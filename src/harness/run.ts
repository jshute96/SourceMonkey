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

import { DialogTracker, readConsoleCommands, skippedScriptLine, type ConsoleContext, type ControlledTab } from './console-commands.js';
import { ExtensionBackend, type LogEntry } from './extension-backend.js';
import { HarnessHost, type ErrorReport, type SkipReport, type StartReport } from './host.js';
import { attachPage, type PageAttachment } from './inject.js';
import { showConsoleLine, showPageError } from './page-output.js';
import { defaultPageUrl, explainMatch, NO_DEFAULT_PAGE, prepareScript, type PreparedScript } from './prepare.js';

export interface RunOptions extends ConnectOptions {
  files: string[];
  /** The page to open. Defaults to the first URL the first script's `@match` implies. */
  url?: string;
  /**
   * Open each script's default page, one tab per distinct page, rather
   * than one page for the first script.
   */
  all?: boolean;
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
  /** Also stream the page's own errors, not just ones from the scripts. */
  pageErrors?: boolean;
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
const NO_URL_ALL = 'None of the scripts\' @match names a page to open. Use --url instead of --all.';

// The pages a run opens: `--url`, or the first script's default page,
// or with `--all` each script's, once per distinct page. Null, with
// the reason printed, when there is none.
interface StartPages {
  urls: string[];
  /** Scripts `--all` found no page for, printed once the rest are open. */
  skipped: { n: number; script: PreparedScript; reason: string }[];
}

function startPages(opts: RunOptions, prepared: PreparedScript[]): StartPages | null {
  if (!opts.all) {
    const url = opts.url ?? defaultPageUrl(prepared[0]);
    if (!url) opts.out(NO_URL);
    return url ? { urls: [url], skipped: [] } : null;
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
  return { urls: [...urls], skipped };
}

// Also for a page whose tab failed to open: every script it was for.
function skipScriptsOf(start: StartPages, prepared: PreparedScript[], url: string, reason: string): void {
  prepared.forEach((script, i) => {
    if (defaultPageUrl(script) === url) start.skipped.push({ n: i + 1, script, reason });
  });
}

function printSkipped(opts: RunOptions, start: StartPages): void {
  for (const s of [...start.skipped].sort((a, b) => a.n - b.n)) opts.out(skippedScriptLine(s.n, s.script, s.reason));
}

export async function run(opts: RunOptions): Promise<number> {
  const session = await connectBrowser(opts, opts.out, { reuseTab: true });
  if (!session) return 1;
  const held: Held = {};
  try {
    return opts.extension ? await runInExtension(opts, session) : await runInHarness(opts, session, held);
  } finally {
    // Also on a throw partway through, so a failed run leaves no
    // attachment behind in a browser the developer keeps using.
    await held.tabs?.dispose().catch(() => undefined);
    await held.attachment?.dispose().catch(() => undefined);
    await session.done().catch(() => undefined);
  }
}

async function runInHarness(
  opts: RunOptions,
  session: BrowserSession,
  held: Held,
): Promise<number> {
  const { page } = session;
  const host = new HarnessHost();
  // Commands are only read once the page has loaded, but a prompt
  // opened before then can still wait for a typed accept.
  const commandsComing = opts.until !== undefined && process.stdin.readable;
  const tabs = new FollowedTabs(host, opts, commandsComing);
  held.tabs = tabs;
  wireHostOutput(host, opts.out, (record) => tabs.prefixOf(record));
  wirePageOutput(page, opts, true);
  const dialogs = await DialogTracker.attach(page, opts.out, { visible: browserVisible(opts), commandsComing });
  // Attached before preparing, so the scripts' GM_info describes this
  // browser.
  const attachment = await attachPage(page, host);
  held.attachment = attachment;
  tabs.start(page, attachment, dialogs);
  const prepared = await prepareAll(opts);
  if (!prepared) return 1;
  const start = startPages(opts, prepared);
  if (!start) return 2;
  const { urls } = start;

  const injectAll = async (scripts: PreparedScript[]): Promise<void> => {
    for (const script of scripts) {
      // T1 may have been closed; the other tabs still get them.
      if (!page.isClosed()) await attachment.inject(script);
      opts.out(`[sm-dev] Injected ${script.script.relativePath} in world ${script.world}, run-at ${script.runAt}`);
    }
    await tabs.replaceScripts(scripts);
    // The typed commands' list too, keeping the `use` script by its place.
    if (commands) {
      const i = commands.current ? commands.scripts.indexOf(commands.current) : -1;
      commands.scripts = scripts;
      commands.current = scripts[i];
    }
  };
  let commands: ConsoleContext | null = null;
  // Seeded once. A watch re-inject keeps the store, so values the
  // script wrote since the last save survive the save.
  if (opts.values) for (const script of prepared) host.seedValues(script.spec!.id, opts.values);
  await injectAll(prepared);
  opts.out(`[sm-dev] Opening ${urls[0]}`);
  // With --all, the other scripts' pages too, each in a tab of its own,
  // all loading at once. `newTab` numbers them in call order.
  await Promise.all([
    page.goto(urls[0]).catch((err) => opts.out(`[sm-dev] Navigation failed: ${(err as Error).message}`)),
    ...urls.slice(1).map((url) => tabs.newTab(url)
      .catch((err) => skipScriptsOf(start, prepared, url, `The tab could not be opened: ${(err as Error).message}`))),
  ]);
  printSkipped(opts, start);
  if (opts.fireMenu) {
    // Registered from the script's body, so it exists once the script
    // has started; a short grace period covers a late registration.
    const name = opts.fireMenu;
    const deadline = Date.now() + 5000;
    let fired = false;
    let firedOn: ControlledTab | undefined;
    while (!fired && Date.now() < deadline) {
      // Only once it is registered, so an unrelated dialog opening
      // meanwhile can't pass for this command's. The newest on any
      // tab, as the extension's toolbar would have it on the tab it
      // is showing.
      const entry = [...host.reports.menuCommands].reverse().find((m) => m.name === name || m.commandId === name);
      firedOn = entry && tabs.list().find((t) => t.link === host.pageOf(entry));
      // Done once a dialog it opens is up, on the tab it ran in: that
      // page waits on it.
      fired = entry !== undefined && firedOn !== undefined
        && await (firedOn.dialogs ?? dialogs).untilDialog(host.fireMenuEntry(entry));
      if (!fired) await sleep(100);
    }
    const where = firedOn && firedOn.n > 1 ? ` on T${firedOn.n}` : '';
    opts.out(fired ? `[sm-dev] Fired menu command "${name}"${where}` : `[sm-dev] No menu command named "${name}" was registered`);
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
      commands = {
        host,
        tabs: () => tabs.list(),
        // T1 to start with, or whichever is open if T1 has closed.
        tab: tabs.list()[0],
        newTab: (url) => tabs.newTab(url),
        scripts: prepared,
        out: opts.out,
        stop: () => opts.onStop?.(),
      };
      stopCommands = readConsoleCommands(commands);
      await opts.until;
    } else {
      // One load's worth of output, then leave the page as it is. Not
      // the page's own timer: the script may have closed it.
      await sleep(500);
    }
  } finally {
    // Also on a throw, or stdin and the file watcher would keep the
    // process alive.
    stopCommands?.();
    watcher?.();
  }
  return host.reports.errors.length === 0 ? 0 : 1;
}

interface Held {
  attachment?: PageAttachment;
  tabs?: FollowedTabs;
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
  // T1, the run's own tab; set by `start`.
  private first!: ControlledTab;
  // The scripts every tab gets: the latest `--watch` set.
  private scripts: PreparedScript[] = [];
  // The rest, while they are open.
  private readonly tabs = new Map<Page, { tab: ControlledTab; attachment: PageAttachment }>();
  // Every tab's number by its attachment, kept after it closes, so a
  // report that arrives late (a request finishing) still says whose.
  private readonly numbers = new WeakMap<object, number>();
  // Tabs still being set up, so dispose can wait for them.
  private readonly adopting = new Set<Promise<unknown>>();
  private nextNumber = 2;
  private disposed = false;

