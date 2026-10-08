// `sm-dev start`'s run: connect to a browser, push one or more scripts
// from disk into SourceMonkey there, load the page, and log what
// happens, taking commands from clients over its socket until stopped.
//
// Kept apart from cli.ts so the Node-only commands (`validate`,
// `match`) never load Playwright, which is an optional peer dependency.

import { watch, type FSWatcher } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, BrowserContext, ConsoleMessage, Page } from '@playwright/test';

import { shellWord } from './command-lines.js';
import {
  commandOutput, commandRunner, DialogTracker, gotoInTab, leaveDialogsOpen, onlyInspects, reloadTab, reloadable, serveSavedPage, setCommandsListening, skippedScriptLine, targetIdSuffix, withoutQuery,
  type CommandRunner, type ConsoleContext, type ControlledTab,
} from './console-commands.js';
import { applyLang, langLaunchArgs } from './browser-lang.js';
import { watchDownloads, type DownloadWatch } from './download-watch.js';
import { managerState, managersIn, otherManagersWarning, stateLabel, type ManagerState } from './browser-extensions.js';
import { ExtensionHost } from './extension-host.js';
import { launchExtensionBrowser } from './extension-launch.js';
import { fetchManager, fetchedVersion } from './manager-fetch.js';
import { DEFAULT_MANAGER, MANAGERS, managerFlag, type ManagerName } from './managers.js';
import { ExtensionLink, linkRunId, type ExtensionEvent } from './extension-link.js';
import { ExternalRunScripts, externalControl, externalOff, externalOthers, openExternalManager, type ExternalManager } from './external-manager.js';
import type { ErrorReport, ManualReport, PageLink, SkipReport, StartReport } from './host.js';
import { attachPage, targetIdOf, type AttachOptions, type PageAttachment } from './page-watch.js';
import { pageSays } from './page-commands.js';
import { consoleSource, consoleText, decodeOwnRefs, formatConsoleArgs, isPreludeLine, pageErrorSource } from './page-output.js';
import {
  defaultPageUrl, explainMatch, isDirectoryMessage, NO_DEFAULT_PAGE, noSuchFileMessage, preparedScriptPath, prepareScript, pushedFiles, shownPath, warningLines, type PreparedScript,
} from './prepare.js';
import { DEFAULT_LOG_SOURCES, inSources, RunLog, streamText, type LogFields, type LogSource } from './run-logs.js';
import { runDownloadsDir } from './run-log.js';
import { comparableUrl, openingSavedLine, type SavedPageStart } from './saved-pages.js';
import { browserSentence, checkRunsDir, ownRunsDir, processAlive, RunControl, runTabsPath, type RunRecord, type SentCommand, type SentLineHandler } from './runs.js';
import { cspBlocksPageScripts, sandboxedPageWarning } from '../sandboxed-page.js';
import { waitForStuckTabs } from './stuck-tabs.js';
import { NO_TABS } from './tab-refs.js';
import { loadPage, settleTabs } from './wait.js';

export interface RunOptions extends ConnectOptions {
  files: string[];
  /** `files` as they were typed, in the same order, for errors to name them so. */
  given?: string[];
  /**
   * Each file's name as typed, `given` and those `load` adds: a file
   * that won't prepare is named as the person named it.
   */
  typed?: Map<string, string>;
  /**
   * The pages to open, one tab each. Defaults to the first URL the first
   * script's `@match` implies.
   */
  urls?: string[];
  /**
   * `--from-saved`: for each of `urls`, the saved page its tab serves
   * there, or null for a live one.
   */
  saved?: (SavedPageStart | null)[];
  /**
   * Open each script's default page, one tab per distinct page, rather
   * than one page for the first script.
   */
  all?: boolean;
  /**
   * Open no tab at startup. The typed `newtab` opens one later; tabs
   * the person opens run none of the run's scripts.
   */
  noTab?: boolean;
  /** Re-push and reload whenever a script or one of its files changes. */
  watch?: boolean;
  /** Seed `GM_*` storage for every script before it runs. */
  values?: Record<string, unknown>;
  /** The log sources the run's stream and log file show (`start --log-source`). */
  logSources?: ReadonlySet<LogSource>;
  collectionRoot: string;
  localRoots: string[];
  /** Where the stream goes. */
  out: (line: string) => void;
  /**
   * Logs a line of one of the log sources (see run-logs.ts), which the
   * stream shows when its source is one it shows. Set by `run`.
   */
  emit?: (fields: LogFields) => void;
  /** Resolves when the run should end (stop, a signal, --stop-after-seconds). Omit to return after the first load. */
  until?: Promise<void>;
  /** Called when a client's `stop` asks for the run to end. */
  onStop?: () => void;
  /** Called once the run has a browser connection, and so something to clean up. */
  onConnected?: () => void;
  /**
   * Called once the run has started: its pages loaded and scripts
   * started, and sent commands taken. With its id, or none when other
   * shells can't reach it.
   */
  onReady?: (id: string | undefined) => void;
  /**
   * Called as each sent command starts and ends, and as clients start and
   * stop following the run, for `--stop-after-idle-seconds` to count from. `watched`:
   * whether a client follows the run now, which keeps it from going idle.
   */
  onActivity?: (watched: boolean) => void;
  /** Started by `--detach`, as the run's record says, for a later `--detach` to replace. */
  detached?: boolean;
  /** The run's log file (see run-log.ts), linked by the run's id. */
  log?: string;
  /** The id `start --run` asked for, rather than the lowest free one. */
  runId?: string;
  /** The process id of the client that started the run (see commandMark). */
  primaryPid?: number;
  /** Don't wait for the tabs to settle before taking commands (`--nowait`). */
  noWait?: boolean;
  /** `start --timeout-seconds`, in ms: each first load, and the settling after. */
  timeoutMs?: number;
}

// How the browser commands reach a browser: connect to one over CDP
// (the default, for the developer's own logged-in browser) or launch
// a fresh Chromium (`--temp-browser`).
export interface ConnectOptions {
  cdp?: string;
  /**
   * `--manager`: the userscript manager the run works with, and a
   * `tempBrowser` loads. SourceMonkey when not given.
   */
  manager?: ManagerName;
  /**
   * `--temp-browser`: launch a Chromium of the run's own instead, with
   * the package's own build of SourceMonkey loaded.
   */
  tempBrowser?: boolean;
  headed?: boolean;
  /** With `tempBrowser`: whether it has sound (false), or is muted (the default). */
  muted?: boolean;
  /**
   * `--lang`: the languages the run's tabs prefer (see browser-lang.ts).
   * A `tempBrowser` is launched with them too.
   */
  lang?: string[];
  /** Resolves to give up connecting (--stop-after-seconds): ends a wait for tabs that don't answer. */
  until?: Promise<void>;
  /** The run's log file, which a `tempBrowser`'s downloads folder is named after. */
  log?: string;
}

/**
 * A `--browser` value as a URL Playwright can connect to: a port alone
 * (`9222`, `:9222`) means this machine, and a host with no scheme gets
 * `http://`. Also the key runs record their tabs under, so the port
 * and no-scheme spellings match the URL they stand for; `localhost`
 * and `127.0.0.1` still differ. An IPv6 host needs brackets
 * (`[::1]:9222`), as in a URL.
 */
export function cdpEndpoint(value: string): string {
  const v = value.trim().replace(/\/+$/, '');
  const port = /^:?(\d+)$/.exec(v);
  if (port) return `http://127.0.0.1:${port[1]}`;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`;
}

/**
 * Whether two `--browser` values name the same browser: as
 * `cdpEndpoint` writes them, with `localhost` and `[::1]` the same as
 * `127.0.0.1`.
 */
export function sameBrowser(a: string, b: string): boolean {
  const key = (value: string): string => cdpEndpoint(value.trim()).replace(/^(\w+:\/\/)(localhost|\[::1\])(?=[:/]|$)/i, '$1127.0.0.1');
  return key(a) === key(b);
}

/**
 * The browser to use: `--browser` (`given`), else $SM_DEV_BROWSER, else
 * port 9233. Empty counts as unset, so an exported-but-blank variable
 * doesn't become `http://`.
 */
export function browserSetting(given?: string): string {
  return cdpEndpoint(given?.trim() || process.env.SM_DEV_BROWSER?.trim() || '9233');
}

function cdpSetting(opts: ConnectOptions): string {
  return browserSetting(opts.cdp);
}

/**
 * ` --browser <address>`, for advice to run a command against the
 * browser at `endpoint`, unless that's where commands go anyway. Empty
 * for a launched one (`launched`), which closes with the run.
 */
export function browserArg(endpoint: string, launched = false): string {
  if (launched || sameBrowser(endpoint, browserSetting())) return '';
  return ` --browser ${endpoint.replace(/^https?:\/\//, '')}`;
}

/**
 * Where the browser setting came from, for a message about it: the
 * variable when `--browser` wasn't given. $SM_DEV_BROWSER used to name
 * the Chrome binary, so a stale one shouldn't be blamed on the flag.
 */
export function browserSettingName(given: string | undefined): string {
  return !given?.trim() && process.env.SM_DEV_BROWSER?.trim() ? '$SM_DEV_BROWSER' : '--browser';
}

export interface BrowserSession {
  browser: Browser;
  /** The browser's CDP endpoint, a launched one's too. */
  endpoint: string;
  /** Launched for this run (`--temp-browser`), and closed with it. */
  launched: boolean;
  /** Running without a window. */
  headless: boolean;
  /** Where a launched browser saves downloads. A connected one keeps its own setting. */
  downloadsDir?: string;
  context: BrowserContext;
  page: Page;
  /**
   * Lines about the tab taken, for after the line naming the browser
   * (`run`), or printed at once by `connectBrowser`.
   */
  notes: string[];
  /**
   * End the session: a launched browser is closed; a connected one is
   * only disconnected, and its tabs, this page included, stay open.
   */
  done(): Promise<void>;
}

/**
 * `runTab`: in a connected browser, open the run's tab with
 * `openRunTab`, which closes the selected tab when an earlier,
 * finished run opened it.
 */
export async function connectBrowser(
  opts: ConnectOptions,
  out: (line: string) => void,
  { runTab = false } = {},
): Promise<BrowserSession | null> {
  const session = await openBrowser(opts, out, { runTab, openTab: true });
  session?.notes.forEach(out);
  return session;
}

/**
 * The browser at `--browser` (`cdp`), with no run and no tab, for the
 * commands that only talk to SourceMonkey (`collection list`). Null,
 * having said why, when it couldn't connect.
 */
export function connectWithoutRun(cdp: string | undefined, out: (line: string) => void): Promise<Omit<BrowserSession, 'page'> | null> {
  return openBrowser({ cdp }, out, { runTab: false, openTab: false });
}

// Whether a connected browser runs without a window: its user agent
// then says HeadlessChrome. (The product name does only in the old
// headless mode, not in --headless=new.) Unknown counts as not.
async function isHeadless(browser: Browser): Promise<boolean> {
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { userAgent } = await cdp.send('Browser.getVersion');
    await cdp.detach().catch(() => undefined);
    return /\bHeadlessChrome\//.test(userAgent);
  } catch {
    return false;
  }
}

