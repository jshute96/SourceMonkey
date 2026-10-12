// The Playwright fixture a repo of userscripts imports:
//
//     import { test, expect } from 'sourcemonkey/harness';
//
// It extends `@playwright/test` so each test's scripts run in the real
// SourceMonkey extension, as sm-dev's runs do: `loadUserscript` pushes a
// script from disk into a test collection of the test's own, `gm` seeds
// and reads what the script did, `reports` has what it reported, and
// `serveHtml` runs it against a saved page.
//
// - The browser: by default one per worker process, launched with the
//   package's built extension (extension-launch.ts), and reused by that
//   worker's tests. A repo that drives a browser of its own (a logged-in
//   one, over CDP) overrides `browser`, `context` and `page` as it
//   always has; that browser needs SourceMonkey loaded, with "Allow
//   User Scripts" on.
// - Per test: an `ExtensionLink` with its own run id, which claims the
//   test's page so only the test's scripts run there, and an
//   `ExtensionHost` filled from the extension's events. The test
//   collection goes when the test ends.
//
// See docs/harness-guide.md for the user-facing description.

import { test as base, chromium, type BrowserContext, type CDPSession, type Worker } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { savePageHtml, userscriptLabel } from './save-html.js';
import { companionFiles, loadSavedPage, routeSavedPage, savedPageUrl } from './saved-pages.js';

import type { GmXhrEvent, GmXhrRequestPayload } from '../gm-xhr-types.js';
import { ExtensionHost } from './extension-host.js';
import { launchExtensionBrowser } from './extension-launch.js';
import { ExtensionLink, linkRunId } from './extension-link.js';
import { RUN_SCRIPT_LABEL } from '../userscript-header.js';
import type { ConnectChoice, HostReports, SkipReport, ErrorReport, StartReport, RequestInterceptor } from './host.js';
import { attachPage, type PageAttachment } from './page-watch.js';
import {
  prepareScript,
  scriptRoots,
  pushedFiles,
  NO_RULE_COVERS_URL,
  explainMatch,
  preparedScriptMatches,
  type PreparedScript,
  type PrepareOptions,
} from './prepare.js';

export interface LoadOptions extends Omit<PrepareOptions, 'file' | 'text'> {
  /** Seed the script's `GM_*` storage before it runs. */
  values?: Record<string, unknown>;
  /**
   * Load the same file a second time as a separate copy: its own
   * script id and its own storage, as two installed copies would be.
   * Pass any name you can refer to it by afterwards.
   */
  copy?: string;
  /**
   * Check the page URL against the script's header now and throw if it
   * would not run there, rather than finding out from a silent page.
   */
  url?: string;
}

