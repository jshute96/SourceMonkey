// The stand-in service worker.
//
// In the extension, the injected code (the prelude and the `GM_*`
// runtime) talks to the service worker: it asks whether to run, reports
// that it started or threw, flushes `GM_setValue` writes, and asks the
// worker to make requests and open tabs on its behalf. This host answers
// the same messages under Node, so the same injected code runs in a
// page with no extension present.
//
// The transport is the one the injected code already has for the case
// where `chrome.runtime` is missing: a `sourcemonkey-bridge-sync` DOM
// event out, `window.postMessage` replies and pushes back (see
// src/wrapper-bridge.js for the protocol). `inject.ts` forwards the
// events here and posts the replies; this module only knows message
// payloads and the pages they came from.
//
// What it keeps: every attached script, its stored values, and a record
// of everything the scripts reported (start, error, skipped) or asked
// for (tabs, menu commands, notifications). Tests and the `sm-dev`
// command read those records instead of scraping console output.

import { EventEmitter } from 'node:events';

import { WRAPPER_GM_RUNTIME } from '../generated-wrappers.js';
import {
  connectBlockedMessage,
  extractSelfHosts,
  gmXhrError,
  isUrlConnectAllowed,
  parseConnectRules,
} from '../gm-connect.js';
import { abortXhr, runXhr, type GmXhrEvent, type GmXhrRequestPayload } from '../gm-xhr.js';
import {
  downloadUrlRefusedMessage,
  isAllowedDownloadUrl,
  validateDownloadName,
  type GmDownloadEvent,
} from '../gm-download.js';
import { isAllowedTabUrl, tabUrlRefusedMessage } from '../gm-tab.js';
import { access, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PreparedScript } from './prepare.js';
import { explainMatch } from './prepare.js';

// One attached page, as the host sees it. `inject.ts` implements it
// over a Playwright page; nothing here depends on Playwright.
export interface PageLink {
  /** Deliver a service-worker push into the page's bridge listener. */
  push(message: object): Promise<void>;
  /** The page's current top-level URL. */
  url(): string;
  /**
   * The browser's cookies for a URL, for a credentialed
   * `GM_xmlhttpRequest`. Optional: without it requests go out with no
   * cookies at all.
   */
  cookiesFor?(url: string): Promise<{ name: string; value: string }[]>;
  /** Browser-side actions a script can ask for. Optional: without
   * them `GM_openInTab`, `window.close` and `window.focus` are refused. */
  browser?: BrowserActions;
}

// What the host needs from the browser for the tab-level APIs. The
// page opened for `GM_openInTab` is a real page in the same context,
// so a test can wait for it the way it would for the extension's tab.
export interface BrowserActions {
  openTab(url: string, active: boolean): Promise<OpenedTab>;
  closeSelf(): Promise<void>;
  focusSelf(): Promise<void>;
}

export interface OpenedTab {
  close(): Promise<void>;
  /** Called when the tab closes; called at once if it already has. */
  onClosed(callback: () => void): void;
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
  /** Where the bytes were written, on `load`. */
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
  /** Why the script did not run: the header rule, or the prelude's reason. */
  reason: string;
}

export interface LogReport extends ScriptReport {
  message: string;
}

export interface HostReports {
  started: StartReport[];
  errors: ErrorReport[];
  skipped: SkipReport[];
  logs: LogReport[];
  /** `GM_addStyle` / `GM_addElement` refused by the page's CSP. */
  domBlocked: { scriptId: string; api: string; at: number }[];
  /** Every `GM_xmlhttpRequest`, with its outcome once settled. */
  requests: XhrRecord[];
  /** Every `GM_openInTab`. */
  tabs: TabRecord[];
  /** Menu commands currently registered, in registration order. */
  menuCommands: MenuCommandRecord[];
  /** Every `GM_notification`. */
  notifications: NotificationRecord[];
  /** Every `GM_download` that went through the host. */
  downloads: DownloadRecord[];
  /** `window.close()` and `window.focus()` calls a granted script made. */
  windowCalls: { scriptId: string; method: 'close' | 'focus'; at: number }[];
}

interface WireWrite {
  key: string;
  value?: unknown;
  deleted?: boolean;
}

