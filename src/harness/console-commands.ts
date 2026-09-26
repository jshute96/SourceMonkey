// The commands a developer types while `sm-dev start` is streaming.
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

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { Dialog, Page } from '@playwright/test';

import { CommandAssembler, echoCommand, unclosedBlockMessage } from './command-lines.js';
import type { HarnessHost, MenuCommandRecord } from './host.js';
import type { PageAttachment } from './inject.js';
import { ACTIONS, PAGE_COMMAND_GROUPS, PAGE_COMMANDS, runPageCommand, splitWords, VALUE_FLAGS } from './page-commands.js';
import { defaultPageUrl, NO_DEFAULT_PAGE, preparedScriptMatches, preparedScriptName, withDefaultScheme, type PreparedScript } from './prepare.js';
import { currentTab, dialogKind, dialogWaitingMessage, NO_TABS, pickTab, TAB_ARG, tabName } from './tab-refs.js';
import { formIndex, settleTabs, waitFor } from './wait.js';
import {
  SCRIPT_ARG, UsageError, matchLines, prepareSource, rel, scriptSources, validateLines, validateSources, validateSummary,
  type ScriptRoots, type ScriptSource,
} from './checks.js';

/**
 * A tab the run controls: its own, or one a controlled tab opened.
 * Named `T<n>` in every list and command.
 */
export interface ControlledTab {
  /** T1 is the run's own tab; the tabs it opens count up from 2. */
  n: number;
  page: Page;
  /** The page as the host knows it, to tell this tab's reports apart. */
  link: PageAttachment;
  /** Opened with `newtab --noscript`, or by such a tab: no scripts run in it. */
  noScript?: boolean;
  /** The page's JavaScript dialogs, for `accept` and `dismiss`. */
  dialogs?: DialogTracker;
  /** The number of the tab that opened this one. */
  openedBy?: number;
  /**
   * Its CDP target id, for a debugging session alongside the run to
   * name the same tab. Unset if it closed before it could be read.
   */
  targetId?: string | null;
  /** Its page id in the run's DevTools server (`--devtools`), once found. */
  pageId?: number;
  /**
   * Its last load failed, or its scripts never reported (said already),
   * so the waits after it don't wait on it again.
   */
  stalled?: boolean;
}

/** ` [targetId=...]`, the tab's CDP id, for the end of a line. */
export function targetIdSuffix(targetId: string | null | undefined): string {
  return targetId ? ` [targetId=${targetId}]` : '';
}

// ` [targetId=... pageId=4]`: both ids, where `tabs` lists the tab.
function tabIdsSuffix(tab: ControlledTab): string {
  const ids = [
    ...(tab.targetId ? [`targetId=${tab.targetId}`] : []),
    ...(tab.pageId !== undefined ? [`pageId=${tab.pageId}`] : []),
  ];
  return ids.length > 0 ? ` [${ids.join(' ')}]` : '';
}

export interface ConsoleContext {
  host: HarnessHost;
  /** The controlled tabs still open, T1 first. */
  tabs: () => ControlledTab[];
  /** The tab the page commands act on. Starts as T1; `tabs` changes it. */
  tab?: ControlledTab;
  /**
   * Open a new controlled tab, at `url` or blank, for `newtab`.
   * Absent where the caller can't open one.
   */
  newTab?: (url?: string, options?: { noScript?: boolean }) => Promise<ControlledTab>;
  /** Switch a tab to running no scripts, or back, for `open --noscript` / `--script`. */
  setTabScripts?: (tab: ControlledTab, noScript: boolean) => Promise<void>;
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
  /** The id other shells know the run by (`--run`), for `status`. */
  runId?: string;
  /** How to reach the run's DevTools server, for `status`. */
  devtools?: () => string | null;
  /** The run's output so far, for `wait log`. */
  output?: OutputHistory;
  /**
   * Writes a command read at the prompt (or piped in) to the run's log,
   * where the terminal's copy of it doesn't reach.
   */
  logCommand?: (text: string, echoed: string[]) => void;
  /**
   * Where `output` stood when the previous command (that wasn't only a
   * look, like `status`) began, for `wait log`: a line the command set
   * off, printed while it waited for the page to settle, still counts.
   * Unset before the first.
   */
  previousStart?: number;
  /** Where `validate` and `match` find local copies of `@require`s: the run's own. */
  roots?: ScriptRoots;
  /** `clear --extension` in this run's browser; the scratch scripts removed. */
  clearExtension?: () => Promise<number>;
}

/** The lines a run has printed, numbered, and a way to hear new ones. */
export interface OutputHistory {
  /** The number the next line will get. */
  mark(): number;
  /** The lines numbered `from` on, that are still kept. */
  since(from: number): string[];
  /** Calls `listener` with each new line, until the returned function is called. */
  watch(listener: (line: string) => void): () => void;
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
      'newtab [page]     Open a new tab with the scripts, pick it and focus',
      '                  it; with all, one tab for each script\'s page;',
      '                  newtab --noscript [page] opens one without them',
      'reload [T<n>|all] Reload the page, another tab\'s, or every tab;',
      '                  --noscript and --script switch them as open does',
      'open [page]       Navigate to a URL, or to a script\'s default page',
      '                  (the selected script\'s, or one by number: 2, T2.3);',
      '                  open all is newtab all. --noscript switches the',
      '                  tab to run no scripts, and --script to run them',
      '                  again, for every later load',
      'focus [T<n>]      Bring the tab to the front',
      'accept [text]     Answer an open dialog with OK (a prompt with text)',
      'dismiss           Answer an open dialog with Cancel',
    ],
  },
  {
    title: 'Waiting',
    lines: [
      'wait [T<n>|all]   Wait until the tab (or all tabs) settles: loaded, its',
      '                  scripts started, and no requests or DOM changes for a',
      '                  moment. reload, open, newtab, click, hover, type and',
      '                  key wait like this on their own, unless given --nowait',
      'wait selector <css>',
      '                  Wait until an element matches',
      'wait selector-gone <css>',
      '                  Wait until no element matches',
      'wait log <text>   Wait for an output line with the text (or /regex/),',
      '                  printed since the previous command began',
      'wait {500ms|2s}   Wait that long',
      'wait ... --timeout-seconds S',
      '                  Give up after S seconds (default 5)',
    ],
  },
  ...PAGE_COMMAND_GROUPS,
  {
    title: 'Checking scripts',
    lines: [
      'match [what]...   Say whether scripts run on pages, and which header',
      '                  rules decided it: the selected script on the tab,',
      '                  unless others are named. what: a script (3, T2.3, a',
      '                  .user.js file), a tab (T2), a URL, all-scripts,',
      '                  all-tabs, or all (every script on every tab)',
      'validate [what]   Re-read a script from disk and check it, without',
      '                  loading it: the selected one, one by number, all',
      '                  loaded scripts, or files and directories',
    ],
  },
  {
    title: 'The run',
    lines: [
      'help [command]    List these, or one command\'s help',
      'list              List the sm-dev runs active on this machine',
      'stop [--all]      Stop the run (as quit does), or every run;',
      '                  --run ID stops another',
      'clear --extension Remove every script in the extension\'s Scratch',
      '                  collection, and turn solo mode off',
      'quit              Stop the run',
    ],
  },
];

