// A run's connection to the real SourceMonkey in its browser: the calls
// it makes into the extension's service worker, the tabs it claims, and
// the events the worker streams back. The extension's side is
// src/extension/sm-dev-link.ts; the design is docs/sm-dev-design.md.
//
// - Calls go through `self.SourceMonkey` in the worker, with Playwright's
//   `worker.evaluate`.
// - Chrome stops an idle worker and starts a new one later. A call made
//   while the known one is stopped goes to the new one, which is
//   listened to and subscribed to again; the run is told, since events
//   in between are lost.
// - The run's claims and its subscription are a lease, renewed here
//   while the run lasts, and released at its end. A renewal also claims
//   again any of the run's tabs whose claim the extension lost.
// - A run's scripts go into a test collection of its own,
//   which the extension removes when the run is released, or a while
//   after its lease runs out.
// - It marks the browser's pages, so a `document-start` wrapper knows
//   whether it can run without asking the extension
//   (`markBrowser`, `setVouch`; docs/sm-dev-design.md#making-wrappers-ask).

import { randomBytes } from 'node:crypto';

import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test';

import {
  SM_DEV_EVENT, SM_DEV_MARKERS, SM_DEV_PROTOCOL, type ManagedCollection, type ManagedOnDisk, type ManagedScript, type ProtocolVersion,
} from '../sm-dev-protocol.js';
import type { StackLayout } from '../composed-source.js';
import type { PushedFile } from '../external-files.js';
import {
  findExtensionWorker, isSourceMonkeyWorker, sourceMonkeyExtensionId, sourceMonkeyOrigin, type LogEntry, type PushResult,
} from './extension-backend.js';
import type { ManagerControl } from './manager-commands.js';
import { rebuildAdvice } from './rebuild-advice.js';
import type { ExtensionFrame } from './frames.js';
import { quoted } from './output-style.js';

// How long a claim lasts unrenewed, and how often it's renewed. A killed
// run's tabs run the extension's scripts again within the lease.
const LEASE_MS = 30_000;
const RENEW_MS = 10_000;

// How long the extension watches for the navigation that names a tab.
const NAMING_MS = 10_000;

// The world the per-tab marker's listener runs in, out of the page's
// sight. A listener on `window` hears events dispatched from any world.
const VOUCH_WORLD = 'sourcemonkey-sm-dev';

// A marker: a window listener that cancels events of its type.
const markerSource = (type: string): string =>
  `window.addEventListener(${JSON.stringify(type)}, function (e) { e.preventDefault(); });`;

// The contexts whose pages carry the marker every page does.
const markedContexts = new WeakSet<BrowserContext>();

/**
 * Marks every page of the browser as one sm-dev is connected to, so a
 * wrapper there asks the extension before running, since any tab may be
 * claimed. Through Playwright's context init script, which Playwright
 * adds to a new tab before letting it load, a tab a page opens
 * included. Once per context: it lasts as long as the connection.
 */
async function markBrowser(context: BrowserContext): Promise<void> {
  if (markedContexts.has(context)) return;
  try {
    await context.addInitScript({ content: markerSource(SM_DEV_MARKERS.present) });
  } catch (err) {
    throw new Error(`Could not mark the browser's pages as sm-dev's, so SourceMonkey's scripts would run in the run's tabs: ${firstLine(err)}`);
  }
  markedContexts.add(context);
}

// How to bring each side up to date, for the messages below.
const UPDATE_EXTENSION = 'Update it: rebuild it and reload it in chrome://extensions, or use `--temp-browser`, which loads this sm-dev\'s copy.';
const updateSmDev = (): string => `Update sm-dev: ${rebuildAdvice()} Or use ${quoted('--temp-browser')}, which loads this sm-dev's copy of SourceMonkey.`;

/** Said when the extension in the browser has an older protocol major, or none. */
const EXTENSION_TOO_OLD = `SourceMonkey in this browser is older than this sm-dev, so the two can't work together. ${UPDATE_EXTENSION}`;

/**
 * How the extension's protocol version compares with sm-dev's
 * (`SM_DEV_PROTOCOL`): an error for a major that differs, a note for a
 * minor that does, or null when they match.
 */
