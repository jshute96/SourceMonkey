// A run's connection to the real SourceMonkey in its browser: the calls
// it makes into the extension's service worker, the tabs it claims, and
// the events the worker streams back. The extension's side is
// src/sm-dev-link.ts; the design is docs/sm-dev-extension.md.
//
// - Calls go through `self.SourceMonkey` in the worker, with Playwright's
//   `worker.evaluate`, as ExtensionBackend's do.
// - Chrome stops an idle worker and starts a new one later. A call made
//   while the known one is stopped goes to the new one, which is
//   listened to and subscribed to again; the run is told, since events
//   in between are lost.
// - The run's claims and its subscription are a lease, renewed here
//   while the run lasts, and released at its end. A renewal also claims
//   again any of the run's tabs whose claim the extension lost.

import type { BrowserContext, Page, Worker } from '@playwright/test';

import { SM_DEV_EVENT } from '../sm-dev-link.js';
import { ExtensionBackend, findExtensionWorker, sourceMonkeyExtensionId, type LogEntry, type PushResult } from './extension-backend.js';

// How long a claim lasts unrenewed, and how often it's renewed. A killed
// run's tabs run the extension's scripts again within the lease.
const LEASE_MS = 30_000;
const RENEW_MS = 10_000;

/** The calls an extension run needs, which an older SourceMonkey lacks. */
const NEEDED_CALLS = ['claimTab', 'renewRun', 'releaseRun', 'setTabScriptsOff', 'writeGmValues'];

/** Said when the extension in the browser is older than these calls. */
export const EXTENSION_TOO_OLD = 'SourceMonkey in this browser is older than this sm-dev, so it can\'t run --extension runs. '
  + 'Update it: rebuild it and reload it in chrome://extensions, or use --temp-browser, which loads this sm-dev\'s copy.';

/** An event from the extension, as sm-dev-link.ts and background.ts send them. */
export type ExtensionEvent =
  | {
    kind: 'report'; type: string; tabId: number; documentId: string; scriptId: string; name: string; url: string;
    message?: string; stack?: string; reason?: string; at: number;
  }
  | { kind: 'log'; scriptId: string; entry: LogEntry; fromReport?: boolean; at: number }
  | { kind: 'menu'; op: 'add' | 'remove'; tabId: number; documentId: string; scriptId: string; commandId: string; name?: string; at: number }
  | { kind: 'values'; scriptId: string; tabId?: number; writes: { key: string; value?: unknown; deleted?: boolean }[]; at: number }
  | { kind: 'tab-opened'; sourceTabId: number; tabId: number; url: string; at: number };

export class ExtensionLink {
  private worker: Worker | null = null;
  // Workers already listened to, so none gets a second listener.
  private readonly heard = new WeakSet<Worker>();
  // Workers that have stopped, whose handles fail every call.
  private readonly stopped = new WeakSet<Worker>();
  private readonly listeners = new Set<(event: ExtensionEvent) => void>();
  private readonly restartListeners = new Set<(restoredClaims: number) => void>();
  private renewTimer: NodeJS.Timeout | null = null;
  // The extension's script ids this run's tabs let run; null for none.
  private allow: string[] | null;
  // The tabs the run holds, for a renewal to claim again if lost.
  private readonly tabs = new Map<number, { scriptsOff: boolean }>();
  private closed = false;
  private readonly onWorker = (worker: Worker): void => {
    if (worker.url() === this.workerUrl) void this.adopt(worker).catch(() => undefined);
  };

  private constructor(
    private readonly context: BrowserContext,
    /** The run's id, which its claims carry. */
    readonly runId: string,
    allow: string[] | null,
    private readonly workerUrl: string,
  ) {
    this.allow = allow;
  }

  /**
   * Connects to the extension in `context`'s browser and subscribes to
   * its events. `allow` is what the run's tabs let run: the run's
   * scripts' ids for an extension run (none yet, before the first
   * push), null for none. Throws `EXTENSION_TOO_OLD` for an extension
   * without the calls this needs.
   */
  static async open(context: BrowserContext, runId: string, allow: string[] | null): Promise<ExtensionLink> {
    const workerUrl = `chrome-extension://${await sourceMonkeyExtensionId()}/background.js`;
    const link = new ExtensionLink(context, runId, allow, workerUrl);
    const worker = await findExtensionWorker(context);
    const missing = await worker.evaluate((names) => {
      const api = (self as unknown as { SourceMonkey?: Record<string, unknown> }).SourceMonkey ?? {};
      return names.filter((name) => typeof api[name] !== 'function');
    }, NEEDED_CALLS);
    if (missing.length > 0) throw new Error(EXTENSION_TOO_OLD);
    await link.adopt(worker);
    context.on('serviceworker', link.onWorker);
    link.renewTimer = setInterval(() => { void link.renew().catch(() => undefined); }, RENEW_MS);
    return link;
  }

  /** The origin of the extension's pages and its scripts' world. */
  get origin(): string {
    // Not `new URL(...).origin`, which is "null" for a scheme Node doesn't know.
    return this.workerUrl.replace(/\/background\.js$/, '');
  }

  // Makes `worker` the one calls go to: listened to once, and the run
  // subscribed in it.
  private async adopt(worker: Worker): Promise<void> {
    if (this.closed || worker === this.worker) return;
    const replaced = this.worker !== null;
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
    // Playwright's argument types don't follow a generic `A` through.
    const evaluate = (worker: Worker): Promise<R> => worker.evaluate(fn as never, arg as never) as Promise<R>;
    const worker = await this.current();
    try {
      return await evaluate(worker);
    } catch (err) {
      if (this.closed || !this.stopped.has(worker)) throw err;
      return evaluate(await this.current());
    }
  }

