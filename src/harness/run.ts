// `sm-dev start`'s run: connect to a browser, inject one or more scripts
// from disk, load the page, and log what happens, taking commands from
// clients over its socket until stopped.
//
// Kept apart from cli.ts so the Node-only commands (`validate`,
// `match`) never load Playwright, which is an optional peer dependency.

import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { shellWord } from './command-lines.js';
import {
  commandOutput, commandRunner, DialogTracker, gotoInTab, inCommand, leaveDialogsOpen, onlyInspects, reloadTab, reloadable, serveSavedPage, setCommandsListening, skippedScriptLine, targetIdSuffix,
  warnSavedUserscripts, type CommandRunner, type ConsoleContext, type ControlledTab, type OutputHistory,
} from './console-commands.js';
import { DevToolsLink } from './devtools.js';
import { ExtensionBackend, extensionLabel, sourceMonkeyState, type LogEntry } from './extension-backend.js';
import { launchExtensionBrowser } from './extension-launch.js';
import { HarnessHost, type ErrorReport, type SkipReport, type StartReport } from './host.js';
import { attachPage, targetIdOf, type PageAttachment } from './inject.js';
import { pageSays, recordLog } from './page-commands.js';
import { showConsoleLine, showPageError } from './page-output.js';
import {
  defaultPageUrl, explainMatch, isDirectoryMessage, NO_DEFAULT_PAGE, noSuchFileMessage, preparedScriptPath, prepareScript, shownPath, warningLines, type PreparedScript,
} from './prepare.js';
import { comparableUrl, openingSavedLine, routeSavedPage, savedPageServe, type SavedPageStart } from './saved-pages.js';
import { browserSentence, checkRunsDir, ownRunsDir, processAlive, RunControl, runTabsPath, type RunRecord, type SentCommand, type SentLineHandler } from './runs.js';
import { cspBlocksPageScripts, sandboxedPageWarning } from '../missing-scripts.js';
import { remapStackText } from '../stack-link.js';
import type { StackLayout } from '../composed-source.js';
import { waitForStuckTabs } from './stuck-tabs.js';
import { NO_TABS } from './tab-refs.js';
import { settleTabs } from './wait.js';

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
   * Open no tab at startup. The typed `newtab` opens one later, and
   * with `--extension` the scripts run in whatever tabs the person
   * browses to.
   */
  noTab?: boolean;
  /** Re-inject and reload whenever a script or one of its files changes. */
  watch?: boolean;
  /** Seed `GM_*` storage for every script before it runs. */
  values?: Record<string, unknown>;
  /** With `extension`: disable every other collection for the run. */
  solo?: boolean;
  /** Also stream the page's own errors, not just ones from the scripts. */
  pageErrors?: boolean;
  /**
   * Start a DevTools background server for the run, and find each tab's
   * page id in it. Needs a browser connected over CDP, and the harness
   * backend.
   */
  devtools?: boolean;
  collectionRoot: string;
  localRoots: string[];
  /** Where the stream goes. */
  out: (line: string) => void;
  /** Resolves when the run should end (stop, a signal, --seconds). Omit to return after the first load. */
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
   * stop following the run, for `--idle-seconds` to count from. `watched`:
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
}

// How the browser commands reach a browser: connect to one over CDP
// (the default, for the developer's own logged-in browser) or launch
// a fresh Chromium (`--temp-browser`).
export interface ConnectOptions {
  cdp?: string;
  /** `--temp-browser`: launch a Chromium of the run's own instead. */
  tempBrowser?: boolean;
  /**
   * Use the real extension in the browser: the script is pushed into
   * its Scratch collection as text rather than injected by the harness.
   * A `tempBrowser` loads the package's own build of it.
   */
  extension?: boolean;
  headed?: boolean;
  /** Resolves to give up connecting (--seconds): ends a wait for tabs that don't answer. */
  until?: Promise<void>;
}

/**
 * A `--cdp` value as a URL Playwright can connect to: a port alone
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

// `--cdp`, else $SM_DEV_CDP, else port 9233. Empty counts as unset, so
// an exported-but-blank variable doesn't become `http://`.
function cdpSetting(opts: ConnectOptions): string {
  return cdpEndpoint(opts.cdp?.trim() || process.env.SM_DEV_CDP?.trim() || '9233');
}

export interface BrowserSession {
  browser: Browser;
  /** The browser's CDP endpoint, a launched one's too. */
  endpoint: string;
  /** Launched for this run (`--temp-browser`), and closed with it. */
  launched: boolean;
  /** Running without a window. */
  headless: boolean;
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
 * it is one an earlier, finished run opened, rather than opening
 * another. See `openRunTab`.
 */
export async function connectBrowser(
  opts: ConnectOptions,
  out: (line: string) => void,
  { reuseTab = false } = {},
): Promise<BrowserSession | null> {
  return openBrowser(opts, out, { reuseTab, openTab: true });
}