export function compareProtocol(
  extension: ProtocolVersion | undefined,
  ours: ProtocolVersion = SM_DEV_PROTOCOL,
): { error?: string; note?: string } | null {
  // Built before the version existed.
  if (!extension || extension.major < ours.major) return { error: EXTENSION_TOO_OLD };
  if (extension.major > ours.major) {
    return { error: `This sm-dev is older than SourceMonkey in this browser, so the two can't work together. ${updateSmDev()}` };
  }
  if (extension.minor < ours.minor) {
    return { note: `SourceMonkey in this browser is older than this sm-dev, so some of sm-dev's newer features won't work there. ${UPDATE_EXTENSION}` };
  }
  if (extension.minor > ours.minor) {
    return { note: `This sm-dev is older than SourceMonkey in this browser, so it lacks some newer features. ${updateSmDev()}` };
  }
  return null;
}

/**
 * The worker's protocol version, compared with sm-dev's: throws for a
 * major that differs, and gives the note for a minor that does.
 */
async function checkedProtocol(worker: Worker): Promise<{ protocol: ProtocolVersion | undefined; note: string | null }> {
  const protocol = await worker.evaluate(
    () => (self as unknown as { SourceMonkey?: { smDevProtocol?: ProtocolVersion } }).SourceMonkey?.smDevProtocol,
  );
  const compared = compareProtocol(protocol);
  if (compared?.error) throw new Error(compared.error);
  return { protocol, note: compared?.note ?? null };
}

/**
 * Throws, naming `feature`, when the extension's protocol minor is older
 * than `minor`.
 */
function requireMinorOf(extension: ProtocolVersion | undefined, minor: number, feature: string): void {
  if ((extension?.minor ?? 0) < minor) {
    throw new Error(`${feature} needs a newer SourceMonkey in this browser. ${UPDATE_EXTENSION}`);
  }
}

/** Said when Chrome won't let the extension register user scripts. */
function userScriptsOff(extensionId: string): string {
  return 'SourceMonkey in this browser does not have "Allow User Scripts" on, so it can\'t run sm-dev\'s scripts. '
    + `Turn it on in SourceMonkey's details page, chrome://extensions/?id=${extensionId}, or use ${quoted('--temp-browser')}, which has it on.`;
}

/** An event from the extension, as sm-dev-link.ts and background.ts send them. */
export type ExtensionEvent =
  | {
    kind: 'report'; type: string; tabId: number; documentId: string; topFrame?: boolean; scriptId: string; name: string; url: string;
    message?: string; stack?: string; reason?: string; detail?: string; at: number;
  }
  | { kind: 'log'; scriptId: string; entry: LogEntry; fromReport?: boolean; at: number }
  | {
    kind: 'menu'; op: 'add' | 'remove'; tabId: number; documentId: string; topFrame?: boolean;
    scriptId: string; commandId: string; name?: string; at: number;
  }
  // `documentId` on `values`, `request`, `download` and `notification`:
  // the sending document, from protocol 2.2.
  | { kind: 'values'; scriptId: string; tabId?: number; documentId?: string; writes: { key: string; value?: unknown; deleted?: boolean }[]; at: number }
  | {
    // `scriptId` and the rest are set for a `GM_openInTab`; a link or
    // `window.open` has none.
    kind: 'tab-opened'; sourceTabId: number; tabId: number; url: string;
    scriptId?: string; requestId?: string; active?: boolean; at: number;
  }
  | { kind: 'tab-closed'; scriptId: string; requestId: string; at: number }
  // A request, download or notification of a script, once as it starts
  // (or shows) and again as it settles.
  | {
    kind: 'request'; scriptId: string; tabId: number; documentId?: string; id: string; url: string; method: string;
    outcome?: 'load' | 'error' | 'timeout' | 'abort'; status?: number; error?: string; at: number;
  }
  | {
    kind: 'download'; scriptId: string; tabId: number; documentId?: string; requestId: string; url: string; name: string;
    outcome?: 'load' | 'error' | 'timeout' | 'abort'; filename?: string; error?: string; at: number;
  }
  | {
    // A connection prompt opened (`shown`), got its answer, or closed
    // with nobody left waiting on it.
    kind: 'connect-prompt'; op: 'shown' | 'answered' | 'closed'; promptId: string; scriptId: string; tabId: number;
    host: string; url?: string; method?: string; answer?: 'once' | 'cancel' | 'allow' | 'allow-all' | 'deny'; at: number;
  }
  | {
    kind: 'notification'; op: 'shown' | 'clicked' | 'closed'; scriptId: string; tabId: number; documentId?: string; requestId: string;
    notificationId?: string; text?: string; title?: string; at: number;
  };