// The events a listener can subscribe to, each with the record just
// appended to `reports`, plus `value-write` for storage flushes.
export interface HostEventMap {
  start: [StartReport];
  'script-error': [ErrorReport];
  skip: [SkipReport];
  log: [LogReport];
  'value-write': [{ scriptId: string; writes: WireWrite[] }];
  /** A `GM_xmlhttpRequest` settled; the record carries its outcome. */
  request: [XhrRecord];
  tab: [TabRecord];
  'menu-command': [MenuCommandRecord];
  notification: [NotificationRecord];
  download: [DownloadRecord];
  unhandled: [{ type: string; payload: Record<string, unknown> }];
}

// The runtime's own stored-value codec, loaded once under Node the way
// the unit tests do, so a test reading `GM_setValue` output gets the
// value the script stored rather than its wire envelope.
let codec: { encodeValue(v: unknown): unknown; decodeValue(v: unknown): unknown } | null = null;

function loadCodec(): NonNullable<typeof codec> {
  if (codec) return codec;
  const window = Object.create(globalThis) as Record<string, unknown>;
  window.addEventListener = () => {};
  const document = { visibilityState: 'visible' };
  new Function('window', 'document', WRAPPER_GM_RUNTIME)(window, document);
  codec = (window.__SM_GM__ as { storage: NonNullable<typeof codec> }).storage;
  return codec;
}

// What a message type that the host doesn't answer yet means to the
// script that sent it, so the error it sees names the API rather than
// an internal message name.
// Every message the injected code sends today has a handler; this
// names the API for a future one that doesn't yet, so the script's
// error reads as an API name rather than a message type. `sm:gm-call`
// is the generic envelope, which carries the API's name itself.
const UNSUPPORTED_API: Record<string, string> = {};

// Which API a page-level action belongs to, for the refusal when the
// attached page can't perform browser actions.
const NEEDS_BROWSER: Record<string, string> = {
  'sm:gm-tab-open': 'GM_openInTab',
  'sm:gm-window-close': 'window.close',
  'sm:gm-window-focus': 'window.focus',
};

export class HarnessHost extends EventEmitter<HostEventMap> {
  private readonly scripts = new Map<string, PreparedScript>();
  // Which attached pages hold each script. A script stays known to the
  // host while any page still has it injected, so removing it from one
  // page can't break another page's storage calls.
  private readonly owners = new Map<string, Set<PageLink>>();
  // scriptId -> key -> value in wire form (what the page sent, what the
  // extension would have put in chrome.storage.local).
  private readonly values = new Map<string, Map<string, unknown>>();
  private readonly pages = new Set<PageLink>();
  readonly reports: HostReports = {
    started: [], errors: [], skipped: [], logs: [], domBlocked: [], requests: [],
    tabs: [], menuCommands: [], notifications: [], downloads: [], windowCalls: [],
  };
  // Tabs a script opened, by request id. An entry exists from the
  // moment the open was asked for, so a close that arrives while the
  // page is still being created is honored once it exists, as the
  // worker's `closeRequested` does.
  private readonly openTabs = new Map<string, {
    tab: OpenedTab | null; record: TabRecord; from: PageLink; closeRequested: boolean;
  }>();
  private readonly notifications = new Map<string, {
    record: NotificationRecord; from: PageLink; timer: NodeJS.Timeout | null;
  }>();
  // Menu commands live per document, as in the worker: the runtime
  // mints a fresh id on every load, so entries are dropped when their
  // page loads a new document or goes away.
  private readonly menuOwners = new Map<MenuCommandRecord, PageLink>();
  private readonly downloadControllers = new Map<string, AbortController>();
  // Paths handed out to downloads still being written, so two
  // concurrent downloads with one name don't both pick it.
  private readonly claimedPaths = new Set<string>();
  private nextTabId = 1;
  private nextDownloadId = 1;
  private nextNotificationId = 1;
  /** Where `GM_download` writes files. Overridable before any download. */
  downloadDir = path.join(os.tmpdir(), 'sourcemonkey-harness-downloads');