// One wording for having none, whether as a reply or in a list.
const NO_SCRIPTS = 'No scripts are loaded';


// The commands that act on the current tab, which there may not be.
const NEEDS_A_TAB = new Set(['menu', 'open', 'reload', 'focus', 'accept', 'dismiss', ...PAGE_COMMANDS]);

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
  '  - Its DevTools page id, as pageId=4 (with --devtools)',
  'Elements (where a command takes a selector):',
  '  - A CSS or Playwright selector',
  '  - e4 or f2e6: its ref in the latest snapshot (also ref=e4 or [ref=e4])',
  'Menu commands:',
  '  - M2: its number in the tab\'s menu list',
  '  - T2.M2: menu item M2 on tab T2',
  '  - Its label',
  'Runs (pass as --run ID to select the target run):',
  '  - D2: run number, as reported by start and list',
  '  - Dname: a user-chosen run ID',
];

// A blank line between the groups.
/** The commands' help, as `help` prints it, for `sm-dev --help` too. */
export const CONSOLE_HELP = [
  ...COMMAND_GROUPS.flatMap((group, i) => [...(i > 0 ? [''] : []), `${group.title}:`, ...group.lines.map((line) => `  ${line}`)]),
  '',
  'IDs to select objects:',
  ...ID_LINES.map((line) => `  ${line}`),
];

// The names a command also answers to, when run and in `help`.
const ALIASES: Record<string, string> = { script: 'scripts', tab: 'tabs', exit: 'quit', '?': 'help', keys: 'key' };

// The flags each command takes; the rest take none. A word starting
// with -- that isn't one is a mistake, said before the command does
// anything, rather than taken as an argument (`status --bad` looking
// for a script named that).
const COMMAND_FLAGS: Record<string, string[]> = {
  newtab: ['--noscript', '--script', '--nowait'],
  reload: ['--noscript', '--script', '--nowait'],
  open: ['--noscript', '--script', '--nowait'],
  click: ['--nowait'],
  hover: ['--nowait'],
  type: ['--nowait'],
  key: ['--nowait'],
  eval: ['--script'],
  snapshot: ['--out', '--visible'],
  screenshot: ['--full'],
  probe: ['--html', '--css'],
  wait: ['--timeout-seconds'],
  stop: ['--all', '--run'],
  clear: ['--extension'],
};

// Commands whose last argument is free text, which may start with --
// as content (eval's JavaScript, type's text, a menu label), and how
// many words of theirs come before it (type's selector). Only the words
// before it are looked at for flags. `wait log`'s text too (see
// freeTextStart).
const FREE_TEXT: Record<string, number> = { eval: 0, type: 1, accept: 0, set: 0, get: 0, menu: 0 };

/**
 * Where a command's free text starts among its own words (the name not
 * included): past its flags, their values, a tab, and the words it
 * takes first. -1 when it has none.
 */
function freeTextStart(command: string, words: string[]): number {
  if (command === 'wait') {
    const at = formIndex(words);
    return words[at] === 'log' ? at + 1 : -1;
  }
  const before = FREE_TEXT[command];
  if (before === undefined) return -1;
  let plain = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith('--')) {
      if (VALUE_FLAGS.has(word)) i++;
      continue;
    }
    if (plain === 0 && TAB_ARG.test(word)) continue;
    if (plain++ === before) return i;
  }
  return -1;
}

/**
 * The mistake in a run command's flags, or null: a word starting with
 * -- the command doesn't take. `words` are the command's, its name
 * first. Null for a name that is no command, which is said elsewhere.
 */
export function commandFlagMistake(words: string[]): string | null {
  const typed = words[0];
  if (typed === undefined) return null;
  const command = ALIASES[typed] ?? typed;
  if (!COMMAND_NAMES.includes(command)) return null;
  const known = COMMAND_FLAGS[command] ?? [];
  const text = freeTextStart(command, words.slice(1));
  // `wait log`'s text may end with its flag.
  const checked = text < 0 ? words.slice(1) : words.slice(1, text + 1);
  if (command === 'wait' && text >= 0 && words.at(-2) === '--timeout-seconds') checked.push(...words.slice(-2));
  for (let i = 0; i < checked.length; i++) {
    const word = checked[i];
    if (!word.startsWith('--')) continue;
    if (!known.includes(word)) return `The ${command} command has no ${word} flag`;
    // A flag's value, which may look like anything.
    if (VALUE_FLAGS.has(word) || word === '--run') i++;
  }
  return null;
}


/**
 * A command line's words, as the prompt splits them (quotes kept
 * together), for `commandFlagMistake`.
 */
export function commandWords(line: string): string[] {
  const trimmed = line.trim();
  const name = trimmed.split(/\s+/)[0];
  return [name, ...splitWords(trimmed.slice(name.length)).map((w) => w.text)];
}

// Commands that only look: what they print answers whoever asked, and
// is no part of the run's story.
const INSPECTING = new Set(['help', 'status', 'values', 'get', 'snapshot', 'screenshot', 'savehtml', 'probe', 'logs', 'match', 'validate', 'list']);

/**
 * Whether a command line only inspects, so its output, sent from
 * another shell, goes back to the sender alone rather than into the run's
 * stream too. `tabs`, `scripts` and `menu` inspect when they list, and
 * change things when they pick or fire.
 */
export function onlyInspects(line: string): boolean {
  const [typed = '', ...rest] = line.trim().split(/\s+/);
  const command = ALIASES[typed] ?? typed;
  if (INSPECTING.has(command)) return true;
  if (command === 'tabs' || command === 'scripts') return rest.length === 0;
  if (command === 'menu') return rest.length === 0 || (rest.length === 1 && (rest[0] === 'all' || /^[Tt]\d+$/.test(rest[0])));
  return false;
}

/**
 * Where a running command's output goes instead of the run's stream,
 * while it runs: an inspecting command sent from another shell answers
 * the sender alone. Output the page or the scripts produce meanwhile
 * isn't the command's, and still goes to the stream. `live` goes false
 * when the command ends, so anything it started that prints later goes
 * to the stream rather than a closed connection.
 */
