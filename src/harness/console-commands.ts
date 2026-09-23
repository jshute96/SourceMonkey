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

import type { Page } from '@playwright/test';

import type { HarnessHost } from './host.js';
import { preparedScriptMatches, preparedScriptName, type PreparedScript } from './prepare.js';

export interface ConsoleContext {
  host: HarnessHost;
  page: Page;
  /** The scripts this run injected, in load order. */
  scripts: PreparedScript[];
  /**
   * The script `values`, `get` and `set` act on. Starts as the first;
   * `use` changes it.
   */
  current?: PreparedScript;
  out: (line: string) => void;
  /** Ends the run, as Ctrl-C does. */
  stop: () => void;
}

// Also the "Interactive commands" part of `sm-dev --help`, so the two
// lists can't drift apart.
export const CONSOLE_HELP = [
  'menu [label]      Fire a registered menu command; with no label, list them',
  'values            Print everything the script has stored',
  'get <key>         Print one stored value',
  'set <key> <json>  Store a value, as another tab\'s write would',
  'use [script]      Pick the script values/get/set act on (path, file name',
  '                  or @name); with none, list them',
  'reload            Reload the page',
  'open <url>        Navigate to another page',
  'help              List these',
  'quit              Stop the run',
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

  switch (command) {
    case 'help':
    case '?':
      for (const l of CONSOLE_HELP) ctx.out(`  ${l}`);
      return;
    case 'quit':
    case 'exit':
      ctx.stop();
      return;
    case 'menu': {
      const commands = ctx.host.reports.menuCommands;
      if (!argument) {
        if (commands.length === 0) ctx.out('[sm-dev] No menu commands are registered');
        for (const c of commands) ctx.out(`  ${c.name}`);
        return;
      }
      // Waits for the command rather than reporting a miss at once: a
      // script registers on load, and a line typed (or piped) a moment
      // early should still land.
      const fired = await waitForMenuCommand(ctx, argument);
      ctx.out(fired
        ? `[sm-dev] Fired "${argument}"`
        : `[sm-dev] No menu command named "${argument}" is registered`);
      return;
    }
    case 'use': {
      if (!argument) {
        for (const script of ctx.scripts) {
          const name = preparedScriptName(script);
          const where = name === script.script.relativePath ? '' : `  ${script.script.relativePath}`;
          ctx.out(`${script === current ? '* ' : '  '}${name}${where}`);
        }
        return;
      }
      const found = ctx.scripts.find((script) => preparedScriptMatches(script, argument));
      if (!found) {
        ctx.out(`[sm-dev] No loaded script is named ${argument}. Type use to list them.`);
        return;
      }
      ctx.current = found;
      ctx.out(`[sm-dev] Using ${preparedScriptName(found)}`);
      return;
    }
    case 'values': {
      if (!scriptId) {
        ctx.out('[sm-dev] No script is loaded');
        return;
      }
      await settleWrites();
      const values = ctx.host.getValues(scriptId);
      const keys = Object.keys(values);
      if (keys.length === 0) ctx.out(`[sm-dev] The script${whose} has stored nothing`);
      for (const key of keys) ctx.out(`  ${key} = ${JSON.stringify(values[key])}`);
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
      // Through the host, so a running script sees it on its next read
      // and its value-change listeners fire, as another tab's write
      // would.
      await ctx.host.setValues(scriptId, { [key]: value });
      ctx.out(`[sm-dev] Set ${key}${whose}`);
      return;
    }
    case 'reload':
      await ctx.page.reload().catch((err) => ctx.out(`[sm-dev] Reload failed: ${(err as Error).message}`));
      return;
    case 'open': {
      if (!argument) {
        ctx.out('[sm-dev] The open command needs a URL');
        return;
      }
      await ctx.page.goto(argument).catch((err) => ctx.out(`[sm-dev] Navigation failed: ${(err as Error).message}`));
      return;
    }
    default:
      ctx.out(`[sm-dev] ${command} is not a command. Type help to list them.`);
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

const MENU_WAIT_MS = 5000;

async function waitForMenuCommand(ctx: ConsoleContext, label: string): Promise<boolean> {
  const deadline = Date.now() + MENU_WAIT_MS;
  for (;;) {
    if (await ctx.host.fireMenuCommand(label)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const COMMAND_NAMES = CONSOLE_HELP
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
 * empty one it or Ctrl-D stops the run. Piped input gets neither: EOF on a pipe
 * only means no more commands, and the run goes on.
 */
export function readConsoleCommands(ctx: ConsoleContext): () => void {
  if (!process.stdin.readable) return () => undefined;
  // A dumb terminal can't move the cursor, so writeOutputLine couldn't
  // redraw around a prompt there.
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== 'dumb';
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
    dropPrompt();
    lines.close();
    process.stdin.pause();
  };
}