// `connectBrowser`, and for `start --notab`, the same with no tab.
async function openBrowser(
  opts: ConnectOptions, out: (line: string) => void, o: { runTab: boolean; openTab: true },
): Promise<BrowserSession | null>;
async function openBrowser(
  opts: ConnectOptions, out: (line: string) => void, o: { runTab: boolean; openTab: boolean },
): Promise<RunSession | null>;
async function openBrowser(
  opts: ConnectOptions,
  out: (line: string) => void,
  { runTab, openTab }: { runTab: boolean; openTab: boolean },
): Promise<RunSession | null> {
  const { chromium } = await import('@playwright/test');
  let browser: Browser;
  // Set for a connected browser only.
  let endpoint: string | null = null;
  // A launched one's port, which the run connects to, and other tools
  // (a debugger, a second Playwright) can too; `list` says where.
  let launchedAt: string | null = null;
  // Closes a launched browser, which the run reaches over a CDP
  // connection of its own (see extension-launch.ts).
  let closeLaunched: (() => Promise<void>) | undefined;
  let downloadsDir: string | undefined;
  if (opts.tempBrowser) {
    let launched;
    downloadsDir = runDownloadsDir(opts.log);
    const manager = opts.manager ?? DEFAULT_MANAGER;
    const { label } = MANAGERS[manager];
    try {
      // Fetched the first time it's wanted, as `manager fetch` would.
      if (manager !== 'sourcemonkey' && fetchedVersion(manager) === null) await fetchManager(manager, out);
      launched = await launchExtensionBrowser({ headed: opts.headed === true, muted: opts.muted, args: langLaunchArgs(opts.lang), connectedElsewhere: true, downloadsDir, manager });
    } catch (err) {
      out(`Could not launch a browser with ${label}: ${(err as Error).message}`);
      return null;
    }
    closeLaunched = launched.close;
    try {
      browser = await chromium.connectOverCDP(launched.endpoint);
    } catch (err) {
      await launched.close();
      out(`Could not connect to the browser launched with ${label}: ${(err as Error).message}`);
      return null;
    }
    launchedAt = launched.endpoint;
  } else {
    endpoint = cdpSetting(opts);
    try {
      // Playwright's connection waits on every tab, so a tab that
      // doesn't answer is named first, and waited for.
      if (!await waitForStuckTabs(endpoint, out, opts.until)) return null;
      // `noDefaults` keeps Playwright's test-friendly overrides off the
      // developer's own profile: downloads rerouted to a temp folder
      // that is deleted on disconnect, every tab reporting focus, and
      // a forced light color scheme. The script should see the browser
      // as its user would. A Playwright older than the option ignores
      // it and keeps the overrides.
      browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    } catch (err) {
      const message = (err as Error).message;
      if (/Timeout \d+ms exceeded/.test(message) && /<ws connected>/.test(message)) {
        // The browser answered, and the tabs' setup didn't finish: a tab
        // that stopped responding after the check, or very many tabs.
        out(`Could not connect to the browser at ${endpoint}: Connecting timed out. A tab may have stopped responding (a dialog open, or a busy page), or the browser has very many tabs. Run again to check the tabs.`);
        return null;
      }
      const from = browserSettingName(opts.cdp) === '$SM_DEV_BROWSER' ? ' (from $SM_DEV_BROWSER)' : '';
      out(`Could not connect to a browser at ${endpoint}${from}: ${message}`);
      out('Start one with sm-dev --open-browser, pass --browser, or use --temp-browser');
      return null;
    }
  }
  const context = browser.contexts()[0] ?? await browser.newContext();
  if (endpoint !== null) browser.contexts().forEach(leaveDialogsOpen);
  const notes: string[] = [];
  const page = !openTab ? null
    // The one blank tab a launch leaves for the run.
    : closeLaunched ? context.pages()[0] ?? await context.newPage()
    : runTab && endpoint !== null
      ? await openRunTab(browser, context, endpoint, (line) => notes.push(line)).catch(() => context.newPage())
      : await context.newPage();
  return {
    browser,
    endpoint: endpoint ?? launchedAt!,
    launched: endpoint === null,
    headless: endpoint === null ? !opts.headed : await isHeadless(browser),
    ...(downloadsDir ? { downloadsDir } : {}),
    context,
    page,
    notes,
    // On a connected browser `close()` only drops the connection; the
    // browser and its tabs stay as they are.
    done: async () => {
      try {
        await browser.close();
      } finally {
        await closeLaunched?.();
      }
    },
  };
}

/** A script `apply` puts in place: `old` is absent for a `load`. */
interface ScriptChange {
  old?: PreparedScript;
  next: PreparedScript;
}

/** A `start` session, whose `--notab` form has no tab. */
type RunSession = Omit<BrowserSession, 'page'> & { page: Page | null };

// ---------- A run's tab ----------

// The tabs runs have opened, so a later one can recognize
// them: a tab carries no mark of its own that a page couldn't also set.
// Keyed by endpoint and the tab's CDP target id, with the pid of the
// run that owns it, since a tab whose run is still going is not free.
// Kept in `runTabsPath()`, beside the runs' records, private to the user.
interface RunTab {
  endpoint: string;
  /** CDP's id for the tab, not the `chrome.tabs` id an extension sees. */
  tabTargetId: string;
  pid: number;
  /** The run's name, once it has one (`nameRunTab`), for the next run's "Closed" line. */
  run?: string;
}

/**
 * The tab for a new run: always a new one, so the run starts on a clean
 * page. The selected tab is closed when an earlier run opened it and
 * has since ended, so re-running from a terminal doesn't pile up tabs.
 * "Selected" is the tab showing in its window: the terminal has the
 * focus, so no tab would count as focused. Records the tab for the
 * next run.
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
  let old: Page | null = null;
  // Only when one could be free, since reading a page's target id
  // means a protocol session per tab.
  if (free.size > 0) {
    for (const candidate of context.pages()) {
      const id = await targetIdOf(candidate);
      if (id && free.has(id) && await isSelected(candidate)) {
        old = candidate;
        break;
      }
    }
  }
  const page = await context.newPage();
  // Closed only when the new tab opened in its window, so the window
  // isn't left empty (and closed with it). With several windows, the
  // new tab opens in the last focused one, which may be another.
  if (old && await sameWindow(browser, old, page)) {
    const oldId = await targetIdOf(old);
    const opener = records.find((r) => r.endpoint === endpoint && r.tabTargetId === oldId)?.run;
    const url = old.url();
    // Without its unload handlers, which could open a "leave site?"
    // prompt nobody is there to answer.
    await old.close({ runBeforeUnload: false }).then(
      () => out(`[sm-dev] Closed the selected tab (${url}), which ${opener ? `run ${opener}` : 'an earlier run'} opened. That run has ended.`),
      () => undefined,
    );
  }
  const id = await targetIdOf(page);
  if (!id) return page;
  // Re-read just before writing, so a parallel run's entry written
  // meanwhile survives.
  const latest = await readRunTabs();
  // Drops this browser's closed tabs. Another browser's entries are
  // left as they are: a parallel session may be using that browser, and
  // its tabs can't be checked from here.
  const kept = latest.filter((r) => r.endpoint !== endpoint || (live.has(r.tabTargetId) && r.tabTargetId !== id));
  kept.push({ endpoint, tabTargetId: id, pid: process.pid });
  await writeRunTabs(kept).catch(() => undefined);
  return page;
}

// Whether two tabs are in one window. False when that can't be told.
async function sameWindow(browser: Browser, a: Page, b: Page): Promise<boolean> {
  const [idA, idB] = await Promise.all([targetIdOf(a), targetIdOf(b)]);
  if (!idA || !idB) return false;
  const cdp = await browser.newBrowserCDPSession();
  try {
    const [winA, winB] = await Promise.all([idA, idB].map((targetId) => cdp.send('Browser.getWindowForTarget', { targetId })));
    return winA.windowId === winB.windowId;
  } catch {
    return false;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

// The run's name on the tab `openRunTab` recorded for it, which it
// gets only once the run is open, after the tab was opened.
async function nameRunTab(endpoint: string, page: Page, run: string): Promise<void> {
  const id = await targetIdOf(page);
  if (!id) return;
  const tabs = await readRunTabs();
  const mine = tabs.find((r) => r.endpoint === endpoint && r.tabTargetId === id && r.pid === process.pid);
  if (!mine) return;
  mine.run = run;
  await writeRunTabs(tabs).catch(() => undefined);
}

// Written whole and renamed into place, so a run reading it meanwhile
// never sees half a file, which it would take for an empty one and
// then write back over everyone's entries.
async function writeRunTabs(tabs: RunTab[]): Promise<void> {
  // One tab per line, for someone reading the file.
  const text = `[\n${tabs.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n`;
  const file = runTabsPath();
  await ownRunsDir();
  const temp = `${file}.${process.pid}`;
  await writeFile(temp, text);
  await rename(temp, file);
}

async function readRunTabs(): Promise<RunTab[]> {
  try {
    // Not trusted from a directory another user could write in.
    if (!await checkRunsDir()) return [];
    const parsed: unknown = JSON.parse(await readFile(runTabsPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed as RunTab[] : [];
  } catch {
    return [];
  }
}

// Every window's showing tab counts, so with several windows open the
// first free one found wins. A page blocked on a dialog never answers,
// hence the time limit.
function isSelected(page: Page): Promise<boolean> {
  return pageSays(page, () => document.visibilityState === 'visible');
}

const NO_URL = 'No URL was given, and the first script\'s @match names no page to open. Give a URL.';
const NO_URL_ALL = 'None of the scripts\' @match names a page to open. Give a URL instead of --all.';

// The pages a run opens: the URLs given, or the first script's default page,
// or with `--all` each script's, once per distinct page. Null, with
// the reason printed, when there is none.
interface StartPages {
  urls: string[];
  /** For each of `urls`, the saved page served there, or null. */
  saved: (SavedPageStart | null)[];
  /** Whether the URLs were given, rather than the scripts' own pages. */
  given?: boolean;
  /** Scripts `--all` found no page for, printed once the rest are open. */
  skipped: { n: number; script: PreparedScript; reason: string }[];
}

