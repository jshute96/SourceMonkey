// `sm-dev run`: the interactive loop. Connect to a browser, inject one
// or more scripts from disk, load the page, and stream what happens
// until interrupted.
//
// Kept apart from cli.ts so the Node-only commands (`validate`,
// `match`) never load Playwright, which is an optional peer dependency.

import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { representativeMatch } from '../match-targets.js';
import { HarnessHost, type ErrorReport, type SkipReport, type StartReport } from './host.js';
import { attachPage, type PageAttachment } from './inject.js';
import { prepareScript, type PreparedScript } from './prepare.js';

export interface RunOptions {
  files: string[];
  /** The page to open. Defaults to the first URL the first script's `@match` implies. */
  url?: string;
  /** CDP endpoint to connect to, e.g. `http://127.0.0.1:9233`. */
  cdp?: string;
  /** Launch a Chromium instead of connecting. */
  launch?: boolean;
  headed?: boolean;
  /** Re-inject and reload whenever a script or one of its files changes. */
  watch?: boolean;
  /** Seed `GM_*` storage for every script before it runs. */
  values?: Record<string, unknown>;
  /** Fire this registered menu command once the page has loaded. */
  fireMenu?: string;
  collectionRoot: string;
  localRoots: string[];
  /** Where the stream goes. */
  out: (line: string) => void;
  /** Resolves when the run should end (Ctrl-C). Omit to return after the first load. */
  until?: Promise<void>;
}

export async function run(opts: RunOptions): Promise<number> {
  const prepared = await prepareAll(opts);
  if (!prepared) return 1;

  const url = opts.url ?? defaultUrl(prepared[0]);
  if (!url) {
    opts.out('No --url given and the first script\'s @match names no page to open');
    return 2;
  }

  const { chromium } = await import('@playwright/test');
  let browser: Browser;
  if (opts.launch) {
    browser = await chromium.launch({ headless: !opts.headed });
  } else {
    const endpoint = opts.cdp ?? process.env.SM_DEV_CDP ?? 'http://127.0.0.1:9233';
    try {
      browser = await chromium.connectOverCDP(endpoint);
    } catch (err) {
      opts.out(`Could not connect to a browser at ${endpoint}: ${(err as Error).message}`);
      opts.out('Start one with a remote-debugging port, pass --cdp, or use --launch');
      return 1;
    }
  }
  const context: BrowserContext = browser.contexts()[0] ?? await browser.newContext();
  const page: Page = await context.newPage();
  const host = new HarnessHost();
  wireOutput(host, page, opts.out);
  const attachment = await attachPage(page, host);

  const injectAll = async (scripts: PreparedScript[]): Promise<void> => {
    for (const script of scripts) {
      await attachment.inject(script);
      opts.out(`[sm-dev] injected ${script.script.relativePath}: world ${script.world}, run-at ${script.runAt}`);
    }
  };
  // Seeded once. A watch re-inject keeps the store, so values the
  // script wrote since the last save survive the save.
  if (opts.values) for (const script of prepared) host.seedValues(script.spec!.id, opts.values);
  await injectAll(prepared);
  opts.out(`[sm-dev] opening ${url}`);
  await page.goto(url).catch((err) => opts.out(`[sm-dev] navigation failed: ${(err as Error).message}`));
  if (opts.fireMenu) {
    // Registered from the script's body, so it exists once the script
    // has started; a short grace period covers a late registration.
    const name = opts.fireMenu;
    const deadline = Date.now() + 5000;
    let fired = false;
    while (!fired && Date.now() < deadline) {
      fired = await host.fireMenuCommand(name);
      if (!fired) await page.waitForTimeout(100);
    }
    opts.out(fired ? `[sm-dev] fired menu command "${name}"` : `[sm-dev] no menu command named "${name}" was registered`);
  }

  let watcher: (() => void) | null = null;
  if (opts.watch) watcher = watchFiles(opts, prepared, attachment, page, injectAll);

  if (opts.until) {
    await opts.until;
  } else {
    // One load's worth of output, then leave the page as it is.
    await page.waitForTimeout(500);
  }
  watcher?.();
  await attachment.dispose();
  // On a connected browser this only drops the connection; the browser
  // and the tab stay as they are.
  await browser.close();
  return host.reports.errors.length === 0 ? 0 : 1;
}

async function prepareAll(opts: RunOptions): Promise<PreparedScript[] | null> {
  const out: PreparedScript[] = [];
  for (const file of opts.files) {
    const p = await prepareScript({ file, collectionRoot: opts.collectionRoot, localRoots: opts.localRoots });
    if (p.status !== 'ok') {
      opts.out(`INVALID  ${path.relative(process.cwd(), file)}\n    ${p.diagnostic}`);
      return null;
    }
    for (const log of p.startupLogs) opts.out(`[sm-dev] ${log.level}: ${log.message}`);
    out.push(p);
  }
  return out;
}

