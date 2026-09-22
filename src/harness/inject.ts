// Attaching prepared scripts to a Playwright page without the extension.
//
// What the extension does with `chrome.userScripts`, this does with the
// Chrome DevTools Protocol (CDP) on a page Playwright already controls:
//
//   - Each registration entry (`prepare.ts` returns the same four the
//     extension registers) becomes a `Page.addScriptToEvaluateOnNewDocument`
//     call, in the script's world. MAIN is the page's own world; the
//     isolated world is named, which Playwright's `addInitScript` cannot
//     do and which is what makes `@grant` scripts run sandboxed here as
//     they do in Chrome.
//   - The shared `GM_*` runtime goes in ahead of the first script that
//     needs it in each world, once per page, as `buildGmRuntimeSpecs`
//     registers it once per world.
//   - The injected code finds no `chrome.runtime` and talks over the DOM
//     bridge (a `sourcemonkey-bridge-sync` event out, `postMessage`
//     back). A listener registered before any script forwards each
//     event to Node through a CDP binding, and the reply is posted back
//     into the frame the request came from. See host.ts for the messages.
//
// Init scripts persist across reloads, so a script attached once keeps
// running on every navigation of the page until it is detached, which
// is what makes "edit, reload, look" a one-step loop.

import type { CDPSession, Page } from '@playwright/test';

import { WRAPPER_GM_RUNTIME } from '../generated-wrappers.js';
import { GM_RUNTIME_SOURCE_URL } from '../script-source-url.js';
import type { HarnessHost, PageLink } from './host.js';
import type { InjectionWorld, PreparedScript } from './prepare.js';

// The named isolated world. Any name works; it only has to be the same
// for every entry so they share one global object, the way one
// `chrome.userScripts` world does.
const ISOLATED_WORLD = 'sourcemonkey';
const BINDING = '__smHarnessBridge';

const BRIDGE_SYNC = 'sourcemonkey-bridge-sync';
const BRIDGE_REPLY = 'sourcemonkey-bridge-reply';
const BRIDGE_PUSH = 'sourcemonkey-bridge-push';

// MAIN-world listener that hands every bridge event to Node. The
// binding call is synchronous from the page's side, so a report sent
// as the document tears down still leaves the page, the property the
// extension's bridge is built around. Installed first, in MAIN, so it
// hears the isolated world's events too (DOM events cross worlds).
const BRIDGE_LISTENER = `(function(){
  if (window.__smHarnessListening) return;
  window.__smHarnessListening = true;
  document.addEventListener(${JSON.stringify(BRIDGE_SYNC)}, function (ev) {
    try {
      if (!ev || typeof ev.detail !== 'string') return;
      window[${JSON.stringify(BINDING)}](ev.detail);
    } catch (e) {}
  }, true);
})();`;

export interface InjectOptions {
  /**
   * Also run in the current document, not only on the next navigation.
   * Off by default: the usual loop is attach, then reload.
   */
  immediately?: boolean;
}

interface Injected {
  script: PreparedScript;
  identifiers: string[];
}

// Pages that already have an attachment. A second attachment on the
// same page would replace the binding and skip the listener (the live
// document already has one), so the bridge would go quiet until the
// next reload; refusing is clearer.
const attached = new WeakSet<Page>();

/**
 * One page wired to a host. Create with `attachPage`; then `inject`
 * scripts into it and navigate or reload.
 */
export class PageAttachment implements PageLink {
  private readonly injected = new Map<string, Injected>();
  private readonly runtimeWorlds = new Map<InjectionWorld, string>();
  private closed = false;
  private readonly onClose = (): void => {
    this.closed = true;
    this.host.detachPage(this);
  };

  private constructor(
    readonly page: Page,
    readonly host: HarnessHost,
    private readonly cdp: CDPSession,
  ) {}

  static async create(page: Page, host: HarnessHost): Promise<PageAttachment> {
    if (attached.has(page)) throw new Error('This page already has a harness attachment');
    attached.add(page);
    const cdp = await page.context().newCDPSession(page);
    const attachment = new PageAttachment(page, host, cdp);
    await attachment.install();
    return attachment;
  }