function startPages(opts: RunOptions, prepared: PreparedScript[]): StartPages | null {
  if (opts.noTab) return { urls: [], saved: [], skipped: [] };
  // Each page once. Two saved files can be served at one URL, in a tab each.
  const pairs = new Map<string, { url: string; saved: SavedPageStart | null }>();
  (opts.urls ?? []).forEach((url, i) => {
    const saved = opts.saved?.[i] ?? null;
    pairs.set(`${url}\n${saved?.file ?? ''}`, { url, saved });
  });
  const given: StartPages = { urls: [...pairs.values()].map((p) => p.url), saved: [...pairs.values()].map((p) => p.saved), given: true, skipped: [] };
  // No scripts: the tab as it opened, blank, unless URLs are given.
  if (prepared.length === 0) return given;
  if (!opts.all) {
    if (given.urls.length > 0) return given;
    const url = defaultPageUrl(prepared[0]);
    if (!url) opts.out(NO_URL);
    return url ? { urls: [url], saved: [null], skipped: [] } : null;
  }
  const urls = new Set<string>();
  const skipped: StartPages['skipped'] = [];
  prepared.forEach((script, i) => {
    const url = defaultPageUrl(script);
    if (url) urls.add(url);
    else skipped.push({ n: i + 1, script, reason: NO_DEFAULT_PAGE });
  });
  if (urls.size === 0) {
    opts.out(NO_URL_ALL);
    return null;
  }
  return { urls: [...urls], saved: [...urls].map(() => null), skipped };
}

// A page whose tab failed to open. A URL that was given is named; a
// script's own page (`--all`) is reported as every script it was for.
function tabFailed(opts: RunOptions, start: StartPages, prepared: PreparedScript[], url: string, err: Error): void {
  if (start.given) {
    opts.out(`[sm-dev] The tab for ${url} could not be opened: ${err.message}`);
    return;
  }
  const reason = `The tab could not be opened: ${err.message}`;
  prepared.forEach((script, i) => {
    if (defaultPageUrl(script) === url) start.skipped.push({ n: i + 1, script, reason });
  });
}

function printSkipped(opts: RunOptions, start: StartPages): void {
  for (const s of [...start.skipped].sort((a, b) => a.n - b.n)) opts.out(skippedScriptLine(s.n, s.script, s.reason));
}

