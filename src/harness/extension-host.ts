// The host of a run whose scripts the real extension runs
// (`--extension`). The run's commands, waits and output read a host's
// reports, values and menus; this one fills them from the extension's
// events (extension-link.ts) and answers from the extension, so they
// work the same as in a harness run.
//
// - Events are translated into the bridge messages a harness page
//   sends (`sm:start`, `sm:gm-menu-register`, ...), and handled by the
//   harness host's own code, so the records are the same.
// - The run knows its scripts by their prepared ids; the extension by
//   its own. `setPushed` maps one to the other.
// - A tab is known by its `chrome.tabs` id once set up (`addTab`).
//   Events from a tab the run is still setting up wait for it; others
//   are not the run's.
// - A tab's events come over the worker's connection, its navigations
//   over the page's, and nothing orders the two. So an event from a
//   document the attachment hasn't seen arrive yet waits for it: a
//   report stamped before its document began would not count for it,
//   and a menu command recorded then would be cleared by the
//   navigation that follows.

import { SKIP_REASON_SM_DEV } from '../sm-dev-link.js';
import { HarnessHost, valueCodec, type MenuCommandRecord, type PageLink } from './host.js';
import type { ExtensionEvent, ExtensionLink } from './extension-link.js';

/** What the host needs of a tab's attachment, to order its events. */
export interface WatchedPage extends PageLink {
  /** When the page's current document began (see `PageAttachment.documentStart`). */
  documentStart(): number;
}

type TabEvent = Extract<ExtensionEvent, { kind: 'report' | 'menu' }>;

// How long a tab's event waits for its document, or for the tab to be
// set up, before it's handled anyway or dropped.
const DOCUMENT_WAIT_MS = 3000;
const SETUP_WAIT_MS = 10_000;

interface TabState {
  page: WatchedPage;
  // The extension's id for the document the tab's events are from now,
  // and when the attachment entered it. Undefined until the first event.
  documentId?: string;
  // The attachment's document when the last new document id came: the
  // next one waits for a later document.
  seenStart: number;
  // Events handled in order, each after the one before.
  queue: Promise<void>;
}

export class ExtensionHost extends HarnessHost {
  // The extension's script id by the run's, and back.
  private readonly extensionIds = new Map<string, string>();
  private readonly runIds = new Map<string, string>();
  private readonly tabs = new Map<number, TabState>();
  private readonly tabsByPage = new Map<PageLink, number>();
  // Events from tabs the run is setting up, by tab id, with when they came.
  private readonly early = new Map<number, { at: number; events: TabEvent[] }>();

  constructor(
    private readonly link: ExtensionLink,
    /** Prints a Log entry of one of the run's scripts. */
    private readonly printLog: (name: string, level: string, message: string) => void,
  ) {
    super();
    link.onEvent((event) => this.ingest(event));
  }

  /** The run's script `runId` is the extension's `extensionId`. */
  setPushed(runId: string, extensionId: string): void {
    const before = this.extensionIds.get(runId);
    if (before) this.runIds.delete(before);
    this.extensionIds.set(runId, extensionId);
    this.runIds.set(extensionId, runId);
  }

  /** The run's script the extension knows as `extensionId`, if any. */
  pushedAs(extensionId: string): string | undefined {
    return this.runIds.get(extensionId);
  }

  /** The extension's ids for the run's scripts, which its tabs let run. */
  pushedIds(): string[] {
    return [...this.extensionIds.values()];
  }

  /**
   * `page` is the run's tab `tabId`. `loaded`: the tab already shows the
   * document its first events are from (a tab adopted after it loaded),
   * so they needn't wait for a navigation.
   */
  addTab(page: WatchedPage, tabId: number, loaded = false): void {
    const state: TabState = { page, seenStart: loaded ? -Infinity : page.documentStart(), queue: Promise.resolve() };
    this.tabs.set(tabId, state);
    this.tabsByPage.set(page, tabId);
    this.link.holdTab(tabId);
    const early = this.early.get(tabId);
    this.early.delete(tabId);
    for (const event of early?.events ?? []) this.enqueue(state, event);
  }

  /** A tab the run will set up: its events wait for `addTab`. */
  expectTab(tabId: number): void {
    if (!this.tabs.has(tabId) && !this.early.has(tabId)) this.early.set(tabId, { at: Date.now(), events: [] });
  }

  tabIdOf(page: PageLink): number | undefined {
    return this.tabsByPage.get(page);
  }