// `script` selects one loaded script when several are: by the path
// given to `loadUserscript`, its basename, or the script's `@name`.
// All three work, because different specs have different ones to
// hand.
export interface GmApi {
  /** A stored value, decoded. */
  get(key: string, script?: string): unknown;
  /**
   * Write a value as another tab of the script would: a script already
   * running sees it on its next `GM_getValue` and its value-change
   * listeners fire with `remote` set. Before the first navigation it is
   * simply seeded.
   */
  set(key: string, value: unknown, script?: string): Promise<void>;
  list(script?: string): Record<string, unknown>;
  /**
   * The menu commands' labels. A manual script (`@run-at context-menu`)
   * that can run on the page lists "Run this script" first.
   */
  menuCommands(script?: string): string[];
  /**
   * Fire a menu command by its label. Resolves false if none matches.
   * "Run this script" runs a manual script, as `runScript` does.
   */
  fireMenu(label: string, script?: string): Promise<boolean>;
  /**
   * Run a manual script (`@run-at context-menu`) on the test's page, as
   * its popup "Run this script" does. Each call is another run. Rejects
   * with SourceMonkey's reason when it can't run there.
   */
  runScript(script?: string): Promise<void>;
  openedTabs(): HostReports['tabs'];
  notifications(): HostReports['notifications'];
  clickNotification(requestId: string): Promise<boolean>;
  closeNotification(requestId: string): Promise<boolean>;
  downloads(): HostReports['downloads'];
  requests(): HostReports['requests'];
  /** SourceMonkey's prompts to let a script connect to a host its `@connect` lines don't cover. */
  connectPrompts(): HostReports['connectPrompts'];
  /** Answer a waiting connection prompt. Resolves false if it isn't waiting. */
  answerConnectPrompt(promptId: string, choice: ConnectChoice): Promise<boolean>;
  /**
   * Answer `GM_xmlhttpRequest`s from the test instead of the network:
   * return an event (`{ kind: 'error', message }` or
   * `{ kind: 'load', response }`) to use it, null to let the request
   * go. `failHosts(...)` is the common case, a synthetic 503 for those
   * hosts. Resolves once requests are being intercepted. The extension
   * makes the request, so:
   * - an `error`, `timeout` or `abort` answer reaches the script as a
   *   network failure, with the extension's own message;
   * - a `load` answer's status, headers, `responseText` and `finalUrl`
   *   are what the script sees, and the rest is derived from them;
   * - the interceptor's script id is set only when one script is loaded.
   */
  interceptRequests(fn: RequestInterceptor | null): Promise<void>;
  failHosts(...hosts: string[]): Promise<void>;
}

export interface ReportsApi {
  started(): StartReport[];
  skipped(): SkipReport[];
  errors(): ErrorReport[];
  /**
   * Resolve once a script has reported that it started; `script`
   * selects one as in `GmApi`. An earlier start in the same test
   * counts, so after a second navigation clear the reports first or
   * wait on the page instead.
   */
  waitForStart(script?: string, timeoutMs?: number): Promise<StartReport>;
}

export interface HarnessFixtures {
  host: ExtensionHost;
  attachment: PageAttachment;
  loadUserscript: (file: string, options?: LoadOptions) => Promise<PreparedScript>;
  gm: GmApi;
  reports: ReportsApi;
  /**
   * Serve a saved HTML file at `url` on this page, so `@match` and
   * relative URLs behave as on the live site. Without `url`, the one
   * the file's header records (`saveHtml` writes it). The URL is
   * matched exactly, query string included, fragment ignored. Other
   * requests fall through to the page's other routes and then the
   * network, unless `block` is set, which aborts them. Resolves to the
   * URL served, for the spec to go to.
   */
  serveHtml: (file: string, url?: string, options?: { block?: boolean }) => Promise<string>;
  /**
   * Write the page's current DOM to `file`, for `serveHtml` to
   * replay later. The same file the `savehtml` run command writes: run a spec
   * once against the live site to record it, then serve it and the
   * spec needs no login.
   */
  saveHtml: (file: string) => Promise<void>;
}

interface InternalFixtures {
  // The test's connection to SourceMonkey, released at its end.
  _smLink: ExtensionLink;
  // The scripts the test loaded, and the request interception.
  _smLoaded: PreparedScript[];
  _smRequests: RequestFakes;
}

