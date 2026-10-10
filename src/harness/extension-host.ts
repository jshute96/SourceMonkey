// The host of a run, or of the spec fixture's test: the real extension
// runs the scripts, and this fills the host's reports, values and menus
// (host.ts) from its events (extension-link.ts), and answers the run's
// commands from it.
//
// - The run knows its scripts by their prepared ids; the extension by
//   its own. `setPushed` maps one to the other.
// - A tab is known by its `chrome.tabs` id once set up (`addTab`).
//   Events from a tab the run is still setting up wait for it; others
//   are not the run's.
// - A tab's events come over the worker's connection, its navigations
//   over the page's, and nothing orders the two. So an event from a
//   top-frame document the attachment hasn't seen arrive yet waits for
//   it: a report stamped before its document began would not count for
//   it, and a menu command recorded then would be cleared by the
//   navigation that follows. Only a top-frame event's document counts:
//   an iframe's events carry the iframe's document, which no navigation
//   of the tab's would ever match.
// - The run reports only on its own tabs: events from others, and Log
//   entries made in them, are left out.

import type { Frame, Page } from '@playwright/test';

import { SM_ABANDONED_MSG, SM_ERROR_MSG, SM_MANUAL_MSG, SM_START_MSG, SM_SWAPPED_MSG } from '../runtime-messages.js';
import { evalHookKey } from '../eval-hook.js';
import { SKIP_REASON_SM_DEV } from '../sm-dev-protocol.js';
import { remapStackText } from '../stack-link.js';
import type { StackLayout } from '../composed-source.js';
import { decodeOwnRefs } from './page-output.js';
import {
  HarnessHost, valueCodec, type ConnectChoice, type ConnectPromptRecord, type DownloadRecord, type MenuCommandRecord, type NotificationRecord, type PageLink, type TabRecord, type XhrRecord,
} from './host.js';
import type { ConsoleContext, OtherScript } from './console-commands.js';
import type { LogEntry } from './extension-backend.js';
import type { ExtensionEvent, ExtensionLink } from './extension-link.js';
import { frameNodes, matchFrameTrees } from './frames.js';

/** What the host needs of a tab's attachment, to order its events. */
export interface WatchedPage extends PageLink {
  /** When the page's current document began (see `PageAttachment.documentStart`). */
  documentStart(): number;
  /** The tab's page, whose frames the extension's are matched to. */
  readonly page: Page;
}

type TabEvent = Extract<ExtensionEvent, { kind: 'report' | 'menu' | 'values' | 'request' | 'download' | 'notification' | 'connect-prompt' }>;

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
  // The extension's frame ids matched to the page's frames, kept so
  // each of two sibling frames with one URL keeps its match.
  frames: Map<number, Frame>;
  // Each live iframe document's frame, as last matched.
  documents: Map<string, Frame>;
  // Iframe documents that matched no frame when their first event came,
  // not looked for again: each look costs the event queue a wait.
  unmatched: Set<string>;
}

export class ExtensionHost extends HarnessHost {
  // The extension's script id by the run's, and back.
  private readonly extensionIds = new Map<string, string>();
  private readonly runIds = new Map<string, string>();
  // Each pushed script's line layout, by the extension's id.
  private readonly layouts = new Map<string, StackLayout>();
  private readonly tabs = new Map<number, TabState>();
  private readonly tabsByPage = new Map<PageLink, number>();
  // Events from tabs the run is setting up, by tab id, with when they came.
  private readonly early = new Map<number, { at: number; events: TabEvent[] }>();
  // The SourceMonkey-managed scripts the run has listed, by label (`E1`), and
  // each one's label by its id, kept for the run.
  private readonly others = new Map<string, OtherScript>();
  private readonly otherLabels = new Map<string, string>();
  // The newest Log entry's time seen for each pushed script, by the
  // extension's id, so catching up after a restart prints only the rest.
  private readonly logSeen = new Map<string, number>();
  // While catchUpLogs reads a Log back: the first entry heard live since.
  private readonly liveFrom = new Map<string, number>();
  // The extension's notification id for each shown one, by request id,
  // to click or close it.
  private readonly notificationIds = new Map<string, string>();

