// The commands a developer types while `sm-dev run` is streaming.
//
// The point is that the interesting things a script does are not all
// available at startup: a menu command may need firing twice, or after
// some state exists, and what the script stored is worth reading
// between steps rather than only at the end. So the same actions the
// Playwright fixture gives a test (`gm.fireMenu`, `gm.get`, `gm.set`,
// `gm.list`) are available here as lines on stdin.
//
// Kept apart from run.ts so the parsing and the wording of each reply
// sit in one place, and so a non-interactive run (a pipe, an agent
// reading the stream) can skip the whole thing.

import readline from 'node:readline';

import type { Dialog, Page } from '@playwright/test';

import type { HarnessHost, MenuCommandRecord, PageLink } from './host.js';
import { defaultPageUrl, NO_DEFAULT_PAGE, preparedScriptMatches, preparedScriptName, withDefaultScheme, type PreparedScript } from './prepare.js';

/**
 * A tab the run controls: its own, or one a controlled tab opened.
 * Named `T<n>` in every list and command.
 */
export interface ControlledTab {
  /** T1 is the run's own tab; the tabs it opens count up from 2. */
  n: number;
  page: Page;
  /** The page as the host knows it, to tell this tab's reports apart. */
  link: PageLink;
  /** The page's JavaScript dialogs, for `accept` and `dismiss`. */
  dialogs?: DialogTracker;
  /** The number of the tab that opened this one. */
  openedBy?: number;
  /**
   * Its CDP target id, for a debugging session alongside the run to
   * name the same tab. Unset if it closed before it could be read.
   */
  targetId?: string | null;
}

/** ` [targetId=...]`, the tab's CDP id, for the end of a line. */
export function targetIdSuffix(targetId: string | null | undefined): string {
  return targetId ? ` [targetId=${targetId}]` : '';
}

export interface ConsoleContext {
  host: HarnessHost;
  /** The controlled tabs still open, T1 first. */
  tabs: () => ControlledTab[];
  /** The tab the page commands act on. Starts as T1; `tabs` changes it. */
  tab?: ControlledTab;
  /**
   * Open a new controlled tab, at `url` or blank, for `tabs new`.
   * Absent where the caller can't open one.
   */
  newTab?: (url?: string) => Promise<ControlledTab>;
  /** Load another script from disk, for `load`. */
  loadScript?: (file: string) => Promise<void>;
  /** Re-read scripts from disk (all, when none are named), for `update`. */
  updateScripts?: (scripts?: PreparedScript[]) => Promise<void>;
  /** The scripts this run injected, in load order. */
  scripts: PreparedScript[];
  /**
   * The script `get` and `set` act on. Starts as the first; `scripts`
   * changes it.
   */
  current?: PreparedScript;
  /**
   * Typed at a terminal prompt, rather than piped. A person can see
   * what is registered, so `menu` never waits for a late one.
   */
  interactive?: boolean;
  out: (line: string) => void;
  /** Ends the run, as Ctrl-C does. */
  stop: () => void;
  /** The id `sm-dev send` and `stop` know the run by, for `status`. */
  runId?: string;
}

// Grouped as `help` prints them.
const COMMAND_GROUPS: { title: string; lines: string[] }[] = [
  {
    title: 'Scripts',
    lines: [
      'scripts [script]  List the loaded scripts; with one, pick the script',
      '                  get and set act on (T2.3 picks tab T2 too)',
      'status [what]     Show the tab\'s URL and each script\'s status there;',
      '                  or one script (3, T2.3), a tab (T2), or all tabs',
      'load <file>       Load another script from disk',
      'update [script]   Re-read one script from disk, or all (as --watch',
      '                  does on a save), and reload the tabs it affects',
    ],
  },
  {
    title: 'Menu commands',
    lines: [
      'menu [what]       List the tab\'s menu commands, a tab\'s (T2), or all',
      '                  tabs\'; with a number (M2, T2.M2) or a label, fire one',
    ],
  },
  {
    title: 'Stored values',
    lines: [
      'values [what]     Print what every script has stored, or one script\'s,',
      '                  or the scripts running on a tab (T2), or on all tabs',
      'get <key>         Print one stored value',
      'set <key> <json>  Store a value, as another tab\'s write would',
    ],
  },
  {
    title: 'The page',
    lines: [
      'tabs [tab]        List the tabs the run controls; with one, pick the',
      '                  tab the commands for the page act on',
      'tabs new [page]   Open a new tab with the scripts, pick it and focus',
      '                  it; with all, one tab for each script\'s page',
      'reload [T<n>|all] Reload the page, another tab\'s, or every tab',
      'open [page]       Navigate to a URL, or to a script\'s default page',
      '                  (the selected script\'s, or one by number: 2, T2.3);',
      '                  open all is tabs new all',
      'focus [T<n>]      Bring the tab to the front',
      'accept [text]     Answer an open dialog with OK (a prompt with text)',
      'dismiss           Answer an open dialog with Cancel',
    ],
  },
  {
    title: 'The run',
    lines: [
      'help              List these',
      'quit              Stop the run',
    ],
  },
];

// One wording for having none, whether as a reply or in a list.
const NO_SCRIPTS = 'No scripts are loaded';

/** Where the page commands have no tab to act on; also `run --notab`'s start. */
export const NO_TABS = '[sm-dev] No tabs are active. Type tabs new to open one.';

// The commands that act on the current tab, which there may not be.
const NEEDS_A_TAB = new Set(['menu', 'open', 'reload', 'focus', 'accept', 'dismiss']);

// How a command's argument names each kind of thing. Kept out of
// COMMAND_GROUPS, whose first words are the command names Tab
// completes.
const ID_LINES = [
  'Scripts:',
  '  - 2: its number in the scripts list',
  '  - T2.3: script 3, on tab T2',
  '  - Its name, file name or path, or a unique substring',
  'Tabs:',
  '  - T2: its number in the tabs list',
  '  - Its CDP targetId (first 6 or more characters), optionally with targetId=',
  'Menu commands:',
  '  - M2: its number in the tab\'s menu list',
  '  - T2.M2: menu item M2 on tab T2',
  '  - Its label',
];