export const test = base.extend<HarnessFixtures & InternalFixtures>({
  // A browser of the worker's own, with the extension. Over CDP, so
  // `browser` is a Playwright `Browser` as specs expect.
  browser: [async ({ headless }, use) => {
    const launched = await launchExtensionBrowser({ headed: !headless, connectedElsewhere: true });
    try {
      const browser = await chromium.connectOverCDP(launched.endpoint);
      await use(browser);
      await browser.close().catch(() => undefined);
    } finally {
      await launched.close();
    }
  }, { scope: 'worker' }],

  // The browser's own context, where the extension is: one for the
  // worker's tests, whose pages each test opens and closes.
  context: async ({ browser }, use) => {
    await use(browser.contexts()[0]);
  },

  // A page of the test's own, closed at its end with the tabs it opened,
  // since the context outlives the test.
  page: async ({ context }, use) => {
    const before = new Set(context.pages());
    const page = await context.newPage();
    await use(page);
    for (const p of context.pages()) if (!before.has(p)) await p.close().catch(() => undefined);
  },

  _smLink: async ({ context }, use) => {
    const link = await ExtensionLink.open(context, linkRunId('test'));
    await use(link);
    await link.close();
  },

  _smLoaded: async ({}, use) => {
    await use([]);
  },

  _smRequests: async ({ context, _smLink, _smLoaded }, use) => {
    const fakes = new RequestFakes(context, _smLink.workerUrl, () => _smLoaded);
    await use(fakes);
    await fakes.stop();
  },

  host: async ({ _smLink }, use) => {
    // Log entries other than reports, which `GM_log` adds to.
    const host: ExtensionHost = new ExtensionHost(_smLink, () => undefined);
    await use(host);
  },

  // The test's page, claimed for the test so only its scripts run
  // there, and watched for what they report. Set up with every test, so
  // a page a test serves without loading a script runs none of the
  // extension's either.
  attachment: [async ({ page, host, _smLink }, use) => {
    const tabId = await _smLink.claimPage(page);
    const attachment = await attachPage(page, host, { watchOnly: { extensionOrigin: _smLink.origin } });
    host.addTab(attachment, tabId);
    await use(attachment);
    await attachment.dispose();
  }, { auto: true }],

  loadUserscript: async ({ attachment, host, _smLink, _smLoaded, _smRequests }, use, testInfo) => {
    await use(async (file, options = {}) => {
      const { values, url, ...prepareOptions } = options;
      const abs = path.isAbsolute(file) ? file : path.resolve(testInfo.config.rootDir, file);
      const { collectionRoot, localRoots } = scriptRoots(abs, prepareOptions.collectionRoot ?? testInfo.config.rootDir, prepareOptions.localRoots);
      const prepared = await prepareScript({ ...prepareOptions, file: abs, collectionRoot, localRoots });
      if (prepared.status !== 'ok' || !prepared.id) {
        throw new Error(`This file cannot be loaded: ${prepared.diagnostic}`);
      }
      if (url) {
        const verdict = explainMatch(prepared.matching, url);
        if (!verdict.matches) {
          throw new Error(`${path.basename(file)} would not run on ${url}: ${verdict.rule ?? NO_RULE_COVERS_URL}`);
        }
      }
      // The extension keeps the test's scripts by this name: the path
      // under the collection root, with the copy's name for a copy.
      const relative = path.relative(collectionRoot, abs).split(path.sep).join('/');
      const name = prepareOptions.copy ? relative.replace(/(\.user\.js)?$/, `-copy-${prepareOptions.copy}$1`) : relative;
      const text = await readFile(abs, 'utf8');
      // Its `@require`s are fetched as it installs, which a test's
      // request fakes are not for.
      const result = await _smRequests.paused(() => _smLink.push(text, name, pushedFiles(prepared)));
      if (result.status !== 'ok') throw new Error(`This file cannot be loaded: ${result.errorMessage ?? 'SourceMonkey refused it'}`);
      host.setPushed(prepared.id, result.scriptId);
      host.setLayout(result.scriptId, await _smLink.stackLayout(result.scriptId).catch(() => null));
      await attachment.inject(prepared);
      _smLoaded.push(prepared);
      if (values) await host.setValues(prepared.id, values);
      return prepared;
    });
  },

  gm: async ({ host, attachment, _smLoaded, _smRequests }, use) => {
    const idOf = (script?: string): string => {
      if (_smLoaded.length === 0) throw new Error('No userscript is loaded');
      if (script === undefined) {
        if (_smLoaded.length > 1) throw new Error('Multiple userscripts are loaded; name one');
        return _smLoaded[0].id!;
      }
      const found = _smLoaded.find((p) => preparedScriptMatches(p, script));
      if (!found) throw new Error(`No loaded userscript is named ${script}`);
      return found.id!;
    };
    await use({
      get: (key, script) => host.getValue(idOf(script), key),
      set: (key, value, script) => host.setValues(idOf(script), { [key]: value }),
      list: (script) => host.getValues(idOf(script)),
      menuCommands: (script) => {
        const id = script === undefined ? undefined : idOf(script);
        const runnable = host.manualScripts(attachment).filter((m) => id === undefined || m === id);
        return [
          ...runnable.map(() => RUN_SCRIPT_LABEL),
          ...host.reports.menuCommands.filter((m) => id === undefined || m.scriptId === id).map((m) => m.name),
        ];
      },
      fireMenu: async (label, script) => {
        const id = script === undefined ? undefined : idOf(script);
        if (label === RUN_SCRIPT_LABEL) {
          const runnable = host.manualScripts(attachment).filter((m) => id === undefined || m === id);
          if (runnable.length === 1) {
            await host.runManualScript(attachment, runnable[0]);
            return true;
          }
        }
        return host.fireMenuCommand(label, id);
      },
      runScript: (script) => host.runManualScript(attachment, idOf(script)),
      openedTabs: () => host.reports.tabs,
      notifications: () => host.reports.notifications,
      clickNotification: (requestId) => host.clickNotification(requestId),
      closeNotification: (requestId) => host.closeNotification(requestId),
      downloads: () => host.reports.downloads,
      requests: () => host.reports.requests,
      connectPrompts: () => host.reports.connectPrompts,
      answerConnectPrompt: (promptId, choice) => host.answerConnectPrompt(promptId, choice),
      interceptRequests: (fn) => _smRequests.set(fn),
      failHosts: (...hosts) => {
        const set = new Set(hosts);
        return _smRequests.set((request) => {
          let hostname = '';
          try { hostname = new URL(request.url).hostname; } catch { return null; }
          if (!set.has(hostname)) return null;
          return {
            kind: 'load',
            response: {
              status: 503, statusText: 'Service Unavailable', responseURL: request.url,
              responseText: '', response: '', responseHeaders: '', finalUrl: request.url,
            },
          };
        });
      },
    });
  },

  reports: async ({ host, _smLoaded }, use) => {
    await use({
      started: () => host.reports.started,
      skipped: () => host.reports.skipped,
      errors: () => host.reports.errors,
      waitForStart: (script, timeoutMs = 10000) => new Promise<StartReport>((resolve, reject) => {
        // The same selection `gm` uses, via the loaded script's id.
        const wanted = script === undefined
          ? undefined
          : _smLoaded.find((p) => preparedScriptMatches(p, script))?.id! ?? script;
        const matches = (r: StartReport): boolean => wanted === undefined || r.scriptId === wanted;
        const already = host.reports.started.find(matches);
        if (already) {
          resolve(already);
          return;
        }
        const timer = setTimeout(() => {
          host.off('start', onStart);
          const skipped = host.reports.skipped.map((s) => `${s.name} on ${s.url}: ${s.reason}`).join('; ');
          reject(new Error(skipped
            ? `No userscript started within ${timeoutMs} ms. Skipped: ${skipped.replace(/\.$/, '')}.`
            : `No userscript started within ${timeoutMs} ms`));
        }, timeoutMs);
        const onStart = (r: StartReport): void => {
          if (!matches(r)) return;
          clearTimeout(timer);
          host.off('start', onStart);
          resolve(r);
        };
        host.on('start', onStart);
      }),
    });
  },

  saveHtml: async ({ page, attachment, host, _smLoaded }, use) => {
    await use(async (file) => {
      const running = _smLoaded.filter((s) => s.id && host.isRunning(attachment, s.id));
      await savePageHtml(page, file, running.map(userscriptLabel));
    });
  },

  serveHtml: async ({ page }, use) => {
    await use(async (file, url, options = {}) => {
      const { html, header } = await loadSavedPage(file);
      const found = savedPageUrl(file, header, url, 'Pass one to serveHtml.');
      if ('problem' in found) throw new Error(found.problem);
      const at = found.url;
      await routeSavedPage(page, () => ({
        url: at,
        html: async () => html,
        block: options.block ? () => true : undefined,
        name: file,
        companion: companionFiles(file, at),
      }));
      return at;
    });
  },
});