export const commandOutput = new AsyncLocalStorage<{ line: (line: string) => void; live: boolean }>();

/** How a line saying a command was typed wrong starts. */
export const MISTAKE_PREFIX = '[sm-dev] ERROR: ';

/**
 * Set while a command runs, in its own async work: what it prints is
 * its reply, not something the page or a script printed on its own,
 * which `wait log` looks for. Lines from the page and scripts arrive
 * through events outside it. `inspects`: the command only looks, so
 * its reply is no part of the run's log either.
 */
export const inCommand = new AsyncLocalStorage<{ inspects: boolean }>();

/**
 * The entries for `name` in a help list: a line starting with it, and
 * the indented lines that carry on its description. Empty when none
 * does. A command with several entries gets them all.
 */
export function helpEntries(lines: string[], name: string): string[] {
  const found: string[] = [];
  let taking = false;
  for (const line of lines) {
    if (!/^\s/.test(line)) taking = line.split(/\s+/)[0] === name;
    if (taking) found.push(line);
  }
  return found;
}

/**
 * Typed commands' help, for `help <command>...` and `sm-dev help`: each
 * one's entries once, in the order `help` lists them, under its group's
 * heading. `unknown` are the names no command has.
 */
export function consoleCommandsHelp(names: string[]): { lines: string[]; unknown: string[] } {
  const lines: string[] = [];
  const unknown: string[] = [];
  const groupOf = (name: string) => COMMAND_GROUPS.find((g) => helpEntries(g.lines, name).length > 0);
  const known = [...new Set(names.map((typed) => ALIASES[typed] ?? typed))];
  unknown.push(...names.filter((typed) => !groupOf(ALIASES[typed] ?? typed)));
  // In the order `help` lists them, so each group's heading shows once.
  const ordered = known.filter((name) => groupOf(name)).sort((a, b) => COMMAND_NAMES.indexOf(a) - COMMAND_NAMES.indexOf(b));
  let lastGroup: string | null = null;
  for (const name of ordered) {
    const group = groupOf(name)!;
    if (group.title !== lastGroup) lines.push(...(lastGroup ? [''] : []), `${group.title}:`);
    lastGroup = group.title;
    lines.push(...helpEntries(group.lines, name).map((line) => `  ${line}`));
  }
  return { lines, unknown };
}

/**
 * Run one typed line. Returns once its effect has been applied, so an
 * agent driving this over a pipe can send the next line knowing the
 * previous one is done. For a line sent from another shell: `cwd` is
 * where the files it names are, and `words` are the sender's own words
 * (the line is them joined by spaces), which page commands take as
 * they are rather than splitting the line.
 */
