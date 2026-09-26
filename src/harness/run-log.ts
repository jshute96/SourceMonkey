// A run's log file: its stream, each line timestamped, to tail or read
// back for what happened and when. The run's process writes its output
// there. Each file is named by its start time and kept after the run
// ends.
//
// Node-only, like runs.ts.

import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, symlink, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { checkPrivateDir, owner } from './runs.js';

/**
 * Where the logs go: `/tmp/sm-dev-logs-<user>` on most machines.
 * `SM_DEV_LOGS_DIR` moves it, for tests.
 */
export function runLogsDir(): string {
  return process.env.SM_DEV_LOGS_DIR || path.join(os.tmpdir(), `sm-dev-logs-${owner()}`);
}

/**
 * Local time as `20260408-203012-345`: SeeWhatISee's file-name
 * timestamp. Names the log files, and starts each line in them.
 */
export function logTimestamp(ms = Date.now()): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    + `-${pad(d.getMilliseconds(), 3)}`;
}

/** A log line's timestamp and the space after it, for taking back off. */
export const LOG_LINE_PREFIX = /^\d{8}-\d{6}-\d{3} /;

/**
 * Creates a new log file, `sm-dev-<timestamp>.log`. A name already
 * taken moves the timestamp on a millisecond and tries again; created
 * exclusively, so two runs starting together can't share one.
 */
export async function createRunLog(): Promise<{ file: string; handle: FileHandle }> {
  const dir = runLogsDir();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`Could not create the log directory ${dir}: ${(err as Error).message}`);
  }
  // In a shared temp directory, another user could have made it first,
  // and then delete or swap the run links.
  await checkPrivateDir(dir, 'log');
  for (let ms = Date.now(); ; ms++) {
    const file = path.join(dir, `sm-dev-${logTimestamp(ms)}.log`);
    try {
      return { file, handle: await open(file, 'wx', 0o600) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`Could not create the log file ${file}: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Starts each line this process writes to stdout and stderr with the
 * time it was written. For the detached run, whose output is its log
 * file. Output that bypasses the streams (a crash in Node itself)
 * still lands in the file, unstamped.
 */
export function timestampOutputLines(): void {
  // Shared, since both streams go to the one file.
  let atLineStart = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: string, ...rest: unknown[]) => boolean;
    // So a character split across two byte writes survives.
    const decoder = new StringDecoder('utf8');
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
      const stamp = logTimestamp();
      let out = '';
      for (const [i, part] of text.split('\n').entries()) {
        if (i > 0) {
          out += '\n';
          atLineStart = true;
        }
        if (part === '') continue;
        if (atLineStart) out += `${stamp} `;
        atLineStart = false;
        out += part;
      }
      // A string, whatever came in, so an encoding argument no longer applies.
      const callback = rest.find((r) => typeof r === 'function');
      return callback ? write(out, callback) : write(out);
    }) as typeof stream.write;
  }
}

/**
 * Points `sm-dev-<run id>.log`, beside the log, at it: the latest log of
 * a run with that id, found by the id alone. Swapped in by a rename, so
 * the link is never missing or half made. A failure only costs the
 * link, so it is said and the run goes on.
 */
export async function linkRunLog(file: string, id: string, out: (line: string) => void): Promise<void> {
  // A file symlink there takes admin rights or Developer Mode, so most
  // runs would only say it failed.
  if (process.platform === 'win32') return;
  const link = path.join(path.dirname(file), `sm-dev-${id}.log`);
  const temp = `${link}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    // Relative, so the pair still works if the directory is moved.
    await symlink(path.basename(file), temp);
    await rename(temp, link);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    out(`[sm-dev] Could not link ${link} to the log: ${(err as Error).message}`);
  }
}