  private async install(): Promise<void> {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    this.cdp.on('Runtime.bindingCalled', (ev) => {
      if (ev.name !== BINDING) return;
      void this.onBridgeEvent(ev.payload, ev.executionContextId);
    });
    await this.cdp.send('Runtime.addBinding', { name: BINDING });
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: BRIDGE_LISTENER,
      runImmediately: true,
    });
    // New documents only. Playwright's `framenavigated` also fires for
    // `pushState` and hash changes, where the injected scripts are still
    // running from the earlier document and a "skipped" would be false.
    this.cdp.on('Page.frameNavigated', (ev) => {
      if (ev.frame.parentId) return;
      this.host.noteNavigation(this, this.injectedScripts());
    });
    this.page.on('close', this.onClose);
    this.host.attachPage(this);
  }

  // ---------- PageLink ----------

  url(): string {
    return this.page.url();
  }

  async push(message: object): Promise<void> {
    if (this.closed) return;
    await this.page.evaluate(
      ([marker, payload]) => { window.postMessage({ __sm: marker, payload }, '*'); },
      [BRIDGE_PUSH, message] as const,
    );
  }

  // ---------- Bridge ----------

  private async onBridgeEvent(detail: string, contextId: number): Promise<void> {
    let envelope: { requestId?: unknown; payload?: unknown };
    try {
      envelope = JSON.parse(detail);
    } catch {
      return;
    }
    const payload = envelope?.payload;
    if (!payload || typeof payload !== 'object') return;
    // A listener on the host that throws must not become an unhandled
    // rejection here, and the page still gets an answer: the extension's
    // bridge always replies, and `{action: 'run'}` is its fallback too.
    let reply: unknown;
    try {
      reply = await this.host.handle(payload as Record<string, unknown>, this);
    } catch {
      reply = undefined;
    }
    if (typeof envelope.requestId !== 'string') return;
    // Posted into the frame and world the request came from. The
    // prelude's fallback for a missing reply is to run anyway after
    // two seconds, so a lost reply costs time, not correctness.
    const message = { __sm: BRIDGE_REPLY, requestId: envelope.requestId, reply: reply ?? { action: 'run' } };
    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: `window.postMessage(${JSON.stringify(message)}, '*')`,
        contextId,
      });
    } catch {
      // The document went away before the answer did.
    }
  }

  // ---------- Injection ----------

  /** Attach a prepared script. Re-attaching the same script replaces it. */
  async inject(prepared: PreparedScript, options: InjectOptions = {}): Promise<void> {
    if (!prepared.spec) throw new Error(`Cannot inject an invalid script: ${prepared.diagnostic}`);
    const id = prepared.spec.id;
    if (this.injected.has(id)) await this.remove(id);
    this.host.addScript(prepared, this);
    const world = prepared.world;
    const identifiers: string[] = [];
    if (prepared.needsGmRuntime && !this.runtimeWorlds.has(world)) {
      // Always into the current document as well: the runtime is
      // idempotent and inert without scripts, and a later `immediately`
      // injection would otherwise find no `__SM_GM__` until a reload.
      const identifier = await this.add(
        WRAPPER_GM_RUNTIME + `\n//# sourceURL=${GM_RUNTIME_SOURCE_URL}\n`,
        world,
        true,
      );
      this.runtimeWorlds.set(world, identifier);
    }
    for (const entry of prepared.spec.js) {
      identifiers.push(await this.add(entry.code, world, options.immediately === true));
    }
    this.injected.set(id, { script: prepared, identifiers });
  }

  /** Detach a script; it stops running on the next navigation. */
  async remove(scriptId: string): Promise<void> {
    const entry = this.injected.get(scriptId);
    if (!entry) return;
    this.injected.delete(scriptId);
    this.host.removeScript(scriptId, this);
    for (const identifier of entry.identifiers) {
      await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => undefined);
    }
  }

  injectedScripts(): PreparedScript[] {
    return [...this.injected.values()].map((e) => e.script);
  }

  private async add(code: string, world: InjectionWorld, immediately: boolean): Promise<string> {
    const { identifier } = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      // `chrome.userScripts` registers top-frame only unless asked for
      // all frames, and SourceMonkey never asks; CDP init scripts run in
      // every frame. The guard is on the first line so line numbers in
      // stack traces are unchanged.
      source: `if(self===top){${code}\n}`,
      runImmediately: immediately,
      worldName: world === 'USER_SCRIPT' ? ISOLATED_WORLD : undefined,
    });
    return identifier;
  }

  /** Detach everything and drop the CDP session. */
  async dispose(): Promise<void> {
    for (const id of [...this.injected.keys()]) await this.remove(id);
    for (const identifier of this.runtimeWorlds.values()) {
      await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => undefined);
    }
    this.runtimeWorlds.clear();
    this.closed = true;
    this.page.off('close', this.onClose);
    this.host.detachPage(this);
    attached.delete(this.page);
    await this.cdp.detach().catch(() => undefined);
  }
}

export function attachPage(page: Page, host: HarnessHost): Promise<PageAttachment> {
  return PageAttachment.create(page, host);
}
