// Watching a page the extension runs scripts in: a run's tab, or the
// spec fixture's page. Adds nothing the page or its scripts can see.
//
// - Tracks the page's documents (when each began), for the waits and
//   for ordering the extension's events against navigations
//   (extension-host.ts).
// - Records which scripts the tab runs, for the host's skip reports and
//   the waits; the extension runs them.
// - Reads what `wait` needs (DOM activity, requests in flight), from a
//   CDP-made world of its own, and evaluates `eval` in the page's world
//   or the scripts' (the extension's user-script world).

import type { CDPSession, Page, Request } from '@playwright/test';

import type { HarnessHost, PageLink } from './host.js';
import type { PreparedScript } from './prepare.js';
import type { InjectionWorld } from '../script-world.js';

// The world the activity tracker runs in, created by CDP: its own, so
// neither the page nor the scripts see it.
const WATCH_WORLD = 'sm-dev-watch';

// When the DOM last changed, and where, for `wait` (see wait.ts): a
// MutationObserver from the document's start, in the watch world.
const ACTIVITY_KEY = 'sm-dev-activity';
const ACTIVITY_TRACKER = `(function(){
  if (self !== top) return;
  var key = Symbol.for(${JSON.stringify(ACTIVITY_KEY)});
  if (globalThis[key]) return;
  var state = globalThis[key] = { last: Date.now(), target: '' };
  function describe(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return '';
    var classes = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.localName + (el.id ? '#' + el.id : '') + classes;
  }
  new MutationObserver(function(records){
    state.last = Date.now();
    state.target = describe(records[records.length - 1].target);
  }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
})()`;

/** What `activity` reads from a page, for `wait`. */
export interface PageActivity {
  readyState: string;
  /** Milliseconds since the DOM last changed. */
  sinceDom: number;
  /** The element that changed last, as `div#id.class`. */
  lastChanged: string;
}

/** A request the page has in flight, and for how long. */
export interface PendingRequest {
  url: string;
  ms: number;
}

// Results JSON can't show, printed as the console describes them.
const DESCRIBED = new Set(['node', 'error', 'map', 'set', 'weakmap', 'weakset', 'nodelist', 'htmlcollection', 'regexp', 'date', 'proxy', 'promise', 'generator', 'iterator']);

/** What an expression `evaluate` ran threw, as opposed to evaluate failing. */
export class ScriptThrew extends Error {}

/**
 * A script's own scope, for `eval` in a script: the world it runs in, and
 * where its eval hook is kept there (see src/eval-hook.ts).
 */
export interface ScriptScope {
  world: InjectionWorld;
  key: string;
  id: string;
}

/** `evaluate` found no eval hook for the script: it hasn't run in this document. */
export class NoEvalHook extends Error {}

/** `evaluate` found no document to run in: the page stayed between documents. */
export class NoDocument extends Error {}

// How long `evaluate` waits for a page that is between documents (a
// reload or navigation under way) to have one again.
const DOCUMENT_WAIT_MS = 5000;
const BETWEEN_DOCUMENTS = 'The page is between documents (reloading or navigating), so there is none to evaluate in';

// What an expression threw: an Error's description, else the value
// thrown (`throw 'boom'`).
function threw(details: { text: string; exception?: unknown }): ScriptThrew {
  const exception = details.exception as RemoteObject | undefined;
  const thrown = exception?.description ?? (exception && 'value' in exception ? JSON.stringify(exception.value) : details.text);
  return new ScriptThrew(thrown.split('\n')[0]);
}

// A top-level `return` in `eval`'s code: V8's syntax error for it.
// Only as the code compiled, which has no stack trace. One thrown as it
// ran (by an inner `eval("return")`) had its side effects already.
function isIllegalReturn(details: { exception?: unknown; stackTrace?: unknown }): boolean {
  const exception = details.exception as RemoteObject | undefined;
  return !details.stackTrace && exception?.className === 'SyntaxError' && (exception.description ?? '').startsWith('SyntaxError: Illegal return statement');
}

// Code that's only valid as a function body (a top-level `return`, or
// `await`), from the syntax error compiling it as a script gave.
function needsFunctionBody(details: { text: string; exception?: unknown }): boolean {
  const exception = details.exception as RemoteObject | undefined;
  return /Illegal return statement|await is only valid/.test(exception?.description ?? details.text);
}

