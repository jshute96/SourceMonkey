// Files named on a command line for what they hold (`eval --file`,
// `set --file`, `type --file`, `start --values-file`): read whole, with what went wrong
// in plain words for an `ERROR:` line.

import { readFileSync } from 'node:fs';

/**
 * The text of `file`, which is `shown` in messages. Throws an Error
 * saying why it couldn't be read, or that it is empty: nothing, or
 * only whitespace unless `blankOk` (text to type may be just that).
 */
export function readInputFile(file: string, shown: string, { blankOk = false } = {}): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Couldn't read ${shown}: ${readProblem(err as NodeJS.ErrnoException)}`);
  }
  if (blankOk ? !text : !text.trim()) throw new Error(`The file ${shown} is empty`);
  return text;
}

/** The JSON value in `file`, else an Error as `readInputFile` throws. */
export function readJsonFile(file: string, shown: string): unknown {
  const text = readInputFile(file, shown);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`The file ${shown} is not JSON: ${(err as Error).message}`);
  }
}

// Why a file couldn't be read.
function readProblem(err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') return 'The file does not exist';
  if (err.code === 'EISDIR') return 'It\'s a folder';
  if (err.code === 'EACCES') return 'Permission was refused';
  return errorSentence(err);
}

/**
 * Why a file couldn't be written, or null for a failure with no
 * common cause. Playwright's own writes (a screenshot) only name the
 * code in their message, hence the match.
 */
export function writeProblem(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException).code ?? /\b(ENOENT|EACCES|EISDIR)\b/.exec((err as Error).message)?.[1];
  if (code === 'ENOENT') return 'Its folder doesn\'t exist';
  if (code === 'EACCES') return 'Permission was refused';
  if (code === 'EISDIR') return 'It\'s a folder';
  return null;
}

/** An error's message as a sentence to follow a `: `. */
export function errorSentence(err: unknown): string {
  const first = (err as Error).message.split('\n')[0].replace(/\.$/, '');
  return first.charAt(0).toUpperCase() + first.slice(1);
}
