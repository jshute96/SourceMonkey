// `sm-dev run`: the interactive loop. Connect to a browser, inject one
// or more scripts from disk, load the page, and stream what happens
// until interrupted.
//
// Kept apart from cli.ts so the Node-only commands (`validate`,
// `match`) never load Playwright, which is an optional peer dependency.

import { watch } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { representativeMatch } from '../match-targets.js';
import { DialogTracker, readConsoleCommands } from './console-commands.js';
import { ExtensionBackend, type LogEntry } from './extension-backend.js';
import { HarnessHost, type ErrorReport, type SkipReport, type StartReport } from './host.js';
import { attachPage, type PageAttachment } from './inject.js';
import { prepareScript, type PreparedScript } from './prepare.js';

export interface RunOptions extends ConnectOptions {
  files: string[];
  /** The page to open. Defaults to the first URL the first script's `@match` implies. */
  url?: string;
  /** Re-inject and reload whenever a script or one of its files changes. */
  watch?: boolean;
  /** Seed `GM_*` storage for every script before it runs. */
  values?: Record<string, unknown>;
  /** Fire this registered menu command once the page has loaded. */
  fireMenu?: string;
  /**
   * Use the real extension in the browser: the script is pushed into
   * its Scratch collection as text rather than injected by the harness.
   */
  extension?: boolean;
  /** With `extension`: disable every other collection for the run. */
  solo?: boolean;
  collectionRoot: string;
  localRoots: string[];
  /** Where the stream goes. */
  out: (line: string) => void;
  /** Resolves when the run should end (Ctrl-C). Omit to return after the first load. */
  until?: Promise<void>;
  /** Called when a typed `quit` asks for the run to end. */
  onStop?: () => void;
}

// How the browser commands reach a browser: connect to one over CDP
// (the default, for the developer's own logged-in browser) or launch
// a fresh Chromium.
export interface ConnectOptions {
  cdp?: string;
  launch?: boolean;
  headed?: boolean;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /**
   * End the session: a launched browser is closed; a connected one is
   * only disconnected, and its tabs, this page included, stay open.
   */
  done(): Promise<void>;
}

/**
 * `reuseTab`: in a connected browser, take over the selected tab when
 * it is one an earlier, finished `run` opened, rather than opening
 * another. See `openRunTab`.
 */
export async function connectBrowser(
  opts: ConnectOptions,
  out: (line: string) => void,
  { reuseTab = false } = {},
): Promise<BrowserSession | null> {
  const { chromium } = await import('@playwright/test');
  let browser: Browser;
  let endpoint: string | null = null;
  if (opts.launch) {
    browser = await chromium.launch({ headless: !opts.headed });
  } else {
    endpoint = opts.cdp ?? process.env.SM_DEV_CDP ?? 'http://127.0.0.1:9233';
    try {
      // `noDefaults` keeps Playwright's test-friendly overrides off the
      // developer's own profile: downloads rerouted to a temp folder
      // that is deleted on disconnect, every tab reporting focus, and
      // a forced light color scheme. The script should see the browser
      // as its user would. A Playwright older than the option ignores
      // it and keeps the overrides.
      browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    } catch (err) {
      out(`Could not connect to a browser at ${endpoint}: ${(err as Error).message}`);
      out('Start one with a remote-debugging port, pass --cdp, or use --launch');
      return null;
    }
  }
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = reuseTab && endpoint !== null
    ? await openRunTab(browser, context, endpoint, out).catch(() => context.newPage())
    : await context.newPage();
  return {
    browser,
    context,
    page,
    // On a connected browser `close()` only drops the connection; the
    // browser and its tabs stay as they are.
    done: () => browser.close(),
  };
}

// ---------- Reusing a run's tab ----------

// The tabs `run` has opened, across runs, so a later one can recognize
// them: a tab carries no mark of its own that a page couldn't also set.
// Keyed by endpoint and the tab's CDP target id, with the pid of the
// run that owns it, since a tab whose run is still going is not free.
const RUN_TABS_FILE = path.join(os.tmpdir(), 'sm-dev-run-tabs.json');

interface RunTab {
  endpoint: string;
  /** CDP's id for the tab, not the `chrome.tabs` id an extension sees. */
  tabTargetId: string;
  pid: number;
}