  /** Register a prepared script as injected into `owner`. */
  addScript(prepared: PreparedScript, owner: PageLink): void {
    if (!prepared.spec) throw new Error(`Cannot host an invalid script: ${prepared.diagnostic}`);
    const id = prepared.spec.id;
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

  scriptIds(): string[] {
    return [...this.scripts.keys()];
  }

  attachPage(page: PageLink): void {
    this.pages.add(page);
  }

  detachPage(page: PageLink): void {
    this.pages.delete(page);
    this.forgetDocumentState(page);
    // The worker drops a closed tab's opener state too: a tab it opened
    // stays open, but nothing will ever hear about it closing.
    for (const [requestId, entry] of this.openTabs) {
      if (entry.from === page) this.openTabs.delete(requestId);
    }
  }

  // What belongs to one document of a page: its menu commands (a new
  // document registers its own) and its notifications (the page-side
  // table is per document, so an event after a navigation reaches
  // nothing).
  private forgetDocumentState(page: PageLink): void {
    for (const [record, owner] of this.menuOwners) {
      if (owner !== page) continue;
      this.menuOwners.delete(record);
      const i = this.reports.menuCommands.indexOf(record);
      if (i >= 0) this.reports.menuCommands.splice(i, 1);
    }
    for (const [requestId, entry] of this.notifications) {
      if (entry.from !== page) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.notifications.delete(requestId);
    }
  }

  // ---------- Stored values ----------

  /** Seed a script's storage before it runs. Plain JSON values only. */
  seedValues(scriptId: string, values: Record<string, unknown>): void {
    const store = this.storeFor(scriptId);
    const { encodeValue } = loadCodec();
    for (const [k, v] of Object.entries(values)) store.set(k, encodeValue(v));
  }

  /** Every value a script has stored, decoded. */
  getValues(scriptId: string): Record<string, unknown> {
    const { decodeValue } = loadCodec();
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.storeFor(scriptId)) out[k] = decodeValue(v);
    return out;
  }

  getValue(scriptId: string, key: string): unknown {
    const store = this.storeFor(scriptId);
    return store.has(key) ? loadCodec().decodeValue(store.get(key)) : undefined;
  }

  /** Drop a script's values, as removing it from the extension would. */
  clearValues(scriptId: string): void {
    this.values.set(scriptId, new Map());
  }

  private storeFor(scriptId: string): Map<string, unknown> {
    let store = this.values.get(scriptId);
    if (!store) {
      store = new Map();
      this.values.set(scriptId, store);
    }
    return store;
  }

  private snapshot(scriptId: string): Record<string, unknown> {
    return Object.fromEntries(this.storeFor(scriptId));
  }

  // ---------- Navigation ----------

  /**
   * A page attached to this host loaded a new document. The prelude's
   * in-page matcher decides silently, so the host records the miss for
   * the developer: which rule kept the script off this URL. `scripts`
   * are the ones injected into that page.
   */
  noteNavigation(page: PageLink, scripts: readonly PreparedScript[]): void {
    this.forgetDocumentState(page);
    const url = page.url();
    for (const script of scripts) {
      const id = script.spec?.id ?? '';
      const verdict = explainMatch(script.matching, url);
      if (verdict.matches) continue;
      const report: SkipReport = {
        scriptId: id,
        name: scriptName(script),
        url,
        at: Date.now(),
        reason: verdict.rule ?? 'No @match or @include covers this URL',
      };
      this.reports.skipped.push(report);
      this.emit('skip', report);
    }
  }

  // ---------- Messages from the page ----------

