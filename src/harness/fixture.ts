// The Playwright fixture a repo of userscripts imports:
//
//     import { test, expect } from 'sourcemonkey/harness';
//
// It extends `@playwright/test` with a host and a page attachment per
// test, `loadUserscript` to inject a script from disk, `gm` to seed
// and read what the script did, `reports` for what the script itself
// reported, and `serveSnapshot` to run against a saved page. The
// browser and context are left to Playwright's own fixtures, so a
// repo that attaches to a manually launched browser overrides those
// as it always has and re-exports this `test` extended with them.
//
// See docs/harness-guide.md for the user-facing description.

import { test as base } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { savePageSnapshot } from './capture-page.js';

import {
  HarnessHost, NO_RULE_COVERS_URL,
  type HostReports, type SkipReport, type ErrorReport, type StartReport, type RequestInterceptor,
} from './host.js';
import { attachPage, type PageAttachment } from './inject.js';
import { prepareScript, explainMatch, type PreparedScript, type PrepareOptions } from './prepare.js';

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
// Any of the three, because each is what a different spec has to hand.
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
  menuCommands(script?: string): string[];
  /** Fire a registered menu command by its label. Resolves false if none matches. */
  fireMenu(label: string, script?: string): Promise<boolean>;
  openedTabs(): HostReports['tabs'];
  notifications(): HostReports['notifications'];
  clickNotification(requestId: string): Promise<boolean>;
  closeNotification(requestId: string): Promise<boolean>;
  downloads(): HostReports['downloads'];
  requests(): HostReports['requests'];
  /**
   * Answer `GM_xmlhttpRequest`s from the test instead of the network:
   * return an event (`{ kind: 'error', message }` or
   * `{ kind: 'load', response }`) to use it, null to let the request
   * go. `failHosts(...)` is the common case, a synthetic 503 for those
   * hosts.
   */
  interceptRequests(fn: RequestInterceptor | null): void;
  failHosts(...hosts: string[]): void;
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
  host: HarnessHost;
  attachment: PageAttachment;
  loadUserscript: (file: string, options?: LoadOptions) => Promise<PreparedScript>;
  gm: GmApi;
  reports: ReportsApi;
  /**
   * Serve a saved HTML file at `url` on this page, so `@match` and
   * relative URLs behave as on the live site. The URL is matched
   * exactly, query string included, fragment ignored. Other requests
   * fall through to the page's other routes and then the network,
   * unless `block` is set, which aborts them.
   */
  serveSnapshot: (file: string, url: string, options?: { block?: boolean }) => Promise<void>;
  /**
   * Write the page's current DOM to `file`, for `serveSnapshot` to
   * replay later. The same file `sm-dev snapshot` writes: run a spec
   * once against the live site to record it, then serve it and the
   * spec needs no login.
   */
  saveSnapshot: (file: string) => Promise<void>;
}

