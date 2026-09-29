// Files named on a command line for what they hold (`eval --file`,
// `set --file`, `start --values-file`): read whole, with what went wrong
// in plain words for an `ERROR:` line.

import { readFileSync } from 'node:fs';

/**
 * The text of `file`, which is `shown` in messages. Throws an Error
 * saying why it couldn't be read, or that it is empty.
 */
export function readInputFile(file: string, shown: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Couldn't read ${shown}: ${readProblem(err as NodeJS.ErrnoException)}`);
  }
  if (!text.trim()) throw new Error(`The file ${shown} is empty`);
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
  const first = err.message.split('\n')[0].replace(/\.$/, '');
  return first.charAt(0).toUpperCase() + first.slice(1);
}
