// What a run (and the spec fixture) knows of its scripts: a record of
// what they reported and did in its tabs, a copy of their stored
// values, and their menu commands. The extension runs the scripts;
// `ExtensionHost` (extension-host.ts) fills this from its events, and
// the run's commands, waits and output read it.
//
// - Every record remembers the page (tab) it came from, kept off the
//   records themselves so they stay plain data a test can compare.
// - Menu commands belong to a page's current document: a new document
//   registers its own.
// - A script's values here are a copy, kept up to date from the
//   extension's events, for reads that can't wait on a round trip.

import { EventEmitter } from 'node:events';

import { WRAPPER_GM_RUNTIME } from '../generated-wrappers.js';
import type { GmXhrEvent, GmXhrRequestPayload } from '../gm-xhr-types.js';
import type { PreparedScript } from './prepare.js';
import { NO_RULE_COVERS_URL, explainMatch, preparedScriptName } from './prepare.js';

/** One watched page (a tab), as the host sees it. */
export interface PageLink {
  /** The page's current top-level URL. */
  url(): string;
}

export interface TabRecord {
  scriptId: string;
  requestId: string;
  url: string;
  active: boolean;
  at: number;
  closed: boolean;
}

export interface MenuCommandRecord {
  scriptId: string;
  commandId: string;
  name: string;
  at: number;
}

export interface NotificationRecord {
  scriptId: string;
  requestId: string;
  text: string;
  title: string;
  at: number;
  /** The last event delivered to the script, if any. */
  event?: 'clicked' | 'closed';
}

export interface DownloadRecord {
  scriptId: string;
  requestId: string;
  url: string;
  name: string;
  at: number;
  outcome?: 'load' | 'error' | 'timeout' | 'abort';
  /** Where the browser saved it, on `load`. */
  filename?: string;
  error?: string;
}

export interface XhrRecord {
  scriptId: string;
  id: string;
  url: string;
  method: string;
  at: number;
  /** How it ended, once it has. */
  outcome?: 'load' | 'error' | 'timeout' | 'abort';
  /** The HTTP status, on `load`. */
  status?: number;
  /** The message the script's `onerror` got, on `error`. */
  error?: string;
}

/**
 * SourceMonkey asking whether a script may connect to a host its
 * `@connect` lines don't cover, and the answer once given.
 */
export interface ConnectPromptRecord {
  scriptId: string;
  /** The script's name. */
  name: string;
  promptId: string;
  host: string;
  url: string;
  method: string;
  at: number;
  answer?: ConnectChoice;
  /** Closed without an answer: its requests timed out or were aborted. */
  closed?: boolean;
}

export type ConnectChoice = 'once' | 'cancel' | 'allow' | 'allow-all' | 'deny';

export interface ScriptReport {
  scriptId: string;
  name: string;
  url: string;
  at: number;
}

export interface StartReport extends ScriptReport {}

export interface ErrorReport extends ScriptReport {
  message: string;
  stack: string;
}

export interface SkipReport extends ScriptReport {
  /** Why the script did not run: the header rule, or the extension's reason. */
  reason: string;
  /**
   * The host's own finding that the header's rules miss the URL, rather
   * than the extension's report, so SourceMonkey's Log has no entry.
   */
  ruleMiss?: true;
}

/**
 * A manual script (`@run-at context-menu`) matched a new document,
 * where it waits to be run rather than starting.
 */
export type ManualReport = ScriptReport;

export interface HostReports {
  started: StartReport[];
  errors: ErrorReport[];
  skipped: SkipReport[];
  /** Manual scripts waiting in a new document (`ManualReport`). */
  manual: ManualReport[];
  /** Every `GM_xmlhttpRequest`, with its outcome once settled. */
  requests: XhrRecord[];
  /** Every `GM_openInTab`. */
  tabs: TabRecord[];
  /** Menu commands currently registered, in registration order. */
  menuCommands: MenuCommandRecord[];
  /** Every `GM_notification`. */
  notifications: NotificationRecord[];
  /** Every `GM_download` the extension handled. */
  downloads: DownloadRecord[];
  /** Every connection prompt, with its answer once given. */
  connectPrompts: ConnectPromptRecord[];
}