export async function runConsoleCommand(
  line: string, ctx: ConsoleContext, { cwd = process.cwd(), words }: { cwd?: string; words?: string[] } = {},
): Promise<number | boolean | void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  const [typedCommand, ...rest] = trimmed.split(/\s+/);
  const argument = trimmed.slice(typedCommand.length).trim();
  const command = ALIASES[typedCommand] ?? typedCommand;
  // The sender's words when they start with the command; a whole
  // command sent as one word is split like a typed one.
  const flagMistake = commandFlagMistake(words?.[0] === typedCommand ? words : commandWords(trimmed));
  if (flagMistake) {
    ctx.out(`[sm-dev] ERROR: ${flagMistake}`);
    return false;
  }
  const current = ctx.current ?? ctx.scripts[0];
  const scriptId = current?.spec?.id;
  // Named in the output only when there is a choice to be clear about.
  const whose = ctx.scripts.length > 1 && current ? ` (${preparedScriptName(current)})` : '';
  // For the commands that take nothing, so a stray word isn't
  // silently dropped.
  const takesNothing = (): boolean => {
    if (!argument) return true;
    ctx.out(`[sm-dev] ERROR: The ${command} command takes no arguments`);
    return false;
  };
  const picked = currentTab(ctx);
  // Every controlled tab can be closed, T1 included. `open all` opens
  // tabs, so it needs none.
  const opensAll = command === 'open' && rest.filter((w) => !w.startsWith('--')).join(' ') === 'all';
  if (!picked && NEEDS_A_TAB.has(command) && !opensAll) {
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
    ctx.out(`[sm-dev] ${dialogWaitingMessage(waiting, tab)}`);
    return true;
  };

  // The command's own words after its name, as the sender gave them.
  const args = (words?.[0] === typedCommand ? words : commandWords(trimmed)).slice(1);

  switch (command) {
    case 'match':
      return matchCommand(ctx, args, cwd);
    case 'validate':
      return validateCommand(ctx, args, cwd);
    case 'list': {
      if (!takesNothing()) return 2;
      const { liveRuns, runTable } = await import('./runs.js');
      const runs = await liveRuns();
      if (runs.length === 0) ctx.out('No sm-dev runs are active');
      for (const l of runTable(runs)) ctx.out(l);
      return;
    }
    case 'stop':
      return stopCommand(ctx, args);
    case 'clear': {
      if (args.join(' ') !== '--extension') {
        ctx.out(`${MISTAKE_PREFIX}The clear command needs --extension, since it clears the extension's Scratch collection`);
        return 2;
      }
      if (!ctx.clearExtension) {
        ctx.out('[sm-dev] This run cannot reach the extension. Stop the run first, then type sm-dev clear --extension.');
        return 1;
      }
      const count = await ctx.clearExtension();
      ctx.out(`[sm-dev] Removed ${count} scratch script(s)`);
      return;
    }
    case 'start':
      ctx.out(`${MISTAKE_PREFIX}This is ${ctx.runId ? `run ${ctx.runId}` : 'a run'} already. Type load to add a script, or newtab to open a page.`);
      return 2;
    case 'help':
      if (!argument) {
        for (const l of CONSOLE_HELP) ctx.out(l ? `  ${l}` : '');
        return;
      }
      const { lines, unknown } = consoleCommandsHelp(rest);
      for (const name of unknown) ctx.out(`[sm-dev] ERROR: ${name} is not a command. Type help to list them.`);
      for (const l of lines) ctx.out(l ? `  ${l}` : '');
      return;
    case 'quit':
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
    case 'newtab':
      await openNewTab(ctx, rest, cwd);
      return;
    case 'tabs': {
      if (!argument) {
        printTabs(ctx);
        return;
      }
      // `tabs new` was newtab's old name.
      if (rest[0] === 'new') {
        ctx.out('[sm-dev] ERROR: The tabs command picks a tab. To open one, type newtab.');
        return false;
      }
      // The bracketed ids, as `tabs` shows them, are two words.
      if (rest.length > 1 && !/^\[targetId=\S+\s+pageId=\d+\]$/i.test(argument)) {
        ctx.out('[sm-dev] ERROR: The tabs command takes one tab, e.g. tabs T2');
        return false;
      }
      const picked = pickTab(ctx, argument);
      if (!picked) return;
      ctx.tab = picked;
      ctx.out(`[sm-dev] The page commands now act on ${tabName(picked)} (${picked.page.url()})`);
      return;
    }
    case 'scripts': {
      if (!argument) {
        ctx.out('Loaded scripts:');
        if (ctx.scripts.length === 0) ctx.out(`  ${NO_SCRIPTS}`);
        for (const script of ctx.scripts) ctx.out(scriptRow(ctx, script));
        return;
      }
      const ref = tabRef(ctx, argument, tab);
      if (!ref) return;
      if (!ref.rest) {
        ctx.out('[sm-dev] ERROR: The scripts command needs a script after the tab, e.g. scripts T2.2');
        return false;
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
      if (!argument || argument === 'all') {
        if (ctx.runId) ctx.out(`Run: ${ctx.runId} (pid ${process.pid})`);
        const devtools = ctx.devtools?.();
        if (devtools) ctx.out(`DevTools: ${devtools}`);
      }
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
        ctx.out('[sm-dev] ERROR: The get command needs a key');
        return false;
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
        ctx.out('[sm-dev] ERROR: The set command needs a key and a JSON value, e.g. set units "metric"');
        return false;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        ctx.out(`[sm-dev] ERROR: ${raw} is not JSON. A string needs quotes.`);
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
      const noWait = rest.includes('--nowait');
      const mode = scriptsFlag(ctx, 'reload', rest.filter((w) => w !== '--nowait'));
      if (mode === null) return;
      const words = rest.filter((w) => !w.startsWith('--'));
      if (words.length > 1) {
        ctx.out('[sm-dev] ERROR: The reload command takes one tab, or all');
        return false;
      }
      if (words[0] === 'all') {
        // All at once, so one slow page holds up no other.
        const all = reloadable(ctx.tabs(), ctx.out);
        for (const t of all) if (!await switchScripts(ctx, t, mode)) return;
        const loaded = await Promise.all(all.map((t) => reloadTab(t, ctx.host, ctx.out)));
        if (!noWait) await settleTabs(ctx.host, all.filter((_, i) => loaded[i]), ctx.out);
        return;
      }
      const target = words[0] ? pickTab(ctx, words[0]) : tab;
      if (!target || blockedByDialog([target])) return;
      if (!await switchScripts(ctx, target, mode)) return;
      if (await reloadTab(target, ctx.host, ctx.out) && !noWait) await settleTabs(ctx.host, [target], ctx.out);
      return;
    }
    case 'load': {
      if (!argument) {
        ctx.out('[sm-dev] ERROR: The load command needs a script file');
        return false;
      }
      if (!ctx.loadScript) {
        ctx.out('[sm-dev] This run cannot load scripts');
        return;
      }
      // Its injection reaches every tab, so any tab's dialog blocks it.
      if (blockedByDialog(ctx.tabs())) return;
      // A relative path sent from another directory is the sender's.
      await ctx.loadScript(cwd !== process.cwd() && !path.isAbsolute(argument) ? path.resolve(cwd, argument) : argument);
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
      // `--noscript` / `--script` switch the tab's mode, which lasts.
      const noWait = rest.includes('--nowait');
      const mode = scriptsFlag(ctx, 'open', rest.filter((w) => w !== '--nowait'));
      if (mode === null) return;
      const page = rest.filter((w) => !w.startsWith('--'));
      if (page[0] === 'all' && page.length === 1) {
        await openNewTab(ctx, ['all', ...(mode ? ['--noscript'] : []), ...(noWait ? ['--nowait'] : [])], cwd);
        return;
      }
      if (page.length > 1) {
        ctx.out('[sm-dev] ERROR: The open command takes one URL or script');
        return false;
      }
      const where = page[0] ?? '';
      // `T2`: the selected script's page, in T2; `T2.3`: script 3's. Only
      // those shapes, so a host like `t2.example.com` stays a URL.
      const target = TAB_REF.test(where) ? tabRef(ctx, where, tab) : { tab, rest: where };
      if (!target) return;
      // With the mode switched and no page named, the page it's on.
      const url = target.rest ? pageFor(ctx, target.rest, cwd)
        : mode !== undefined ? target.tab.page.url()
          : current ? scriptPage(ctx, current) : null;
      if (!url) {
        if (!current) ctx.out('[sm-dev] ERROR: The open command needs a URL, since no script is loaded');
        return false;
      }
      if (blockedByDialog([target.tab])) return;
      if (!await switchScripts(ctx, target.tab, mode)) return;
      if (await gotoInTab(target.tab, ctx.host, url, ctx.out) && !noWait) await settleTabs(ctx.host, [target.tab], ctx.out);
      return;
    }
    case 'wait': {
      const own = words?.[0] === typedCommand ? words.slice(1) : commandWords(trimmed).slice(1);
      return waitFor(ctx, own, words?.[0] === typedCommand ? null : argument);
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
        ctx.out(`[sm-dev] ERROR: Only a prompt dialog takes text. This one is ${dialogKind(dialog)}.`);
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
    default: {
      if (!PAGE_COMMANDS.has(command)) {
        ctx.out(`[sm-dev] ERROR: ${command} is not a command. Type help to list them.`);
        return false;
      }
      // The sender's own words, when they start with the command; a
      // whole command sent as one quoted word is split like a typed one.
      const typed = words?.[0] !== typedCommand;
      const list = typed ? splitWords(argument) : words!.slice(1).map((text) => ({ text, start: -1, end: -1 }));
      // A tab first (T2, targetId=..., pageId=...), or the current one.
      // Among any flags that lead (and a flag's value), so `eval --script
      // T2 ...` and `snapshot --out f T2` name one.
      // Only on the command's own line: an eval block's code is not
      // looked through for them.
      const headEnd = typed ? argument.indexOf('\n') : -1;
      const inHead = (i: number): boolean => i < list.length && (headEnd < 0 || list[i].start < headEnd);
      let at = 0;
      while (inHead(at) && list[at].text.startsWith('--')) at += VALUE_FLAGS.has(list[at].text) ? 2 : 1;
      let target = tab;
      // Spans of the typed line taken out of it (the tab, `--nowait`),
      // for the line as the command gets it.
      const cut: [number, number][] = [];
      if (inHead(at) && TAB_ARG.test(list[at].text)) {
        // The ids as `tabs` shows them, `[targetId=... pageId=4]`, are
        // two words.
        const pair = /^\[targetId=[^\]]+$/i.test(list[at].text) && /^pageId=\d+\]$/i.test(list[at + 1]?.text ?? '');
        const taken = pair ? 2 : 1;
        const picked = pickTab(ctx, list.slice(at, at + taken).map((w) => w.text).join(' '));
        if (!picked) return;
        target = picked;
        cut.push([list[at].start, list[at + taken - 1].end]);
        list.splice(at, taken);
      }
      // `logs` only reads what was recorded; the rest reach into a page
      // a dialog has stopped.
      if (command !== 'logs' && blockedByDialog([target])) return;
      // `--nowait` on an action: taken out of its words. For `type`,
      // only before its text, which may hold the word itself.
      let noWait = false;
      if (ACTIONS.has(command)) {
        const text = freeTextStart(command, list.map((w) => w.text));
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].text !== '--nowait' || (text >= 0 && i >= text)) continue;
          cut.push([list[i].start, list[i].end]);
          list.splice(i, 1);
          noWait = true;
        }
      }
      let raw = argument;
      for (const [start, end] of cut.sort((a, b) => b[0] - a[0])) raw = raw.slice(0, start) + raw.slice(end);
      const input = {
        words: list.map((w) => w.text),
        raw: typed ? raw : list.map((w) => w.text).join(' '),
        typed,
        scriptsRunning: runningOn(ctx, target).length > 0,
        noWait,
      };
      await runPageCommand(command, input, target, ctx.out, cwd);
    }
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

