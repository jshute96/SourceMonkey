// Attaching prepared scripts to a Playwright page without the extension.
//
// The extension registers its scripts with `chrome.userScripts`. This
// does the same job with the Chrome DevTools Protocol (CDP), on a page
// Playwright already controls:
//
//   - Each registration entry (`prepare.ts` returns the same ones the
//     extension registers) becomes a `Page.addScriptToEvaluateOnNewDocument`
//     call, in the script's world. MAIN is the page's own world; the
//     isolated world is named, which Playwright's `addInitScript`
//     cannot do. Naming it sandboxes `@grant` scripts here as Chrome
//     sandboxes them.
//   - The shared `GM_*` runtime goes in ahead of the first script that
//     needs it in each world, once per page, as `buildGmRuntimeSpecs`
//     registers it once per world.
//   - Isolated-world code gets a stand-in `chrome.runtime` whose
//     `sendMessage` calls a CDP binding exposed only in that world, so
//     it takes the same path as in the extension and the page can
//     neither read nor forge its traffic. Replies and pushes come back
//     by evaluating into that world.
//   - MAIN-world code has no `chrome.runtime` there either, and talks
//     over the DOM bridge (a `sourcemonkey-bridge-sync` event out,
//     `postMessage` back). The page can see and forge that traffic, as
//     it can in the extension, so the host checks each such request the
//     way the worker's `bridgeMayActAs` does. See host.ts.
//
// Init scripts persist across reloads, so a script attached once keeps
// running on every navigation until it is detached. That turns "edit,
// reload, look" into a one-step loop.

import type { CDPSession, Page } from '@playwright/test';

import { WRAPPER_GM_RUNTIME } from '../generated-wrappers.js';
import { setUserAgentDataSnapshot } from '../injector.js';
import { GM_RUNTIME_SOURCE_URL } from '../script-source-url.js';
import type { BrowserActions, HarnessHost, OpenedTab, PageLink } from './host.js';
import type { InjectionWorld, PreparedScript } from './prepare.js';
import { BADGE_BINDING, TabBadge, type BadgeDocument, type BadgeOptions } from './tab-badge.js';

// The named isolated world. Any name works; it only has to be the same
// for every entry so they share one global object, the way one
// `chrome.userScripts` world does.
const ISOLATED_WORLD = 'sourcemonkey';
const BINDING = '__smHarnessBridge';
const RUNTIME_BINDING = '__smHarnessRuntime';
// The id the stand-in `chrome.runtime` reports. The injected code only
// needs a string: it compares a push's `sender.id` against it.
const RUNTIME_ID = 'sourcemonkey-harness';

const BRIDGE_SYNC = 'sourcemonkey-bridge-sync';
const BRIDGE_REPLY = 'sourcemonkey-bridge-reply';
const BRIDGE_PUSH = 'sourcemonkey-bridge-push';

// MAIN-world listener that hands every bridge event to Node. The
// binding call is synchronous from the page's side, so a report sent
// as the document tears down still leaves the page, the property the
// extension's bridge is built around. Top frame only, as the scripts
// are.
const BRIDGE_LISTENER = `(function(){
  if (self !== top) return;
  if (window.__smHarnessListening) return;
  window.__smHarnessListening = true;
  // Captured now, before any page script, so a page that replaces the
  // global later can't swallow the scripts' reports and calls.
  var call = window[${JSON.stringify(BINDING)}];
  if (typeof call !== 'function') return;
  document.addEventListener(${JSON.stringify(BRIDGE_SYNC)}, function (ev) {
    try {
      if (!ev || typeof ev.detail !== 'string') return;
      call(ev.detail);
    } catch (e) {}
  }, true);
})();`;