  constructor(
    private readonly link: ExtensionLink,
    /**
     * Logs a Log entry of one of the run's scripts (`scriptId`: the
     * run's id), with the tab it was made in, if any.
     */
    private readonly printLog: (entry: { scriptId: string; name: string; level: string; message: string; page?: PageLink }) => void,
  ) {
    super();
    link.onEvent((event) => this.ingest(event));
  }

  /** The run's script `runId` is the extension's `extensionId`. */
  setPushed(runId: string, extensionId: string): void {
    const before = this.extensionIds.get(runId);
    if (before) {
      this.runIds.delete(before);
      this.layouts.delete(before);
    }
    this.extensionIds.set(runId, extensionId);
    this.runIds.set(extensionId, runId);
    // Entries from before the push (a replaced copy's) are no part of the run.
    this.logSeen.set(extensionId, Math.max(this.logSeen.get(extensionId) ?? 0, Date.now()));
  }

  /**
   * After the extension's worker restarted, logs the Log entries of the
   * run's scripts made meanwhile, whose events were lost.
   */
  async catchUpLogs(): Promise<void> {
    for (const [extensionId, runId] of [...this.runIds]) {
      // The gap is from the last entry seen to the first the new worker
      // sends live while the Log is read, which is logged already.
      const seen = this.logSeen.get(extensionId) ?? 0;
      this.liveFrom.set(extensionId, Infinity);
      const entries = await this.link.scriptLog(extensionId).catch(() => []);
      const live = this.liveFrom.get(extensionId) ?? Infinity;
      this.liveFrom.delete(extensionId);
      for (const entry of entries) if (entry.timestamp > seen && entry.timestamp < live) this.logEntry(extensionId, runId, entry);
    }
  }

  // A Log entry of one of the run's scripts: logged when it was made in
  // one of the run's tabs, or outside any (a `@require` that failed to
  // load).
  private logEntry(extensionId: string, runId: string, entry: LogEntry): void {
    this.logSeen.set(extensionId, Math.max(this.logSeen.get(extensionId) ?? 0, entry.timestamp));
    const tabId = entry.tabId;
    if (tabId !== undefined && !this.tabs.has(tabId) && !this.early.has(tabId)) return;
    const page = tabId === undefined ? undefined : this.tabs.get(tabId)?.page;
    this.printLog({ scriptId: runId, name: this.nameOf(runId), level: entry.level, message: decodeOwnRefs(this.remapStack(entry.message)), page });
  }

  /** The extension's id for the run's script `runId`, once pushed. */
  extensionIdOf(runId: string): string | undefined {
    return this.extensionIds.get(runId);
  }

  /** How the extension's script `extensionId` maps back to its files, if known. */
  setLayout(extensionId: string, layout: StackLayout | null): void {
    if (layout) this.layouts.set(extensionId, layout);
    else this.layouts.delete(extensionId);
  }

  // The extension runs the scripts under its own entry URLs, so their
  // stack lines map by the layouts it reports (`setLayout`). Another
  // manager maps its own.
  override remapStack(text: string): string {
    if (this.external) return this.external.remap?.(text) ?? text;
    return remapStackText(text, this.layouts.values());
  }

  /**
   * The run's script whose code one of `urls` is (a stack frame's, or
   * a stack's text), by the entry URLs the extension runs them under.
   */
  scriptOf(urls: string[]): string | undefined {
    for (const url of urls) {
      for (const [extensionId, layout] of this.layouts) {
        if (url.includes(layout.entryUrl)) return this.runIds.get(extensionId);
      }
      const external = this.external?.idOf(url);
      if (external !== undefined) return this.runIds.get(external);
    }
    return undefined;
  }

  /**
   * Under another manager (Violentmonkey, Tampermonkey), which reports
   * nothing: how its code's URLs name scripts, by the manager's id
   * (`setPushed`), what every URL it runs code under starts with, and
   * how it maps stack lines it moved.
   */
  external?: { idOf(url: string): string | undefined; prefix: string; remap?(text: string): string };