// ---------- Checking scripts ----------

// Where the loaded scripts' local @require copies are, for re-reading
// one: the run's roots, or the sender's directory.
function rootsOf(ctx: ConsoleContext, cwd: string): ScriptRoots {
  return ctx.roots ?? { collectionRoot: cwd, localRoots: [] };
}

// A loaded script's number and label, as the scripts list shows it.
function numbered(ctx: ConsoleContext, script: PreparedScript): string {
  return `${ctx.scripts.indexOf(script) + 1}: ${scriptLabel(script)}`;
}

/**
 * `match` in a run: the selected script on the current tab, unless the
 * words name others. Scripts: a number, `T2.3`, a loaded script's
 * name or file name, a `.user.js` file (or its URL), `all-scripts`.
 * Pages: a tab, `T2.3`'s tab, a URL, `all-tabs`. `all` is both. 1 when
 * any page isn't matched.
 */
async function matchCommand(ctx: ConsoleContext, words: string[], cwd: string): Promise<number> {
  const loaded: PreparedScript[] = [];
  const files: string[] = [];
  const pages: { url: string; name?: string }[] = [];
  let allScripts = false;
  let allTabs = false;
  const tabPage = (tab: ControlledTab): { url: string; name: string } => ({ url: tab.page.url(), name: tabName(tab) });
  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower === 'all' || lower === 'all-scripts') allScripts = true;
    if (lower === 'all' || lower === 'all-tabs') allTabs = true;
    if (lower === 'all' || lower === 'all-scripts' || lower === 'all-tabs') continue;
    const ref = /^[Tt](\d+)(?:\.(\d+))?$/.exec(word);
    if (ref) {
      const tab = pickTab(ctx, `T${ref[1]}`);
      if (!tab) return 2;
      pages.push(tabPage(tab));
      if (ref[2] !== undefined) {
        const script = pickScript(ctx, ref[2]);
        if (!script) return 2;
        loaded.push(script);
      }
    } else if (/^\d+$/.test(word)) {
      const script = pickScript(ctx, word);
      if (!script) return 2;
      loaded.push(script);
    } else if (ctx.scripts.some((script) => preparedScriptMatches(script, word))) {
      // A loaded script by its exact name or path, before a file or URL.
      loaded.push(...ctx.scripts.filter((script) => preparedScriptMatches(script, word)));
    } else if (SCRIPT_ARG.test(word)) {
      files.push(word);
    } else {
      pages.push({ url: withDefaultScheme(word, cwd) });
    }
  }
  if (allScripts) loaded.splice(0, loaded.length, ...ctx.scripts);
  const current = ctx.current ?? ctx.scripts[0];
  if (loaded.length === 0 && files.length === 0) {
    if (!current) {
      ctx.out(`[sm-dev] ${NO_SCRIPTS}. Name a .user.js file to match.`);
      return 1;
    }
    loaded.push(current);
  }
  // Every tab, then any URLs named.
  if (allTabs) pages.splice(0, pages.length, ...ctx.tabs().map(tabPage), ...pages.filter((p) => p.name === undefined));
  if (pages.length === 0) {
    const tab = currentTab(ctx);
    if (!tab) {
      ctx.out(NO_TABS);
      return 1;
    }
    // Named only when there is another tab it could have been.
    pages.push(ctx.tabs().length > 1 ? tabPage(tab) : { url: tab.page.url() });
  }
  // Each once, as on the command line.
  const unique = pages.filter((p, i) => pages.findIndex((q) => q.url === p.url && q.name === p.name) === i);
  pages.splice(0, pages.length, ...unique);
  const scripts: { label: string; prepared: PreparedScript }[] = [...new Set(loaded)].map((script) => ({ label: numbered(ctx, script), prepared: script }));
  for (const source of await scriptSources(files, cwd)) scripts.push({ label: source.label, prepared: await prepareSource(source, rootsOf(ctx, cwd)) });
  let misses = 0;
  for (const [i, { label, prepared }] of scripts.entries()) {
    // Headed only when there are several, as on the command line.
    if (scripts.length > 1) {
      if (i > 0) ctx.out('');
      ctx.out(label);
    }
    const report = matchLines(prepared, pages, scripts.length > 1 ? undefined : label);
    misses += report.misses;
    for (const line of report.lines) ctx.out(line);
  }
  return misses === 0 ? 0 : 1;
}

/**
 * `validate` in a run: the selected script re-read from disk, unless
 * the words name others: a number, `T2.3`, `all` (every loaded
 * script), or files and directories. 1 when any is invalid.
 */