  override detachPage(page: PageLink): void {
    const tabId = this.tabsByPage.get(page);
    if (tabId !== undefined) {
      this.tabs.delete(tabId);
      this.link.forgetTab(tabId);
    }
    this.tabsByPage.delete(page);
    super.detachPage(page);
  }

  override async valuesOf(scriptId: string): Promise<Record<string, unknown>> {
    const id = this.extensionIds.get(scriptId);
    if (!id) return {};
    const { decodeValue } = valueCodec();
    const wire = await this.link.values(id);
    return Object.fromEntries(Object.entries(wire).map(([k, v]) => [k, decodeValue(v)]));
  }

  override async setValues(scriptId: string, values: Record<string, unknown>): Promise<void> {
    const id = this.extensionIds.get(scriptId);
    if (!id) throw new Error('Internal error: The script was never pushed into the extension');
    const { encodeValue } = valueCodec();
    await this.link.writeValues(id, Object.entries(values).map(([key, v]) =>
      (v === undefined ? { key, deleted: true } : { key, value: encodeValue(v) })));
  }

  override async fireMenuEntry(entry: MenuCommandRecord): Promise<boolean> {
    const page = this.pageOf(entry);
    const tabId = page && this.tabsByPage.get(page);
    const id = this.extensionIds.get(entry.scriptId);
    if (tabId === undefined || !id) return false;
    return this.link.fireMenu(tabId, id, entry.commandId);
  }

  private ingest(event: ExtensionEvent): void {
    if (event.kind === 'log') {
      const runId = this.runIds.get(event.scriptId);
      // A report's own entry (started, threw, skipped) prints as the report.
      if (!runId || event.fromReport) return;
      this.printLog(this.nameOf(runId), event.entry.level, event.entry.message);
      return;
    }
    if (event.kind === 'values') {
      const runId = this.runIds.get(event.scriptId);
      // A write with no tab is the run's own `set` (or another run's),
      // which says so itself.
      const page = event.tabId === undefined ? undefined : this.tabs.get(event.tabId)?.page;
      if (runId && page) void this.handle({ type: 'sm:gm-batch-write', scriptId: runId, writes: event.writes }, page, 'isolated');
      return;
    }
    if (event.kind === 'tab-opened') return;
    if (!this.runIds.has(event.scriptId)) return;
    const state = this.tabs.get(event.tabId);
    if (state) {
      this.enqueue(state, event);
      return;
    }
    const early = this.early.get(event.tabId);
    if (!early) return;
    // A tab whose setup never finished doesn't hold events for good.
    if (Date.now() - early.at > SETUP_WAIT_MS) this.early.delete(event.tabId);
    else early.events.push(event);
  }

  private enqueue(state: TabState, event: TabEvent): void {
    state.queue = state.queue.then(() => this.handleTabEvent(state, event)).catch(() => undefined);
  }

  private async handleTabEvent(state: TabState, event: TabEvent): Promise<void> {
    if (event.documentId && event.documentId !== state.documentId) {
      // A new document: wait for the attachment to have entered one
      // after the last, so what this records counts for it.
      const deadline = Date.now() + DOCUMENT_WAIT_MS;
      while (state.page.documentStart() <= state.seenStart && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      state.documentId = event.documentId;
      state.seenStart = state.page.documentStart();
    }
    const runId = this.runIds.get(event.scriptId);
    if (!runId || !this.tabs.has(event.tabId)) return;
    if (event.kind === 'menu') {
      await this.handle(event.op === 'add'
        ? { type: 'sm:gm-menu-register', scriptId: runId, commandId: event.commandId, name: event.name ?? '' }
        : { type: 'sm:gm-menu-unregister', scriptId: runId, commandId: event.commandId }, state.page, 'isolated');
      return;
    }
    // A tab with its scripts turned off (`--noscript`) skips them on
    // each load, as asked: nothing to say.
    if (event.type === 'sm:abandoned' && event.reason === SKIP_REASON_SM_DEV) return;
    const type = { 'sm:start': 'sm:start', 'sm:swapped': 'sm:start', 'sm:error': 'sm:error', 'sm:abandoned': 'sm:abandoned' }[event.type];
    if (!type) return;
    await this.handle({
      type, id: runId, name: event.name, url: event.url,
      message: event.message, stack: event.stack, reason: event.reason,
    }, state.page, 'isolated');
  }
}