  override get getsReports(): boolean {
    return this.external === undefined;
  }

  /**
   * `page` is the run's tab `tabId`. `loaded`: the tab already shows the
   * document its first events are from (a tab adopted after it loaded),
   * so they needn't wait for a navigation. `scriptsOff`: its claim runs
   * no scripts (opened from a `--noscript` tab), to keep if restored.
   */
  addTab(page: WatchedPage, tabId: number, loaded = false, scriptsOff = false): void {
    const state: TabState = {
      page, seenStart: loaded ? -Infinity : page.documentStart(), queue: Promise.resolve(), frames: new Map(), documents: new Map(), unmatched: new Set(),
    };
    this.tabs.set(tabId, state);
    this.tabsByPage.set(page, tabId);
    this.link.holdTab(tabId, scriptsOff);
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

  override async liveFrameDocuments(page: PageLink): Promise<Map<string, Frame> | null> {
    const tabId = this.tabsByPage.get(page);
    const state = tabId === undefined ? undefined : this.tabs.get(tabId);
    if (tabId === undefined || !state) return null;
    // Before protocol 2.1, the extension ran no scripts in iframes, and
    // its reports say nothing of frames.
    this.link.requireMinor(1, 'Showing which scripts run in iframes');
    return this.matchFrames(tabId, state);
  }

  // Lists the tab's frames from the extension and matches them to the
  // page's: the live iframe documents, each with its frame. When the
  // listing fails (the worker restarting, say), the last answer stands:
  // an empty one would show every frame's scripts as gone.
  private async matchFrames(tabId: number, state: TabState): Promise<Map<string, Frame>> {
    const listed = await this.link.allFrames(tabId).catch(() => null);
    if (!listed) return state.documents;
    const nodes = frameNodes(state.page.page, this.frameIds).map((n) => ({ key: n.frame, parent: n.parent === null ? null : n.frame.parentFrame(), url: n.url }));
    const matched = new Map([...matchFrameTrees(listed, nodes, state.frames)].filter((e): e is [number, Frame] => e[1] !== null));
    // A frame left out this time only because its URL is between two
    // (mid-navigation) keeps its match, so same-URL siblings don't swap.
    const taken = new Set(matched.values());
    for (const f of listed) {
      const was = state.frames.get(f.frameId);
      if (was && !matched.has(f.frameId) && !was.isDetached() && !taken.has(was)) matched.set(f.frameId, was);
    }
    state.frames = matched;
    const live = new Map<string, Frame>();
    for (const f of listed) {
      const frame = matched.get(f.frameId);
      if (frame) live.set(f.documentId, frame);
    }
    state.documents = live;
    return live;
  }

  // The frame number of the iframe document an event came from, for
  // its line and menu label. A document new since the last match lists
  // the frames again, and once more after a moment: Playwright can hear
  // of a frame after the extension does. One that still matches none
  // isn't looked for again.
  private async frameNumberOf(tabId: number, state: TabState, documentId: string): Promise<number | undefined> {
    const known = state.documents.get(documentId);
    if (known && !known.isDetached()) return this.frameIds.number(known);
    if (state.unmatched.has(documentId)) return undefined;
    for (const wait of [0, 200]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const frame = (await this.matchFrames(tabId, state)).get(documentId);
      if (frame) return this.frameIds.number(frame);
    }
    state.unmatched.add(documentId);
    return undefined;
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

  // The extension gives a test collection's scripts their run's hook,
  // under the script's id there.
  override evalHook(scriptId: string): { key: string; id: string } | null {
    const id = this.extensionIds.get(scriptId);
    return id ? { key: evalHookKey(this.link.runId), id } : null;
  }

  override async valuesOf(scriptId: string): Promise<Record<string, unknown>> {
    const id = this.extensionIds.get(scriptId);
    return id ? this.extensionValues(id) : {};
  }

  // Into the extension, and the host's own copy, which `getValue` reads
  // without a round trip (the fixture's `gm.get`). The tabs' own writes
  // reach that copy as events.
  override async setValues(scriptId: string, values: Record<string, unknown>): Promise<void> {
    const id = this.extensionIds.get(scriptId);
    if (!id) throw new Error('Internal error: The script was never pushed into the extension');
    await this.writeExtensionValues(id, values);
    await super.setValues(scriptId, values);
  }

  // A script's values by the extension's id, decoded.
  private async extensionValues(id: string): Promise<Record<string, unknown>> {
    const { decodeValue } = valueCodec();
    const wire = await this.link.values(id);
    return Object.fromEntries(Object.entries(wire).map(([k, v]) => [k, decodeValue(v)]));
  }

  private async writeExtensionValues(id: string, values: Record<string, unknown>): Promise<void> {
    const { encodeValue } = valueCodec();
    await this.link.writeValues(id, Object.entries(values).map(([key, v]) =>
      (v === undefined ? { key, deleted: true } : { key, value: encodeValue(v) })));
  }

  // One object per script, brought up to date, so one picked earlier
  // (`scripts E1`) shows what the latest listing found.
  private other(id: string, label: string, facts: Partial<Pick<OtherScript, 'name' | 'collection' | 'status'>>): OtherScript {
    const other = this.others.get(label) ?? {
      label, name: '', collection: '', status: '',
      values: () => this.extensionValues(id),
      setValues: (values: Record<string, unknown>) => this.writeExtensionValues(id, values),
    };
    Object.assign(other, facts);
    this.others.set(label, other);
    return other;
  }

  /**
   * The SourceMonkey-managed scripts, for the commands (`ConsoleContext.others`).
   * `guarded`: `set` on one changes the person's real data.
   */
  otherScripts(guarded: boolean): NonNullable<ConsoleContext['others']> {
    return {
      guarded,
      byLabel: (label) => this.others.get(label),
      onTab: async (tab) => {
        const tabId = this.tabsByPage.get(tab.link);
        if (tabId === undefined) return [];
        const rows = await this.link.scriptsOnTab(tabId);
        return rows.filter((row) => !this.runIds.has(row.id)).map((row) => {
          // SourceMonkey's own number for the script (`E12`), the same
          // in every run. An extension before protocol 1.1 numbers none,
          // and gets the run's own numbering, in the order first seen.
          let label = row.number !== undefined ? `E${row.number}` : this.otherLabels.get(row.id);
          if (!label) label = `E${this.otherLabels.size + 1}`;
          this.otherLabels.set(row.id, label);
          return this.other(row.id, label, { name: row.name, collection: row.collection, status: row.status });
        });
      },
      installed: (id, label, name, collection) => this.other(id, label, { name, collection }),
    };
  }

  override async answerConnectPrompt(promptId: string, choice: ConnectChoice): Promise<boolean> {
    return this.link.answerConnectPrompt(promptId, choice);
  }

  override async clickNotification(requestId: string): Promise<boolean> {
    const id = this.notificationIds.get(requestId);
    return id ? this.link.clickNotification(id) : false;
  }

  override async closeNotification(requestId: string): Promise<boolean> {
    const id = this.notificationIds.get(requestId);
    return id ? this.link.closeNotification(id) : false;
  }

  override async runManualScript(page: PageLink, scriptId: string): Promise<void> {
    const tabId = this.tabsByPage.get(page);
    const id = this.extensionIds.get(scriptId);
    if (tabId === undefined || !id) throw new Error('Internal error: sm-dev has no tab or script to run it in');
    await this.link.runManualScript(tabId, id);
  }

  override async fireMenuEntry(entry: MenuCommandRecord): Promise<boolean> {
    const page = this.pageOf(entry);
    const tabId = page && this.tabsByPage.get(page);
    const id = this.extensionIds.get(entry.scriptId);
    if (tabId === undefined || !id) return false;
    return this.link.fireMenu(tabId, id, entry.commandId, entry.documentId);
  }

  private ingest(event: ExtensionEvent): void {
    if (event.kind === 'log') {
      const runId = this.runIds.get(event.scriptId);
      if (!runId) return;
      const live = this.liveFrom.get(event.scriptId);
      if (live !== undefined) this.liveFrom.set(event.scriptId, Math.min(live, event.entry.timestamp));
      // A report's own entry (started, threw, skipped) prints as the
      // report, but counts as seen.
      if (event.fromReport) {
        this.logSeen.set(event.scriptId, Math.max(this.logSeen.get(event.scriptId) ?? 0, event.entry.timestamp));
        return;
      }
      this.logEntry(event.scriptId, runId, event.entry);
      return;
    }
    if (event.kind === 'tab-opened') {
      this.recordOpenedTab(event);
      return;
    }
    if (event.kind === 'tab-closed') {
      const runId = this.runIds.get(event.scriptId);
      const record = runId ? this.reports.tabs.find((t) => t.scriptId === runId && t.requestId === event.requestId) : undefined;
      if (record) record.closed = true;
      return;
    }
    // A write with no tab is the run's own `set` (or another run's),
    // which says so itself.
    if (event.kind === 'values' && event.tabId === undefined) return;
    const tabId = event.tabId!;
    if (!this.runIds.has(event.scriptId)) return;
    const state = this.tabs.get(tabId);
    if (state) {
      this.enqueue(state, event);
      return;
    }
    const early = this.early.get(tabId);
    if (!early) return;
    // A tab whose setup never finished doesn't hold events for good.
    if (Date.now() - early.at > SETUP_WAIT_MS) this.early.delete(tabId);
    else early.events.push(event);
  }

  private enqueue(state: TabState, event: TabEvent): void {
    state.queue = state.queue.then(() => this.handleTabEvent(state, event)).catch(() => undefined);
  }

  private async handleTabEvent(state: TabState, event: TabEvent): Promise<void> {
    if ((event.kind === 'report' || event.kind === 'menu') && event.topFrame !== false && event.documentId && event.documentId !== state.documentId) {
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
    if (!runId || !this.tabs.has(event.tabId!)) return;
    // An iframe's report or menu command names its frame. Looked up
    // only for what's recorded, after the events that are dropped.
    const inFrame = (event.kind === 'report' || event.kind === 'menu') && event.topFrame === false;
    const frameNumber = async (): Promise<{ frameNumber?: number }> => {
      const n = inFrame && event.documentId ? await this.frameNumberOf(event.tabId!, state, event.documentId) : undefined;
      return n === undefined ? {} : { frameNumber: n };
    };
    if (event.kind === 'request' || event.kind === 'download' || event.kind === 'notification') {
      this.recordActivity(runId, state.page, event);
      return;
    }
    if (event.kind === 'connect-prompt') {
      this.recordConnectPrompt(runId, state.page, event);
      return;
    }
    if (event.kind === 'values') {
      this.recordValueWrites(state.page, runId, event.writes);
      return;
    }
    if (event.kind === 'menu') {
      if (event.op === 'add') this.registerMenu(state.page, runId, event.commandId, event.name ?? '', event.documentId || undefined, inFrame ? await frameNumber() : undefined);
      else this.unregisterMenu(state.page, runId, event.commandId, event.documentId || undefined);
      return;
    }
    // A tab with its scripts turned off (`--noscript`) skips them on
    // each load, as asked: nothing to say.
    if (event.type === SM_ABANDONED_MSG && event.reason === SKIP_REASON_SM_DEV) return;
    const fields = {
      scriptId: runId, name: event.name, url: event.url,
      ...(inFrame ? { frame: true as const } : {}),
      ...(event.documentId ? { documentId: event.documentId } : {}),
      ...await frameNumber(),
    };
    if (event.type === SM_START_MSG || event.type === SM_SWAPPED_MSG) {
      this.recordStart(state.page, fields);
    } else if (event.type === SM_ERROR_MSG) {
      this.recordError(state.page, { ...fields, message: event.message ?? '', stack: event.stack ?? '' });
    } else if (event.type === SM_MANUAL_MSG) {
      this.recordManual(state.page, fields);
    } else if (event.type === SM_ABANDONED_MSG) {
      // With no decision, the why (`detail`, from protocol 1.4) rather
      // than its token.
      this.recordSkip(state.page, { ...fields, reason: event.detail?.replace(/\.+$/, '') || event.reason || 'skip' });
    }
  }

  // A `GM_openInTab` of one of the run's scripts, from one of its tabs.
  private recordOpenedTab(event: Extract<ExtensionEvent, { kind: 'tab-opened' }>): void {
    const runId = event.scriptId === undefined ? undefined : this.runIds.get(event.scriptId);
    const from = this.tabs.get(event.sourceTabId)?.page;
    if (!runId || !from) return;
    const record: TabRecord = {
      scriptId: runId, requestId: event.requestId ?? '', url: event.url, active: event.active === true, at: event.at, closed: false,
    };
    this.reports.tabs.push(record);
    this.recordPages.set(record, from);
    this.notify('tab', record);
  }

  // A connection prompt for one of the run's scripts: one record, which
  // the answer fills in.
  private recordConnectPrompt(runId: string, page: WatchedPage, event: Extract<TabEvent, { kind: 'connect-prompt' }>): void {
    let record = this.reports.connectPrompts.find((r) => r.promptId === event.promptId);
    if (event.op === 'shown') {
      if (record) return;
      record = {
        scriptId: runId, name: this.nameOf(runId), promptId: event.promptId, host: event.host,
        url: event.url ?? '', method: event.method ?? 'GET', at: event.at,
      } satisfies ConnectPromptRecord;
      this.reports.connectPrompts.push(record);
      this.recordPages.set(record, page);
      this.notify('connect-prompt', record);
      return;
    }
    if (!record || record.answer || record.closed) return;
    if (event.op === 'closed') {
      record.closed = true;
      return;
    }
    if (!event.answer) return;
    record.answer = event.answer;
    this.notify('connect-prompt', record);
  }

  // A request, download or notification, recorded as the harness host
  // records its own: one record each, filled in as it settles, and
  // announced once it has (a notification as it shows).
  private recordActivity(runId: string, page: WatchedPage, event: Extract<TabEvent, { kind: 'request' | 'download' | 'notification' }>): void {
    if (event.kind === 'request') {
      let record = this.reports.requests.find((r) => r.id === event.id && r.scriptId === runId);
      if (!record) {
        record = { scriptId: runId, id: event.id, url: event.url, method: event.method, at: event.at } satisfies XhrRecord;
        this.reports.requests.push(record);
        this.recordPages.set(record, page);
      }
      if (!event.outcome) return;
      Object.assign(record, { outcome: event.outcome }, event.status !== undefined ? { status: event.status } : {}, event.error ? { error: event.error } : {});
      this.notify('request', record);
      return;
    }
    if (event.kind === 'download') {
      let record = this.reports.downloads.find((r) => r.requestId === event.requestId && r.scriptId === runId);
      if (!record) {
        record = { scriptId: runId, requestId: event.requestId, url: event.url, name: event.name, at: event.at } satisfies DownloadRecord;
        this.reports.downloads.push(record);
        this.recordPages.set(record, page);
      }
      if (!event.outcome) return;
      Object.assign(record, { outcome: event.outcome }, event.filename ? { filename: event.filename } : {}, event.error ? { error: event.error } : {});
      this.notify('download', record);
      return;
    }
    if (event.op === 'shown') {
      const record: NotificationRecord = {
        scriptId: runId, requestId: event.requestId, text: event.text ?? '', title: event.title ?? '', at: event.at,
      };
      if (event.notificationId) this.notificationIds.set(event.requestId, event.notificationId);
      this.reports.notifications.push(record);
      this.recordPages.set(record, page);
      this.notify('notification', record);
      return;
    }
    const record = this.reports.notifications.find((n) => n.requestId === event.requestId && n.scriptId === runId);
    if (record) record.event = event.op;
    if (event.op === 'closed') this.notificationIds.delete(event.requestId);
  }
}