export async function run(opts: RunOptions): Promise<number> {
  const remote = new Remote(opts.out, opts.logSources ?? DEFAULT_LOG_SOURCES, opts.onStop, opts.onActivity, opts.primaryPid);
  // Every line also goes to whoever sent the command running now.
  opts = { ...opts, out: remote.out, emit: remote.emit, typed: new Map(opts.files.map((file, i) => [file, opts.given?.[i] ?? file])) };
  const session = await openBrowser(opts, opts.out, { runTab: true, openTab: !opts.noTab });
  if (!session) return 1;
  // Which browser, for the stream and the log.
  const browserIs = { browser: session.endpoint, owned: session.launched, headless: session.headless };
  const manager = opts.manager ?? DEFAULT_MANAGER;
  const managers = await managersIn(session.endpoint);
  const state = managers ? managerState(managers, manager) : null;
  const extension = state ? stateLabel(state, manager) : '';
  opts.out(`[sm-dev] ${capitalized(browserSentence(browserIs, session.launched ? 'launched' : 'connected to'))} (Chrome ${session.browser.version()}${extension ? `, ${extension}` : ''})`);
  for (const line of otherManagersWarning(managers ?? [], manager, browserArg(session.endpoint, session.launched))) opts.out(`[sm-dev] ${line}`);
  session.notes.forEach(opts.out);
  opts.onConnected?.();
  // Only a run that waits for commands can be sent any.
  if (opts.until) {
    await remote.open({
      pid: process.pid,
      started: remote.startedAt,
      browser: session.endpoint,
      ...(session.launched ? { owned: true } : {}),
      ...(session.headless ? { headless: true } : {}),
      scripts: opts.files,
      ...(manager !== DEFAULT_MANAGER ? { manager } : {}),
      ...(opts.detached ? { detached: true } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    }, opts.runId);
    if (remote.id && session.page && !session.launched) await nameRunTab(session.endpoint, session.page, remote.id).catch(() => undefined);
  }
  // The browser closing (or its connection dropping) ends the run: it
  // has nothing left to stream from. Without this the run would wait
  // on with nothing keeping Node alive, and quit without its last line.
  let ending = false;
  session.browser.on('disconnected', () => {
    if (ending) return;
    opts.out('[sm-dev] The browser closed, or its connection dropped');
    opts.onStop?.();
  });
  const held: Held = {};
  try {
    return await runInBrowser(opts, session, held, remote, state);
  } finally {
    ending = true;
    // No sent command runs against tabs being let go.
    remote.disarm();
    // Also on a throw partway through, so a failed run leaves no
    // attachment behind in a browser the developer keeps using.
    await held.downloads?.stop();
    await held.tabs?.dispose().catch(() => undefined);
    await held.attachment?.dispose().catch(() => undefined);
    // Its tabs run the extension's scripts again from their next load,
    // and the extension removes its test collection.
    await held.extension?.close();
    if (held.external) {
      // Not from a browser that's gone: a throwaway one takes them with
      // it, and the next run in a person's own removes them as it starts.
      if (!session.launched && session.browser.isConnected()) {
        await held.external.scripts.removeAll().catch((err) => opts.out(`[sm-dev] The run's scripts could not be removed from ${held.external!.manager.label}: ${(err as Error).message}`));
      }
      await held.external.manager.close().catch(() => undefined);
    }
    await session.done().catch(() => undefined);
    // On every way out, so a page tested after this is never taken
    // for one the run still controls. Its registrations are gone, but
    // script code already running in an open page runs on.
    const run = remote.id ? `Run ${remote.id}` : 'The run';
    opts.out(`[sm-dev] ${run} ended`);
    await remote.close();
  }
}

/**
 * How a sent command is headed in the log and to the clients following
 * the run: who sent it (`primary`, the client that started the run, or
 * `remote`, any other) and how it got it (`arg`, `stdin`, `prompt`), as
 * `primary:arg >`. A client heads its own without the who.
 */
export function commandMark(sent: Pick<SentCommand, 'pid' | 'source'>, primaryPid: number | undefined): string {
  const who = sent.pid !== undefined && sent.pid === primaryPid ? 'primary' : 'remote';
  return `${who}:${sent.source} >`;
}

/**
 * A run's side of `sm-dev <command>` and `sm-dev stop`: runs each sent line
 * as a typed command, and answers the sender with the output while it
 * runs. Done when the command is: each command waits out what it sets
 * off that has an end, such as the scripts starting after a reload.
 * A command that only inspects answers the sender alone; one that
 * changes things also shows in the run's stream, with what the page and
 * scripts print meanwhile. Lines arriving before the run is ready for
 * commands wait.
 */
class Remote {
  private control: RunControl | null = null;
  private runner: CommandRunner | null = null;
  private ending = false;
  private ready!: () => void;
  private readonly armed = new Promise<void>((resolve) => { this.ready = resolve; });
  // Who gets the stream, each with the log sources it shows; undefined
  // for the run's own.
  private readonly listeners = new Map<(line: string) => void, ReadonlySet<LogSource> | undefined>();
  /** The run's log lines, for `logs` and `wait log`. */
  readonly logs = new RunLog();
  /** When the run started, in epoch ms, as its record says. */
  readonly startedAt = Date.now();

  // The run's stream is its log, and every command comes from a
  // client, so a command that changes something is marked there as
  // `> command`, for where it happened among what the page printed.
  // `sources`: the log sources the log file shows, and the clients
  // that didn't ask for others. `primaryPid`: the client that started
  // the run, whose commands are marked as the primary's.
  constructor(
    private readonly print: (line: string) => void,
    private readonly sources: ReadonlySet<LogSource>,
    private readonly onStop?: () => void,
    private readonly onActivity?: (watched: boolean) => void,
    private readonly primaryPid?: number,
  ) {}

  /**
   * Prints a line, and copies it to the senders listening now. An
   * inspecting sent command's own lines go to its sender alone.
   */
  readonly out = (line: string): void => {
    const answer = commandOutput.getStore();
    if (answer?.live) {
      answer.line(line);
      return;
    }
    this.print(line);
    for (const listener of this.listeners.keys()) listener(line);
  };

  /**
   * Logs a line of one of the log sources, and prints it where its
   * source is shown: the log file, and each listener, by the sources
   * it asked for.
   */
  readonly emit = (fields: LogFields): void => {
    const record = this.logs.add(fields);
    if (record.streamed === false) return;
    const line = streamText(record);
    const shows = (sources: ReadonlySet<LogSource>): boolean => record.always === true || inSources(record, sources);
    if (shows(this.sources)) this.print(line);
    for (const [listener, sources] of this.listeners) if (shows(sources ?? this.sources)) listener(line);
  };

  /** The run's id, once other shells can reach it. */
  get id(): string | undefined {
    return this.control?.id;
  }

  /** Whether sent commands can arrive, for dialogs to wait on one. */
  get reachable(): boolean {
    return this.control !== null;
  }

  async open(record: Omit<RunRecord, 'id'>, wanted?: string): Promise<void> {
    try {
      this.control = await RunControl.open(record, { command: this.handle, follow: this.follow }, wanted);
      const { id } = this.control;
      if (record.log) {
        const { linkRunLog } = await import('./run-log.js');
        await linkRunLog(record.log, id, this.out);
      }
      this.out(`[sm-dev] Started as run ${id}. Other shells reach it with sm-dev --run ${id} <command>, or sm-dev attach ${id}, and stop it with sm-dev stop ${id}.`);
    } catch (err) {
      this.out(`[sm-dev] Other shells can't reach this run: ${(err as Error).message}`);
    }
  }

  /** Ready for sent commands, run through `runner`. */
  arm(runner: CommandRunner): void {
    this.runner = runner;
    this.ready();
  }

  /**
   * From now on, sent lines are refused, and ones still waiting for the
   * run to be ready are let go: it is ending.
   */
  disarm(): void {
    this.ending = true;
    this.ready();
  }

  /** Records the loaded scripts, after `load` adds one. */
  setScripts(files: string[]): void {
    void this.control?.update({ scripts: files });
  }

  /** Records how many tabs the run controls, as they open and close. */
  setTabs(tabs: number): void {
    void this.control?.update({ tabs });
  }

  async close(): Promise<void> {
    await this.control?.close();
  }

  // The connections following the run's stream.
  private readonly followers = new Set<(line: string) => void>();

  private readonly follow = (reply: (line: string) => void, sources?: ReadonlySet<LogSource>): (() => void) => {
    this.listeners.set(reply, sources);
    this.followers.add(reply);
    this.onActivity?.(true);
    return () => {
      this.listeners.delete(reply);
      this.followers.delete(reply);
      this.onActivity?.(this.followers.size > 0);
    };
  };

  private readonly handle: SentLineHandler = async (line, reply, sent) => {
    this.onActivity?.(this.followers.size > 0);
    try {
      return await this.run(line, reply, sent);
    } finally {
      this.onActivity?.(this.followers.size > 0);
    }
  };

  private readonly run: SentLineHandler = async (line, reply, sent) => {
    const inspects = onlyInspects(line);
    // A command that changes something, in the stream: not copied to
    // other senders, as it is no part of their commands. A {{ block's
    // code lines as the prompt shows them. One that only looks answers
    // its sender alone.
    if (!inspects) {
      // The sender's own words quoted as it gave them, so the command
      // reads as it was typed.
      const shown = sent.words ? sent.words.map(shellWord).join(' ') : line;
      const [first, ...more] = shown.split('\n');
      // Headed by who sent it and how (see commandMark). A {{ block
      // as it was typed: its code between `{{` and `}}`.
      const mark = commandMark(sent, this.primaryPid);
      const marked = more.length === 0 ? [`${mark} ${first}`] : [`${mark} ${first} {{`, ...more.map((m) => `... ${m}`), '... }}'];
      // To the log and the clients following the run, but not back to
      // the one that sent it, which heads its output itself.
      for (const l of marked) {
        this.print(l);
        for (const follower of this.followers) if (follower !== reply) follower(l);
      }
    }
    // Answered straight away, even before the run is ready, and the
    // sender kept listening until the run has ended, so it sees that.
    if (/^\s*stop\s*$/.test(line)) {
      // First, so `sm-dev stop` knows it was heard, and waits for the
      // teardown rather than taking the wait for no answer.
      reply(`[sm-dev] Stopping run ${this.id}`);
      if (!sent.follows) this.listeners.set(reply, undefined);
      this.onStop?.();
      return 'hold';
    }
    if (!this.runner && !this.ending) reply('[sm-dev] The run is still starting. The command runs once it is ready.');
    await this.armed;
    if (this.ending || !this.runner) {
      reply('[sm-dev] The run is ending, so the command was not run');
      return 1;
    }
    const hooks = { cwd: sent.cwd, words: sent.words, interactive: sent.source === 'prompt', json: sent.json };
    // One that only looks answers its sender alone. One that changes
    // things prints to the stream, which a following sender gets
    // anyway; another gets it while the command runs.
    return this.runner(line, inspects ? { ...hooks, answer: reply }
      : sent.follows ? hooks
        : { ...hooks, start: () => this.listeners.set(reply, undefined), end: () => this.listeners.delete(reply) });
  };
}

async function runInBrowser(
  opts: RunOptions,
  session: RunSession,
  held: Held,
  remote: Remote,
  // Whether the browser has the run's manager, as the run's first line says.
  managerNow: ManagerState | null,
): Promise<number> {
  const { page } = session;
  // The real extension runs the scripts: the run pushes them into it,
  // claims its tabs so only they run there, and its host is filled from
  // the extension's events (extension-host.ts). See
  // docs/sm-dev-design.md.
  // Told apart up front: its worker can't be found either, which would
  // read as not installed.
  const manager = opts.manager ?? DEFAULT_MANAGER;
  const { label } = MANAGERS[manager];
  if (manager === 'sourcemonkey' && managerNow === 'disabled') {
    opts.out(`[sm-dev] SourceMonkey is turned off in this browser. Turn it on with sm-dev${browserArg(session.endpoint, session.launched)} manager enable, or use --temp-browser, which loads it.`);
    return 1;
  }
  // Under another manager, the manager runs every script it has, and
  // the run's tabs are plain browser tabs. The run's scripts go into
  // it too (external-manager.ts).
  if (manager !== 'sourcemonkey' && managerNow !== 'installed' && managerNow !== null) {
    const fix = managerNow === 'disabled' ? 'manager enable' : 'manager install';
    opts.out(`[sm-dev] ${label} is ${managerNow === 'disabled' ? 'turned off' : 'not installed'} in this browser. Use sm-dev${browserArg(session.endpoint, session.launched)} ${managerFlag(manager)} ${fix}.`);
    if (opts.files.length > 0) return 1;
  }
  if (manager !== 'sourcemonkey' && (managerNow === 'installed' || managerNow === null)) {
    let opened: ExternalManager;
    try {
      opened = await openExternalManager(manager, session.endpoint, browserArg(session.endpoint, session.launched));
    } catch (err) {
      opts.out(`[sm-dev] ${(err as Error).message}`);
      return 1;
    }
    const scripts = new ExternalRunScripts(opened, { id: remote.id ?? 'unnamed', started: new Date(remote.startedAt).toISOString() });
    held.external = { manager: opened, scripts };
    try {
      // A throwaway browser's settings are the run's own, so local
      // test pages run scripts, as under SourceMonkey.
      if (session.launched) await opened.allowFilePages();
      for (const line of await scripts.removeLeftovers()) opts.out(`[sm-dev] ${line}`);
    } catch (err) {
      opts.out(`[sm-dev] ${(err as Error).message}`);
      return 1;
    }
  }
  const external = held.external;
  let link: ExtensionLink;
  try {
    link = manager === 'sourcemonkey' ? await ExtensionLink.open(session.context, linkRunId(remote.id))
      : ExtensionLink.without(session.context, linkRunId(remote.id), runUses(manager));
  } catch (err) {
    opts.out(`[sm-dev] ${(err as Error).message}`);
    return 1;
  }
  held.extension = link;
  if (link.versionNote) opts.out(`[sm-dev] ${link.versionNote}`);
  // `tabs` is set before any entry can come in: nothing awaits between.
  const host = new ExtensionHost(link, ({ scriptId, name, level, message, page }) => opts.emit!({
    source: 'sm', kind: level, scriptId, tab: page && tabs.numberOf(page), text: `${name}: ${message}`,
  }));
  if (external) {
    host.external = {
      idOf: (url) => {
        const id = external.manager.scriptIdOf(url);
        return id === undefined ? undefined : String(id);
      },
      prefix: external.manager.scriptUrlPrefix,
      ...(external.manager.remapStack ? { remap: (text: string) => external.manager.remapStack!(text) } : {}),
    };
  }
  link.onRestart((restored) => {
    opts.out('[sm-dev] SourceMonkey\'s background script restarted, so what the scripts did meanwhile may be missing here, apart from their Log entries, which are read back.'
      + (restored > 0 ? ` It had lost its hold on ${restored === 1 ? 'one of the run\'s tabs' : `${restored} of the run's tabs`}, which it has again.` : ''));
    void host.catchUpLogs();
  });
  // Commands are only read once the page has loaded, but a prompt
  // opened before then can still wait for a typed or sent accept.
  const commandsComing = opts.until !== undefined && remote.reachable;
  const tabs = new FollowedTabs(host, opts, session.context, commandsComing, link, () => remote.setTabs(tabs.list().length));
  held.tabs = tabs;
  wireHostOutput(host, opts.emit!, (record) => tabs.tabOf(record));
  held.downloads = await watchDownloads(session.browser, () => tabs.list(), (n, text) => tabEvent(opts.emit!, n, 'download')(text), opts.out, { downloadsDir: session.downloadsDir });
  // T1, unless `--notab`; then the first tab `newtab` opens is T1.
  if (page) {
    // Claimed first, before it loads the run's page; the run can't do
    // without it.
    const tabId = await claimTab(link, page, opts.out);
    if (tabId === undefined) return 1;
    wirePageOutput(page, 1, opts.emit!, host, link.origin);
    wireSandboxCheck(page, () => tabs.firstTabScripts, opts.out);
    const dialogs = await DialogTracker.attach(page, tabEvent(opts.emit!, 1, 'dialog'), {
      visible: browserVisible(opts), commandsComing, tabRef: () => (tabs.list().length > 1 ? 'T1' : undefined),
    });
    await applyLang(page, opts.lang, opts.out);
    const attachment = await attachPage(page, host, tabs.attachOptions);
    host.addTab(attachment, tabId);
    held.attachment = attachment;
    await tabs.start(page, attachment, dialogs);
  }
  const prepared = await prepareAll(opts);
  if (!prepared) return 1;
  const start = startPages(opts, prepared);
  if (!start) return 2;
  const { urls } = start;

  // The loaded scripts, and the files they came from, in step: `load`
  // adds to both, `update` and `--watch` replace scripts in place.
  let scripts = prepared;
  const files = [...opts.files];
  // When each script's files were last modified, as it was read.
  const stamps = new Map<PreparedScript, string>();
  for (const script of prepared) stamps.set(script, await filesStamp(script));
  let commands: ConsoleContext | null = null;
  let watcher: FileWatcher | null = null;
  // Set once the run is ending, so work still queued changes nothing.
  let stopping = false;
  // `load`, `update` and `--watch` saves, one at a time: each reads the
  // script list, awaits, and then replaces it, so two at once would
  // lose one's change.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = (work: () => Promise<void>): Promise<void> => {
    const done = queue.then(work);
    queue = done.catch(() => undefined);
    return done;
  };
  // The scripts' text into the run's test collection in the extension,
  // which the run's tabs run. False,
  // having said why, when the extension refused one; whatever was
  // pushed before it stays. `seed`: newly loaded, so `--values` seeds
  // their storage, before any tab can run them.
  let pushedAny = false;
  const push = async (list: PreparedScript[], seed = false): Promise<boolean> => {
    for (const script of list) {
      const file = fileURLToPath(script.script.fileUrl);
      // The extension keeps the run's scripts by this: the path as
      // typed to start or load, so files of the same name stay apart.
      const name = typedName(opts, file);
      const text = await readFile(file, 'utf8');
      if (manager !== 'sourcemonkey' && !external) {
        opts.out(`[sm-dev] ${label} was not on in this browser when the run started, so the run can't load scripts into it. Start a new run once it's on.`);
        return false;
      }
      if (external) {
        let installed: { id: number; replaced: boolean };
        try {
          installed = await external.scripts.push(script, text);
        } catch (err) {
          opts.out(`[sm-dev] ${name} could not be loaded into ${label}: ${(err as Error).message}`);
          return false;
        }
        pushedAny = true;
        host.setPushed(script.id!, String(installed.id));
        opts.out(`[sm-dev] Installed in ${label} as E${installed.id}: ${preparedScriptPath(script)}${installed.replaced ? ' (replaced)' : ''}`);
        continue;
      }
      const result = await link.push(text, name, pushedFiles(script), script.script.fileUrl);
      pushedAny = true;
      if (result.status !== 'ok') {
        opts.out(`INVALID  ${typedName(opts, file)}\n    ${result.errorMessage ?? ''}`);
        return false;
      }
      host.setPushed(script.id!, result.scriptId);
      // An extension without the call leaves its stack lines as they are.
      host.setLayout(result.scriptId, await link.stackLayout(result.scriptId).catch(() => null));
      if (seed && opts.values) await host.setValues(script.id!, opts.values);
      opts.out(`[sm-dev] Pushed to SourceMonkey: ${preparedScriptPath(script)}${result.replaced ? ' (replaced)' : ''}`);
    }
    return true;
  };
  // Put `next` in place everywhere, and reload the tabs `changed` affects.
  // `timeoutMs`: each reload's, from the command's --timeout-seconds.
  const apply = async (next: PreparedScript[], changed: ScriptChange[], none: string, pushed = false, timeoutMs?: number): Promise<void> => {
    if (!pushed && !(await push(changed.map((c) => c.next)))) return;
    scripts = next;
    // The typed commands' list too, keeping the selected script by its place.
    if (commands) {
      const i = commands.current ? commands.scripts.indexOf(commands.current) : -1;
      commands.scripts = next;
      commands.current = next[i];
    }
    // Before the reloads, so a save made while they run is seen; a
    // watcher that fails to start costs the tabs nothing.
    try {
      watcher?.watch(next);
    } catch (err) {
      opts.out(`[sm-dev] The files could not be watched: ${(err as Error).message}`);
    }
    await tabs.apply(next, changed, none, timeoutMs);
  };
  // `update`, and a `--watch` save: re-read the scripts at `which`
  // (every one, when not given) whose files have been modified since
  // they were read; a touch counts. One that no longer prepares leaves
  // every one as it was.
  const update = (which?: number[], timeoutMs?: number): Promise<void> => serial(async () => {
    const indices = which ?? scripts.map((_, i) => i);
    const next = [...scripts];
    const changed: ScriptChange[] = [];
    for (const i of indices) {
      const old = scripts[i];
      const stamp = await filesStamp(old);
      if (stamp === stamps.get(old)) continue;
      const fresh = await prepareAll(opts, [files[i]]);
      if (!fresh || stopping) return;
      stamps.set(fresh[0], stamp);
      next[i] = fresh[0];
      changed.push({ old, next: fresh[0] });
    }
    if (changed.length === 0) {
      opts.out(indices.length === 1
        ? `[sm-dev] Script ${indices[0] + 1} hasn't changed on disk, so nothing was reloaded`
        : '[sm-dev] No script has changed on disk, so nothing was reloaded');
      return;
    }
    await apply(next, changed, 'No open tab runs or matches the updated scripts, so none was reloaded', false, timeoutMs);
  });
  const load = (input: string, timeoutMs?: number): Promise<void> => serial(async () => {
    const file = path.resolve(input);
    const info = await stat(file).catch(() => null);
    if (!info) {
      opts.out(`[sm-dev] ${noSuchFileMessage(input)}`);
      return;
    }
    if (info.isDirectory()) {
      opts.out(`[sm-dev] ${isDirectoryMessage(input)}`);
      return;
    }
    const already = files.indexOf(file);
    if (already >= 0) {
      opts.out(`[sm-dev] ${input} is already loaded, as script ${already + 1}. Use update ${already + 1} to re-read it.`);
      return;
    }
    opts.typed?.set(file, input);
    const fresh = await prepareAll(opts, [file]);
    if (!fresh || stopping) return;
    const script = fresh[0];
    const n = scripts.length + 1;
    // Before it counts as loaded, so a push the extension refuses
    // leaves the run as it was.
    if (!(await push([script], true)) || stopping) return;
    files.push(file);
    remote.setScripts(files);
    stamps.set(script, await filesStamp(script));
    opts.out(`[sm-dev] Loaded ${input} as script ${n}`);
    await apply([...scripts, script], [{ next: script }], `No open tab matches it, so none was reloaded. Use open ${n} to open its page.`, true, timeoutMs);
  });
  // Seeded once, as pushed. An update keeps the store, so values the
  // script wrote since survive it.
  if (!(await push(prepared, true))) return 1;
  await tabs.setScripts(prepared);
  if (page) {
    const t1 = tabs.list()[0];
    // The other URLs given, or with --all the other scripts' pages, each
    // get a tab of their own.
    // All are set up first (numbered in call order), then announced in
    // order, then loaded at once.
    const more = await Promise.all(urls.slice(1).map((url, i) => tabs.createTab().then(
      (tab) => ({ tab, url, saved: start.saved[i + 1] }),
      (err) => {
        tabFailed(opts, start, prepared, url, err as Error);
        return null;
      },
    )));
    const opened = more.filter((m) => m !== null);
    // Each saved page served before its tab is announced, which then
    // names the file.
    for (const [tab, saved] of [[t1, start.saved[0]] as const, ...opened.map((o) => [o.tab, o.saved] as const)]) {
      if (tab && saved) await serveSavedPage(tab, saved, opts.out, prepared.length === 0);
    }
    // T1 is gone only if a page closed it on its own already.
    if (t1) tabs.announce(t1, urls[0]);
    for (const { tab, url } of opened) tabs.announce(tab, url);
    await Promise.all([
      ...(t1 && urls[0] ? [tabs.navigate(t1, urls[0], opts.timeoutMs)] : []),
      ...opened.map(({ tab, url }) => tabs.navigate(tab, url, opts.timeoutMs)),
    ]);
    printSkipped(opts, start);
  } else {
    opts.out(NO_TABS);
  }

  try {
    if (opts.watch) {
      watcher = watchFiles(opts, prepared, async () => {
        opts.out('[sm-dev] Change detected, re-pushing');
        await update();
      });
    }
    if (opts.until) {
      // Typed commands drive the script while it runs: fire a menu
      // command again, read what it stored, write a value back. Only
      // worth arming for a run that is waiting on something.
      //
      // Armed once the script has started (or shortly after, if it
      // never does): a command read before then would run against a
      // page whose script has not registered anything yet. A piped
      // sequence of commands would otherwise hit exactly that.
      // Nothing will start with no scripts, or no tab to run in.
      if (prepared.length > 0 && page) await waitForReports(host, tabs.list());
      // Then for the tabs to settle (see wait.ts), so the first command,
      // or `--detach`'s return, sees the page as its scripts left it.
      if (!opts.noWait) await settleTabs(host, tabs.list(), opts.out, opts.timeoutMs);
      const ctx: ConsoleContext = {
        host,
        tabs: () => tabs.list(),
        // T1 to start with, or whichever is open if T1 has closed.
        tab: tabs.list()[0],
        newTab: (url, options) => tabs.newTab(url, options),
        // In turn with load, update and --watch saves, which also
        // change what a tab has.
        setTabScripts: (tab, noScript) => serial(() => tabs.setNoScript(tab, noScript)),
        loadScript: load,
        // By place, so an update queued behind another still finds them.
        updateScripts: (which, timeoutMs) => update(which?.map((s) => scripts.indexOf(s)).filter((i) => i >= 0), timeoutMs),
        scripts,
        out: opts.out,
        stop: () => opts.onStop?.(),
        runId: remote.id,
        ...(opts.log ? { log: opts.log } : {}),
        ...(session.downloadsDir ? { downloadsDir: session.downloadsDir } : {}),
        browser: browserSentence({ browser: session.endpoint, owned: session.launched, headless: session.headless }),
        browserInfo: { address: session.endpoint.replace(/^https?:\/\//, ''), owned: session.launched === true, headless: session.headless === true },
        testCollection: () => (pushedAny && !external ? link.runId : undefined),
        managerName: manager,
        browserArg: browserArg(session.endpoint, session.launched),
        managers: () => managersIn(session.endpoint),
        // The first push makes the test collection.
        backend: () => (external ? `${label} ${external.manager.version}, with the run's scripts installed in it until the run ends`
          : manager !== 'sourcemonkey' ? `${label}, which the run loads no scripts into`
          : pushedAny
            ? `SourceMonkey extension, test collection ${link.runId}`
            : `SourceMonkey extension, run ${link.runId}, with no test collection until a script is pushed`),
        // A throwaway browser's data is the run's own. Under another
        // manager, there's no SourceMonkey to list.
        ...(manager === 'sourcemonkey' ? { others: host.otherScripts(!session.launched), manager: link.manager }
          : external ? {
            others: externalOthers(external.manager, () => new Set(scripts.flatMap((p) => (p.id ? [host.extensionIdOf(p.id)] : []))), !session.launched),
            manager: externalControl(external.manager),
            // Nothing reports what ran, so the run's scripts' rules say.
            predicted: true,
            predictedOff: externalOff(external.manager),
          } : {}),
        extensionIdOf: (script) => (script.id === undefined ? undefined : host.extensionIdOf(script.id)),
        logs: remote.logs,
        roots: { collectionRoot: opts.collectionRoot, localRoots: opts.localRoots },
      };
      commands = ctx;
      const runner = commandRunner(ctx);
      if (commandsComing) setCommandsListening(ctx.tabs(), true);
      remote.arm(runner);
      opts.onReady?.(remote.id);
      await opts.until;
    } else {
      // One load's worth of output, then leave the page as it is. Not
      // the page's own timer: the script may have closed it.
      await sleep(500);
    }
  } finally {
    // Also on a throw, or stdin and the file watcher would keep the
    // process alive. Queued work still running finishes first, and
    // changes nothing once it sees `stopping`.
    stopping = true;
    remote.disarm();
    setCommandsListening(tabs.list(), false);
    watcher?.stop();
    await queue;
  }
  return host.reports.errors.length === 0 ? 0 : 1;
}

// Claims `page`'s tab for the run (see `ExtensionLink.claimPage`).
// Undefined, having said why, when it can't be.
async function claimTab(link: ExtensionLink, page: Page, out: (line: string) => void): Promise<number | undefined> {
  try {
    return await link.claimPage(page);
  } catch (err) {
    out(`[sm-dev] The tab could not be set up for the run: ${(err as Error).message}`);
    return undefined;
  }
}

interface Held {
  attachment?: PageAttachment;
  tabs?: FollowedTabs;
  downloads?: DownloadWatch;
  /** The run's connection to SourceMonkey, released at its end. */
  extension?: ExtensionLink;
  /** Under another manager: the manager, and the run's scripts in it, removed at its end. */
  external?: { manager: ExternalManager; scripts: ExternalRunScripts };
}

// The run's tabs: T1, the tabs `newtab` and `--all` open, and the tabs
// those open, by a link, `window.open` or `GM_openInTab`. The extension
// claims an opened tab for the run itself and says so (`tab-opened`),
// so its scripts run there from its first load; the run then finds its
// page and watches it. Tabs the person opens themselves have no opener,
// and are left alone.
class FollowedTabs {
  // T1, the run's own tab; set by `start`, unless the run opened none.
  private first: ControlledTab | null = null;
  private firstAttachment: PageAttachment | null = null;
  // The scripts every tab gets: the latest after `load`, `update` and
  // `--watch` saves.
  private scripts: PreparedScript[] = [];
  // What T1 runs now: none once `open --noscript` switched it off.
  get firstTabScripts(): readonly PreparedScript[] {
    return this.first?.noScript ? [] : this.scripts;
  }
  // The rest, while they are open.
  private readonly tabs = new Map<Page, { tab: ControlledTab; attachment: PageAttachment; ready: boolean }>();
  // Every tab's number by its attachment, kept after it closes, so a
  // report that arrives late (a request finishing) still says whose.
  private readonly numbers = new WeakMap<object, number>();
  // Tabs still being set up, so dispose can wait for them.
  private readonly adopting = new Set<Promise<unknown>>();
  // Without a T1 of the run's own (`--notab`), the first tab opened is T1.
  private nextNumber = 1;
  private disposed = false;

  // Pages that were open before the run, or that it opened itself,
  // which a tab-opened event can't be about.
  private readonly notOpenedByScripts = new WeakSet<Page>();

  constructor(
    private readonly host: ExtensionHost,
    private readonly opts: RunOptions,
    private readonly context: BrowserContext,
    // Whether typed commands will be read, so a new tab's dialog waits
    // for a typed answer rather than being dismissed.
    private readonly commandsComing: boolean,
    // The run's connection to SourceMonkey, which claims its tabs and
    // says which tabs they open.
    private readonly link: ExtensionLink,
    // Called as tabs join the list or close.
    private readonly onTabsChanged: () => void = () => undefined,
  ) {
    for (const p of context.pages()) this.notOpenedByScripts.add(p);
    link.onEvent((event) => {
      if (event.kind === 'tab-opened') void this.adoptOpened(event);
    });
  }

  /** How the run's tabs are attached: watched, with the extension running the scripts. */
  get attachOptions(): AttachOptions {
    return { watchOnly: { extensionOrigin: this.link.origin } };
  }

  /** Register the run's own tab as T1, and follow the tabs it opens. */
  async start(page: Page, attachment: PageAttachment, dialogs: DialogTracker): Promise<void> {
    this.notOpenedByScripts.add(page);
    this.first = { n: 1, page, link: attachment, dialogs, targetId: await targetIdOf(page) };
    this.firstAttachment = attachment;
    this.nextNumber = 2;
    this.numbers.set(attachment, 1);
    page.on('close', () => {
      if (this.disposed) return;
      tabEvent(this.opts.emit!, 1, 'tab-closed')('Tab closed');
      this.onTabsChanged();
    });
    this.onTabsChanged();
  }

  /** The controlled tabs still open, by number. */
  list(): ControlledTab[] {
    // Sorted: tabs opened together finish setting up in any order.
    const all = [...(this.first ? [this.first] : []), ...[...this.tabs.values()].map((t) => t.tab)];
    return all.filter((t) => !t.page.isClosed()).sort((a, b) => a.n - b.n);
  }

  /** The number of the tab a host report came from, if known. */
  tabOf(record: object): number | undefined {
    const link = this.host.pageOf(record);
    return link ? this.numberOf(link) : undefined;
  }

  /** The number of the tab a page link (its attachment) is, if known. */
  numberOf(link: PageLink): number | undefined {
    return this.numbers.get(link);
  }

  /** The scripts to start with, before T1 has loaded anything. */
  async setScripts(scripts: PreparedScript[]): Promise<void> {
    this.scripts = scripts;
    for (const { attachment } of this.open()) await this.swapScripts(attachment, scripts);
  }

  /**
   * Put `next` in place in every open tab, for `update`, `load` and a
   * `--watch` save, and reload the tabs `changed` affects: those where
   * a changed script is running, or where its rules now match. All at
   * once, so one slow page holds up no other. `none` is what to say
   * when no tab is affected.
   */
  async apply(next: PreparedScript[], changed: ScriptChange[], none: string, timeoutMs?: number): Promise<void> {
    this.scripts = next;
    const open = this.open();
    const affected = open.filter(({ tab }) => changed.some((c) =>
      (c.old?.id && this.host.isRunning(tab.link, c.old.id))
      || explainMatch(c.next.matching, tab.page.url()).matches));
    if (affected.length === 0) this.opts.out(`[sm-dev] ${none}`);
    const reload = reloadable(affected.map(({ tab }) => tab), this.opts.out);
    // Only a `--watch` save gets here with a dialog open; the typed
    // commands refuse. The page takes no new scripts until it is
    // answered, so neither does this.
    for (const { tab } of open) {
      if (tab.dialogs?.current) this.opts.out(`[sm-dev] T${tab.n} gets the new scripts once its dialog is answered`);
    }
    if (reload.length > 0) this.opts.out(`[sm-dev] Reloading ${reload.map((t) => `T${t.n}`).join(', ')}`);
    // Scripts before the first changed one stay as they are, so a tab
    // that isn't reloaded keeps them attached throughout; from there on
    // they are re-added, keeping the load order they run in.
    const from = Math.min(...changed.map((c) => next.indexOf(c.next)));
    await Promise.all(open.map(async ({ tab, attachment }) => {
      try {
        await this.swapScripts(attachment, next, from);
      } catch (err) {
        // A tab closing meanwhile needs no word; its close says it.
        if (!tab.page.isClosed()) this.opts.out(`[sm-dev] T${tab.n} could not be updated: ${(err as Error).message}`);
        return;
      }
      if (reload.includes(tab)) await reloadTab(tab, this.host, this.opts.out, timeoutMs);
    }));
  }

  // The open tabs with their attachments, T1 included.
  private open(): { tab: ControlledTab; attachment: PageAttachment }[] {
    const first = this.first && this.firstAttachment && !this.first.noScript ? [{ tab: this.first, attachment: this.firstAttachment }] : [];
    // A tab still being set up is left out: its setup catches up on
    // what it missed, and two swaps at once could add a script twice.
    // A tab without scripts is no part of changing them.
    const ready = [...this.tabs.values()].filter((t) => t.ready && !t.tab.noScript);
    return [...first, ...ready].filter(({ tab }) => !tab.page.isClosed());
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Settled, not all: one failed setup must not skip the others'
    // cleanup.
    await Promise.allSettled(this.adopting);
    // The tabs stay open, only no longer watched.
    for (const { attachment } of this.tabs.values()) await attachment.dispose().catch(() => undefined);
    this.tabs.clear();
  }

  // Sets up `page`, a tab tab `opener` opened, as a run tab.
  private adopt(page: Page, opener: number, tabId: number): void {
    if (this.disposed || this.tabs.has(page)) return;
    this.notOpenedByScripts.add(page);
    const n = this.nextNumber++;
    // A tab without scripts opens more of its kind.
    const noScript = this.list().find((t) => t.n === opener)?.noScript === true;
    this.track(this.setUp(page, n, opener, true, noScript, tabId).catch((err) => {
      // Closed while being set up is the usual cause, and says nothing.
      if (page.isClosed()) return;
      this.opts.out(`[sm-dev] T${n} could not be set up: ${(err as Error).message}`);
    }));
  }

  /**
   * A new tab for `newtab` and `--all`: controlled from the start, so
   * its first page loads with the scripts as the extension would run
   * them. Numbered before anything is awaited, so tabs opened together
   * are numbered in call order. Stays open when the run ends, like the
   * tabs the page opens. `noScript`: one the scripts stay out of, for
   * `newtab --noscript`.
   */
  async newTab(url?: string, { noScript = false, saved, timeoutMs }: { noScript?: boolean; saved?: SavedPageStart; timeoutMs?: number } = {}): Promise<ControlledTab> {
    const tab = await this.createTab(noScript);
    if (saved) await serveSavedPage(tab, saved, this.opts.out, noScript || this.scripts.length === 0);
    this.announce(tab, url);
    if (url) await this.navigate(tab, url, timeoutMs);
    return tab;
  }

  /**
   * `newTab` without the announcing and loading, for `--all` to set
   * its tabs up together and then say so in order.
   */
  async createTab(noScript = false): Promise<ControlledTab> {
    if (this.disposed) throw new Error('The run is ending');
    const n = this.nextNumber++;
    const setUp = (async () => {
      const page = await this.context.newPage();
      this.notOpenedByScripts.add(page);
      try {
        const tabId = await this.link.claimPage(page, noScript);
        await this.setUp(page, n, undefined, false, noScript, tabId);
      } catch (err) {
        // Nothing controls it, so it would only be in the way.
        await page.close().catch(() => undefined);
        throw err;
      }
      return page;
    })();
    this.track(setUp);
    const page = await setUp;
    const entry = this.tabs.get(page);
    if (!entry) throw new Error(`T${n} closed before it could be set up`);
    return entry.tab;
  }

  /**
   * The line a tab the run opens gets: where it's going, and its id; an
   * event for a blank one, as for a tab a page opens.
   */
  announce(tab: ControlledTab, url?: string): void {
    const saved = url && tab.saved && comparableUrl(url) === comparableUrl(tab.saved.url) ? tab.saved : undefined;
    if (!url) {
      tabEvent(this.opts.emit!, tab.n, 'tab-opened')(`Tab opened${targetIdSuffix(tab.targetId)}`);
      return;
    }
    this.opts.out(saved ? `${openingSavedLine(saved.given, url, `T${tab.n}`)}${targetIdSuffix(tab.targetId)}`
      : `[sm-dev] Opening ${url} in T${tab.n}${targetIdSuffix(tab.targetId)}`);
  }

  async navigate(tab: ControlledTab, url: string, timeoutMs?: number): Promise<void> {
    await gotoInTab(tab, this.host, url, this.opts.out, timeoutMs);
  }

  private track(work: Promise<unknown>): void {
    const settled = work.catch(() => undefined).finally(() => this.adopting.delete(settled));
    this.adopting.add(settled);
  }

  // `opener` is the tab that opened this one; none for `newtab`.
  // `announce`: say it opened; the run's own tabs are announced by
  // their caller instead, with where they are going. `noScript`: its
  // claim runs no scripts, now or later.
  private async setUp(page: Page, n: number, opener: number | undefined, announce: boolean, noScript: boolean, tabId: number): Promise<void> {
    // T1 goes unprefixed, as the run's own does, when `--notab` makes
    // the first tab opened T1.
    const out = tabOutput(this.opts.out, n);
    // First, so a tab that closes during the awaits below is still
    // noticed.
    let announced = false;
    page.on('close', () => {
      this.tabs.delete(page);
      if (!announced || this.disposed) return;
      tabEvent(this.opts.emit!, n, 'tab-closed')('Tab closed');
      this.onTabsChanged();
    });
    wirePageOutput(page, n, this.opts.emit!, this.host, this.link.origin);
    // Not for a tab with no scripts, which gets none either way. Read
    // from the tab once it exists, since `open --script` switches it.
    let tabNow: ControlledTab | null = null;
    wireSandboxCheck(page, () => ((tabNow?.noScript ?? noScript) ? [] : this.scripts), out);
    const dialogs = await DialogTracker.attach(page, tabEvent(this.opts.emit!, n, 'dialog'), {
      visible: browserVisible(this.opts),
      commandsComing: this.commandsComing,
      // T2 on is named even while it is set up, before list() has it.
      tabRef: () => (n > 1 || this.list().length > 1 ? `T${n}` : undefined),
    });
    await applyLang(page, this.opts.lang, out);
    // An opened tab may have loaded already, with its events from that
    // document waiting.
    const shown = page.url();
    const attachment = await attachPage(page, this.host, this.attachOptions);
    this.numbers.set(attachment, n);
    // Read before the check below, so a tab closing meanwhile is caught
    // by it rather than listed after its close has passed.
    const targetId = await targetIdOf(page);
    if (page.isClosed()) {
      await attachment.dispose().catch(() => undefined);
      return;
    }
    const entry = { tab: { n, page, link: attachment, dialogs, openedBy: opener, targetId, noScript }, attachment, ready: false };
    tabNow = entry.tab;
    this.tabs.set(page, entry);
    this.onTabsChanged();
    const url = page.url();
    const loaded = url !== '' && url !== 'about:blank';
    announced = true;
    if (announce) tabEvent(this.opts.emit!, n, 'tab-opened')(`Tab opened${loaded ? ` at ${url}` : ''}${noScript ? ' (no scripts)' : ''}${opener ? `, from T${opener}` : ''}${targetIdSuffix(targetId)}`);
    // After it's announced, so the events it had waiting print under it.
    this.host.addTab(attachment, tabId, opener !== undefined && shown !== '' && shown !== 'about:blank', noScript);
    if (noScript) {
      entry.ready = true;
      return;
    }
    let scripts = this.scripts;
    // Recorded, for the waits and reports to know what to expect; the
    // extension runs them.
    for (const script of scripts) await attachment.inject(script, { immediately: true });
    // A `load`, `update` or `--watch` save while this tab was being set
    // up passed it by. Brought up to date here, before it is ready for
    // the next one.
    while (this.scripts !== scripts) {
      scripts = this.scripts;
      await this.swapScripts(attachment, scripts);
      await loadPage(page, (o) => page.reload(o)).catch(() => undefined);
    }
    entry.ready = true;
  }

  /**
   * Switches a tab to running no scripts, or back to running them, for
   * `open --noscript` / `--script`. It lasts: every page the tab loads
   * from then on goes the new way, until switched again. Its claim
   * changes here; the page it's showing keeps what it has until the
   * next load.
   */
  async setNoScript(tab: ControlledTab, noScript: boolean): Promise<void> {
    if ((tab.noScript === true) === noScript) return;
    // Its setup would put back what this takes off.
    if (tab !== this.first && [...this.tabs.values()].some((t) => t.tab === tab && !t.ready)) {
      throw new Error('It\'s still being set up. Try again in a moment.');
    }
    const tabId = this.host.tabIdOf(tab.link);
    if (tabId !== undefined) await this.link.setTabScriptsOff(tabId, noScript);
    await this.swapScripts(tab.link, noScript ? [] : this.scripts);
    // Once done, so a failed switch leaves the tab as it was for `load`
    // and `update`.
    tab.noScript = noScript;
  }

  /**
   * A tab one of the run's tabs opened, as the
   * extension says (a link, `window.open`, `GM_openInTab`), which it has
   * already claimed for the run. Its page is one not otherwise accounted
   * for, opened by the opener's page (`window.open`, as Playwright
   * knows), or else at the event's URL. Never a guess past that: a
   * page the person opened mustn't be taken for it. Waits a few seconds
   * for Playwright to report it, and for the opener's own setup.
   */
  private async adoptOpened(event: Extract<ExtensionEvent, { kind: 'tab-opened' }>): Promise<void> {
    // Its events wait for the setup.
    this.host.expectTab(event.tabId);
    // Which page is that tab: the one showing the same document as the
    // extension reads in it, by URL and `performance.timeOrigin`. Read
    // again until both sides agree, since the tab may be navigating.
    const deadline = Date.now() + 10_000;
    let opener: ControlledTab | undefined;
    while (Date.now() < deadline && !this.disposed) {
      opener = this.list().find((t) => this.host.tabIdOf(t.link) === event.sourceTabId);
      const shown = opener ? await this.link.tabDocument(event.tabId).catch(() => null) : null;
      if (opener && shown) {
        const candidates = this.context.pages().filter((p) => !this.notOpenedByScripts.has(p) && !this.tabs.has(p) && !p.isClosed());
        for (const p of candidates) {
          // Not held up by a page stopped on a dialog.
          const doc = await Promise.race([
            p.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin })).catch(() => null),
            sleep(1000).then(() => null),
          ]);
          if (doc && doc.timeOrigin === shown.timeOrigin && doc.url === shown.url) {
            this.adopt(p, opener.n, event.tabId);
            return;
          }
        }
      }
      await sleep(100);
    }
    // Still the run's (its claim came from its opener), but unseen here.
    if (!this.disposed && opener) {
      tabEvent(this.opts.emit!, opener.n, 'tab-opened')(`Opened a tab sm-dev couldn't follow (${event.url}). Only the run's scripts run in it, but their output there isn't shown.`);
    }
  }

  // `scripts` in place of what `attachment` has, from index `from` on.
  private async swapScripts(attachment: PageAttachment, scripts: PreparedScript[], from = 0): Promise<void> {
    const keep = new Set(scripts.slice(0, from).map((s) => s.id!));
    for (const old of attachment.injectedScripts()) {
      if (!keep.has(old.id!)) await attachment.remove(old.id!);
    }
    for (const script of scripts.slice(from)) await attachment.inject(script);
  }
}


// Resolve once each script in each tab's page has had its word there:
// started, skipped (a URL its rules don't cover) or thrown. Or after a
// grace period, for one that never says (a page that never loads).
async function waitForReports(host: ExtensionHost, tabs: ControlledTab[], timeoutMs = 5000): Promise<void> {
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), timeoutMs);
  const gaveUp = new Promise<void>((resolve) => giveUp.signal.addEventListener('abort', () => resolve()));
  try {
    await Promise.race([
      // Not one whose load already gave up, and said so.
      Promise.all(tabs.filter((tab) => !tab.stalled).map((tab) => {
        const ids = tab.link.scriptsInDocument().filter((s) => s.id).map((s) => s.id!);
        return host.untilReported(tab.link, ids, tab.link.documentFirstStart(), giveUp.signal);
      })),
      gaveUp,
    ]);
  } finally {
    clearTimeout(timer);
    giveUp.abort();
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Whether a person can see the browser, and so answer its dialogs.
function browserVisible(opts: ConnectOptions): boolean {
  return !opts.tempBrowser || opts.headed === true;
}

// When a script's files (its own and local @requires) were last
// modified, as one comparable string; a missing file counts too.
async function filesStamp(script: PreparedScript): Promise<string> {
  const paths = [script.script.fileUrl, ...script.requires.map((r) => r.localUrl ?? '')]
    .filter((u) => u.startsWith('file:')).map((u) => fileURLToPath(u));
  const times = await Promise.all(paths.map((p) => stat(p).then((st) => st.mtimeMs, () => -1)));
  return paths.map((p, i) => `${p}:${times[i]}`).join('|');
}

// A script file as the person typed it, for an error to name it as
// they did; else as paths are shown.

function typedName(opts: RunOptions, file: string): string {
  return opts.typed?.get(file) ?? shownPath(file);
}

async function prepareAll(opts: RunOptions, files = opts.files): Promise<PreparedScript[] | null> {
  const out: PreparedScript[] = [];
  for (const file of files) {
    const p = await prepareScript({ file, collectionRoot: opts.collectionRoot, localRoots: opts.localRoots });
    if (p.status !== 'ok') {
      opts.out(`INVALID  ${typedName(opts, file)}\n    ${p.diagnostic}`);
      return null;
    }
    for (const line of warningLines(p)) opts.out(`[sm-dev] ${line}`);
    out.push(p);
  }
  return out;
}

// `prefix` tags each report with the tab it came from.
function wireHostOutput(host: ExtensionHost, emit: (fields: LogFields) => void, tabOf: (record: object) => number | undefined): void {
  const event = (record: { scriptId?: string }, kind: string, text: string, also?: LogSource[]): void => emit({ source: 'event', kind, tab: tabOf(record), scriptId: record.scriptId, text, ...(also ? { also } : {}) });
  // SourceMonkey's Log has an entry for each of these, logged as the
  // report rather than twice; not for a rule miss, which only the run
  // finds. A throw is the script's own error too, and the page's console
  // shows it.
  host.on('start', (r: StartReport) => event(r, 'started', `${r.name} started on ${r.url}`, ['sm']));
  host.on('skip', (r: SkipReport) => event(r, 'skipped', `${r.name} skipped on ${r.url}: ${r.reason}`, r.ruleMiss ? undefined : ['sm']));
  host.on('manual', (r: ManualReport) => event(r, 'manual', `${r.name} is waiting to be run on ${r.url}, since it has @run-at context-menu. Use menu to run it.`));
  host.on('script-error', (r: ErrorReport) => {
    const frames = r.stack ? r.stack.split('\n').slice(1, 4).map((line) => `\n    ${decodeOwnRefs(line.trim())}`).join('') : '';
    event(r, 'threw', `${r.name} threw: ${decodeOwnRefs(r.message)}${frames}`, ['sm', 'script', 'page']);
  });
  host.on('request', (r) => event(r, 'request', `GM_xmlhttpRequest ${r.method} ${r.url}: ${r.outcome}${r.status ? ' ' + r.status : ''}${r.error ? ' ' + r.error : ''}`));
  host.on('tab', (r) => event(r, 'open-tab', `GM_openInTab ${r.url}`));
  host.on('menu-command', (r) => event(r, 'menu-command', `GM_registerMenuCommand "${r.name}"`));
  host.on('notification', (r) => event(r, 'notification', `GM_notification "${r.title || r.text}"`));
  // Only the asking: the answer is the script's Log entry. Set apart and
  // streamed whatever the sources: the run waits on an answer, and the
  // line is easy to miss among the page's own output.
  host.on('connect-prompt', (r) => {
    if (r.answer) return;
    emit({
      source: 'event', kind: 'permission-prompt', tab: tabOf(r), scriptId: r.scriptId, always: true,
      text: `*PERMISSION PROMPT*: ${r.name} requests permission to connect to ${r.host} (${r.method} ${withoutQuery(r.url)}). Answer using connect once|cancel|allow|deny|allow-all.`,
    });
  });
  host.on('download', (r) => event(r, 'download', `GM_download ${r.url}: ${r.outcome}${r.filename ? ' -> ' + r.filename : ''}${r.error ? ' ' + r.error : ''}`));
  host.on('value-write', (r) => {
    for (const w of r.writes) {
      event(r, 'value', w.deleted
        ? `GM_deleteValue ${w.key}`
        : `GM_setValue ${w.key} = ${shortValue(w.value)}`);
    }
  });
}

// Longer stored values are cut in `GM_setValue` lines, so a cache a
// script stores doesn't bury the rest of the output. `values` and
// `get` show them whole.
const VALUE_SHOWN_CHARS = 100;

function shortValue(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  if (json.length <= VALUE_SHOWN_CHARS) return json;
  // By code point, so an emoji isn't cut in half.
  return `${Array.from(json).slice(0, VALUE_SHOWN_CHARS).join('')}... (${json.length} chars; get shows it all)`;
}

// A page whose CSP sandboxes it without allow-scripts gets no MAIN-world
// userscripts in a real manager, and Chrome says nothing about it. Said
// on each load of one that the run's MAIN-world scripts match. See
// src/sandboxed-page.ts.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function wireSandboxCheck(page: Page, scripts: () => readonly PreparedScript[], out: (line: string) => void): void {
  page.on('response', (response) => {
    try {
      // A redirect's own headers don't apply to the page it leads to.
      // Not every 3xx: a 304 is the page itself, revalidated.
      if (REDIRECT_STATUSES.has(response.status())) return;
      if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return;
    } catch {
      // A service worker's response has no frame.
      return;
    }
    const url = response.url();
    void response.headerValue('content-security-policy').then((csp) => {
      if (!csp || !cspBlocksPageScripts(csp)) return;
      const blocked = scripts().filter((s) => s.world === 'MAIN' && explainMatch(s.matching, url).matches);
      if (blocked.length > 0) out(`[sm-dev] ${sandboxedPageWarning(blocked.map(preparedScriptPath))}`);
    }, () => undefined);
  });
}