  /**
   * Answer one payload from the bridge. Returns the reply for a
   * request, or undefined for a fire-and-forget report. Never throws:
   * an unknown or malformed message gets `{ ok: false }` so the caller's
   * promise settles, the way the extension's bridge always replies.
   */
  async handle(payload: Record<string, unknown>, from: PageLink): Promise<unknown> {
    const type = typeof payload.type === 'string' ? payload.type : '';
    switch (type) {
      case 'sm:check-pending':
        return this.checkPending(payload);
      case 'sm:start': {
        const report = this.baseReport(payload);
        this.reports.started.push(report);
        this.emit('start', report);
        return undefined;
      }
      case 'sm:error': {
        const report: ErrorReport = {
          ...this.baseReport(payload),
          message: str(payload.message),
          stack: str(payload.stack),
        };
        this.reports.errors.push(report);
        this.emit('script-error', report);
        return undefined;
      }
      case 'sm:abandoned': {
        const report: SkipReport = { ...this.baseReport(payload), reason: str(payload.reason) || 'skip' };
        this.reports.skipped.push(report);
        this.emit('skip', report);
        return undefined;
      }
      case 'sm:swapped':
      case 'sm:focus':
        return undefined;
      case 'sm:gm-log': {
        const report: LogReport = {
          scriptId: str(payload.scriptId),
          name: this.nameOf(str(payload.scriptId)),
          url: from.url(),
          at: Date.now(),
          message: str(payload.message),
        };
        this.reports.logs.push(report);
        this.emit('log', report);
        return { ok: true };
      }
      case 'sm:gm-dom-blocked':
        this.reports.domBlocked.push({ scriptId: str(payload.scriptId), api: str(payload.api), at: Date.now() });
        return { ok: true };
      case 'sm:gm-batch-write':
        return this.batchWrite(payload, from);
      case 'sm:gm-resync': {
        const scriptId = str(payload.scriptId);
        if (!this.scripts.has(scriptId)) return { ok: false };
        return { ok: true, values: this.snapshot(scriptId) };
      }
      case 'sm:gm-xhr-start':
        return this.xhrStart(payload, from);
      case 'sm:gm-xhr-abort':
        abortXhr(str(payload.id));
        return { ok: true };
      case 'sm:gm-tab-open':
        return this.tabOpen(payload, from);
      case 'sm:gm-tab-close':
        return this.tabClose(str(payload.requestId));
      case 'sm:gm-menu-register': {
        const record: MenuCommandRecord = {
          scriptId: str(payload.scriptId), commandId: str(payload.commandId), name: str(payload.name), at: Date.now(),
        };
        if (!this.scripts.has(record.scriptId) || !record.commandId) return { ok: false };
        // Re-registering an id replaces the entry in place, as the
        // worker's registry does.
        const i = this.reports.menuCommands.findIndex((m) =>
          m.scriptId === record.scriptId && m.commandId === record.commandId && this.menuOwners.get(m) === from);
        if (i >= 0) {
          this.menuOwners.delete(this.reports.menuCommands[i]);
          this.reports.menuCommands[i] = record;
        } else {
          this.reports.menuCommands.push(record);
        }
        this.menuOwners.set(record, from);
        this.emit('menu-command', record);
        return { ok: true };
      }
      case 'sm:gm-menu-unregister': {
        const scriptId = str(payload.scriptId);
        const commandId = str(payload.commandId);
        const i = this.reports.menuCommands.findIndex((m) =>
          m.scriptId === scriptId && m.commandId === commandId && this.menuOwners.get(m) === from);
        if (i >= 0) {
          this.menuOwners.delete(this.reports.menuCommands[i]);
          this.reports.menuCommands.splice(i, 1);
        }
        return { ok: true };
      }
      case 'sm:gm-notification-show': {
        const scriptId = str(payload.scriptId);
        const requestId = str(payload.requestId);
        const details = (payload.details ?? {}) as Record<string, unknown>;
        if (!this.scripts.has(scriptId) || !requestId) return { ok: false, error: 'This script is not attached to the harness' };
        // A backstop: the page side already rejects empty text.
        if (!str(details.text)) return { ok: false, error: 'GM_notification was called without text' };
        const record: NotificationRecord = {
          scriptId, requestId, text: str(details.text), title: str(details.title), at: Date.now(),
        };
        this.reports.notifications.push(record);
        // A `timeout` closes the notification and fires `ondone`, as
        // Chrome's auto-close does in the extension.
        const timeout = typeof details.timeout === 'number' && details.timeout > 0 ? details.timeout : 0;
        const timer = timeout
          ? setTimeout(() => { void this.closeNotification(requestId); }, timeout)
          : null;
        this.notifications.set(requestId, { record, from, timer });
        this.emit('notification', record);
        return { ok: true, notificationId: `harness-notification-${this.nextNotificationId++}` };
      }
      case 'sm:gm-download-start':
        return this.downloadStart(payload, from);
      case 'sm:gm-download-abort': {
        const requestId = str(payload.requestId);
        this.downloadControllers.get(requestId)?.abort();
        return { ok: true };
      }
      case 'sm:gm-window-close':
      case 'sm:gm-window-focus': {
        const scriptId = str(payload.scriptId);
        if (!this.scripts.has(scriptId)) return { ok: false, error: 'This script is not attached to the harness' };
        if (!from.browser) return { ok: false, error: `${NEEDS_BROWSER[type]} is not available on this page` };
        const method = type === 'sm:gm-window-close' ? 'close' : 'focus';
        this.reports.windowCalls.push({ scriptId, method, at: Date.now() });
        // Answered before the page goes away, the way the worker's reply
        // reaches the page before `chrome.tabs.remove` takes effect.
        setTimeout(() => {
          void (method === 'close' ? from.browser!.closeSelf() : from.browser!.focusSelf()).catch(() => undefined);
        }, 0);
        return { ok: true };
      }
      default: {
        this.emit('unhandled', { type, payload });
        const api = UNSUPPORTED_API[type] ?? (type === 'sm:gm-call' ? str(payload.api) : '');
        return {
          ok: false,
          error: api
            ? `${api} is not supported by the harness yet`
            : 'The harness does not recognize this request',
        };
      }
    }
  }

