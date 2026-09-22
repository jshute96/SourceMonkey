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
import type { PreparedScript } from './prepare.js';
import { explainMatch } from './prepare.js';

// One attached page, as the host sees it. `inject.ts` implements it
// over a Playwright page; nothing here depends on Playwright.
export interface PageLink {
  /** Deliver a service-worker push into the page's bridge listener. */
  push(message: object): Promise<void>;
  /** The page's current top-level URL. */
  url(): string;
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
const UNSUPPORTED_API: Record<string, string> = {
  'sm:gm-xhr-start': 'GM_xmlhttpRequest',
  'sm:gm-xhr-abort': 'GM_xmlhttpRequest',
  'sm:gm-tab-open': 'GM_openInTab',
  'sm:gm-tab-close': 'GM_openInTab',
  'sm:gm-download-start': 'GM_download',
  'sm:gm-download-abort': 'GM_download',
  'sm:gm-notification-show': 'GM_notification',
  'sm:gm-menu-register': 'GM_registerMenuCommand',
  'sm:gm-menu-unregister': 'GM_unregisterMenuCommand',
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
  readonly reports: HostReports = { started: [], errors: [], skipped: [], logs: [], domBlocked: [] };

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
      default: {
        this.emit('unhandled', { type, payload });
        const api = UNSUPPORTED_API[type];
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

function scriptName(script: PreparedScript): string {
  const tags = script.script.header?.tags ?? [];
  const name = tags.find((t) => t.tag === 'name' && !t.locale)?.value;
  return name || script.script.relativePath;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
