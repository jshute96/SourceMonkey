// The `--interactive` prompt's history, kept across sessions in
// ~/.sm-dev-history (or `SM_DEV_HISTORY`; set it empty for none).
//
// As in a shell with `histappend`, sessions share the file without
// overwriting each other: each loads it when it starts, and appends
// its own commands as they are typed. A session doesn't see another's
// commands until it is restarted.
//
// One entry per line, as a JSON string, since a `{{` block is one
// entry of several lines.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How many entries a session loads, and the file keeps. */
export const HISTORY_SIZE = 1000;

/** The history file, or null when history isn't kept. */
export function historyFile(): string | null {
  const chosen = process.env.SM_DEV_HISTORY;
  if (chosen !== undefined) return chosen.trim() ? path.resolve(chosen.trim()) : null;
  return path.join(os.homedir(), '.sm-dev-history');
}

/**
 * The entries in the file's last `HISTORY_SIZE` lines, newest first, as
 * readline takes them. A missing or unreadable file is no history.
 * The file is cut back to that many lines once it holds twice as many,
 * since each session only appends to it.
 */
export function loadHistory(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  const entries: string[] = [];
  for (const line of lines.slice(-HISTORY_SIZE)) {
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry === 'string' && entry !== entries.at(-1)) entries.push(entry);
    } catch {
      // A line cut short by a crash mid-write: skipped.
    }
  }
  try {
    if (lines.length >= 2 * HISTORY_SIZE) {
      // Written aside and renamed, so a session reading the file never
      // sees half of it. One appending meanwhile loses that entry.
      const temp = `${file}.${process.pid}.tmp`;
      try {
        writePrivate(temp, lines.slice(-HISTORY_SIZE).join('\n') + '\n', 'w');
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    } else if (text && !text.endsWith('\n')) {
      // End a cut-short line, so the next entry doesn't join it.
      writePrivate(file, '\n', 'a');
    }
  } catch {
    // Tidying only. A file that can't be written is reported by the
    // first appendHistory.
  }
  return entries.reverse();
}

/** Adds an entry to the end of the file. Throws when it can't. */
export function appendHistory(file: string, entry: string): void {
  writePrivate(file, JSON.stringify(entry) + '\n', 'a');
}

// Every write of the file goes through here, so it stays readable only
// by its owner: commands can hold passwords (`type`) and tokens. A
// file's mode is only set when it is made, so it is set again here.
function writePrivate(file: string, text: string, flag: 'a' | 'w'): void {
  const fd = fs.openSync(file, flag, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}