function defaultUrl(script: PreparedScript): string | null {
  return representativeMatch(script.matching)?.linkUrl ?? null;
}

function wireOutput(host: HarnessHost, page: Page, out: (line: string) => void): void {
  host.on('start', (r: StartReport) => out(`[sm-dev] ${r.name} started on ${r.url}`));
  host.on('skip', (r: SkipReport) => out(`[sm-dev] ${r.name} skipped on ${r.url}: ${r.reason}`));
  host.on('script-error', (r: ErrorReport) => {
    out(`[sm-dev] ${r.name} threw: ${r.message}`);
    if (r.stack) for (const line of r.stack.split('\n').slice(1, 4)) out(`    ${line.trim()}`);
  });
  host.on('log', (r) => out(`[sm-dev] ${r.name} GM_log: ${r.message}`));
  host.on('request', (r) => out(`[sm-dev] GM_xmlhttpRequest ${r.method} ${r.url}: ${r.outcome}${r.status ? ' ' + r.status : ''}${r.error ? ' ' + r.error : ''}`));
  host.on('tab', (r) => out(`[sm-dev] GM_openInTab ${r.url}`));
  host.on('menu-command', (r) => out(`[sm-dev] GM_registerMenuCommand "${r.name}"`));
  host.on('notification', (r) => out(`[sm-dev] GM_notification "${r.title || r.text}"`));
  host.on('download', (r) => out(`[sm-dev] GM_download ${r.url}: ${r.outcome}${r.filename ? ' -> ' + r.filename : ''}${r.error ? ' ' + r.error : ''}`));
  host.on('value-write', ({ writes }) => {
    for (const w of writes) {
      out(w.deleted
        ? `[sm-dev] GM_deleteValue ${w.key}`
        : `[sm-dev] GM_setValue ${w.key} = ${JSON.stringify(w.value)}`);
    }
  });
  page.on('console', (msg) => {
    const text = msg.text();
    // The prelude's own lines duplicate the reports printed above.
    if (text.startsWith('[SourceMonkey]')) return;
    // A userscript's console output comes from a `sourcemonkey://`
    // source (the entries' sourceURL), which is how it is told from the
    // page's own chatter. `[name]`-prefixed lines and errors pass too,
    // for a script that logs through a page-world helper.
    const fromScript = msg.location().url.startsWith('sourcemonkey://');
    if (fromScript || /^\[[^\]]+\]/.test(text) || msg.type() === 'error') out(`[page ${msg.type()}] ${text}`);
  });
  page.on('pageerror', (err) => out(`[page error] ${err.message}`));
}

// Re-prepare and re-inject on any change to a script or a file it
// loads, then reload so the new version runs. Debounced: an editor
// save is often two writes. The parent directories are watched rather
// than the files, because an editor that saves by writing a temp file
// and renaming it over the original leaves a per-file watch on the old
// inode, silent from the first save on.
function watchFiles(
  opts: RunOptions,
  prepared: PreparedScript[],
  attachment: PageAttachment,
  page: Page,
  injectAll: (scripts: PreparedScript[]) => Promise<void>,
): () => void {
  const files = new Set<string>();
  for (const p of prepared) {
    if (p.script.fileUrl.startsWith('file:')) files.add(fileURLToPath(p.script.fileUrl));
    for (const r of p.requires) {
      if (r.localUrl?.startsWith('file:')) files.add(fileURLToPath(r.localUrl));
    }
  }
  const dirs = new Map<string, Set<string>>();
  for (const file of files) {
    const dir = path.dirname(file);
    if (!dirs.has(dir)) dirs.set(dir, new Set());
    dirs.get(dir)!.add(path.basename(file));
  }
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      (async () => {
        opts.out('[sm-dev] change detected, re-injecting');
        const next = await prepareAll(opts);
        if (!next || stopped) return;
        for (const old of attachment.injectedScripts()) await attachment.remove(old.spec!.id);
        await injectAll(next);
        await page.reload();
      })().catch((err) => opts.out(`[sm-dev] re-inject failed: ${(err as Error).message}`));
    }, 150);
  };
  const watchers = [...dirs].map(([dir, names]) => watch(dir, (_event, name) => {
    if (typeof name === 'string' && names.has(name)) trigger();
  }));
  opts.out(`[sm-dev] watching ${files.size} file(s); Ctrl-C to stop`);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