// A blank line between the groups.
const CONSOLE_HELP = [
  ...COMMAND_GROUPS.flatMap((group, i) => [...(i > 0 ? [''] : []), `${group.title}:`, ...group.lines.map((line) => `  ${line}`)]),
  '',
  'IDs to select objects:',
  ...ID_LINES.map((line) => `  ${line}`),
];

/**
 * Run one typed line. Returns once its effect has been applied, so an
 * agent driving this over a pipe can send the next line knowing the
 * previous one is done.
 */
export async function runConsoleCommand(line: string, ctx: ConsoleContext): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  const [command, ...rest] = trimmed.split(/\s+/);
  const argument = trimmed.slice(command.length).trim();
  const current = ctx.current ?? ctx.scripts[0];
  const scriptId = current?.spec?.id;
  // Named in the output only when there is a choice to be clear about.
  const whose = ctx.scripts.length > 1 && current ? ` (${preparedScriptName(current)})` : '';
  // For the commands that take nothing, so a stray word isn't
  // silently dropped.
  const takesNothing = (): boolean => {
    if (!argument) return true;
    const name = command === '?' ? 'help' : command === 'exit' ? 'quit' : command;
    ctx.out(`[sm-dev] The ${name} command takes no arguments`);
    return false;
  };
  const picked = currentTab(ctx);
  // Every controlled tab can be closed, T1 included. `open all` opens
  // tabs, so it needs none.
  if (!picked && NEEDS_A_TAB.has(command) && !(command === 'open' && argument === 'all')) {
    ctx.out(NO_TABS);
    return;
  }
  // Only undefined for the commands that don't act on it.
  const tab = picked as ControlledTab;
  // An open dialog blocks the page's JavaScript, so a command that
  // reaches into the page would wait on it, and hold up the accept or
  // dismiss typed after it. `set` reaches every tab, so any tab's
  // dialog blocks it.
  const blockedByDialog = (tabs: ControlledTab[] = [tab]): boolean => {
    const waiting = tabs.find((t) => t.dialogs?.current);
    if (!waiting) return false;
    const kind = dialogKind(waiting.dialogs!.current!);
    ctx.out(waiting === tab
      ? `[sm-dev] The page is waiting on ${kind} dialog. Type accept or dismiss first.`
      : `[sm-dev] ${tabName(waiting)} is waiting on ${kind} dialog. Type tabs ${tabName(waiting)}, then accept or dismiss.`);
    return true;
  };

  switch (command) {
    case 'help':
    case '?':
      if (!takesNothing()) return;
      for (const l of CONSOLE_HELP) ctx.out(l ? `  ${l}` : '');
      return;
    case 'quit':
    case 'exit':
      if (!takesNothing()) return;
      ctx.stop();
      return;
    case 'menu': {
      if (argument === 'all') {
        ctx.out('Menu commands:');
        printPerTab(ctx, tab, (t) => menuLines(ctx, t), 'None registered');
        return;
      }
      const ref = tabRef(ctx, argument, tab, true);
      if (!ref) return;
      if (!ref.rest) {
        const lines = menuLines(ctx, ref.tab);
        if (lines.length === 0) {
          ctx.out(noMenusMessage(ctx, ref.tab));
          return;
        }
        ctx.out(`Menu commands${onTab(ctx, ref.tab)}:`);
        for (const l of lines) ctx.out(l);
        return;
      }
      if (blockedByDialog([ref.tab])) return;
      await fireMenu(ctx, ref.tab, ref.rest);
      return;
    }
    case 'tabs':
    case 'tab': {
      if (!argument) {
        printTabs(ctx);
        return;
      }
      if (rest[0] === 'new') {
        await openNewTab(ctx, rest);
        return;
      }
      if (rest.length > 1) {
        ctx.out('[sm-dev] The tabs command takes one tab, e.g. tabs T2');
        return;
      }
      const picked = pickTab(ctx, argument);
      if (!picked) return;
      ctx.tab = picked;
      ctx.out(`[sm-dev] The page commands now act on ${tabName(picked)} (${picked.page.url()})`);
      return;
    }
    case 'scripts':
    case 'script': {
      if (!argument) {
        ctx.out('Loaded scripts:');
        if (ctx.scripts.length === 0) ctx.out(`  ${NO_SCRIPTS}`);
        for (const script of ctx.scripts) ctx.out(scriptRow(ctx, script));
        return;
      }
      const ref = tabRef(ctx, argument, tab);
      if (!ref) return;
      if (!ref.rest) {
        ctx.out('[sm-dev] The scripts command needs a script after the tab, e.g. scripts T2.2');
        return;
      }
      const found = pickScript(ctx, ref.rest);
      if (!found) return;
      ctx.current = found;
      if (!ref.named) {
        ctx.out(`[sm-dev] Using ${scriptLabel(found)} for get and set`);
        return;
      }
      ctx.tab = ref.tab;
      ctx.out(`[sm-dev] Using ${scriptLabel(found)} for get and set, and ${tabName(ref.tab)} for the page commands`);
      return;
    }
    case 'status': {
      if (ctx.runId && (!argument || argument === 'all')) ctx.out(`Run: ${ctx.runId} (pid ${process.pid})`);
      // With no tab, still the scripts and what they have stored.
      if (!tab && (!argument || argument === 'all' || !TAB_REF.test(argument))) {
        const script = argument && argument !== 'all' ? pickScript(ctx, argument) : undefined;
        if (script === null) return;
        ctx.out(NO_TABS);
        for (const l of statusLines(ctx, undefined, script ? [script] : ctx.scripts, false)) ctx.out(l);
        return;
      }
      if (argument === 'all') {
        printPerTab(ctx, tab, (t) => statusLines(ctx, t, ctx.scripts, false));
        return;
      }
      const ref = tabRef(ctx, argument, tab);
      if (!ref) return;
      const script = ref.rest ? pickScript(ctx, ref.rest) : undefined;
      if (script === null) return;
      const several = ctx.tabs().length > 1;
      ctx.out(`Page${several ? ` (${tabName(ref.tab)})` : ''}: ${ref.tab.page.url()}`);
      for (const l of statusLines(ctx, ref.tab, script ? [script] : ctx.scripts, true)) ctx.out(l);
      // The other tabs too, unless one script was asked about.
      if (several && !script) printTabs(ctx);
      return;
    }
    case 'values': {
      if (ctx.scripts.length === 0) {
        ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
        return;
      }
      if (argument === 'all') {
        await settleWrites();
        // The values are each script's, the same on every tab; per
        // tab, this shows which scripts are running there to use them.
        ctx.out('Stored values:');
        printPerTab(ctx, tab, (t) => valueLines(ctx, runningOn(ctx, t)), 'No script is running here');
        return;
      }
      const ref = tabRef(ctx, argument, tab);
      if (!ref) return;
      let scripts = ctx.scripts;
      if (ref.rest) {
        const found = pickScript(ctx, ref.rest);
        if (!found) return;
        scripts = [found];
      } else if (ref.named) {
        scripts = runningOn(ctx, ref.tab);
        if (scripts.length === 0) {
          ctx.out(`[sm-dev] No script is running on ${tabName(ref.tab)}`);
          return;
        }
      }
      await settleWrites();
      ctx.out('Stored values:');
      for (const l of valueLines(ctx, scripts)) ctx.out(l);
      return;
    }
    case 'get': {
      if (!scriptId) {
        ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
        return;
      }
      if (!argument) {
        ctx.out('[sm-dev] The get command needs a key');
        return;
      }
      await settleWrites();
      ctx.out(`  ${argument} = ${JSON.stringify(ctx.host.getValue(scriptId, argument))}`);
      return;
    }
    case 'set': {
      if (!scriptId) {
        ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
        return;
      }
      const key = rest[0];
      const raw = argument.slice(key?.length ?? 0).trim();
      if (!key || !raw) {
        ctx.out('[sm-dev] The set command needs a key and a JSON value, e.g. set units "metric"');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        ctx.out(`[sm-dev] ${raw} is not JSON. A string needs quotes.`);
        return;
      }
      if (blockedByDialog(ctx.tabs())) return;
      // Through the host, so a running script sees it on its next read
      // and its value-change listeners fire, as another tab's write
      // would.
      await ctx.host.setValues(scriptId, { [key]: value });
      ctx.out(`[sm-dev] Set ${key}${whose}`);
      return;
    }
    case 'reload': {
      if (argument === 'all') {
        // All at once, so one slow page holds up no other.
        await Promise.all(reloadable(ctx.tabs(), ctx.out).map((t) => reloadTab(t, ctx.out)));
        return;
      }
      const target = argument ? pickTab(ctx, argument) : tab;
      if (!target || blockedByDialog([target])) return;
      await reloadTab(target, ctx.out);
      return;
    }
    case 'load': {
      if (!argument) {
        ctx.out('[sm-dev] The load command needs a script file');
        return;
      }
      if (!ctx.loadScript) {
        ctx.out('[sm-dev] This run cannot load scripts');
        return;
      }
      // Its injection reaches every tab, so any tab's dialog blocks it.
      if (blockedByDialog(ctx.tabs())) return;
      await ctx.loadScript(argument);
      return;
    }
    case 'update': {
      if (!ctx.updateScripts) {
        ctx.out('[sm-dev] This run cannot update scripts');
        return;
      }
      if (ctx.scripts.length === 0) {
        ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
        return;
      }
      if (blockedByDialog(ctx.tabs())) return;
      if (!argument || argument === 'all') {
        await ctx.updateScripts();
        return;
      }
      const script = pickScript(ctx, argument);
      if (script) await ctx.updateScripts([script]);
      return;
    }
    case 'open': {
      if (argument === 'all') {
        await openNewTab(ctx, ['new', 'all']);
        return;
      }
      if (rest.length > 1) {
        ctx.out('[sm-dev] The open command takes one URL or script');
        return;
      }
      // `T2`: the selected script's page, in T2; `T2.3`: script 3's. Only
      // those shapes, so a host like `t2.example.com` stays a URL.
      const target = TAB_REF.test(argument) ? tabRef(ctx, argument, tab) : { tab, rest: argument };
      if (!target) return;
      const url = target.rest ? pageFor(ctx, target.rest) : current ? scriptPage(ctx, current) : null;
      if (!url) {
        if (!current) ctx.out('[sm-dev] The open command needs a URL, since no script is loaded');
        return;
      }
      if (blockedByDialog([target.tab])) return;
      await target.tab.page.goto(url)
        .catch((err) => ctx.out(`[sm-dev] Navigation failed: ${(err as Error).message}`));
      return;
    }
    case 'focus': {
      const target = argument ? pickTab(ctx, argument) : tab;
      if (!target) return;
      const which = ctx.tabs().length > 1 ? tabName(target) : 'the tab';
      await focusTab(target.page)
        .then(() => ctx.out(`[sm-dev] Brought ${which} to the front`))
        .catch((err) => ctx.out(`[sm-dev] Could not bring ${which} to the front: ${(err as Error).message}`));
      return;
    }
    case 'accept':
    case 'dismiss': {
      if (command === 'dismiss' && !takesNothing()) return;
      const dialog = tab.dialogs?.take();
      if (!dialog) {
        const elsewhere = ctx.tabs().find((t) => t.dialogs?.current);
        ctx.out(elsewhere
          ? `[sm-dev] No dialog is open on ${tabName(tab)}. ${tabName(elsewhere)} has one; type tabs ${tabName(elsewhere)} first.`
          : '[sm-dev] No dialog is open');
        return;
      }
      if (argument && dialog.type() !== 'prompt') {
        ctx.out(`[sm-dev] Only a prompt dialog takes text. This one is ${dialogKind(dialog)}.`);
        tab.dialogs!.putBack(dialog);
        return;
      }
      // A bare accept keeps the prompt's own default, as pressing OK
      // on it would.
      const answered = command === 'accept'
        ? dialog.accept(argument || dialog.defaultValue())
        : dialog.dismiss();
      await answered.then(
        () => ctx.out(`[sm-dev] ${command === 'accept' ? 'Accepted' : 'Dismissed'} the dialog`),
        () => ctx.out('[sm-dev] The dialog was already closed'),
      );
      return;
    }
    default:
      ctx.out(`[sm-dev] ${command} is not a command. Type help to list them.`);
  }
}