/**
 * The tab for a new run: the selected tab, when an earlier run opened
 * it and has since ended, so re-running from a terminal doesn't pile up
 * tabs; otherwise a new one. "Selected" is the tab showing in its
 * window: the terminal has the focus, so no tab would count as
 * focused. Records the tab for the next run either way.
 */
async function openRunTab(
  browser: Browser,
  context: BrowserContext,
  endpoint: string,
  out: (line: string) => void,
): Promise<Page> {
  const records = await readRunTabs();
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  await cdp.detach();
  const live = new Set(targetInfos.filter((t) => t.type === 'page').map((t) => t.targetId));
  const free = new Set(records
    .filter((r) => r.endpoint === endpoint && live.has(r.tabTargetId) && !processAlive(r.pid))
    .map((r) => r.tabTargetId));
  let page: Page | null = null;
  // Only when one could be free, since reading a page's target id
  // means a protocol session per tab.
  if (free.size > 0) {
    for (const candidate of context.pages()) {
      const id = await targetIdOf(candidate).catch(() => null);
      if (id && free.has(id) && await isSelected(candidate)) {
        page = candidate;
        break;
      }
    }
  }
  if (page) out('[sm-dev] Reusing the selected tab, which an earlier run opened');
  page ??= await context.newPage();
  const id = await targetIdOf(page);
  // Re-read just before writing, so a parallel run's entry written
  // meanwhile survives. Two runs on one browser starting at the same
  // moment could still both take the same free tab; that is left as
  // too rare to lock against.
  const latest = await readRunTabs();
  // Drops this browser's closed tabs. Another browser's entries are
  // left as they are: a parallel session may be using that browser, and
  // its tabs can't be checked from here.
  const kept = latest.filter((r) => r.endpoint !== endpoint || (live.has(r.tabTargetId) && r.tabTargetId !== id));
  kept.push({ endpoint, tabTargetId: id, pid: process.pid });
  await writeRunTabs(kept).catch(() => undefined);
  return page;
}

// Written whole and renamed into place, so a run reading it meanwhile
// never sees half a file, which it would take for an empty one and
// then write back over everyone's entries.
async function writeRunTabs(tabs: RunTab[]): Promise<void> {
  // One tab per line, for someone reading the file.
  const text = `[\n${tabs.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n`;
  const temp = `${RUN_TABS_FILE}.${process.pid}`;
  await writeFile(temp, text);
  await rename(temp, RUN_TABS_FILE);
}

async function readRunTabs(): Promise<RunTab[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(RUN_TABS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed as RunTab[] : [];
  } catch {
    return [];
  }
}

async function targetIdOf(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

// Every window's showing tab counts, so with several windows open the
// first free one found wins. A page blocked on a dialog never answers,
// hence the time limit.
async function isSelected(page: Page): Promise<boolean> {
  const visible = page.evaluate(() => document.visibilityState === 'visible').catch(() => false);
  const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 1000).unref());
  return Promise.race([visible, timeout]);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, under another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const NO_URL = 'No --url given, and the first script\'s @match names no page to open';

export async function run(opts: RunOptions): Promise<number> {
  const session = await connectBrowser(opts, opts.out, { reuseTab: true });
  if (!session) return 1;
  const held: { attachment?: PageAttachment } = {};
  try {
    return opts.extension ? await runInExtension(opts, session) : await runInHarness(opts, session, held);
  } finally {
    // Also on a throw partway through, so a failed run leaves no
    // attachment behind in a browser the developer keeps using.
    await held.attachment?.dispose().catch(() => undefined);
    await session.done().catch(() => undefined);
  }
}