  private checkPending(payload: Record<string, unknown>): unknown {
    const id = str(payload.id);
    // The extension replies `run-new` with a fresher body when the
    // file changed since registration; the harness re-injects instead,
    // so the answer is always to run the body that was injected.
    const reply: { action: 'run'; gmValues?: Record<string, unknown> } = { action: 'run' };
    if (payload.needsValues === true && this.scripts.has(id)) reply.gmValues = this.snapshot(id);
    return reply;
  }

  private async batchWrite(payload: Record<string, unknown>, from: PageLink): Promise<unknown> {
    const scriptId = str(payload.scriptId);
    const writes = Array.isArray(payload.writes) ? (payload.writes as WireWrite[]) : [];
    if (!this.scripts.has(scriptId)) return { ok: false };
    const store = this.storeFor(scriptId);
    // Last write wins per key, as `applyBatchValues` resolves it.
    for (const w of writes) {
      if (typeof w?.key !== 'string') continue;
      if (w.deleted) store.delete(w.key);
      else store.set(w.key, w.value);
    }
    this.emit('value-write', { scriptId, writes });
    // Broadcast to every other attached page, as the worker does to
    // every other tab running the script. The writer already applied
    // the writes to its own cache.
    await this.push({ type: 'sm:gm-value-update', smWorld: this.worldOf(scriptId), scriptId, writes }, from);
    return { ok: true };
  }

  // ---------- GM_xmlhttpRequest ----------

  // The extension's own `runXhr` drives the request, so timeouts,
  // aborts, binary response types and the post-redirect `@connect`
  // re-check behave as they do there. Two things differ, both because
  // the fetch is Node's rather than the extension's:
  //   - the browser's cookies for the target are copied onto a `Cookie`
  //     header (when the page can supply them and the request isn't
  //     `anonymous`), where Chrome would attach the extension's jar;
  //   - forbidden headers pass straight through instead of riding a
  //     declarativeNetRequest rule.
  //   - a script's own `Cookie` header wins over the jar, as the rule
  //     does in the extension: the override is the script's request,
  //     and sending the user's session instead would be the opposite.
  // Neither makes this the extension's request as a server sees it;
  // see docs/harness-guide.md, "What is and isn't faithful".
  private xhrStart(payload: Record<string, unknown>, from: PageLink): { ok: boolean; error?: string } {
    const scriptId = str(payload.scriptId);
    const id = str(payload.id);
    const request = payload.request as GmXhrRequestPayload | undefined;
    const script = this.scripts.get(scriptId);
    if (!script) return { ok: false, error: 'This script is not attached to the harness' };
    if (!id || !request || typeof request.url !== 'string') {
      return { ok: false, error: 'GM_xmlhttpRequest was called without a URL' };
    }
    const record: XhrRecord = {
      scriptId, id, url: request.url, method: (request.method ?? 'GET').toUpperCase(), at: Date.now(),
    };
    this.reports.requests.push(record);
    const emit = async (event: GmXhrEvent): Promise<void> => {
      record.outcome = event.kind;
      if (event.kind === 'load') record.status = event.response.status;
      if (event.kind === 'error') record.error = event.message;
      this.emit('request', record);
      await from.push({ type: 'sm:gm-xhr-event', smWorld: script.world, id, event }).catch(() => undefined);
    };
    // Acknowledged first, as the worker does, then the outcome arrives
    // as a push: even a synchronous `@connect` refusal waits for the
    // reply to go out.
    setImmediate(() => {
      this.runRequest(script, id, request, from, emit).catch((err) => {
        void emit({ kind: 'error', message: gmXhrError(`internal error: ${(err as Error).message}`) });
      });
    });
    return { ok: true };
  }