// How a script is shown in every list: its @name, and the file when
// that says something the name doesn't.
function scriptLabel(script: PreparedScript): string {
  const name = preparedScriptName(script);
  const file = script.script.relativePath;
  return name === file ? name : `${name} (${file})`;
}

// One script's row in any list of them: its number in the `scripts` list,
// with `*` on the one `get` and `set` act on.
function scriptRow(ctx: ConsoleContext, script: PreparedScript): string {
  const current = ctx.current ?? ctx.scripts[0];
  return `${script === current ? '* ' : '  '}${ctx.scripts.indexOf(script) + 1}: ${scriptLabel(script)}`;
}

/**
 * The script a typed argument names: its number in the `scripts` list, an
 * exact path, file name or `@name`, or else a piece of its name or path
 * that no other loaded script shares. Reports why and returns null when
 * there is no single answer.
 */
function pickScript(ctx: ConsoleContext, arg: string): PreparedScript | null {
  if (/^\d+$/.test(arg)) {
    const script = ctx.scripts[Number(arg) - 1];
    if (!script) ctx.out(`[sm-dev] There is no script ${arg}. Type scripts to list them.`);
    return script ?? null;
  }
  const exact = ctx.scripts.filter((script) => preparedScriptMatches(script, arg));
  if (exact.length === 1) return exact[0];
  const needle = arg.toLowerCase();
  const hits = ctx.scripts.filter((script) =>
    preparedScriptName(script).toLowerCase().includes(needle)
    || script.script.relativePath.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    ctx.out(`[sm-dev] No loaded script matches ${arg}. Type scripts to list them.`);
  } else {
    const numbers = hits.map((script) => ctx.scripts.indexOf(script) + 1).join(', ');
    ctx.out(`[sm-dev] Several loaded scripts match ${arg} (${numbers}). Name one by its number.`);
  }
  return null;
}

