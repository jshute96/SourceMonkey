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

const HELP = [
  'menu [label]      fire a registered menu command; with no label, list them',
  'values            print everything the script has stored',
  'get <key>         print one stored value',
  'set <key> <json>  store a value, as another tab\'s write would',
  'use [script]      pick the script values/get/set act on (path, file name or @name); with none, list them',
  'reload            reload the page',
  'open <url>        navigate to another page',
  'help              this list',
  'quit              stop the run',
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
      for (const l of HELP) ctx.out(`  ${l}`);
      return;
    case 'quit':
    case 'exit':
      ctx.stop();
      return;
    case 'menu': {
      const commands = ctx.host.reports.menuCommands;
      if (!argument) {
        if (commands.length === 0) ctx.out('[sm-dev] no menu commands are registered');
        for (const c of commands) ctx.out(`  ${c.name}`);
        return;
      }
      // Waits for the command rather than reporting a miss at once: a
      // script registers on load, and a line typed (or piped) a moment
      // early should still land.
      const fired = await waitForMenuCommand(ctx, argument);
      ctx.out(fired
        ? `[sm-dev] fired "${argument}"`
        : `[sm-dev] no menu command named "${argument}" is registered`);
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
        ctx.out(`[sm-dev] no loaded script is named ${argument}; type use to list them`);
        return;
      }
      ctx.current = found;
      ctx.out(`[sm-dev] using ${preparedScriptName(found)}`);
      return;
    }
    case 'values': {
      if (!scriptId) {
        ctx.out('[sm-dev] no script is loaded');
        return;
      }
      await settleWrites();
      const values = ctx.host.getValues(scriptId);
      const keys = Object.keys(values);
      if (keys.length === 0) ctx.out(`[sm-dev] the script${whose} has stored nothing`);
      for (const key of keys) ctx.out(`  ${key} = ${JSON.stringify(values[key])}`);
      return;
    }
    case 'get': {
      if (!scriptId) {
        ctx.out('[sm-dev] no script is loaded');
        return;
      }
      if (!argument) {
        ctx.out('[sm-dev] get needs a key');
        return;
      }
      await settleWrites();
      ctx.out(`  ${argument} = ${JSON.stringify(ctx.host.getValue(scriptId, argument))}`);
      return;
    }
    case 'set': {
      if (!scriptId) {
        ctx.out('[sm-dev] no script is loaded');
        return;
      }
      const key = rest[0];
      const raw = argument.slice(key?.length ?? 0).trim();
      if (!key || !raw) {
        ctx.out('[sm-dev] set needs a key and a JSON value, e.g. set units "metric"');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        ctx.out(`[sm-dev] ${raw} is not JSON; a string needs quotes`);
        return;
      }
      // Through the host, so a running script sees it on its next read
      // and its value-change listeners fire, as another tab's write
      // would.
      await ctx.host.setValues(scriptId, { [key]: value });
      ctx.out(`[sm-dev] set ${key}${whose}`);
      return;
    }
    case 'reload':
      await ctx.page.reload().catch((err) => ctx.out(`[sm-dev] reload failed: ${(err as Error).message}`));
      return;
    case 'open': {
      if (!argument) {
        ctx.out('[sm-dev] open needs a URL');
        return;
      }
      await ctx.page.goto(argument).catch((err) => ctx.out(`[sm-dev] navigation failed: ${(err as Error).message}`));
      return;
    }
    default:
      ctx.out(`[sm-dev] ${command} is not a command; type help`);
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

/**
 * Read commands from stdin, one per line, for as long as the run lasts.
 * Whole lines only, so a piped command split across two reads still
 * runs as one. Does nothing when stdin is already closed.
 */
export function readConsoleCommands(ctx: ConsoleContext): () => void {
  if (!process.stdin.readable) return () => undefined;
  let queue: Promise<void> = Promise.resolve();
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  lines.on('line', (line) => {
    // Serialized: two lines typed quickly must not interleave.
    queue = queue.then(() => runConsoleCommand(line, ctx)).catch((err) => {
      ctx.out(`[sm-dev] ${(err as Error).message}`);
    });
  });
  return () => {
    lines.close();
    process.stdin.pause();
  };
}
