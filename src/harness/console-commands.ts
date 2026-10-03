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

import type { BrowserContext, Dialog, Page } from '@playwright/test';

import { CommandAssembler, endsOutsideBlock, listed } from './command-lines.js';
import { isJsonLine, jsonLayoutMistake, jsonResult, JSON_COMMANDS, markedLine, STDERR_LINE, withLayout, type JsonLayout } from './json-output.js';
import type * as J from './json-output.js';
import { extensionLabel, type ExtensionState } from './extension-backend.js';
import { firstLine } from './extension-link.js';
import type { HarnessHost, MenuCommandRecord } from './host.js';
import type { PageAttachment } from './page-watch.js';
import { parseCommandArgs, splitWords, unquoteWhole, type ParsedArgs } from './command-args.js';
import { ALIASES, COMMAND_NAMES, RUN_COMMAND_NAMES, commandsHelp } from './command-list.js';
import { errorSentence, readJsonFile, writeProblem } from './input-file.js';
import { PAGE_COMMANDS, runPageCommand, type EvalIn } from './page-commands.js';
import { editMultiLine } from './prompt-editor.js';
import { appendHistory, HISTORY_SIZE, historyFile, loadHistory } from './prompt-history.js';
import { defaultPageUrl, NO_DEFAULT_PAGE, preparedScriptMatches, preparedScriptName, preparedScriptPath, shownPath, withDefaultScheme, type PreparedScript } from './prepare.js';
import { currentTab, dialogKind, dialogWaitingMessage, NO_TABS, pickTab, TAB_ARG, tabName } from './tab-refs.js';
import { runLogLabel } from './run-log.js';
import { loadPage, settleTabs, waitFor } from './wait.js';
import { userscriptLabel, type SavedPageHeader } from './save-html.js';
import {
  comparableUrl, openingSavedLine, pagesToOpen, routeSavedPage, savedPageServe,
  type PageToOpen, type PageWord, type SavedPageFile, type SavedPageStart,
} from './saved-pages.js';
import {
  SCRIPT_ARG, UsageError, expandPathArg, expandPathArgs, matchJson, matchLines, prepareSource, scriptSources, validateAll, validateSources,
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
  /** Serving a saved page, from `--from-saved`. */
  saved?: SavedPageFile;
  /** The page's JavaScript dialogs, for `accept` and `dismiss`. */
  dialogs?: DialogTracker;
  /** The number of the tab that opened this one. */
  openedBy?: number;
  /**
   * Its CDP target id, for a debugging session alongside the run to
   * name the same tab. Unset if it closed before it could be read.
   */
  targetId?: string | null;
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

/**
 * A SourceMonkey-managed script, which the run didn't
 * push: named E1, E2, ... for the run, in the order it first sees them.
 */
export interface OtherScript {
  label: string;
  name: string;
  collection: string;
  /** What the toolbar badge says of it on the tab it was listed for. */
  status: string;
  values(): Promise<Record<string, unknown>>;
  setValues(values: Record<string, unknown>): Promise<void>;
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
  newTab?: (url?: string, options?: { noScript?: boolean; saved?: SavedPageStart }) => Promise<ControlledTab>;
  /** Switch a tab to running no scripts, or back, for `open --noscript` / `--script`. */
  setTabScripts?: (tab: ControlledTab, noScript: boolean) => Promise<void>;
  /** Load another script from disk, for `load`. */
  loadScript?: (file: string) => Promise<void>;
  /** Re-read scripts from disk (all, when none are named), for `update`. */
  updateScripts?: (scripts?: PreparedScript[]) => Promise<void>;
  /** The scripts this run pushed, in load order. */
  scripts: PreparedScript[];
  /** SourceMonkey-managed scripts (see `OtherScript`). */
  others?: {
    /** Those on the tab's page, as its toolbar badge lists them. */
    onTab(tab: ControlledTab): Promise<OtherScript[]>;
    /** One already listed, by its label (`E2`). */
    byLabel(label: string): OtherScript | undefined;
    /** `set` on one changes the person's own data, so needs `--force`. */
    guarded: boolean;
  };
  /** One of `others` picked for `get` and `set` (`scripts E1`), in place of `current`. */
  currentOther?: OtherScript;
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
  /**
   * The running command prints its result as JSON (`--json`), set
   * while it runs. Only for a command with a JSON form.
   */
  json?: boolean;
  /** The running command's own `--json=single` or `=multi`. */
  jsonLayout?: JsonLayout;
  /** Ends the run, as Ctrl-C does. */
  stop: () => void;
  /** The id other shells know the run by (`--run`), for `status`. */
  runId?: string;
  /** The run's log file (see run-log.ts), for `status`. */
  log?: string;
  /** The run's browser, for `status`: `connected to browser 127.0.0.1:9233`. */
  browser?: string;
  /** The same, for `status --json`. */
  browserInfo?: { address: string; owned: boolean; headless: boolean };
  /** The run's test collection's id, once a script was pushed, for `status --json`. */
  testCollection?: () => string | undefined;
  /**
   * Where the scripts run, for `status`: `SourceMonkey extension, test
   * collection D2-a3f9`. Read as `status` runs.
   */
  backend?: () => string;
  /** Whether SourceMonkey is there now, for `status`; null when unknown. */
  extension?: () => Promise<ExtensionState | null>;
  /** The run's output so far, for `wait log`. */
  output?: OutputHistory;
  /**
   * Where `output` stood when the previous command (that wasn't only a
   * look, like `status`) began, for `wait log`: a line the command set
   * off, printed while it waited for the page to settle, still counts.
   * Unset before the first.
   */
  previousStart?: number;
  /** Where `validate` and `match` find local copies of `@require`s: the run's own. */
  roots?: ScriptRoots;
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

// One wording for having none, whether as a reply or in a list.
const NO_SCRIPTS = 'No scripts are loaded';


// The commands that act on the current tab, which there may not be.
const NEEDS_A_TAB = new Set(['menu', 'open', 'reload', 'focus', 'closetab', 'accept', 'dismiss', ...PAGE_COMMANDS]);

// `script` and `tab` pick one, as `scripts` and `tabs` do given one,
// so each is run as its plural.
const RUN_ALIASES: Record<string, string> = { ...ALIASES, script: 'scripts', tab: 'tabs' };

/**
 * What's wrong with a run command's words, before it runs, or null (for
 * a name that is no run command too: that is said elsewhere). `input`:
 * the command as typed, its name first (a block's lines after a line
 * break), or as a sender's words. `flag`: the flag it's about, so one
 * that belongs before the command can be said to.
 */
export function runCommandMistake(input: { line: string } | { words: string[] }): { error: string; flag?: string } | null {
  const own = ownWords(input);
  if (!own) return null;
  const parsed = parseCommandArgs(own.command, own.rest);
  return 'error' in parsed ? parsed : null;
}

/** The run command whose help `--help` asks for (`click --help`), or null. */
export function runCommandHelp(input: { line: string } | { words: string[] }): string | null {
  const own = ownWords(input);
  if (!own) return null;
  const parsed = parseCommandArgs(own.command, own.rest);
  return 'help' in parsed && parsed.help ? own.command : null;
}

// The error for a word that names no command a run takes.
function notACommand(word: string): string {
  return `${word} is not a command. Use help to list them.`;
}

// A run command's name, aliases resolved, and its words after the name;
// null for a name that is no run command.

function ownWords(input: { line: string } | { words: string[] }): { command: string; rest: { line: string } | { words: string[] } } | null {
  let name: string;
  let rest: { line: string } | { words: string[] };
  if ('line' in input) {
    // A block's line breaks are kept, so its lines stay its own.
    const trimmed = input.line.replace(/^\s+/, '');
    name = trimmed.split(/\s/)[0];
    rest = { line: trimmed.slice(name.length).replace(/^[^\S\n]+/, '') };
  } else {
    name = input.words[0] ?? '';
    rest = { words: input.words.slice(1) };
  }
  if (!RUN_COMMAND_NAMES.includes(ALIASES[name] ?? name)) return null;
  return { command: RUN_ALIASES[name] ?? name, rest };
}

/**
 * A command line's words, as the prompt splits them (quotes kept
 * together), for telling which command it is and where it runs.
 */
export function commandWords(line: string): string[] {
  const trimmed = line.trim();
  const name = trimmed.split(/\s+/)[0];
  return [name, ...splitWords(trimmed.slice(name.length)).map((w) => w.text)];
}

// Commands that only look: what they print answers whoever asked, and
// is no part of the run's story.
const INSPECTING = new Set(['help', 'status', 'values', 'get', 'snapshot', 'screenshot', 'savehtml', 'probe', 'logs', 'match', 'validate']);

/**
 * Whether a command line only inspects, so its output goes back to the
 * client that sent it alone, rather than into the run's stream too. `tabs`, `scripts` and `menu` inspect when they list, and
 * change things when they pick or fire.
 */
export function onlyInspects(line: string): boolean {
  const [typed = '', ...words] = line.trim().split(/\s+/);
  // `tabs --json` still lists.
  const rest = words.filter((word) => !/^--(no)?json(=|$)/.test(word));
  const command = RUN_ALIASES[typed] ?? typed;
  if (INSPECTING.has(command)) return true;
  if (command === 'tabs' || command === 'scripts') return rest.length === 0;
  if (command === 'menu') return rest.length === 0 || (rest.length === 1 && (rest[0] === 'all' || /^[Tt]\d+$/.test(rest[0])));
  return false;
}

/**
 * Whether a command line has a JSON form (`--json`): one of
 * `JSON_COMMANDS`, in a form that only looks (`tabs`, not `tabs T2`).
 */
export function hasJsonForm(line: string): boolean {
  const typed = line.trim().split(/\s+/)[0];
  return JSON_COMMANDS.includes(RUN_ALIASES[typed] ?? typed) && onlyInspects(line);
}

/**
 * Where a running command's output goes instead of the run's stream,
 * while it runs: an inspecting command answers the client that sent it
 * alone. Output the page or the scripts produce meanwhile
 * isn't the command's, and still goes to the stream. `live` goes false
 * when the command ends, so anything it started that prints later goes
 * to the stream rather than a closed connection.
 */
export const commandOutput = new AsyncLocalStorage<{ line: (line: string) => void; live: boolean }>();

/** How a line saying a command was invalid starts. */
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
 * Run one typed line. Returns once its effect has been applied, so an
 * agent driving this over a pipe can send the next line knowing the
 * previous one is done. For a line a client sent: `cwd` is
 * where the files it names are, and `words` are the sender's own words
 * (the line is them joined by spaces), which page commands take as
 * they are rather than splitting the line.
 */
export async function runConsoleCommand(
  line: string, ctx: ConsoleContext, { cwd = process.cwd(), words }: { cwd?: string; words?: string[] } = {},
): Promise<number | boolean | void> {
  // A block's lines (after the first line break) are kept as they are,
  // spaces at the end included, since `type` types them.
  const block = line.includes('\n');
  const trimmed = block ? line.trimStart() : line.trim();
  if (!trimmed) return;
  const typedCommand = trimmed.split(/\s+/)[0];
  // The sender's words when they start with the command; a whole
  // command sent as one word is read like a typed one.
  const own = ownWords(words?.[0] === typedCommand ? { words } : { line: trimmed });
  if (!own) {
    ctx.out(`[sm-dev] ERROR: ${notACommand(typedCommand)}`);
    return false;
  }
  const { command } = own;
  const parsed = parseCommandArgs(command, own.rest);
  if ('error' in parsed) {
    ctx.out(`[sm-dev] ERROR: ${parsed.error}`);
    return false;
  }
  // The command's own --json or --nojson over the sender's global one,
  // and its own layout over the client's. Its help is text either way.
  const ownJson = parsed.flags['--json'];
  if (typeof ownJson === 'string') {
    const mistake = jsonLayoutMistake(ownJson);
    if (mistake) {
      ctx.out(`[sm-dev] ERROR: ${mistake}`);
      return false;
    }
    if (ctx.json !== undefined) ctx.jsonLayout = ownJson as JsonLayout;
  }
  if (ctx.json !== undefined) ctx.json = !parsed.help && (parsed.flags['--nojson'] ? false : ownJson ? true : ctx.json);
  // `click --help`: its help, as `help click` gives it, rather than a click.
  if (parsed.help) {
    for (const l of commandsHelp([command]).text.trimEnd().split('\n')) ctx.out(l);
    return;
  }
  // Its arguments, its text (the rest of its line, for the commands
  // that take one), and its flags.
  const args = parsed.words;
  const text = parsed.text ?? '';
  const { flags } = parsed;
  const current = ctx.current ?? ctx.scripts[0];
  const scriptId = current?.id;
  const other = ctx.currentOther;
  // Named in the output only when there is a choice to be clear about.
  const whose = other ? ` (${other.label}: ${other.name})`
    : ctx.scripts.length > 1 && current ? ` (${preparedScriptName(current)})` : '';
  const picked = currentTab(ctx);
  // Every controlled tab can be closed, T1 included.
  if (!picked && NEEDS_A_TAB.has(command)) {
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

  switch (command) {
    case 'match':
      return matchCommand(ctx, args, cwd);
    case 'validate':
      return validateCommand(ctx, args, cwd);
    case 'menu': {
      // A label quoted as a whole is just that, even `all` or `T2.x`.
      const label = unquoteWhole(text);
      if (label.quoted) {
        if (blockedByDialog([tab])) return false;
        return fireMenu(ctx, tab, label.text);
      }
      if (ctx.json && (text === 'all' || !text || /^[Tt]\d+$/.test(text))) {
        const which = text === 'all' ? ctx.tabs() : [text ? pickTab(ctx, text) : tab];
        if (which.includes(null)) return false;
        ctx.out(jsonResult('menu', { tabs: (which as ControlledTab[]).map((t) => menuJson(ctx, t)) } satisfies J.MenuData));
        return;
      }
      if (text === 'all') {
        ctx.out('Menu commands:');
        printPerTab(ctx, tab, (t) => menuLines(ctx, t), 'None registered');
        return;
      }
      const ref = tabRef(ctx, text, tab, true);
      if (!ref) return false;
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
      if (blockedByDialog([ref.tab])) return false;
      // The label after `T2.` may be quoted too.
      return fireMenu(ctx, ref.tab, unquoteWhole(ref.rest).text);
    }
    case 'newtab':
      return openNewTab(ctx, args, flags, cwd);
    case 'closetab':
      return closeTabs(ctx, args, flags['--force'] === true, tab);
    case 'tabs': {
      const named = namedTab(ctx, 'tabs', parsed);
      if (named === null) return false;
      if (named === undefined) {
        if (ctx.json) ctx.out(jsonResult('tabs', { tabs: ctx.tabs().map((t) => tabJson(ctx, t)) } satisfies J.TabsData));
        else printTabs(ctx);
        return;
      }
      // `tabs new` was newtab's old name.
      if (named === 'new') {
        ctx.out('[sm-dev] ERROR: The tabs command picks a tab. To open one, use newtab.');
        return false;
      }
      const picked = pickTab(ctx, named);
      if (!picked) return false;
      ctx.tab = picked;
      ctx.out(`[sm-dev] The page commands now act on ${tabName(picked)} (${picked.page.url()})`);
      return;
    }
    case 'scripts': {
      if (!text && ctx.json) {
        const others = await otherScriptsJson(ctx, picked);
        if (!others) return false;
        ctx.out(jsonResult('scripts', {
          ...(picked ? { tab: tabName(picked) } : {}),
          scripts: [...ctx.scripts.map((script) => scriptJson(ctx, script)), ...others],
        } satisfies J.ScriptsData));
        return;
      }
      if (!text) {
        ctx.out(`Loaded scripts${activityHeading(picked)}:`);
        if (ctx.scripts.length === 0) ctx.out(`  ${NO_SCRIPTS}`);
        for (const script of ctx.scripts) {
          ctx.out(scriptRow(ctx, script));
          if (picked) ctx.out(activityLine(ctx, picked, script.id));
        }
        for (const l of await otherLines(ctx, picked)) ctx.out(l);
        return;
      }
      if (OTHER_LABEL.test(text)) {
        const found = await pickOther(ctx, text, picked);
        if (!found) return false;
        ctx.currentOther = found;
        ctx.out(`[sm-dev] Selected ${found.label}: ${found.name}`);
        return;
      }
      const ref = tabRef(ctx, text, tab);
      if (!ref) return false;
      if (!ref.rest) {
        ctx.out('[sm-dev] ERROR: The scripts command needs a script after the tab, e.g. scripts T2.2');
        return false;
      }
      const found = pickScript(ctx, ref.rest);
      if (!found) return false;
      ctx.current = found;
      ctx.currentOther = undefined;
      if (!ref.named) {
        ctx.out(`[sm-dev] Selected ${scriptLabel(found)}`);
        return;
      }
      ctx.tab = ref.tab;
      ctx.out(`[sm-dev] Selected ${scriptLabel(found)}, and ${tabName(ref.tab)} for the page commands`);
      return;
    }
    case 'status': {
      if (ctx.json) {
        ctx.out(jsonResult('status', await statusJson(ctx, picked)));
        return;
      }
      if (ctx.runId) {
        // Asked each time, since the person may install it mid-run.
        const extension = ctx.browser ? extensionLabel(await ctx.extension?.() ?? null) : '';
        ctx.out(`Run: ${ctx.runId} (pid ${process.pid})${ctx.browser ? `, ${ctx.browser}${extension ? ` (${extension})` : ''}` : ''}`);
      }
      if (ctx.backend) ctx.out(`Backend: ${ctx.backend()}`);
      if (ctx.log) ctx.out(`Log: ${runLogLabel(ctx.log, ctx.runId)}`);
      // The tabs first, each with its URL, ids and any dialog; then
      // the scripts on the current one, which is marked there. With no
      // tab, still the scripts and what they have stored.
      printTabs(ctx);
      for (const l of await statusLines(ctx, tab)) ctx.out(l);
      for (const l of await otherLines(ctx, tab)) ctx.out(l);
      return;
    }
    case 'values': {
      if (OTHER_LABEL.test(text)) {
        const found = await pickOther(ctx, text, picked);
        if (!found) return false;
        if (ctx.json) {
          ctx.out(jsonResult('values', { scripts: [{ script: found.label, name: found.name, values: await found.values() }] } satisfies J.ValuesData));
          return;
        }
        ctx.out('Stored values:');
        ctx.out(`  ${otherLabel(found)}`);
        for (const l of valueEntries(await found.values())) ctx.out(l);
        return;
      }
      if (ctx.scripts.length === 0) {
        if (ctx.json) ctx.out(jsonResult('values', { scripts: [] } satisfies J.ValuesData));
        else ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
        return;
      }
      // The values are each script's, the same on every tab, so all is
      // every script's, as with nothing named, not a list per tab.
      const ref = tabRef(ctx, text === 'all' ? '' : text, tab);
      if (!ref) return false;
      let scripts = ctx.scripts;
      if (ref.rest) {
        const found = pickScript(ctx, ref.rest);
        if (!found) return false;
        scripts = [found];
      } else if (ref.named) {
        scripts = runningOn(ctx, ref.tab);
        if (scripts.length === 0 && !ctx.json) {
          ctx.out(`[sm-dev] No script is running on ${tabName(ref.tab)}`);
          return;
        }
      }
      await settleWrites();
      if (ctx.json) {
        const entries = [];
        for (const script of scripts) {
          entries.push({ script: scriptNumber(ctx, script), name: preparedScriptName(script), values: script.id ? await ctx.host.valuesOf(script.id) : {} });
        }
        // Named a tab: only the scripts running there, which `tab` says.
        const onTab = ref.named && !ref.rest ? { tab: tabName(ref.tab) } : {};
        ctx.out(jsonResult('values', { ...onTab, scripts: entries } satisfies J.ValuesData));
        return;
      }
      ctx.out('Stored values:');
      for (const l of await valueLines(ctx, scripts)) ctx.out(l);
      return;
    }
    case 'get': {
      if (!scriptId && !other) {
        ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
        return;
      }
      if (!text) {
        ctx.out('[sm-dev] ERROR: The get command needs a key');
        return false;
      }
      await settleWrites();
      const values = other ? await other.values() : await ctx.host.valuesOf(scriptId!);
      if (ctx.json) {
        const found = Object.hasOwn(values, text);
        ctx.out(jsonResult('get', {
          script: other ? other.label : scriptNumber(ctx, current!), key: text, found, ...(found ? { value: values[text] } : {}),
        } satisfies J.GetData));
        return;
      }
      ctx.out(`  ${text} = ${JSON.stringify(values[text])}`);
      return;
    }
    case 'set': {
      if (!scriptId && !other) {
        ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
        return;
      }
      // `set <key> <json>`, the JSON maybe a `{{` block's lines, or
      // `set <key> --file <path>`. The key is on the command's own
      // line, never the block's first.
      const [key] = args;
      const from = flags['--file'];
      const raw = [text, parsed.block].filter((part) => part).join('\n');
      let value: unknown;
      if (typeof from === 'string') {
        if (!key || raw) {
          ctx.out('[sm-dev] ERROR: The set command takes a key and one file, e.g. set units --file units.json');
          return false;
        }
        const file = path.resolve(cwd, from);
        try {
          value = readJsonFile(file, shownPath(file, cwd));
        } catch (err) {
          ctx.out(`[sm-dev] ERROR: ${(err as Error).message}`);
          return;
        }
      } else {
        if (!key || !raw) {
          ctx.out('[sm-dev] ERROR: The set command needs a key and a JSON value, e.g. set units "metric"');
          return false;
        }
        try {
          value = JSON.parse(raw);
        } catch (err) {
          // A bare word typed inline is most likely a string without
          // its quotes; a block's JSON is just broken.
          ctx.out(parsed.block !== undefined
            ? `[sm-dev] ERROR: The value of ${key} is not JSON: ${(err as Error).message}`
            : `[sm-dev] ERROR: ${raw} is not JSON. A string needs quotes.`);
          return;
        }
      }
      if (flags['--force'] === true && !other) {
        ctx.out('[sm-dev] ERROR: The --force flag is for SourceMonkey-managed scripts only (E1, ...)');
        return false;
      }
      // A SourceMonkey-managed script never runs in the run's tabs, so a
      // dialog there doesn't hold up its write.
      if (!other && blockedByDialog(ctx.tabs())) return;
      // Through the host, so a running script sees it on its next read
      // and its value-change listeners fire, as another tab's write
      // would.
      if (other) {
        if (ctx.others?.guarded && flags['--force'] !== true) {
          ctx.out(`[sm-dev] ERROR: ${other.label} is a SourceMonkey-managed script, so this would change its real stored data. Use --force to continue.`);
          return false;
        }
        await other.setValues({ [key]: value });
      } else {
        await ctx.host.setValues(scriptId!, { [key]: value });
      }
      ctx.out(`[sm-dev] Set ${key}${whose}`);
      return;
    }
    case 'reload': {
      const noWait = flags['--nowait'] === true;
      const mode = scriptsMode(ctx, 'reload', flags);
      if (mode === null) return false;
      const named = namedTab(ctx, 'reload', parsed);
      if (named === null) return false;
      if (named === 'all') {
        // All at once, so one slow page holds up no other.
        const all = reloadable(ctx.tabs(), ctx.out);
        for (const t of all) if (!await switchScripts(ctx, t, mode)) return false;
        const loaded = await Promise.all(all.map((t) => reloadTab(t, ctx.host, ctx.out)));
        if (!noWait) await settleTabs(ctx.host, all.filter((_, i) => loaded[i]), ctx.out);
        return;
      }
      const target = named !== undefined ? pickTab(ctx, named) : tab;
      if (!target || blockedByDialog([target])) return false;
      if (!await switchScripts(ctx, target, mode)) return false;
      if (await reloadTab(target, ctx.host, ctx.out) && !noWait) await settleTabs(ctx.host, [target], ctx.out);
      return;
    }
    case 'load': {
      if (args.length === 0) {
        ctx.out('[sm-dev] ERROR: The load command needs a script file');
        return false;
      }
      if (!ctx.loadScript) {
        ctx.out('[sm-dev] This run cannot load scripts');
        return;
      }
      // It reloads every tab it affects, so any tab's dialog blocks it.
      if (blockedByDialog(ctx.tabs())) return;
      // All expanded first, so a glob matching nothing loads none.
      for (const file of expandPathArgs(args, cwd, { scripts: true })) {
        // A relative path sent from another directory is the sender's.
        await ctx.loadScript(cwd !== process.cwd() && !path.isAbsolute(file) ? path.resolve(cwd, file) : file);
      }
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
      if (!text || text === 'all') {
        await ctx.updateScripts();
        return;
      }
      const script = pickScript(ctx, text);
      if (!script) return false;
      await ctx.updateScripts([script]);
      return;
    }
    case 'open': {
      // `--noscript` / `--script` switch the tab's mode, which lasts,
      // as does `--from-saved`.
      const saved = savedFlags(ctx, flags);
      if (!saved) return false;
      const noWait = flags['--nowait'] === true;
      const mode = scriptsMode(ctx, 'open', flags);
      if (mode === null) return false;
      // A glob stands for the files it matches, of which it takes one.
      const page = args.flatMap((w) => expandPathArg(w, cwd));
      // `open T2 <page>`: a tab first, as page commands take one.
      let inTab: ControlledTab | undefined;
      if (page.length === 2 && TAB_ARG.test(page[0])) {
        const picked = pickTab(ctx, page[0]);
        if (!picked) return false;
        inTab = picked;
        page.shift();
      }
      // Rather than a page at http://all.
      if (page[0] === 'all' && page.length === 1) {
        ctx.out('[sm-dev] ERROR: The open command navigates one tab. To open a tab for each script, use newtab all.');
        return false;
      }
      if (page.length > 1) {
        ctx.out('[sm-dev] ERROR: The open command opens one page, so it takes one URL, file or script. To open several, use newtab.');
        return false;
      }
      const where = page[0] ?? '';
      // `T2`: the selected script's page, in T2; `T2.3`: script 3's. Only
      // those shapes, so a host like `t2.example.com` stays a URL.
      const target = inTab ? { tab: inTab, rest: where } : TAB_REF.test(where) ? tabRef(ctx, where, tab) : { tab, rest: where };
      if (!target) return false;
      const named = target.rest ? pageFor(ctx, target.rest, cwd) : undefined;
      if (named === null) return false;
      const [opening] = await pagesToOpen(named ? [{ word: target.rest, url: named }] : [], saved, cwd);
      // With the mode switched and no page named, the page it's on.
      const url = opening?.url ?? (mode !== undefined ? target.tab.page.url()
        : current ? scriptPage(ctx, current) : null);
      if (!url) {
        if (!current) ctx.out('[sm-dev] ERROR: The open command needs a URL, since no script is loaded');
        return false;
      }
      if (blockedByDialog([target.tab])) return false;
      if (!await switchScripts(ctx, target.tab, mode)) return false;
      if (opening?.saved) {
        await serveSavedPage(target.tab, opening.saved, ctx.out, target.tab.noScript === true || ctx.scripts.length === 0);
        ctx.out(openingSavedLine(opening.saved.given, url, tabName(target.tab)));
      }
      if (!await gotoInTab(target.tab, ctx.host, url, ctx.out)) return false;
      if (!noWait) await settleTabs(ctx.host, [target.tab], ctx.out);
      return;
    }
    case 'wait':
      return waitFor(ctx, parsed);
    case 'focus': {
      const named = namedTab(ctx, 'focus', parsed);
      if (named === null) return false;
      const target = named !== undefined ? pickTab(ctx, named) : tab;
      if (!target) return false;
      const which = ctx.tabs().length > 1 ? tabName(target) : 'the tab';
      await focusTab(target.page)
        .then(() => ctx.out(`[sm-dev] Brought ${which} to the front`))
        .catch((err) => ctx.out(`[sm-dev] Could not bring ${which} to the front: ${(err as Error).message}`));
      return;
    }
    case 'accept':
    case 'dismiss': {
      const target = parsed.tab !== undefined ? pickTab(ctx, parsed.tab) : tab;
      if (!target) return false;
      const dialog = target.dialogs?.take();
      if (!dialog) {
        const elsewhere = ctx.tabs().find((t) => t.dialogs?.current);
        ctx.out(elsewhere
          ? `[sm-dev] No dialog is open on ${tabName(target)}. ${tabName(elsewhere)} has one; use ${[command, tabName(elsewhere), text].filter(Boolean).join(' ')}.`
          : '[sm-dev] No dialog is open');
        return;
      }
      if (text && dialog.type() !== 'prompt') {
        ctx.out(`[sm-dev] ERROR: Only a prompt dialog takes text. This one is ${dialogKind(dialog)}.`);
        target.dialogs!.putBack(dialog);
        return;
      }
      // A bare accept keeps the prompt's own default, as pressing OK
      // on it would.
      const answered = command === 'accept'
        ? dialog.accept(text || dialog.defaultValue())
        : dialog.dismiss();
      await answered.then(
        () => ctx.out(`[sm-dev] ${command === 'accept' ? 'Accepted' : 'Dismissed'} the dialog`),
        () => ctx.out('[sm-dev] The dialog was already closed'),
      );
      return;
    }
    default: {
      if (!PAGE_COMMANDS.has(command)) {
        ctx.out(`[sm-dev] ERROR: ${notACommand(command)}`);
        return false;
      }
      // The tab named first, or the current one.
      let target = tab;
      if (parsed.tab !== undefined) {
        const named = pickTab(ctx, parsed.tab);
        if (!named) return false;
        target = named;
      }
      // `logs` only reads what was recorded; the rest reach into a page
      // a dialog has stopped.
      if (command !== 'logs' && blockedByDialog([target])) return false;
      let evalIn: EvalIn | undefined;
      if (command === 'eval' && parsed.flags['--script'] !== undefined) {
        const resolved = evalScope(ctx, parsed.flags['--script']);
        if (!resolved) return false;
        evalIn = resolved;
      }
      return runPageCommand(command, { ...parsed, userscripts: runningOn(ctx, target).map(userscriptLabel), evalIn, json: ctx.json === true }, target, ctx.out, cwd);
    }
  }
}

/**
 * The tab a command whose one argument is a tab names: the one the
 * parser took, or else the word given, which `pickTab` checks (a
 * target id's start, which isn't tab-shaped enough to lead a page
 * command). Undefined for none; null (said why) for more than one.
 */
function namedTab(ctx: ConsoleContext, command: string, parsed: ParsedArgs): string | undefined | null {
  if (parsed.tab !== undefined && parsed.words.length > 0) {
    ctx.out(`[sm-dev] ERROR: The ${command} command takes one tab`);
    return null;
  }
  return parsed.tab ?? parsed.words[0];
}

// How a script is shown in every list: its @name, and the file when
// that says something the name doesn't.
function scriptLabel(script: PreparedScript): string {
  const name = preparedScriptName(script);
  const file = preparedScriptPath(script);
  // No `@name`: the name is its file already, so the path alone.
  return name === script.script.relativePath || name === file ? file : `${name} (${file})`;
}

// One script's row in any list of them: its number in the `scripts` list,
// with `*` on the one `get` and `set` act on.
function scriptRow(ctx: ConsoleContext, script: PreparedScript): string {
  return `${script === selectedScript(ctx) ? '* ' : '  '}${ctx.scripts.indexOf(script) + 1}: ${scriptLabel(script)}`;
}

// The run's script `get` and `set` act on, marked `*` in the lists:
// none while a SourceMonkey-managed script (`E1`) is picked instead.
function selectedScript(ctx: ConsoleContext): PreparedScript | undefined {
  return ctx.currentOther ? undefined : ctx.current ?? ctx.scripts[0];
}

/**
 * Where `eval --script` runs: inside the selected script, or the one
 * `--script=<script>` names. The scripts' shared world when no run
 * script is selected (none loaded, or an `E` script picked, which has
 * no eval hook). Null, said why, when the name picks none.
 */
function evalScope(ctx: ConsoleContext, flag: string | true): EvalIn | null {
  const script = flag === true ? selectedScript(ctx) : pickScript(ctx, flag);
  if (!script) return flag === true ? 'scripts' : null;
  // No hook: not pushed into the extension, so it hasn't run anywhere.
  const hook = script.id ? ctx.host.evalHook(script.id) : null;
  return { scope: hook && { world: script.world, ...hook }, name: preparedScriptName(script), named: flag !== true };
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
    if (!script) ctx.out(`[sm-dev] There is no script ${arg}. Use scripts to list them.`);
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
    ctx.out(`[sm-dev] No loaded script matches ${arg}. Use scripts to list them.`);
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
    } else {
      // A glob expanded, a directory taken for its scripts.
      for (const found of expandPathArg(word, cwd, { scripts: true })) {
        if (SCRIPT_ARG.test(found)) files.push(found);
        else pages.push({ url: withDefaultScheme(found, cwd) });
      }
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
  const loadedCount = scripts.length;
  for (const source of await scriptSources(files, cwd)) scripts.push({ label: source.label, prepared: await prepareSource(source, rootsOf(ctx, cwd)) });
  if (ctx.json) {
    const results: J.MatchData['results'] = scripts.map(({ label, prepared }, i) => ({
      script: i < loadedCount ? scriptNumber(ctx, prepared) : label,
      name: preparedScriptName(prepared),
      ...matchJson(prepared, pages),
    }));
    ctx.out(jsonResult('match', { results } satisfies J.MatchData));
    return results.every((r) => r.valid && r.pages.every((p) => p.matches)) ? 0 : 1;
  }
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
    reread.push({ label: shownPath(file, cwd), file });
  }
  // The loaded scripts first, in their order, then the paths.
  sources.unshift(...reread);
  return validateAll(sources, rootsOf(ctx, cwd), (line) => ctx.out(line), ctx.json === true);
}

// ---------- Tabs ----------

// `--noscript` / `--script` among a command's flags: true for no
// scripts, false for scripts, undefined for neither, and null (said
// why) for both.
function scriptsMode(ctx: ConsoleContext, command: string, flags: Record<string, string | true>): boolean | undefined | null {
  if (flags['--noscript'] && flags['--script']) {
    ctx.out(`[sm-dev] ERROR: The ${command} command takes --noscript or --script, not both`);
    return null;
  }
  return flags['--noscript'] ? true : flags['--script'] ? false : undefined;
}

// `--from-saved`, `--url URL` and `--offline` among a command's flags;
// null (said why) when `--url` is empty. What they combine with is
// `pagesToOpen`'s to check.
function savedFlags(ctx: ConsoleContext, flags: Record<string, string | true>): { fromSaved: boolean; url?: string; offline: boolean } | null {
  const url = flags['--url'];
  if (url === '') {
    ctx.out('[sm-dev] ERROR: The --url flag needs a URL, e.g. --url https://example.com/page');
    return null;
  }
  return { fromSaved: flags['--from-saved'] === true, url: typeof url === 'string' ? url : undefined, offline: flags['--offline'] === true };
}

/**
 * Warns when a saved page was saved with userscripts running: their
 * changes are in it, so running them again may apply them twice.
 * Nothing to say for a tab that runs none.
 */
export function warnSavedUserscripts(out: (line: string) => void, given: string, header: SavedPageHeader, noScript: boolean): void {
  if (noScript || header.userscripts.length === 0) return;
  out(`[sm-dev] ${given} was saved with userscripts running, so their changes are already in it: ${header.userscripts.join(', ')}`);
}

// The pages already routed for saved pages. The route reads the tab's
// `saved` on each request, so it is added once per page.
const routedPages = new WeakSet<Page>();

/**
 * Makes `tab` serve `saved` from now on: its URL gets the file, read
 * fresh on each load. It lasts until another saved page replaces it;
 * loading another URL in the tab goes to the live site meanwhile.
 */
/**
 * Starts serving a saved page in `tab` (`serveSaved`), first warning of
 * the userscripts whose changes its file has, unless `runsNone`: the
 * tab runs no scripts, or none are loaded.
 */
export async function serveSavedPage(tab: ControlledTab, saved: SavedPageStart, out: (line: string) => void, runsNone: boolean): Promise<void> {
  const { userscripts, ...file } = saved;
  warnSavedUserscripts(out, file.given, { url: file.url, userscripts }, runsNone);
  await serveSaved(tab, file, out);
}

export async function serveSaved(tab: ControlledTab, saved: SavedPageFile, out: (line: string) => void): Promise<void> {
  tab.saved = saved;
  if (routedPages.has(tab.page)) return;
  routedPages.add(tab.page);
  await routeSavedPage(tab.page, () => (tab.saved ? savedPageServe(tab.page, tab.saved, out) : undefined));
}

// Whether the tab shows its saved page now.
function showingSaved(tab: ControlledTab): boolean {
  return tab.saved !== undefined && comparableUrl(tab.page.url()) === comparableUrl(tab.saved.url);
}

// ` (from saved: page.html)` after a tab's URL, while it shows its saved page.
function savedSuffix(tab: ControlledTab): string {
  if (!showingSaved(tab)) return '';
  return ` (from saved: ${tab.saved!.given}${tab.saved!.offline ? ', offline' : ''})`;
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
  return loadInTab(tab, host, () => loadPage(tab.page, (o) => tab.page.reload(o)), `[sm-dev] ${tabName(tab)} could not be reloaded`, out);
}

/** Navigate one tab to `url`, as `reloadTab` reloads it. */
export function gotoInTab(tab: ControlledTab, host: HarnessHost, url: string, out: (line: string) => void): Promise<boolean> {
  return loadInTab(tab, host, () => loadPage(tab.page, (o) => tab.page.goto(url, o)), '[sm-dev] Navigation failed', out);
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
  tab: ControlledTab, host: HarnessHost, load: () => Promise<void>, failed: string, out: (line: string) => void,
): Promise<boolean> {
  const scripts = tab.link.injectedScripts().filter((s) => s.id);
  const ids = scripts.map((s) => s.id!);
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
    const names = scripts.filter((s) => waiting.includes(s.id!)).map(preparedScriptName);
    if (names.length > 0) {
      out(`[sm-dev] ${names.join(', ')} had not started on ${tabName(tab)} after ${SCRIPTS_REPORT_MAX_MS / 1000} seconds`);
    }
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
    ctx.out(`${tab === current ? '* ' : '  '}${tabName(tab)}: ${tab.page.url()}${savedSuffix(tab)}${none}${opener}${targetIdSuffix(tab.targetId)}`);
    const dialog = tab.dialogs?.current;
    if (dialog) ctx.out(`    Waiting on ${dialogKind(dialog)} dialog: ${JSON.stringify(dialog.message())}`);
    const running = runningOn(ctx, tab);
    // By @name alone, the file being in `scripts`. The selected script is one
    // for the whole run, so its `*` goes only under the current tab.
    const selected = tab === current ? selectedScript(ctx) : undefined;
    for (const script of running) {
      ctx.out(`   ${script === selected ? '* ' : '  '}${ctx.scripts.indexOf(script) + 1}: ${preparedScriptName(script)}`);
    }
  }
}

// ---------- JSON forms (see json-output.ts) ----------

// A loaded script's id: its number in the `scripts` list.
function scriptNumber(ctx: ConsoleContext, script: PreparedScript): string {
  return String(ctx.scripts.indexOf(script) + 1);
}

function tabJson(ctx: ConsoleContext, tab: ControlledTab): J.Tab {
  const dialog = tab.dialogs?.current;
  const saved = showingSaved(tab) ? tab.saved : undefined;
  return {
    id: tabName(tab),
    url: tab.page.url(),
    ...(tab.targetId ? { targetId: tab.targetId } : {}),
    selected: tab === currentTab(ctx),
    ...(tab.noScript ? { noScript: true } : {}),
    ...(saved ? { savedFrom: saved.given, ...(saved.offline ? { offline: true } : {}) } : {}),
    ...(tab.openedBy ? { openedBy: `T${tab.openedBy}` } : {}),
    ...(dialog ? { dialog: { kind: dialogKind(dialog), message: dialog.message() } } : {}),
    scripts: runningOn(ctx, tab).map((script) => scriptNumber(ctx, script)),
  };
}

function scriptJson(ctx: ConsoleContext, script: PreparedScript): J.Script {
  return {
    id: scriptNumber(ctx, script),
    kind: 'run',
    name: preparedScriptName(script),
    file: preparedScriptPath(script),
    status: script.status,
    ...(script.diagnostic ? { error: script.diagnostic } : {}),
    ...(script === selectedScript(ctx) ? { selected: true } : {}),
    tabs: ctx.tabs().map((tab) => ({ tab: tabName(tab), state: activeOn(ctx, tab, script.id) ? 'running' : 'not-running' })),
  };
}

// The badge's word for an extension script's state, as JSON.
const OTHER_STATE: Record<string, J.TabState> = {
  OK: 'running',
  ERROR: 'error',
  REJECTED: 'refused',
  MISSING: 'not-started',
  UNEXPECTED: 'unexpected',
  RELOAD: 'changed',
  NOT_LOADED: 'kept-out',
};

// The SourceMonkey-managed scripts on `tab`, as JSON; null (said why)
// when they couldn't be listed.
async function otherScriptsJson(ctx: ConsoleContext, tab: ControlledTab | undefined): Promise<J.Script[] | null> {
  if (!ctx.others || !tab) return [];
  let others: OtherScript[];
  try {
    others = await ctx.others.onTab(tab);
  } catch (err) {
    ctx.out(`[sm-dev] SourceMonkey-managed scripts on ${tabName(tab)} could not be listed: ${firstLine(err)}`);
    return null;
  }
  return others.map((o) => ({
    id: o.label,
    kind: 'installed',
    name: o.name,
    ...(o.collection ? { collection: { name: o.collection } } : {}),
    ...(o.label === ctx.currentOther?.label ? { selected: true } : {}),
    tabs: [{ tab: tabName(tab), state: OTHER_STATE[o.status] ?? 'running' }],
  }));
}

async function statusJson(ctx: ConsoleContext, tab: ControlledTab | undefined): Promise<J.StatusData> {
  const { reports } = ctx.host;
  const scripts: J.StatusScript[] = [];
  for (const script of ctx.scripts) {
    const id = script.id;
    const errors = (tab ? fromTab(ctx, tab, reports.errors) : reports.errors).filter((r) => r.scriptId === id);
    scripts.push({
      ...scriptJson(ctx, script),
      ...(tab ? { menuCommands: fromTab(ctx, tab, reports.menuCommands).filter((r) => r.scriptId === id).length } : {}),
      values: id ? Object.keys(await ctx.host.valuesOf(id)).length : 0,
      errors: errors.length,
      ...(errors.length > 0 ? { lastError: errors.at(-1)!.message } : {}),
    });
  }
  const others = await otherScriptsJson(ctx, tab) ?? [];
  let run: J.StatusData['run'];
  if (ctx.runId && ctx.browserInfo) {
    const extension = await ctx.extension?.() ?? null;
    const collection = ctx.testCollection?.();
    run = {
      id: ctx.runId,
      pid: process.pid,
      browser: ctx.browserInfo,
      ...(extension ? { sourceMonkey: extension } : {}),
      ...(collection ? { testCollection: collection } : {}),
      ...(ctx.log ? { log: ctx.log } : {}),
    };
  }
  return {
    ...(run ? { run } : {}),
    tabs: ctx.tabs().map((t) => tabJson(ctx, t)),
    ...(tab ? { tab: tabName(tab) } : {}),
    scripts: [...scripts, ...others],
  };
}

// A tab's menu commands, as JSON, numbered as `menu` numbers them.
function menuJson(ctx: ConsoleContext, tab: ControlledTab): J.MenuData['tabs'][number] {
  let n = 0;
  const commands = menuGroups(ctx, tab).flatMap(({ script, commands: registered }) => registered
    .map((c) => ({ id: `M${++n}`, script: scriptNumber(ctx, script), name: c.name })));
  return { tab: tabName(tab), url: tab.page.url(), commands };
}

// How long `closetab` waits for a tab to close, or to ask first.
const CLOSE_TIMEOUT_MS = 5000;

// `closetab [tab...|all] [--force]`: closes the current tab, the tabs
// named, or all of them. Each is named before any closes, so a slip
// closes none. The tabs' own close handlers say each closed.
//
// The page's beforeunload handlers run, as when a person closes a tab,
// so a page that asks first ("Leave site?") shows its dialog, which the
// dialog tracker reports for `accept` (leave) or `dismiss` (stay).
// `--force` skips them.
async function closeTabs(ctx: ConsoleContext, words: string[], force: boolean, current: ControlledTab): Promise<void | false> {
  let tabs: ControlledTab[];
  if (words.length === 1 && words[0] === 'all') {
    tabs = ctx.tabs();
  } else if (words.length === 0) {
    tabs = [current];
  } else {
    tabs = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i] === 'all') {
        ctx.out('[sm-dev] ERROR: The closetab command takes all by itself, to close all tabs');
        return false;
      }
      const picked = pickTab(ctx, words[i]);
      if (!picked) return;
      if (!tabs.includes(picked)) tabs.push(picked);
    }
  }
  // A page stopped by a dialog can't run its beforeunload, so it's left
  // open, as `reload all` leaves it; the rest still close.
  const waiting = force ? [] : tabs.filter((t) => t.dialogs?.current);
  for (const t of waiting) {
    ctx.out(`[sm-dev] ${tabName(t)} is waiting on ${dialogKind(t.dialogs!.current!)} dialog, so it was not closed. Answer it, or use closetab ${tabName(t)} --force.`);
  }
  await Promise.all(tabs.filter((t) => !waiting.includes(t)).map((t) => closeTab(ctx, t, force)));
  // Says where the page commands act now, if their tab closed.
  currentTab(ctx);
}