// ---------- Tabs ----------

function tabName(tab: ControlledTab): string {
  return `T${tab.n}`;
}

// The tab the page commands act on. One that has closed gives way to
// T1, said once so a command doesn't land somewhere unexpected.
function currentTab(ctx: ConsoleContext): ControlledTab | undefined {
  const open = ctx.tabs();
  if (ctx.tab && !open.includes(ctx.tab)) {
    // With none left, the command's own reply says so.
    if (open[0]) ctx.out(`[sm-dev] ${tabName(ctx.tab)} has closed, so the page commands now act on ${tabName(open[0])}`);
    ctx.tab = undefined;
  }
  // Remembered, so the tab closing later is noted as above.
  ctx.tab ??= open[0];
  return ctx.tab;
}

// ` on T2` in a heading, only when there is more than one tab to
// tell apart.
function onTab(ctx: ConsoleContext, tab: ControlledTab): string {
  return ctx.tabs().length > 1 ? ` on ${tabName(tab)}` : '';
}

function fromTab<T extends object>(ctx: ConsoleContext, tab: ControlledTab, records: T[]): T[] {
  return records.filter((r) => ctx.host.pageOf(r) === tab.link);
}

// Whether a script is running on a tab's current document.
function activeOn(ctx: ConsoleContext, tab: ControlledTab, scriptId: string | undefined): boolean {
  return scriptId !== undefined && ctx.host.isRunning(tab.link, scriptId);
}

function lastStartAndSkip(ctx: ConsoleContext, tab: ControlledTab, scriptId: string | undefined) {
  return scriptId === undefined ? {} : ctx.host.lastStartAndSkip(tab.link, scriptId);
}

/**
 * The tabs of `tabs` that can be reloaded now. One waiting on a dialog
 * would hang its reload, so it is left for the person, and named.
 */
export function reloadable(tabs: ControlledTab[], out: (line: string) => void): ControlledTab[] {
  const waiting = tabs.filter((t) => t.dialogs?.current);
  for (const t of waiting) out(`[sm-dev] ${tabName(t)} is waiting on a dialog, so it was not reloaded`);
  return tabs.filter((t) => !waiting.includes(t));
}

/** Reload one tab, saying so if it fails. */
export function reloadTab(tab: ControlledTab, out: (line: string) => void): Promise<void> {
  return tab.page.reload().then(
    () => undefined,
    (err: Error) => out(`[sm-dev] ${tabName(tab)} could not be reloaded: ${err.message}`),
  );
}

// `tabs`, and the end of `status` when there are several: each tab
// with `*` on the current one, what opened it, an open dialog, and
// which scripts run there.
function printTabs(ctx: ConsoleContext): void {
  const current = currentTab(ctx);
  ctx.out('Tabs:');
  if (ctx.tabs().length === 0) ctx.out('  No active tabs');
  for (const tab of ctx.tabs()) {
    const opener = tab.openedBy ? ` (opened by T${tab.openedBy})` : '';
    ctx.out(`${tab === current ? '* ' : '  '}${tabName(tab)}: ${tab.page.url()}${opener}${targetIdSuffix(tab.targetId)}`);
    const dialog = tab.dialogs?.current;
    if (dialog) ctx.out(`    Waiting on ${dialogKind(dialog)} dialog: ${JSON.stringify(dialog.message())}`);
    const running = runningOn(ctx, tab);
    // By @name alone, the file being in `scripts`. The selected script is one
    // for the whole run, so its `*` goes only under the current tab.
    const selected = tab === current ? ctx.current ?? ctx.scripts[0] : undefined;
    for (const script of running) {
      ctx.out(`   ${script === selected ? '* ' : '  '}${ctx.scripts.indexOf(script) + 1}: ${preparedScriptName(script)}`);
    }
  }
}

