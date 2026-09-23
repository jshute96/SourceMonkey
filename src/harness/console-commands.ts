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

import type { HarnessHost, MenuCommandRecord } from './host.js';
import { preparedScriptMatches, preparedScriptName, withDefaultScheme, type PreparedScript } from './prepare.js';

export interface ConsoleContext {
  host: HarnessHost;
  page: Page;
  /** The scripts this run injected, in load order. */
  scripts: PreparedScript[];
  /**
   * The script `get` and `set` act on. Starts as the first; `use`
   * changes it.
   */
  current?: PreparedScript;
  /**
   * Typed at a terminal prompt, rather than piped. A person can see
   * what is registered, so `menu` never waits for a late one.
   */
  interactive?: boolean;
  /** The page's JavaScript dialogs, for `accept` and `dismiss`. */
  dialogs?: DialogTracker;
  out: (line: string) => void;
  /** Ends the run, as Ctrl-C does. */
  stop: () => void;
}

// Grouped as `help` prints them. Also the "Interactive commands" part
// of `sm-dev --help`, so the two lists can't drift apart.
const COMMAND_GROUPS: { title: string; lines: string[] }[] = [
  {
    title: 'Scripts',
    lines: [
      'use [script]      List the loaded scripts; with one, pick the script',
      '                  get and set act on',
      'status            Show the page\'s URL and status for each script',
    ],
  },
  {
    title: 'Menu commands',
    lines: [
      'menu [n|label]    List the registered menu commands; with a number',
      '                  from that list or a label, fire one',
    ],
  },
  {
    title: 'Stored values',
    lines: [
      'values [script]   Print what every script has stored, or one script',
      'get <key>         Print one stored value',
      'set <key> <json>  Store a value, as another tab\'s write would',
    ],
  },
  {
    title: 'The page',
    lines: [
      'reload            Reload the page',
      'open <url>        Navigate to another page',
      'focus             Bring the tab to the front',
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

export const CONSOLE_HELP = [
  ...COMMAND_GROUPS.flatMap((group) => [`${group.title}:`, ...group.lines.map((line) => `  ${line}`)]),
  'A script is named by its number in the use list, or by part of its',
  'name or path.',
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
  // An open dialog blocks the page's JavaScript, so a command that
  // reaches into the page would wait on it, and hold up the accept or
  // dismiss typed after it.
  const blockedByDialog = (): boolean => {
    const dialog = ctx.dialogs?.current;
    if (!dialog) return false;
    ctx.out(`[sm-dev] The page is waiting on ${dialogKind(dialog)} dialog. Type accept or dismiss first.`);
    return true;
  };

  switch (command) {
    case 'help':
    case '?':
      if (!takesNothing()) return;
      for (const l of CONSOLE_HELP) ctx.out(`  ${l}`);
      return;
    case 'quit':
    case 'exit':
      if (!takesNothing()) return;
      ctx.stop();
      return;
    case 'menu': {
      if (!argument) {
        const groups = menuGroups(ctx);
        if (groups.length === 0) {
          ctx.out('[sm-dev] No menu commands are registered');
          return;
        }
        ctx.out('Menu commands:');
        let n = 0;
        for (const group of groups) {
          ctx.out(group.label);
          for (const c of group.commands) ctx.out(`    ${++n}: ${c.name}`);
        }
        return;
      }
      if (blockedByDialog()) return;
      await fireMenu(ctx, argument);
      return;
    }
    case 'use': {
      if (!argument) {
        ctx.out('Loaded scripts:');
        for (const script of ctx.scripts) ctx.out(scriptRow(ctx, script));
        return;
      }
      const found = pickScript(ctx, argument);
      if (!found) return;
      ctx.current = found;
      ctx.out(`[sm-dev] Using ${scriptLabel(found)} for get and set`);
      return;
    }
    case 'status':
      if (!takesNothing()) return;
      printStatus(ctx);
      return;
    case 'values': {
      const scripts = argument ? [pickScript(ctx, argument)] : ctx.scripts;
      if (scripts[0] === null) return;
      if (scripts.length === 0) {
        ctx.out('[sm-dev] No script is loaded');
        return;
      }
      await settleWrites();
      ctx.out('Stored values:');
      for (const script of scripts as PreparedScript[]) {
        ctx.out(scriptRow(ctx, script));
        const id = script.spec?.id;
        const values = id ? ctx.host.getValues(id) : {};
        const keys = Object.keys(values);
        if (keys.length === 0) ctx.out('    Nothing stored');
        for (const key of keys) ctx.out(`    ${key} = ${JSON.stringify(values[key])}`);
      }
      return;
    }
    case 'get': {
      if (!scriptId) {
        ctx.out('[sm-dev] No script is loaded');
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
        ctx.out('[sm-dev] No script is loaded');
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
      if (blockedByDialog()) return;
      // Through the host, so a running script sees it on its next read
      // and its value-change listeners fire, as another tab's write
      // would.
      await ctx.host.setValues(scriptId, { [key]: value });
      ctx.out(`[sm-dev] Set ${key}${whose}`);
      return;
    }
    case 'reload':
      if (!takesNothing() || blockedByDialog()) return;
      await ctx.page.reload().catch((err) => ctx.out(`[sm-dev] Reload failed: ${(err as Error).message}`));
      return;
    case 'open': {
      if (!argument) {
        ctx.out('[sm-dev] The open command needs a URL');
        return;
      }
      if (rest.length > 1) {
        ctx.out('[sm-dev] The open command takes one URL');
        return;
      }
      if (blockedByDialog()) return;
      await ctx.page.goto(withDefaultScheme(argument))
        .catch((err) => ctx.out(`[sm-dev] Navigation failed: ${(err as Error).message}`));
      return;
    }
    case 'focus':
      if (!takesNothing()) return;
      await focusTab(ctx.page)
        .then(() => ctx.out('[sm-dev] Brought the tab to the front'))
        .catch((err) => ctx.out(`[sm-dev] Could not bring the tab to the front: ${(err as Error).message}`));
      return;
    case 'accept':
    case 'dismiss': {
      if (command === 'dismiss' && !takesNothing()) return;
      const dialog = ctx.dialogs?.take();
      if (!dialog) {
        ctx.out('[sm-dev] No dialog is open');
        return;
      }
      if (argument && dialog.type() !== 'prompt') {
        ctx.out(`[sm-dev] Only a prompt dialog takes text. This one is ${dialogKind(dialog)}.`);
        ctx.dialogs!.putBack(dialog);
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

// One script's row in any list of them: its number in the `use` list,
// with `*` on the one `get` and `set` act on.
function scriptRow(ctx: ConsoleContext, script: PreparedScript): string {
  const current = ctx.current ?? ctx.scripts[0];
  return `${script === current ? '* ' : '  '}${ctx.scripts.indexOf(script) + 1}: ${scriptLabel(script)}`;
}

/**
 * The script a typed argument names: its number in the `use` list, an
 * exact path, file name or `@name`, or else a piece of its name or path
 * that no other loaded script shares. Reports why and returns null when
 * there is no single answer.
 */
function pickScript(ctx: ConsoleContext, arg: string): PreparedScript | null {
  if (/^\d+$/.test(arg)) {
    const script = ctx.scripts[Number(arg) - 1];
    if (!script) ctx.out(`[sm-dev] There is no script ${arg}. Type use to list them.`);
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
    ctx.out(`[sm-dev] No loaded script matches ${arg}. Type use to list them.`);
  } else {
    const numbers = hits.map((script) => ctx.scripts.indexOf(script) + 1).join(', ');
    ctx.out(`[sm-dev] Several loaded scripts match ${arg} (${numbers}). Name one by its number.`);
  }
  return null;
}

// The registered menu commands under the script that registered each,
// in load order. The numbers `menu` prints count through this, so
// firing by number reads the same order.
function menuGroups(ctx: ConsoleContext): { label: string; commands: MenuCommandRecord[] }[] {
  const all = ctx.host.reports.menuCommands;
  return ctx.scripts
    .map((script) => ({
      label: scriptRow(ctx, script),
      commands: all.filter((c) => c.scriptId === script.spec?.id),
    }))
    .filter((group) => group.commands.length > 0);
}

// A script registers its commands as it starts, and commands are only
// read once one has started. So for piped input, a miss while nothing
// is registered yet may just be early, and is worth waiting out. A
// miss while others are registered is a wrong name, and is reported at
// once, as is any miss typed at a terminal.
const MENU_WAIT_MS = 5000;

async function fireMenu(ctx: ConsoleContext, argument: string): Promise<void> {
  const all = (): MenuCommandRecord[] => menuGroups(ctx).flatMap((group) => group.commands);
  const deadline = Date.now() + MENU_WAIT_MS;
  for (;;) {
    const commands = all();
    // A label wins over a number, for a command whose label is one.
    const byName = [...commands].reverse().find((c) => c.name === argument);
    const byNumber = /^\d+$/.test(argument) ? commands[Number(argument) - 1] : undefined;
    const entry = byName ?? byNumber;
    if (entry) {
      // Listed but not fired: the page that registered it is going
      // away, as in the middle of a navigation.
      ctx.out(await fire(ctx, entry)
        ? `[sm-dev] Fired "${entry.name}"`
        : `[sm-dev] The menu command "${entry.name}" could not be fired, since the page that registered it has gone away`);
      return;
    }
    if (ctx.interactive || commands.length > 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (all().length === 0) ctx.out('[sm-dev] No menu commands are registered');
  else if (/^\d+$/.test(argument)) ctx.out(`[sm-dev] There is no menu command ${argument}. Type menu to list them.`);
  else ctx.out(`[sm-dev] No menu command named "${argument}" is registered. Type menu to list them.`);
}

// Counts as done once a dialog the command opens is up, so `accept`
// can be typed.
function fire(ctx: ConsoleContext, entry: MenuCommandRecord): Promise<boolean> {
  const fired = ctx.host.fireMenuCommand(entry.commandId, entry.scriptId);
  return ctx.dialogs ? ctx.dialogs.untilDialog(fired) : fired;
}

function printStatus(ctx: ConsoleContext): void {
  const { reports } = ctx.host;
  ctx.out(`Page: ${ctx.page.url()}`);
  const dialog = ctx.dialogs?.current;
  if (dialog) ctx.out(`Waiting on ${dialogKind(dialog)} dialog: ${JSON.stringify(dialog.message())}`);
  ctx.out('Scripts:');
  ctx.scripts.forEach((script) => {
    const id = script.spec?.id;
    ctx.out(scriptRow(ctx, script));
    // The newer of its last start and last skip says where it stands.
    const started = reports.started.filter((r) => r.scriptId === id).at(-1);
    const skipped = reports.skipped.filter((r) => r.scriptId === id).at(-1);
    if (skipped && (!started || skipped.at > started.at)) ctx.out(`    Skipped on ${skipped.url}: ${skipped.reason}`);
    else if (started) ctx.out(`    Started on ${started.url}`);
    else ctx.out('    Not started');
    const errors = reports.errors.filter((r) => r.scriptId === id);
    const menus = reports.menuCommands.filter((r) => r.scriptId === id).length;
    const values = id ? Object.keys(ctx.host.getValues(id)).length : 0;
    // Only the counts that aren't zero, and no line when none is.
    const counts = [count(menus, 'menu command'), count(values, 'stored value'), count(errors.length, 'error')]
      .filter((c) => !c.startsWith('0 '));
    if (counts.length > 0) ctx.out(`    ${counts.join(', ')}`);
    const last = errors.at(-1);
    if (last) ctx.out(`    Last error: ${last.message}`);
  });
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

const COMMAND_NAMES = COMMAND_GROUPS
  .flatMap((group) => group.lines)
  .map((line) => line.split(/\s+/)[0])
  .filter(Boolean);

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
export function readConsoleCommands(ctx: ConsoleContext): () => void {
  if (!process.stdin.readable) return () => undefined;
  if (ctx.dialogs) ctx.dialogs.commandsListening = true;
  // Otherwise nothing says the run is listening at all.
  ctx.out('[sm-dev] Ready for commands. Type help to list them.');
  // A dumb terminal can't move the cursor, so writeOutputLine couldn't
  // redraw around a prompt there.
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== 'dumb';
  ctx.interactive = terminal;
  let queue: Promise<void> = Promise.resolve();
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
    // Serialized: two lines typed quickly must not interleave.
    queue = queue.then(() => runConsoleCommand(line, ctx)).catch((err) => {
      ctx.out(`[sm-dev] ${(err as Error).message}`);
    });
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
    if (ctx.dialogs) ctx.dialogs.commandsListening = false;
    dropPrompt();
    lines.close();
    process.stdin.pause();
  };
}