// Closes one tab for `closetab`, and says if it didn't close: it asked
// first (its dialog, reported by the tracker, is waiting on an answer),
// or it didn't close in time.
async function closeTab(ctx: ConsoleContext, tab: ControlledTab, force: boolean): Promise<void> {
  const { page } = tab;
  if (force) {
    // A page stopped on a dialog never finishes closing, so the dialog
    // goes first: a beforeunload one accepted, which leaves the page,
    // any other dismissed.
    const dialog = tab.dialogs?.take();
    if (dialog) await (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  let onClose = (): void => undefined;
  const closedOrLate = new Promise<void>((resolve) => {
    onClose = resolve;
    page.once('close', onClose);
    timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
  });
  // Watched from before the close, which may open it at once. Its
  // dialog, if it asks, is said by the tracker, along with what accept
  // and dismiss do with it.
  const asking = tab.dialogs?.untilDialog(closedOrLate.then(() => false)) ?? closedOrLate.then(() => false);
  // With beforeunload run, Playwright doesn't wait for the close.
  await page.close({ runBeforeUnload: true }).catch(() => undefined);
  const asked = await asking;
  clearTimeout(timer);
  page.off('close', onClose);
  if (!asked && !page.isClosed()) {
    ctx.out(`[sm-dev] ${tabName(tab)} didn't close within ${CLOSE_TIMEOUT_MS / 1000} seconds. Use closetab --force to close it without running its beforeunload handlers.`);
  }
}

// `newtab [page]...`: a tab of the run's own for each page (a URL, a
// script's number, a file or a glob of them), controlled from the start.
// The first becomes the current tab and comes to the front. `newtab all`
// (one per script's page) leaves the current tab be.
// False (said why) for a mistake, so a list of commands stops there.
async function openNewTab(ctx: ConsoleContext, rest: string[], given: Record<string, string | true>, cwd: string): Promise<boolean | void> {
  const flags = savedFlags(ctx, given);
  if (!flags) return false;
  // `--noscript`: a tab the scripts stay out of. `--script` is what a
  // new tab gets anyway.
  const noWait = given['--nowait'] === true;
  const mode = scriptsMode(ctx, 'newtab', given);
  if (mode === null) return false;
  const noScript = mode === true;
  if (!ctx.newTab) {
    ctx.out('[sm-dev] This run cannot open tabs');
    return;
  }
  if (rest.includes('all')) {
    if (rest.length > 1 || flags.fromSaved || flags.url !== undefined || flags.offline) {
      ctx.out('[sm-dev] ERROR: The newtab command takes all by itself, to open each script\'s page');
      return false;
    }
    return openScriptPages(ctx, noScript, noWait);
  }
  const tabRef = rest.find((w) => TAB_REF.test(w));
  if (tabRef) {
    ctx.out(`[sm-dev] ERROR: The newtab command opens a tab of its own, so it takes URLs, files or script numbers, not ${tabRef}`);
    return false;
  }
  const named: PageWord[] = [];
  for (const word of rest.flatMap((w) => expandPathArg(w, cwd))) {
    const url = pageFor(ctx, word, cwd);
    if (!url) return false;
    named.push({ word, url });
  }
  const pages = await pagesToOpen(named, flags, cwd);
  const open = async (page?: PageToOpen): Promise<ControlledTab | null> => {
    try {
      return await ctx.newTab!(page?.url, { noScript, saved: page?.saved });
    } catch (err) {
      ctx.out(`[sm-dev] The new tab could not be opened: ${(err as Error).message}`);
      return null;
    }
  };
  // All loading at once, numbered in call order as `newtab all`'s are.
  const opened = (await Promise.all((pages.length > 0 ? pages : [undefined]).map(open))).filter((t) => t !== null);
  const [tab] = opened;
  if (!tab) return;
  ctx.tab = tab;
  await focusTab(tab.page).catch(() => undefined);
  if (!noWait) await settleTabs(ctx.host, opened, ctx.out);
  ctx.out(`[sm-dev] The page commands now act on ${tabName(tab)} (${tab.page.url()})`);
}

// `newtab all`: one tab per distinct script page; the scripts with
// none, or whose tab failed, are listed at the end, after the tabs'
// own output.
async function openScriptPages(ctx: ConsoleContext, noScript: boolean, noWait: boolean): Promise<void> {
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
  return ctx.scripts.filter((script) => activeOn(ctx, tab, script.id));
}


// ---------- Menu commands ----------

// A tab's registered menu commands under the script that registered
// each, in load order. The M numbers `menu` prints count through this,
// so firing by number reads the same order.
function menuGroups(ctx: ConsoleContext, tab: ControlledTab): { script: PreparedScript; label: string; commands: MenuCommandRecord[] }[] {
  const all = fromTab(ctx, tab, ctx.host.reports.menuCommands);
  return ctx.scripts
    .map((script) => ({
      script,
      label: scriptRow(ctx, script),
      commands: all.filter((c) => c.scriptId === script.id),
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
    : `[sm-dev] No menu commands are registered on ${tabName(tab)}. ${listed(others.map(tabName))} ${others.length === 1 ? 'has' : 'have'} some; `
      + `use menu all or menu ${tabName(others[0])} to list them.`;
}

// A script registers its commands as it starts, and commands are only
// read once one has started. So for piped input, a miss while nothing
// is registered yet may just be early, and is worth waiting out. A
// miss while others are registered is a wrong name, and is reported at
// once, as is any miss typed at a terminal.
const MENU_WAIT_MS = 5000;

// False when nothing was fired.
async function fireMenu(ctx: ConsoleContext, tab: ControlledTab, argument: string): Promise<boolean> {
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
        return false;
      }
      ctx.out(`[sm-dev] Fired "${entry.name}"`);
      // A MAIN-world handler runs in a later task than the push, so the
      // command ends once the page has run it, with what it printed.
      if (!tab.dialogs?.current) await fire(tab, tab.link.drain().then(() => true));
      return true;
    }
    // Registered on another tab is an answer too, not worth waiting past.
    if (ctx.interactive || commands.length > 0 || Date.now() >= deadline || elsewhereFor(ctx, tab, argument).length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const elsewhere = numbered ? [] : elsewhereFor(ctx, tab, argument);
  if (/^\d+$/.test(argument) && elsewhere.length === 0) ctx.out(`[sm-dev] ERROR: Menu commands are named M1, M2 and so on. Did you mean M${argument}?`);
  else if (elsewhere.length > 0) {
    ctx.out(`[sm-dev] "${argument}" is registered on ${listed(elsewhere.map(tabName))}, not ${tabName(tab)}. `
      + `Use menu ${tabName(elsewhere[0])}.${argument} to fire it ${elsewhere.length === 1 ? 'there' : 'on one of them'}.`);
  }
  else if (all().length === 0) ctx.out(noMenusMessage(ctx, tab));
  else if (numbered) ctx.out(`[sm-dev] There is no menu command M${numbered[1]}${onTab(ctx, tab)}. Use menu to list them.`);
  else ctx.out(`[sm-dev] No menu command named "${argument}" is registered${onTab(ctx, tab)}. Use menu to list them.`);
  return false;
}

// The other tabs with a menu command of that label.
function elsewhereFor(ctx: ConsoleContext, tab: ControlledTab, label: string): ControlledTab[] {
  return ctx.tabs().filter((t) => t !== tab && fromTab(ctx, t, ctx.host.reports.menuCommands).some((c) => c.name === label));
}

// Counts as done once a dialog the command opens is up, so `accept`
// can be typed.
function fire(tab: ControlledTab, fired: Promise<boolean>): Promise<boolean> {
  return tab.dialogs ? tab.dialogs.untilDialog(fired) : fired;
}

// ---------- status and values ----------

// Each script's state on a tab: an open dialog there, then per script
// where it is active, its counts, and its last error. With no `tab`,
// only what doesn't depend on one: stored values and errors.
// The lines under a script are indented to start under its name.
async function statusLines(ctx: ConsoleContext, tab: ControlledTab | undefined): Promise<string[]> {
  const { scripts } = ctx;
  const { reports } = ctx.host;
  const lines: string[] = [];
  lines.push(`Scripts${activityHeading(tab)}:`);
  if (scripts.length === 0) lines.push(`  ${NO_SCRIPTS}`);
  for (const script of scripts) {
    const id = script.id;
    lines.push(scriptRow(ctx, script));
    if (!tab) {
      // Errors are the script's, from tabs since closed, so still told.
      const values = id ? Object.keys(await ctx.host.valuesOf(id)).length : 0;
      const errors = reports.errors.filter((r) => r.scriptId === id);
      const counts = [count(values, 'stored value'), count(errors.length, 'error')].filter((c) => !c.startsWith('0 '));
      if (counts.length > 0) lines.push(`${DETAIL}${counts.join(', ')}`);
      const last = errors.at(-1);
      if (last) lines.push(`${DETAIL}Last error: ${last.message}`);
      continue;
    }
    lines.push(activityLine(ctx, tab, id));
    const errors = fromTab(ctx, tab, reports.errors).filter((r) => r.scriptId === id);
    const menus = fromTab(ctx, tab, reports.menuCommands).filter((r) => r.scriptId === id).length;
    // Stored values are the script's, shared by every tab.
    const values = id ? Object.keys(await ctx.host.valuesOf(id)).length : 0;
    // Only the counts that aren't zero, and no line when none is.
    const counts = [count(menus, 'menu command'), count(values, 'stored value'), count(errors.length, 'error')]
      .filter((c) => !c.startsWith('0 '));
    if (counts.length > 0) lines.push(`${DETAIL}${counts.join(', ')}`);
    const last = errors.at(-1);
    if (last) lines.push(`${DETAIL}Last error: ${last.message}`);
  }
  return lines;
}

// Under a `scriptRow`, lined up with the script's name (`* 1: `) when
// its number is one digit.
const DETAIL = '     ';

// A script list's heading names the tab its `activityLine`s are about.
// None with no tab.
function activityHeading(tab: ControlledTab | undefined): string {
  return tab ? ` (with status on active tab ${tabName(tab)})` : '';
}

// Whether a script is active on the tab the heading names, and on
// which others: `Not active (Active on T1,T2.)`.
function activityLine(ctx: ConsoleContext, tab: ControlledTab, id: string | undefined): string {
  const active = activeOn(ctx, tab, id);
  const here = active ? 'Active' : 'Not active';
  const elsewhere = ctx.tabs().filter((t) => t !== tab && activeOn(ctx, t, id)).map(tabName);
  if (elsewhere.length === 0) return `${DETAIL}${here}`;
  return `${DETAIL}${here} (${active ? 'Also active' : 'Active'} on ${elsewhere.join(',')}.)`;
}

async function valueLines(ctx: ConsoleContext, scripts: PreparedScript[]): Promise<string[]> {
  const lines: string[] = [];
  for (const script of scripts) {
    lines.push(scriptRow(ctx, script));
    const id = script.id;
    lines.push(...valueEntries(id ? await ctx.host.valuesOf(id) : {}));
  }
  return lines;
}

// One script's values, a line each, under its row.
function valueEntries(values: Record<string, unknown>): string[] {
  const keys = Object.keys(values);
  if (keys.length === 0) return ['    Nothing stored'];
  return keys.map((key) => `    ${key} = ${JSON.stringify(values[key])}`);
}

// `E1`: a SourceMonkey-managed script (see `OtherScript`).
const OTHER_LABEL = /^E\d+$/i;

// The SourceMonkey-managed script `label` names, or null having said
// why. Lists the current tab's first if it isn't known yet, so it can
// be named before anything listed it.
async function pickOther(ctx: ConsoleContext, label: string, tab: ControlledTab | undefined): Promise<OtherScript | null> {
  const name = label.toUpperCase();
  if (!ctx.others) {
    ctx.out(`[sm-dev] ERROR: ${name} names a SourceMonkey-managed script, which only a run lists`);
    return null;
  }
  if (!ctx.others.byLabel(name) && tab) {
    try {
      await ctx.others.onTab(tab);
    } catch (err) {
      ctx.out(`[sm-dev] SourceMonkey-managed scripts on ${tabName(tab)} could not be listed: ${firstLine(err)}`);
      return null;
    }
  }
  const found = ctx.others.byLabel(name);
  if (!found) ctx.out(`[sm-dev] There is no script ${name}. Use scripts to list them.`);
  return found ?? null;
}

// How `scripts` and `status` show an extension script's badge status.
// In the run's tabs, which the run claims, NOT_LOADED is the claim
// keeping it out.
const OTHER_STATUS: Record<string, string> = {
  OK: 'Running',
  ERROR: 'Threw an error',
  REJECTED: 'Refused by Chrome',
  MISSING: 'Not started',
  UNEXPECTED: 'Running, though it doesn\'t match',
  RELOAD: 'Changed since it started',
  NOT_LOADED: 'Kept out of the run\'s tabs',
};

// `E1: Name (Collection)`, without the parentheses for a script whose
// collection isn't known (one deleted since the page loaded).
function otherLabel(o: OtherScript): string {
  return `${o.label}: ${o.name}${o.collection ? ` (${o.collection})` : ''}`;
}

// SourceMonkey-managed scripts on `tab`, for `scripts` and `status`.
// None when there are none.
async function otherLines(ctx: ConsoleContext, tab: ControlledTab | undefined): Promise<string[]> {
  if (!ctx.others || !tab) return [];
  let others: OtherScript[];
  try {
    others = await ctx.others.onTab(tab);
  } catch (err) {
    return [`[sm-dev] SourceMonkey-managed scripts on ${tabName(tab)} could not be listed: ${firstLine(err)}`];
  }
  if (others.length === 0) return [];
  return [
    `SourceMonkey-managed scripts on ${tabName(tab)}:`,
    // By label: each listing gets the scripts afresh.
    ...others.map((o) => `${o.label === ctx.currentOther?.label ? '* ' : '  '}${otherLabel(o)}: ${OTHER_STATUS[o.status] ?? o.status}`),
  ];
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
 * Keeps Playwright from dismissing dialogs in `context`'s pages.
 *
 * - Playwright dismisses a dialog nobody listens for, on the page or its
 *   context, in every tab it's attached to: on a connected browser, the
 *   person's own tabs too.
 * - And when the dialog is gone before its dismiss lands, the error is
 *   unhandled, and ends the process.
 * - A listener that does nothing leaves each dialog to whoever does
 *   answer it: the person, or the run's DialogTracker in its own tabs.
 *   Also for a Playwright client that isn't the run's own.
 */
export function leaveDialogsOpen(context: BrowserContext): void {
  context.on('dialog', () => undefined);
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
      this.out(`[sm-dev] ${what}. Dismissed it, since nothing can answer it in a headless run that takes no commands.`);
      void dialog.dismiss().catch(() => undefined);
      return;
    }
    this.current = dialog;
    this.currentOrdinal = ordinal;
    const answer = dialog.type() === 'beforeunload' ? 'use accept to leave the page or dismiss to stay'
      : `use ${dialog.type() === 'prompt' ? 'accept [text]' : 'accept'} or dismiss`;
    const how = !this.visible ? `${answer[0].toUpperCase()}${answer.slice(1)}`
      : this.commandsListening ? `Answer it in the browser, or ${answer}`
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

function completeFrom(names: readonly string[], line: string): [string[], string] {
  if (/\s/.test(line.trimStart())) return [[], line];
  const word = line.trimStart();
  return [names.filter((name) => name.startsWith(word)), word];
}

// Set by the global --json: other log messages print to stderr, and
// `--json=single` or `=multi` picks how results are laid out.
let jsonLogs = false;
let jsonLayout: JsonLayout | undefined;

/**
 * For the global --json: sends other log messages to stderr from now
 * on, and lays results out on one line or multi-line (`layout`),
 * rather than by whether stdout is a terminal.
 */
export function setJsonOutput(layout?: JsonLayout): void {
  jsonLogs = true;
  jsonLayout = layout;
}

// The prompt readline is drawing while a person types at a terminal,
// or null when there is none (a pipe, or before commands are armed).
let activePrompt: readline.Interface | null = null;

const PROMPT = '> ';
// While a {{ block is open.
const BLOCK_PROMPT = '... ';

/**
 * Print one line of run output. With a prompt showing, the prompt and
 * whatever is half-typed are erased, the line printed above them, and
 * both redrawn with the cursor where it was, so streaming output never
 * lands in the middle of a command being edited.
 */
export function writeOutputLine(line: string): void {
  const marked = markedLine(line, jsonLayout ?? (process.stdout.isTTY ? 'multi' : 'single'));
  // In JSON mode, other log messages go to stderr, keeping stdout for
  // the results (see docs/sm-dev-json.md).
  const out = marked?.stderr || (!marked && jsonLogs && line.startsWith('[sm-dev] ')) ? process.stderr : process.stdout;
  if (marked) line = marked.text;
  const rl = activePrompt;
  if (!rl) {
    out.write(line + '\n');
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
  out.write(line + '\n');
  process.stdout.write('\n'.repeat(recorded));
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
  hooks?: { start?: () => void; end?: () => void; cwd?: string; words?: string[]; answer?: (line: string) => void; interactive?: boolean; json?: boolean },
) => Promise<number>;

// `answer`: where the command's own output goes instead of `ctx.out`
// (see commandOutput). Resolves to the command's exit code.
export function commandRunner(ctx: ConsoleContext): CommandRunner {
  let queue: Promise<unknown> = Promise.resolve();
  return (line, hooks) => {
    // The exit code: 2 when it said it was invalid, wherever in it
    // that was said; else what the command returned (a number, or false
    // for 1); else 0. A throw is 2 for an invalid command (a file that
    // isn't there), 1 otherwise. Commands run one at a time, so the
    // mistake watch holds only for this one.
    let code = 0;
    const run = async (): Promise<void> => {
      let mistaken = false;
      const out = ctx.out;
      // In JSON mode, the command's other lines (a note beside its
      // result, or its failure in place of one) go to stderr as text.
      ctx.json = hasJsonForm(line) ? hooks?.json === true : undefined;
      ctx.out = (l) => {
        if (l.startsWith(MISTAKE_PREFIX)) mistaken = true;
        if (!ctx.json) out(l);
        else if (isJsonLine(l)) out(ctx.jsonLayout ? withLayout(l, ctx.jsonLayout) : l);
        else out(STDERR_LINE + l);
      };
      try {
        // Typed at a person's prompt, `menu` needn't wait for a command
        // still to register: the person can see what there is.
        ctx.interactive = hooks?.interactive === true;
        const result = await runConsoleCommand(line, ctx, { cwd: hooks?.cwd, words: hooks?.words });
        code = result === false ? 1 : typeof result === 'number' ? result : 0;
        // An invalid command is 2, even when it also said it failed.
        if (mistaken) code = 2;
      } catch (err) {
        ctx.out(`${err instanceof UsageError ? MISTAKE_PREFIX : '[sm-dev] '}${(err as Error).message}`);
        code = err instanceof UsageError ? 2 : 1;
      } finally {
        ctx.json = undefined;
        ctx.jsonLayout = undefined;
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

/** What the prompt needs from whoever runs its commands. */
export interface PromptIO {
  /** Prints a line, drawn around the prompt (see writeOutputLine). */
  out: (line: string) => void;
  /**
   * Leaves: Ctrl-D, or Ctrl-C on an empty line. `now`: without waiting
   * for the command running, as a second Ctrl-C asks.
   */
  exit: (now?: boolean) => void;
}

/**
 * The `> ` prompt of `sm-dev --interactive`, reading the terminal: line
 * editing and history (readline's own keys: arrows, Ctrl-A/E, Ctrl-U
 * and so on), Tab completion of command names, and `... ` inside an
 * `{{` block (see command-lines.ts), edited as one buffer at a terminal
 * (see prompt-editor.ts). A block is one history entry, and history is
 * kept across sessions (see prompt-history.ts). Ctrl-C clears the
 * typed command, and on an empty line it or Ctrl-D leaves. Each command goes to `runLine` once typed, in order.
 * Returns a function that closes the prompt.
 */
export function readPromptCommands(io: PromptIO, runLine: (line: string, hooks?: { start?: () => void }) => Promise<unknown>): () => void {
  io.out('[sm-dev] Ready for commands. Use help to list them.');
  // A dumb terminal can't move the cursor, so writeOutputLine couldn't
  // redraw around a prompt there.
  const terminal = Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
  const blocks = new CommandAssembler();
  // Set once the prompt is closed on purpose, rather than by Ctrl-D.
  let closing = false;
  // A message in the commands' turn, after the ones before it. The
  // empty line runs nothing.
  const say = (message: string): void => {
    void runLine('', { start: () => io.out(`[sm-dev] ERROR: ${message}`) });
  };
  const names = [...COMMAND_NAMES].sort();
  // Kept across sessions (see prompt-history.ts). Newest first.
  const file = terminal ? historyFile() : null;
  const history = file ? loadHistory(file) : [];
  const lines = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal,
    prompt: PROMPT,
    history,
    // A lone Esc clears the command (see prompt-editor.ts). readline
    // waits this long for more of an escape sequence before taking it
    // as one: 500ms by default, which made Esc feel slow.
    escapeCodeTimeout: 100,
    // One over, so readline never drops an entry for the typed line
    // it adds, which the 'history' handler below takes back out.
    historySize: HISTORY_SIZE + 1,
    // Tab completes a command name, except in a {{ block, where the
    // text is the block's (JavaScript or JSON). Only at a terminal,
    // where the editor holds a block as one buffer.
    completer: (line: string) => (line.includes('\n') ? [[], line] : completeFrom(names, line)),
  });
  // At a terminal a {{ block is typed and edited as one buffer, sent
  // once its }} line ends it (see prompt-editor.ts). Without one, each
  // line is sent as typed, and `blocks` collects them.
  // A command of several lines (a {{ block, or lines joined with
  // Alt-Enter) cleared by Ctrl-C or Esc is kept, unfinished, to take
  // up again. Not one brought back from the history unchanged.
  const editor = terminal ? editMultiLine(lines, BLOCK_PROMPT, endsOutsideBlock, (text) => {
    if (text.includes('\n') && !history.includes(text)) remember(text);
  }) : null;
  // readline adds each typed line to the history itself, but a {{
  // block should be one entry of all its lines, so its additions are
  // taken back out here and `remember` adds whole entries instead.
  // This leans on how readline (checked on Node 22) adds a line:
  // - It skips a blank line, and one equal to the newest entry, so the
  //   newest entry changing (from `newest`, ours) means it added one.
  // - It reads the line it hands to 'line' before this event, so
  //   removing it here doesn't change what is run.
  let newest: string | undefined = history[0];
  lines.on('history', (entries: string[]) => {
    if (entries.length > 0 && entries[0] !== newest) entries.shift();
  });
  let saveFailed = false;
  const remember = (entry: string): void => {
    if (!entry.trim() || entry === newest) return;
    history.unshift(entry);
    if (history.length > HISTORY_SIZE) history.pop();
    newest = entry;
    if (!file || saveFailed) return;
    try {
      appendHistory(file, entry);
    } catch (err) {
      saveFailed = true;
      io.out(`[sm-dev] Command history isn't being saved: Could not write ${file}: ${writeProblem(err) ?? errorSentence(err)}`);
    }
  };
  // The lines of the {{ block being typed, for its history entry.
  let blockLines: string[] = [];
  // Typed commands not yet done. The `> ` prompt waits for them, as a
  // shell's does, so a command's output lands before the next prompt
  // rather than under it. Typing ahead still works, on a bare line.
  let running = 0;
  // Set by a Ctrl-C while a command runs, so a second one leaves.
  let exitArmed = false;
  // `blocks` is only open without a terminal, where lines are sent one
  // by one.
  const promptText = (): string => (blocks.open ? BLOCK_PROMPT : running > 0 ? '' : PROMPT);
  const showPrompt = (preserveCursor: boolean): void => {
    lines.setPrompt(promptText());
    lines.prompt(preserveCursor);
  };
  const take = (line: string): void => {
    const inBlock = blocks.open;
    const got = blocks.push(line);
    if (inBlock || blocks.open) blockLines.push(line);
    if (!blocks.open) {
      remember(blockLines.length > 0 ? blockLines.join('\n') : line);
      blockLines = [];
    }
    if (got && 'error' in got) say(got.error);
    else if (got) {
      running++;
      void runLine(got.command.text).finally(() => {
        running--;
        if (running === 0) exitArmed = false;
        if (running === 0 && activePrompt === lines) showPrompt(true);
      });
    }
  };
  lines.on('line', (input) => {
    // At a terminal, a block arrives as one line holding its lines.
    for (const line of input.split('\n')) take(line);
    showPrompt(false);
  });
  // Erases the prompt and stops drawing output around it. Before the
  // interface closes, or after readline closes it itself on Ctrl-D, so
  // later output neither redraws a dead prompt nor resumes stdin.
  const dropPrompt = (): void => {
    if (activePrompt !== lines) return;
    activePrompt = null;
    if (!terminal) return;
    readline.moveCursor(process.stdout, 0, -lines.getCursorPos().rows);
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
  };
  // readline puts the terminal in raw mode, so Ctrl-C arrives here
  // rather than as the process's SIGINT. As in a shell, it first
  // clears a half-typed line, and only leaves on an empty one.
  // Only at a terminal, so with the editor, where a {{ block is the
  // typed buffer rather than lines `blocks` holds.
  lines.on('SIGINT', () => {
    // With no prompt showing, Ctrl-C looks like it would cancel the
    // command. It can't, so the first one only says so.
    if (!lines.line && running > 0 && !exitArmed) {
      exitArmed = true;
      io.out('[sm-dev] A command is still running, and cannot be cancelled. Press Ctrl-C again to exit.');
      return;
    }
    if (!lines.line) {
      // With a command still running, at once rather than after it.
      io.exit(running > 0);
      return;
    }
    editor?.clear();
  });
  // readline handles Ctrl-Z itself. On `fg` it pauses its input and
  // emits this event, but never resumes the input. Without this the
  // prompt stays frozen until some output line happens to redraw it.
  lines.on('SIGCONT', () => lines.resume());
  lines.on('close', () => {
    dropPrompt();
    if (!closing) io.exit();
  });
  if (terminal) activePrompt = lines;
  lines.prompt();
  return () => {
    closing = true;
    dropPrompt();
    lines.close();
    process.stdin.pause();
  };
}