async function runInHarness(
  opts: RunOptions,
  session: BrowserSession,
  held: { attachment?: PageAttachment },
): Promise<number> {
  const { page } = session;
  const host = new HarnessHost();
  wireOutput(host, page, opts.out);
  const dialogs = await DialogTracker.attach(page, opts.out, {
    visible: browserVisible(opts),
    // Commands are only read once the page has loaded, but a prompt
    // opened before then can still wait for a typed accept.
    commandsComing: opts.until !== undefined && process.stdin.readable,
  });
  // Attached before preparing, so the scripts' GM_info describes this
  // browser.
  const attachment = await attachPage(page, host);
  held.attachment = attachment;
  const prepared = await prepareAll(opts);
  if (!prepared) return 1;
  const url = opts.url ?? defaultUrl(prepared[0]);
  if (!url) {
    opts.out(NO_URL);
    return 2;
  }

  const injectAll = async (scripts: PreparedScript[]): Promise<void> => {
    for (const script of scripts) {
      await attachment.inject(script);
      opts.out(`[sm-dev] Injected ${script.script.relativePath} in world ${script.world}, run-at ${script.runAt}`);
    }
  };
  // Seeded once. A watch re-inject keeps the store, so values the
  // script wrote since the last save survive the save.
  if (opts.values) for (const script of prepared) host.seedValues(script.spec!.id, opts.values);
  await injectAll(prepared);
  opts.out(`[sm-dev] Opening ${url}`);
  await page.goto(url).catch((err) => opts.out(`[sm-dev] Navigation failed: ${(err as Error).message}`));
  if (opts.fireMenu) {
    // Registered from the script's body, so it exists once the script
    // has started; a short grace period covers a late registration.
    const name = opts.fireMenu;
    const deadline = Date.now() + 5000;
    let fired = false;
    while (!fired && Date.now() < deadline) {
      // Only once it is registered, so an unrelated dialog opening
      // meanwhile can't pass for this command's.
      const registered = host.reports.menuCommands.some((m) => m.name === name || m.commandId === name);
      // Done once a dialog it opens is up: the page waits on that.
      fired = registered && await dialogs.untilDialog(host.fireMenuCommand(name));
      if (!fired) await page.waitForTimeout(100);
    }
    opts.out(fired ? `[sm-dev] Fired menu command "${name}"` : `[sm-dev] No menu command named "${name}" was registered`);
  }

  let watcher: (() => void) | null = null;
  let stopCommands: (() => void) | null = null;
  try {
    if (opts.watch) watcher = watchFiles(opts, prepared, attachment, page, injectAll);
    if (opts.until) {
      // Typed commands drive the script while it runs: fire a menu
      // command again, read what it stored, write a value back. Only
      // worth arming for a run that is waiting on something.
      //
      // Armed once the script has started (or shortly after, if it
      // never does): a command read before then would run against a
      // page whose script has not registered anything yet. A piped
      // sequence of commands would otherwise hit exactly that.
      await waitForFirstStart(host);
      stopCommands = readConsoleCommands({
        host,
        page,
        scripts: prepared,
        dialogs,
        out: opts.out,
        stop: () => opts.onStop?.(),
      });
      await opts.until;
    } else {
      // One load's worth of output, then leave the page as it is.
      await page.waitForTimeout(500);
    }
  } finally {
    // Also on a throw, or stdin and the file watcher would keep the
    // process alive.
    stopCommands?.();
    watcher?.();
  }
  return host.reports.errors.length === 0 ? 0 : 1;
}