// The parts of CDP's `Runtime.RemoteObject` that `evaluate` reads.
interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
  description?: string;
  className?: string;
}

interface ContextInfo {
  frameId: string;
  name: string;
  isDefault: boolean;
  origin: string;
}

export interface AttachOptions {
  /**
   * The extension's origin (`chrome-extension://<id>`), which names the
   * world its scripts run in, for `eval` in a script.
   */
  watchOnly: { extensionOrigin: string };
}

export interface InjectOptions {
  /**
   * The script runs in the current document too, not only from the
   * next navigation: one the tab already showed when it was set up.
   */
  immediately?: boolean;
}

interface Recorded {
  script: PreparedScript;
  /** When it was recorded, by the host's clock. */
  at: number;
  /** The document it also ran in at once (`immediately`), if any. */
  into?: PageDocument;
}

// One document the main frame showed, and when: `spans` holds each
// stretch of time it was the current one, more than one when the
// back/forward cache restored it.
interface PageDocument {
  url: string;
  spans: [number, number][];
}

// Pages that already have an attachment.
const attached = new WeakSet<Page>();

/**
 * One page watched for a host. Create with `attachPage`, then record the
 * scripts its tab runs with `inject`.
 */
export class PageAttachment implements PageLink {
  private readonly injected = new Map<string, Recorded>();
  private disposing = false;
  private closed = false;
  private mainFrameId = '';
  // The main frame's recent documents by loader id: one restored from
  // the back/forward cache is the same document again.
  private readonly documents = new Map<string, PageDocument>();
  private currentDocument: PageDocument = { url: '', spans: [[0, Infinity]] };
  // Execution contexts by id, to find a world's context in the main frame.
  private readonly contexts = new Map<number, ContextInfo>();
  // Requests in flight, by when each started; see `network`.
  private readonly requests = new Map<Request, number>();
  private lastRequestEnd = 0;
  private readonly onRequest = (request: Request): void => { this.requests.set(request, Date.now()); };
  private readonly onRequestEnd = (request: Request): void => {
    if (this.requests.delete(request)) this.lastRequestEnd = Date.now();
  };
  private readonly onClose = (): void => {
    this.closed = true;
    this.host.detachPage(this);
  };

  private constructor(
    readonly page: Page,
    readonly host: HarnessHost,
    private readonly cdp: CDPSession,
    private readonly options: AttachOptions,
  ) {}