export interface WireWrite {
  key: string;
  value?: unknown;
  deleted?: boolean;
}

// The events a listener can subscribe to, each with the record just
// appended to `reports`, plus `value-write` for a tab's storage writes.
export interface HostEventMap {
  start: [StartReport];
  'script-error': [ErrorReport];
  skip: [SkipReport];
  manual: [ManualReport];
  'value-write': [{ scriptId: string; writes: WireWrite[] }];
  /** A `GM_xmlhttpRequest` settled; the record carries its outcome. */
  request: [XhrRecord];
  tab: [TabRecord];
  'menu-command': [MenuCommandRecord];
  notification: [NotificationRecord];
  download: [DownloadRecord];
  /** A connection prompt opened, or was answered (`answer` set). */
  'connect-prompt': [ConnectPromptRecord];
}

// The runtime's own stored-value codec, loaded once under Node the way
// the unit tests do, so a test reading `GM_setValue` output gets the
// value the script stored rather than its wire envelope.
let codec: { encodeValue(v: unknown): unknown; decodeValue(v: unknown): unknown } | null = null;

export function valueCodec(): NonNullable<typeof codec> {
  if (codec) return codec;
  const window = Object.create(globalThis) as Record<string, unknown>;
  window.addEventListener = () => {};
  const document = { visibilityState: 'visible' };
  new Function('window', 'document', WRAPPER_GM_RUNTIME)(window, document);
  codec = (window.__SM_GM__ as { storage: NonNullable<typeof codec> }).storage;
  return codec;
}

// What a test can put in front of `GM_xmlhttpRequest`: an event to
// answer with instead of sending the request, or null to send it.
export type RequestInterceptor = (
  request: GmXhrRequestPayload,
  scriptId: string,
) => GmXhrEvent | null | Promise<GmXhrEvent | null>;

// Abstract: the actions on the page go through whatever runs the
// scripts (`ExtensionHost`).
export abstract class HarnessHost extends EventEmitter<HostEventMap> {
  private readonly scripts = new Map<string, PreparedScript>();
  // Which watched pages hold each script. A script stays known while
  // any page still has it.
  private readonly owners = new Map<string, Set<PageLink>>();
  // scriptId -> key -> value in wire form, as the extension stores it.
  private readonly values = new Map<string, Map<string, unknown>>();
  // Which page each record came from, for telling tabs apart.
  protected readonly recordPages = new WeakMap<object, PageLink>();
  // `untilReported`'s waits, checked on each start, skip and error.
  // Not emitter listeners: `reload all` over many tabs would pass
  // Node's listener limit, which prints a warning.
  private readonly reportWaiters = new Set<() => void>();
  readonly reports: HostReports = {
    started: [], errors: [], skipped: [], manual: [], requests: [], tabs: [], menuCommands: [], notifications: [], downloads: [],
    connectPrompts: [],
  };
  // The manual scripts that match each page's current document, which
  // can be run there.
  private readonly manualByPage = new Map<PageLink, Set<string>>();
  // Each menu command's page; dropped when that page loads a new
  // document or goes away.
  private readonly menuOwners = new Map<MenuCommandRecord, PageLink>();

  /** Register a prepared script as running in `owner`'s tab. */
  addScript(prepared: PreparedScript, owner: PageLink): void {
    if (!prepared.id) throw new Error(`Cannot host an invalid script: ${prepared.diagnostic}`);
    const id = prepared.id;
    this.scripts.set(id, prepared);
    let set = this.owners.get(id);
    if (!set) {
      set = new Set();
      this.owners.set(id, set);
    }
    set.add(owner);
    if (!this.values.has(id)) this.values.set(id, new Map());
  }

  /** `owner` no longer has the script; forget it once nobody does. */
  removeScript(scriptId: string, owner: PageLink): void {
    const set = this.owners.get(scriptId);
    if (!set) return;
    set.delete(owner);
    if (set.size > 0) return;
    this.owners.delete(scriptId);
    this.scripts.delete(scriptId);
  }

  hasScript(scriptId: string): boolean {
    return this.scripts.has(scriptId);
  }