// `tabs new [page]`: a tab of the run's own, controlled from the start,
// which becomes the current one and comes to the front. `tabs new all`
// opens one per script's page instead, and leaves the current tab be.
async function openNewTab(ctx: ConsoleContext, rest: string[]): Promise<void> {
  if (!ctx.newTab) {
    ctx.out('[sm-dev] This run cannot open tabs');
    return;
  }
  if (rest.length > 2) {
    ctx.out('[sm-dev] The tabs new command takes one URL or script');
    return;
  }
  const open = async (url?: string): Promise<ControlledTab | null> => {
    try {
      return await ctx.newTab!(url);
    } catch (err) {
      ctx.out(`[sm-dev] The new tab could not be opened: ${(err as Error).message}`);
      return null;
    }
  };
  if (rest[1] === 'all') {
    // One tab per distinct page; the scripts with none, or whose tab
    // failed, are listed at the end, after the tabs' own output.
    const pages = new Map<string, PreparedScript[]>();
    const skipped: string[] = [];
    if (ctx.scripts.length === 0) {
      ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
      return;
    }
    ctx.scripts.forEach((script, i) => {
      const url = defaultPageUrl(script);
      if (!url) skipped[i] = skippedScriptLine(i + 1, script, NO_DEFAULT_PAGE);
      else pages.set(url, [...(pages.get(url) ?? []), script]);
    });
    if (pages.size === 0) {
      ctx.out('[sm-dev] No tab was opened, since no script\'s @match names a page to open');
      return;
    }
    // All loading at once; tabs are numbered in call order.
    await Promise.all([...pages].map(async ([url, scripts]) => {
      try {
        await ctx.newTab!(url);
      } catch (err) {
        for (const script of scripts) {
          const i = ctx.scripts.indexOf(script);
          skipped[i] = skippedScriptLine(i + 1, script, `The tab could not be opened: ${(err as Error).message}`);
        }
      }
    }));
    for (const line of skipped) if (line) ctx.out(line);
    return;
  }
  if (rest[1] && TAB_REF.test(rest[1])) {
    ctx.out(`[sm-dev] The tabs new command opens a tab of its own, so it takes a URL or a script number, not ${rest[1]}`);
    return;
  }
  let url: string | undefined;
  if (rest[1]) {
    const page = pageFor(ctx, rest[1]);
    if (!page) return;
    url = page;
  }
  const tab = await open(url);
  if (!tab) return;
  ctx.tab = tab;
  await focusTab(tab.page).catch(() => undefined);
  ctx.out(`[sm-dev] The page commands now act on ${tabName(tab)} (${tab.page.url()})`);
}

// What `open` and `tabs new` take: a script by its number, meaning its
// default page, or else a URL. A bare number can't be a URL, so the
// two never overlap.
function pageFor(ctx: ConsoleContext, arg: string): string | null {
  if (!/^\d+$/.test(arg)) return withDefaultScheme(arg);
  const script = pickScript(ctx, arg);
  return script ? scriptPage(ctx, script) : null;
}

function scriptPage(ctx: ConsoleContext, script: PreparedScript): string | null {
  const url = defaultPageUrl(script);
  if (!url) ctx.out(`[sm-dev] ${scriptLabel(script)}: ${NO_DEFAULT_PAGE}. Give a URL instead.`);
  return url;
}

/** A script `--all` or `tabs new all` opened no tab for, and why. */
export function skippedScriptLine(n: number, script: PreparedScript, reason: string): string {
  return `[sm-dev] Skipped script ${n}, ${scriptLabel(script)}: ${reason}`;
}

// A tab reference `open` and `tabs new` recognize: `T2` or `T2.3`.
const TAB_REF = /^[Tt]\d+(\.\d+)?$/;

/**
 * Splits a `T<n>.` prefix off a typed argument: `T2.3` is script 3 on
 * T2, `T1.M2` menu command M2 on T1, and `T2` alone the tab itself.
 * Without one, the current tab and the whole argument. Only a number
 * or `M<n>` after the dot, or for `menu` (`labels`) any label, so a
 * file name like `t1.user.js` stays a script. Null, reported, when the
 * named tab isn't open.
 */
function tabRef(
  ctx: ConsoleContext,
  arg: string,
  current: ControlledTab,
  labels = false,
): { tab: ControlledTab; rest: string; named: boolean } | null {
  const m = (labels ? /^[Tt](\d+)(?:\.(.+))?$/ : /^[Tt](\d+)(?:\.(\d+|[Mm]\d+))?$/).exec(arg);
  if (!m) return { tab: current, rest: arg, named: false };
  const tab = pickTab(ctx, `T${m[1]}`);
  return tab ? { tab, rest: (m[2] ?? '').trim(), named: true } : null;
}

// The `all` form of a command: each tab under a `Tab T<n>:` heading,
// `*` on the current one, with `body`'s lines for it indented below.
function printPerTab(
  ctx: ConsoleContext,
  current: ControlledTab | undefined,
  body: (tab: ControlledTab) => string[],
  empty?: string,
): void {
  for (const tab of ctx.tabs()) {
    ctx.out(`${tab === current ? '* ' : '  '}Tab ${tabName(tab)}: ${tab.page.url()}`);
    const lines = body(tab);
    if (lines.length === 0 && empty) ctx.out(`    ${empty}`);
    for (const l of lines) ctx.out(`  ${l}`);
  }
}

function runningOn(ctx: ConsoleContext, tab: ControlledTab): PreparedScript[] {
  return ctx.scripts.filter((script) => activeOn(ctx, tab, script.spec?.id));
}

// Enough of a target id to be taken for one rather than a slip.
const MIN_TARGET_ID_PREFIX = 6;

/**
 * The tab a typed argument names: `T2`, or its CDP target id (or the
 * start of one, if only one open tab's id starts that way), bare or as
 * the output shows it (`[targetId=...]`).
 */
function pickTab(ctx: ConsoleContext, typed: string): ControlledTab | null {
  // As copied from the output: `targetId=ABC...`, brackets and all.
  const arg = typed.replace(/^\[?targetId=([0-9a-f]+)\]?$/i, '$1');
  if (arg.length >= MIN_TARGET_ID_PREFIX && /^[0-9a-f]+$/i.test(arg)) {
    const upper = arg.toUpperCase();
    const hits = ctx.tabs().filter((t) => t.targetId?.toUpperCase().startsWith(upper));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      ctx.out(`[sm-dev] Several tabs' target ids start with ${arg} (${hits.map(tabName).join(', ')}). Type more of it.`);
      return null;
    }
    // Only a number could still be a tab slip (`2` for `T2`).
    if (!/^\d+$/.test(arg)) {
      ctx.out(`[sm-dev] No open tab's target id starts with ${arg}. Type tabs to list them.`);
      return null;
    }
  }
  const m = /^[Tt](\d+)$/.exec(arg);
  if (!m) {
    // A bare number is the likely slip, and has an obvious fix.
    ctx.out(/^\d+$/.test(arg)
      ? `[sm-dev] Tabs are named T1, T2 and so on. Did you mean T${arg}?`
      : `[sm-dev] ${arg} is not a tab. Tabs are named T1, T2 and so on; type tabs to list them.`);
    return null;
  }
  const tab = ctx.tabs().find((t) => t.n === Number(m[1]));
  if (!tab) ctx.out(`[sm-dev] There is no open tab T${m[1]}. Type tabs to list them.`);
  return tab ?? null;
}