  /** The backend calls (push, clear, log, solo) through the current worker. */
  async backend(): Promise<ExtensionBackend> {
    return new ExtensionBackend(await this.current());
  }

  /**
   * Claims `page`'s tab for the run before it loads the run's page: it
   * visits a page of the extension, which can read its own tab id, and
   * the claim is recorded before this returns. Leaves the tab on that
   * page. Returns the tab's id. Throws an error naming the step that
   * failed.
   */
  async claimPage(page: Page, scriptsOff = false): Promise<number> {
    try {
      await page.goto(`${this.origin}/sm-dev.html`);
    } catch (err) {
      throw new Error(`The tab could not open SourceMonkey's sm-dev page: ${firstLine(err)}`);
    }
    const tabId = await page.evaluate(() => chrome.tabs.getCurrent().then((tab) => tab?.id ?? null)).catch(() => null);
    if (typeof tabId !== 'number') throw new Error('Internal error: The tab could not read its own id');
    await this.call(({ id, runId, allow, ttl }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.claimTab(id, runId, allow, ttl),
    { id: tabId, runId: this.runId, allow: this.allow, ttl: LEASE_MS });
    if (scriptsOff) await this.setTabScriptsOff(tabId, true);
    this.tabs.set(tabId, { scriptsOff });
    return tabId;
  }

  /**
   * A tab the extension claimed for the run itself (one a run tab
   * opened), for renewals to keep.
   */
  holdTab(tabId: number): void {
    if (!this.tabs.has(tabId)) this.tabs.set(tabId, { scriptsOff: false });
  }

  /** The run no longer holds the tab (it closed). */
  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /** Turns a claimed tab's scripts off or back on, for `--noscript` tabs. */
  async setTabScriptsOff(tabId: number, off: boolean): Promise<void> {
    await this.call(({ t, o }) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.setTabScriptsOff(t, o), { t: tabId, o: off });
    const held = this.tabs.get(tabId);
    if (held) held.scriptsOff = off;
  }

  /** Changes which scripts the run's tabs let run, after a push. */
  async setAllow(allow: string[] | null): Promise<void> {
    this.allow = allow;
    await this.renew();
  }

  private async renew(): Promise<void> {
    if (this.closed) return;
    const worker = await this.current();
    // A worker started meanwhile was renewed as it was adopted.
    if (worker === this.worker) await this.renewIn(worker);
  }

  // Renews the run's lease in `worker`. Returns how many of its tab
  // claims had to be made again.
  private renewIn(worker: Worker): Promise<number> {
    const tabs = [...this.tabs].map(([tabId, t]) => ({ tabId, scriptsOff: t.scriptsOff }));
    return worker.evaluate(({ runId, ttl, allow, held }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.renewRun(runId, ttl, allow, held),
    { runId: this.runId, ttl: LEASE_MS, allow: this.allow, held: tabs });
  }

  async push(text: string, name: string): Promise<PushResult> {
    return this.call(([t, n]) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.writeScratchScript({ text: t, name: n }), [text, name] as const);
  }

  async log(scriptId: string): Promise<LogEntry[]> {
    return this.call((id) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.getScriptLog(id), scriptId);
  }

  /** A script's stored values, in the wire form the extension keeps. */
  async values(scriptId: string): Promise<Record<string, unknown>> {
    return this.call((id) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.getGmValues(id), scriptId);
  }

  /** Writes values (wire form) as another tab of the script would. */
  async writeValues(scriptId: string, writes: { key: string; value?: unknown; deleted?: boolean }[]): Promise<void> {
    await this.call(({ id, w }) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.writeGmValues(id, w), { id: scriptId, w: writes });
  }

  /** Fires a menu command in a tab, as clicking it in the toolbar menu does. */
  async fireMenu(tabId: number, scriptId: string, commandId: string): Promise<boolean> {
    const result = await this.call(({ t, s, c }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.fireActionContextMenuItem(t, s, c),
    { t: tabId, s: scriptId, c: commandId });
    return result.ok;
  }

  /** Releases the run's claims and subscription, and stops renewing. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.context.off('serviceworker', this.onWorker);
    // Best effort: an unreleased claim runs out with its lease.
    await this.call((runId) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.releaseRun(runId), this.runId)
      .catch(() => undefined);
    this.closed = true;
    this.listeners.clear();
    this.restartListeners.clear();
  }
}

// An error's first line, without the call Playwright names at its start.
function firstLine(err: unknown): string {
  const line = (err as Error).message.split('\n')[0].replace(/^[\w.]+: /, '');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// The part of the worker's `self.SourceMonkey` this file calls.
interface Api {
  claimTab(tabId: number, runId: string, allow: string[] | null, ttlMs: number): Promise<void>;
  renewRun(runId: string, ttlMs: number, allow: string[] | null, tabs: { tabId: number; scriptsOff?: boolean }[]): Promise<number>;
  releaseRun(runId: string): Promise<void>;
  setTabScriptsOff(tabId: number, off: boolean): Promise<void>;
  writeScratchScript(args: { text: string; name?: string }): Promise<PushResult>;
  getScriptLog(scriptId: string): Promise<LogEntry[]>;
  getGmValues(scriptId: string): Promise<Record<string, unknown>>;
  writeGmValues(scriptId: string, writes: { key: string; value?: unknown; deleted?: boolean }[]): Promise<void>;
  fireActionContextMenuItem(tabId: number, scriptId: string, commandId: string): Promise<{ ok: boolean }>;
}