  constructor(
    private readonly host: HarnessHost,
    private readonly opts: RunOptions,
    // Whether typed commands will be read, so a new tab's dialog waits
    // for a typed answer rather than being dismissed.
    private readonly commandsComing: boolean,
  ) {}

  /** Register the run's own tab as T1, and follow the tabs it opens. */
  start(page: Page, attachment: PageAttachment, dialogs: DialogTracker): void {
    this.first = { n: 1, page, link: attachment, dialogs };
    this.numbers.set(attachment, 1);
    this.follow(attachment, 1);
    page.on('close', () => {
      if (!this.disposed) this.opts.out('[sm-dev] Tab T1 closed');
    });
  }

  /** The controlled tabs still open, by number. */
  list(): ControlledTab[] {
    // Sorted: tabs opened together finish setting up in any order.
    const all = [this.first, ...[...this.tabs.values()].map((t) => t.tab)];
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

  /**
   * After a `--watch` re-prepare: swap in the new scripts and reload,
   * every tab at once, so one waiting on a dialog holds up no other.
   */
  async replaceScripts(scripts: PreparedScript[]): Promise<void> {
    this.scripts = scripts;
    await Promise.all([...this.tabs.values()].map(async ({ tab, attachment }) => {
      try {
        await this.swapScripts(attachment, scripts);
        await attachment.page.reload();
      } catch (err) {
        // A tab closing meanwhile needs no word; its close says it.
        if (!tab.page.isClosed()) this.opts.out(`[sm-dev] T${tab.n} could not be re-injected: ${(err as Error).message}`);
      }
    }));
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
    this.track(this.setUp(page, n, opener).catch((err) => {
      // Closed while being set up is the usual cause, and says nothing.
      if (!page.isClosed()) this.opts.out(`[sm-dev] The scripts could not be injected into T${n}: ${(err as Error).message}`);
    }));
  }

  /**
   * A new tab for `tabs new` and `--all`: controlled from the start, so
   * its first page loads with the scripts as the extension would run
   * them. Numbered before anything is awaited, so tabs opened together
   * are numbered in call order. Stays open when the run ends, like the
   * tabs the page opens.
   */
  async newTab(url?: string): Promise<ControlledTab> {
    if (this.disposed) throw new Error('The run is ending');
    const n = this.nextNumber++;
    const setUp = (async () => {
      const page = await this.first.page.context().newPage();
      try {
        await this.setUp(page, n);
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
    if (url) {
      this.opts.out(`[sm-dev] Opening ${url} in T${n}`);
      await page.goto(url).catch((err) => this.opts.out(`[sm-dev] Navigation failed: ${(err as Error).message}`));
    }
    return entry.tab;
  }

  private track(work: Promise<unknown>): void {
    const settled = work.catch(() => undefined).finally(() => this.adopting.delete(settled));
    this.adopting.add(settled);
  }

  // `opener` is the tab that opened this one; none for `tabs new`.
  private async setUp(page: Page, n: number, opener?: number): Promise<void> {
    const out = (line: string): void => this.opts.out(`[T${n}] ${line}`);
    // First, so a tab that closes during the awaits below is still
    // noticed.
    let announced = false;
    page.on('close', () => {
      this.tabs.delete(page);
      if (announced && !this.disposed) this.opts.out(`[sm-dev] Tab T${n} closed`);
    });
    wirePageOutput(page, { ...this.opts, out }, true);
    const dialogs = await DialogTracker.attach(page, out, {
      visible: browserVisible(this.opts),
      commandsComing: this.commandsComing,
    });
    const attachment = await attachPage(page, this.host);
    this.numbers.set(attachment, n);
    if (page.isClosed()) {
      await attachment.dispose().catch(() => undefined);
      return;
    }
    this.tabs.set(page, { tab: { n, page, link: attachment, dialogs, openedBy: opener }, attachment });
    const url = page.url();
    const loaded = url !== '' && url !== 'about:blank';
    announced = true;
    this.opts.out(`[sm-dev] Tab T${n} opened${loaded ? ` at ${url}` : ''}${opener ? `, from T${opener}` : ''}`);
    const readyState = await page.evaluate(() => document.readyState).catch(() => null);
    const { scripts } = this;
    // A document that committed before the attachment reports no
    // navigation, so a miss on it is noted here. Before injecting, as
    // it also clears the document's menu commands, which the scripts
    // are about to register.
    if (loaded) this.host.noteNavigation(attachment, scripts);
    for (const script of scripts) await attachment.inject(script, { immediately: true });
    this.follow(attachment, n);
    // A `--watch` save while this tab was being set up passed it by,
    // since it wasn't listed yet. Brought up to date here.
    if (this.scripts !== scripts) {
      await this.swapScripts(attachment, this.scripts);
      await page.reload().catch(() => undefined);
      return;
    }
    if (!loaded) return;
    for (const script of scripts) {
      if (!explainMatch(script.matching, url).matches || !ranLate(script, readyState)) continue;
      this.opts.out(`[sm-dev] Tab T${n} had already started loading, so ${script.script.relativePath} (run-at ${script.runAt}) may have run later there than it would in the extension`);
    }
  }

  private async swapScripts(attachment: PageAttachment, scripts: PreparedScript[]): Promise<void> {
    for (const old of attachment.injectedScripts()) await attachment.remove(old.spec!.id);
    for (const script of scripts) await attachment.inject(script);
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
  const start = startPages(opts, prepared);
  if (!start) return 2;
  const { urls } = start;
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
    // With --all, one tab per page, named as the harness names them and
    // all loading at once. The extension injects into each itself, so
    // these are only watched for page output, dialogs and closing. Its
    // Log entries, polled below, carry no tab.
    const pages: Page[] = [];
    await Promise.all(urls.map(async (url, i) => {
      const n = i + 1;
      let tabPage: Page;
      try {
        tabPage = i === 0 ? page : await context.newPage();
      } catch (err) {
        skipScriptsOf(start, prepared, url, `The tab could not be opened: ${(err as Error).message}`);
        return;
      }
      const out = i === 0 ? opts.out : (line: string): void => opts.out(`[T${n}] ${line}`);
      pages.push(tabPage);
      tabPage.on('close', () => opts.out(`[sm-dev] Tab T${n} closed`));
      wirePageOutput(tabPage, { ...opts, out }, false);
      await DialogTracker.attach(tabPage, out, { visible: browserVisible(opts) });
      opts.out(i === 0 ? `[sm-dev] Opening ${url}` : `[sm-dev] Opening ${url} in T${n}`);
      await tabPage.goto(url).catch((err) => opts.out(`[sm-dev] Navigation failed: ${(err as Error).message}`));
    }));
    printSkipped(opts, start);
    let watcher: (() => void) | null = null;
    if (opts.watch) {
      watcher = watchFiles(opts, prepared, null, page, async (next) => {
        if (!(await pushAll(next))) return;
        for (const p of pages) await p.reload().catch(() => undefined);
      });
    }
    const ticker = setInterval(() => { void poll(); }, 500);
    try {
      if (opts.until) await opts.until;
      else await sleep(1000);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        : `[sm-dev] GM_setValue ${w.key} = ${JSON.stringify(w.value)}`);
    }
  });
}

// `hostReports`: the harness host already prints a script's own throws,
// so the page's copy of those is skipped. See page-output.ts.
function wirePageOutput(page: Page, opts: Pick<RunOptions, 'out' | 'pageErrors'>, hostReports: boolean): void {
  const pageErrors = opts.pageErrors ?? false;
  page.on('console', (msg) => {
    const line = { type: msg.type(), text: msg.text(), url: msg.location().url, argCount: msg.args().length };
    if (showConsoleLine(line, pageErrors)) opts.out(`[page ${line.type}] ${line.text}`);
  });
  page.on('pageerror', (err) => {
    if (showPageError(err.stack ?? err.message, { pageErrors, hostReports })) opts.out(`[page error] ${err.message}`);
  });
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
          // T1 may have been closed, with other tabs still open.
          const open = !page.isClosed();
          if (open) for (const old of attachment.injectedScripts()) await attachment.remove(old.spec!.id);
          await injectAll(next);
          if (open) await page.reload();
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
