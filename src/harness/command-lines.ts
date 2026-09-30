// Turning lines of input into `sm-dev start` commands, for the prompt,
// piped input, and a list of commands sent in one go.
//
// Most commands are one line. `eval` (its JavaScript), `set` (its
// JSON), `type` (its text) and `cdp` (one call per line) can take
// several, as a block:
//
//   eval T2 --script {{
//   const rows = [...document.querySelectorAll('.athing')];
//   rows.map((r) => r.id)
//   }}
//
// `{{` ending the first line opens the block, and a line that is just
// `}}` closes it. Not `{` / `}`: a line holding only `}` ends any
// JavaScript function or JSON object, so it would close the block
// early, where one holding only `}}` almost never appears.
//
// Outside a block, blank lines are skipped and a line starting with `#`
// is a comment (no command starts with `#`). Inside one, every line is
// the block's own.

import { splitWords } from './command-args.js';
import { ALIASES, COMMAND_NAMES, commandSyntax } from './command-list.js';

/** One command, ready for `runConsoleCommand`. */
export interface AssembledCommand {
  /**
   * The command as `runConsoleCommand` takes it. For a block, its first
   * line without the `{{`, then the block's lines after a newline.
   */
  text: string;
  /** The lines it was written as, `{{` and `}}` included, for echoing. */
  source: string[];
  /** The line number (from 1) it started on. */
  line: number;
}

const OPEN = '{{';
const CLOSE = '}}';

// The commands that take a block, as their syntax says.
const BLOCK_COMMANDS = new Set(COMMAND_NAMES.filter((name) => commandSyntax(name).base.block).sort());

/**
 * A `{{` after a command that takes no block. Its lines up to `}}` are
 * skipped, not run one by one as commands.
 */
export const NOT_A_BLOCK_COMMAND = `Only the ${listed([...BLOCK_COMMANDS])} commands take a {{ block, so its lines up to }} are skipped`;

/**
 * A `}}` line with more after it (`}} --nowait`). Only a line of just
 * `}}` closes a block, so the line would otherwise be taken as the
 * block's, leaving it open. Not `}});` or `}},`, which end JavaScript
 * calls and JSON objects: only words after a space.
 */
export const TEXT_AFTER_CLOSE = 'Nothing can follow }} on its line, so the block is dropped (put flags before the {{)';
const CLOSE_WITH_TEXT = /^}}\s+\S/;

/**
 * A `{{` with code after it on its line (`eval {{ const x = 1`). The
 * block's lines would otherwise each run as a command.
 */
export const OPEN_NOT_LAST = 'A {{ block\'s content starts on the line after the {{, and its }} goes on a line of its own';

// `a, b and c`.
function listed(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A block the input ended inside of. */
export function unclosedBlockMessage(line: number): string {
  return `The {{ block on line ${line} has no }} line to end it`;
}

/**
 * Collects lines into commands, one line at a time: each line gives a
 * command, nothing (a blank, a comment, or a line inside a block), or
 * an error for a line that can't be taken.
 */
export class CommandAssembler {
  private block: AssembledCommand | null = null;
  // The block was refused, and its lines are being skipped.
  private refused = false;
  private body: string[] = [];
  private count = 0;

  /** Whether a block is open, waiting for its `}}`. */
  get open(): boolean {
    return this.block !== null;
  }

  push(raw: string): { command: AssembledCommand } | { error: string } | null {
    const line = raw.replace(/\r$/, '');
    const n = ++this.count;
    const trimmed = line.trim();
    if (this.block) {
      if (CLOSE_WITH_TEXT.test(trimmed)) {
        this.drop();
        return { error: TEXT_AFTER_CLOSE };
      }
      if (trimmed !== CLOSE) {
        this.block.source.push(line);
        this.body.push(line);
        return null;
      }
      const command = this.block;
      command.source.push(line);
      if (this.refused) {
        this.drop();
        return null;
      }
      // The block keeps its own line breaks, so `//` comments and
      // statements without semicolons read as they were written.
      // Even blank lines are content: `type` types them.
      if (this.body.length > 0) command.text += '\n' + this.body.join('\n');
      this.block = null;
      this.body = [];
      return { command };
    }
    if (!trimmed || trimmed.startsWith('#')) return null;
    const words = trimmed.split(/\s+/);
    if (words.length > 1 && words.at(-1) === OPEN) {
      this.block = { text: trimmed.slice(0, -OPEN.length).trimEnd(), source: [line], line: n };
      this.refused = !BLOCK_COMMANDS.has(ALIASES[words[0]] ?? words[0]);
      return this.refused ? { error: NOT_A_BLOCK_COMMAND } : null;
    }
    // Not where the text may hold the word (type's). Split as a
    // command's words are, so a {{ in a quoted string is left alone.
    const name = ALIASES[words[0]] ?? words[0];
    if (BLOCK_COMMANDS.has(name) && !commandSyntax(name).base.bracesInText && splitWords(trimmed).slice(1, -1).some((w) => w.text === OPEN)) {
      return { error: OPEN_NOT_LAST };
    }
    return { command: { text: trimmed, source: [line], line: n } };
  }

  /**
   * Drops an open block, returning the line it started on, or null when
   * none was open.
   */
  drop(): number | null {
    const start = this.block?.line ?? null;
    this.block = null;
    this.body = [];
    this.refused = false;
    return start;
  }
}

export const NONE_RUN = 'None of the commands were run.';

/**
 * A whole list of commands, as sent in one go or read from a file.
 * Checked in full before any runs, so a mistake anywhere in it (a `{{`
 * after the wrong command, a block never closed) runs none of it
 * rather than half.
 */
export function parseCommandList(text: string): { commands: AssembledCommand[] } | { error: string } {
  const assembler = new CommandAssembler();
  const commands: AssembledCommand[] = [];
  const lines = text.split('\n');
  // A final newline doesn't start another line.
  if (lines.at(-1) === '') lines.pop();
  for (const [i, line] of lines.entries()) {
    const got = assembler.push(line);
    if (got && 'error' in got) return { error: `Line ${i + 1}: ${got.error}. ${NONE_RUN}` };
    if (got) commands.push(got.command);
  }
  const unclosed = assembler.drop();
  if (unclosed !== null) return { error: `${unclosedBlockMessage(unclosed)}. ${NONE_RUN}` };
  return { commands };
}

/**
 * A command as it was written, for heading its output: `> ` before the
 * first line and `... ` before the rest, as the prompt shows them.
 */
export function echoCommand(command: AssembledCommand): string[] {
  return command.source.map((line, i) => `${i === 0 ? '> ' : '... '}${i === 0 ? line.trim() : line}`);
}

/** A word as a shell would need it written, for echoing a command. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}