export { expect } from '@playwright/test';

/**
 * A test's answers to its scripts' `GM_xmlhttpRequest`s, which the
 * extension's worker makes.
 *
 * - Paused with CDP's Fetch domain in the worker's own target, over a
 *   browser-level session (Playwright opens none on a worker). Not
 *   Playwright's `context.route`, which sees the worker's requests but
 *   not the hop after a redirect, which a response ending at another
 *   URL (`finalUrl`) needs.
 * - Only while a test has set an interceptor; a worker that restarts
 *   is attached to again, and requests it makes before that go out.
 * - Only the worker's `fetch`es, which `GM_xmlhttpRequest` makes and a
 *   download doesn't. The ones a push makes (a script's `@require`s)
 *   are let go, and the interceptor's null lets one go.
 * - The worker doesn't say which tab or script a request is for. In a
 *   browser of the repo's own, other tabs' scripts' requests are seen
 *   too, and the interceptor gets a script id only when one script is
 *   loaded.
 */
class RequestFakes {
  private interceptor: RequestInterceptor | null = null;
  private session: CDPSession | null = null;
  // The worker target attached to, and its session id there.
  private attached: { targetId: string; sessionId: string } | null = null;
  private attaching: Promise<void> | null = null;
  private listening = false;
  private pausedCount = 0;
  private nextId = 0;
  private readonly waiting = new Map<number, (reply: { error?: { message: string } }) => void>();
  // Bodies for the URL a faked redirect leads to, served as the worker
  // follows it.
  private readonly redirected = new Map<string, LoadResponse>();
  private readonly onWorker = (worker: Worker): void => {
    if (worker.url() === this.workerUrl && this.interceptor) void this.attach().catch(() => undefined);
  };