async function validateCommand(ctx: ConsoleContext, words: string[], cwd: string): Promise<number> {
  const loaded: PreparedScript[] = [];
  const sources: ScriptSource[] = [];
  const paths: string[] = [];
  for (const word of words) {
    if (word.toLowerCase() === 'all') {
      loaded.push(...ctx.scripts);
      continue;
    }
    const ref = /^(?:[Tt](\d+)\.)?(\d+)$/.exec(word);
    if (!ref) {
      paths.push(word);
      continue;
    }
    if (ref[1] !== undefined && !pickTab(ctx, `T${ref[1]}`)) return 2;
    const script = pickScript(ctx, ref[2]);
    if (!script) return 2;
    loaded.push(script);
  }
  if (paths.length > 0) sources.push(...await validateSources(paths, cwd));
  if (words.length === 0) {
    const current = ctx.current ?? ctx.scripts[0];
    if (!current) {
      ctx.out(`[sm-dev] ${NO_SCRIPTS}. Name a file or directory to validate.`);
      return 1;
    }
    loaded.push(current);
  }
  const reread: ScriptSource[] = [];
  for (const script of new Set(loaded)) {
    const url = script.script.fileUrl;
    if (!url.startsWith('file:')) {
      ctx.out(`[sm-dev] Script ${numbered(ctx, script)} has no file to re-read`);
      return 1;
    }
    const file = fileURLToPath(url);
    reread.push({ label: rel(file, cwd), file });
  }
  // The loaded scripts first, in their order, then the paths.
  sources.unshift(...reread);
  let invalid = 0;
  for (const source of sources) {
    const { lines, ok } = validateLines(source.label, await prepareSource(source, rootsOf(ctx, cwd)));
    if (!ok) invalid++;
    for (const line of lines) ctx.out(line);
  }
  ctx.out('');
  ctx.out(validateSummary(sources.length - invalid, invalid));
  return invalid === 0 ? 0 : 1;
}

/**
 * `stop` in a run: this run, as `quit` does; with `--all`, every run,
 * this one last; with `--run ID`, that run.
 */
async function stopCommand(ctx: ConsoleContext, words: string[]): Promise<number> {
  const all = words.includes('--all');
  const at = words.indexOf('--run');
  const named = at >= 0 ? words[at + 1] : undefined;
  if (at >= 0 && named === undefined) {
    ctx.out(`${MISTAKE_PREFIX}The --run flag needs a run ID, e.g. --run D2`);
    return 2;
  }
  const extra = words.filter((w, i) => w !== '--all' && i !== at && i !== at + 1);
  if (extra.length > 0 || (all && named !== undefined)) {
    ctx.out(`${MISTAKE_PREFIX}The stop command takes --all or --run ID, not both, and nothing else`);
    return 2;
  }
  const { liveRuns, runIdOf, stopRun } = await import('./runs.js');
  const id = named === undefined ? undefined : runIdOf(named);
  if (named !== undefined && !id) {
    ctx.out(`${MISTAKE_PREFIX}The run ID ${named} is not valid. Run IDs are D and then letters, digits, _ or -.`);
    return 2;
  }
  if (id !== undefined && id !== ctx.runId) {
    const record = (await liveRuns()).find((r) => r.id === id);
    if (!record) {
      ctx.out(`[sm-dev] There is no run ${id}. Type list to see the runs.`);
      return 1;
    }
    return await stopRun(record, ctx.out) ? 0 : 1;
  }
  if (all) for (const record of (await liveRuns()).filter((r) => r.id !== ctx.runId)) await stopRun(record, ctx.out);
  ctx.stop();
  return 0;
}

// ---------- Tabs ----------

// `--noscript` / `--script` among a command's words: true for no
// scripts, false for scripts, undefined for neither, and null (said
// why) for another flag, or both.
function scriptsFlag(ctx: ConsoleContext, command: string, words: string[]): boolean | undefined | null {
  const flags = words.filter((w) => w.startsWith('--'));
  const unknown = flags.find((f) => f !== '--noscript' && f !== '--script');
  if (unknown) {
    ctx.out(`[sm-dev] ERROR: The ${command} command has no ${unknown} flag`);
    return null;
  }
  if (flags.includes('--noscript') && flags.includes('--script')) {
    ctx.out(`[sm-dev] ERROR: The ${command} command takes --noscript or --script, not both`);
    return null;
  }
  return flags.includes('--noscript') ? true : flags.includes('--script') ? false : undefined;
}