// `page` is everything the page's console shows, so a script's console
// line or uncaught error is the page's too.
const SCRIPT_IN_PAGE: Record<'script' | 'page', Partial<LogFields>> = { script: { also: ['page'] }, page: {} };

// What happened in tab `n`, said as an `event` line of `kind`. A dialog
// box is streamed whatever the sources, as the page waits on an answer.
function tabEvent(emit: (fields: LogFields) => void, n: number, kind: string): (text: string) => void {
  return (text) => emit({ source: 'event', kind, tab: n, text, ...(kind === 'dialog' ? { always: true } : {}) });
}

// A tab's lines are tagged `[T<n>]`, except T1's, as the run's own are.
function tabOutput(out: (line: string) => void, n: number): (line: string) => void {
  return n === 1 ? out : (line) => out(`[T${n}] ${line}`);
}

// Logs tab `n`'s console lines and uncaught errors, each as the run's
// scripts' (`script`) or the page's own (`page`), and its page loads
// (`event`, for `logs` only). Whose a line is goes by its whole stack,
// read from the protocol's own copy of the call (`ConsoleStacks`), so a
// script logging through a page helper still counts as the script's.
// `host.remapStack` points stack frames in a logged line
// (`console.error(err)` prints the stack) at the `@require` or script
// line they came from. It runs before `decodeOwnRefs`, since it matches
// the scripts' URLs as the page wrote them (still encoded).
function wirePageOutput(page: Page, n: number, emit: (fields: LogFields) => void, host: ExtensionHost, extensionOrigin: string): void {
  // Given up on after a while, so a session that never opens (a hung tab,
  // a slow remote browser) can't hold up the tab's lines for good.
  // Under another manager, its worlds are the scripts'.
  const origin = host.external ? host.external.prefix.replace(/\/$/, '') : extensionOrigin;
  const stacks = Promise.race([ConsoleStacks.attach(page, origin), sleep(STACKS_ATTACH_MS).then(() => null)]);
  const log = (msg: ConsoleMessage, text: string, call: ConsoleCall | null): void => {
    const body = decodeOwnRefs(host.remapStack(text));
    // SourceMonkey's own console lines repeat what the run logs from its
    // reports, so they're only part of the page's whole console.
    if (isPreludeLine(body)) {
      emit({ source: 'page', kind: msg.type(), tab: n, text: body });
      return;
    }
    const url = msg.location().url;
    const frames = call?.frames ?? [];
    const source = consoleSource({ type: msg.type(), text: body, url, frames, extensionWorld: call?.extensionWorld, argCount: msg.args().length }, host.external?.prefix);
    emit({ source, ...SCRIPT_IN_PAGE[source], kind: msg.type(), tab: n, scriptId: source === 'script' ? host.scriptOf([url, ...frames]) : undefined, text: body });
  };
  // In order: a line that logs a DOM node is described from the page,
  // which takes a round trip, and each waits for its stack.
  let pending: Promise<void> = Promise.resolve();
  page.on('console', (msg) => {
    const args = msg.args();
    // `%c` styling and the like applied; Playwright's text has them raw.
    const text = args.some((arg) => arg.asElement())
      ? consoleText(msg).catch(() => msg.text())
      : Promise.resolve(args.length > 1 ? formatConsoleArgs(args.map((arg) => arg.toString())) : msg.text());
    // The browser's own entries (no values) are never a console call.
    // An older Playwright has no `timestamp()`, and a failure here must
    // not lose the line: the line then goes by its call site.
    const call = args.length === 0 || typeof msg.timestamp !== 'function' ? Promise.resolve(null)
      : stacks.then((s) => s?.call(msg.timestamp()) ?? null).catch(() => null);
    // Never rejects, as the queue has no one to report to: a line that
    // fails is lost.
    pending = pending.then(async () => log(msg, await text, await call)).catch(() => undefined);
  });
  // Which page load the lines after it came from.
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    emit({ source: 'event', kind: 'load', tab: n, text: `Loaded ${frame.url()}`, streamed: false });
  });
  // The uncaught error's stack is not mapped, and must not be:
  // `pageErrorSource` drops a script's throw the host already reported by
  // finding the script's `.user.js` URL in it (`SCRIPT_BODY_FRAME`), and
  // a throw inside a `@require` carries that URL only unmapped. Only the
  // message is printed anyway.
  page.on('pageerror', (err) => {
    const stack = err.stack ?? err.message;
    // Another manager reports no errors, so each is the page's to show.
    const source = pageErrorSource(stack, !host.external, host.external?.prefix);
    if (!source) return;
    emit({ source, ...SCRIPT_IN_PAGE[source], kind: 'error', tab: n, scriptId: source === 'script' ? host.scriptOf([stack]) : undefined, text: decodeOwnRefs(err.message) });
  });
}