  private async runRequest(
    script: PreparedScript,
    id: string,
    request: GmXhrRequestPayload,
    from: PageLink,
    emit: (event: GmXhrEvent) => Promise<void>,
  ): Promise<void> {
    // A script with a registration (`spec`) always has a header:
    // `buildScriptFromText` stores a headerless file as invalid.
    const header = script.script.header!;
    const rules = parseConnectRules(header);
    const selfHosts = extractSelfHosts(header);
    const check = (url: string) => isUrlConnectAllowed(url, rules, selfHosts);
    const initial = check(request.url);
    if (!initial.allowed) {
      await emit({
        kind: 'error',
        message: initial.denied ? connectBlockedMessage(initial.reason) : gmXhrError(initial.reason),
      });
      return;
    }
    const outgoing: GmXhrRequestPayload = { ...request };
    const scriptSetsCookie = Object.keys(request.headers ?? {}).some((h) => h.toLowerCase() === 'cookie');
    if (!request.anonymous && !scriptSetsCookie && from.cookiesFor) {
      const jar = await from.cookiesFor(request.url).catch(() => []);
      if (jar.length > 0) {
        outgoing.headers = { ...(request.headers ?? {}), cookie: jar.map((c) => `${c.name}=${c.value}`).join('; ') };
      }
    }
    const event = await runXhr(id, outgoing, (finalUrl) => check(finalUrl).allowed, null, {
      forbiddenHeaders: 'passthrough',
    });
    await emit(event);
  }

  // ---------- GM_openInTab ----------

  private async tabOpen(payload: Record<string, unknown>, from: PageLink): Promise<unknown> {
    const scriptId = str(payload.scriptId);
    const requestId = str(payload.requestId);
    const url = str(payload.url);
    if (!this.scripts.has(scriptId) || !requestId) return { ok: false, error: 'This script is not attached to the harness' };
    if (!from.browser) return { ok: false, error: 'GM_openInTab is not available on this page' };
    // Same gate as the worker: only web URLs, never file:, chrome: or
    // javascript: through a privileged opener. `insert` is accepted and
    // ignored, as the worker only approximates it.
    if (!isAllowedTabUrl(url)) return { ok: false, error: tabUrlRefusedMessage(url) };
    const record: TabRecord = { scriptId, requestId, url, active: payload.active === true, at: Date.now(), closed: false };
    this.reports.tabs.push(record);
    const entry = { tab: null as OpenedTab | null, record, from, closeRequested: false };
    this.openTabs.set(requestId, entry);
    const closed = (): void => {
      if (record.closed) return;
      record.closed = true;
      this.openTabs.delete(requestId);
      void from.push({ type: 'sm:gm-tab-closed', smWorld: this.worldOf(scriptId), requestId }).catch(() => undefined);
    };
    let tab: OpenedTab;
    try {
      tab = await from.browser.openTab(url, record.active);
    } catch (err) {
      this.openTabs.delete(requestId);
      record.closed = true;
      return { ok: false, error: `The tab could not be opened: ${(err as Error).message}` };
    }
    entry.tab = tab;
    tab.onClosed(closed);
    // A close asked for while the page was still being created.
    if (entry.closeRequested) await tab.close().catch(() => undefined);
    this.emit('tab', record);
    return { ok: true, tabId: this.nextTabId++ };
  }

  private async tabClose(requestId: string): Promise<unknown> {
    const entry = this.openTabs.get(requestId);
    if (!entry) return { ok: true };
    if (!entry.tab) {
      entry.closeRequested = true;
      return { ok: true };
    }
    await entry.tab.close().catch(() => undefined);
    return { ok: true };
  }

