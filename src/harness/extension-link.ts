// A run's connection to the real SourceMonkey in its browser: the calls
// it makes into the extension's service worker, the tabs it claims, and
// the events the worker streams back. The extension's side is
// src/sm-dev-link.ts; the design is docs/sm-dev-extension.md.
//
// - Calls go through `self.SourceMonkey` in the worker, with Playwright's
//   `worker.evaluate`, as ExtensionBackend's do.
// - Chrome stops an idle worker and starts a new one later. Each call
//   uses the current one, and a new one is subscribed to again; the
//   run is told, so it can catch up on what it missed.
// - The run's claims and its subscription are a lease, renewed here
//   while the run lasts, and released at its end.

import type { BrowserContext, Page, Worker } from '@playwright/test';

import { ExtensionBackend, findExtensionWorker, sourceMonkeyExtensionId, type LogEntry, type PushResult } from './extension-backend.js';

/** The first argument of each event's console line (`SM_DEV_EVENT` in sm-dev-link.ts). */
const SM_DEV_EVENT = 'sm-dev-event';

// How long a claim lasts unrenewed, and how often it's renewed. A killed
// run's tabs run the extension's scripts again within the lease.
const LEASE_MS = 30_000;
const RENEW_MS = 10_000;

/** An event from the extension, as sm-dev-link.ts and background.ts send them. */
export type ExtensionEvent =
  | { kind: 'report'; type: string; tabId: number; scriptId: string; name: string; url: string; message?: string; stack?: string; reason?: string; at: number }
  | { kind: 'log'; scriptId: string; entry: LogEntry; at: number }
  | { kind: 'menu'; op: 'add' | 'remove'; tabId: number; scriptId: string; commandId: string; name?: string; at: number }
  | { kind: 'values'; scriptId: string; tabId?: number; writes: { key: string; value?: unknown; deleted?: boolean }[]; at: number }
  | { kind: 'tab-opened'; sourceTabId: number; tabId: number; url: string; at: number };

export class ExtensionLink {
  private worker: Worker | null = null;
  private readonly listeners = new Set<(event: ExtensionEvent) => void>();
  private readonly restartListeners = new Set<() => void>();
  private renewTimer: NodeJS.Timeout | null = null;
  // The extension's script ids this run's tabs let run; null for none
  // (a harness run).
  private allow: string[] | null;
  private closed = false;
  private readonly onWorker = (worker: Worker): void => {
    void this.adopt(worker);
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
   * push), null for a harness run.
   */
  static async open(context: BrowserContext, runId: string, allow: string[] | null): Promise<ExtensionLink> {
    const workerUrl = `chrome-extension://${await sourceMonkeyExtensionId()}/background.js`;
    const link = new ExtensionLink(context, runId, allow, workerUrl);
    await link.adopt(await findExtensionWorker(context));
    context.on('serviceworker', link.onWorker);
    link.renewTimer = setInterval(() => { void link.renew().catch(() => undefined); }, RENEW_MS);
    return link;
  }

  /** The origin of the extension's pages and its scripts' world. */
  get origin(): string {
    // Not `new URL(...).origin`, which is "null" for a scheme Node doesn't know.
    return this.workerUrl.replace(/\/background\.js$/, '');
  }

  // Listens to a worker's events, and subscribes the run in it.
  private async adopt(worker: Worker): Promise<void> {
    if (this.closed || worker.url() !== this.workerUrl || worker === this.worker) return;
    const replaced = this.worker !== null;
    this.worker = worker;
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
    // Waits for the worker to be ready, as each call does.
    await this.renew();
    if (replaced) for (const listener of this.restartListeners) listener();
  }

  /** Hears each event the extension sends. */
  onEvent(listener: (event: ExtensionEvent) => void): void {
    this.listeners.add(listener);
  }

  /** Told when a new worker replaced the one before, whose events in between are lost. */
  onRestart(listener: () => void): void {
    this.restartListeners.add(listener);
  }

  // The worker to call: the current one, or found again if it's gone.
  private async current(): Promise<Worker> {
    if (this.worker) return this.worker;
    const worker = await findExtensionWorker(this.context);
    await this.adopt(worker);
    return worker;
  }

  /** Runs `fn` in the worker, finding it again once if the one known stopped. */
  async call<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    // Playwright's argument types don't follow a generic `A` through.
    const evaluate = (worker: Worker): Promise<R> => worker.evaluate(fn as never, arg as never) as Promise<R>;
    const worker = await this.current();
    try {
      return await evaluate(worker);
    } catch (err) {
      // A stopped worker's handle fails; a new one is listed once it's
      // woken. An error from the call itself fails again, and is thrown.
      if (this.closed) throw err;
      this.worker = null;
      return evaluate(await this.current());
    }
  }

  /** The backend calls (push, clear, log) through the current worker. */
  async backend(): Promise<ExtensionBackend> {
    return new ExtensionBackend(await this.current());
  }

  /**
   * Claims `page`'s tab for the run before it loads the run's page: it
   * visits a page of the extension, which can read its own tab id, and
   * the claim is recorded before this returns. Leaves the tab on that
   * page. Returns the tab's id.
   */
  async claimPage(page: Page): Promise<number> {
    await page.goto(`${this.origin}/sm-dev.html`);
    const tabId = await page.evaluate(() => chrome.tabs.getCurrent().then((tab) => tab?.id ?? null));
    if (typeof tabId !== 'number') throw new Error('Internal error: the tab could not tell its own id');
    await this.call(({ tabId: id, runId, allow, ttl }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.claimTab(id, runId, allow, ttl),
    { tabId, runId: this.runId, allow: this.allow, ttl: LEASE_MS });
    return tabId;
  }

  /** Turns a claimed tab's scripts off or back on, for `--noscript` tabs. */
  async setTabScriptsOff(tabId: number, off: boolean): Promise<void> {
    await this.call(({ t, o }) => (self as unknown as { SourceMonkey: Api }).SourceMonkey.setTabScriptsOff(t, o), { t: tabId, o: off });
  }

  /** Changes which scripts the run's tabs let run, after a push. */
  async setAllow(allow: string[] | null): Promise<void> {
    this.allow = allow;
    await this.renew();
  }

  private async renew(): Promise<void> {
    if (this.closed || !this.worker) return;
    await this.worker.evaluate(({ runId, ttl, allow }) =>
      (self as unknown as { SourceMonkey: Api }).SourceMonkey.renewRun(runId, ttl, allow),
    { runId: this.runId, ttl: LEASE_MS, allow: this.allow });
  }

  async push(text: string, name: string): Promise<PushResult> {
    return (await this.backend()).push(text, name);
  }

  async log(scriptId: string): Promise<LogEntry[]> {
    return (await this.backend()).log(scriptId);
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

// The part of the worker's `self.SourceMonkey` this file calls.
interface Api {
  claimTab(tabId: number, runId: string, allow: string[] | null, ttlMs: number): Promise<void>;
  renewRun(runId: string, ttlMs: number, allow?: string[] | null): Promise<void>;
  releaseRun(runId: string): Promise<void>;
  setTabScriptsOff(tabId: number, off: boolean): Promise<void>;
  getGmValues(scriptId: string): Promise<Record<string, unknown>>;
  writeGmValues(scriptId: string, writes: { key: string; value?: unknown; deleted?: boolean }[]): Promise<void>;
  fireActionContextMenuItem(tabId: number, scriptId: string, commandId: string): Promise<{ ok: boolean }>;
}