// The isolated world's `chrome.runtime`: the two members the injected
// code uses (plus `id`, which it checks to pick this path over the DOM
// bridge). `sendMessage` resolves with the host's reply, which comes
// back through `__smHarnessReply`; pushes arrive through
// `__smHarnessPush` with the sender shape the runtime's filter wants.
// The binding call is synchronous, like `chrome.runtime.sendMessage`,
// so a write sent during teardown still leaves. A reply that never
// comes rejects after the MAIN bridge's own timeout, as the real
// `sendMessage` rejects when nobody answers: the GM runtime has no
// timer of its own on this path.
const ISOLATED_RUNTIME = `(function(){
  if (self !== top) return;
  var call = globalThis[${JSON.stringify(RUNTIME_BINDING)}];
  if (typeof call !== 'function') return;
  var id = ${JSON.stringify(RUNTIME_ID)};
  var stringify = JSON.stringify;
  var pending = Object.create(null);
  var listeners = [];
  var seq = 1;
  var TIMEOUT_MS = 30000;
  globalThis.__smHarnessReply = function (requestId, reply) {
    var entry = pending[requestId];
    if (!entry) return;
    delete pending[requestId];
    clearTimeout(entry.timer);
    entry.resolve(reply);
  };
  globalThis.__smHarnessPush = function (msg) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](msg, { id: id }, function () {}); } catch (e) {}
    }
  };
  var runtime = {
    id: id,
    sendMessage: function (payload) {
      return new Promise(function (resolve, reject) {
        var requestId = 'r' + (seq++);
        var detail = stringify({ requestId: requestId, payload: payload });
        // Registered before the call, so the entry exists whenever the
        // reply lands.
        pending[requestId] = {
          resolve: resolve,
          timer: setTimeout(function () {
            delete pending[requestId];
            reject(new Error('[SourceMonkey] The harness did not answer within ' + TIMEOUT_MS / 1000 + ' seconds'));
          }, TIMEOUT_MS)
        };
        try {
          call(detail);
        } catch (e) {
          clearTimeout(pending[requestId].timer);
          delete pending[requestId];
          throw e;
        }
      });
    },
    onMessage: {
      addListener: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
    }
  };
  var c = globalThis.chrome;
  if (!c || typeof c !== 'object') { c = {}; globalThis.chrome = c; }
  Object.defineProperty(c, 'runtime', { value: runtime, configurable: true, writable: true });
})();`;

// Pushes that carry nothing script-scoped, so they go to MAIN world
// whatever script they concern. Same list as wrapper-bridge.js.
const PUSHED_ANY_WORLD = new Set(['sm:gm-resync-hint', 'sm:url-change']);

// Where a bridge message came from: the isolated world's own channel,
// or the DOM bridge the page shares.
export type BridgeOrigin = 'isolated' | 'page';