/** A console call as the protocol reports it: its stack's URLs, and the world it ran in. */
interface ConsoleCall {
  frames: string[];
  extensionWorld: boolean;
}

// How long a console line waits for the protocol's copy of its call,
// and how many unclaimed copies are kept.
const CALL_WAIT_MS = 250;
// How long the tab's protocol session has to open before lines stop
// waiting for it.
const STACKS_ATTACH_MS = 3000;
const CALLS_KEPT = 500;

type ConsoleApiCalled = {
  executionContextId: number;
  timestamp: number;
  stackTrace?: StackTrace;
};
type StackTrace = { callFrames: { url: string }[]; parent?: StackTrace };

/**
 * A tab's console calls as the protocol (CDP) reports them on a session
 * of the run's own, for what Playwright's console event leaves out: the
 * whole stack, and the JavaScript world the call ran in. Paired with
 * Playwright's event by the call's timestamp, which both carry.
 */
class ConsoleStacks {
  // Copies not yet claimed, and lines waiting for theirs, by timestamp.
  private readonly calls = new Map<number, ConsoleCall[]>();
  private readonly waiting = new Map<number, ((call: ConsoleCall) => void)[]>();
  // The tab's JavaScript worlds that are SourceMonkey's (`USER_SCRIPT`).
  private readonly extensionWorlds = new Set<number>();