// ---------- Menu commands ----------

// A tab's registered menu commands under the script that registered
// each, in load order. The M numbers `menu` prints count through this,
// so firing by number reads the same order.
function menuGroups(ctx: ConsoleContext, tab: ControlledTab): { label: string; commands: MenuCommandRecord[] }[] {
  const all = fromTab(ctx, tab, ctx.host.reports.menuCommands);
  return ctx.scripts
    .map((script) => ({
      label: scriptRow(ctx, script),
      commands: all.filter((c) => c.scriptId === script.spec?.id),
    }))
    .filter((group) => group.commands.length > 0);
}

// A tab's menu commands as `menu` lists them, numbered M1, M2 under
// each script; empty when it has none.
function menuLines(ctx: ConsoleContext, tab: ControlledTab): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const group of menuGroups(ctx, tab)) {
    lines.push(group.label);
    for (const c of group.commands) lines.push(`    M${++n}: ${c.name}`);
  }
  return lines;
}

function noMenusMessage(ctx: ConsoleContext, tab: ControlledTab): string {
  if (ctx.tabs().length === 1) return '[sm-dev] No menu commands are registered';
  const others = ctx.tabs().filter((t) => t !== tab && menuGroups(ctx, t).length > 0);
  return others.length === 0
    ? '[sm-dev] No menu commands are registered on any tab'
    : `[sm-dev] No menu commands are registered on ${tabName(tab)}. ${others.map(tabName).join(', ')} ${others.length === 1 ? 'has' : 'have'} some; type menu ${tabName(others[0])} to list them.`;
}

// A script registers its commands as it starts, and commands are only
// read once one has started. So for piped input, a miss while nothing
// is registered yet may just be early, and is worth waiting out. A
// miss while others are registered is a wrong name, and is reported at
// once, as is any miss typed at a terminal.
const MENU_WAIT_MS = 5000;