interface ContextInfo {
  frameId: string;
  name: string;
  isDefault: boolean;
}

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
  // `GM_openInTab` calls still finding their page, so dispose can wait
  // for them rather than miss a tab that appears as it runs.
  private readonly creatingTabs = new Set<Promise<Page | null>>();
  private disposing = false;
  private closed = false;
  /**
   * Called with each tab this page's scripts open with `GM_openInTab`,
   * so a caller can inject into it too. Such a tab has no opener, so
   * Playwright's `popup` event never names it.
   */
  onOpenedTab: ((tab: Page) => void) | null = null;
  private mainFrameId = '';
  // The main frame's recent documents by loader id, for the badge: one
  // restored from the back/forward cache is the same document again,
  // with the reports it sent before.
  private readonly documents = new Map<string, BadgeDocument>();
  private currentDocument: BadgeDocument = { url: '', spans: [[0, Infinity]] };
  private badge: TabBadge | null = null;
  private badgeCall: ((payload: string) => void) | null = null;
  // Execution contexts by id, so a binding call can be traced to its
  // frame and world, and a push can find the isolated world.
  private readonly contexts = new Map<number, ContextInfo>();
  readonly browser: BrowserActions = {
    // A real page in the same context, so a test can `waitForEvent('page')`
    // for it as it would for the extension's tab.
    openTab: async (url: string, active: boolean): Promise<OpenedTab> => {
      if (this.disposing) throw new Error('The page is being detached from the harness');
      const creating = this.createTab(url, active);
      this.creatingTabs.add(creating);
      let opened: Page | null;
      try {
        opened = await creating;
      } finally {
        this.creatingTabs.delete(creating);
      }
      const alreadyClosed: OpenedTab = { close: () => Promise.resolve(), onClosed: (cb) => cb() };
      // Closed before it could be told apart from other pages: it
      // opened, and it has already closed.
      if (!opened) return alreadyClosed;
      // Finished opening after dispose began, which closes every tab.
      if (this.disposing) {
        await opened.close().catch(() => undefined);
        return alreadyClosed;
      }
      this.openedTabs.add(opened);
      this.onOpenedTab?.(opened);
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
    // Claimed before the first await, so two concurrent attaches can't
    // both pass the check; released if setup fails, so the page can be
    // attached again.
    attached.add(page);
    let cdp: CDPSession | null = null;
    try {
      cdp = await page.context().newCDPSession(page);
      const attachment = new PageAttachment(page, host, cdp);
      await attachment.install();
      return attachment;
    } catch (err) {
      attached.delete(page);
      await cdp?.detach().catch(() => undefined);
      throw err;
    }
  }

  private async install(): Promise<void> {
    // Before `Runtime.enable`, which reports the contexts that already exist.
    this.cdp.on('Runtime.executionContextCreated', ({ context }) => {
      const aux = (context.auxData ?? {}) as { frameId?: string; isDefault?: boolean };
      this.contexts.set(context.id, { frameId: aux.frameId ?? '', name: context.name, isDefault: aux.isDefault === true });
    });
    this.cdp.on('Runtime.executionContextDestroyed', (ev) => { this.contexts.delete(ev.executionContextId); });
    this.cdp.on('Runtime.executionContextsCleared', () => { this.contexts.clear(); });
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    this.cdp.on('Runtime.bindingCalled', (ev) => {
      if (ev.name === BADGE_BINDING) {
        const context = this.contexts.get(ev.executionContextId);
        if (context?.frameId === this.mainFrameId && context.name === ISOLATED_WORLD) this.badgeCall?.(ev.payload);
        return;
      }
      const origin = ev.name === RUNTIME_BINDING ? 'isolated' : ev.name === BINDING ? 'page' : null;
      if (origin) void this.onBridgeEvent(ev.payload, ev.executionContextId, origin);
    });
    await this.cdp.send('Runtime.addBinding', { name: BINDING });
    // Only in the isolated world, so the page can't call it.
    await this.cdp.send('Runtime.addBinding', { name: RUNTIME_BINDING, executionContextName: ISOLATED_WORLD });
    await this.cdp.send('Runtime.addBinding', { name: BADGE_BINDING, executionContextName: ISOLATED_WORLD });
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: BRIDGE_LISTENER,
      runImmediately: true,
    });
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: ISOLATED_RUNTIME,
      runImmediately: true,
      worldName: ISOLATED_WORLD,
    });
    // New documents only. Playwright's `framenavigated` also fires for
    // `pushState` and hash changes, where the injected scripts are still
    // running from the earlier document and a "skipped" would be false.
    this.cdp.on('Page.frameNavigated', (ev) => {
      if (ev.frame.parentId) return;
      this.enterDocument(ev.frame.loaderId, ev.frame.url);
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
    this.currentDocument.url = frameTree.frame.url;
    this.documents.set(frameTree.frame.loaderId, this.currentDocument);
    this.page.on('close', this.onClose);
    this.host.attachPage(this);
    // Closed during the awaits above, before the listener was on: the
    // event has come and gone.
    if (this.page.isClosed()) this.onClose();
  }

  /**
   * Badge the tab's icon with its script count and status, as the
   * extension's toolbar badge does, until the attachment is disposed.
   * See tab-badge.ts.
   */
  async showBadge(options?: BadgeOptions): Promise<void> {
    if (this.badge || this.disposing) return;
    const badge = new TabBadge({
      page: this.page,
      link: this,
      host: this.host,
      scripts: () => this.injectedScripts(),
      currentDocument: () => this.currentDocument,
      addScript: async (source) => {
        await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true, worldName: ISOLATED_WORLD });
      },
      evaluate: async (expression) => {
        const contextId = this.contextFor(ISOLATED_WORLD);
        if (contextId !== null && !this.closed) await this.cdp.send('Runtime.evaluate', { expression, contextId });
      },
      onCall: (handler) => { this.badgeCall = handler; },
    }, options);
    this.badge = badge;
    // Best effort: a tab is no less controlled for lacking its badge.
    await badge.start().catch(() => badge.stop());
  }

  // The main frame moved to the document `loaderId` names.
  private enterDocument(loaderId: string, url: string): void {
    const now = Date.now();
    this.currentDocument.spans[this.currentDocument.spans.length - 1][1] = now;
    let doc = this.documents.get(loaderId);
    if (!doc) {
      doc = { url, spans: [] };
      this.documents.set(loaderId, doc);
      // Only the last few: the back/forward cache holds no more.
      for (const key of this.documents.keys()) {
        if (this.documents.size <= 10) break;
        this.documents.delete(key);
      }
    }
    doc.spans.push([now, Infinity]);
    this.currentDocument = doc;
  }

  // ---------- PageLink ----------

  url(): string {
    return this.page.url();
  }

  // The isolated world always hears a push, as the extension's
  // `chrome.runtime.onMessage` does. MAIN world, which the page can
  // read, hears only pushes addressed to a MAIN-world script or
  // carrying nothing script-scoped: the rule wrapper-bridge.js applies
  // with `smWorld`, so an isolated script's values and responses stay
  // out of the page.
  async push(message: object): Promise<void> {
    if (this.closed) return;
    const { type, smWorld } = message as { type?: unknown; smWorld?: unknown };
    const isolated = this.contextFor(ISOLATED_WORLD);
    const sends: Promise<unknown>[] = [];
    if (isolated !== null) {
      sends.push(this.cdp.send('Runtime.evaluate', {
        expression: `globalThis.__smHarnessPush && globalThis.__smHarnessPush(${JSON.stringify(message)})`,
        contextId: isolated,
      }));
    }
    if (smWorld === 'MAIN' || PUSHED_ANY_WORLD.has(String(type))) {
      sends.push(this.page.evaluate(
        ([marker, payload]) => { window.postMessage({ __sm: marker, payload }, '*'); },
        [BRIDGE_PUSH, message] as const,
      ));
    }
    await Promise.all(sends);
  }

  // The top frame's context for a world: '' is the page's own (MAIN).
  // The newest match, should a stale one linger beside it (Map order is
  // creation order).
  private contextFor(world: string): number | null {
    let found: number | null = null;
    for (const [id, info] of this.contexts) {
      if (info.frameId !== this.mainFrameId) continue;
      if (world === '' ? info.isDefault : info.name === world) found = id;
    }
    return found;
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
  // page's own browser context, so it lands inside the Playwright
  // context a test is watching.
  private async createTab(url: string, active: boolean): Promise<Page | null> {
    const { targetInfo } = await this.cdp.send('Target.getTargetInfo');
    const browser = this.page.context().browser();
    // A persistent context (`launchPersistentContext`) has no Browser
    // object in Playwright, and so no browser-level session.
    if (!browser) {
      throw new Error('A persistent context (launchPersistentContext) cannot open tabs here. Use a context from browser.newContext().');
    }
    const browserSession = await browser.newBrowserCDPSession();
    try {
      // Heard from before the create, so a tab closed at once is still
      // seen going.
      const destroyed = new Set<string>();
      browserSession.on('Target.targetDestroyed', (ev) => { destroyed.add(ev.targetId); });
      await browserSession.send('Target.setDiscoverTargets', { discover: true });
      // Pages open before the create can't be the new one, so they are
      // never attached to just to ask their id: under `sm-dev run` they
      // are the developer's own tabs.
      const before = new Set(this.page.context().pages());
      const { targetId } = await browserSession.send('Target.createTarget', {
        url,
        browserContextId: targetInfo.browserContextId,
        background: !active,
      });
      let opened: Page | null;
      try {
        opened = await this.pageForTarget(targetId, before, () => destroyed.has(targetId));
      } catch (err) {
        // Never found, so nothing else would close it.
        await browserSession.send('Target.closeTarget', { targetId }).catch(() => undefined);
        throw err;
      }
      if (opened && active) await opened.bringToFront().catch(() => undefined);
      return opened;
    } finally {
      await browserSession.detach().catch(() => undefined);
    }
  }

  // The Playwright page for a CDP target, or null once the target is
  // gone before its page was found. Matched by target id, not by URL or
  // by "the next new page": a page that fails to load reports an error
  // URL, and two tabs opened at once would otherwise each take
  // whichever appeared first, leaving the other open and untracked.
  private async pageForTarget(targetId: string, before: ReadonlySet<Page>, gone: () => boolean): Promise<Page | null> {
    const ctx = this.page.context();
    // Pages known not to be it. One whose id couldn't be read yet (still
    // initializing) is asked again on the next pass.
    const ruledOut = new Set<Page>(before);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      for (const p of ctx.pages()) {
        if (ruledOut.has(p)) continue;
        const id = await targetIdOf(p);
        if (id === targetId) return p;
        if (id !== null || p.isClosed()) ruledOut.add(p);
      }
      if (gone()) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('The tab GM_openInTab opened did not appear within 10 seconds');
  }

  // ---------- Bridge ----------

  private async onBridgeEvent(detail: string, contextId: number, origin: BridgeOrigin): Promise<void> {
    // Top frame only, and each binding from its own world. The page
    // binding is visible in every world and frame; a call from anywhere
    // else is not one of ours.
    const context = this.contexts.get(contextId);
    if (!context || context.frameId !== this.mainFrameId) return;
    if (origin === 'isolated' ? context.name !== ISOLATED_WORLD : !context.isDefault) return;
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
      reply = await this.host.handle(payload as Record<string, unknown>, this, origin);
    } catch {
      reply = undefined;
    }
    if (typeof envelope.requestId !== 'string') return;
    // Delivered into the context the request came from: a call into
    // the isolated runtime, or a postMessage the MAIN-world code is
    // listening for. The prelude's fallback for a missing reply is to
    // run anyway after two seconds, so a lost reply costs time, not
    // correctness.
    const answer = reply ?? { action: 'run' };
    const expression = origin === 'isolated'
      ? `globalThis.__smHarnessReply(${JSON.stringify(envelope.requestId)}, ${JSON.stringify(answer)})`
      : `window.postMessage(${JSON.stringify({ __sm: BRIDGE_REPLY, requestId: envelope.requestId, reply: answer })}, '*')`;
    try {
      await this.cdp.send('Runtime.evaluate', { expression, contextId });
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
    this.disposing = true;
    // Grey now, while the session can still say so.
    if (this.badge) await briefly(this.badge.stop());
    const unregister = (async () => {
      for (const id of [...this.injected.keys()]) await this.remove(id);
      for (const identifier of this.runtimeWorlds.values()) {
        await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => undefined);
      }
    })();
    // A page stopped on a dialog answers nothing until it is closed, so
    // this is not waited on for long. Detaching the session below drops
    // what it registered either way.
    await briefly(unregister);
    this.runtimeWorlds.clear();
    // Each one closes its own page on seeing `disposing`; closed here
    // too, in case dispose gets there first.
    for (const pending of [...this.creatingTabs]) {
      const tab = await pending.catch(() => null);
      await tab?.close().catch(() => undefined);
    }
    for (const tab of this.openedTabs) await tab.close().catch(() => undefined);
    this.openedTabs.clear();
    this.closed = true;
    this.page.off('close', this.onClose);
    this.host.detachPage(this);
    attached.delete(this.page);
    // Also held up by a dialog; the session goes with the page anyway.
    await briefly(this.cdp.detach().catch(() => undefined));
  }
}

// `work`, or a second, whichever is sooner.
function briefly(work: Promise<unknown>): Promise<unknown> {
  return Promise.race([work, new Promise((r) => setTimeout(r, 1000).unref())]);
}

// A page's CDP target id, remembered: a page keeps its id for life.
const targetIds = new WeakMap<Page, string>();

/**
 * The page's CDP target id (the `id` in `/json/list`, and what CDP's
 * `Target.*` calls take), or null when it can't be read, as once the
 * page has closed.
 */
export async function targetIdOf(page: Page): Promise<string | null> {
  const known = targetIds.get(page);
  if (known) return known;
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      targetIds.set(page, targetInfo.targetId);
      return targetInfo.targetId;
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    // Closed while being asked.
    return null;
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