  /** Null when the tab can't be read so (closed already). */
  static async attach(page: Page, extensionOrigin: string): Promise<ConsoleStacks | null> {
    try {
      const session = await page.context().newCDPSession(page);
      const stacks = new ConsoleStacks();
      session.on('Runtime.executionContextCreated', ({ context }) => {
        if (context.origin === extensionOrigin) stacks.extensionWorlds.add(context.id);
      });
      session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => stacks.extensionWorlds.delete(executionContextId));
      session.on('Runtime.executionContextsCleared', () => stacks.extensionWorlds.clear());
      session.on('Runtime.consoleAPICalled', (event) => stacks.heard(event as ConsoleApiCalled));
      await session.send('Runtime.enable');
      return stacks;
    } catch {
      return null;
    }
  }

  /** The call Playwright reported at `timestamp`; null when its copy doesn't come in time. */
  call(timestamp: number): Promise<ConsoleCall | null> {
    const known = this.calls.get(timestamp);
    if (known) {
      const call = known.shift()!;
      if (known.length === 0) this.calls.delete(timestamp);
      return Promise.resolve(call);
    }
    return new Promise((resolve) => {
      const take = (call: ConsoleCall): void => {
        clearTimeout(timer);
        resolve(call);
      };
      const timer = setTimeout(() => {
        const list = this.waiting.get(timestamp);
        list?.splice(list.indexOf(take), 1);
        if (list?.length === 0) this.waiting.delete(timestamp);
        resolve(null);
      }, CALL_WAIT_MS);
      this.waiting.set(timestamp, [...this.waiting.get(timestamp) ?? [], take]);
    });
  }

  private heard(event: ConsoleApiCalled): void {
    const frames: string[] = [];
    for (let trace = event.stackTrace; trace; trace = trace.parent) frames.push(...trace.callFrames.map((f) => f.url));
    const call = { frames, extensionWorld: this.extensionWorlds.has(event.executionContextId) };
    const waiter = this.waiting.get(event.timestamp)?.shift();
    if (waiter) {
      if (this.waiting.get(event.timestamp)?.length === 0) this.waiting.delete(event.timestamp);
      waiter(call);
      return;
    }
    // Enabling the protocol's console replays the calls before it,
    // which no line will claim: the oldest go past a cap.
    this.calls.set(event.timestamp, [...this.calls.get(event.timestamp) ?? [], call]);
    if (this.calls.size > CALLS_KEPT) this.calls.delete(this.calls.keys().next().value!);
  }
}