// The extension backend: push the files' text into SourceMonkey and
// read its Log tab, instead of preparing and injecting. `prepareAll`
// still runs first so a header or syntax problem is reported here with
// the same wording, before anything reaches the extension.
async function runInExtension(opts: RunOptions, session: BrowserSession): Promise<number> {
  const { context, page } = session;
  let backend: ExtensionBackend;
  try {
    backend = await ExtensionBackend.connect(context);
  } catch (err) {
    opts.out(`[sm-dev] ${(err as Error).message}`);
    return 1;
  }
  const prepared = await prepareAll(opts);
  if (!prepared) return 1;
  const url = opts.url ?? defaultUrl(prepared[0]);
  if (!url) {
    opts.out(NO_URL);
    return 2;
  }
  if (opts.values) opts.out('[sm-dev] The --values flag is ignored with --extension, since the extension keeps its own storage');
  if (opts.fireMenu) opts.out('[sm-dev] The --fire-menu flag is ignored with --extension. Use the toolbar menu in the browser.');
  const pushed = new Map<string, string>();
  // The extension's per-script log is the report stream here; it is
  // polled, since nothing pushes it to Node. Only what this run adds is
  // printed, so each script's last printed entry is remembered rather
  // than a count: the log rotates at a cap, and a count would go quiet
  // once it did.
  const lastPrinted = new Map<string, LogEntry | null>();
  let errors = 0;
  const pushAll = async (scripts: PreparedScript[]): Promise<boolean> => {
    for (const script of scripts) {
      const text = await readFile(fileURLToPath(script.script.fileUrl), 'utf8');
      const result = await backend.push(text, path.basename(script.script.relativePath));
      if (result.status !== 'ok') {
        opts.out(`INVALID  ${script.script.relativePath}\n    ${result.errorMessage ?? ''}`);
        return false;
      }
      pushed.set(result.scriptId, script.script.relativePath);
      const entries = await backend.log(result.scriptId).catch(() => [] as LogEntry[]);
      lastPrinted.set(result.scriptId, entries[entries.length - 1] ?? null);
      opts.out(`[sm-dev] Pushed to Scratch: ${script.script.relativePath}${result.replaced ? ' (replaced)' : ''}`);
    }
    return true;
  };
  let polling = false;
  const poll = async (): Promise<void> => {
    // One poll at a time: an overlapping pair would print the same
    // entries twice.
    if (polling) return;
    polling = true;
    try {
      for (const [scriptId, name] of pushed) {
        const entries = await backend.log(scriptId).catch(() => [] as LogEntry[]);
        const last = lastPrinted.get(scriptId) ?? null;
        let at = -1;
        if (last) {
          for (let i = entries.length - 1; i >= 0; i--) {
            if (sameEntry(entries[i], last)) {
              at = i;
              break;
            }
          }
        }
        for (const entry of entries.slice(at + 1)) {
          if (entry.level === 'error') errors++;
          opts.out(`[sm-dev] ${name} ${entry.level}: ${entry.message}`);
        }
        if (entries.length > 0) lastPrinted.set(scriptId, entries[entries.length - 1]);
      }
    } finally {
      polling = false;
    }
  };
  try {
    // Inside the try, so a solo switch that fails partway is still
    // switched back.
    if (opts.solo) await backend.solo(true);
    if (!(await pushAll(prepared))) return 1;
    wirePageOutput(page, opts.out);
    await DialogTracker.attach(page, opts.out, { visible: browserVisible(opts) });
    opts.out(`[sm-dev] Opening ${url}`);
    await page.goto(url).catch((err) => opts.out(`[sm-dev] Navigation failed: ${(err as Error).message}`));
    let watcher: (() => void) | null = null;
    if (opts.watch) {
      watcher = watchFiles(opts, prepared, null, page, async (next) => {
        if (await pushAll(next)) await page.reload().catch(() => undefined);
      });
    }
    const ticker = setInterval(() => { void poll(); }, 500);
    try {
      if (opts.until) await opts.until;
      else await page.waitForTimeout(1000);
    } finally {
      clearInterval(ticker);
      watcher?.();
    }
    while (polling) await new Promise((r) => setTimeout(r, 50));
    await poll();
  } finally {
    if (opts.solo) await backend.solo(false).catch(() => undefined);
  }
  return errors === 0 ? 0 : 1;
}

// Resolve when some script has reported that it started, or after a
// grace period when none does (a URL its header does not cover, a
// script that threw before reporting).
async function waitForFirstStart(host: HarnessHost, timeoutMs = 5000): Promise<void> {
  if (host.reports.started.length > 0) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      host.off('start', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    host.on('start', done);
  });
}

// Whether a person can see the browser, and so answer its dialogs.
function browserVisible(opts: ConnectOptions): boolean {
  return !opts.launch || opts.headed === true;
}

function sameEntry(a: LogEntry, b: LogEntry): boolean {
  return a.timestamp === b.timestamp && a.message === b.message && a.source === b.source;
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
  wireHostOutput(host, out);
  wirePageOutput(page, out);
}

function wireHostOutput(host: HarnessHost, out: (line: string) => void): void {
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
}

function wirePageOutput(page: Page, out: (line: string) => void): void {
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
  attachment: PageAttachment | null,
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
        opts.out(attachment ? '[sm-dev] Change detected, re-injecting' : '[sm-dev] Change detected, re-pushing');
        const next = await prepareAll(opts);
        if (!next || stopped) return;
        if (attachment) {
          for (const old of attachment.injectedScripts()) await attachment.remove(old.spec!.id);
          await injectAll(next);
          await page.reload();
        } else {
          // Extension mode: the callback pushes and reloads itself.
          await injectAll(next);
        }
      })().catch((err) => opts.out(`[sm-dev] Re-inject failed: ${(err as Error).message}`));
    }, 150);
  };
  const watchers = [...dirs].map(([dir, names]) => watch(dir, (_event, name) => {
    if (typeof name === 'string' && names.has(name)) trigger();
  }));
  opts.out(`[sm-dev] Watching ${files.size} file(s). Press Ctrl-C to stop.`);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
