// Turning lines of input into `sm-dev run` commands, for the prompt,
// piped input, and a list of commands sent in one go.
//
// Most commands are one line. `eval` can take several, as a block:
//
//   eval T2 --script {{
//   const rows = [...document.querySelectorAll('.athing')];
//   rows.map((r) => r.id)
//   }}
//
// `{{` ending the first line opens the block, and a line that is just
// `}}` closes it. Not `{` / `}`: a line holding only `}` ends any
// JavaScript function, so it would close the block early, where one
// holding only `}}` almost never appears.
//
// Outside a block, blank lines are skipped and a line starting with `#`
// is a comment (no command starts with `#`). Inside one, every line is
// the JavaScript's own.

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

/**
 * A `{{` after a command other than eval. Its lines up to `}}` are
 * skipped, not run one by one as commands.
 */
export const ONLY_EVAL_TAKES_A_BLOCK = 'Only the eval command takes a {{ block, so its lines up to }} are skipped';

/** An eval block the input ended inside of. */
export function unclosedBlockMessage(line: number): string {
  return `The eval block on line ${line} has no }} line to end it`;
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
      // The code keeps its own line breaks, so `//` comments and
      // statements without semicolons read as they were written.
      if (this.body.some((l) => l.trim())) command.text += '\n' + this.body.join('\n');
      this.block = null;
      this.body = [];
      return { command };
    }
    if (!trimmed || trimmed.startsWith('#')) return null;
    const words = trimmed.split(/\s+/);
    if (words.length > 1 && words.at(-1) === OPEN) {
      this.block = { text: trimmed.slice(0, -OPEN.length).trimEnd(), source: [line], line: n };
      this.refused = words[0] !== 'eval';
      return this.refused ? { error: ONLY_EVAL_TAKES_A_BLOCK } : null;
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

const NONE_RUN = 'None of the commands were run.';

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