async function fireMenu(ctx: ConsoleContext, tab: ControlledTab, argument: string): Promise<void> {
  const all = (): MenuCommandRecord[] => menuGroups(ctx, tab).flatMap((group) => group.commands);
  const numbered = /^[Mm](\d+)$/.exec(argument);
  const deadline = Date.now() + MENU_WAIT_MS;
  for (;;) {
    const commands = all();
    // A label wins over a number, for a command whose label is one.
    const byName = [...commands].reverse().find((c) => c.name === argument);
    const byNumber = numbered ? commands[Number(numbered[1]) - 1] : undefined;
    const entry = byName ?? byNumber;
    if (entry) {
      // Listed but not fired: the page that registered it is going
      // away, as in the middle of a navigation.
      ctx.out(await fire(tab, ctx.host.fireMenuEntry(entry))
        ? `[sm-dev] Fired "${entry.name}"`
        : `[sm-dev] The menu command "${entry.name}" could not be fired, since the page that registered it has gone away`);
      return;
    }
    // Registered on another tab is an answer too, not worth waiting past.
    if (ctx.interactive || commands.length > 0 || Date.now() >= deadline || elsewhereFor(ctx, tab, argument)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const elsewhere = numbered ? undefined : elsewhereFor(ctx, tab, argument);
  if (/^\d+$/.test(argument) && !elsewhere) ctx.out(`[sm-dev] Menu commands are named M1, M2 and so on. Did you mean M${argument}?`);
  else if (elsewhere) ctx.out(`[sm-dev] "${argument}" is registered on ${tabName(elsewhere)}, not ${tabName(tab)}. Type menu ${tabName(elsewhere)}.${argument} to fire it there.`);
  else if (all().length === 0) ctx.out(noMenusMessage(ctx, tab));
  else if (numbered) ctx.out(`[sm-dev] There is no menu command M${numbered[1]}${onTab(ctx, tab)}. Type menu to list them.`);
  else ctx.out(`[sm-dev] No menu command named "${argument}" is registered${onTab(ctx, tab)}. Type menu to list them.`);
}

// Another tab with a menu command of that label.
function elsewhereFor(ctx: ConsoleContext, tab: ControlledTab, label: string): ControlledTab | undefined {
  return ctx.tabs().find((t) => t !== tab && fromTab(ctx, t, ctx.host.reports.menuCommands).some((c) => c.name === label));
}

// Counts as done once a dialog the command opens is up, so `accept`
// can be typed.
function fire(tab: ControlledTab, fired: Promise<boolean>): Promise<boolean> {
  return tab.dialogs ? tab.dialogs.untilDialog(fired) : fired;
}

// ---------- status and values ----------

// Each script's state on a tab: an open dialog there, then per script
// its last start or skip, its counts, and its last error. `others`
// adds a line for a script also running on other tabs, which the `all`
// form shows anyway.
// With no `tab`, only what doesn't depend on one: stored values and
// errors.
function statusLines(ctx: ConsoleContext, tab: ControlledTab | undefined, scripts: PreparedScript[], others: boolean): string[] {
  const { reports } = ctx.host;
  const lines: string[] = [];
  const dialog = tab?.dialogs?.current;
  if (dialog) lines.push(`Waiting on ${dialogKind(dialog)} dialog: ${JSON.stringify(dialog.message())}`);
  lines.push('Scripts:');
  if (scripts.length === 0) lines.push(`  ${NO_SCRIPTS}`);
  for (const script of scripts) {
    const id = script.spec?.id;
    lines.push(scriptRow(ctx, script));
    if (!tab) {
      // Errors are the script's, from tabs since closed, so still told.
      const values = id ? Object.keys(ctx.host.getValues(id)).length : 0;
      const errors = reports.errors.filter((r) => r.scriptId === id);
      lines.push('    Not running, since no tabs are active');
      const counts = [count(values, 'stored value'), count(errors.length, 'error')].filter((c) => !c.startsWith('0 '));
      if (counts.length > 0) lines.push(`    ${counts.join(', ')}`);
      const last = errors.at(-1);
      if (last) lines.push(`    Last error: ${last.message}`);
      continue;
    }
    // The newer of its last start and last skip says where it stands.
    const { started, skipped } = lastStartAndSkip(ctx, tab, id);
    if (skipped && (!started || skipped.at > started.at)) lines.push(`    Skipped on ${skipped.url}: ${skipped.reason}`);
    else if (started) lines.push(`    Started on ${started.url}`);
    else lines.push('    Not started');
    const errors = fromTab(ctx, tab, reports.errors).filter((r) => r.scriptId === id);
    const menus = fromTab(ctx, tab, reports.menuCommands).filter((r) => r.scriptId === id).length;
    // Stored values are the script's, shared by every tab.
    const values = id ? Object.keys(ctx.host.getValues(id)).length : 0;
    // Only the counts that aren't zero, and no line when none is.
    const counts = [count(menus, 'menu command'), count(values, 'stored value'), count(errors.length, 'error')]
      .filter((c) => !c.startsWith('0 '));
    if (counts.length > 0) lines.push(`    ${counts.join(', ')}`);
    const last = errors.at(-1);
    if (last) lines.push(`    Last error: ${last.message}`);
    if (!others) continue;
    const elsewhere = ctx.tabs().filter((t) => t !== tab && activeOn(ctx, t, id)).length;
    if (elsewhere > 0) lines.push(`    Also active on ${elsewhere} other tab${elsewhere === 1 ? '' : 's'}`);
  }
  return lines;
}

function valueLines(ctx: ConsoleContext, scripts: PreparedScript[]): string[] {
  const lines: string[] = [];
  for (const script of scripts) {
    lines.push(scriptRow(ctx, script));
    const id = script.spec?.id;
    const values = id ? ctx.host.getValues(id) : {};
    const keys = Object.keys(values);
    if (keys.length === 0) lines.push('    Nothing stored');
    for (const key of keys) lines.push(`    ${key} = ${JSON.stringify(values[key])}`);
  }
  return lines;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// Activates the tab, un-minimizing its window first, since activating
// a tab in a minimized window leaves it out of sight.
async function focusTab(page: Page): Promise<void> {
  const browser = page.context().browser();
  if (browser) {
    const pageCdp = await page.context().newCDPSession(page);
    const { targetInfo } = await pageCdp.send('Target.getTargetInfo')
      .finally(() => pageCdp.detach().catch(() => undefined));
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
      if (bounds.windowState === 'minimized') {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      }
    } finally {
      await cdp.detach();
    }
  }
  await page.bringToFront();
}

// ---------- Dialogs ----------

function dialogKind(dialog: Dialog): string {
  const type = dialog.type();
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/**
 * The page's `alert`, `confirm`, `prompt` and `beforeunload` dialogs.
 * Playwright dismisses a dialog nobody listens for, which would answer
 * a script's `prompt` with Cancel before anyone saw it. So each one is
 * reported and left open, for the person at the browser or a typed
 * `accept` / `dismiss`. Only when neither can answer (a headless
 * browser, no command input) is it dismissed, since it would otherwise
 * hang the page for good.
 */
export class DialogTracker {
  /** The dialog open now, if any. */
  current: Dialog | null = null;
  /**
   * Whether typed commands are, or are about to be, read, so `accept`
   * can answer. Set before the page loads when they will be, or a
   * prompt the script opens on load would be dismissed first.
   */
  commandsListening: boolean;
  private waiters = new Set<() => void>();
  // Dialogs open one at a time and close in order, so the nth close
  // on the protocol session is the nth dialog Playwright reported. The
  // two come over separate sessions, in no fixed order between them,
  // so a close is matched by count rather than applied to whatever is
  // current, which may be the next dialog already.
  private openedCount = 0;
  private closedCount = 0;
  private currentOrdinal = 0;

  private constructor(
    private readonly out: (line: string) => void,
    private readonly visible: boolean,
    commandsComing: boolean,
  ) {
    this.commandsListening = commandsComing;
  }

  /**
   * `visible`: whether the browser is on screen, for a person to
   * answer. `commandsComing`: whether typed commands will be read.
   */
  static async attach(
    page: Page,
    out: (line: string) => void,
    { visible, commandsComing = false }: { visible: boolean; commandsComing?: boolean },
  ): Promise<DialogTracker> {
    const tracker = new DialogTracker(out, visible, commandsComing);
    page.on('dialog', (dialog) => tracker.opened(dialog));
    // Answered in the browser, a dialog closes without Playwright
    // saying so; the protocol's own event does.
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Page.enable');
      cdp.on('Page.javascriptDialogClosed', () => tracker.closed());
    } catch {
      // Then `status` may name a dialog already answered, and
      // `accept` says it was closed.
    }
    return tracker;
  }

  /**
   * `work`, or true as soon as a dialog opens while it runs. A menu
   * command that opens a dialog blocks the page, and the push that
   * fired it with it, until the dialog is answered.
   */
  async untilDialog(work: Promise<boolean>): Promise<boolean> {
    let wake!: () => void;
    const opened = new Promise<boolean>((resolve) => { wake = () => resolve(true); });
    this.waiters.add(wake);
    try {
      return await Promise.race([work, opened]);
    } finally {
      this.waiters.delete(wake);
    }
  }

  /** The open dialog, now claimed by whoever answers it. */
  take(): Dialog | null {
    const dialog = this.current;
    this.current = null;
    return dialog;
  }

  putBack(dialog: Dialog): void {
    this.current ??= dialog;
  }

  private closed(): void {
    this.closedCount++;
    if (this.currentOrdinal <= this.closedCount) this.current = null;
  }

  private opened(dialog: Dialog): void {
    const ordinal = ++this.openedCount;
    for (const wake of this.waiters) wake();
    const message = dialog.message();
    const what = `The page opened ${dialogKind(dialog)} dialog${message ? `: ${JSON.stringify(message)}` : ''}`;
    if (!this.visible && !this.commandsListening) {
      this.out(`[sm-dev] ${what}. Dismissed it, since nothing can answer it in a headless run without typed commands.`);
      void dialog.dismiss().catch(() => undefined);
      return;
    }
    this.current = dialog;
    this.currentOrdinal = ordinal;
    const typed = `type ${dialog.type() === 'prompt' ? 'accept [text]' : 'accept'} or dismiss`;
    const how = !this.visible ? `${typed[0].toUpperCase()}${typed.slice(1)}`
      : this.commandsListening ? `Answer it in the browser, or ${typed}`
        : 'Answer it in the browser';
    this.out(`[sm-dev] ${what}. ${how}.`);
  }
}

// A script's `GM_setValue` is batched in the page and flushed 150ms
// after the last write, so a read issued straight after firing a menu
// command would print what was there before it. Waiting out that window
// is the difference between "fire, then read" telling the truth and
// telling yesterday's truth.
const WRITE_FLUSH_MS = 250;

function settleWrites(): Promise<void> {
  return new Promise((r) => setTimeout(r, WRITE_FLUSH_MS));
}

// A command with several help lines (`tabs`, `tabs new`) is listed once.
const COMMAND_NAMES = [...new Set(COMMAND_GROUPS
  .flatMap((group) => group.lines)
  .map((line) => line.split(/\s+/)[0])
  .filter(Boolean))];

function completeCommand(line: string): [string[], string] {
  if (/\s/.test(line.trimStart())) return [[], line];
  const word = line.trimStart();
  return [COMMAND_NAMES.filter((name) => name.startsWith(word)), word];
}

// The prompt readline is drawing while a person types at a terminal,
// or null when there is none (a pipe, or before commands are armed).
let activePrompt: readline.Interface | null = null;

/**
 * Print one line of run output. With a prompt showing, the prompt and
 * whatever is half-typed are erased, the line printed above them, and
 * both redrawn with the cursor where it was, so streaming output never
 * lands in the middle of a command being edited.
 */
export function writeOutputLine(line: string): void {
  const rl = activePrompt;
  if (!rl) {
    process.stdout.write(line + '\n');
    return;
  }
  // A long typed line can wrap onto several rows; erase from its top.
  const { rows } = rl.getCursorPos();
  readline.moveCursor(process.stdout, 0, -rows);
  readline.cursorTo(process.stdout, 0);
  readline.clearScreenDown(process.stdout);
  // readline's redraw starts by moving up as many rows as it last
  // recorded the cursor being below the prompt's top, so pad the output
  // by that much. Its record, not `rows`: it goes stale when pasted
  // text wraps without a redraw. `prevRows` is internal, hence
  // the fallback.
  const recorded = (rl as unknown as { prevRows?: number }).prevRows ?? rows;
  process.stdout.write(line + '\n' + '\n'.repeat(recorded));
  rl.prompt(true);
}

/**
 * Runs command lines one at a time, from whichever source: typed ones
 * and ones `sm-dev send` delivers take turns, so two never interleave.
 * `hooks` bracket the line's own turn, not its wait for one, so output
 * captured between them is that command's.
 */
export type CommandRunner = (line: string, hooks?: { start?: () => void; end?: () => void }) => Promise<void>;

export function commandRunner(ctx: ConsoleContext): CommandRunner {
  let queue: Promise<void> = Promise.resolve();
  return (line, hooks) => {
    const done = queue.then(async () => {
      hooks?.start?.();
      try {
        await runConsoleCommand(line, ctx);
      } catch (err) {
        ctx.out(`[sm-dev] ${(err as Error).message}`);
      } finally {
        hooks?.end?.();
      }
    });
    queue = done;
    return done;
  };
}

/**
 * Whether dialogs wait for a typed (or sent) `accept`, rather than
 * being dismissed in a headless run. On while commands are read.
 */
export function setCommandsListening(tabs: ControlledTab[], listening: boolean): void {
  for (const tab of tabs) if (tab.dialogs) tab.dialogs.commandsListening = listening;
}

/**
 * Read commands from stdin, one per line, for as long as the run lasts.
 * Whole lines only, so a piped command split across two reads still
 * runs as one. Does nothing when stdin is already closed.
 *
 * At a terminal, shows a `> ` prompt with line editing and history
 * (readline's own keys: arrows, Ctrl-A/E, Ctrl-U and so on) and Tab
 * completion of command names. Ctrl-C clears the typed line, and on an
 * empty one it or Ctrl-D stops the run. Piped input gets neither: EOF
 * on a pipe only means no more commands, and the run goes on.
 */
export function readConsoleCommands(ctx: ConsoleContext, runLine: CommandRunner = commandRunner(ctx)): () => void {
  if (!process.stdin.readable) return () => undefined;
  // Otherwise nothing says the run is listening at all.
  ctx.out('[sm-dev] Ready for commands. Type help to list them.');
  // A dumb terminal can't move the cursor, so writeOutputLine couldn't
  // redraw around a prompt there.
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== 'dumb';
  ctx.interactive = terminal;
  const lines = terminal
    ? readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: '> ',
      // Tab completes a command name.
      completer: completeCommand,
    })
    : readline.createInterface({ input: process.stdin, terminal: false });
  lines.on('line', (line) => {
    void runLine(line);
    if (terminal) lines.prompt();
  });
  // Erases the prompt and stops drawing output around it. Before the
  // interface closes, or after readline closes it itself on Ctrl-D, so
  // later output neither redraws a dead prompt nor resumes stdin.
  const dropPrompt = (): void => {
    if (activePrompt !== lines) return;
    activePrompt = null;
    readline.moveCursor(process.stdout, 0, -lines.getCursorPos().rows);
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
  };
  if (terminal) {
    // readline puts the terminal in raw mode, so Ctrl-C arrives here
    // rather than as the process's SIGINT. As in a shell, it first
    // clears a half-typed line, and only stops the run on an empty one.
    lines.on('SIGINT', () => {
      if (!lines.line) {
        ctx.stop();
        return;
      }
      lines.write(null, { ctrl: true, name: 'e' });
      lines.write(null, { ctrl: true, name: 'u' });
    });
    lines.on('close', () => {
      dropPrompt();
      ctx.stop();
    });
    activePrompt = lines;
    lines.prompt();
  }
  return () => {
    dropPrompt();
    lines.close();
    process.stdin.pause();
  };
}