  constructor(
    private readonly context: BrowserContext,
    private readonly workerUrl: string,
    private readonly loaded: () => readonly PreparedScript[],
  ) {}

  set(fn: RequestInterceptor | null): Promise<void> {
    this.interceptor = fn;
    if (!fn) return Promise.resolve();
    if (!this.listening) {
      this.listening = true;
      this.context.on('serviceworker', this.onWorker);
    }
    return this.attach();
  }

  /** Runs `work` with every request let go. */
  async paused<T>(work: () => Promise<T>): Promise<T> {
    this.pausedCount++;
    try {
      return await work();
    } finally {
      this.pausedCount--;
    }
  }

  async stop(): Promise<void> {
    this.interceptor = null;
    this.listening = false;
    this.context.off('serviceworker', this.onWorker);
    this.redirected.clear();
    const session = this.session;
    this.session = null;
    this.detached();
    await session?.detach().catch(() => undefined);
  }

  // Attaches to the worker running now, unless already attached to it.
  private attach(): Promise<void> {
    this.attaching ??= this.attachNow().finally(() => { this.attaching = null; });
    return this.attaching;
  }

  private async attachNow(): Promise<void> {
    const browser = this.context.browser();
    if (!browser) {
      throw new Error('Requests can\'t be intercepted in a launchPersistentContext context. Connect to the browser (chromium.connectOverCDP) and use its context instead.');
    }
    if (!this.session) {
      this.session = await browser.newBrowserCDPSession();
      this.session.on('Target.receivedMessageFromTarget', (ev) => this.onMessage(ev.sessionId, ev.message));
      // The worker stopped: its calls in flight get no answer.
      this.session.on('Target.detachedFromTarget', (ev) => {
        if (ev.sessionId === this.attached?.sessionId) this.detached();
      });
    }
    const { targetInfos } = await this.session.send('Target.getTargets');
    const target = targetInfos.find((t) => t.type === 'service_worker' && t.url === this.workerUrl);
    if (!target) throw new Error('Internal error: SourceMonkey\'s background script is not running, so requests can\'t be intercepted');
    if (this.attached?.targetId === target.targetId) return;
    // Not flattened: a flat session's messages need a session id
    // Playwright's CDP session can't send with.
    const { sessionId } = await this.session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    this.attached = { targetId: target.targetId, sessionId };
    try {
      await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Fetch' }] });
    } catch (err) {
      // Not attached after all, so the next `set` tries again.
      this.detached();
      throw err;
    }
  }

