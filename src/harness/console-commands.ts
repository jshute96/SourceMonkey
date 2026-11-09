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
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { Frame, Page } from '@playwright/test';

import { CommandAssembler, endsOutsideBlock, listed } from './command-lines.js';
import { isJsonLine, jsonLayoutMistake, jsonResult, JSON_COMMANDS, markedLine, STDERR_LINE, withLayout, type JsonLayout } from './json-output.js';
import type * as J from './json-output.js';
import { managerState, managersText, otherManagersWarning, stateLabel, type InstalledManager } from './browser-extensions.js';
import { DEFAULT_MANAGER, MANAGERS, type ManagerName } from './managers.js';
import { firstLine } from './extension-link.js';
import type { ErrorReport, HarnessHost, MenuCommandRecord, WarningRecord } from './host.js';
import type { PageAttachment } from './page-watch.js';
import {
  collectionList, count, managerVerb, noSuchScript, noSuchVerb, scriptList, type ManagerControl, type ManagerRun, type RunView,
} from './manager-commands.js';
import { helpRequest, helpSubcommand, parseCommandArgs, splitWords, unquoteWhole, type ParsedArgs } from './command-args.js';
import { commandLimitMs, givenTimeoutMs, pageBusy, stopPageScript } from './command-limit.js';
import { ALIASES, COMMAND_NAMES, RUN_COMMAND_NAMES, SAME_COMMANDS, TIMEOUT_FLAG, commandHelp, commandSuggestion, commandSyntax, unsupportedCommand } from './command-list.js';
import { errorSentence, readJsonFile, writeProblem } from './input-file.js';
import { CDP_FRAME_ARG, PAGE_COMMANDS, runPageCommand, type EvalIn } from './page-commands.js';
import { editMultiLine } from './prompt-editor.js';
import { appendHistory, HISTORY_SIZE, historyFile, loadHistory } from './prompt-history.js';
import { frameNodes, parseFrameRef } from './frames.js';
import { defaultPageUrl, explainMatch, NO_DEFAULT_PAGE, preparedNoframes, preparedScriptMatches, preparedScriptName, preparedScriptPath, shownPath, withDefaultScheme, type PreparedScript } from './prepare.js';
import { representativeMatch } from '../match-targets.js';
import { RUN_SCRIPT_LABEL, isContextMenuRunAt } from '../userscript-header.js';
import { currentTab, defaultOf, dialogWaitingError, dialogWaitingMessage, NO_TABS, pickTab, runTrackers, showCommand, tabName } from './tab-refs.js';
import {
  buttonList, dialogBlock, dialogJson, dialogName, dialogSummary, firstToAnswer, namesDialog, parseDialogId, setRunningCommand, setTrackersListening,
  settingUpTracker, type DialogButton, type DialogTracker, type WaitingDialog,
} from './dialogs.js';
import { runLogLabel } from './run-log.js';
import {
  DEFAULT_LOG_SOURCES, isoTime, linesLost, logsLines, logsUpTo, inSources, noLogLines, nowMicros, parseLogSources, parsePosition, parseTail, streamText, textMatcher, type LogRecord, type RunLog,
} from './run-logs.js';
import { err as errorLine, message, MISTAKE_PREFIX, paintAs, paintOutput, plainLine, quoted, streamHasColor, ui } from './output-style.js';
// The roles for marked-up output, as S.id(...): their names are common locals here.
import * as S from './output-style.js';
import { budgeted, deadlineIn, inBudget, inLimit, LOAD_TIMEOUT_MS, notLoadedMessage, notSettledMessage, SETTLE_TIMEOUT_MS, settleTab, shownMs, loadPage, PageNotLoaded, seconds, timeoutFlagMs, waitFor, within } from './wait.js';
import { userscriptLabel, type SavedPageHeader } from './save-html.js';
import { visibleCommands } from '../menu-captions.js';
import {
  comparableUrl, openingSavedLine, pagesToOpen, routeSavedPage, savedPageServe,
  type PageToOpen, type PageWord, type SavedPageFile, type SavedPageStart,
} from './saved-pages.js';
import {
  UsageError, expandPathArg, expandPathArgs, isScriptWord, matchJson, matchLines, prepareSource, scriptSources, validateAll, validateSources,
  type MatchTarget, type ScriptRoots, type ScriptSource, type ValidateSource,
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
  /** The dialogs waiting on the tab, for the `dialog` command. */
  dialogs?: DialogTracker;
  /** The number of the tab that opened this one. */
  openedBy?: number;
  /**
   * Its CDP target id, for a debugging session alongside the run to
   * name the same tab. Unset if it closed before it could be read.
   */
  targetId?: string | null;
  /**
   * Its last load failed or didn't finish (said already), so `start`
   * doesn't wait on its scripts again.
   */
  stalled?: boolean;
}

/** ` [targetId=...]`, the tab's CDP id, for the end of a line. */
export function targetIdSuffix(targetId: string | null | undefined): string {
  return targetId ? ` [targetId=${targetId}]` : '';
}

/**
 * A SourceMonkey-managed script, which the run didn't push: named by
 * its script number in SourceMonkey (`E12`), the same in every run.
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
  newTab?: (url?: string, options?: { noScript?: boolean; saved?: SavedPageStart; timeoutMs?: number; noWait?: boolean }) => Promise<ControlledTab>;
  /** Switch a tab to running no scripts, or back, for `open --noscript` / `--script`. */
  setTabScripts?: (tab: ControlledTab, noScript: boolean) => Promise<void>;
  /** Load another script from disk, for `load`. */
  loadScript?: (file: string, timeoutMs?: number) => Promise<void>;
  /** Re-read scripts from disk (all, when none are named), for `update`. */
  updateScripts?: (scripts?: PreparedScript[], timeoutMs?: number) => Promise<void>;
  /** The scripts this run pushed, in load order. */
  scripts: PreparedScript[];
  /** SourceMonkey-managed scripts (see `OtherScript`), or another manager's. */
  others?: {
    /** How their list is headed, before ` on T1`: `SourceMonkey-managed scripts`. */
    kind?: string;
    /** Those on the tab's page, as its toolbar badge lists them. */
    onTab(tab: ControlledTab): Promise<OtherScript[]>;
    /** One already listed, by its label (`E2`). */
    byLabel(label: string): OtherScript | undefined;
    /** One installed anywhere, picked from `script list`'s rows, by the extension's id. */
    installed(id: string, label: string, name: string, collection: string): OtherScript;
    /** `set` on one changes the person's own data, so needs `--force`. */
    guarded: boolean;
  };
  /**
   * Under another manager, which reports nothing: whether a script is
   * active on a tab is predicted from its rules.
   */
  predicted?: boolean;
  /**
   * Which of the run's scripts the manager has off, all of them while
   * its switch is off. Read again (`refresh`) before each command that
   * shows what a tab runs or waits on its scripts.
   */
  scriptsOff?: {
    refresh(): Promise<void>;
    has(script: PreparedScript): boolean;
    /** The manager's own switch is off, so all of them are. */
    managerOff?(): boolean;
  };
  /**
   * Each tab's iframes and the scripts in each, read again
   * (`loadFrames`) before each command that shows them. Without it,
   * scripts show for the top frame only.
   */
  frames?: Map<ControlledTab, FrameView[]>;
  /** One of `others` picked for `get` and `set` (`scripts E1`), in place of `current`. */
  currentOther?: OtherScript;
  /** The dialog `dialog select` picked, by id, for `dialog` commands to apply to by default. */
  selectedDialog?: string;
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
  /** Where a temp browser saves downloads, for `status`. */
  downloadsDir?: string;
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
  /** The userscript manager the run works with (`--manager`); SourceMonkey when unset. */
  managerName?: ManagerName;
  /** The managers in the browser now, for `status`; null when unknown. */
  managers?: () => Promise<InstalledManager[] | null>;
  /** The run's log lines, for `logs` and `wait log` (see run-logs.ts). */
  logs?: RunLog;
  /**
   * The log's position when the previous command (that wasn't only a
   * look, like `status`) began, for `wait log`: a line the command set
   * off, logged while it waited for the page to settle, still counts.
   * Unset before the first.
   */
  previousStart?: number;
  /** SourceMonkey's collections and installed scripts, for `collection list` and `script list`. */
  manager?: ManagerControl;
  /** The extension's id for one of `scripts`, once pushed, for `script list`. */
  extensionIdOf?: (script: PreparedScript) => string | undefined;
  /** Where `validate` and `match` find local copies of `@require`s: the run's own. */
  roots?: ScriptRoots;
}

// One wording for having none, whether as a reply or in a list.
const NO_SCRIPTS = 'No scripts are loaded';


// The commands that act on the current tab, which there may not be.
const NEEDS_A_TAB = new Set(['menu', 'open', 'reload', 'focus', 'closetab', ...PAGE_COMMANDS]);

// `script` and `tab` pick one, as `scripts` and `tabs` do given one,
// so each is run as its plural.
const RUN_ALIASES: Record<string, string> = { ...ALIASES, ...SAME_COMMANDS };

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

export { withoutQuery } from './dialogs.js';

// What is still waiting for an answer as a command ends: the dialogs
// waiting on the run's tabs. Each is a stuck state (a request, or the
// whole page, can't go on), and the event telling of it may have come
// between commands, where only the run's log saw it. So each command
// repeats them, after its own output, until answered.
//
// Only what was already waiting when the command began: one that opens
// during the command has just been shown in its output. Nor a dialog
// the command's output already named (a command refused for it).
export function waitingReminders(ctx: ConsoleContext, before: WaitingState, said: readonly string[]): string[] {
  const lines: string[] = [];
  for (const d of runDialogs(ctx)) {
    if (!before.dialogs.has(d.id)) continue;
    // Not when the output already said how to answer it (a refusal), or
    // showed it (`dialog show`).
    if (said.map(plainLine).some((l) => (namesDialog(l, d.id) && l.includes('dialog show')) || l.includes(`${d.id}  ${d.title}`))) continue;
    lines.push(S.SM_DEV_PREFIX + ui`*DIALOG* still waiting: ${dialogSummary(d)}. Use ${S.cmd(showCommand(ctx, d))} to see how to answer it.`);
  }
  return lines;
}

// The `dialog` commands that answer or fill one, rather than look.
const ANSWERS_DIALOG = /^\s*dialog\s+(set|accept|cancel|click)\b/;

// What `waitingReminders` compares against: the dialogs waiting as a
// command began, by id.
export interface WaitingState {
  dialogs: Set<string>;
}

export function waitingState(ctx: ConsoleContext): WaitingState {
  return { dialogs: new Set(runDialogs(ctx).map((d) => d.id)) };
}

// ---------- The `dialog` command ----------

// The dialogs waiting in the run, oldest first.
function runDialogs(ctx: ConsoleContext): WaitingDialog[] {
  return runTrackers(ctx).flatMap((t) => t.waiting).sort((a, b) => a.openedAt - b.openedAt);
}

// The dialogs waiting on the tab `--tab` names: a listed tab, or one
// still being set up. Null (said) for no such tab.
function tabDialogs(ctx: ConsoleContext, name: string): { tab: number; waiting: WaitingDialog[] } | null {
  const early = settingUpTracker(name);
  if (early) return { tab: early.tab, waiting: early.waiting };
  const tab = pickTab(ctx, name);
  if (!tab) return null;
  return { tab: tab.n, waiting: tab.dialogs?.waiting ?? [] };
}

// Where the other dialogs are, after saying none is waiting where asked.
function elsewhereHint(ctx: ConsoleContext, except?: number): string {
  const others = runDialogs(ctx).filter((d) => d.tab !== except);
  if (others.length === 0) return '';
  const tabs = [...new Set(others.map((d) => d.tab))];
  return ` ${tabs.map((n) => `T${n}`).join(', ')} ${tabs.length === 1 ? 'has' : 'have'} ${others.length === 1 ? 'one' : 'some'}: use ${quoted(`dialog show --tab T${tabs[0]}`)}.`;
}

// The dialog a `dialog` command acts on: `--dialog`'s, else `--tab`'s
// tab's selected or oldest one, else the default. Undefined (said) for none, false
// (said) for a mistake.
function targetDialog(ctx: ConsoleContext, parsed: ParsedArgs): WaitingDialog | undefined | false {
  const flag = parsed.flags['--dialog'];
  if (typeof flag === 'string') {
    const id = parseDialogId(flag);
    if (!id) {
      ctx.out(`${MISTAKE_PREFIX}The ${quoted('--dialog')} flag takes a dialog's id, such as ${quoted('T1.2')}`);
      return false;
    }
    const found = runDialogs(ctx).find((d) => d.id === id);
    if (!found) ctx.out(`[sm-dev] No dialog ${id} is waiting${elsewhereHint(ctx) ? `.${elsewhereHint(ctx)}` : ', and no others are'}`);
    return found;
  }
  if (parsed.tab !== undefined) {
    const tracker = tabDialogs(ctx, parsed.tab);
    if (!tracker) return false;
    // The selected one when it's on that tab, else as for the default.
    const found = tracker.waiting.find((d) => d.id === ctx.selectedDialog) ?? firstToAnswer(tracker.waiting);
    if (!found) ctx.out(`[sm-dev] No dialog is waiting on T${tracker.tab}.${elsewhereHint(ctx, tracker.tab)}`);
    return found;
  }
  const found = defaultOf(ctx);
  if (!found) ctx.out('[sm-dev] No dialogs are waiting');
  return found;
}

// `dialog show|select|set|accept|cancel|click`: the dialogs waiting, and
// answering them (docs/sm-dev-dialogs.md).
async function dialogCommand(ctx: ConsoleContext, parsed: ParsedArgs, cwd: string): Promise<false | void> {
  const form = parsed.form;
  if (form === undefined) {
    ctx.out(`${MISTAKE_PREFIX}The ${quoted('dialog')} command takes a subcommand: ${quoted('show')}, ${quoted('select')}, ${quoted('set')}, ${quoted('accept')}, ${quoted('cancel')} or ${quoted('click')}`);
    return false;
  }
  if (form === 'show') return showDialogs(ctx, parsed);
  if (form === 'select') {
    const id = parseDialogId(parsed.words[0] ?? '');
    if (!id) {
      ctx.out(`${MISTAKE_PREFIX}The ${quoted('dialog select')} command takes a dialog's id, such as ${quoted('T1.2')}`);
      return false;
    }
    const found = runDialogs(ctx).find((d) => d.id === id);
    if (!found) {
      ctx.out(`[sm-dev] No dialog ${id} is waiting${elsewhereHint(ctx) ? `.${elsewhereHint(ctx)}` : ', and no others are'}`);
      return;
    }
    ctx.selectedDialog = id;
    ctx.out(S.SM_DEV_PREFIX + ui`${S.cmd('dialog')} commands now apply to ${dialogSummary(found)} by default`);
    return;
  }
  const d = targetDialog(ctx, parsed);
  if (d === false) return false;
  if (!d) return;
  if (form === 'set') {
    const [name, ...values] = parsed.words;
    const field = d.fields.find((f) => f.name.toLowerCase() === name?.toLowerCase());
    if (name === undefined) {
      ctx.out(`${MISTAKE_PREFIX}The ${quoted('dialog set')} command needs a field and a value${d.fields[0] ? `: ${quoted(`dialog set ${d.fields[0].name} ${d.fields[0].placeholder}`)}` : ''}`);
      return false;
    }
    if (!field) {
      ctx.out(`${MISTAKE_PREFIX}${d.fields.length === 0 ? `${d.title} dialog ${d.id} has no fields to set` : `${d.title} dialog ${d.id} has no ${quoted(name ?? '')} field. Its fields are ${d.fields.map((f) => quoted(f.name)).join(', ')}.`}`);
      return false;
    }
    const given = fieldValues(d, field, values, cwd);
    if ('error' in given) {
      ctx.out(`${MISTAKE_PREFIX}${given.error}`);
      return false;
    }
    field.value = given.values;
    ctx.out(`[sm-dev] Set ${field.name} to ${given.values.map((v) => JSON.stringify(v)).join(' ')} on ${d.title} dialog ${d.id}`);
    return;
  }
  let button: DialogButton | 'close' | undefined;
  if (form === 'accept') {
    const values = parsed.words;
    if (values.length > 0) {
      if (d.fields.length !== 1) {
        ctx.out(`${MISTAKE_PREFIX}${d.fields.length === 0 ? `${d.title} dialog ${d.id} has no field to fill` : `${d.title} dialog ${d.id} has more than one field. Use ${quoted('dialog set')} for each.`}`);
        return false;
      }
      const given = fieldValues(d, d.fields[0], values, cwd);
      if ('error' in given) {
        ctx.out(`${MISTAKE_PREFIX}${given.error}`);
        return false;
      }
      d.fields[0].value = given.values;
    }
    button = d.buttons.find((b) => b.role === 'accept');
  } else if (form === 'cancel') {
    button = d.buttons.find((b) => b.role === 'cancel') ?? 'close';
  } else {
    const label = unquoteWhole(parsed.text ?? '').text.trim().toLowerCase();
    button = d.buttons.find((b) => b.label.toLowerCase() === label);
    if (!button) {
      ctx.out(`${MISTAKE_PREFIX}${d.title} dialog ${d.id} has no ${quoted(parsed.text ?? '')} button. Its buttons are ${buttonList(d)}.`);
      return false;
    }
  }
  if (!button) {
    ctx.out(`${MISTAKE_PREFIX}${d.title} dialog ${d.id} has no OK button. Its buttons are ${buttonList(d)}.`);
    return false;
  }
  // Its answer would wait on the page, which a JavaScript dialog holds.
  const holder = d.needsPage ? ctx.tabs().find((t) => t.n === d.tab)?.dialogs?.stopping : undefined;
  if (holder && holder !== d) {
    ctx.out(`${MISTAKE_PREFIX}${dialogName(d)} can't be answered while ${dialogName(holder)} blocks its page. Answer ${holder.id} first. Use ${quoted(showCommand(ctx, holder))} to see how.`);
    return false;
  }
  const values = Object.fromEntries(d.fields.map((f) => [f.name, f.value ?? f.default]));
  let pressed: boolean;
  try {
    pressed = await d.press(button, values);
  } catch (err) {
    ctx.out(`${MISTAKE_PREFIX}${(err as Error).message}`);
    return false;
  }
  if (ctx.selectedDialog === d.id) ctx.selectedDialog = undefined;
  if (!pressed) {
    ctx.out(`[sm-dev] ${d.title} dialog ${d.id} was already closed`);
    return;
  }
  ctx.out(button === 'close' ? `[sm-dev] Closed ${d.title} dialog ${d.id}` : `[sm-dev] Clicked ${button.label} on ${d.title} dialog ${d.id}`);
}