  /**
   * Whether a script is running in a page's current document: its last
   * word from that page is a start rather than a skip.
   */
  isRunning(page: PageLink, scriptId: string): boolean {
    const { started, skipped } = this.lastStartAndSkip(page, scriptId);
    return started !== undefined && (!skipped || started.at >= skipped.at);
  }

  /**
   * Whether the scripts' manager reports their starts, skips and
   * errors. Another manager than SourceMonkey doesn't.
   */
  get getsReports(): boolean {
    return true;
  }

  /**
   * Of `scriptIds`, the ones with no word from `page` since `since`:
   * not yet started, skipped or thrown there, nor waiting to be run.
   */
  unreported(page: PageLink, scriptIds: readonly string[], since: number): string[] {
    // Nothing to wait for from a manager that never reports.
    if (!this.getsReports) return [];
    const { started, skipped, errors, manual } = this.reports;
    const reported = (id: string): boolean => [started, skipped, errors, manual]
      .some((records) => records.some((r) => r.scriptId === id && r.at >= since && this.recordPages.get(r) === page));
    return scriptIds.filter((id) => !reported(id));
  }

  /**
   * Resolves once each of `scriptIds` has had its word from `page`
   * since `since` (see `unreported`). Every script the extension runs
   * in a new document gives one, so this is when a load's scripts are
   * done starting. Never rejects. Stops waiting, unresolved, on
   * `signal`, for a page that goes away first.
   */
  untilReported(page: PageLink, scriptIds: readonly string[], since: number, signal?: AbortSignal): Promise<void> {
    if (this.unreported(page, scriptIds, since).length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      if (signal?.aborted) return;
      const stop = (): void => {
        this.reportWaiters.delete(check);
        signal?.removeEventListener('abort', stop);
      };
      const check = (): void => {
        if (this.unreported(page, scriptIds, since).length > 0) return;
        stop();
        resolve();
      };
      this.reportWaiters.add(check);
      signal?.addEventListener('abort', stop);
    });
  }

  /** A script's latest start and latest skip from one page. */
  lastStartAndSkip(page: PageLink, scriptId: string): { started?: StartReport; skipped?: SkipReport } {
    const mine = <T extends ScriptReport>(records: T[]): T | undefined =>
      records.filter((r) => r.scriptId === scriptId && this.recordPages.get(r) === page).at(-1);
    return { started: mine(this.reports.started), skipped: mine(this.reports.skipped) };
  }

  /** The page a record in `reports` came from, if it is still known. */
  pageOf(record: object): PageLink | undefined {
    return this.recordPages.get(record);
  }

  scriptIds(): string[] {
    return [...this.scripts.keys()];
  }

  /**
   * `text` with each stack frame from a script's injected entry pointed
   * at the file and line it was written in: a `@require`, or the script
   * itself. Without this, a script with `@require`s reports lines
   * counted from the top of the requires.
   */
  abstract remapStack(text: string): string;

  /** A watched page went away. */
  detachPage(page: PageLink): void {
    this.forgetDocumentState(page);
  }

  /**
   * The manual scripts that can be run in `page`'s current document, at
   * its URL now: one the page moved away from in place (pushState) can't.
   */
  manualScripts(page: PageLink): string[] {
    const url = page.url();
    return [...this.manualByPage.get(page) ?? []].filter((id) => {
      const script = this.scripts.get(id);
      return script !== undefined && explainMatch(script.matching, url).matches;
    });
  }

  // What belongs to one document of a page: its menu commands, which a
  // new document registers again, and the manual scripts it matches.
  private forgetDocumentState(page: PageLink): void {
    this.manualByPage.delete(page);
    for (const [record, owner] of this.menuOwners) {
      if (owner !== page) continue;
      this.menuOwners.delete(record);
      const i = this.reports.menuCommands.indexOf(record);
      if (i >= 0) this.reports.menuCommands.splice(i, 1);
    }
  }

  // ---------- Stored values ----------

  /**
   * Values written by the run or the test, as another tab of the script
   * would. Here only the host's copy; `ExtensionHost` writes them into
   * the extension too.
   */
  async setValues(scriptId: string, values: Record<string, unknown>): Promise<void> {
    const { encodeValue } = valueCodec();
    this.applyWrites(scriptId, Object.entries(values).map(([key, v]) =>
      (v === undefined ? { key, deleted: true } : { key, value: encodeValue(v) })));
  }

  /** Every value a script has stored, decoded, from the host's copy. */
  getValues(scriptId: string): Record<string, unknown> {
    const { decodeValue } = valueCodec();
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.storeFor(scriptId)) out[k] = decodeValue(v);
    return out;
  }

  /**
   * Every value a script has stored, for the run's commands: here the
   * host's copy; `ExtensionHost` asks the extension.
   */
  async valuesOf(scriptId: string): Promise<Record<string, unknown>> {
    return this.getValues(scriptId);
  }

  /**
   * Where `eval` finds a script's eval hook in a page (see
   * src/eval-hook.ts): the key the hooks are kept under, and the id the
   * script has there. Null for a script that has none.
   */
  abstract evalHook(scriptId: string): { key: string; id: string } | null;

  getValue(scriptId: string, key: string): unknown {
    const store = this.storeFor(scriptId);
    return store.has(key) ? valueCodec().decodeValue(store.get(key)) : undefined;
  }

  // Writes into the host's copy; last write wins per key.
  private applyWrites(scriptId: string, writes: readonly WireWrite[]): void {
    const store = this.storeFor(scriptId);
    for (const w of writes) {
      if (typeof w?.key !== 'string') continue;
      if (w.deleted) store.delete(w.key);
      else store.set(w.key, w.value);
    }
  }

  private storeFor(scriptId: string): Map<string, unknown> {
    let store = this.values.get(scriptId);
    if (!store) {
      store = new Map();
      this.values.set(scriptId, store);
    }
    return store;
  }

  // ---------- Navigation ----------

  /**
   * A watched page loaded a new document. The extension skips a script
   * whose rules miss the URL silently, so the host records the miss for
   * the developer: which rule kept the script off this URL. `scripts`
   * are the ones the page's tab runs.
   */
  noteNavigation(page: PageLink, scripts: readonly PreparedScript[]): void {
    this.forgetDocumentState(page);
    const url = page.url();
    for (const script of scripts) {
      const id = script.id ?? '';
      const verdict = explainMatch(script.matching, url);
      if (verdict.matches) continue;
      const report: SkipReport = {
        scriptId: id,
        name: preparedScriptName(script),
        url,
        at: Date.now(),
        reason: verdict.rule ?? NO_RULE_COVERS_URL,
        ruleMiss: true,
      };
      this.recordPages.set(report, page);
      this.reports.skipped.push(report);
      this.notify('skip', report);
    }
  }

  // ---------- What the scripts reported ----------

  /** A script started in `from`'s current document. */
  protected recordStart(from: PageLink, fields: { scriptId: string; name: string; url: string }): void {
    const report: StartReport = this.baseReport(from, fields);
    this.reports.started.push(report);
    this.notify('start', report);
  }

  /** A script threw in `from`. */
  protected recordError(from: PageLink, fields: { scriptId: string; name: string; url: string; message: string; stack: string }): void {
    const report: ErrorReport = this.baseReport(from, { ...fields, stack: this.remapStack(fields.stack) });
    this.reports.errors.push(report);
    this.notify('script-error', report);
  }

  /** A script didn't run in `from`, for `reason`. */
  protected recordSkip(from: PageLink, fields: { scriptId: string; name: string; url: string; reason: string }): void {
    const report: SkipReport = this.baseReport(from, fields);
    this.reports.skipped.push(report);
    this.notify('skip', report);
  }

  /**
   * A manual script can be run in `from`'s document, where it waits to
   * be run. Once per document: the extension says it again on each
   * navigation, a pushState included, and a back/forward restore
   * (which `forgetDocumentState` has cleared it for).
   */
  protected recordManual(from: PageLink, fields: { scriptId: string; name: string; url: string }): void {
    let set = this.manualByPage.get(from);
    if (set?.has(fields.scriptId)) return;
    if (!set) {
      set = new Set();
      this.manualByPage.set(from, set);
    }
    set.add(fields.scriptId);
    const report: ManualReport = this.baseReport(from, fields);
    this.reports.manual.push(report);
    this.notify('manual', report);
  }

  /** A script in `from` wrote values. */
  protected recordValueWrites(from: PageLink, scriptId: string, writes: WireWrite[]): void {
    if (!this.scripts.has(scriptId)) return;
    this.applyWrites(scriptId, writes);
    const write = { scriptId, writes };
    this.recordPages.set(write, from);
    this.notify('value-write', write);
  }

  /** A script in `from` registered a menu command. */
  protected registerMenu(from: PageLink, scriptId: string, commandId: string, name: string): void {
    if (!this.scripts.has(scriptId) || !commandId) return;
    const record: MenuCommandRecord = { scriptId, commandId, name, at: Date.now() };
    // Re-registering an id replaces the entry in place, as the worker's
    // registry does.
    const i = this.reports.menuCommands.findIndex((m) =>
      m.scriptId === scriptId && m.commandId === commandId && this.menuOwners.get(m) === from);
    if (i >= 0) {
      this.menuOwners.delete(this.reports.menuCommands[i]);
      this.reports.menuCommands[i] = record;
    } else {
      this.reports.menuCommands.push(record);
    }
    this.menuOwners.set(record, from);
    this.recordPages.set(record, from);
    this.notify('menu-command', record);
  }

  /** A script in `from` removed a menu command. */
  protected unregisterMenu(from: PageLink, scriptId: string, commandId: string): void {
    const i = this.reports.menuCommands.findIndex((m) =>
      m.scriptId === scriptId && m.commandId === commandId && this.menuOwners.get(m) === from);
    if (i < 0) return;
    this.menuOwners.delete(this.reports.menuCommands[i]);
    this.reports.menuCommands.splice(i, 1);
  }

  // ---------- What a test or command can do ----------

  /**
   * Invoke a registered menu command by its name, or by id. The newest
   * registration wins when a name is repeated, and the command fires
   * on the page that registered it.
   */
  async fireMenuCommand(nameOrId: string, scriptId?: string): Promise<boolean> {
    const entry = [...this.reports.menuCommands].reverse().find((m) =>
      (scriptId === undefined || m.scriptId === scriptId) && (m.name === nameOrId || m.commandId === nameOrId));
    return entry ? this.fireMenuEntry(entry) : false;
  }

  /**
   * Fire one entry of `reports.menuCommands` in the page that
   * registered it. False once that page has moved on.
   */
  abstract fireMenuEntry(entry: MenuCommandRecord): Promise<boolean>;

  /**
   * Run a manual script in `page`, as its popup "Run this script" does.
   * Throws with the reason when it can't.
   */
  abstract runManualScript(page: PageLink, scriptId: string): Promise<void>;

  /** Click a shown notification, which runs the script's `onclick`. */
  abstract clickNotification(requestId: string): Promise<boolean>;

  /** Close a shown notification, which fires the script's `ondone`. */
  abstract closeNotification(requestId: string): Promise<boolean>;

  /** Answer a waiting connection prompt. False when it isn't waiting. */
  abstract answerConnectPrompt(promptId: string, choice: ConnectChoice): Promise<boolean>;

  // ---------- Helpers ----------

  private baseReport<T extends { scriptId: string; name: string; url: string }>(from: PageLink, fields: T): T & { at: number } {
    const report = { ...fields, name: fields.name || this.nameOf(fields.scriptId), at: Date.now() };
    this.recordPages.set(report, from);
    return report;
  }

  protected nameOf(scriptId: string): string {
    const script = this.scripts.get(scriptId);
    return script ? preparedScriptName(script) : scriptId;
  }

  // Every event goes out through here. A test's listener that throws
  // is the test's own failure: it must not cost the host its records.
  protected notify<K extends keyof HostEventMap>(event: K, ...args: HostEventMap[K]): void {
    try {
      (this.emit as (e: K, ...a: HostEventMap[K]) => boolean)(event, ...args);
    } catch {
      // Dropped on purpose; see above.
    }
    if (event === 'start' || event === 'skip' || event === 'script-error' || event === 'manual') {
      for (const check of [...this.reportWaiters]) check();
    }
  }
}
