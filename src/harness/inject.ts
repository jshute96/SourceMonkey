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
import { setUserAgentDataSnapshot } from '../injector.js';
import { GM_RUNTIME_SOURCE_URL } from '../script-source-url.js';
import type { BrowserActions, HarnessHost, OpenedTab, PageLink } from './host.js';
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
  // Tabs this page's scripts opened with `GM_openInTab`. The extension
  // leaves such a tab open when its opener goes; a test must not, or a
  // run against the developer's own browser leaves one behind every
  // time. Closed on dispose.
  private readonly openedTabs = new Set<Page>();
  private closed = false;
  private mainFrameId = '';
  readonly browser: BrowserActions = {
    // A real page in the same context, so a test can `waitForEvent('page')`
    // for it as it would for the extension's tab.
    openTab: async (url: string, active: boolean): Promise<OpenedTab> => {
      const opened = await this.createTab(url, active);
      this.openedTabs.add(opened);
      const closedCallbacks: (() => void)[] = [];
      opened.on('close', () => {
        this.openedTabs.delete(opened);
        for (const cb of closedCallbacks) cb();
      });
      return {
        close: () => (opened.isClosed() ? Promise.resolve() : opened.close()),
        onClosed: (cb) => {
          if (opened.isClosed()) cb();
          else closedCallbacks.push(cb);
        },
      };
    },
    closeSelf: () => this.page.close(),
    focusSelf: () => this.page.bringToFront(),
  };
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
      void readUserAgentData(this.page);
    });
    // Those same-document changes are what `window.onurlchange` reports.
    // The worker forwards Chrome's history-update events; this is the
    // same signal from CDP, for the main frame.
    this.cdp.on('Page.navigatedWithinDocument', (ev) => {
      if (ev.frameId !== this.mainFrameId) return;
      void this.push({ type: 'sm:url-change', url: ev.url }).catch(() => undefined);
    });
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
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

  // The browser context's cookies for the request's URL, so a
  // credentialed GM_xmlhttpRequest carries the session the user has in
  // this browser, as the extension's does.
  async cookiesFor(url: string): Promise<{ name: string; value: string }[]> {
    if (this.closed) return [];
    const cookies = await this.page.context().cookies(url);
    return cookies.map((c) => ({ name: c.name, value: c.value }));
  }

  // A tab created the way `chrome.tabs.create({url})` creates one: the
  // target is born navigating to `url`, so the page a test receives
  // from the context's `page` event already has that URL, and
  // `waitForLoadState` waits for that document rather than resolving at
  // once on `about:blank`. Playwright's `newPage()` can't do this (it
  // always starts blank), so the target is created over CDP in this
  // page's own browser context, which is what keeps it inside the
  // Playwright context a test is watching.
  private async createTab(url: string, active: boolean): Promise<Page> {
    const { targetInfo } = await this.cdp.send('Target.getTargetInfo');
    const browser = this.page.context().browser();
    // A persistent context (`launchPersistentContext`) has no Browser
    // object in Playwright, and so no browser-level session.
    if (!browser) throw new Error('This browser context does not expose a browser-level CDP session');
    const browserSession = await browser.newBrowserCDPSession();
    try {
      // Matched by identity, not by URL: a page that fails to load
      // reports an error URL rather than the one asked for, and that
      // page would then never be recognized as this tab, left open and
      // untracked. The pages present before the create are the ones
      // this is not.
      const before = new Set(this.page.context().pages());
      const pagePromise = this.page.context().waitForEvent('page', {
        predicate: (p) => !before.has(p),
        timeout: 10000,
      });
      // Settled either way, so a failed create can't leave a rejection
      // nobody awaits.
      pagePromise.catch(() => undefined);
      await browserSession.send('Target.createTarget', {
        url,
        browserContextId: targetInfo.browserContextId,
        background: !active,
      });
      const opened = await pagePromise;
      if (active) await opened.bringToFront().catch(() => undefined);
      return opened;
    } finally {
      await browserSession.detach().catch(() => undefined);
    }
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
    for (const tab of this.openedTabs) await tab.close().catch(() => undefined);
    this.openedTabs.clear();
    this.closed = true;
    this.page.off('close', this.onClose);
    this.host.detachPage(this);
    attached.delete(this.page);
    await this.cdp.detach().catch(() => undefined);
  }
}

export async function attachPage(page: Page, host: HarnessHost): Promise<PageAttachment> {
  await readUserAgentData(page);
  return PageAttachment.create(page, host);
}

let userAgentDataRead = false;

/**
 * Read the browser's `navigator.userAgentData` once and hand it to the
 * injector, so a script prepared after this gets the browser's brands
 * in `GM_info` as it would from the extension (whose worker is a
 * secure context). The API exists only on secure origins, `localhost`
 * and `file:` included, and not on `about:blank`; a page that has none
 * leaves the value unread, and the next navigation of any attached
 * page tries again. A script prepared before a page reached such an
 * origin gets `null`.
 */
export async function readUserAgentData(page: Page): Promise<boolean> {
  if (userAgentDataRead) return true;
  try {
    const data = await page.evaluate(() => {
      const nav = navigator as Navigator & {
        userAgentData?: { brands: { brand: string; version: string }[]; mobile: boolean; platform: string };
      };
      const d = nav.userAgentData;
      return d ? { brands: d.brands.map((b) => ({ brand: b.brand, version: b.version })), mobile: d.mobile, platform: d.platform } : null;
    });
    if (!data) return false;
    setUserAgentDataSnapshot(data);
    userAgentDataRead = true;
    return true;
  } catch {
    return false;
  }
}