// `values` as `field` takes them: files resolved from `cwd`, the
// command's own directory, and checked. Or what's wrong with them.
function fieldValues(d: WaitingDialog, field: WaitingDialog['fields'][number], values: string[], cwd: string): { values: string[] } | { error: string } {
  if (values.length === 0) return { error: `The ${quoted('dialog set')} command needs a field and a value: ${quoted(`dialog set ${field.name} ${field.placeholder}`)}` };
  if (!field.files) {
    if (values.length > 1 && !field.multiple) return { error: `The ${field.name} field of ${d.title} dialog ${d.id} takes one value. Quote a value that has spaces in it.` };
    return { values };
  }
  let files: string[];
  try {
    files = expandPathArgs(values, cwd).map((f) => path.resolve(cwd, f));
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (files.length > 1 && !field.multiple) return { error: `${d.title} dialog ${d.id} takes one file` };
  const missing = files.find((f) => !existsSync(f));
  if (missing) return { error: `There is no file at ${shownPath(missing, cwd)}` };
  return { values: files };
}

// `dialog show`: the dialogs waiting on a tab, each with its fields,
// buttons and the commands that answer it.
function showDialogs(ctx: ConsoleContext, parsed: ParsedArgs): false | void {
  const all = runDialogs(ctx);
  const def = defaultOf(ctx);
  let shown: WaitingDialog[];
  let tab: number;
  if (typeof parsed.flags['--dialog'] === 'string') {
    const d = targetDialog(ctx, parsed);
    if (d === false) return false;
    if (!d) return;
    shown = [d];
    tab = d.tab;
  } else if (parsed.tab !== undefined) {
    const tracker = tabDialogs(ctx, parsed.tab);
    if (!tracker) return false;
    tab = tracker.tab;
    shown = [...tracker.waiting];
  } else {
    if (!def) {
      if (ctx.json) ctx.out(jsonResult('dialog', { dialogs: [] } satisfies J.DialogShowData));
      else ctx.out('[sm-dev] No dialogs are waiting');
      return;
    }
    tab = def.tab;
    shown = all.filter((d) => d.tab === tab);
  }
  const elsewhere = [...new Set(all.filter((d) => d.tab !== tab).map((d) => d.tab))];
  if (ctx.json) {
    ctx.out(jsonResult('dialog', {
      ...(def ? { default: def.id } : {}),
      dialogs: shown.map((d) => dialogJson(d, d === def)),
      ...(elsewhere.length > 0 ? { otherTabs: elsewhere.map((n) => `T${n}`) } : {}),
    } satisfies J.DialogShowData));
    return;
  }
  if (shown.length === 0) {
    ctx.out(`[sm-dev] No dialog is waiting on T${tab}.${elsewhereHint(ctx, tab)}`);
    return;
  }
  const head = `T${tab} has ${shown.length === 1 ? '1 dialog' : `${shown.length} dialogs`} waiting.`;
  const which = def && (shown.length > 1 || !shown.includes(def))
    ? ` \`dialog\` commands apply to ${def.id} by default. Use \`--dialog\` or \`dialog select\` to choose another.` : '';
  ctx.out(message(head + which));
  const now = Date.now();
  for (const d of shown) {
    ctx.out(ui``);
    for (const line of dialogBlock(d, { isDefault: d === def, now })) ctx.out(line);
  }
  for (const n of elsewhere) {
    const count = all.filter((d) => d.tab === n).length;
    ctx.out(ui``);
    ctx.out(message(`T${n} also has ${count === 1 ? '1 dialog' : `${count} dialogs`} waiting. Use \`dialog show --tab T${n}\` to see ${count === 1 ? 'it' : 'them'}.`));
  }
}

/**
 * The run command, and its subcommand, whose help `--help` asks for
 * (`click --help`, `script save --help`), or null when it isn't asked;
 * an error for words that name no subcommand.
 */
export function runCommandHelp(input: { line: string } | { words: string[] }): { command: string; subcommand?: string } | { error: string } | null {
  const own = ownWords(input);
  if (!own) return null;
  const parsed = parseCommandArgs(own.command, own.rest);
  return 'help' in parsed && parsed.help ? helpRequest(own.command, own.rest) : null;
}

// The error for a word that names no command a run takes.
function notACommand(word: string): string {
  return `${quoted(word)} is not a command.${commandSuggestion(word, RUN_COMMAND_NAMES)} Use ${quoted('help commands')} to list them.`;
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
  // `scripts E4 enable` is the script command; `scripts E4` picks one.
  const isScriptVerb = (name === 'script' || name === 'scripts') && managedVerb(name, rest) !== null;
  return { command: isScriptVerb ? 'script' : RUN_ALIASES[name] ?? name, rest };
}

/**
 * Which of the commands for what's installed a command is (`collection
 * C3 show`, `script list`), in any spelling, with its verb, or null for
 * another command. These need SourceMonkey but no run.
 */
export function managerCommandOf(words: string[]): { command: 'collection' | 'script'; verb: string | undefined } | null {
  const [name = '', ...rest] = words;
  if ((ALIASES[name] ?? name) === 'collection') {
    // Alone, or with flags only, it lists.
    const verb = rest.every((w) => w.startsWith('--')) ? 'list' : managedVerb('collection', { words: rest }) ?? undefined;
    return { command: 'collection', verb };
  }
  const verb = managedVerb(name, { words: rest });
  return verb !== null ? { command: 'script', verb } : null;
}

// The verb of `script list`, `script E4 show`, `collection C3 refresh`
// and the rest, as command-args.ts reads it, or null: for `script`,
// picking a script instead (`script E4`). A line that doesn't parse is
// still the verb's when a word of it is one, so the verb's own message
// says what's wrong (`script enable E4`).
function managedVerb(name: string, rest: { line: string } | { words: string[] }): string | null {
  const command = name === 'script' || name === 'scripts' ? 'script' : name === 'collection' ? 'collection' : null;
  if (command === null) return null;
  const parsed = parseCommandArgs(command, 'line' in rest ? { line: rest.line.split('\n')[0] } : rest);
  if (!('error' in parsed)) return parsed.form ?? null;
  const all = 'line' in rest ? splitWords(rest.line.split('\n')[0]).map((w) => w.text) : rest.words;
  const verbs = commandSyntax(command).forms;
  return all.find((w) => !w.startsWith('--') && Object.hasOwn(verbs, w)) ?? null;
}

// The verbs that only look.
const LOOKING_VERBS = new Set(['list', 'show', 'print', 'save']);

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
const INSPECTING = new Set([
  'help', 'status', 'values', 'get', 'snapshot', 'screenshot', 'savehtml', 'probe', 'logs', 'match', 'validate', 'frames',
]);

/**
 * Whether a command line only inspects, so its output goes back to the
 * client that sent it alone, rather than into the run's stream too. `tabs`, `scripts` and `menu` inspect when they list, and
 * change things when they pick or fire.
 */
export function onlyInspects(line: string): boolean {
  const [typed = '', ...words] = line.trim().split(/\s+/);
  // `tabs --json` and `tabs --frames` still list.
  const rest = words.filter((word) => !/^--(no)?json(=|$)/.test(word) && word !== '--frames');
  // A script or collection named in quotes is one word.
  const managing = managerCommandOf(commandWords(line));
  if (managing) return managing.verb !== undefined && LOOKING_VERBS.has(managing.verb);
  const command = RUN_ALIASES[typed] ?? typed;
  if (INSPECTING.has(command)) return true;
  if (command === 'tabs' || command === 'scripts') return rest.length === 0;
  if (command === 'dialog') return rest[0] === 'show';
  if (command === 'menu') return rest.length === 0 || (rest.length === 1 && (rest[0] === 'all' || /^[Tt]\d+$/.test(rest[0])));
  return false;
}

// The commands that run beside the others rather than in turn, along
// with listing `tabs` and `scripts`. Each one waits, or reads what
// sm-dev already knows without reaching into a page, and changes
// nothing. So one sender's `wait 10s` or `status` neither holds up
// another's commands nor waits behind them. All other commands take
// turns, including those that only look into a page (`snapshot`).
// Each sender's own commands still run in order, since its client
// sends the next only once one has ended.
const RUNS_BESIDE = new Set(['wait', 'help', 'status', 'logs', 'match', 'validate']);

/** Whether a command line runs beside the others (see RUNS_BESIDE). */
export function runsBeside(line: string): boolean {
  const typed = line.trim().split(/\s+/)[0];
  const command = RUN_ALIASES[typed] ?? typed;
  if (command === 'tabs' || command === 'scripts') return onlyInspects(line);
  return RUNS_BESIDE.has(command);
}

/**
 * Whether a command line has a JSON form (`--json`): one of
 * `JSON_COMMANDS`, in a form that only looks (`tabs`, not `tabs T2`).
 */
export function hasJsonForm(line: string): boolean {
  const [typed = '', ...words] = commandWords(line);
  // Each collection and script verb has one, the changing ones too.
  if (managerCommandOf([typed, ...words])) return true;
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
export { MISTAKE_PREFIX };

/**
 * Set while a command runs, in its own async work: what it prints is
 * its reply, not something the page or a script printed on its own,
 * which `wait log` looks for. Lines from the page and scripts arrive
 * through events outside it. `inspects`: the command only looks, so
 * its reply is no part of the run's log either.
 */
export const inCommand = new AsyncLocalStorage<{ inspects: boolean }>();

// The commands that say which scripts a tab runs, or act on the ones
// it does (`save` lists them in the saved page, `values T1` reads them).
const SHOWS_ACTIVITY = new Set(['scripts', 'script', 'status', 'tabs', 'logs', 'save', 'values']);

// The commands that load pages and wait on their scripts.
const LOADS_PAGES = new Set(['reload', 'load', 'open', 'newtab', 'update', 'wait']);

// The commands that show a tab's frames, or the scripts in them.
const SHOWS_FRAMES = new Set(['scripts', 'script', 'status', 'tabs', 'frames', 'menu']);

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
    ctx.out(`${MISTAKE_PREFIX}${notACommand(typedCommand)}`);
    return false;
  }
  const { command } = own;
  const parsed = parseCommandArgs(command, own.rest);
  if ('error' in parsed) {
    ctx.out(`${MISTAKE_PREFIX}${parsed.error}`);
    return false;
  }
  // What the manager has turned off, for the commands that show what
  // the tabs are expected to run, and those that wait on a load's
  // scripts (`HarnessHost.isOff`).
  if (ctx.scriptsOff && (SHOWS_ACTIVITY.has(command) || LOADS_PAGES.has(command))) await ctx.scriptsOff.refresh();
  // The trees and JSON show each frame's details too, which cost a call
  // per frame.
  if (SHOWS_FRAMES.has(command)) {
    await loadFrames(ctx, command === 'frames' || parsed.flags['--frames'] === true || ctx.json === true || parsed.flags['--json'] !== undefined);
  }
  // The command's own --json or --nojson over the sender's global one,
  // and its own layout over the client's. Its help is text either way.
  const ownJson = parsed.flags['--json'];
  if (typeof ownJson === 'string') {
    const mistake = jsonLayoutMistake(ownJson);
    if (mistake) {
      ctx.out(`${MISTAKE_PREFIX}${mistake}`);
      return false;
    }
    if (ctx.json !== undefined) ctx.jsonLayout = ownJson as JsonLayout;
  }
  if (ctx.json !== undefined) ctx.json = !parsed.help && (parsed.flags['--nojson'] ? false : ownJson ? true : ctx.json);
  // `click --help`: its help, as `help click` gives it, rather than a
  // click; `script save --help`, the subcommand's.
  if (parsed.help) {
    const subcommand = helpSubcommand(command, parsed);
    if (typeof subcommand === 'object') {
      ctx.out(`${MISTAKE_PREFIX}${subcommand.error}`);
      return false;
    }
    for (const l of commandHelp(command, subcommand).trimEnd().split('\n')) ctx.out(l);
    return;
  }
  const unsupported = unsupportedCommand(command, ctx.managerName ?? DEFAULT_MANAGER, 'this run uses');
  if (unsupported) {
    ctx.out(`${MISTAKE_PREFIX}${unsupported}`);
    return false;
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
  // As markup, the name in its style, and plain, for error lines.
  const whoseUi = other ? ui` (${S.id(other.label)}: ${S.name(other.name)})`
    : ctx.scripts.length > 1 && current ? ui` (${S.name(preparedScriptName(current))})` : '';
  const whose = whoseUi && S.plainLine(whoseUi);
  const picked = currentTab(ctx);
  // Every controlled tab can be closed, T1 included.
  if (!picked && NEEDS_A_TAB.has(command)) {
    ctx.out(NO_TABS);
    return;
  }
  // Only undefined for the commands that don't act on it.
  const tab = picked as ControlledTab;
  // An open dialog blocks the page's JavaScript, so a command that
  // reaches into the page would wait on it, and hold up the `dialog`
  // command given after it. `set` reaches every tab, so any tab's
  // dialog blocks it.
  const blockedByDialog = (tabs: ControlledTab[] = [tab]): boolean => {
    const waiting = tabs.find((t) => t.dialogs?.current);
    if (!waiting) return false;
    ctx.out(S.SM_DEV_PREFIX + dialogWaitingMessage(ctx, waiting));
    return true;
  };

  switch (command) {
    case 'collection':
    case 'script': {
      const result = await managerCommand(ctx, command, parsed, cwd);
      // What the command turned on or off, for the waits on the next
      // load, however it comes (a `--watch` save's reload too).
      await ctx.scriptsOff?.refresh();
      return result;
    }
    case 'match':
      return matchCommand(ctx, args, cwd, flags['--frames'] === true);
    case 'validate':
      return validateCommand(ctx, args, cwd);
    case 'menu': {
      const timeoutMs = timeoutFlagMs(flags, ctx.out);
      if (timeoutMs === null) return false;
      // A label quoted as a whole is just that, even `all` or `T2.x`.
      const label = unquoteWhole(text);
      if (label.quoted) {
        if (blockedByDialog([tab])) return false;
        return fireMenu(ctx, tab, label.text, timeoutMs);
      }
      if (ctx.json && (text === 'all' || !text || /^[Tt]\d+$/.test(text))) {
        const which = text === 'all' ? ctx.tabs() : [text ? pickTab(ctx, text) : tab];
        if (which.includes(null)) return false;
        ctx.out(jsonResult('menu', { tabs: (which as ControlledTab[]).map((t) => menuJson(ctx, t)) } satisfies J.MenuData));
        return;
      }
      if (text === 'all') {
        ctx.out(ui`${S.heading('Menu commands')}:`);
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
        ctx.out(ui`${S.heading('Menu commands')}${onTabUi(ctx, ref.tab)}:`);
        for (const l of lines) ctx.out(l);
        return;
      }
      if (blockedByDialog([ref.tab])) return false;
      // The label after `T2.` may be quoted too.
      return fireMenu(ctx, ref.tab, unquoteWhole(ref.rest).text, timeoutMs);
    }
    case 'frames':
      return framesCommand(ctx, args, tab);
    case 'newtab':
      return openNewTab(ctx, args, flags, cwd);
    case 'closetab': {
      const timeoutMs = timeoutFlagMs(flags, ctx.out);
      if (timeoutMs === null) return false;
      return closeTabs(ctx, args, flags['--force'] === true, tab, timeoutMs);
    }
    case 'tabs': {
      const named = namedTab(ctx, 'tabs', parsed);
      if (named === null) return false;
      if (named === undefined) {
        if (ctx.json) ctx.out(jsonResult('tabs', { tabs: ctx.tabs().map((t) => tabJson(ctx, t)) } satisfies J.TabsData));
        else printTabs(ctx, flags['--frames'] === true);
        return;
      }
      // `tabs new` was newtab's old name.
      if (named === 'new') {
        ctx.out(MISTAKE_PREFIX + 'The `tabs` command picks a tab. To open one, use `newtab`.');
        return false;
      }
      const picked = pickTab(ctx, named);
      if (!picked) return false;
      ctx.tab = picked;
      ctx.out(`[sm-dev] ${ui`The page commands now act on ${S.id(tabName(picked))} (${S.url(picked.page.url())})`}`);
      return;
    }
    case 'scripts': {
      if (!text && ctx.json) {
        const others = await otherScriptsJson(ctx, picked);
        if (!others) return false;
        ctx.out(jsonResult('scripts', {
          ...(picked ? { tab: tabName(picked) } : {}),
          // Stored values as `status` gives them; another manager's aren't readable.
          scripts: [...await Promise.all(ctx.scripts.map(async (script) => ({
            ...scriptJson(ctx, script),
            ...(ctx.predicted ? {} : { values: await valueCount(ctx, script.id) }),
          }))), ...others],
        } satisfies J.ScriptsData));
        return;
      }
      if (!text) {
        ctx.out(ui`${S.heading('Loaded scripts')}:`);
        if (ctx.scripts.length === 0) ctx.out(`  ${NO_SCRIPTS}`);
        for (const script of ctx.scripts) {
          ctx.out(scriptRow(ctx, script));
          for (const l of activityLines(ctx, script, (t) => pageDetails(ctx, t, script))) ctx.out(l);
          // As `status` gives them.
          const values = await valueCount(ctx, script.id);
          if (values > 0) ctx.out(`${DETAIL}${count(values, 'stored value')}`);
        }
        for (const l of await otherLines(ctx, picked)) ctx.out(l);
        return;
      }
      // Under another manager, one of the run's own by its E-id.
      const own = OTHER_LABEL.test(text) ? ownByLabel(ctx, text) : undefined;
      if (own) {
        ctx.current = own;
        ctx.currentOther = undefined;
        ctx.out(`[sm-dev] ${ui`Selected ${scriptLabelUi(own)}`}`);
        return;
      }
      if (OTHER_LABEL.test(text)) {
        const found = await pickOther(ctx, text, picked);
        if (!found) return false;
        ctx.currentOther = found;
        const away = await otherOnTab(ctx, found, picked) ? '' : picked ? ui`. It isn't on ${S.id(tabName(picked))}'s page.` : '. No tab is open.';
        ctx.out(`[sm-dev] ${ui`Selected ${S.id(found.label)}: ${S.name(found.name)}${away}`}`);
        return;
      }
      const ref = tabRef(ctx, text, tab);
      if (!ref) return false;
      if (!ref.rest) {
        ctx.out(MISTAKE_PREFIX + 'The `scripts` command needs a script after the tab, e.g. `scripts T2.2`');
        return false;
      }
      const found = pickScript(ctx, ref.rest);
      if (!found) return false;
      ctx.current = found;
      ctx.currentOther = undefined;
      if (!ref.named) {
        ctx.out(`[sm-dev] ${ui`Selected ${scriptLabelUi(found)}`}`);
        return;
      }
      ctx.tab = ref.tab;
      ctx.out(`[sm-dev] ${ui`Selected ${scriptLabelUi(found)}, and ${S.id(tabName(ref.tab))} for the page commands`}`);
      return;
    }
    case 'status': {
      if (ctx.json) {
        ctx.out(jsonResult('status', await statusJson(ctx, picked)));
        return;
      }
      if (ctx.runId) {
        // Asked each time, since the person may install one mid-run.
        const chosen = ctx.managerName ?? DEFAULT_MANAGER;
        const managers = ctx.browser ? await ctx.managers?.() ?? null : null;
        const extension = managers ? stateLabel(managerState(managers, chosen), chosen) : '';
        ctx.out(ui`${S.heading('Run')}: ${S.id(ctx.runId)} (pid ${process.pid})${ctx.browser ? `, ${ctx.browser}${extension ? ` (${extension})` : ''}` : ''}`);
        if (managers) {
          ctx.out(ui`${S.heading('Managers')}: ${managersText(managers, chosen)}`);
          for (const line of otherManagersWarning(managers, chosen)) ctx.out(line);
        }
      }
      if (ctx.backend) ctx.out(ui`${S.heading('Backend')}: ${ctx.backend()}`);
      if (ctx.log) ctx.out(ui`${S.heading('Log')}: ${runLogLabelUi(ctx.log, ctx.runId)}`);
      // Chrome makes the folder with the first download, so it's only
      // worth a line once there is one.
      if (ctx.downloadsDir && existsSync(ctx.downloadsDir)) ctx.out(ui`${S.heading('Downloads')}: ${S.url(ctx.downloadsDir)}`);
      // The tabs first, each with its URL, ids and any dialog; then
      // the scripts, each with its status on each tab. With no tab,
      // still the scripts and what they have stored.
      printTabs(ctx, flags['--frames'] === true);
      for (const l of await statusLines(ctx, tab)) ctx.out(l);
      for (const l of await otherLines(ctx, tab)) ctx.out(l);
      return;
    }
    case 'values': {
      const outFile = typeof flags['--out'] === 'string' ? flags['--out'] : undefined;
      if (OTHER_LABEL.test(text)) {
        const found = await pickOther(ctx, text, picked);
        if (!found) return false;
        if (outFile !== undefined) return writeValuesFile(ctx, cwd, outFile, await found.values(), ui` (${S.id(found.label)}: ${S.name(found.name)})`);
        if (ctx.json) {
          ctx.out(jsonResult('values', { scripts: [{ script: found.label, name: found.name, values: await found.values() }] } satisfies J.ValuesData));
          return;
        }
        ctx.out(ui`${S.heading('Stored values')}:`);
        ctx.out(ui`  ${otherLabelUi(found)}`);
        for (const l of valueEntries(await found.values())) ctx.out(l);
        return;
      }
      // `--out` writes the selected script's values: one of another
      // manager's, as `get` and `set` take it, when that is selected.
      if (outFile !== undefined && !text && other) return writeValuesFile(ctx, cwd, outFile, await other.values(), whoseUi);
      if (ctx.scripts.length === 0) {
        if (outFile !== undefined) {
          ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
          return false;
        }
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
      } else if (outFile !== undefined) {
        // One script's values, as --values-file takes them: the one
        // named, or the selected one.
        if (text) {
          ctx.out(`${MISTAKE_PREFIX}The ${quoted('--out')} flag writes one script's values. Name one script, or select one with ${quoted('script')}.`);
          return false;
        }
        scripts = [current];
      } else if (ref.named) {
        scripts = runningOn(ctx, ref.tab);
        if (scripts.length === 0 && !ctx.json) {
          ctx.out(`[sm-dev] ${ui`No script is running on ${S.id(tabName(ref.tab))}`}`);
          return;
        }
      }
      await settleWrites();
      if (outFile !== undefined) {
        const [script] = scripts;
        const named = ctx.scripts.length > 1 ? ui` (${S.name(preparedScriptName(script))})` : '';
        return writeValuesFile(ctx, cwd, outFile, script.id ? await ctx.host.valuesOf(script.id) : {}, named);
      }
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
      ctx.out(ui`${S.heading('Stored values')}:`);
      for (const l of await valueLines(ctx, scripts)) ctx.out(l);
      return;
    }
    case 'get': {
      if (!scriptId && !other) {
        ctx.out(`[sm-dev] ${NO_SCRIPTS}`);
        return;
      }
      if (!text) {
        ctx.out(MISTAKE_PREFIX + 'The `get` command needs a key');
        return false;
      }
      await settleWrites();
      const values = other ? await other.values() : await ctx.host.valuesOf(scriptId!);
      // The value alone, whole, as `set <key> --file` reads it back.
      const getOut = flags['--out'];
      if (typeof getOut === 'string') {
        if (!Object.hasOwn(values, text)) {
          ctx.out(`${MISTAKE_PREFIX}Nothing is stored under ${quoted(text)}${whose}, so nothing was written`);
          return false;
        }
        return writeJsonFile(ctx, cwd, getOut, values[text], ui`Wrote ${S.given(text)}${whoseUi}`);
      }
      if (ctx.json) {
        const found = Object.hasOwn(values, text);
        ctx.out(jsonResult('get', {
          script: other ? other.label : scriptNumber(ctx, current!), key: text, found, ...(found ? { value: values[text] } : {}),
        } satisfies J.GetData));
        return;
      }
      ctx.out(ui`  ${S.code(text)} = ${S.code(String(JSON.stringify(values[text])))}`);
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
          ctx.out(MISTAKE_PREFIX + 'The `set` command takes a key and one file, e.g. `set units --file units.json`');
          return false;
        }
        const file = path.resolve(cwd, from);
        try {
          value = readJsonFile(file, shownPath(file, cwd));
        } catch (err) {
          ctx.out(`${MISTAKE_PREFIX}${(err as Error).message}`);
          return;
        }
      } else {
        if (!key || !raw) {
          ctx.out(MISTAKE_PREFIX + 'The `set` command needs a key and a JSON value, e.g. `set units "metric"`');
          return false;
        }
        try {
          value = JSON.parse(raw);
        } catch (err) {
          // A bare word typed inline is most likely a string without
          // its quotes; a block's JSON is just broken.
          ctx.out(parsed.block !== undefined
            ? `${MISTAKE_PREFIX}The value of ${quoted(key)} is not JSON: ${(err as Error).message}`
            : `${MISTAKE_PREFIX}${quoted(raw)} is not JSON. A string needs quotes.`);
          return;
        }
      }
      if (flags['--force'] === true && !other) {
        ctx.out(MISTAKE_PREFIX + 'The --force flag is for SourceMonkey-managed scripts only (E1, ...)');
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
          ctx.out(`${MISTAKE_PREFIX}${other.label} is a SourceMonkey-managed script, so this would change its real stored data. Use ${quoted('--force')} to continue.`);
          return false;
        }
        await other.setValues({ [key]: value });
      } else {
        await ctx.host.setValues(scriptId!, { [key]: value });
      }
      ctx.out(`[sm-dev] ${ui`Set ${S.given(key)}${whoseUi}`}`);
      return;
    }
    case 'reload': {
      const noWait = flags['--nowait'] === true;
      const timeoutMs = timeoutFlagMs(flags, ctx.out);
      if (timeoutMs === null) return false;
      const mode = scriptsMode(ctx, 'reload', flags);
      if (mode === null) return false;
      const named = namedTab(ctx, 'reload', parsed);
      if (named === null) return false;
      // `--force`: a page that asks first ("Leave site?") is left anyway,
      // and any dialogs already waiting are answered first.
      const force = flags['--force'] === true;
      if (named === 'all') {
        if (force) for (const t of ctx.tabs()) await answerDialog(t, false);
        // All at once, so one slow page holds up no other.
        const all = reloadable(ctx.tabs(), ctx.out);
        for (const t of all) if (!await switchScripts(ctx, t, mode)) return false;
        await Promise.all(all.map((t) => reloadTab(t, ctx.host, ctx.out, { timeoutMs, force, noWait })));
        return;
      }
      const target = named !== undefined ? pickTab(ctx, named) : tab;
      if (!target) return false;
      if (force) await answerDialog(target, false);
      if (blockedByDialog([target])) return false;
      if (!await switchScripts(ctx, target, mode)) return false;
      await reloadTab(target, ctx.host, ctx.out, { timeoutMs, force, noWait });
      return;
    }
    case 'load': {
      if (args.length === 0) {
        ctx.out(MISTAKE_PREFIX + 'The `load` command needs a script file');
        return false;
      }
      if (!ctx.loadScript) {
        ctx.out('[sm-dev] This run cannot load scripts');
        return;
      }
      const timeoutMs = timeoutFlagMs(flags, ctx.out);
      if (timeoutMs === null) return false;
      // It reloads every tab it affects, so any tab's dialog blocks it.
      if (blockedByDialog(ctx.tabs())) return;
      // All expanded first, so a glob matching nothing loads none.
      for (const file of expandPathArgs(args, cwd, { scripts: true })) {
        // A relative path sent from another directory is the sender's.
        await ctx.loadScript(cwd !== process.cwd() && !path.isAbsolute(file) ? path.resolve(cwd, file) : file, timeoutMs);
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
      const timeoutMs = timeoutFlagMs(flags, ctx.out);
      if (timeoutMs === null) return false;
      if (blockedByDialog(ctx.tabs())) return;
      if (!text || text === 'all') {
        await ctx.updateScripts(undefined, timeoutMs);
        return;
      }
      const script = pickScript(ctx, text);
      if (!script) return false;
      await ctx.updateScripts([script], timeoutMs);
      return;
    }
    case 'open': {
      // `--noscript` / `--script` switch the tab's mode, which lasts,
      // as does `--from-saved`.
      const saved = savedFlags(ctx, flags);
      if (!saved) return false;
      const noWait = flags['--nowait'] === true;
      const timeoutMs = timeoutFlagMs(flags, ctx.out);
      if (timeoutMs === null) return false;
      const mode = scriptsMode(ctx, 'open', flags);
      if (mode === null) return false;
      // A glob stands for the files it matches, of which it takes one.
      const page = args.flatMap((w) => expandPathArg(w, cwd));
      let inTab: ControlledTab | undefined;
      if (parsed.tab !== undefined) {
        const picked = pickTab(ctx, parsed.tab);
        if (!picked) return false;
        inTab = picked;
      }
      // Rather than a page at http://all.
      if (page[0] === 'all' && page.length === 1) {
        ctx.out(MISTAKE_PREFIX + 'The `open` command navigates one tab. To open a tab for each script, use `newtab all`.');
        return false;
      }
      if (page.length > 1) {
        ctx.out(MISTAKE_PREFIX + 'The `open` command opens one page, so it takes one URL, file or script. To open multiple, use `newtab`.');
        return false;
      }
      const where = page[0] ?? '';
      // `T2.3`: script 3's page, in T2. Only that shape, so a host like
      // `t2.example.com` stays a URL. (A bare `T2` is `--tab T2`.)
      const target = inTab ? { tab: inTab, rest: where } : TAB_REF.test(where) ? tabRef(ctx, where, tab) : { tab, rest: where };
      if (!target) return false;
      const named = target.rest ? await pageFor(ctx, target.rest, cwd) : undefined;
      if (named === null) return false;
      const [opening] = await pagesToOpen(named ? [{ word: target.rest, url: named }] : [], saved, cwd);
      // With the mode switched and no page named, the page it's on.
      const url = opening?.url ?? (mode !== undefined ? target.tab.page.url()
        : current ? scriptPage(ctx, current) : null);
      if (!url) {
        if (!current) ctx.out(MISTAKE_PREFIX + 'The `open` command needs a URL, since no script is loaded');
        return false;
      }
      if (blockedByDialog([target.tab])) return false;
      if (!await switchScripts(ctx, target.tab, mode)) return false;
      if (opening?.saved) {
        await serveSavedPage(target.tab, opening.saved, ctx.out, target.tab.noScript === true || ctx.scripts.length === 0);
        ctx.out(openingSavedLine(opening.saved.given, url, tabName(target.tab)));
      }
      if (!await gotoInTab(target.tab, ctx.host, url, ctx.out, { timeoutMs, noWait })) return false;
      return;
    }
    case 'wait':
      return waitFor(ctx, parsed);
    case 'logs':
      return logsCommand(ctx, parsed, picked);
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
    case 'dialog':
      return dialogCommand(ctx, parsed, cwd);
    default: {
      if (!PAGE_COMMANDS.has(command)) {
        ctx.out(`${MISTAKE_PREFIX}${notACommand(command)}`);
        return false;
      }
      // The tab named first, or the current one.
      let target = tab;
      if (parsed.tab !== undefined) {
        const named = pickTab(ctx, parsed.tab);
        if (!named) return false;
        target = named;
      }
      // They reach into a page, which a dialog has stopped.
      if (blockedByDialog([target])) return false;
      let evalIn: EvalIn | undefined;
      if (command === 'eval') {
        // A tab that runs no scripts has no script to be in, so a bare
        // `eval` there runs in the page without a word about it.
        const page = parsed.flags['--page'] === true || (target.noScript === true && parsed.flags['--script'] === undefined);
        const resolved = evalScope(ctx, parsed.flags['--script'], page);
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
    ctx.out(`${MISTAKE_PREFIX}The ${quoted(command)} command takes one tab`);
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

/** `runLogLabel` marked up, for output: the log's path as one. */
export function runLogLabelUi(file: string, id: string | undefined): string {
  return ui`${S.url(file)}${runLogLabel(file, id).slice(file.length)}`;
}

// `scriptLabel` marked up, for output.
function scriptLabelUi(script: PreparedScript): string {
  const name = preparedScriptName(script);
  const file = preparedScriptPath(script);
  return name === script.script.relativePath || name === file ? S.url(file) : ui`${S.name(name)} (${S.url(file)})`;
}

// `* ` on the selected item in a list, or its spaces, marked up.
function selectMark(isSelected: boolean): string {
  return isSelected ? ui`${S.selected('*')} ` : '  ';
}

// One script's row in any list of them: its number in the `scripts` list,
// with `*` on the one `get` and `set` act on. Under another manager,
// with its E-id there. Marked up, so only for output.
function scriptRow(ctx: ConsoleContext, script: PreparedScript): string {
  const id = ctx.predicted ? ctx.extensionIdOf?.(script) : undefined;
  const there = id !== undefined ? ui`, ${S.id(`E${id}`)} in ${MANAGERS[ctx.managerName ?? DEFAULT_MANAGER].label}` : '';
  return ui`${selectMark(script === selectedScript(ctx))}${S.id(ctx.scripts.indexOf(script) + 1)}: ${scriptLabelUi(script)}${there}`;
}

// Under another manager, the run's own script with E-id `label`.
function ownByLabel(ctx: ConsoleContext, label: string): PreparedScript | undefined {
  if (!ctx.predicted) return undefined;
  return ctx.scripts.find((script) => `E${ctx.extensionIdOf?.(script)}` === label.toUpperCase());
}

// The run's script `get` and `set` act on, marked `*` in the lists:
// none while a SourceMonkey-managed script (`E1`) is picked instead.
function selectedScript(ctx: ConsoleContext): PreparedScript | undefined {
  return ctx.currentOther ? undefined : ctx.current ?? ctx.scripts[0];
}

/**
 * Where `eval` runs: inside the selected script, or the one
 * `--script=<script>` names; in the page with `--page`.
 * - With no run script selected (none loaded, or an `E` script picked,
 *   which has no eval hook), a bare `eval` runs in the page, and
 *   `--script` is an error.
 * - A selected script that hasn't run on the page: a bare `eval` runs
 *   in the page, so its globals aren't silently out of reach. With
 *   `--script` that's a failure, as the script was asked for.
 * Null, said why, when the name picks none, `--script` has no script,
 * or the flags clash.
 */
function evalScope(ctx: ConsoleContext, flag: string | true | undefined, page: boolean): EvalIn | null {
  if (page) {
    if (flag === undefined) return 'page';
    ctx.out(`${MISTAKE_PREFIX}The ${quoted('eval')} command takes ${quoted('--page')} or ${quoted('--script')}, not both`);
    return null;
  }
  const script = flag === undefined || flag === true ? selectedScript(ctx) : pickScript(ctx, flag);
  if (!script) {
    if (flag === undefined) return 'page';
    if (flag === true) ctx.out(`${MISTAKE_PREFIX}No script of this run is selected, so ${quoted('eval --script')} has none to run in. Name one with ${quoted('--script=<script>')}, or use ${quoted('--page')}.`);
    return null;
  }
  // No hook: not pushed into the extension, so it hasn't run anywhere.
  const hook = script.id ? ctx.host.evalHook(script.id) : null;
  // Another manager reports nothing, so a missed scope there says
  // nothing about whether the script ran.
  const manager = ctx.managerName && ctx.managerName !== DEFAULT_MANAGER ? MANAGERS[ctx.managerName].label : undefined;
  return { scope: hook && { world: script.world, ...hook }, name: preparedScriptName(script), inPageIfMissing: flag === undefined, manager };
}

/**
 * The script a typed argument names: its number in the `scripts` list, an
 * exact path, file name or `@name`, or else a piece of its name or path
 * that no other loaded script shares. Reports why and returns null when
 * there is no single answer.
 */
function pickScript(ctx: ConsoleContext, arg: string): PreparedScript | null {
  const own = ownByLabel(ctx, arg);
  if (own) return own;
  if (/^\d+$/.test(arg)) {
    const script = ctx.scripts[Number(arg) - 1];
    if (!script) ctx.out(`[sm-dev] There is no script ${quoted(arg)}. Use ${quoted('scripts')} to list them.`);
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
    ctx.out(`[sm-dev] No loaded script matches ${quoted(arg)}. Use ${quoted('scripts')} to list them.`);
  } else {
    const numbers = hits.map((script) => ctx.scripts.indexOf(script) + 1).join(', ');
    ctx.out(`[sm-dev] Multiple loaded scripts match ${quoted(arg)} (${numbers}). Name one by its number.`);
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
 * The `collection` and `script` commands for what's installed (`collection`
 * alone lists). `parsed`: its words as command-args.ts reads them, the
 * verb as `form` (`list`), what it acts on as `subject` (`C3` in
 * `collection C3 show`). `cwd`: where a path `script install` is given
 * is from.
 */
export async function managerCommand(
  ctx: Pick<ConsoleContext, 'manager' | 'out' | 'json'> & Partial<ConsoleContext>, command: string,
  parsed: Pick<ParsedArgs, 'form' | 'subject' | 'words' | 'flags'>, cwd = process.cwd(),
): Promise<boolean | void> {
  const { form, subject, words: args, flags } = parsed;
  if (form === undefined && args.length > 0) {
    ctx.out(`${MISTAKE_PREFIX}${noSuchVerb(args)}`);
    return false;
  }
  if (!ctx.manager) {
    ctx.out('[sm-dev] This run has no SourceMonkey to manage');
    return false;
  }
  const kind = command === 'script' ? 'script' : 'collection';
  if (form !== undefined && form !== 'list') {
    return managerVerb({
      manager: ctx.manager,
      out: ctx.out,
      json: ctx.json === true,
      ...(ctx.scripts ? { run: managerRun(ctx as ConsoleContext) } : {}),
      // A throwaway browser's data is the run's own, as for `set`; with
      // no run, the browser is always the person's.
      guarded: ctx.others?.guarded ?? true,
      cwd,
    }, kind, form, subject, args, flags);
  }
  try {
    if (kind === 'script') await scriptList(ctx.manager, args[0], ctx.out, ctx.json === true, runView(ctx));
    else await collectionList(ctx.manager, ctx.out, ctx.json === true);
  } catch (err) {
    // What it named isn't there, or SourceMonkey failed: a failure, not
    // a mistake in the command, as `pickScript` reports one.
    ctx.out(`[sm-dev] ${firstLine(err)}`);
    return false;
  }
}

// In a run, what the commands that show and change things need of it.
function managerRun(ctx: ConsoleContext): ManagerRun {
  const ownScript = (internalId: string): PreparedScript | undefined =>
    ctx.scripts.find((script) => ctx.extensionIdOf?.(script) === internalId);
  return {
    ...runView(ctx)!,
    updateOwn: async (internalId) => {
      const script = ownScript(internalId);
      if (!script || !ctx.updateScripts) throw new Error('This run cannot update scripts');
      // It reloads the tabs the script runs in, as `update` does, which
      // an open dialog would hold up.
      const waiting = ctx.tabs().find((t) => t.dialogs?.current);
      if (waiting) throw new Error(dialogWaitingError(ctx, waiting));
      await ctx.updateScripts([script]);
    },
    tabsOf: async (managed, label) => {
      const script = ownScript(managed.id);
      const out: Awaited<ReturnType<ManagerRun['tabsOf']>> = [];
      for (const tab of ctx.tabs()) {
        const name = tabName(tab);
        // As `scripts` says it, and on every tab: one it doesn't match
        // says so rather than being left out.
        if (script) {
          out.push({ activity: tabActivityJson(ctx, tab, script), text: tabActivity(ctx, tab, script) ?? "Doesn't match page URL" });
          continue;
        }
        const other = label === undefined ? undefined : (await ctx.others?.onTab(tab).catch((): OtherScript[] => []))?.find((o) => o.label === label);
        out.push(other
          ? { activity: { tab: name, state: OTHER_STATE[other.status] ?? 'running' }, text: OTHER_STATUS[other.status] ?? other.status }
          : { activity: { tab: name, state: activityState(ctx, false) }, text: ctx.predicted ? 'Not expected using match rules' : 'Not on this page' });
      }
      return out;
    },
  };
}

// In a run, how `script list` shows the run's own scripts: by their
// numbers here (`2`), with the selected script (one of them, or an `E`
// script picked) marked.
function runView(ctx: Partial<ConsoleContext>): RunView | undefined {
  if (!ctx.scripts) return undefined;
  const own = new Map<string, string>();
  ctx.scripts.forEach((script, i) => {
    const id = ctx.extensionIdOf?.(script);
    if (id) own.set(id, String(i + 1));
  });
  const selected = ctx.currentOther ? { label: ctx.currentOther.label } : undefined;
  const mine = ctx.currentOther ? undefined : ctx.current ?? ctx.scripts[0];
  const mineId = mine && ctx.extensionIdOf?.(mine);
  return { own, selected: selected ?? (mineId ? { internalId: mineId } : undefined) };
}

/**
 * `match` in a run: the selected script on the current tab, unless the
 * words name others. Scripts: a number, `T2.3`, a loaded script's
 * name or file name, a `.user.js` file (or its URL), `all-scripts`.
 * Pages: a tab, `T2.3`'s tab, a URL, `all-tabs`. `all` is both. 1 when
 * any page isn't matched.
 */
async function matchCommand(ctx: ConsoleContext, words: string[], cwd: string, withFrames = false): Promise<number> {
  const loaded: PreparedScript[] = [];
  const files: string[] = [];
  const pages: MatchTarget[] = [];
  let allScripts = false;
  let allTabs = false;
  if (withFrames) await loadFrames(ctx);
  // With --frames, a tab's iframes are checked too.
  const framesOf = (tab: ControlledTab): Pick<MatchTarget, 'frames'> => (withFrames ? {
    frames: (ctx.frames?.get(tab) ?? []).map((f) => ({
      id: `F${f.n}`, parent: f.parent === null ? tabName(tab) : `F${f.parent}`, url: f.url, depth: f.depth,
    })),
  } : {});
  const tabPage = (tab: ControlledTab): MatchTarget & { name: string } => ({ url: tab.page.url(), name: tabName(tab), ...framesOf(tab) });
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
        if (isScriptWord(found)) files.push(found);
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
    // Named only when there is another tab it could have been, or
    // frames under it to tell it from.
    pages.push(ctx.tabs().length > 1 || withFrames ? tabPage(tab) : { url: tab.page.url() });
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
  const sources: ValidateSource[] = [];
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
    ctx.out(`${MISTAKE_PREFIX}The ${quoted(command)} command takes ${quoted('--noscript')} or ${quoted('--script')}, not both`);
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
    ctx.out(MISTAKE_PREFIX + 'The --url flag needs a URL, e.g. --url https://example.com/page');
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

// `onTab` marked up, for output.
function onTabUi(ctx: ConsoleContext, tab: ControlledTab): string {
  return ctx.tabs().length > 1 ? ui` on ${S.id(tabName(tab))}` : '';
}

function fromTab<T extends object>(ctx: ConsoleContext, tab: ControlledTab, records: T[]): T[] {
  return records.filter((r) => ctx.host.pageOf(r) === tab.link);
}

// ---------- Frames ----------

/** One of a tab's iframes, with the run's scripts running in it. */
export interface FrameView {
  /** Its id's number: `F3` is 3. */
  n: number;
  /** Its parent's number, or null for a frame in the top frame. */
  parent: number | null;
  /** 1 for a frame in the top frame. */
  depth: number;
  url: string;
  scripts: PreparedScript[];
  /** The extension's ids for its live documents, where it says. */
  documents: string[];
  /** Read with `loadFrames`' details: its <iframe> isn't visible (no size, hidden). */
  hidden?: true;
  /** Read with `loadFrames`' details: its CDP frame id, in its target. */
  frameId?: string;
  /** Read with `loadFrames`' details: its CDP target, when it runs in a process of its own. */
  targetId?: string;
}

// Reads each tab's frames and the scripts in them, for the command
// about to show them. Says once why frames' scripts can't be shown
// (an extension too old), listing the frames anyway.
//
// With `details`, also whether each is hidden and its CDP target.
async function loadFrames(ctx: ConsoleContext, details = false): Promise<void> {
  const views = new Map<ControlledTab, FrameView[]>();
  let problem: string | undefined;
  for (const tab of ctx.tabs()) {
    views.set(tab, await tabFrames(ctx, tab, (why) => { problem ??= why; }, details).catch((): FrameView[] => []));
  }
  ctx.frames = views;
  if (problem) ctx.out(`[sm-dev] ${problem}`);
}

// A tab's iframes, each after its parent. Under SourceMonkey, a frame's
// scripts are those that started in its current document. Under another
// manager, which reports nothing, those whose rules cover its URL, as
// `activeOn` predicts for the top frame.
async function tabFrames(ctx: ConsoleContext, tab: ControlledTab, unknown: (why: string) => void, details: boolean): Promise<FrameView[]> {
  const nodes = frameNodes(tab.page, ctx.host.frameIds);
  if (nodes.length === 0) return [];
  let scriptsIn = (_url: string, _frame: unknown): PreparedScript[] => [];
  const documentsOf = new Map<unknown, string[]>();
  if (tab.noScript) {
    // No scripts run in any of its frames.
  } else if (ctx.predicted) {
    scriptsIn = (url) => ctx.scripts.filter((s) => !preparedNoframes(s) && !ctx.scriptsOff?.has(s) && explainMatch(s.matching, url).matches);
  } else {
    const documents = await ctx.host.liveFrameDocuments(tab.link).catch((err: Error) => {
      unknown(err.message);
      return null;
    }) ?? new Map();
    const runs = ctx.host.frameRuns(tab.link);
    const byFrame = new Map<unknown, Set<string>>();
    for (const [documentId, frame] of documents) {
      documentsOf.set(frame, [...documentsOf.get(frame) ?? [], documentId]);
      for (const id of runs.get(documentId) ?? []) {
        let ids = byFrame.get(frame);
        if (!ids) byFrame.set(frame, ids = new Set());
        ids.add(id);
      }
    }
    scriptsIn = (_url, frame) => ctx.scripts.filter((s) => s.id !== undefined && byFrame.get(frame)?.has(s.id) === true);
  }
  // All at once, each bounded: a frame's page that's busy only costs
  // its own details.
  const found = (id: string | undefined | 'timeout'): string | undefined => (id === 'timeout' ? undefined : id);
  const detailOf = (frame: Frame): Promise<Pick<FrameView, 'hidden' | 'frameId' | 'targetId'>> => (details ? Promise.all([
    within(frame.frameElement().then((el) => el.isVisible()), DETAIL_MS).catch(() => true),
    within(tab.link.frameCdpId(frame), DETAIL_MS).catch(() => undefined),
    within(tab.link.frameTargetId(frame), DETAIL_MS).catch(() => undefined),
  ]).then(([visible, frameId, targetId]) => ({
    // Unknown (too slow) counts as visible: only a frame known to be hidden is marked.
    ...(visible === false ? { hidden: true as const } : {}),
    ...(found(frameId) ? { frameId: found(frameId) } : {}),
    ...(found(targetId) ? { targetId: found(targetId) } : {}),
  })) : Promise.resolve({}));
  const detailed = await Promise.all(nodes.map((node) => detailOf(node.frame)));
  return nodes.map((node, i) => ({
    n: node.n, parent: node.parent, depth: node.depth, url: node.url, scripts: scriptsIn(node.url, node.frame), documents: documentsOf.get(node.frame) ?? [],
    ...detailed[i],
  }));
}

// How long a frame's details (`loadFrames`) may take to read.
const DETAIL_MS = 1000;

// The numbers of a tab's frames a script runs in.
function framesRunning(ctx: ConsoleContext, tab: ControlledTab, scriptId: string | undefined): number[] {
  if (scriptId === undefined) return [];
  return (ctx.frames?.get(tab) ?? []).filter((f) => f.scripts.some((s) => s.id === scriptId)).map((f) => f.n);
}

// Whether a script runs anywhere in a tab: its top frame or an iframe.
function activeInTab(ctx: ConsoleContext, tab: ControlledTab, scriptId: string | undefined): boolean {
  return activeOn(ctx, tab, scriptId) || framesRunning(ctx, tab, scriptId).length > 0;
}

// Where in a tab a script runs, by frame ids: the tab's own id for its
// top frame. Undefined when that's the top frame only, or nowhere.
function framesWhere(ctx: ConsoleContext, tab: ControlledTab, scriptId: string | undefined): string[] | undefined {
  const frames = framesRunning(ctx, tab, scriptId);
  if (frames.length === 0) return undefined;
  return [...(activeOn(ctx, tab, scriptId) ? [tabName(tab)] : []), ...frames.map((n) => `F${n}`)];
}

// `framesWhere` after a tab's name or a script's: ` (T1, F1, F3)`. A
// script without @noframes on an ad-heavy page runs in 100 frames or
// more, so a long list is cut, with the count of the rest.
function framesSuffix(ctx: ConsoleContext, tab: ControlledTab, scriptId: string | undefined): string {
  const where = framesWhere(ctx, tab, scriptId);
  return where ? ui` (${placesList(where)})` : '';
}

/**
 * Places as `framesSuffix` lists them: all of them, or the first few and
 * how many more. Never "and 1 more", which takes the room of the one.
 */
export function placesList(where: string[]): string {
  if (where.length <= FRAMES_LISTED + 1) return idList(where);
  return ui`${idList(where.slice(0, FRAMES_LISTED))} and ${where.length - FRAMES_LISTED} more frames`;
}

// How many places `framesSuffix` names before it counts the rest.
const FRAMES_LISTED = 5;

// IDs joined by commas, each marked up.
function idList(ids: string[]): string {
  return ui`${ids.map((i) => S.id(i)).join(', ')}`;
}

// After a tab's URL: how many iframes it has.
function frameCountSuffix(ctx: ConsoleContext, tab: ControlledTab): string {
  const n = ctx.frames?.get(tab)?.length ?? 0;
  return n === 0 ? '' : ` (+${count(n, 'frame')})`;
}

// A tab's frame tree: the top frame (the tab's id), then each iframe
// under its parent, each with the scripts in it. `indent` goes before
// each line; `from` limits it to that frame and the frames in it.
function frameTreeLines(ctx: ConsoleContext, tab: ControlledTab, indent: string, from?: number): string[] {
  const label = ctx.predicted ? 'Expected' : 'Scripts';
  const scriptsLine = (scripts: PreparedScript[], pad: string): string =>
    ui`${pad}    ${S.heading(label)}: ${scripts.length === 0 ? 'None' : idList(scripts.map((s) => scriptNumber(ctx, s)))}`;
  const frames = ctx.frames?.get(tab) ?? [];
  const lines: string[] = [];
  let base = 0;
  let shown = frames;
  if (from === undefined) {
    // The top frame's frame id is its tab's target id.
    const ids = tab.targetId ? ` [frameId=${tab.targetId}]${targetIdSuffix(tab.targetId)}` : '';
    lines.push(ui`${indent}${S.id(tabName(tab))}: ${S.url(tab.page.url())}${ids}`, scriptsLine(runningOn(ctx, tab), indent));
  } else {
    // The frame and those under it: those after it, until one no deeper.
    const at = frames.findIndex((f) => f.n === from);
    const end = frames.findIndex((f, i) => i > at && f.depth <= frames[at].depth);
    shown = frames.slice(at, end < 0 ? undefined : end);
    base = frames[at].depth;
  }
  for (const frame of shown) {
    const pad = `${indent}${'  '.repeat(frame.depth - base)}`;
    // A frame's own target, when it has one, is the same id as its frame
    // id; both are shown, so each is there to copy.
    const ids = `${frame.frameId ? ` [frameId=${frame.frameId}]` : ''}${targetIdSuffix(frame.targetId)}`;
    lines.push(ui`${pad}${S.id(`F${frame.n}`)}: ${S.url(frame.url)}${frame.hidden ? ' (hidden)' : ''}${ids}`, scriptsLine(frame.scripts, pad));
  }
  return lines;
}

// A tab's frames as JSON: absent for none.
function framesJson(ctx: ConsoleContext, tab: ControlledTab): { frames?: J.Frame[] } {
  const frames = ctx.frames?.get(tab) ?? [];
  if (frames.length === 0) return {};
  return {
    frames: frames.map((f) => ({
      id: `F${f.n}`, parent: f.parent === null ? tabName(tab) : `F${f.parent}`, url: f.url, scripts: f.scripts.map((s) => scriptNumber(ctx, s)),
      ...(f.hidden ? { hidden: true as const } : {}), ...(f.frameId ? { frameId: f.frameId } : {}), ...(f.targetId ? { targetId: f.targetId } : {}),
    })),
  };
}

// `frames [tab|frame|all]`.
function framesCommand(ctx: ConsoleContext, words: string[], current: ControlledTab | undefined): boolean | void {
  const word = words[0];
  const tabs: { tab: ControlledTab; from?: number }[] = [];
  if (word?.toLowerCase() === 'all') {
    if (ctx.tabs().length === 0) {
      ctx.out(NO_TABS);
      return false;
    }
    tabs.push(...ctx.tabs().map((tab) => ({ tab })));
  } else if (word && CDP_FRAME_ARG.test(word)) {
    // An iframe by its CDP id, or a tab by its target id: its top frame's.
    const id = CDP_FRAME_ARG.exec(word)![1];
    const hits = [
      ...ctx.tabs().filter((t) => t.targetId?.toUpperCase().startsWith(id.toUpperCase())).map((tab) => ({ tab, name: tabName(tab), from: undefined })),
      ...framesWithId(ctx, id).map((h) => ({ tab: h.tab, name: `F${h.frame.n}`, from: h.frame.n })),
    ];
    if (hits.length !== 1) {
      ctx.out(hits.length > 1
        ? `[sm-dev] Multiple frames have ids starting with ${quoted(id)} (${hits.map((h) => h.name).join(', ')}). Give more of it.`
        : `[sm-dev] No frame's id starts with ${quoted(id)}. Use ${quoted('frames all')} to list them.`);
      return false;
    }
    tabs.push({ tab: hits[0].tab, from: hits[0].from });
  } else if (word && parseFrameRef(word)) {
    const ref = parseFrameRef(word)!;
    const found = ctx.tabs().find((t) => (ctx.frames?.get(t) ?? []).some((f) => f.n === ref.frame));
    if (!found || (ref.tab !== undefined && found.n !== ref.tab)) {
      ctx.out(`${MISTAKE_PREFIX}${ref.tab !== undefined ? `T${ref.tab} has no frame F${ref.frame}` : `No tab has a frame F${ref.frame}`}. Use ${quoted('frames all')} to list them.`);
      return false;
    }
    tabs.push({ tab: found, from: ref.frame });
  } else if (word) {
    const tab = pickTab(ctx, word);
    if (!tab) return false;
    tabs.push({ tab });
  } else {
    if (!current) {
      ctx.out(NO_TABS);
      return false;
    }
    tabs.push({ tab: current });
  }
  if (ctx.json) {
    ctx.out(jsonResult('frames', {
      tabs: tabs.map(({ tab, from }) => {
        const all = framesJson(ctx, tab).frames ?? [];
        const under = from === undefined ? all : subtree(all, `F${from}`);
        return { tab: tabName(tab), url: tab.page.url(), scripts: runningOn(ctx, tab).map((s) => scriptNumber(ctx, s)), frames: under };
      }),
    } satisfies J.FramesData));
    return;
  }
  for (const { tab, from } of tabs) {
    for (const line of frameTreeLines(ctx, tab, '', from)) ctx.out(line);
    if (from === undefined && (ctx.frames?.get(tab)?.length ?? 0) === 0) ctx.out('  No frames');
  }
}

// The iframes, of any tab, whose CDP frame id starts with `id`.
function framesWithId(ctx: ConsoleContext, id: string): { tab: ControlledTab; frame: FrameView }[] {
  const upper = id.toUpperCase();
  return ctx.tabs().flatMap((tab) => (ctx.frames?.get(tab) ?? [])
    .filter((frame) => frame.frameId?.toUpperCase().startsWith(upper)).map((frame) => ({ tab, frame })));
}

// A frame and those under it, from a tab's frames as JSON.
function subtree(frames: J.Frame[], id: string): J.Frame[] {
  const ids = new Set([id]);
  return frames.filter((f) => {
    if (f.id === id) return true;
    if (!ids.has(f.parent)) return false;
    ids.add(f.id);
    return true;
  });
}

// Whether a script is running on a tab's current top-frame document.
// Under another manager (`predicted`), whether its rules cover the
// tab's page, since nothing reports what ran.
function activeOn(ctx: ConsoleContext, tab: ControlledTab, scriptId: string | undefined): boolean {
  // Switched to run no scripts: the host's last word from it can still
  // be a start from before, since a load with none says nothing.
  if (tab.noScript) return false;
  if (ctx.predicted) {
    const script = ctx.scripts.find((s) => s.id === scriptId);
    if (script === undefined || ctx.scriptsOff?.has(script)) return false;
    return explainMatch(script.matching, tab.page.url()).matches;
  }
  return scriptId !== undefined && ctx.host.isRunning(tab.link, scriptId);
}

// What a manual script that hasn't run on a tab is doing there.
const WAITING_FOR_MENU = 'Waiting for menu to run it (@run-at context-menu)';

// Under another manager, a manual script whose rules match: whether its
// menu was used isn't known.
const MANUAL = 'Runs from its menu (@run-at context-menu)';

// Whether a manual script (`@run-at context-menu`) not running on a
// tab could be run there.
function waitingOn(ctx: ConsoleContext, tab: ControlledTab, scriptId: string | undefined, running: boolean): boolean {
  return !running && !ctx.predicted && scriptId !== undefined && ctx.host.manualScripts(tab.link).includes(scriptId);
}

// `activeOn`'s answer, as JSON.
function activityState(ctx: ConsoleContext, active: boolean, waiting = false): J.TabState {
  if (ctx.predicted) return active ? 'expected' : 'not-expected';
  if (waiting) return 'manual';
  return active ? 'running' : 'not-running';
}

/**
 * The tabs of `tabs` that can be reloaded now. One waiting on a dialog
 * would hang its reload, so it is left for the person, and named.
 */
export function reloadable(tabs: ControlledTab[], out: (line: string) => void): ControlledTab[] {
  const waiting = tabs.filter((t) => t.dialogs?.current);
  for (const t of waiting) out(S.SM_DEV_PREFIX + ui`${tabName(t)} is waiting on ${t.dialogs?.stopping ? dialogSummary(t.dialogs.stopping) : 'a dialog'}, so it was not reloaded`);
  return tabs.filter((t) => !waiting.includes(t));
}

/**
 * Reload one tab, as `loadInTab` loads it. False when the reload
 * failed (said already). `force`: a `beforeunload` dialog the reload
 * opens is accepted.
 */
export function reloadTab(
  tab: ControlledTab, host: HarnessHost, out: (line: string) => void, { timeoutMs, force = false, noWait = false }: LoadOptions = {},
): Promise<boolean> {
  const saved = showingSaved(tab);
  const reload = (): Promise<boolean> => loadPage(tab.page, (o) => tab.page.reload(o), timeoutMs);
  const load = force && tab.dialogs ? () => tab.dialogs!.leavingPage(reload) : reload;
  return loadInTab(tab, host, () => withOfflineHint(tab, saved, load), `[sm-dev] ${tabName(tab)} could not be reloaded`, out, { timeoutMs, noWait, hint: offlineHint(tab, saved) });
}

/** Navigate one tab to `url`, as `reloadTab` reloads it. */
export function gotoInTab(
  tab: ControlledTab, host: HarnessHost, url: string, out: (line: string) => void, { timeoutMs, noWait = false }: LoadOptions = {},
): Promise<boolean> {
  const saved = tab.saved !== undefined && comparableUrl(url) === comparableUrl(tab.saved.url);
  const load = (): Promise<boolean> => loadPage(tab.page, (o) => tab.page.goto(url, o), timeoutMs);
  return loadInTab(tab, host, () => withOfflineHint(tab, saved, load), '[sm-dev] Navigation failed', out, { timeoutMs, noWait, hint: offlineHint(tab, saved) });
}

/** How `loadInTab` loads a page. */
export interface LoadOptions {
  /** `--timeout-seconds`, for the whole load. */
  timeoutMs?: number;
  /** Return once the page has loaded, without waiting for it to settle. */
  noWait?: boolean;
  /** `reload --force`: accept a `beforeunload` dialog the reload opens. */
  force?: boolean;
  /** Said after a warning that the page didn't finish loading. */
  hint?: string;
}

// A saved page without --offline still loads its images, scripts and
// styles from the live site, and one that never answers holds up its load
// (as a site that needs a login does). So a load of one that timed
// out says how to stop that.
function offlineHint(tab: ControlledTab, saved: boolean): string | undefined {
  return saved && !tab.saved?.offline
    ? 'The saved page still loads its images, scripts and styles from the live site. Open it with --from-saved --offline to block those.'
    : undefined;
}

async function withOfflineHint(tab: ControlledTab, saved: boolean, load: () => Promise<boolean>): Promise<boolean> {
  try {
    return await load();
  } catch (err) {
    const hint = offlineHint(tab, saved);
    if (err instanceof PageNotLoaded && hint) throw new PageNotLoaded(`${err.message}. ${hint}`);
    throw err;
  }
}

// The longest one round trip into a loaded page may take.
const PAGE_ROUND_TRIP_MS = 1000;

/**
 * Load a page in `tab`, within the load's limit (`--timeout-seconds`,
 * or 30 seconds):
 * - The page must start loading, or the load fails, said after `failed`.
 * - It should finish loading. A page that doesn't (an ad that never
 *   finishes) still works, so it gets a warning naming what it was
 *   busy with, plus `hint`, and the load ends there.
 * - Unless `noWait`, it should then settle (see wait.ts), its scripts
 *   started included, within 5 seconds, or it gets a warning. So a
 *   command that loads a page ends with its scripts' output rather
 *   than before it.
 * A dialog the page opens ends the wait, as the page waits on it; so
 * does the tab closing. What the load does after that prints nothing.
 * False when the load failed.
 */
async function loadInTab(
  tab: ControlledTab, host: HarnessHost, load: () => Promise<boolean>, failed: string, out: (line: string) => void,
  { timeoutMs, noWait = false, hint }: LoadOptions,
): Promise<boolean> {
  const limitMs = timeoutMs ?? LOAD_TIMEOUT_MS;
  // Set once the wait has ended on a dialog or the tab closing.
  let ended = false;
  const say = (line: string): void => {
    if (!ended) out(line);
  };
  // Whether the page loaded in full; false when it didn't finish.
  let complete = true;
  // False when the load itself failed.
  const work = inLimit(limitMs, async (): Promise<boolean> => {
    let loaded: boolean;
    try {
      loaded = await load();
    } catch (err) {
      say(`${failed}: ${(err as Error).message}`);
      return false;
    }
    if (ended || tab.page.isClosed()) return true;
    // Each a round trip into the page, which a dialog in a tab sharing
    // its process (one it opened) holds up for good: bounded.
    await within(tab.link.caughtUp(), PAGE_ROUND_TRIP_MS);
    if (!loaded) {
      complete = false;
      if (ended) return true;
      const message = await notLoadedMessage(tab, host, limitMs);
      say(`[sm-dev] ${hint ? `${message}. ${hint}` : message}`);
      return true;
    }
    if (noWait || ended) return true;
    const settleMs = budgeted(SETTLE_TIMEOUT_MS);
    const outcome = await settleTab(tab, host, settleMs);
    if (!outcome.settled && 'busy' in outcome) say(`[sm-dev] ${notSettledMessage(tab, settleMs, outcome.busy)}`);
    // What the scripts' bodies printed comes through another session.
    await within(tab.link.drain(), PAGE_ROUND_TRIP_MS);
    return true;
  });
  let onClose!: () => void;
  const closed = new Promise<boolean>((resolve) => {
    onClose = () => resolve(true);
    tab.page.once('close', onClose);
  });
  try {
    const raced = Promise.race([work, closed]);
    // A dialog counts as loaded: the page is there, waiting on it.
    const ok = await (tab.dialogs ? tab.dialogs.untilDialog(raced) : raced);
    ended = true;
    // So `start` doesn't wait on the scripts of a tab whose load gave up.
    tab.stalled = !ok || !complete;
    return ok;
  } finally {
    tab.page.off('close', onClose);
  }
}


// `tabs`, and the end of `status` when there are several: each tab
// with `*` on the current one, what opened it, an open dialog, and
// which scripts run there.
//
// With `frames`, each tab's frame tree in place of its scripts.
function printTabs(ctx: ConsoleContext, frames = false): void {
  const current = currentTab(ctx);
  ctx.out(ui`${S.heading('Tabs')}:`);
  if (ctx.tabs().length === 0) ctx.out('  No active tabs');
  for (const tab of ctx.tabs()) {
    const opener = tab.openedBy ? ui` (opened by ${S.id(`T${tab.openedBy}`)})` : '';
    const none = tab.noScript ? ' (no scripts)' : '';
    ctx.out(ui`${selectMark(tab === current)}${S.id(tabName(tab))}: ${S.url(tab.page.url())}${frameCountSuffix(ctx, tab)}${savedSuffix(tab)}${none}${opener}${targetIdSuffix(tab.targetId)}`);
    for (const d of tab.dialogs?.waiting ?? []) ctx.out(ui`    Waiting on ${dialogSummary(d)}. Use ${S.cmd(showCommand(ctx, d))} to see how to answer it.`);
    if (frames) {
      // The tab's own line is above; the tree's first line repeats it.
      // Its lines are indented as the tab's frames, two deeper than its
      // scripts' lines would be.
      for (const line of frameTreeLines(ctx, tab, '  ').slice(1)) ctx.out(line);
      continue;
    }
    // Those in its top frame or any of its iframes, and those that
    // should be and aren't.
    const listed = ctx.scripts.filter((script) => activeInTab(ctx, tab, script.id) || tabNote(ctx, tab, script).length > 0);
    // By @name alone, the file being in `scripts`. The selected script is one
    // for the whole run, so its `*` goes only under the current tab.
    const selected = tab === current ? selectedScript(ctx) : undefined;
    for (const script of listed) {
      // Where, when not the top frame alone, then anything amiss.
      const where = framesWhere(ctx, tab, script.id);
      const notes = [...(where ? [placesList(where)] : []), tabNote(ctx, tab, script).join(', ')].filter((n) => n);
      const suffix = notes.length > 0 ? ui` (${notes.join('; ')})` : '';
      ctx.out(ui`   ${selectMark(script === selected)}${S.id(ctx.scripts.indexOf(script) + 1)}: ${S.name(preparedScriptName(script))}${suffix}`);
    }
  }
}

// ---------- JSON forms (see json-output.ts) ----------

// A loaded script's id: its number in the `scripts` list.
function scriptNumber(ctx: ConsoleContext, script: PreparedScript): string {
  return String(ctx.scripts.indexOf(script) + 1);
}

function tabJson(ctx: ConsoleContext, tab: ControlledTab): J.Tab {
  const dialogs = tab.dialogs?.waiting ?? [];
  const saved = showingSaved(tab) ? tab.saved : undefined;
  return {
    id: tabName(tab),
    url: tab.page.url(),
    ...(tab.targetId ? { targetId: tab.targetId } : {}),
    selected: tab === currentTab(ctx),
    ...(tab.noScript ? { noScript: true } : {}),
    ...(saved ? { savedFrom: saved.given, ...(saved.offline ? { offline: true } : {}) } : {}),
    ...(tab.openedBy ? { openedBy: `T${tab.openedBy}` } : {}),
    ...(dialogs.length > 0 ? { dialogs: dialogs.map((d) => ({ id: d.id, title: d.title, ...(d.message ? { message: d.message } : {}) })) } : {}),
    scripts: runningOn(ctx, tab).map((script) => scriptNumber(ctx, script)),
    ...framesJson(ctx, tab),
  };
}

function scriptJson(ctx: ConsoleContext, script: PreparedScript): J.Script {
  const installed = ctx.predicted ? ctx.extensionIdOf?.(script) : undefined;
  return {
    id: scriptNumber(ctx, script),
    ...(installed !== undefined ? { installedAs: `E${installed}` } : {}),
    kind: 'run',
    name: preparedScriptName(script),
    file: preparedScriptPath(script),
    status: script.status,
    ...(script.diagnostic ? { error: script.diagnostic } : {}),
    ...(script === selectedScript(ctx) ? { selected: true } : {}),
    tabs: ctx.tabs().map((tab) => tabActivityJson(ctx, tab, script)),
  };
}

// A run's script on one tab, as JSON: what `tabActivity` and
// `pageDetails` say in words.
function tabActivityJson(ctx: ConsoleContext, tab: ControlledTab, script: PreparedScript): J.TabActivity {
  const id = script.id;
  const s = tabStanding(ctx, tab, script);
  const where = framesWhere(ctx, tab, id);
  const out: J.TabActivity = {
    tab: tabName(tab),
    state: activityState(ctx, s.anywhere, s.waiting),
    ...(where ? { frames: where } : {}),
    matches: explainMatch(script.matching, tab.page.url()).matches,
    ...(s.manual ? {} : { expected: s.expected }),
    ...(s.off ? { notExpected: s.off } : {}),
  };
  // Another manager says nothing of what ran.
  if (ctx.predicted) return out;
  const skipped = skipReason(ctx, tab, id);
  const { errors, warnings } = pageReports(ctx, tab, script);
  const lastError = errors.at(-1);
  return {
    ...out,
    // As `Expected, Not running (skipped: ...)` says: one that doesn't
    // match has its rule miss as a skip too.
    ...(skipped && s.expected && !s.top ? { skipped } : {}),
    menuCommands: tabMenuCommands(ctx, tab).filter((r) => r.scriptId === id).length,
    errors: errors.length,
    warnings: warnings.length,
    ...(lastError ? { lastError: lastError.message } : {}),
    ...(lastError?.frameNumber !== undefined ? { lastErrorFrame: `F${lastError.frameNumber}` } : {}),
    ...(warnings.length > 0 ? { lastWarning: warnings.at(-1)!.message } : {}),
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
  UNTRACKED: 'unknown',
  EXPECTED: 'expected',
};

// The SourceMonkey-managed scripts on `tab`, as JSON; null (said why)
// when they couldn't be listed.
async function otherScriptsJson(ctx: ConsoleContext, tab: ControlledTab | undefined): Promise<J.Script[] | null> {
  if (!ctx.others) return [];
  // With no tab, only the picked one, which is on no page.
  if (!tab) return ctx.currentOther ? [{ ...otherJson(ctx, ctx.currentOther), tabs: [] }] : [];
  let others: OtherScript[];
  try {
    others = await ctx.others.onTab(tab);
  } catch (err) {
    ctx.out(`[sm-dev] ${othersKind(ctx)} on ${tabName(tab)} could not be listed: ${firstLine(err)}`);
    return null;
  }
  const away = ctx.currentOther && !others.includes(ctx.currentOther) ? [ctx.currentOther] : [];
  return [...others, ...away].map((o) => ({
    ...otherJson(ctx, o),
    tabs: [{ tab: tabName(tab), state: away.includes(o) ? 'not-running' : OTHER_STATE[o.status] ?? 'running' }],
  }));
}

function otherJson(ctx: ConsoleContext, o: OtherScript): J.Script {
  return {
    id: o.label,
    kind: 'installed',
    name: o.name,
    ...(o.collection ? { collection: { name: o.collection } } : {}),
    ...(o.label === ctx.currentOther?.label ? { selected: true } : {}),
  };
}

async function statusJson(ctx: ConsoleContext, tab: ControlledTab | undefined): Promise<J.StatusData> {
  const { reports } = ctx.host;
  const scripts: J.StatusScript[] = [];
  for (const script of ctx.scripts) {
    const id = script.id;
    // As the text gives them with no tab: each tab's are in `tabs`.
    const errors = tab ? [] : reports.errors.filter((r) => r.scriptId === id);
    scripts.push({
      ...scriptJson(ctx, script),
      // Another manager's aren't readable.
      ...(ctx.predicted ? {} : { values: id ? Object.keys(await ctx.host.valuesOf(id)).length : 0 }),
      ...(tab ? {} : { errors: errors.length }),
      ...(errors.length > 0 ? { lastError: errors.at(-1)!.message } : {}),
    });
    // The prompts shown as dialogs: one whose tab closed is gone, as
    // from the text output.
    const prompts = runDialogs(ctx).filter((d) => d.scriptId === id && d.connect);
    if (prompts.length > 0) {
      scripts[scripts.length - 1].permissionPrompts = prompts.map((d) => ({ ...d.connect!, dialog: d.id }));
    }
  }
  const others = await otherScriptsJson(ctx, tab) ?? [];
  let run: J.StatusData['run'];
  if (ctx.runId && ctx.browserInfo) {
    const chosen = ctx.managerName ?? DEFAULT_MANAGER;
    const managers = await ctx.managers?.() ?? null;
    const collection = ctx.testCollection?.();
    run = {
      id: ctx.runId,
      pid: process.pid,
      browser: ctx.browserInfo,
      manager: chosen,
      ...(managers ? {
        sourceMonkey: managerState(managers, 'sourcemonkey'),
        managers: managers.map((m) => ({ manager: m.manager, name: m.name, version: m.version, id: m.id, enabled: m.enabled, userScripts: m.userScripts })),
      } : {}),
      ...(collection ? { testCollection: collection } : {}),
      ...(ctx.log ? { log: ctx.log } : {}),
      ...(ctx.downloadsDir ? { downloads: ctx.downloadsDir } : {}),
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
    .map((c) => ({
      id: `M${++n}`, script: scriptNumber(ctx, script), name: c.name, ...('run' in c ? { builtin: 'run' as const } : {}),
      ...('record' in c && c.frameNumber !== undefined ? { frame: `F${c.frameNumber}` } : {}),
    })));
  return { tab: tabName(tab), url: tab.page.url(), commands };
}

// How long `closetab` waits for a tab to close, or to ask first.
const CLOSE_TIMEOUT_MS = 5000;

// `closetab [tab...|all] [--force]`: closes the current tab, the tabs
// named, or all of them. Each is named before any closes, so a slip
// closes none. The tabs' own close handlers say each closed. The
// browser's last tab is replaced by a blank one, so the browser stays.
//
// The page's beforeunload handlers run, as when a person closes a tab,
// so a page that asks first ("Leave site?") shows its dialog, which the
// dialog tracker reports for `dialog accept` (leave) or `dialog cancel` (stay).
// `--force` skips them.
async function closeTabs(ctx: ConsoleContext, words: string[], force: boolean, current: ControlledTab, timeoutMs = CLOSE_TIMEOUT_MS): Promise<void | false> {
  let tabs: ControlledTab[];
  if (words.length === 1 && words[0] === 'all') {
    tabs = ctx.tabs();
  } else if (words.length === 0) {
    tabs = [current];
  } else {
    tabs = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i] === 'all') {
        ctx.out(MISTAKE_PREFIX + 'The `closetab` command takes all by itself, to close all tabs');
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
    ctx.out(S.SM_DEV_PREFIX + ui`${tabName(t)} is waiting on ${dialogSummary(t.dialogs!.stopping!)}, so it was not closed. Answer it, or use ${S.cmd(`closetab ${tabName(t)} --force`)}.`);
  }
  const closing = tabs.filter((t) => !waiting.includes(t));
  // Closing the browser's last tab closes the browser, which ends a run
  // in a browser of its own, so a blank tab is opened to stay. In a
  // shared browser, the person's own tabs keep it open.
  const pages = current.page.context().pages().filter((p) => !p.isClosed());
  if (ctx.newTab && closing.length > 0 && pages.every((p) => closing.some((t) => t.page === p))) await ctx.newTab();
  await Promise.all(closing.map((t) => closeTab(ctx, t, force, timeoutMs)));
  // Says where the page commands act now, if their tab closed.
  currentTab(ctx);
}

// For `--force`: answers the dialog `tab` is waiting on, if any, so it
// can go on. `leave`: a beforeunload one is accepted, which leaves the
// page (`closetab`); else it's dismissed like any other, so the
// navigation it held back doesn't race a reload. One that couldn't be
// answered is put back, to be named as still waiting.
async function answerDialog(tab: ControlledTab, leave: boolean): Promise<void> {
  const dialog = tab.dialogs?.take();
  if (!dialog) return;
  try {
    await (leave && dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  } catch {
    if (!tab.page.isClosed()) tab.dialogs!.putBack(dialog);
  }
}

// Closes one tab for `closetab`, and says if it didn't close: it asked
// first (its dialog, reported by the tracker, is waiting on an answer),
// or it didn't close in time.
async function closeTab(ctx: ConsoleContext, tab: ControlledTab, force: boolean, timeoutMs: number): Promise<void> {
  const { page } = tab;
  timeoutMs = budgeted(timeoutMs);
  if (force) {
    // A page stopped on a dialog never finishes closing.
    await answerDialog(tab, true);
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  let onClose = (): void => undefined;
  const closedOrLate = new Promise<void>((resolve) => {
    onClose = resolve;
    page.once('close', onClose);
    timer = setTimeout(resolve, timeoutMs);
  });
  // Watched from before the close, which may open it at once. Its
  // dialog, if it asks, is shown by the tracker, with the commands that
  // answer it.
  const asking = tab.dialogs?.untilDialog(closedOrLate.then(() => false)) ?? closedOrLate.then(() => false);
  // With beforeunload run, Playwright doesn't wait for the close.
  await page.close({ runBeforeUnload: true }).catch(() => undefined);
  const asked = await asking;
  clearTimeout(timer);
  page.off('close', onClose);
  if (!asked && !page.isClosed()) {
    ctx.out(`[sm-dev] ${tabName(tab)} didn't close within ${seconds(shownMs(timeoutMs))}. Use ${quoted('closetab --force')} to close it without running its beforeunload handlers.`);
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
  const timeoutMs = timeoutFlagMs(given, ctx.out);
  if (timeoutMs === null) return false;
  const mode = scriptsMode(ctx, 'newtab', given);
  if (mode === null) return false;
  const noScript = mode === true;
  if (!ctx.newTab) {
    ctx.out('[sm-dev] This run cannot open tabs');
    return;
  }
  if (rest.includes('all')) {
    if (rest.length > 1 || flags.fromSaved || flags.url !== undefined || flags.offline) {
      ctx.out(MISTAKE_PREFIX + 'The `newtab` command takes all by itself, to open each script\'s page');
      return false;
    }
    return openScriptPages(ctx, noScript, noWait, timeoutMs);
  }
  const tabRef = rest.find((w) => TAB_REF.test(w));
  if (tabRef) {
    ctx.out(`${MISTAKE_PREFIX}The ${quoted('newtab')} command opens a tab of its own, so it takes URLs, files or script numbers, not ${quoted(tabRef)}`);
    return false;
  }
  const named: PageWord[] = [];
  for (const word of rest.flatMap((w) => expandPathArg(w, cwd))) {
    const url = await pageFor(ctx, word, cwd);
    if (!url) return false;
    named.push({ word, url });
  }
  const pages = await pagesToOpen(named, flags, cwd);
  const open = async (page?: PageToOpen): Promise<ControlledTab | null> => {
    try {
      return await ctx.newTab!(page?.url, { noScript, saved: page?.saved, timeoutMs, noWait });
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
  // A new session on a page showing a dialog waits for it to close, so
  // that page is left where it is, and a dialog opening meanwhile only
  // holds this up a moment.
  if (!tab.dialogs?.current) await within(focusTab(tab.page).catch(() => undefined), PAGE_ROUND_TRIP_MS);
  ctx.out(`[sm-dev] The page commands now act on ${tabName(tab)} (${tab.page.url()})`);
}

// `newtab all`: one tab per distinct script page; the scripts with
// none, or whose tab failed, are listed at the end, after the tabs'
// own output.
async function openScriptPages(ctx: ConsoleContext, noScript: boolean, noWait: boolean, timeoutMs: number | undefined): Promise<void> {
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
      opened.push(await ctx.newTab!(url, { noScript, timeoutMs, noWait }));
    } catch (err) {
      for (const script of scripts) {
        const i = ctx.scripts.indexOf(script);
        skipped[i] = skippedScriptLine(i + 1, script, `The tab could not be opened: ${(err as Error).message}`);
      }
    }
  }));
  for (const line of skipped) if (line) ctx.out(line);
}

// What `open` and `newtab` take: a script by its number, or an
// installed one by its E-id, meaning its default page, or else a URL. A
// bare number or `E3` can't be a URL, so they never overlap.
// `cwd`: where a relative path is, the sender's for a sent command.
async function pageFor(ctx: ConsoleContext, arg: string, cwd: string): Promise<string | null> {
  if (OTHER_LABEL.test(arg) && !ownByLabel(ctx, arg)) return installedPage(ctx, arg.toUpperCase());
  if (!/^\d+$/.test(arg) && !OTHER_LABEL.test(arg)) return withDefaultScheme(arg, cwd);
  const script = pickScript(ctx, arg);
  return script ? scriptPage(ctx, script) : null;
}

// An installed script's default page, from its `@match`, or null
// having said why.
async function installedPage(ctx: ConsoleContext, label: string): Promise<string | null> {
  if (!ctx.manager) {
    ctx.out(`${MISTAKE_PREFIX}${quoted(label)} names an installed script, which this run can't look up`);
    return null;
  }
  try {
    const found = (await ctx.manager.scripts()).find((s) => `E${s.number}` === label);
    const details = found && await ctx.manager.scriptDetails(found.id);
    if (!details) {
      ctx.out(`[sm-dev] ${noSuchScript(label)}`);
      return null;
    }
    const url = representativeMatch({ matches: details.match })?.linkUrl ?? null;
    if (!url) ctx.out(`[sm-dev] ${ui`${S.id(label)}: ${S.name(details.name)}: ${NO_DEFAULT_PAGE}. Give a URL instead.`}`);
    return url;
  } catch (err) {
    ctx.out(`[sm-dev] ${label} could not be looked up: ${firstLine(err)}`);
    return null;
  }
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
    ctx.out(ui`${selectMark(tab === current)}${S.heading('Tab')} ${S.id(tabName(tab))}: ${S.url(tab.page.url())}`);
    const lines = body(tab);
    if (lines.length === 0 && empty) ctx.out(`    ${empty}`);
    for (const l of lines) ctx.out(`  ${l}`);
  }
}

function runningOn(ctx: ConsoleContext, tab: ControlledTab): PreparedScript[] {
  return ctx.scripts.filter((script) => activeOn(ctx, tab, script.id));
}

// ---------- Logs ----------

/**
 * `logs [tab|all] [script]`: the run's log lines (see run-logs.ts), of
 * the sources asked for (by default all but the page's own), on the
 * current tab, the one named, or all of them, and for one script if
 * named. Then the position reached, for the next `--since`.
 */
function logsCommand(ctx: ConsoleContext, parsed: ParsedArgs, current: ControlledTab | undefined): boolean | void {
  const mistake = (text: string): false => {
    ctx.out(`${MISTAKE_PREFIX}${text}`);
    return false;
  };
  const logs = ctx.logs;
  if (!logs) {
    ctx.out('[sm-dev] Internal error: This run keeps no log');
    return false;
  }
  // `--tab all` as `all`, as the commands about tabs take it.
  const all = parsed.tab?.toLowerCase() === 'all';
  const scriptFlag = parsed.flags['--script'];
  const scriptWord = typeof scriptFlag === 'string' ? scriptFlag : undefined;
  let tab: ControlledTab | undefined;
  if (parsed.tab !== undefined && !all) {
    const named = pickTab(ctx, parsed.tab);
    if (!named) return false;
    tab = named;
  } else if (!all) {
    if (!current) {
      ctx.out(NO_TABS);
      return false;
    }
    tab = current;
  }
  const script = scriptWord === undefined ? undefined : pickScript(ctx, scriptWord);
  if (script === null) return false;
  const { flags } = parsed;
  const sources = typeof flags['--log-source'] === 'string' ? parseLogSources(flags['--log-source']) : DEFAULT_LOG_SOURCES;
  if ('error' in sources) return mistake(sources.error as string);
  const find = typeof flags['--find'] === 'string' ? textMatcher(flags['--find']) : undefined;
  if (find && 'error' in find) return mistake(find.error);
  const since = typeof flags['--since'] === 'string' ? parsePosition(flags['--since']) : undefined;
  if (typeof since === 'object') return mistake(since.error);
  const tail = typeof flags['--tail'] === 'string' ? parseTail(flags['--tail']) : undefined;
  if (tail && 'error' in tail) return mistake(tail.error);

  const position = logs.position();
  // A tab's lines, and the lines of the scripts running there made
  // outside any tab (a refresh's, a failed @require's).
  const onTab = new Set(tab ? runningOn(ctx, tab).map((s) => s.id) : []);
  let records = (since === undefined ? [...logs.all()] : logs.since(since)).filter((r) => inSources(r, sources)
    && (!tab || r.tab === tab.n || (r.tab === undefined && r.scriptId !== undefined && onTab.has(r.scriptId)))
    && (!script || r.scriptId === script.id)
    && (!find || find.matches(streamText(r, true))));
  if (tail && 'lines' in tail) records = records.slice(-tail.lines);
  else if (tail) {
    const from = nowMicros() - tail.micros;
    records = records.filter((r) => r.id > from);
  }

  const lost = since === undefined ? undefined : logs.lostAfter(since);
  if (lost !== undefined) ctx.out(linesLost(lost));
  if (ctx.json) {
    ctx.out(jsonResult('logs', {
      ...(tab ? { tab: tabName(tab) } : {}),
      ...(script ? { script: scriptNumber(ctx, script) } : {}),
      lines: records.map((r) => logLineJson(ctx, r)),
      until: position,
    } satisfies J.LogsData));
  } else if (records.length === 0) {
    ctx.out(noLogLines(tab ? tabName(tab) : undefined));
  } else {
    for (const line of logsLines(records)) ctx.out(line);
  }
  ctx.out(logsUpTo(position));
}

function logLineJson(ctx: ConsoleContext, record: LogRecord): J.LogLine {
  const script = record.scriptId === undefined ? undefined : ctx.scripts.find((s) => s.id === record.scriptId);
  return {
    id: record.id,
    time: isoTime(record.id),
    ...(record.tab !== undefined ? { tab: `T${record.tab}` } : {}),
    ...(record.frame !== undefined ? { frame: `F${record.frame}` } : {}),
    ...(script ? { script: scriptNumber(ctx, script) } : {}),
    source: record.source,
    ...(record.also ? { also: record.also } : {}),
    kind: record.kind,
    text: record.text,
  };
}


// ---------- Menu commands ----------

// One entry `menu` lists: a command a script registered, or a manual
// script's own "Run this script" (`run`).
// `frameNumber`: the iframe all of the entry's registrations are in,
// when they are all in one.
type MenuEntry = { name: string; scriptId: string } & ({ record: MenuCommandRecord; frameNumber?: number } | { run: true });

// A tab's menu commands under the script that registered each, in load
// order. A manual script that can run on the tab's document (`@run-at
// context-menu`) gets a group even before it has run, with "Run this
// script" first. The M numbers `menu` prints count through this, so
// firing by number reads the same order.
function menuGroups(ctx: ConsoleContext, tab: ControlledTab): { script: PreparedScript; label: string; commands: MenuEntry[] }[] {
  const all = tabMenuCommands(ctx, tab);
  const manual = new Set(ctx.host.manualScripts(tab.link));
  return ctx.scripts
    .map((script) => {
      const scriptId = script.id ?? '';
      const commands: MenuEntry[] = all
        .filter((c) => c.scriptId === script.id)
        .map(({ record, frameNumber }) => ({ name: record.name, scriptId, record, frameNumber }));
      if (manual.has(scriptId)) commands.unshift({ name: RUN_SCRIPT_LABEL, scriptId, run: true });
      return { script, label: scriptRow(ctx, script), commands };
    })
    .filter((group) => group.commands.length > 0);
}

// The menu commands a tab shows, as the extension's popup does: one per
// script and caption, across the tab's frames. Firing it runs them all.
function tabMenuCommands(ctx: ConsoleContext, tab: ControlledTab): { scriptId: string; record: MenuCommandRecord; frameNumber?: number }[] {
  const live = fromTab(ctx, tab, ctx.host.reports.menuCommands).filter((c) => menuLive(ctx, tab, c));
  const key = (c: MenuCommandRecord): string => `${c.scriptId}\0${c.name}`;
  return visibleCommands(live, key).map((record) => {
    const docs = new Set(live.filter((c) => key(c) === key(record)).map((c) => c.documentId));
    return { scriptId: record.scriptId, record, ...(docs.size === 1 ? { frameNumber: record.frameNumber } : {}) };
  });
}

// Whether an iframe's menu command is still there: its document is one
// of the tab's frames shows now. The extension sends nothing when a
// frame goes. Kept when the frames haven't been read.
function menuLive(ctx: ConsoleContext, tab: ControlledTab, record: MenuCommandRecord): boolean {
  const frames = ctx.frames?.get(tab);
  if (!record.frame || !frames || !record.documentId || ctx.predicted) return true;
  return frames.some((f) => f.documents.includes(record.documentId!));
}

// A tab's menu commands as `menu` lists them, numbered M1, M2 under
// each script; empty when it has none.
function menuLines(ctx: ConsoleContext, tab: ControlledTab): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const group of menuGroups(ctx, tab)) {
    lines.push(group.label);
    // One an iframe registered names it: each frame has its own copy.
    for (const c of group.commands) lines.push(ui`    ${S.id(`M${++n}`)}: ${S.name(c.name)}${'record' in c && c.frameNumber !== undefined ? ui` (${S.id(`F${c.frameNumber}`)})` : ''}`);
  }
  return lines;
}

function noMenusMessage(ctx: ConsoleContext, tab: ControlledTab): string {
  if (ctx.tabs().length === 1) return '[sm-dev] No menu commands are registered';
  const others = ctx.tabs().filter((t) => t !== tab && menuGroups(ctx, t).length > 0);
  return others.length === 0
    ? '[sm-dev] No menu commands are registered on any tab'
    : `[sm-dev] No menu commands are registered on ${tabName(tab)}. ${listed(others.map(tabName))} ${others.length === 1 ? 'has' : 'have'} some; `
      + `use ${quoted('menu all')} or ${quoted(`menu ${tabName(others[0])}`)} to list them.`;
}

// A script registers its commands as it starts, and commands are only
// read once one has started. So for piped input, a miss while nothing
// is registered yet may just be early, and is worth waiting out. A
// miss while others are registered is a wrong name, and is reported at
// once, as is any miss typed at a terminal. A `--timeout-seconds`
// given waits that long for it in any case.
const MENU_WAIT_MS = 5000;

// A label without its leading and trailing emoji, symbols and spaces,
// in lower case: `⚙️ Script Settings` is `script settings`.
function looseLabel(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

/** Whether a menu label matches `argument` but for case and the emoji or symbols around it. */
function looselyNamed(label: string, argument: string): boolean {
  const key = looseLabel(argument);
  return key !== '' && looseLabel(label) === key;
}

/**
 * The menu command whose label matches `argument` but for case and the
 * emoji or symbols around it, as a label like `⚙️ Settings` is given
 * without them, when only one label does. `labels`: each distinct one
 * that matched.
 */
function looseMenuMatch(commands: MenuEntry[], argument: string): { entry?: MenuEntry; labels: string[] } {
  const found = commands.filter((c) => looselyNamed(c.name, argument));
  // One label can be listed more than once (from multiple frames); as
  // for an exact match, the last one listed.
  const labels = [...new Set(found.map((c) => c.name))];
  return labels.length === 1 ? { entry: found.at(-1), labels } : { labels };
}

// False when nothing was fired.
async function fireMenu(ctx: ConsoleContext, tab: ControlledTab, argument: string, timeoutMs?: number): Promise<boolean> {
  const all = (): MenuEntry[] => menuGroups(ctx, tab).flatMap((group) => group.commands);
  const numbered = /^[Mm](\d+)$/.exec(argument);
  const deadline = Date.now() + budgeted(timeoutMs ?? MENU_WAIT_MS);
  for (;;) {
    const commands = all();
    // A label wins over a number, for a command whose label is one.
    const byName = [...commands].reverse().find((c) => c.name === argument) ?? looseMenuMatch(commands, argument).entry;
    const byNumber = numbered ? commands[Number(numbered[1]) - 1] : undefined;
    const entry = byName ?? byNumber;
    if (entry && 'run' in entry) {
      // Each manual script has one, so the label alone may not say which.
      if (!byNumber && commands.filter((c) => 'run' in c).length > 1) {
        ctx.out(`[sm-dev] More than one script here has "${RUN_SCRIPT_LABEL}". Use ${quoted('menu')} to list them, and fire one by its M number.`);
        return false;
      }
      return runManual(ctx, tab, entry.scriptId);
    }
    if (entry) {
      // Listed but not fired: the page that registered it is going
      // away, as in the middle of a navigation.
      if (!await fire(tab, ctx.host.fireMenuEntry(entry.record))) {
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
    const early = timeoutMs === undefined && (ctx.interactive || commands.length > 0);
    if (early || Date.now() >= deadline || elsewhereFor(ctx, tab, argument).length > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const elsewhere = numbered ? [] : elsewhereFor(ctx, tab, argument);
  if (/^\d+$/.test(argument) && elsewhere.length === 0) ctx.out(`${MISTAKE_PREFIX}Menu commands are named M1, M2 and so on. Did you mean ${quoted(`M${argument}`)}?`);
  else if (elsewhere.length > 0) {
    ctx.out(`[sm-dev] "${argument}" is registered on ${listed(elsewhere.map(tabName))}, not ${tabName(tab)}. `
      + `Use ${quoted(`menu ${tabName(elsewhere[0])}.${argument}`)} to fire it ${elsewhere.length === 1 ? 'there' : 'on one of them'}.`);
  }
  else if (all().length === 0) ctx.out(noMenusMessage(ctx, tab));
  else if (looseMenuMatch(all(), argument).labels.length > 1) {
    const labels = looseMenuMatch(all(), argument).labels;
    ctx.out(`[sm-dev] Multiple menu commands match ${quoted(argument)}: ${labels.map((l) => `"${l}"`).join(', ')}. Give the whole label, or its M number.`);
  }
  else if (numbered) ctx.out(`[sm-dev] There is no menu command M${numbered[1]}${onTab(ctx, tab)}. Use ${quoted('menu')} to list them.`);
  else ctx.out(`[sm-dev] No menu command named "${argument}" is registered${onTab(ctx, tab)}. Use ${quoted('menu')} to list them.`);
  return false;
}

// Run a manual script on a tab: `menu`'s "Run this script". The run's
// start (or error) prints as any script's does. False when it didn't run.
async function runManual(ctx: ConsoleContext, tab: ControlledTab, scriptId: string): Promise<boolean> {
  const script = ctx.scripts.find((sc) => sc.id === scriptId);
  const name = script ? preparedScriptName(script) : scriptId;
  // Settled here either way: when the run opens a dialog, `fire` stops
  // waiting at the dialog, and a later failure has nobody else to catch it.
  const run = ctx.host.runManualScript(tab.link, scriptId).then(() => null, (err: unknown) => err as Error);
  const failed = await fire(tab, run.then((err) => err === null)) === false ? await run : null;
  if (failed) {
    ctx.out(`${MISTAKE_PREFIX}${name} did not run: ${failed.message}`);
    return false;
  }
  ctx.out(`[sm-dev] ${ui`Ran ${script ? S.name(name) : name}`}`);
  if (!tab.dialogs?.current) await fire(tab, tab.link.drain().then(() => true));
  return true;
}

// The other tabs with a menu command of that label.
function elsewhereFor(ctx: ConsoleContext, tab: ControlledTab, label: string): ControlledTab[] {
  // Loosely too, as `menu` matches on the tab itself.
  return ctx.tabs().filter((t) => t !== tab && fromTab(ctx, t, ctx.host.reports.menuCommands).some((c) => c.name === label || looselyNamed(c.name, label)));
}

// Counts as done once a dialog the command opens is up, so `dialog accept`
// can be typed.
function fire(tab: ControlledTab, fired: Promise<boolean>): Promise<boolean> {
  return tab.dialogs ? tab.dialogs.untilDialog(fired) : fired;
}

// ---------- status and values ----------

// Each script's state: any permission prompt it waits on, then its
// status on each tab (`activityLines`), with what it did on that tab's
// page under it, then its stored values. With no `tab`, only what
// doesn't depend on one: stored values and all its errors. Only
// whether `tab` is there counts: the lines cover every tab.
// The lines under a script are indented to start under its name.
async function statusLines(ctx: ConsoleContext, tab: ControlledTab | undefined): Promise<string[]> {
  const { scripts } = ctx;
  const { reports } = ctx.host;
  const lines: string[] = [];
  lines.push(ui`${S.heading('Scripts')}:`);
  if (scripts.length === 0) lines.push(`  ${NO_SCRIPTS}`);
  for (const script of scripts) {
    const id = script.id;
    lines.push(scriptRow(ctx, script));
    // First under the script, on any tab: the script is stuck until
    // it's answered.
    for (const d of runDialogs(ctx).filter((w) => w.scriptId === id)) {
      lines.push(ui`${DETAIL}*DIALOG* waiting: ${dialogSummary(d)}. Use ${S.cmd(showCommand(ctx, d))} to see how to answer it.`);
    }
    if (!tab) {
      // Errors are the script's, from tabs since closed, so still told.
      const values = await valueCount(ctx, id);
      const errors = reports.errors.filter((r) => r.scriptId === id);
      const counts = [count(values, 'stored value'), count(errors.length, 'error')].filter((c) => !c.startsWith('0 '));
      if (counts.length > 0) lines.push(`${DETAIL}${counts.join(', ')}`);
      const last = errors.at(-1);
      if (last) lines.push(ui`${DETAIL}${S.heading('Last error')}: ${last.message}`);
      continue;
    }
    lines.push(...activityLines(ctx, script, (t) => pageDetails(ctx, t, script)));
    // Stored values are the script's, shared by every tab.
    const values = await valueCount(ctx, id);
    if (values > 0) lines.push(`${DETAIL}${count(values, 'stored value')}`);
  }
  return lines;
}

// A script's errors and warnings from a tab's current page.
function pageReports(ctx: ConsoleContext, tab: ControlledTab, script: PreparedScript): { errors: ErrorReport[]; warnings: WarningRecord[] } {
  const onPage = <T extends { scriptId: string; at: number }>(records: T[]): T[] =>
    fromTab(ctx, tab, records).filter((r) => r.scriptId === script.id && r.at >= tab.link.documentFirstStart());
  return { errors: onPage(ctx.host.reports.errors), warnings: onPage(ctx.host.reports.warnings) };
}

// What a script did on a tab's current page, for under the tab's line:
// its menu command, error and warning counts, then its last error and
// last warning. Only the counts that aren't zero, and no line when none
// is.
function pageDetails(ctx: ConsoleContext, tab: ControlledTab, script: PreparedScript): string[] {
  const id = script.id;
  const { errors, warnings } = pageReports(ctx, tab, script);
  const menus = tabMenuCommands(ctx, tab).filter((r) => r.scriptId === id).length;
  const counts = [count(menus, 'menu command'), count(errors.length, 'error'), count(warnings.length, 'warning')]
    .filter((c) => !c.startsWith('0 '));
  const lastError = errors.at(-1);
  const lastWarning = warnings.at(-1);
  return [
    ...(counts.length > 0 ? [counts.join(', ')] : []),
    // From an iframe, its id where known.
    ...(lastError ? [ui`${S.heading('Last error')}${lastError.frameNumber !== undefined ? ui` (${S.id(`F${lastError.frameNumber}`)})` : ''}: ${lastError.message}`] : []),
    ...(lastWarning ? [ui`${S.heading('Last warning')}: ${lastWarning.message}`] : []),
  ];
}

// How many values a run's script has stored: none to count under
// another manager, which doesn't say.
async function valueCount(ctx: ConsoleContext, id: string | undefined): Promise<number> {
  return id && !ctx.predicted ? Object.keys(await ctx.host.valuesOf(id)).length : 0;
}

// Under a `scriptRow`, lined up with the script's name (`* 1: `) when
// its number is one digit.
const DETAIL = '     ';

// A script's status on each tab where it says something, a line each:
// `T1: Running`, `T2: Not expected (matches page URL, but
// disabled)`, `T3: Running (F7)`. `under` gives more lines about the
// script on that tab, indented under its line.
function activityLines(ctx: ConsoleContext, script: PreparedScript, under: (tab: ControlledTab) => string[] = () => []): string[] {
  return ctx.tabs().flatMap((tab) => {
    const text = tabActivity(ctx, tab, script);
    return text ? [ui`${DETAIL}${S.id(tabName(tab))}: ${text}`, ...under(tab).map((l) => `${DETAIL}  ${l}`)] : [];
  });
}

// An expected script not running on a tab's page, with why when the
// manager said it skipped it there.
function notRunning(ctx: ConsoleContext, tab: ControlledTab, id: string | undefined): string {
  const skipped = skipReason(ctx, tab, id);
  return skipped ? `Not running (skipped: ${skipped})` : 'Not running';
}

// Why the manager skipped a script on a tab's current page, if it did.
function skipReason(ctx: ConsoleContext, tab: ControlledTab, id: string | undefined): string | undefined {
  const { skipped } = id === undefined ? {} : ctx.host.lastStartAndSkip(tab.link, id);
  return skipped && skipped.at >= tab.link.documentFirstStart() ? skipped.reason : undefined;
}

// Where a script stands on a tab, which `tabActivity` and `tabNote`
// both put in words.
interface TabStanding {
  // `@run-at context-menu`: it has no expectation, and runs when its
  // menu is used.
  manual: boolean;
  // Manual, and its menu item can run it there now.
  waiting: boolean;
  // Its rules match the tab's page (its top frame) and it is on.
  expected: boolean;
  // Why not, when its rules match.
  off?: 'disabled' | 'manager-off' | 'noscript';
  // Running in the top frame of the tab's current page, and in any of
  // its frames.
  top: boolean;
  anywhere: boolean;
}

function tabStanding(ctx: ConsoleContext, tab: ControlledTab, script: PreparedScript): TabStanding {
  const id = script.id;
  const top = activeOn(ctx, tab, id);
  const anywhere = activeInTab(ctx, tab, id);
  const manual = isContextMenuRunAt(script.script.header);
  const matches = explainMatch(script.matching, tab.page.url()).matches;
  const off = !matches ? undefined
    : ctx.scriptsOff?.has(script) ? (ctx.scriptsOff.managerOff?.() ? 'manager-off' : 'disabled')
    : tab.noScript ? 'noscript' : undefined;
  return { manual, waiting: waitingOn(ctx, tab, id, anywhere), expected: !manual && matches && !off, off, top, anywhere };
}

// Why a script whose rules match a tab's page isn't expected there.
function offReason(ctx: ConsoleContext, off: NonNullable<TabStanding['off']>): string {
  if (off === 'disabled') return 'matches page URL, but disabled';
  if (off === 'noscript') return 'matches page URL, but the tab has --noscript';
  return `matches page URL, but ${MANAGERS[ctx.managerName ?? DEFAULT_MANAGER].label} is off`;
}

// A script's status on one tab: whether it should be running there,
// then whether it is, with where when not the top frame alone.
//
// None for a script that doesn't match the page and doesn't run there:
// the lists would be mostly those.
function tabActivity(ctx: ConsoleContext, tab: ControlledTab, script: PreparedScript): string | undefined {
  const id = script.id;
  const s = tabStanding(ctx, tab, script);
  // Another manager says nothing of what ran: only what its rules and
  // switches say should.
  if (ctx.predicted) {
    if (s.off) return `Not expected (${offReason(ctx, s.off)})`;
    if (s.manual) return s.anywhere ? MANUAL : undefined;
    // `Expected` goes by the top frame, as `expected` in the JSON does.
    if (s.top) return ui`Expected${framesSuffix(ctx, tab, id)}`;
    return s.anywhere ? ui`Expected in frames${framesSuffix(ctx, tab, id)}` : undefined;
  }
  const running = s.anywhere ? ui`Running${framesSuffix(ctx, tab, id)}` : undefined;
  // A manual script turned off says so, as one that runs on load does,
  // ahead of the menu item its page registered before.
  if (s.manual && s.off) return running ? `Not expected (${offReason(ctx, s.off)}), ${running}` : `Not expected (${offReason(ctx, s.off)})`;
  if (s.waiting) return WAITING_FOR_MENU;
  if (s.manual) return running;
  // Running where expected says it all. Expected in the top frame: a
  // run in an iframe alone doesn't make up for it.
  if (s.expected) return s.top ? running : `Expected, ${notRunning(ctx, tab, id)}${running ? `, ${running}` : ''}`;
  if (s.off) return running ? `Not expected (${offReason(ctx, s.off)}), ${running}` : `Not expected (${offReason(ctx, s.off)})`;
  // Not matching, yet running in the top frame: a pushState moved it away.
  if (s.top) return `Not expected (doesn't match page URL), ${running}`;
  // Only in iframes, whose pages the script matches.
  return running;
}

// A script's status on a tab, short, for `tabs`: only what's amiss.
// `expected but not running`, `not expected: disabled`, `2 errors`.
// Nothing under another manager, which says nothing of what ran.
function tabNote(ctx: ConsoleContext, tab: ControlledTab, script: PreparedScript): string[] {
  if (ctx.predicted) return [];
  const s = tabStanding(ctx, tab, script);
  const notes: string[] = [];
  if (s.expected && !s.top) notes.push('expected but not running');
  // Turned off since the page loaded. A --noscript tab runs none.
  if (s.off === 'disabled' && s.anywhere) notes.push('not expected: disabled');
  if (!s.expected && !s.off && !s.manual && s.top) notes.push("not expected: doesn't match page URL");
  const { errors, warnings } = pageReports(ctx, tab, script);
  return [...notes, ...[count(errors.length, 'error'), count(warnings.length, 'warning')].filter((c) => !c.startsWith('0 '))];
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
  return keys.map((key) => ui`    ${S.code(key)} = ${S.code(shortValue(values[key], VALUES_SHOWN_CHARS))}`);
}

/**
 * `values --out`: a script's values, whole, as the JSON object
 * `--values-file` and `start --values-file` read back.
 */
async function writeValuesFile(ctx: ConsoleContext, cwd: string, given: string, values: Record<string, unknown>, whose = ''): Promise<boolean | void> {
  const count = Object.keys(values).length;
  return writeJsonFile(ctx, cwd, given, values, ui`Wrote ${count} value${count === 1 ? '' : 's'}${whose}`);
}

/** JSON to a file, for `values --out` and `get --out`, then `<done> to <file>` (`done` as markup). */
async function writeJsonFile(ctx: ConsoleContext, cwd: string, given: string, value: unknown, done: string): Promise<boolean | void> {
  const file = path.resolve(cwd, given);
  try {
    await writeFile(file, JSON.stringify(value, null, 2) + '\n');
  } catch (err) {
    ctx.out(`${MISTAKE_PREFIX}Could not write ${quoted(given)}: ${writeProblem(err) ?? errorSentence(err)}`);
    return false;
  }
  ctx.out(`[sm-dev] ${ui`${done} to ${S.url(shownPath(file, cwd))}`}`);
}

// Longer stored values are cut, so a cache a script stores doesn't bury
// the rest of the output: in `GM_setValue` event lines, and less tightly
// in `values`. `get`, `values --out` and JSON output show them whole.
const EVENT_VALUE_SHOWN_CHARS = 100;
const VALUES_SHOWN_CHARS = 1000;

export function shortValue(value: unknown, max = EVENT_VALUE_SHOWN_CHARS): string {
  const json = JSON.stringify(value) ?? String(value);
  if (json.length <= max) return json;
  // By code point, so an emoji isn't cut in half.
  return `${Array.from(json).slice(0, max).join('')}... (${json.length} chars; get shows it all)`;
}

// `E1`: a SourceMonkey-managed script (see `OtherScript`).
const OTHER_LABEL = /^E\d+$/i;

// The SourceMonkey-managed script `label` names, or null having said
// why. Lists the current tab's first if it isn't known yet, so it can
// be named before anything listed it.
async function pickOther(ctx: ConsoleContext, label: string, tab: ControlledTab | undefined): Promise<OtherScript | null> {
  const name = label.toUpperCase();
  if (!ctx.others) {
    ctx.out(`${MISTAKE_PREFIX}${quoted(name)} names a SourceMonkey-managed script, which only a run lists`);
    return null;
  }
  if (!ctx.others.byLabel(name) && tab) {
    try {
      await ctx.others.onTab(tab);
    } catch (err) {
      ctx.out(`[sm-dev] ${othersKind(ctx)} on ${tabName(tab)} could not be listed: ${firstLine(err)}`);
      return null;
    }
  }
  // Not on the tab's page: any installed script can still be picked.
  const found = ctx.others.byLabel(name) ?? await installedOther(ctx, name);
  if (!found) ctx.out(`[sm-dev] ${noSuchScript(name)}`);
  return found;
}

// An installed script anywhere, by its E-id, or null for none.
async function installedOther(ctx: ConsoleContext, label: string): Promise<OtherScript | null> {
  if (!ctx.manager || !ctx.others) return null;
  // A manager that can't list them knows only those on the tab.
  const listed = await Promise.all([ctx.manager.scripts(), ctx.manager.collections()]).catch(() => null);
  if (!listed) return null;
  const [scripts, collections] = listed;
  const script = scripts.find((s) => `E${s.number}` === label);
  if (!script) return null;
  const collection = collections.find((c) => c.id === script.collectionId)?.name ?? '';
  return ctx.others.installed(script.id, label, script.name, collection);
}

// Whether a picked installed script is among those on `tab`'s page.
async function otherOnTab(ctx: ConsoleContext, other: OtherScript, tab: ControlledTab | undefined): Promise<boolean> {
  if (!tab || !ctx.others) return false;
  return (await ctx.others.onTab(tab).catch((): OtherScript[] => [])).includes(other);
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
  NOT_LOADED: 'SourceMonkey script not loaded in sm-dev tab',
  UNTRACKED: 'Unknown: the page loaded before SourceMonkey started',
  // Another manager's, by its match rules (`predicted`).
  EXPECTED: 'Expected using match rules',
};

// `E1: Name (Collection)`, without the parentheses for a script whose
// collection isn't known (one deleted since the page loaded).
function otherLabelUi(o: OtherScript): string {
  return ui`${S.id(o.label)}: ${S.name(o.name)}${o.collection ? ui` (${S.name(o.collection)})` : ''}`;
}

// How the other scripts' list is headed.
function othersKind(ctx: ConsoleContext): string {
  return ctx.others?.kind ?? 'SourceMonkey-managed scripts';
}

// SourceMonkey-managed scripts on `tab`, for `scripts` and `status`, or
// another manager's. None when there are none.
async function otherLines(ctx: ConsoleContext, tab: ControlledTab | undefined): Promise<string[]> {
  if (!ctx.others) return [];
  // With no tab, only the picked one, which is on no page.
  if (!tab) return ctx.currentOther ? [ui`${S.heading(othersKind(ctx))}:`, ui`${selectMark(true)}${otherLabelUi(ctx.currentOther)}: No tab is open`] : [];
  let others: OtherScript[];
  try {
    others = await ctx.others.onTab(tab);
  } catch (err) {
    return [`[sm-dev] ${othersKind(ctx)} on ${tabName(tab)} could not be listed: ${firstLine(err)}`];
  }
  // The picked one, when it isn't on this page.
  const away = ctx.currentOther && !others.includes(ctx.currentOther) ? ctx.currentOther : undefined;
  if (others.length === 0 && !away) return [];
  return [
    ui`${S.heading(othersKind(ctx))} on ${S.id(tabName(tab))}:`,
    // By label: each listing gets the scripts afresh.
    ...others.map((o) => ui`${selectMark(o.label === ctx.currentOther?.label)}${otherLabelUi(o)}: ${OTHER_STATUS[o.status] ?? o.status}`),
    ...(away ? [ui`${selectMark(true)}${otherLabelUi(away)}: Not on this page`] : []),
  ];
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

// The tracker and its helpers are in dialogs.ts; run.ts and the tests
// take them from here too.
export { DialogTracker, dismissSettingUpDialogs, hasUntrackedDialog, leaveDialogsOpen, trackSettingUp } from './dialogs.js';

// A script's `GM_setValue` reaches the worker a message after the page
// makes it, and a menu command's own work may take a moment to get
// there, so a read issued straight after firing one would print what was
// there before it. A short wait is the difference between "fire, then
// read" telling the truth and telling yesterday's truth.
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
  const out = marked?.stderr || (!marked && jsonLogs && line.startsWith(S.SM_DEV_PREFIX)) ? process.stderr : process.stdout;
  if (marked) line = marked.text;
  line = paintOutput(line, streamHasColor(out));
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
 * Runs a command line, resolving to its exit code. `hooks.answer`:
 * where the command's own output goes instead of `ctx.out` (see
 * commandOutput).
 */
export type CommandRunner = (
  line: string,
  hooks?: { start?: () => void; end?: () => void; cwd?: string; words?: string[]; answer?: (line: string) => void; interactive?: boolean; json?: boolean },
) => Promise<number>;

// Commands after which nothing is left to remind about.
const ENDS_RUN = new Set(['exit', 'stop']);

// The fields each running command keeps for itself, so commands
// running at once (see runsBeside) never see each other's.
const OWN_FIELDS = new Set<PropertyKey>(['out', 'json', 'jsonLayout', 'interactive']);

// A command's view of the run's context: its own `OWN_FIELDS`, and the
// rest shared, so a change to the current tab or script still reaches
// the commands after it.
// `frames` is both: a command reads the frames it loaded itself, since
// a listing running beside it may load them without the details it
// needs, and its load also goes to the shared context for the commands
// after it.
function commandContext(shared: ConsoleContext): ConsoleContext {
  const own: Record<PropertyKey, unknown> = { out: shared.out };
  return new Proxy(shared, {
    get: (target, key) => {
      if (OWN_FIELDS.has(key)) return own[key];
      if (key === 'frames') return own.frames ?? target.frames;
      return Reflect.get(target, key);
    },
    set: (target, key, value) => {
      if (OWN_FIELDS.has(key)) own[key] = value;
      else {
        if (key === 'frames') own.frames = value;
        Reflect.set(target, key, value);
      }
      return true;
    },
  });
}

/**
 * Says that `command` ran past its limit (see command-limit.ts). With
 * `stopPages`, it also stops the JavaScript of any page stuck in it,
 * which is likely what the command waits on, and would hold up the
 * next one too. A command that never reaches into a page (one that
 * runs beside the queue) leaves the pages alone, since what runs there
 * may be another command's.
 */
async function overLimit(ctx: ConsoleContext, command: string, limitMs: number, stopPages: boolean, say: (line: string) => void): Promise<void> {
  say(`[sm-dev] ${errorLine(`The ${quoted(command)} command did not finish within ${seconds(limitMs)}. The run stopped waiting for it.`)}`);
  // A page showing a dialog doesn't answer either, but isn't running
  // anything: the dialog is said elsewhere.
  const tabs = stopPages ? ctx.tabs().filter((t) => !t.dialogs?.current) : [];
  const busy = (await Promise.all(tabs.map(async (t) => (await pageBusy(t.page) ? t : null)))).filter((t) => t !== null);
  for (const tab of busy) {
    say(await stopPageScript(tab.link)
      ? `[sm-dev] ${ui`${S.id(tabName(tab))}'s page didn't answer for 3 seconds. sm-dev stopped the JavaScript running there.`}`
      : `[sm-dev] ${ui`${S.id(tabName(tab))}'s page didn't answer for 3 seconds, and sm-dev could not stop the JavaScript running there`}`);
  }
  if (tabs.length > 0 && busy.length === 0) {
    say('[sm-dev] No page is busy running JavaScript. The command is waiting for something else that hasn\'t finished, such as a promise or a request.');
  }
  say(`[sm-dev] Use ${quoted(TIMEOUT_FLAG)} to give it longer`);
}

/**
 * Runs commands against `shared`. `limitMs`: each command's limit when
 * it isn't given `--timeout-seconds`, shorter in tests.
 */
export function commandRunner(shared: ConsoleContext, { limitMs }: { limitMs?: number } = {}): CommandRunner {
  // The commands that take turns, each after the one before.
  let queue: Promise<unknown> = Promise.resolve();
  return (line, hooks) => {
    const ctx = commandContext(shared);
    // The exit code: 2 when it said it was invalid, wherever in it
    // that was said; else what the command returned (a number, or false
    // for 1); else 0. A throw is 2 for an invalid command (a file that
    // isn't there), 1 otherwise.
    let code = 0;
    const typed = line.trim().split(/\s+/)[0];
    const command = RUN_ALIASES[typed] ?? typed;
    const beside = runsBeside(line);
    // `--timeout-seconds`: the longest the whole command may take.
    const given = givenTimeoutMs(line);
    const limit = commandLimitMs(command, given, limitMs);
    const run = async (): Promise<void> => {
      let mistaken = false;
      // Past its limit, the command's work runs on, but what it prints
      // after that is dropped.
      let abandoned = false;
      const out = ctx.out;
      // In JSON mode, the command's other lines (a note beside its
      // result, or its failure in place of one) go to stderr as text.
      ctx.json = hasJsonForm(line) ? hooks?.json === true : undefined;
      const print = (l: string): void => {
        if (!ctx.json) out(l);
        else if (isJsonLine(l)) out(ctx.jsonLayout ? withLayout(l, ctx.jsonLayout) : l);
        else out(STDERR_LINE + l);
      };
      const said: string[] = [];
      ctx.out = (l) => {
        if (abandoned) return;
        said.push(l);
        if (l.startsWith(MISTAKE_PREFIX)) mistaken = true;
        print(l);
      };
      // A JavaScript dialog whose close went unseen isn't waiting. Not
      // for a command that answers one, which finds out for itself, so
      // it doesn't wait on the check.
      if (!ANSWERS_DIALOG.test(line)) await Promise.all(runTrackers(ctx).map((t) => t.verify()));
      const before = waitingState(ctx);
      try {
        // Typed at a person's prompt, `menu` needn't wait for a command
        // still to register: the person can see what there is.
        ctx.interactive = hooks?.interactive === true;
        setRunningCommand(line);
        // Its waits keep to that time, counted from its turn.
        const work = inBudget(deadlineIn(given), () => runConsoleCommand(line, ctx, { cwd: hooks?.cwd, words: hooks?.words }));
        const result = await (limit === null ? work : within(work, limit)).finally(() => setRunningCommand(undefined));
        if (result === 'timeout') {
          abandoned = true;
          work.catch(() => undefined);
          await overLimit(ctx, command, given ?? limit!, !beside, print);
          code = 1;
          return;
        }
        // Not after a command that ends the run, nor a line saying the
        // same thing already (a command refused for an open dialog).
        if (!ENDS_RUN.has(typed)) {
          for (const reminder of waitingReminders(ctx, before, said)) ctx.out(reminder);
        }
        code = result === false ? 1 : typeof result === 'number' ? result : 0;
        // An invalid command is 2, even when it also said it failed.
        if (mistaken) code = 2;
      } catch (err) {
        // A failure, apart from a mistake in the command: in error color too.
        ctx.out(err instanceof UsageError ? `${MISTAKE_PREFIX}${(err as Error).message}` : `[sm-dev] ${errorLine((err as Error).message)}`);
        code = err instanceof UsageError ? 2 : 1;
      } finally {
        // What the command started that prints after it ends goes out
        // plainly, as the page's own lines do, unless it was abandoned.
        ctx.json = undefined;
        ctx.jsonLayout = undefined;
        ctx.out = abandoned ? () => undefined : out;
      }
    };
    const done = (beside ? Promise.resolve() : queue).then(async () => {
      hooks?.start?.();
      const output = hooks?.answer && { line: hooks.answer, live: true };
      // Where this command began, for the next `wait log`. Not for one
      // that only looks or waits, or an empty line (a message's turn):
      // what the command before it set off still counts.
      const began = shared.logs?.position();
      try {
        await inCommand.run({ inspects: onlyInspects(line) }, () => (output ? commandOutput.run(output, run) : run()));
      } finally {
        if (output) output.live = false;
        if (typed && typed !== 'wait' && !onlyInspects(line)) shared.previousStart = began;
        hooks?.end?.();
      }
    });
    if (!beside) queue = done;
    return done.then(() => code);
  };
}

/**
 * Whether dialogs wait for a `dialog` command, rather than being
 * dismissed in a headless run. On while commands are read.
 */
export function setCommandsListening(tabs: ControlledTab[], listening: boolean): void {
  setTrackersListening(tabs.map((t) => t.dialogs), listening);
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

/** The prompt's first line, after the line's own commands have run. */
export const PROMPT_READY = '[sm-dev] Ready for commands. Use `help commands` to list them.';

/**
 * The prompt's first lines when the line gave no commands: no run yet,
 * so how to start one.
 */
export const PROMPT_STARTED = [
  '[sm-dev] Interactive session started. Use `start [script] [url]` to launch a browser.',
  '[sm-dev] Other suggested commands: `status`, `help`, or `help commands`.',
];

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
export function readPromptCommands(
  io: PromptIO, runLine: (line: string, hooks?: { start?: () => void }) => Promise<unknown>, greeting = [PROMPT_READY],
): () => void {
  for (const line of greeting) io.out(line);
  // A dumb terminal can't move the cursor, so writeOutputLine couldn't
  // redraw around a prompt there.
  const terminal = Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
  const blocks = new CommandAssembler();
  // Set once the prompt is closed on purpose, rather than by Ctrl-D.
  let closing = false;
  // A message in the commands' turn, after the ones before it. The
  // empty line runs nothing.
  const say = (message: string): void => {
    void runLine('', { start: () => io.out(`${MISTAKE_PREFIX}${message}`) });
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
  // The prompts and typed commands in color, apart from the output.
  const paint = streamHasColor(process.stdout) ? { prompt: (t: string) => paintAs('prompt', t), text: (t: string) => paintAs('typed', t) } : undefined;
  const editor = terminal ? editMultiLine(lines, BLOCK_PROMPT, endsOutsideBlock, (text) => {
    if (text.includes('\n') && !history.includes(text)) remember(text);
  }, paint) : null;
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