  static async create(page: Page, host: HarnessHost, options: AttachOptions): Promise<PageAttachment> {
    if (attached.has(page)) throw new Error('This page already has an attachment');
    // Claimed before the first await, so two concurrent attaches can't
    // both pass the check; released if setup fails, so the page can be
    // attached again.
    attached.add(page);
    let cdp: CDPSession | null = null;
    try {
      cdp = await page.context().newCDPSession(page);
      const attachment = new PageAttachment(page, host, cdp, options);
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
      this.contexts.set(context.id, { frameId: aux.frameId ?? '', name: context.name, isDefault: aux.isDefault === true, origin: context.origin });
    });
    this.cdp.on('Runtime.executionContextDestroyed', (ev) => { this.contexts.delete(ev.executionContextId); });
    this.cdp.on('Runtime.executionContextsCleared', () => { this.contexts.clear(); });
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: ACTIVITY_TRACKER,
      runImmediately: true,
      worldName: WATCH_WORLD,
    });
    // The page's requests in flight, and when the last one ended, for
    // `wait`. Playwright's events cover every frame of the page.
    this.page.on('request', this.onRequest);
    this.page.on('requestfinished', this.onRequestEnd);
    this.page.on('requestfailed', this.onRequestEnd);
    // New documents only. Playwright's `framenavigated` also fires for
    // `pushState` and hash changes, where the scripts are still running
    // from the earlier document and a "skipped" would be false.
    this.cdp.on('Page.frameNavigated', (ev) => {
      if (ev.frame.parentId) return;
      this.enterDocument(ev.frame.loaderId, ev.frame.url);
      this.host.noteNavigation(this, this.injectedScripts());
    });
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    this.currentDocument.url = frameTree.frame.url;
    this.documents.set(frameTree.frame.loaderId, this.currentDocument);
    this.page.on('close', this.onClose);
    // Closed during the awaits above, before the listener was on: the
    // event has come and gone.
    if (this.page.isClosed()) this.onClose();
  }

  /**
   * When the main frame entered its current document, by the host's
   * clock, as reports are stamped. Changes only when a new document
   * loads, not on a same-document (hash or `pushState`) navigation.
   */
  documentStart(): number {
    return this.currentDocument.spans[this.currentDocument.spans.length - 1][0];
  }

  /**
   * Resolves once the page has run the tasks it already had queued, and
   * the console lines they printed have arrived. A round trip through
   * Playwright's own session, as those lines are, so none comes after
   * it. Then one through the attachment's session, so the events it
   * was sent meanwhile have arrived too. For a
   * command to end after what it set off in the page, such as a menu
   * handler, or a script body, which runs after its start report.
   */
  async drain(): Promise<void> {
    await this.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0))).catch(() => undefined);
    await this.caughtUp();
  }

  /**
   * Resolves once the events the attachment's session had already been
   * sent have arrived: a navigation's new document. Playwright's own
   * session can run ahead of it.
   */
  async caughtUp(): Promise<void> {
    if (this.closed) return;
    await this.cdp.send('Runtime.evaluate', { expression: '0' }).catch(() => undefined);
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

  /**
   * The page's document state and its DOM's last change, for `wait`.
   * Null when there is no document to ask. Can wait on a page busy in
   * a long script, so the caller bounds it.
   */
  async activity(): Promise<PageActivity | null> {
    const contextId = this.contextFor(WATCH_WORLD);
    if (contextId === null || this.closed) return null;
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', {
      contextId,
      returnByValue: true,
      expression: `(() => {
        const s = globalThis[Symbol.for(${JSON.stringify(ACTIVITY_KEY)})];
        return { readyState: document.readyState, sinceDom: s ? Date.now() - s.last : 0, lastChanged: s ? s.target : '' };
      })()`,
    });
    if (exceptionDetails) return null;
    return result.value as PageActivity;
  }

  /**
   * Resolves once the page's main thread has a moment with nothing to
   * do (`requestIdleCallback`), or after `maxMs`.
   */
  async idle(maxMs: number): Promise<void> {
    const contextId = this.contextFor(WATCH_WORLD);
    if (contextId === null || this.closed) return;
    await this.cdp.send('Runtime.evaluate', {
      contextId,
      awaitPromise: true,
      expression: `new Promise((resolve) => requestIdleCallback(() => resolve(true), { timeout: ${maxMs} }))`,
    });
  }

  /** The page's requests in flight, and milliseconds since one last ended. */
  network(): { pending: PendingRequest[]; sinceLast: number } {
    const now = Date.now();
    return {
      pending: [...this.requests].map(([request, at]) => ({ url: request.url(), ms: now - at })),
      sinceLast: this.lastRequestEnd === 0 ? Infinity : now - this.lastRequestEnd,
    };
  }

  // ---------- PageLink ----------

  url(): string {
    return this.page.url();
  }

  // The top frame's context the scripts without `@grant none` run in:
  // the extension's user-script world.
  private scriptsContext(): number | null {
    const origin = this.options.watchOnly.extensionOrigin;
    let found: number | null = null;
    for (const [id, info] of this.contexts) {
      if (info.frameId === this.mainFrameId && !info.isDefault && info.origin === origin) found = id;
    }
    return found;
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

  /**
   * Evaluates `expression` in the main frame, in the page's own world,
   * the scripts' (the user-script world every script without `@grant
   * none` shares), or one script's own scope, for `eval`. Resolves to
   * the result as a line to print; rejects with a `ScriptThrew` for what
   * the expression threw, a `NoEvalHook` for a script that hasn't run
   * here, or an error of the evaluation's own (the page gone, say).
   */
  async evaluate(expression: string, world: 'page' | 'scripts' | ScriptScope): Promise<string> {
    await this.documentReady();
    if (typeof world === 'object') return this.evaluateInScript(expression, world);
    const contextId = world === 'page' ? this.contextFor('') : this.scriptsContext();
    // The page context can go again between the wait and here.
    if (contextId === null) throw world === 'page' ? new NoDocument(BETWEEN_DOCUMENTS) : new Error('The scripts\' world isn\'t set up in this document');
    let { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', {
      expression, contextId, awaitPromise: true, replMode: true, userGesture: true,
    });
    // Code written as a function body (`return` at the top level) is a
    // syntax error as console input. Nothing ran, so it's safe to run
    // again as an async function's body, whose `return` is the value.
    // The newline keeps a trailing `// comment` off the closing `})`.
    if (exceptionDetails && isIllegalReturn(exceptionDetails)) {
      ({ result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', {
        expression: `(async () => {\n${expression}\n})()`, contextId, awaitPromise: true, userGesture: true,
      }));
    }
    return this.evaluated(result, exceptionDetails);
  }

  // A page that is reloading or navigating has no document for a moment,
  // which a site that reloads itself often makes likely. Waits for the
  // next one, and throws `NoDocument` if none comes. The new document's
  // scripts may not have run yet; a world or hook they set up is looked
  // for after this.
  private async documentReady(): Promise<void> {
    if (this.contextFor('') !== null) return;
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), DOCUMENT_WAIT_MS);
      const created = (): void => {
        if (this.contextFor('') !== null) finish(true);
      };
      // The tab closing ends the wait; the caller says it closed.
      const closed = (): void => finish(false);
      const finish = (found: boolean): void => {
        clearTimeout(timer);
        this.cdp.off('Runtime.executionContextCreated', created);
        this.page.off('close', closed);
        resolve(found);
      };
      // After the listener install() added, which records the context.
      this.cdp.on('Runtime.executionContextCreated', created);
      this.page.once('close', closed);
    });
    if (!ready) throw new NoDocument(`${BETWEEN_DOCUMENTS}. No new one loaded within ${DOCUMENT_WAIT_MS / 1000} seconds.`);
  }

  // Through the script's eval hook, a direct `eval` in its scope. That
  // isn't console input: `await` and a top-level `return` are syntax
  // errors there. So the code is compiled first (which runs nothing),
  // and code that needs it runs in an async arrow: as its expression
  // when it is one (`await x` gives x, as in the console), else as its
  // body, whose `return` is the value.
  //
  // A page-world script's hook `eval`s under the page's Content Security
  // Policy, but within a CDP evaluation, which Chrome exempts from it.
  private async evaluateInScript(expression: string, scope: ScriptScope): Promise<string> {
    const contextId = scope.world === 'MAIN' ? this.contextFor('') : this.scriptsContext();
    if (contextId === null) throw new NoEvalHook();
    const hook = `globalThis[${JSON.stringify(scope.key)}]?.[${JSON.stringify(scope.id)}]`;
    const { result: found } = await this.cdp.send('Runtime.evaluate', {
      expression: `typeof ${hook} === 'function'`, contextId, returnByValue: true,
    });
    if (found.value !== true) throw new NoEvalHook();
    const { exceptionDetails: compiled } = await this.cdp.send('Runtime.compileScript', {
      expression, sourceURL: '', persistScript: false, executionContextId: contextId,
    });
    let code = expression;
    if (compiled && needsFunctionBody(compiled)) {
      const asExpression = `(async () => (\n${expression}\n))()`;
      const { exceptionDetails: notExpression } = await this.cdp.send('Runtime.compileScript', {
        expression: asExpression, sourceURL: '', persistScript: false, executionContextId: contextId,
      });
      code = notExpression ? `(async () => {\n${expression}\n})()` : asExpression;
    }
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', {
      // Called detached, so its stack frame isn't named `[as <script id>]`.
      expression: `(0, ${hook})(${JSON.stringify(code)})`, contextId, awaitPromise: true, userGesture: true,
    });
    return this.evaluated(result, exceptionDetails);
  }

  // An evaluation's result as a line to print, or what it threw.
  private async evaluated(result: RemoteObject, exceptionDetails: { text: string; exception?: unknown } | undefined): Promise<string> {
    if (exceptionDetails) throw threw(exceptionDetails);
    // A promise, as `eval fetch(url).then(...)` gives: what it settles
    // to, where the console would show the promise itself.
    if (result.subtype === 'promise' && result.objectId) {
      const settled = await this.cdp.send('Runtime.awaitPromise', { promiseObjectId: result.objectId });
      if (settled.exceptionDetails) throw threw(settled.exceptionDetails);
      return this.describe(settled.result);
    }
    return this.describe(result);
  }

  // A result as `eval` prints it: JSON where it has one, else what
  // DevTools' console would show (an element, a Map, a function).
  private async describe(result: RemoteObject): Promise<string> {
    if (result.type === 'undefined') return 'undefined';
    if (!result.objectId) return result.unserializableValue ?? JSON.stringify(result.value);
    try {
      if (result.type !== 'object' || (result.subtype && DESCRIBED.has(result.subtype))) return result.description ?? result.type;
      // Elements inside it as the console names them, not `{}`.
      const { result: json } = await this.cdp.send('Runtime.callFunctionOn', {
        objectId: result.objectId,
        functionDeclaration: `function () {
          return JSON.stringify(this, (key, value) => {
            if (value instanceof Element) {
              const classes = typeof value.className === 'string' && value.className.trim() ? '.' + value.className.trim().split(/\\s+/).join('.') : '';
              return value.localName + (value.id ? '#' + value.id : '') + classes;
            }
            if (value instanceof Node) return value.nodeName;
            if (value instanceof Map) return Object.fromEntries(value);
            if (value instanceof Set) return [...value];
            return value;
          }, 2);
        }`,
        returnByValue: true,
      });
      const text = typeof json.value === 'string' ? json.value : result.description ?? result.type;
      return text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text;
    } catch {
      // Circular, or a getter that throws: what the console would show.
      return result.description ?? result.type;
    } finally {
      await this.cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => undefined);
    }
  }

  // ---------- The tab's scripts ----------

  /**
   * Records a script the tab runs. Re-recording the same script
   * replaces it.
   */
  async inject(prepared: PreparedScript, options: InjectOptions = {}): Promise<void> {
    if (!prepared.id) throw new Error(`Cannot record an invalid script: ${prepared.diagnostic}`);
    const id = prepared.id;
    if (this.injected.has(id)) await this.remove(id);
    this.host.addScript(prepared, this);
    this.injected.set(id, { script: prepared, at: Date.now(), into: options.immediately ? this.currentDocument : undefined });
  }

  /** The tab no longer runs a script, from its next navigation. */
  async remove(scriptId: string): Promise<void> {
    if (!this.injected.delete(scriptId)) return;
    this.host.removeScript(scriptId, this);
  }

  injectedScripts(): PreparedScript[] {
    return [...this.injected.values()].map((e) => e.script);
  }

  /**
   * The scripts the current document runs, and so hears from: recorded
   * before it started, or run in it at once. One added later (a `load`
   * into a tab a dialog kept from reloading) waits for the next load.
   */
  scriptsInDocument(): PreparedScript[] {
    const start = this.documentFirstStart();
    return [...this.injected.values()]
      .filter((e) => e.at <= start || e.into === this.currentDocument)
      .map((e) => e.script);
  }

  /**
   * When the main frame first entered its current document. Unlike
   * `documentStart`, the same after the back/forward cache restores it,
   * when its scripts don't run again.
   */
  documentFirstStart(): number {
    return this.currentDocument.spans[0][0];
  }

  /** Stop watching, and drop the CDP session. */
  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    this.page.off('request', this.onRequest);
    this.page.off('requestfinished', this.onRequestEnd);
    this.page.off('requestfailed', this.onRequestEnd);
    this.requests.clear();
    for (const id of [...this.injected.keys()]) await this.remove(id);
    this.closed = true;
    this.page.off('close', this.onClose);
    this.host.detachPage(this);
    attached.delete(this.page);
    // A page stopped on a dialog answers nothing until it is closed, so
    // this is not waited on for long; the session goes with the page.
    await Promise.race([this.cdp.detach().catch(() => undefined), new Promise((r) => setTimeout(r, 1000).unref())]);
  }
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

export async function attachPage(page: Page, host: HarnessHost, options: AttachOptions): Promise<PageAttachment> {
  return PageAttachment.create(page, host, options);
}