export const test = base.extend<HarnessFixtures>({
  // No teardown: the host holds no browser resources of its own, and
  // the attachment's dispose drops what it registered with the host.
  host: async ({}, use) => {
    await use(new HarnessHost());
  },

  attachment: async ({ page, host }, use) => {
    const attachment = await attachPage(page, host);
    await use(attachment);
    await attachment.dispose();
  },

  loadUserscript: async ({ attachment, host }, use, testInfo) => {
    await use(async (file, options = {}) => {
      const { values, url, ...prepareOptions } = options;
      const abs = path.isAbsolute(file) ? file : path.resolve(testInfo.config.rootDir, file);
      const prepared = await prepareScript({
        ...prepareOptions,
        file: abs,
        collectionRoot: prepareOptions.collectionRoot ?? testInfo.config.rootDir,
      });
      if (prepared.status !== 'ok' || !prepared.spec) {
        throw new Error(`This file cannot be loaded: ${prepared.diagnostic}`);
      }
      if (url) {
        const verdict = explainMatch(prepared.matching, url);
        if (!verdict.matches) {
          throw new Error(`${path.basename(file)} would not run on ${url}: ${verdict.rule ?? NO_RULE_COVERS_URL}`);
        }
      }
      if (values) host.seedValues(prepared.spec.id, values);
      await attachment.inject(prepared);
      return prepared;
    });
  },

  gm: async ({ host, attachment }, use) => {
    const idOf = (script?: string): string => {
      const loaded = attachment.injectedScripts();
      if (loaded.length === 0) throw new Error('No userscript is loaded');
      if (script === undefined) {
        if (loaded.length > 1) throw new Error('Several userscripts are loaded; name one');
        return loaded[0].spec!.id;
      }
      const found = loaded.find((p) => scriptMatches(p, script));
      if (!found) throw new Error(`No loaded userscript is named ${script}`);
      return found.spec!.id;

    };
    await use({
      get: (key, script) => host.getValue(idOf(script), key),
      set: (key, value, script) => host.setValues(idOf(script), { [key]: value }),
      list: (script) => host.getValues(idOf(script)),
      menuCommands: (script) => {
        const id = script === undefined ? undefined : idOf(script);
        return host.reports.menuCommands.filter((m) => id === undefined || m.scriptId === id).map((m) => m.name);
      },
      fireMenu: (label, script) => host.fireMenuCommand(label, script === undefined ? undefined : idOf(script)),
      openedTabs: () => host.reports.tabs,
      notifications: () => host.reports.notifications,
      clickNotification: (requestId) => host.clickNotification(requestId),
      closeNotification: (requestId) => host.closeNotification(requestId),
      downloads: () => host.reports.downloads,
      requests: () => host.reports.requests,
      interceptRequests: (fn) => { host.interceptRequests = fn; },
      failHosts: (...hosts) => {
        const set = new Set(hosts);
        host.interceptRequests = (request) => {
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
        };
      },
    });
  },

  reports: async ({ host, attachment }, use) => {
    await use({
      started: () => host.reports.started,
      skipped: () => host.reports.skipped,
      errors: () => host.reports.errors,
      waitForStart: (script, timeoutMs = 10000) => new Promise<StartReport>((resolve, reject) => {
        // The same selection `gm` uses, via the loaded script's id.
        const wanted = script === undefined
          ? undefined
          : attachment.injectedScripts().find((p) => scriptMatches(p, script))?.spec!.id ?? script;
        const matches = (r: StartReport): boolean => wanted === undefined || r.scriptId === wanted;
        const already = host.reports.started.find(matches);
        if (already) {
          resolve(already);
          return;
        }
        const timer = setTimeout(() => {
          host.off('start', onStart);
          const skipped = host.reports.skipped.map((s) => `${s.name} on ${s.url}: ${s.reason}`).join('; ');
          reject(new Error(`No userscript started within ${timeoutMs} ms${skipped ? `. Skipped: ${skipped}` : ''}`));
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

  saveSnapshot: async ({ page }, use) => {
    await use(async (file) => { await savePageSnapshot(page, file); });
  },

  serveSnapshot: async ({ page }, use) => {
    await use(async (file, url, options = {}) => {
      const html = await readFile(file, 'utf8');
      const wanted = comparableUrl(url);
      await page.route('**/*', async (route) => {
        if (comparableUrl(route.request().url()) === wanted) {
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
          return;
        }
        if (options.block) {
          await route.abort();
          return;
        }
        // `fallback`, not `continue`: Playwright runs route handlers
        // newest first and only `fallback` hands a request to the next
        // one, so this is what lets a second snapshot, or a HAR, sit
        // beside this route.
        await route.fallback();
      });
    });
  },
});

// A loaded script by the path it was loaded from, its basename, or its
// `@name`.
function scriptMatches(p: PreparedScript, script: string): boolean {
  return p.script.relativePath === script
    || path.basename(p.script.relativePath) === script
    || p.script.header?.tags.some((t) => t.tag === 'name' && !t.locale && t.value === script) === true;
}

// The browser reports `https://example.test` as `https://example.test/`
// and never reports a fragment, so both sides are normalized the same
// way before comparing.
function comparableUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.href;
  } catch {
    return raw;
  }
}

export { expect } from '@playwright/test';