// Re-prepare and re-push on any change to a script or a file it
// loads, then reload so the new version runs. Debounced: an editor
// save is often two writes. The parent directories are watched rather
// than the files, because an editor that saves by writing a temp file
// and renaming it over the original leaves a per-file watch on the old
// inode, silent from the first save on.
//
// `onChange` does the re-preparing. `watch` starts over on a new set
// of scripts, after `load` adds one or a save changes its @requires.
interface FileWatcher {
  /** Returns how many files are watched now. */
  watch(scripts: PreparedScript[]): number;
  stop(): void;
}

function watchFiles(
  opts: RunOptions,
  prepared: PreparedScript[],
  onChange: () => Promise<void>,
): FileWatcher {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let watchers: FSWatcher[] = [];
  // One change at a time: a save landing while the last is still being
  // applied waits for it.
  let running: Promise<void> = Promise.resolve();
  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      running = running.then(onChange).catch((err) => opts.out(`[sm-dev] Re-inject failed: ${(err as Error).message}`));
    }, 150);
  };
  const watcher: FileWatcher = {
    watch(scripts) {
      // Not again once stopped, or its handles would keep the process
      // alive.
      if (stopped) return 0;
      for (const w of watchers) w.close();
      const files = new Set<string>();
      for (const p of scripts) {
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
      watchers = [...dirs].map(([dir, names]) => watch(dir, (_event, name) => {
        if (typeof name === 'string' && names.has(name)) trigger();
      }));
      return files.size;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
  const count = watcher.watch(prepared);
  opts.out(`[sm-dev] Watching ${count} file(s). Press Ctrl-C to stop.`);
  return watcher;
}

/**
 * What a call into SourceMonkey throws in a run under another manager,
 * which has no SourceMonkey to call.
 */
export function runUses(manager: ManagerName): string {
  return `This needs SourceMonkey, and the run uses ${MANAGERS[manager].label} (${managerFlag(manager)})`;
}