// A port free on this machine now, for a launched browser's CDP.
// Something else could take it before the browser does; the browser
// still starts (Playwright talks to it over a pipe), and only what
// `list` shows would be wrong. (A launch with the extension, which the
// run reaches through its port, has Chrome pick one instead.)
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
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
  opts: ConnectOptions, out: (line: string) => void, o: { reuseTab: boolean; openTab: true },
): Promise<BrowserSession | null>;
async function openBrowser(
  opts: ConnectOptions, out: (line: string) => void, o: { reuseTab: boolean; openTab: boolean },
): Promise<RunSession | null>;
async function openBrowser(
  opts: ConnectOptions,
  out: (line: string) => void,
  { reuseTab, openTab }: { reuseTab: boolean; openTab: boolean },
): Promise<RunSession | null> {
  const { chromium } = await import('@playwright/test');
  let browser: Browser;
  // Set for a connected browser only.
  let endpoint: string | null = null;
  // A launched one gets a port too, so other tools (a debugger, a
  // second Playwright) can connect to it, and `list` can say where.
  let launchedAt: string | null = null;
  // Closes a browser launched with the extension, which the run reaches
  // over a CDP connection of its own (see extension-launch.ts).
  let closeLaunched: (() => Promise<void>) | undefined;
  if (opts.tempBrowser && opts.extension) {
    let launched;
    try {
      launched = await launchExtensionBrowser(opts.headed === true);
    } catch (err) {
      out(`Could not launch a browser with SourceMonkey: ${(err as Error).message}`);
      return null;
    }
    closeLaunched = launched.close;
    try {
      browser = await chromium.connectOverCDP(launched.endpoint);
    } catch (err) {
      await launched.close();
      out(`Could not connect to the browser launched with SourceMonkey: ${(err as Error).message}`);
      return null;
    }
    launchedAt = launched.endpoint;
  } else if (opts.tempBrowser) {
    const port = await freePort();
    // Muted when hidden: a page's sound (a video site's autoplay) has
    // no window to say where it comes from. A headed one keeps it.
    const args = [`--remote-debugging-port=${port}`, ...(opts.headed ? [] : ['--mute-audio'])];
    browser = await chromium.launch({ headless: !opts.headed, args });
    launchedAt = cdpEndpoint(String(port));
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
      out(`Could not connect to a browser at ${endpoint}: ${message}`);
      out('Start one with sm-dev --open-browser, pass --cdp, or use --temp-browser');
      return null;
    }
  }
  const context = browser.contexts()[0] ?? await browser.newContext();
  if (endpoint !== null) browser.contexts().forEach(leaveDialogsOpen);
  const page = !openTab ? null
    // The one blank tab a launch with the extension leaves for the run.
    : closeLaunched ? context.pages()[0] ?? await context.newPage()
    : reuseTab && endpoint !== null
      ? await openRunTab(browser, context, endpoint, out).catch(() => context.newPage())
      : await context.newPage();
  return {
    browser,
    endpoint: endpoint ?? launchedAt!,
    launched: endpoint === null,
    headless: endpoint === null ? !opts.headed : await isHeadless(browser),
    context,
    page,
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

// ---------- Reusing a run's tab ----------

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
      const id = await targetIdOf(candidate);
      if (id && free.has(id) && await isSelected(candidate)) {
        page = candidate;
        break;
      }
    }
  }
  if (page) out('[sm-dev] Reusing the selected tab, which an earlier run opened');
  page ??= await context.newPage();
  const id = await targetIdOf(page);
  if (!id) return page;
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
  const remote = new Remote(opts.out, opts.onStop, opts.onActivity, opts.primaryPid);
  // Every line also goes to whoever sent the command running now.
  opts = { ...opts, out: remote.out, typed: new Map(opts.files.map((file, i) => [file, opts.given?.[i] ?? file])) };
  const session = await openBrowser(opts, opts.out, { reuseTab: true, openTab: !opts.noTab });
  if (!session) return 1;
  // Which browser, for the stream and the log.
  const browserIs = { browser: session.endpoint, owned: session.launched, headless: session.headless };
  const extension = extensionLabel(await sourceMonkeyState(session.endpoint));
  opts.out(`[sm-dev] ${capitalized(browserSentence(browserIs, session.launched ? 'launched' : 'connected to'))} (Chrome ${session.browser.version()}${extension ? `, ${extension}` : ''})`);
  opts.onConnected?.();
  // Only a run that waits for commands can be sent any.
  if (opts.until) {
    await remote.open({
      pid: process.pid,
      started: Date.now(),
      browser: session.endpoint,
      ...(session.launched ? { owned: true } : {}),
      ...(session.headless ? { headless: true } : {}),
      scripts: opts.files,
      ...(opts.detached ? { detached: true } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    }, opts.runId);
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
    return opts.extension ? await runInExtension(opts, session, remote, held) : await runInHarness(opts, session, held, remote);
  } finally {
    ending = true;
    // No sent command runs against tabs being let go.
    remote.disarm();
    // While the tabs are still attached, so a DevTools lookup in flight
    // can delete its markers from them.
    await held.devtools?.stop();
    // Also on a throw partway through, so a failed run leaves no
    // attachment behind in a browser the developer keeps using.
    await held.tabs?.dispose().catch(() => undefined);
    await held.attachment?.dispose().catch(() => undefined);
    await session.done().catch(() => undefined);
    // On every way out, so a page tested after this is never taken
    // for one the run still controls. Its registrations are gone, but
    // script code already running in an open page runs on.
    const run = remote.id ? `Run ${remote.id}` : 'The run';
    opts.out(!held.injected ? `[sm-dev] ${run} ended`
      // A launched browser's extension goes with it.
      : opts.extension && session.launched ? `[sm-dev] ${run} ended`
      : opts.extension ? `[sm-dev] ${run} ended. The scripts stay in the extension's Scratch collection; sm-dev clear --extension removes them.`
        : `[sm-dev] ${run} ended. Pages still have previously loaded scripts.`);
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

// How many lines of output `wait log` can look back over.
const HISTORY_LINES = 5000;

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
  private readonly listeners = new Set<(line: string) => void>();
  // The run's recent output, numbered, for `wait log`; the oldest go
  // past a cap.
  private readonly history: string[] = [];
  private historyStart = 0;
  private readonly watchers = new Set<(line: string) => void>();
  readonly output: OutputHistory = {
    mark: () => this.historyStart + this.history.length,
    since: (from) => this.history.slice(Math.max(0, from - this.historyStart)),
    watch: (listener) => {
      this.watchers.add(listener);
      return () => { this.watchers.delete(listener); };
    },
  };

  // The run's stream is its log, and every command comes from a
  // client, so a command that changes something is marked there as
  // `> command`, for where it happened among what the page printed.
  // `primaryPid`: the client that started the run, whose commands are
  // marked as the primary's.
  constructor(
    private readonly print: (line: string) => void,
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
    for (const listener of this.listeners) listener(line);
    // Only what the page and scripts printed on their own: not a
    // command's own reply (see inCommand).
    if (inCommand.getStore()) return;
    this.history.push(line);
    if (this.history.length > HISTORY_LINES) {
      this.history.shift();
      this.historyStart++;
    }
    for (const watcher of [...this.watchers]) watcher(line);
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

  private readonly follow = (reply: (line: string) => void): (() => void) => {
    this.listeners.add(reply);
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
      if (!sent.follows) this.listeners.add(reply);
      this.onStop?.();
      return 'hold';
    }
    if (!this.runner && !this.ending) reply('[sm-dev] The run is still starting. The command runs once it is ready.');
    await this.armed;
    if (this.ending || !this.runner) {
      reply('[sm-dev] The run is ending, so the command was not run');
      return 1;
    }
    const hooks = { cwd: sent.cwd, words: sent.words, interactive: sent.source === 'prompt' };
    // One that only looks answers its sender alone. One that changes
    // things prints to the stream, which a following sender gets
    // anyway; another gets it while the command runs.
    return this.runner(line, inspects ? { ...hooks, answer: reply }
      : sent.follows ? hooks
        : { ...hooks, start: () => this.listeners.add(reply), end: () => this.listeners.delete(reply) });
  };
}

async function runInHarness(
  opts: RunOptions,
  session: RunSession,
  held: Held,
  remote: Remote,
): Promise<number> {
  const { page } = session;
  const host = new HarnessHost();
  // Commands are only read once the page has loaded, but a prompt
  // opened before then can still wait for a typed or sent accept.
  const commandsComing = opts.until !== undefined && remote.reachable;
  let devtools: DevToolsLink | null = null;
  const tabs = new FollowedTabs(host, opts, session.context, commandsComing, () => {
    remote.setTabs(tabs.list().length);
    devtools?.schedule();
  });
  held.tabs = tabs;
  // Named by the run's id, which `list` and `status` show, when it can
  // be: DevTools takes only hex (`D1` happens to be). A run other
  // shells can't reach has none, and a name start --run gave isn't hex,
  // so a random one stands in.
  if (opts.devtools && opts.until) {
    const name = remote.id && /^[0-9a-f]+$/i.test(remote.id) ? remote.id : randomBytes(3).toString('hex');
    devtools = new DevToolsLink(name, session.endpoint, () => tabs.list(), opts.out);
    held.devtools = devtools;
  }
  wireHostOutput(host, opts.out, (record) => tabs.prefixOf(record));
  // T1, unless `--notab`; then the first tab `newtab` opens is T1.
  if (page) {
    wirePageOutput(page, opts, true, (text) => host.remapStack(text));
    wireSandboxCheck(page, () => tabs.firstTabScripts, opts.out);
    const dialogs = await DialogTracker.attach(page, opts.out, { visible: browserVisible(opts), commandsComing });
    // Attached before preparing, so a reused tab already on a secure
    // page gives the scripts' GM_info the browser's userAgentData.
    // Otherwise it stays null (see TODO.md).
    const attachment = await attachPage(page, host);
    held.attachment = attachment;
    await attachment.showBadge();
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
  const injected = (script: PreparedScript): void =>
    opts.out(`[sm-dev] Injected ${preparedScriptPath(script)} in world ${script.world}, run-at ${script.runAt}`);
  // Put `next` in place everywhere, and reload the tabs `changed` affects.
  const apply = async (next: PreparedScript[], changed: ScriptChange[], none: string): Promise<void> => {
    for (const c of changed) injected(c.next);
    scripts = next;
    if (next.length > 0) held.injected = true;
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
    await tabs.apply(next, changed, none);
  };
  // `update`, and a `--watch` save: re-read the scripts at `which`
  // (every one, when not given) whose files have been modified since
  // they were read; a touch counts. One that no longer prepares leaves
  // every one as it was.
  const update = (which?: number[]): Promise<void> => serial(async () => {
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
    await apply(next, changed, 'No open tab runs or matches the updated scripts, so none was reloaded');
  });
  const load = (input: string): Promise<void> => serial(async () => {
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
      opts.out(`[sm-dev] ${input} is already loaded, as script ${already + 1}. Type update ${already + 1} to re-read it.`);
      return;
    }
    opts.typed?.set(file, input);
    const fresh = await prepareAll(opts, [file]);
    if (!fresh || stopping) return;
    const script = fresh[0];
    const n = scripts.length + 1;
    files.push(file);
    remote.setScripts(files);
    stamps.set(script, await filesStamp(script));
    if (opts.values) host.seedValues(script.spec!.id, opts.values);
    opts.out(`[sm-dev] Loaded ${input} as script ${n}`);
    await apply([...scripts, script], [{ next: script }], `No open tab matches it, so none was reloaded. Type open ${n} to open its page.`);
  });
  // Seeded once. An update keeps the store, so values the script wrote
  // since survive it.
  if (opts.values) for (const script of prepared) host.seedValues(script.spec!.id, opts.values);
  for (const script of prepared) injected(script);
  await tabs.setScripts(prepared);
  if (prepared.length > 0) held.injected = true;
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
      ...(t1 && urls[0] ? [tabs.navigate(t1, urls[0])] : []),
      ...opened.map(({ tab, url }) => tabs.navigate(tab, url)),
    ]);
    printSkipped(opts, start);
  } else {
    opts.out(NO_TABS);
  }

  try {
    if (opts.watch) {
      watcher = watchFiles(opts, prepared, async () => {
        opts.out('[sm-dev] Change detected, re-injecting');
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
      if (!opts.noWait) await settleTabs(host, tabs.list(), opts.out);
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
        updateScripts: (which) => update(which?.map((s) => scripts.indexOf(s)).filter((i) => i >= 0)),
        scripts,
        out: opts.out,
        stop: () => opts.onStop?.(),
        runId: remote.id,
        ...(opts.log ? { log: opts.log } : {}),
        devtools: () => (devtools?.isUp ? devtools.usage : null),
        browser: browserSentence({ browser: session.endpoint, owned: session.launched, headless: session.headless }),
        extension: () => sourceMonkeyState(session.endpoint),
        output: remote.output,
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

interface Held {
  attachment?: PageAttachment;
  tabs?: FollowedTabs;
  devtools?: DevToolsLink;
  /** Set once any script was injected or pushed, for the run's last line. */
  injected?: boolean;
}

// Tabs the run's tab opens, by a link, `window.open` or `GM_openInTab`,
// and the tabs those open, get the loaded scripts too: the extension
// would inject whatever matches them. Tabs the person opens themselves
// have no opener, and are left alone.
//
// Playwright reports a new tab only once its document has committed,
// so the scripts also run in that current document. `document-idle`
// ones, most scripts, run as they would; an earlier one can run late,
// and the run says so. Getting in first would take holding the tab
// before it loads, which needs the browser's flat protocol sessions
// that Playwright doesn't expose.
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

  constructor(
    private readonly host: HarnessHost,
    private readonly opts: RunOptions,
    private readonly context: BrowserContext,
    // Whether typed commands will be read, so a new tab's dialog waits
    // for a typed answer rather than being dismissed.
    private readonly commandsComing: boolean,
    // Called as tabs join the list or close.
    private readonly onTabsChanged: () => void = () => undefined,
  ) {}

  /** Register the run's own tab as T1, and follow the tabs it opens. */
  async start(page: Page, attachment: PageAttachment, dialogs: DialogTracker): Promise<void> {
    this.first = { n: 1, page, link: attachment, dialogs, targetId: await targetIdOf(page) };
    this.firstAttachment = attachment;
    this.nextNumber = 2;
    this.numbers.set(attachment, 1);
    this.follow(attachment, 1);
    page.on('close', () => {
      if (this.disposed) return;
      this.opts.out('[sm-dev] Tab T1 closed');
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

  /**
   * `[T2] ` for a host report from a followed tab, so its lines say
   * where they came from as its page output does; empty for T1's.
   */
  prefixOf(record: object): string {
    const link = this.host.pageOf(record);
    const n = link && this.numbers.get(link);
    return n && n > 1 ? `[T${n}] ` : '';
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
  async apply(next: PreparedScript[], changed: ScriptChange[], none: string): Promise<void> {
    this.scripts = next;
    const open = this.open();
    const affected = open.filter(({ tab }) => changed.some((c) =>
      (c.old?.spec && this.host.isRunning(tab.link, c.old.spec.id))
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
      if (reload.includes(tab)) await reloadTab(tab, this.host, this.opts.out);
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
    // Link and `window.open` tabs stay open, as under the extension;
    // `GM_openInTab` ones close with their opener's attachment.
    for (const { attachment } of this.tabs.values()) await attachment.dispose().catch(() => undefined);
    this.tabs.clear();
  }

  // Adopt the tabs `attachment`'s page (tab `opener`) opens from now on.
  private follow(attachment: PageAttachment, opener: number): void {
    attachment.page.on('popup', (tab) => this.adopt(tab, opener));
    attachment.onOpenedTab = (tab) => this.adopt(tab, opener);
  }

  private adopt(page: Page, opener: number): void {
    if (this.disposed || this.tabs.has(page)) return;
    const n = this.nextNumber++;
    // A tab without scripts opens more of its kind.
    const noScript = this.list().find((t) => t.n === opener)?.noScript === true;
    this.track(this.setUp(page, n, opener, true, noScript).catch((err) => {
      // Closed while being set up is the usual cause, and says nothing.
      if (page.isClosed()) return;
      this.opts.out(noScript
        ? `[sm-dev] T${n} could not be set up: ${(err as Error).message}`
        : `[sm-dev] The scripts could not be injected into T${n}: ${(err as Error).message}`);
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
  async newTab(url?: string, { noScript = false, saved }: { noScript?: boolean; saved?: SavedPageStart } = {}): Promise<ControlledTab> {
    const tab = await this.createTab(noScript);
    if (saved) await serveSavedPage(tab, saved, this.opts.out, noScript || this.scripts.length === 0);
    this.announce(tab, url);
    if (url) await this.navigate(tab, url);
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
      try {
        await this.setUp(page, n, undefined, false, noScript);
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

  /** The line a tab the run opens gets: where it's going, and its id. */
  announce(tab: ControlledTab, url?: string): void {
    const saved = url && tab.saved && comparableUrl(url) === comparableUrl(tab.saved.url) ? tab.saved : undefined;
    this.opts.out(saved ? `${openingSavedLine(saved.given, url!, `T${tab.n}`)}${targetIdSuffix(tab.targetId)}`
      : url ? `[sm-dev] Opening ${url} in T${tab.n}${targetIdSuffix(tab.targetId)}`
      : `[sm-dev] Tab T${tab.n} opened${targetIdSuffix(tab.targetId)}`);
  }

  async navigate(tab: ControlledTab, url: string): Promise<void> {
    await gotoInTab(tab, this.host, url, this.opts.out);
  }

  private track(work: Promise<unknown>): void {
    const settled = work.catch(() => undefined).finally(() => this.adopting.delete(settled));
    this.adopting.add(settled);
  }

  // `opener` is the tab that opened this one; none for `newtab`.
  // `announce`: say it opened; the run's own tabs are announced by
  // their caller instead, with where they are going. `noScript`: no
  // scripts are injected, and none are later.
  private async setUp(page: Page, n: number, opener?: number, announce = true, noScript = false): Promise<void> {
    // T1 goes unprefixed, as the run's own does, when `--notab` makes
    // the first tab opened T1.
    const out = n === 1 ? this.opts.out : (line: string): void => this.opts.out(`[T${n}] ${line}`);
    // First, so a tab that closes during the awaits below is still
    // noticed.
    let announced = false;
    page.on('close', () => {
      this.tabs.delete(page);
      if (!announced || this.disposed) return;
      this.opts.out(`[sm-dev] Tab T${n} closed`);
      this.onTabsChanged();
    });
    wirePageOutput(page, { ...this.opts, out }, true, (text) => this.host.remapStack(text));
    // Not for a tab with no scripts, which gets none either way. Read
    // from the tab once it exists, since `open --script` switches it.
    let tabNow: ControlledTab | null = null;
    wireSandboxCheck(page, () => ((tabNow?.noScript ?? noScript) ? [] : this.scripts), out);
    const dialogs = await DialogTracker.attach(page, out, {
      visible: browserVisible(this.opts),
      commandsComing: this.commandsComing,
    });
    const attachment = await attachPage(page, this.host);
    this.numbers.set(attachment, n);
    // Its count would be of scripts that are kept out on purpose.
    if (!noScript) await attachment.showBadge();
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
    if (announce) this.opts.out(`[sm-dev] Tab T${n} opened${loaded ? ` at ${url}` : ''}${noScript ? ' (no scripts)' : ''}${opener ? `, from T${opener}` : ''}${targetIdSuffix(targetId)}`);
    if (noScript) {
      this.follow(attachment, n);
      entry.ready = true;
      return;
    }
    const readyState = await page.evaluate(() => document.readyState).catch(() => null);
    const initial = this.scripts;
    let scripts = initial;
    // A document that committed before the attachment reports no
    // navigation, so a miss on it is noted here. Before injecting, as
    // it also clears the document's menu commands, which the scripts
    // are about to register.
    if (loaded) this.host.noteNavigation(attachment, scripts);
    for (const script of scripts) await attachment.inject(script, { immediately: true });
    this.follow(attachment, n);
    // A `load`, `update` or `--watch` save while this tab was being set
    // up passed it by. Brought up to date here, before it is ready for
    // the next one.
    while (this.scripts !== scripts) {
      scripts = this.scripts;
      await this.swapScripts(attachment, scripts);
      await page.reload().catch(() => undefined);
    }
    entry.ready = true;
    if (scripts !== initial) return;
    if (!loaded) return;
    for (const script of scripts) {
      if (!explainMatch(script.matching, url).matches || !ranLate(script, readyState)) continue;
      this.opts.out(`[sm-dev] Tab T${n} had already started loading, so ${preparedScriptPath(script)} (run-at ${script.runAt}) may have run later there than it would in the extension`);
    }
  }

  /**
   * Switches a tab to running no scripts, or back to running them, for
   * `open --noscript` / `--script`. It lasts: every page the tab loads
   * from then on goes the new way, until switched again. Its scripts
   * and badge come off or go back on here; the page it's showing keeps
   * what it has until the next load.
   */
  async setNoScript(tab: ControlledTab, noScript: boolean): Promise<void> {
    if ((tab.noScript === true) === noScript) return;
    // Its setup would put back what this takes off.
    if (tab !== this.first && [...this.tabs.values()].some((t) => t.tab === tab && !t.ready)) {
      throw new Error('It\'s still being set up. Try again in a moment.');
    }
    if (noScript) {
      await this.swapScripts(tab.link, []);
      await tab.link.hideBadge();
    } else {
      await this.swapScripts(tab.link, this.scripts);
      await tab.link.showBadge();
    }
    // Once done, so a failed switch leaves the tab as it was for `load`
    // and `update`.
    tab.noScript = noScript;
  }

  // `scripts` in place of what `attachment` has, from index `from` on.
  private async swapScripts(attachment: PageAttachment, scripts: PreparedScript[], from = 0): Promise<void> {
    const keep = new Set(scripts.slice(0, from).map((s) => s.spec!.id));
    for (const old of attachment.injectedScripts()) {
      if (!keep.has(old.spec!.id)) await attachment.remove(old.spec!.id);
    }
    for (const script of scripts.slice(from)) await attachment.inject(script);
  }
}

// Whether a script injected into a document already in `readyState`
// missed the moment its run-at names. Idle waits for the load, so it is
// never late; start is, once the page's own scripts may have run.
function ranLate(script: PreparedScript, readyState: string | null): boolean {
  if (script.runAt === 'document-idle') return false;
  if (script.runAt === 'document-start') return true;
  return readyState !== 'loading';
}

// The extension backend: push the files' text into SourceMonkey and
// read its Log tab, instead of preparing and injecting. `prepareAll`
// still runs first so a header or syntax problem is reported here with
// the same wording, before anything reaches the extension.
async function runInExtension(opts: RunOptions, session: RunSession, remote: Remote, held: Held): Promise<number> {
  const { context, page } = session;
  // Set as the run ends, when a launched browser's tabs close with it.
  let ended = false;
  // Nothing to run a command against: the extension runs the scripts.
  remote.arm(async (_line, hooks) => {
    hooks?.start?.();
    opts.out('[sm-dev] A run with --extension takes no commands besides stop');
    hooks?.end?.();
    return 1;
  });
  let backend: ExtensionBackend;
  try {
    backend = await ExtensionBackend.connect(context);
  } catch (err) {
    opts.out(`[sm-dev] ${(err as Error).message}`);
    return 1;
  }
  const prepared = await prepareAll(opts);
  if (!prepared) return 1;
  const start = startPages(opts, prepared);
  if (!start) return 2;
  const { urls } = start;
  const pushed = new Map<string, string>();
  // The extension's per-script log is the report stream here; it is
  // polled, since nothing pushes it to Node. Only what this run adds is
  // printed, so each script's last printed entry is remembered rather
  // than a count: the log rotates at a cap, and a count would go quiet
  // once it did.
  const lastPrinted = new Map<string, LogEntry | null>();
  // Each pushed script's line layout, for stack lines in its Log
  // entries and the page's console lines.
  const layouts = new Map<string, StackLayout>();
  const remapStack = (text: string): string => remapStackText(text, layouts.values());
  let errors = 0;
  const pushAll = async (scripts: PreparedScript[]): Promise<boolean> => {
    for (const script of scripts) {
      const text = await readFile(fileURLToPath(script.script.fileUrl), 'utf8');
      const result = await backend.push(text, path.basename(script.script.relativePath));
      if (result.status !== 'ok') {
        opts.out(`INVALID  ${typedName(opts, fileURLToPath(script.script.fileUrl))}\n    ${result.errorMessage ?? ''}`);
        return false;
      }
      pushed.set(result.scriptId, preparedScriptPath(script));
      const layout = await backend.stackLayout(result.scriptId).catch(() => null);
      if (layout) layouts.set(result.scriptId, layout);
      else layouts.delete(result.scriptId);
      held.injected = true;
      const entries = await backend.log(result.scriptId).catch(() => [] as LogEntry[]);
      lastPrinted.set(result.scriptId, entries[entries.length - 1] ?? null);
      opts.out(`[sm-dev] Pushed to Scratch: ${preparedScriptPath(script)}${result.replaced ? ' (replaced)' : ''}`);
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
          opts.out(`[sm-dev] ${name} ${entry.level}: ${remapStack(entry.message)}`);
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
    // With --all, one tab per page, named as the harness names them and
    // all loading at once. The extension injects into each itself, so
    // these are only watched for page output, dialogs and closing. Its
    // Log entries, polled below, carry no tab.
    // Set up together, announced in order, then loaded at once.
    const opened = await Promise.all(urls.map(async (url, i) => {
      const n = i + 1;
      let tabPage: Page;
      try {
        tabPage = i === 0 && page ? page : await context.newPage();
      } catch (err) {
        tabFailed(opts, start, prepared, url, err as Error);
        return null;
      }
      const out = i === 0 ? opts.out : (line: string): void => opts.out(`[T${n}] ${line}`);
      // Not once the run is ending: a launched browser closes its tabs then.
      tabPage.on('close', () => { if (!ended) opts.out(`[sm-dev] Tab T${n} closed`); });
      wirePageOutput(tabPage, { ...opts, out }, false, remapStack);
      wireSandboxCheck(tabPage, () => prepared, out);
      await DialogTracker.attach(tabPage, out, { visible: browserVisible(opts) });
      return { n, url, page: tabPage, targetId: await targetIdOf(tabPage), saved: start.saved[i] };
    }));
    // The extension's own injection sees the URL, so serving the saved
    // page is all it takes.
    for (const o of opened) {
      if (!o?.saved) continue;
      const { userscripts, ...file } = o.saved;
      warnSavedUserscripts(opts.out, file.given, { url: file.url, userscripts }, false);
      await routeSavedPage(o.page, () => savedPageServe(o.page, file, opts.out));
    }
    const pages: Page[] = [];
    for (const o of opened) {
      if (!o) continue;
      pages.push(o.page);
      opts.out(o.saved
        ? `${openingSavedLine(o.saved.given, o.url, `T${o.n}`)}${targetIdSuffix(o.targetId)}`
        : `[sm-dev] Opening ${o.url} in T${o.n}${targetIdSuffix(o.targetId)}`);
    }
    await Promise.all(opened.map((o) => o && o.page.goto(o.url)
      .catch((err) => opts.out(`[sm-dev] Navigation failed: ${(err as Error).message}`))));
    if (!page) opts.out('[sm-dev] No tab was opened. The scripts run in the pages you browse to.');
    printSkipped(opts, start);
    let watcher: FileWatcher | null = null;
    if (opts.watch) {
      watcher = watchFiles(opts, prepared, async () => {
        opts.out('[sm-dev] Change detected, re-pushing');
        const next = await prepareAll(opts);
        if (!next || !(await pushAll(next))) return;
        // All at once, so one slow page holds up no other.
        await Promise.all(pages.map((p) => p.reload().catch(() => undefined)));
        // With --notab the pages are the person's own, so theirs to reload.
        if (pages.length === 0) opts.out('[sm-dev] Reload your tabs to run the new version');
      });
    }
    const ticker = setInterval(() => { void poll(); }, 500);
    try {
      if (opts.until) {
        await poll();
        opts.onReady?.(remote.id);
        await opts.until;
      } else {
        await sleep(1000);
      }
    } finally {
      clearInterval(ticker);
      watcher?.stop();
    }
    while (polling) await new Promise((r) => setTimeout(r, 50));
    await poll();
  } finally {
    ended = true;
    if (opts.solo) await backend.solo(false).catch(() => undefined);
  }
  return errors === 0 ? 0 : 1;
}

// Resolve once each script in each tab's page has had its word there:
// started, skipped (a URL its rules don't cover) or thrown. Or after a
// grace period, for one that never says (a page that never loads).
async function waitForReports(host: HarnessHost, tabs: ControlledTab[], timeoutMs = 5000): Promise<void> {
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), timeoutMs);
  const gaveUp = new Promise<void>((resolve) => giveUp.signal.addEventListener('abort', () => resolve()));
  try {
    await Promise.race([
      // Not one whose load already gave up, and said so.
      Promise.all(tabs.filter((tab) => !tab.stalled).map((tab) => {
        const ids = tab.link.scriptsInDocument().filter((s) => s.spec).map((s) => s.spec!.id);
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

function sameEntry(a: LogEntry, b: LogEntry): boolean {
  return a.timestamp === b.timestamp && a.message === b.message && a.source === b.source;
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
function wireHostOutput(host: HarnessHost, print: (line: string) => void, prefix: (record: object) => string): void {
  const out = (record: object, line: string): void => print(prefix(record) + line);
  host.on('start', (r: StartReport) => out(r, `[sm-dev] ${r.name} started on ${r.url}`));
  host.on('skip', (r: SkipReport) => out(r, `[sm-dev] ${r.name} skipped on ${r.url}: ${r.reason}`));
  host.on('script-error', (r: ErrorReport) => {
    out(r, `[sm-dev] ${r.name} threw: ${r.message}`);
    if (r.stack) for (const line of r.stack.split('\n').slice(1, 4)) out(r, `    ${line.trim()}`);
  });
  host.on('log', (r) => out(r, `[sm-dev] ${r.name} GM_log: ${r.message}`));
  host.on('request', (r) => out(r, `[sm-dev] GM_xmlhttpRequest ${r.method} ${r.url}: ${r.outcome}${r.status ? ' ' + r.status : ''}${r.error ? ' ' + r.error : ''}`));
  host.on('tab', (r) => out(r, `[sm-dev] GM_openInTab ${r.url}`));
  host.on('menu-command', (r) => out(r, `[sm-dev] GM_registerMenuCommand "${r.name}"`));
  host.on('notification', (r) => out(r, `[sm-dev] GM_notification "${r.title || r.text}"`));
  host.on('download', (r) => out(r, `[sm-dev] GM_download ${r.url}: ${r.outcome}${r.filename ? ' -> ' + r.filename : ''}${r.error ? ' ' + r.error : ''}`));
  host.on('value-write', (r) => {
    for (const w of r.writes) {
      out(r, w.deleted
        ? `[sm-dev] GM_deleteValue ${w.key}`
        : `[sm-dev] GM_setValue ${w.key} = ${shortValue(w.value)}`);
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
// src/missing-scripts.ts.
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

// `hostReports`: the harness host already prints a script's own throws,
// so the page's copy of those is skipped. See page-output.ts.
// `remapStack` points stack frames in a logged line (`console.error(err)`
// prints the stack) at the `@require` or script line they came from;
// see `HarnessHost.remapStack`.
function wirePageOutput(
  page: Page,
  opts: Pick<RunOptions, 'out' | 'pageErrors'>,
  hostReports: boolean,
  remapStack: (text: string) => string,
): void {
  const pageErrors = opts.pageErrors ?? false;
  page.on('console', (msg) => {
    const line = { type: msg.type(), text: remapStack(msg.text()), url: msg.location().url, argCount: msg.args().length };
    // Every line, for `logs`; the stream shows the script's.
    recordLog(page, `[${line.type}] ${line.text}`);
    if (showConsoleLine(line, pageErrors)) opts.out(`[page ${line.type}] ${line.text}`);
  });
  // Which page load each line came from.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) recordLog(page, `--- ${frame.url()}`);
  });
  // The uncaught error's stack is not mapped, and must not be:
  // `showPageError` drops a script's throw the host already reported by
  // finding the script's `.user.js` URL in it (`SCRIPT_BODY_FRAME`), and
  // a throw inside a `@require` carries that URL only unmapped. Only the
  // message is printed anyway.
  page.on('pageerror', (err) => {
    recordLog(page, `[error] ${err.message}`);
    if (showPageError(err.stack ?? err.message, { pageErrors, hostReports })) opts.out(`[page error] ${err.message}`);
  });
}

// Re-prepare and re-inject on any change to a script or a file it
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