  // No worker attached: the calls waiting on one are answered as failed.
  private detached(): void {
    this.attached = null;
    for (const answer of this.waiting.values()) answer({ error: { message: 'The background script stopped' } });
    this.waiting.clear();
  }

  // A call to the worker's target, over the attached session.
  private async send(method: string, params: object): Promise<void> {
    const session = this.session;
    const attached = this.attached;
    if (!session || !attached) return;
    const id = ++this.nextId;
    const reply = new Promise<{ error?: { message: string } }>((resolve) => this.waiting.set(id, resolve));
    await session.send('Target.sendMessageToTarget', { sessionId: attached.sessionId, message: JSON.stringify({ id, method, params }) });
    const { error } = await reply;
    if (error) throw new Error(`Internal error: Intercepting the background script's requests failed (${method}): ${error.message}`);
  }

  private onMessage(sessionId: string, text: string): void {
    if (sessionId !== this.attached?.sessionId) return;
    let message: { id?: number; method?: string; params?: PausedRequest; error?: { message: string } };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
      return;
    }
    if (message.method === 'Fetch.requestPaused' && message.params) {
      void this.answer(message.params).catch(() => this.send('Fetch.continueRequest', { requestId: message.params!.requestId }).catch(() => undefined));
    }
  }

  private async answer({ requestId, request }: PausedRequest): Promise<void> {
    const fn = this.interceptor;
    const pending = this.redirected.get(request.url);
    if (pending) {
      this.redirected.delete(request.url);
      await this.fulfill(requestId, pending);
      return;
    }
    if (!fn || this.pausedCount > 0) {
      await this.send('Fetch.continueRequest', { requestId });
      return;
    }
    const payload: GmXhrRequestPayload = {
      url: request.url, method: request.method, headers: request.headers, ...(request.postData !== undefined ? { data: request.postData } : {}),
    };
    // The worker doesn't say which script asked; with one loaded, it did.
    const loaded = this.loaded();
    const event = await fn(payload, loaded.length === 1 ? loaded[0].id! : '');
    if (!event) {
      await this.send('Fetch.continueRequest', { requestId });
      return;
    }
    if (event.kind === 'load') {
      const finalUrl = event.response.finalUrl;
      // A redirect to the final URL, whose answer is the response, so
      // the script sees the request end where the test said.
      if (finalUrl && finalUrl !== request.url) {
        this.redirected.set(finalUrl, event.response);
        await this.send('Fetch.fulfillRequest', { requestId, responseCode: 302, responseHeaders: [{ name: 'location', value: finalUrl }] });
        return;
      }
      await this.fulfill(requestId, event.response);
      return;
    }
    await this.send('Fetch.failRequest', {
      requestId, errorReason: event.kind === 'timeout' ? 'TimedOut' : event.kind === 'abort' ? 'Aborted' : 'Failed',
    });
  }

  private async fulfill(requestId: string, response: LoadResponse): Promise<void> {
    const responseHeaders: { name: string; value: string }[] = [];
    for (const line of response.responseHeaders.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) responseHeaders.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
    }
    await this.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: response.status,
      ...(response.statusText ? { responsePhrase: response.statusText } : {}),
      responseHeaders,
      body: Buffer.from(response.responseText).toString('base64'),
    });
  }
}

type LoadResponse = Extract<GmXhrEvent, { kind: 'load' }>['response'];

// What CDP's `Fetch.requestPaused` says, in the part used here.
interface PausedRequest {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
}