/**
 * A run's id in the extension: sm-dev's run id (`D2`, or a named one)
 * with a random tail, since run ids are reused once a run ends. Kept to
 * the characters a URL path segment allows, since its scripts' URLs
 * carry it.
 */
export function linkRunId(runId: string | undefined): string {
  const head = (runId ?? 'run').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${head}-${randomBytes(2).toString('hex')}`;
}

export class ExtensionLink {
  private worker: Worker | null = null;
  // Workers already listened to, so none gets a second listener.
  private readonly heard = new WeakSet<Worker>();
  // Workers that have stopped, whose handles fail every call.
  private readonly stopped = new WeakSet<Worker>();
  private readonly listeners = new Set<(event: ExtensionEvent) => void>();
  private readonly restartListeners = new Set<(restoredClaims: number) => void>();
  private renewTimer: NodeJS.Timeout | null = null;
  // The tabs the run holds, for a renewal to claim again if lost.
  private readonly tabs = new Map<number, { scriptsOff: boolean }>();
  // The tabs the run claimed itself, each with the CDP session that
  // marks it, and the marker's script while it has one (`setVouch`).
  private readonly vouches = new Map<number, { session: CDPSession; script: string | null }>();
  private closed = false;
  // Set as `close` begins, so no renewal starts after it; every caller
  // of `close` waits on it.
  private closing: Promise<void> | null = null;
  // The renewals in flight (the timer's and a new worker's can overlap),
  // which `close` lets finish before it releases, so one landing late
  // can't claim the run's tabs again.
  private readonly renewing = new Set<Promise<unknown>>();
  // A worker has been adopted before, so the next is a restart.
  private adopted = false;
  /** The extension's protocol version, as `open` read it. */
  private extensionProtocol: ProtocolVersion | undefined;
  /** For the run to print: how the extension's protocol minor differs from sm-dev's, if it does. */
  versionNote: string | null = null;
  // Set for a run without SourceMonkey (`without`): what every call
  // into the extension throws.
  private absent: string | null = null;
  // The tab ids such a run makes up for its tabs, counting down from -1
  // so they can't be taken for Chrome's.
  private madeUpTabId = 0;
  private readonly onWorker = (worker: Worker): void => {
    if (isSourceMonkeyWorker(worker.url(), this.origin)) void this.adopt(worker).catch(() => undefined);
  };

  /**
   * Throws, naming `feature`, when the extension's protocol minor is
   * older than `minor`: for a call or event added in that minor, before
   * using it.
   */
  requireMinor(minor: number, feature: string): void {
    requireMinorOf(this.extensionProtocol, minor, feature);
  }

  /**
   * Whether the extension's protocol minor is at least `minor`: for
   * output that depends on what the extension does. False for a run
   * with no SourceMonkey link.
   */
  hasMinor(minor: number): boolean {
    return (this.extensionProtocol?.minor ?? 0) >= minor;
  }

  private constructor(
    private readonly context: BrowserContext,
    /**
     * The run's unique id (`linkRunId`), which its claims and its test
     * collection carry.
     */
    readonly runId: string,
    /** The extension's service worker, whose console carries the events. */
    readonly workerUrl: string,
    /** The origin of the extension's pages and its scripts' world. */
    readonly origin: string,
  ) {}

  /**
   * Connects to the extension in `context`'s browser, for a run. Its
   * tabs run its own scripts, and it hears the extension's events.
   * Throws when the extension's protocol major differs from sm-dev's
   * (`compareProtocol`), or `userScriptsOff` when Chrome won't let it
   * run scripts. A minor that differs leaves `versionNote` set.
   */
  static async open(context: BrowserContext, runId: string): Promise<ExtensionLink> {
    const worker = await findExtensionWorker(context);
    const link = new ExtensionLink(context, runId, worker.url(), await sourceMonkeyOrigin());
    const checked = await checkedProtocol(worker);
    link.extensionProtocol = checked.protocol;
    link.versionNote = checked.note;
    // Chrome lists `chrome.userScripts` once the manifest asks for it,
    // but every call fails until the user turns on "Allow User
    // Scripts", which would leave the run's scripts silently unrun.
    // The collections page's banner probes the same way.
    const userScriptsOn = await worker.evaluate(async () => {
      try {
        await chrome.userScripts.getScripts();
        return true;
      } catch {
        return false;
      }
    });
    if (!userScriptsOn) throw new Error(userScriptsOff(await sourceMonkeyExtensionId()));
    // Before any claim, so no claimed tab's page goes unmarked.
    await markBrowser(context);
    await link.adopt(worker);
    context.on('serviceworker', link.onWorker);
    link.renewTimer = setInterval(() => { void link.renew().catch(() => undefined); }, RENEW_MS);
    return link;
  }

  /**
   * A link for a run whose manager isn't SourceMonkey: no extension to
   * call, no tabs claimed, no events heard. Its tabs are plain browser
   * tabs, and every call into the extension throws `reason`.
   */
  static without(context: BrowserContext, runId: string, reason: string): ExtensionLink {
    const link = new ExtensionLink(context, runId, '', 'chrome-extension://none');
    link.absent = reason;
    return link;
  }

  // Makes `worker` the one calls go to: listened to once, and the run
  // subscribed in it.
  private async adopt(worker: Worker): Promise<void> {
    if (this.closed || worker === this.worker) return;
    // Not `this.worker !== null`: a stopped worker is cleared as it
    // closes, before the new one starts.
    const replaced = this.adopted;
    this.adopted = true;
    this.worker = worker;
    if (!this.heard.has(worker)) {
      this.heard.add(worker);
      worker.on('close', () => {
        this.stopped.add(worker);
        if (this.worker === worker) this.worker = null;
      });
      worker.on('console', (message) => {
        if (message.type() !== 'debug') return;
        const text = message.text();
        if (!text.startsWith(`${SM_DEV_EVENT} `)) return;
        let event: ExtensionEvent;
        try {
          event = JSON.parse(text.slice(SM_DEV_EVENT.length + 1)) as ExtensionEvent;
        } catch {
          return;
        }
        for (const listener of this.listeners) listener(event);
      });
    }
    const restored = await this.renewIn(worker);
    if (replaced) for (const listener of this.restartListeners) listener(restored);
  }

  /** Hears each event the extension sends. */
  onEvent(listener: (event: ExtensionEvent) => void): void {
    this.listeners.add(listener);
  }

  /**
   * Told when a new worker replaced the one before, whose events in
   * between are lost, with how many of the run's tab claims had to be
   * made again.
   */
  onRestart(listener: (restoredClaims: number) => void): void {
    this.restartListeners.add(listener);
  }

  // The worker to call: the current one, or the one running now if it
  // stopped.
  private async current(): Promise<Worker> {
    if (this.worker && !this.stopped.has(this.worker)) return this.worker;
    const worker = await findExtensionWorker(this.context);
    await this.adopt(worker);
    return worker;
  }

  /**
   * Runs `fn` in the worker. Tried again once in a new worker when the
   * one known stopped meanwhile; an error of the call's own is thrown,
   * not repeated, since a call may not be safe to make twice.
   */
  async call<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    if (this.absent !== null) throw new Error(this.absent);
    // Playwright's argument types don't follow a generic `A` through.
    const evaluate = (worker: Worker): Promise<R> => worker.evaluate(fn as never, arg as never) as Promise<R>;
    const worker = await this.current();
    try {
      return await evaluate(worker);
    } catch (err) {
      if (this.closed) throw err;
      // The worker's `close` can come just after the call it failed.
      for (let i = 0; i < 10 && !this.stopped.has(worker); i++) await new Promise((r) => setTimeout(r, 25));
      if (!this.stopped.has(worker)) throw err;
      return evaluate(await this.current());
    }
  }

  /**
   * Claims `page`'s tab for the run before it loads the run's page. The
   * tab is named to the extension by a navigation it watches for, to
   * `about:blank#<fragment>`, and the claim is recorded before this
   * returns. Leaves the tab on `about:blank`, for the run to load its
   * page in. Returns the tab's id. Throws an error naming the step that
   * failed. A link `without` SourceMonkey claims nothing, and makes up
   * an id.
   */
  async claimPage(page: Page, scriptsOff = false): Promise<number> {
    if (this.absent !== null) return --this.madeUpTabId;
    // Twice at most: the watch lives in the worker's memory, so a worker
    // Chrome restarted in between has none, and the next one watches anew.
    let tabId = await this.nameTab(page);
    if (tabId === null) tabId = await this.nameTab(page);
    if (tabId === null) throw new Error('SourceMonkey did not see the tab load about:blank, so it could not tell which tab it is');
    await this.call(({ id, runId, ttl }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.claimTab(id, runId, ttl),
    { id: tabId, runId: this.runId, ttl: LEASE_MS });
    if (scriptsOff) await this.setTabScriptsOff(tabId, true);
    this.tabs.set(tabId, { scriptsOff });
    try {
      const session = await this.context.newCDPSession(page);
      this.vouches.set(tabId, { session, script: null });
      // Without it, the tab's new documents don't run the marker.
      await session.send('Page.enable');
      await this.setVouch(tabId, !scriptsOff);
    } catch {
      // Unmarked, the run's scripts ask the extension before running,
      // which answers the same, later.
      await this.forgetVouch(tabId);
    }
    // The fragment off by history, not a navigation: one to `about:blank`
    // would swap the tab's main frame, and Playwright would then prefix
    // the page's snapshot refs (`f1e5`) as if it were an iframe.
    await page.evaluate(() => history.replaceState(null, '', location.href.split('#')[0]))
      .catch(() => page.goto('about:blank').catch(() => undefined));
    return tabId;
  }

  // The tab's `chrome.tabs` id, learned from a navigation the worker
  // watches for (`watchForNamingNavigation`). Null when it heard none.
  private async nameTab(page: Page): Promise<number | null> {
    const fragment = `sm-dev-${randomBytes(8).toString('hex')}`;
    await this.call(({ f, t }) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.watchForNamingNavigation(f, t), { f: fragment, t: NAMING_MS });
    try {
      await page.goto(`about:blank#${fragment}`);
    } catch (err) {
      // The watch ends on its own, as it times out.
      throw new Error(`The tab could not load about:blank, to tell SourceMonkey which tab it is: ${firstLine(err)}`);
    }
    return this.call((f) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.namedTab(f), fragment);
  }

  /**
   * A tab the extension claimed for the run itself (one a run tab
   * opened), for renewals to keep.
   */
  holdTab(tabId: number, scriptsOff = false): void {
    if (!this.tabs.has(tabId)) this.tabs.set(tabId, { scriptsOff });
  }

  /** The run no longer holds the tab (it closed). */
  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
    void this.forgetVouch(tabId);
  }

  /**
   * Marks a tab the run claimed, for every document it loads from now
   * on, as one whose scripts on the run's own get `run`, or takes the
   * marker away. Through a CDP script, which runs ahead of every
   * extension script in a new document. It only reaches the tab: the
   * tabs it opens, and its subframes, ask the extension. The marker is
   * gone with the session, as the run closes or its connection drops.
   */
  private async setVouch(tabId: number, on: boolean): Promise<void> {
    const vouch = this.vouches.get(tabId);
    if (!vouch || on === (vouch.script !== null)) return;
    if (on) {
      const { identifier } = await vouch.session.send('Page.addScriptToEvaluateOnNewDocument', {
        source: markerSource(SM_DEV_MARKERS.vouchPrefix + this.runId), worldName: VOUCH_WORLD,
      });
      vouch.script = identifier;
    } else {
      await vouch.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: vouch.script as string });
      vouch.script = null;
    }
  }

  /** Turns a claimed tab's scripts off or back on, for `--noscript` tabs. */
  async setTabScriptsOff(tabId: number, off: boolean): Promise<void> {
    // Off: the marker goes first, so no page in between runs a script.
    if (off) await this.setVouch(tabId, false).catch(() => this.forgetVouch(tabId));
    await this.call(({ t, o }) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.setTabScriptsOff(t, o), { t: tabId, o: off });
    const held = this.tabs.get(tabId);
    if (held) held.scriptsOff = off;
    if (!off) await this.setVouch(tabId, true).catch(() => undefined);
  }

  // Drops a tab's marker session, and the marker with it.
  private async forgetVouch(tabId: number): Promise<void> {
    const vouch = this.vouches.get(tabId);
    this.vouches.delete(tabId);
    await vouch?.session.detach().catch(() => undefined);
  }


  private async renew(): Promise<void> {
    if (this.closing) return;
    const worker = await this.current();
    // A worker started meanwhile was renewed as it was adopted.
    if (worker === this.worker) await this.renewIn(worker);
  }

  // Renews the run's lease in `worker`. Returns how many of its tab
  // claims had to be made again.
  private renewIn(worker: Worker): Promise<number> {
    if (this.closing) return Promise.resolve(0);
    const tabs = [...this.tabs].map(([tabId, t]) => ({ tabId, scriptsOff: t.scriptsOff }));
    const renewal = worker.evaluate(({ runId, ttl, held }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.renewRun(runId, ttl, held),
    { runId: this.runId, ttl: LEASE_MS, held: tabs });
    this.renewing.add(renewal);
    void renewal.finally(() => this.renewing.delete(renewal)).catch(() => undefined);
    return renewal;
  }

  /**
   * Installs or replaces one of the run's scripts in its test collection,
   * with the dependency bodies read from disk (`pushedFiles`).
   */
  /**
   * `source`: the file's `file://` URL, which `script list` shows. An
   * extension before protocol 1.2 ignores it.
   */
  async push(text: string, name: string, files: Record<string, PushedFile> = {}, source?: string): Promise<PushResult> {
    return this.call(({ run, t, n, f, s }) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.writeRunScript({ run, text: t, name: n, files: f, ...(s ? { source: s } : {}) }),
      { run: this.runId, t: text, n: name, f: files, s: source });
  }

  /** Which document `tabId` shows (see the worker's `tabDocument`), or null if it can't be read. */
  async tabDocument(tabId: number): Promise<{ url: string; timeOrigin: number } | null> {
    return this.call((id) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.tabDocument(id), tabId);
  }

  /** How the script's injected entry maps back to its files; see `remapStackText`. */
  async stackLayout(scriptId: string): Promise<StackLayout | null> {
    return this.call((id) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.getStackLayout(id), scriptId);
  }

  /**
   * A tab's frames, live documents only, as Chrome lists them to the
   * extension: straight from `chrome.webNavigation`, which every
   * extension sm-dev works with has, so no protocol version gates it.
   * Null when Chrome can't list them (the tab is gone).
   */
  async allFrames(tabId: number): Promise<ExtensionFrame[] | null> {
    return this.call((id) => chrome.webNavigation.getAllFrames({ tabId: id }).then(
      (frames) => frames?.map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, documentId: f.documentId, url: f.url })) ?? null,
      () => null,
    ), tabId);
  }

  /** A script's stored values, in the wire form the extension keeps. */
  async values(scriptId: string): Promise<Record<string, unknown>> {
    return this.call((id) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.getGmValues(id), scriptId);
  }

  /** A script's Log entries, oldest first, as its Log tab shows them. */
  async scriptLog(scriptId: string): Promise<LogEntry[]> {
    return this.call((id) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.getScriptLog(id), scriptId);
  }

  /** Writes values (wire form) as another tab of the script would. */
  async writeValues(scriptId: string, writes: { key: string; value?: unknown; deleted?: boolean }[]): Promise<void> {
    await this.call(({ id, w }) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.writeGmValues(id, w), { id: scriptId, w: writes });
  }

  /** The scripts the toolbar badge lists for a tab, with their status and collection. */
  async scriptsOnTab(tabId: number): Promise<{ id: string; name: string; status: string; collection: string; number?: number }[]> {
    return this.call((id) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.scriptsOnTab(id), tabId);
  }

  /**
   * Fires a menu command in a tab, as clicking it in the toolbar menu
   * does: in `documentId`, the document that registered it, when given.
   * An extension before protocol 2.1 ignores it, firing the first match.
   */
  async fireMenu(tabId: number, scriptId: string, commandId: string, documentId?: string): Promise<boolean> {
    const result = await this.call(({ t, s, c, d }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.fireActionContextMenuItem(t, s, c, d),
    { t: tabId, s: scriptId, c: commandId, d: documentId });
    return result.ok;
  }

  /**
   * Runs a manual script (`@run-at context-menu`) in a tab, as its popup
   * "Run this script" does. Throws with the extension's reason when it
   * can't.
   */
  async runManualScript(tabId: number, scriptId: string): Promise<void> {
    const result = await this.call(({ t, s }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.runManualScript(t, s),
    { t: tabId, s: scriptId });
    if (!result.ok) throw new Error(result.error ?? 'Internal error: SourceMonkey did not say why the script did not run');
  }

  /** The collections and installed scripts, for the `collection` and `script` commands. */
  readonly manager: ManagerControl = managerControl((fn, arg) => this.call(fn, arg));

  /** Clicks a shown notification, as the person would. False when it isn't showing. */
  async clickNotification(notificationId: string): Promise<boolean> {
    return this.call((id) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.clickNotification(id), notificationId);
  }

  /**
   * Answers a connection prompt, as the person would in its window.
   * False when it isn't waiting.
   */
  async answerConnectPrompt(promptId: string, choice: 'once' | 'cancel' | 'allow' | 'allow-all' | 'deny'): Promise<boolean> {
    return this.call(({ p, c }) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.answerConnectPrompt(p, c), { p: promptId, c: choice });
  }

  /** Closes a shown notification, as the person would. */
  async closeNotification(notificationId: string): Promise<boolean> {
    return this.call((id) => new Promise<boolean>((resolve) => chrome.notifications.clear(id, resolve)), notificationId);
  }

  /**
   * Releases the run's claims and subscription, which removes its test
   * collection, and stops renewing.
   */
  close(): Promise<void> {
    this.closing ??= this.release();
    return this.closing;
  }

  private async release(): Promise<void> {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.context.off('serviceworker', this.onWorker);
    await Promise.allSettled(this.renewing);
    // The markers go before the claims, so no page in between runs a
    // script on the strength of one.
    await Promise.allSettled([...this.vouches.values()].map((v) => v.session.detach()));
    this.vouches.clear();
    // Best effort: an unreleased claim runs out with its lease, and the
    // collection goes a while later.
    await this.call((runId) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.releaseRun(runId), this.runId)
      .catch(() => undefined);
    this.closed = true;
    this.listeners.clear();
    this.restartListeners.clear();
  }
}

/** An error's first line, without the call Playwright names at its start. */
export function firstLine(err: unknown): string {
  const line = (err as Error).message.split('\n')[0].replace(/^[\w.]+: /, '');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The collection and script commands' connection to SourceMonkey, with
 * no run: no tabs claimed, no events heard. For one command, made just
 * after the worker is found, so it doesn't look for a new one.
 * - Throws as `ExtensionLink.open` does for a protocol major that
 *   differs.
 * - Doesn't need "Allow User Scripts", since nothing here runs a script.
 */
export async function openManagerLink(context: BrowserContext): Promise<{ manager: ManagerControl; versionNote: string | null }> {
  const worker = await findExtensionWorker(context);
  const { note } = await checkedProtocol(worker);
  return {
    versionNote: note,
    // Playwright's argument types don't follow a generic through.
    manager: managerControl((fn, arg) => worker.evaluate(fn as never, arg as never)),
  };
}

// The manager calls, made with `invoke` (in the worker).
function managerControl(
  invoke: <A, R>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>,
): ManagerControl {
  // `self.SourceMonkey.managed`'s calls. A change it refuses fails with
  // its message alone, without the `worker.evaluate: Error: `
  // Playwright puts before it.
  const managed = async <A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> => {
    try {
      return await invoke(fn, arg);
    } catch (err) {
      throw new Error(firstLine(err).replace(/^Error: /, ''), { cause: err });
    }
  };
  type Sm = { SourceMonkey: Api };
  return {
    label: 'SourceMonkey',
    collections: () => invoke(() => (self as unknown as Sm).SourceMonkey.managedCollections(), undefined),
    scripts: () => invoke(() => (self as unknown as Sm).SourceMonkey.managedScripts(), undefined),
    onDisk: () => invoke(() => (self as unknown as Sm).SourceMonkey.managed.onDisk(), undefined),
    setScriptEnabled: (id, enabled) => managed(({ i, e }) => (self as unknown as Sm).SourceMonkey.managed.setScriptEnabled(i, e), { i: id, e: enabled }),
    setCollectionEnabled: (id, enabled) => managed(({ i, e }) => (self as unknown as Sm).SourceMonkey.managed.setCollectionEnabled(i, e), { i: id, e: enabled }),
    refreshScript: (id) => managed((i) => (self as unknown as Sm).SourceMonkey.managed.refreshScript(i), id),
    refreshCollection: (id) => managed((i) => (self as unknown as Sm).SourceMonkey.managed.refreshCollection(i), id),
    installScript: (location, collectionId) => managed(({ l, c }) =>
      (self as unknown as Sm).SourceMonkey.managed.installScript(l, c), { l: location, c: collectionId }),
    uninstallScript: (id) => managed((i) => (self as unknown as Sm).SourceMonkey.managed.uninstallScript(i), id),
    moveScript: (id, collectionId) => managed(({ i, c }) => (self as unknown as Sm).SourceMonkey.managed.moveScript(i, c), { i: id, c: collectionId }),
    renameCollection: (id, name) => managed(({ i, n }) => (self as unknown as Sm).SourceMonkey.managed.renameCollection(i, n), { i: id, n: name }),
    scriptDetails: (id) => managed((i) => (self as unknown as Sm).SourceMonkey.managed.scriptDetails(i), id),
    scriptText: (id) => managed((i) => (self as unknown as Sm).SourceMonkey.managed.scriptText(i), id),
  };
}

// The part of the worker's `self.SourceMonkey` this file calls.
interface Api {
  claimTab(tabId: number, runId: string, ttlMs: number): Promise<void>;
  watchForNamingNavigation(fragment: string, timeoutMs: number): void;
  namedTab(fragment: string): Promise<number | null>;
  renewRun(runId: string, ttlMs: number, tabs: { tabId: number; scriptsOff?: boolean }[]): Promise<number>;
  releaseRun(runId: string): Promise<void>;
  setTabScriptsOff(tabId: number, off: boolean): Promise<void>;
  writeRunScript(args: { run: string; text: string; name?: string; files?: Record<string, PushedFile>; source?: string }): Promise<PushResult>;
  tabDocument(tabId: number): Promise<{ url: string; timeOrigin: number } | null>;
  getStackLayout(scriptId: string): Promise<StackLayout | null>;
  getGmValues(scriptId: string): Promise<Record<string, unknown>>;
  getScriptLog(scriptId: string): Promise<LogEntry[]>;
  writeGmValues(scriptId: string, writes: { key: string; value?: unknown; deleted?: boolean }[]): Promise<void>;
  fireActionContextMenuItem(tabId: number, scriptId: string, commandId: string, documentId?: string): Promise<{ ok: boolean }>;
  runManualScript(tabId: number, scriptId: string): Promise<{ ok: boolean; error?: string }>;
  scriptsOnTab(tabId: number): Promise<{ id: string; name: string; status: string; collection: string; number?: number }[]>;
  clickNotification(notificationId: string): boolean;
  answerConnectPrompt(promptId: string, choice: 'once' | 'cancel' | 'allow' | 'allow-all' | 'deny'): Promise<boolean>;
  managedCollections(): Promise<ManagedCollection[]>;
  managedScripts(): Promise<ManagedScript[]>;
  managed: Omit<ManagerControl, 'label' | 'collections' | 'scripts' | 'onDisk'> & { onDisk(): Promise<ManagedOnDisk> };
}