// Switches a tab to run no scripts (`noScript` true) or the scripts
// again, when that's a change, and says so. The next load in it goes
// the new way, and every one after. False (said why) if it can't.
async function switchScripts(ctx: ConsoleContext, tab: ControlledTab, noScript: boolean | undefined): Promise<boolean> {
  if (noScript === undefined) return true;
  if ((tab.noScript === true) === noScript) {
    ctx.out(`[sm-dev] ${tabName(tab)} already runs ${noScript ? 'no scripts' : 'the scripts'}`);
    return true;
  }
  if (!ctx.setTabScripts) {
    ctx.out('[sm-dev] This run cannot switch a tab\'s scripts');
    return false;
  }
  try {
    await ctx.setTabScripts(tab, noScript);
  } catch (err) {
    ctx.out(`[sm-dev] ${tabName(tab)} could not be switched to run ${noScript ? 'no scripts' : 'the scripts'}: ${(err as Error).message}`);
    return false;
  }
  ctx.out(noScript
    ? `[sm-dev] ${tabName(tab)} runs no scripts from now on (--script switches back)`
    : `[sm-dev] ${tabName(tab)} runs the scripts again`);
  return true;
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
  // Switched to run no scripts: the host's last word from it can still
  // be a start from before, since a load with none says nothing.
  if (tab.noScript) return false;
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

/**
 * Reload one tab, saying so if it fails. False when it failed, or its
 * scripts never reported (said already), so nothing waits on it more.
 */
export function reloadTab(tab: ControlledTab, host: HarnessHost, out: (line: string) => void): Promise<boolean> {
  return loadInTab(tab, host, () => tab.page.reload(), `[sm-dev] ${tabName(tab)} could not be reloaded`, out);
}

/** Navigate one tab to `url`, as `reloadTab` reloads it. */
export function gotoInTab(tab: ControlledTab, host: HarnessHost, url: string, out: (line: string) => void): Promise<boolean> {
  return loadInTab(tab, host, () => tab.page.goto(url), '[sm-dev] Navigation failed', out);
}

// A backstop for a script that never reports, not a guess at when the
// output is done: every injected script reports once per document.
// Counted from the load's end, so a slow page isn't blamed on them.
const SCRIPTS_REPORT_MAX_MS = 10_000;

/**
 * Load a page in `tab`, done once each script injected there has
 * started, been skipped or thrown in the new document, and what their
 * bodies printed has arrived. So a command that loads a page ends with
 * its scripts' output rather than before it. Also done when a dialog
 * opens, since the page waits on it, or the tab closes. `failed` is
 * what to say, before the error, if the load fails.
 */
async function loadInTab(
  tab: ControlledTab, host: HarnessHost, load: () => Promise<unknown>, failed: string, out: (line: string) => void,
): Promise<boolean> {
  const scripts = tab.link.injectedScripts().filter((s) => s.spec);
  const ids = scripts.map((s) => s.spec!.id);
  const before = tab.link.documentStart();
  let since = before;
  // Ends the wait on the scripts however it ends, so it stops checking.
  const stopped = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onClose!: () => void;
  let loadFailed = false;
  // Marked on the tab too, so the waits after it (settleTabs) skip it.
  const result = (ok: boolean): boolean => {
    tab.stalled = !ok;
    return ok;
  };
  const outcome = new Promise<boolean>((resolve) => {
    onClose = () => resolve(true);
    tab.page.once('close', onClose);
    load().then(
      async () => {
        await tab.link.caughtUp();
        since = tab.link.documentStart();
        // Only the hash changed: no new document, so nothing starts again.
        if (since === before || ids.length === 0) {
          resolve(true);
          return;
        }
        timer = setTimeout(() => resolve(false), SCRIPTS_REPORT_MAX_MS);
        // Reports from the new document only, not late ones from the old.
        await host.untilReported(tab.link, ids, since, stopped.signal);
        // A script's start report comes before its body runs.
        await tab.link.drain();
        resolve(true);
      },
      (err: Error) => {
        out(`${failed}: ${err.message}`);
        loadFailed = true;
        resolve(true);
      },
    );
  });
  try {
    if (await (tab.dialogs ? tab.dialogs.untilDialog(outcome) : outcome)) return result(!loadFailed);
    const waiting = host.unreported(tab.link, ids, since);
    const names = scripts.filter((s) => waiting.includes(s.spec!.id)).map(preparedScriptName);
    if (names.length > 0) out(`[sm-dev] ${names.join(', ')} had not started on ${tabName(tab)} after ${SCRIPTS_REPORT_MAX_MS / 1000} seconds`);
    return result(false);
  } finally {
    stopped.abort();
    clearTimeout(timer);
    tab.page.off('close', onClose);
  }
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
    const none = tab.noScript ? ' (no scripts)' : '';
    ctx.out(`${tab === current ? '* ' : '  '}${tabName(tab)}: ${tab.page.url()}${none}${opener}${tabIdsSuffix(tab)}`);
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

// `newtab [page]`: a tab of the run's own, controlled from the start,
// which becomes the current one and comes to the front. `newtab all`
// opens one per script's page instead, and leaves the current tab be.
async function openNewTab(ctx: ConsoleContext, words: string[], cwd: string): Promise<void> {
  // `--noscript` anywhere: a tab the scripts stay out of.
  // `--script` is what a new tab gets anyway.
  const noWait = words.includes('--nowait');
  const mode = scriptsFlag(ctx, 'newtab', words.filter((w) => w !== '--nowait'));
  if (mode === null) return;
  const noScript = mode === true;
  const rest = words.filter((w) => !w.startsWith('--'));
  if (!ctx.newTab) {
    ctx.out('[sm-dev] This run cannot open tabs');
    return;
  }
  if (rest.length > 1) {
    ctx.out('[sm-dev] ERROR: The newtab command takes one URL or script');
    return;
  }
  const open = async (url?: string): Promise<ControlledTab | null> => {
    try {
      return await ctx.newTab!(url, { noScript });
    } catch (err) {
      ctx.out(`[sm-dev] The new tab could not be opened: ${(err as Error).message}`);
      return null;
    }
  };
  if (rest[0] === 'all') {
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
    const opened: ControlledTab[] = [];
    await Promise.all([...pages].map(async ([url, scripts]) => {
      try {
        opened.push(await ctx.newTab!(url, { noScript }));
      } catch (err) {
        for (const script of scripts) {
          const i = ctx.scripts.indexOf(script);
          skipped[i] = skippedScriptLine(i + 1, script, `The tab could not be opened: ${(err as Error).message}`);
        }
      }
    }));
    if (!noWait) await settleTabs(ctx.host, opened, ctx.out);
    for (const line of skipped) if (line) ctx.out(line);
    return;
  }
  if (rest[0] && TAB_REF.test(rest[0])) {
    ctx.out(`[sm-dev] ERROR: The newtab command opens a tab of its own, so it takes a URL or a script number, not ${rest[0]}`);
    return;
  }
  let url: string | undefined;
  if (rest[0]) {
    const page = pageFor(ctx, rest[0], cwd);
    if (!page) return;
    url = page;
  }
  const tab = await open(url);
  if (!tab) return;
  ctx.tab = tab;
  await focusTab(tab.page).catch(() => undefined);
  if (!noWait) await settleTabs(ctx.host, [tab], ctx.out);
  ctx.out(`[sm-dev] The page commands now act on ${tabName(tab)} (${tab.page.url()})`);
}

// What `open` and `newtab` take: a script by its number, meaning its
// default page, or else a URL. A bare number can't be a URL, so the
// two never overlap.
// `cwd`: where a relative path is, the sender's for a sent command.
function pageFor(ctx: ConsoleContext, arg: string, cwd: string): string | null {
  if (!/^\d+$/.test(arg)) return withDefaultScheme(arg, cwd);
  const script = pickScript(ctx, arg);
  return script ? scriptPage(ctx, script) : null;
}

function scriptPage(ctx: ConsoleContext, script: PreparedScript): string | null {
  const url = defaultPageUrl(script);
  if (!url) ctx.out(`[sm-dev] ${scriptLabel(script)}: ${NO_DEFAULT_PAGE}. Give a URL instead.`);
  return url;
}

/** A script `--all` or `newtab all` opened no tab for, and why. */
export function skippedScriptLine(n: number, script: PreparedScript, reason: string): string {
  return `[sm-dev] Skipped script ${n}, ${scriptLabel(script)}: ${reason}`;
}

// A tab reference `open` and `newtab` recognize: `T2` or `T2.3`.
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
      if (!await fire(tab, ctx.host.fireMenuEntry(entry))) {
        ctx.out(`[sm-dev] The menu command "${entry.name}" could not be fired, since the page that registered it has gone away`);
        return;
      }
      ctx.out(`[sm-dev] Fired "${entry.name}"`);
      // A MAIN-world handler runs in a later task than the push, so the
      // command ends once the page has run it, with what it printed.
      if (!tab.dialogs?.current) await fire(tab, tab.link.drain().then(() => true));
      return;
    }
    // Registered on another tab is an answer too, not worth waiting past.
    if (ctx.interactive || commands.length > 0 || Date.now() >= deadline || elsewhereFor(ctx, tab, argument)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const elsewhere = numbered ? undefined : elsewhereFor(ctx, tab, argument);
  if (/^\d+$/.test(argument) && !elsewhere) ctx.out(`[sm-dev] ERROR: Menu commands are named M1, M2 and so on. Did you mean M${argument}?`);
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

// A command with several entries in the help is listed once.
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

const PROMPT = '> ';
// While an eval block is open.
const BLOCK_PROMPT = '... ';

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
 * and ones sent from other shells take turns, so two never interleave.
 * `hooks` bracket the line's own turn, not its wait for one, so output
 * captured between them is that command's.
 */
/**
 * Runs a command line, resolving to false when the command failed in
 * a way that should stop a line of several (a `wait` that timed out).
 */
export type CommandRunner = (
  line: string,
  hooks?: { start?: () => void; end?: () => void; cwd?: string; words?: string[]; answer?: (line: string) => void },
) => Promise<number>;

// `answer`: where the command's own output goes instead of `ctx.out`
// (see commandOutput). Resolves to the command's exit code.
export function commandRunner(ctx: ConsoleContext): CommandRunner {
  let queue: Promise<unknown> = Promise.resolve();
  return (line, hooks) => {
    // The exit code: what the command returned (a number, or false for
    // 1); else 2 when it said it was typed wrong, wherever in it that
    // was said; else 0. A throw is 2 for a typing mistake (a file that
    // isn't there), 1 otherwise. Commands run one at a time, so the
    // mistake watch holds only for this one.
    let code = 0;
    const run = async (): Promise<void> => {
      let mistaken = false;
      const out = ctx.out;
      ctx.out = (l) => {
        if (l.startsWith(MISTAKE_PREFIX)) mistaken = true;
        out(l);
      };
      try {
        const result = await runConsoleCommand(line, ctx, { cwd: hooks?.cwd, words: hooks?.words });
        code = result === false ? 1 : typeof result === 'number' ? result : 0;
        if (code === 0 && mistaken) code = 2;
      } catch (err) {
        ctx.out(`${err instanceof UsageError ? MISTAKE_PREFIX : '[sm-dev] '}${(err as Error).message}`);
        code = err instanceof UsageError ? 2 : 1;
      } finally {
        ctx.out = out;
      }
    };
    const done = queue.then(async () => {
      hooks?.start?.();
      const answer = hooks?.answer && { line: hooks.answer, live: true };
      // Where this command began, for the next `wait log`. Not for one
      // that only looks or waits, or an empty line (a message's turn):
      // what the command before it set off still counts.
      const began = ctx.output?.mark();
      const name = line.trim().split(/\s+/)[0];
      try {
        await inCommand.run({ inspects: onlyInspects(line) }, () => (answer ? commandOutput.run(answer, run) : run()));
      } finally {
        if (answer) answer.live = false;
        else if (name && name !== 'wait' && !onlyInspects(line)) ctx.previousStart = began;
        hooks?.end?.();
      }
    });
    queue = done;
    return done.then(() => code);
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
 * runs as one. An `eval {{` block spans lines up to its `}}` (see
 * command-lines.ts). Does nothing when stdin is already closed.
 *
 * At a terminal, shows a `> ` prompt with line editing and history
 * (readline's own keys: arrows, Ctrl-A/E, Ctrl-U and so on) and Tab
 * completion of command names, and `... ` inside a block. Ctrl-C clears
 * the typed line; on an empty one it drops an open block, and otherwise
 * it or Ctrl-D stops the run. Piped input gets neither: EOF
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
  const blocks = new CommandAssembler();
  // Set once the run closes the input itself, rather than it ending.
  let closing = false;
  // A message in the commands' turn, after the ones before it. The
  // empty line runs nothing.
  const say = (message: string): void => {
    void runLine('', { start: () => ctx.out(`[sm-dev] ERROR: ${message}`) });
  };
  const lines = terminal
    ? readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      prompt: PROMPT,
      // Tab completes a command name, except inside an eval block,
      // where the line is JavaScript.
      completer: (line: string) => (blocks.open ? [[], line] : completeCommand(line)),
    })
    : readline.createInterface({ input: process.stdin, terminal: false });
  // Typed commands not yet done. The `> ` prompt waits for them, as a
  // shell's does, so a command's output lands before the next prompt
  // rather than under it. Typing ahead still works, on a bare line.
  let running = 0;
  // Set by a Ctrl-C while a command runs, so a second one stops the run.
  let stopArmed = false;
  const promptText = (): string => (blocks.open ? BLOCK_PROMPT : running > 0 ? '' : PROMPT);
  const showPrompt = (preserveCursor: boolean): void => {
    lines.setPrompt(promptText());
    lines.prompt(preserveCursor);
  };
  lines.on('line', (line) => {
    const got = blocks.push(line);
    if (got && 'error' in got) say(got.error);
    else if (got) {
      running++;
      // Logged as it starts, in its turn among the stream's lines.
      const text = got.command.text;
      // As a piped list echoes it: `> eval {{`, then `... ` lines.
      const echoed = echoCommand(got.command);
      void runLine(text, { start: () => ctx.logCommand?.(text, echoed) }).finally(() => {
        running--;
        if (running === 0) stopArmed = false;
        if (terminal && running === 0 && activePrompt === lines) showPrompt(true);
      });
    }
    if (terminal) showPrompt(false);
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
      if (!lines.line && blocks.open) {
        blocks.drop();
        // Before the output, which redraws the prompt.
        lines.setPrompt(promptText());
        ctx.out('[sm-dev] Dropped the eval block');
        return;
      }
      // With no prompt showing, Ctrl-C looks like it would cancel the
      // command. It can't, so the first one only says so.
      if (!lines.line && running > 0 && !stopArmed) {
        stopArmed = true;
        ctx.out('[sm-dev] A command is still running, and cannot be cancelled. Press Ctrl-C again to stop the run.');
        return;
      }
      if (!lines.line) {
        ctx.stop();
        return;
      }
      lines.write(null, { ctrl: true, name: 'e' });
      lines.write(null, { ctrl: true, name: 'u' });
    });
    // readline handles Ctrl-Z itself. On `fg` it pauses its input and
    // emits this event, but never resumes the input. Without this the
    // prompt stays frozen until some output line happens to redraw it.
    lines.on('SIGCONT', () => lines.resume());
    lines.on('close', () => {
      dropPrompt();
      ctx.stop();
    });
    activePrompt = lines;
    lines.prompt();
  } else {
    // Piped input that ends inside a block: said, rather than run
    // half-written. Not when the run itself closes the input.
    lines.on('close', () => {
      if (closing) return;
      const unclosed = blocks.drop();
      if (unclosed !== null) say(`${unclosedBlockMessage(unclosed)}, so it was not run`);
    });
  }
  return () => {
    closing = true;
    dropPrompt();
    lines.close();
    process.stdin.pause();
  };
}