  // ---------- GM_download ----------

  // The bytes are fetched from Node and written under `downloadDir`,
  // where the extension hands the URL to Chrome's download manager. The
  // events are the extension's (`load` with the path, `error` with a
  // TM-style code, `timeout`), so a script's callbacks run as they
  // would; what differs is that no download bar or prompt is involved.
  private downloadStart(payload: Record<string, unknown>, from: PageLink): unknown {
    const scriptId = str(payload.scriptId);
    const requestId = str(payload.requestId);
    const url = str(payload.url);
    const name = str(payload.name);
    const script = this.scripts.get(scriptId);
    if (!script || !requestId) return { ok: false, error: 'This script is not attached to the harness' };
    const record: DownloadRecord = { scriptId, requestId, url, name, at: Date.now() };
    this.reports.downloads.push(record);
    const emit = async (event: GmDownloadEvent): Promise<void> => {
      if (event.kind === 'progress') return;
      record.outcome = event.kind;
      if (event.kind === 'load') record.filename = event.filename;
      if (event.kind === 'error') record.error = event.details.message ?? event.error;
      try {
        this.emit('download', record);
      } catch {
        // A listener's failure is its own; the script still gets its event.
      }
      await from.push({ type: 'sm:gm-download-event', smWorld: script.world, requestId, event }).catch(() => undefined);
    };
    // Acknowledged first, then the outcome as a push, even for a refusal:
    // the worker replies before its first event, and the script's
    // `onerror` is where a download that never started reports.
    setImmediate(() => {
      this.runDownload(payload, url, name, requestId, from, emit).catch((err) => {
        void emit({ kind: 'error', error: 'not_succeeded', details: { message: (err as Error).message } });
      });
    });
    return { ok: true };
  }

  private async runDownload(
    payload: Record<string, unknown>,
    url: string,
    name: string,
    requestId: string,
    from: PageLink,
    emit: (event: GmDownloadEvent) => Promise<void>,
  ): Promise<void> {
    if (!isAllowedDownloadUrl(url)) {
      await emit({ kind: 'error', error: 'not_permitted', details: { message: downloadUrlRefusedMessage(url) } });
      return;
    }
    const nameCheck = validateDownloadName(name);
    if (!nameCheck.ok) {
      await emit({ kind: 'error', error: 'not_permitted', details: { message: nameCheck.reason } });
      return;
    }
    const controller = new AbortController();
    this.downloadControllers.set(requestId, controller);
    const timeout = typeof payload.timeout === 'number' && payload.timeout > 0 ? payload.timeout : 0;
    let timedOut = false;
    const timer = timeout ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout) : null;
    try {
      const headers: Record<string, string> = { ...((payload.headers as Record<string, string>) ?? {}) };
      const scriptSetsCookie = Object.keys(headers).some((h) => h.toLowerCase() === 'cookie');
      if (!scriptSetsCookie && from.cookiesFor) {
        const jar = await from.cookiesFor(url).catch(() => []);
        if (jar.length > 0) headers.cookie = jar.map((c) => `${c.name}=${c.value}`).join('; ');
      }
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        await emit({
          kind: 'error',
          error: 'not_succeeded',
          details: { current: interruptReasonFor(res.status), message: `The server answered ${res.status}` },
        });
        return;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      // An abort that landed after the body arrived: the page already
      // settled `download_canceled`, so no file and no `load`.
      if (controller.signal.aborted) return;
      // The validated name (which may carry subdirectories), else the
      // URL's last segment, else a placeholder, the way Chrome derives
      // a name when none is given. A name already taken gets a ` (N)`
      // suffix, as the worker's `conflictAction: 'uniquify'` does.
      const basename = nameCheck.filename || path.basename(new URL(url).pathname) || 'download';
      const filename = await uniquePath(path.join(this.downloadDir, basename), this.claimedPaths);
      this.claimedPaths.add(filename);
      try {
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, bytes);
      } finally {
        this.claimedPaths.delete(filename);
      }
      await emit({ kind: 'load', downloadId: this.nextDownloadId++, filename, finalUrl: res.url, totalBytes: bytes.byteLength });
    } catch (err) {
      if (timedOut) await emit({ kind: 'timeout' });
      else if (controller.signal.aborted) await emit({ kind: 'error', error: 'download_canceled', details: { current: 'USER_CANCELED' } });
      else await emit({ kind: 'error', error: 'not_succeeded', details: { message: (err as Error).message } });
    } finally {
      if (timer) clearTimeout(timer);
      this.downloadControllers.delete(requestId);
    }
  }

  // ---------- What a test can do to the page ----------

  /**
   * Invoke a registered menu command by its name, or by id. The newest
   * registration wins when a name is repeated, and the command fires
   * on the page that registered it.
   */
  async fireMenuCommand(nameOrId: string, scriptId?: string): Promise<boolean> {
    const entry = [...this.reports.menuCommands].reverse().find((m) =>
      (scriptId === undefined || m.scriptId === scriptId) && (m.name === nameOrId || m.commandId === nameOrId));
    const owner = entry && this.menuOwners.get(entry);
    if (!entry || !owner) return false;
    await owner.push({
      type: 'sm:gm-menu-fire', smWorld: this.worldOf(entry.scriptId), scriptId: entry.scriptId, commandId: entry.commandId,
    }).catch(() => undefined);
    return true;
  }

  /** Deliver a click on a shown notification to the script's `onclick`. */
  async clickNotification(requestId: string): Promise<boolean> {
    return this.notificationEvent(requestId, 'clicked');
  }

  /** Close a shown notification, which fires the script's `ondone`. */
  async closeNotification(requestId: string): Promise<boolean> {
    const entry = this.notifications.get(requestId);
    if (entry?.timer) clearTimeout(entry.timer);
    const done = await this.notificationEvent(requestId, 'closed');
    this.notifications.delete(requestId);
    return done;
  }

  private async notificationEvent(requestId: string, event: 'clicked' | 'closed'): Promise<boolean> {
    const entry = this.notifications.get(requestId);
    if (!entry) return false;
    entry.record.event = event;
    await entry.from.push({
      type: 'sm:gm-notification-event', smWorld: this.worldOf(entry.record.scriptId), requestId, event,
    }).catch(() => undefined);
    return true;
  }

  // ---------- Pushes to pages ----------

  /** Send a service-worker push to every attached page but `except`. */
  async push(message: object, except?: PageLink): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const page of this.pages) {
      if (page === except) continue;
      // A page that is navigating or closed can't take a message; that
      // is the "receiving end does not exist" the worker also ignores.
      sends.push(page.push(message).catch(() => undefined));
    }
    await Promise.all(sends);
  }

  // ---------- Helpers ----------

  private baseReport(payload: Record<string, unknown>): ScriptReport {
    const scriptId = str(payload.id);
    return {
      scriptId,
      name: str(payload.name) || this.nameOf(scriptId),
      url: str(payload.url),
      at: Date.now(),
    };
  }

  private nameOf(scriptId: string): string {
    const script = this.scripts.get(scriptId);
    return script ? scriptName(script) : scriptId;
  }

  private worldOf(scriptId: string): 'MAIN' | 'USER_SCRIPT' {
    return this.scripts.get(scriptId)?.world ?? 'USER_SCRIPT';
  }
}

// Chrome's interrupt reason for an HTTP failure, which is what a
// script branching on `details.current` was written against.
function interruptReasonFor(status: number): string {
  if (status === 403) return 'SERVER_FORBIDDEN';
  if (status === 404) return 'SERVER_BAD_CONTENT';
  if (status === 401) return 'SERVER_UNAUTHORIZED';
  return 'SERVER_FAILED';
}

// `file.ext`, else `file (1).ext`, `file (2).ext`, as Chrome's
// uniquify does.
async function uniquePath(wanted: string, claimed: ReadonlySet<string>): Promise<string> {
  const exists = (p: string): Promise<boolean> =>
    claimed.has(p) ? Promise.resolve(true) : access(p).then(() => true, () => false);
  if (!(await exists(wanted))) return wanted;
  const dir = path.dirname(wanted);
  const ext = path.extname(wanted);
  const stem = path.basename(wanted, ext);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

function scriptName(script: PreparedScript): string {
  const tags = script.script.header?.tags ?? [];
  const name = tags.find((t) => t.tag === 'name' && !t.locale)?.value;
  return name || script.script.relativePath;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
