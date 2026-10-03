// Per-script "log ID" assignment.
//
// Goal: every script that appears in a log line or UI label can be
// referred to by a short, file-derived handle: its basename and its
// script number (`bold-on-hover.user.js#E4`), the number sm-dev names
// it by (see sticky-numbers.ts). The number keeps two scripts sharing a
// basename apart, and never shifts when other scripts come and go.
//
// A script with no number yet (one just added, before the service
// worker numbers it, or one in an sm-dev test collection) is labelled
// by its basename alone, or `#1`, `#2`, ... among other unnumbered
// scripts sharing it.
//
// The basename comes from `scriptBasename`, so a script added by URL
// contributes its decoded filename (`My Script.user.js`), not the
// percent-encoded URL tail. `script-source-url.ts` re-encodes the
// label on its way into a `//# sourceURL=` directive.
//
// Unnumbered dupe ordering: sorted by their stable UUID `id`, so the
// assignment is deterministic, though adding or removing another such
// script can reshuffle them.

import { scriptBasename } from '../script-display.js';
import { numberMap, numbersFrom, SCRIPT_NUMBERS_KEY } from './sticky-numbers.js';
import { scanAllStorage } from './storage-scan.js';
import type { StoredScript } from '../script-build.js';

export interface LogIdInput {
  id: string;
  relativePath: string;
}

const SCRIPT_PREFIX = 'script:';

// ---------- Pure helpers ----------

/**
 * Each script's log ID, by id. `numbers`: the script numbers (from the
 * `scriptNumbers` row); a script with one is `<basename>#E<number>`.
 */
export function computeLogIds(scripts: LogIdInput[], numbers: ReadonlyMap<string, number> = new Map()): Map<string, string> {
  const groups = new Map<string, LogIdInput[]>();
  const out = new Map<string, string>();
  for (const s of scripts) {
    const base = scriptBasename(s.relativePath);
    const n = numbers.get(s.id);
    if (n !== undefined) {
      out.set(s.id, `${base}#E${n}`);
      continue;
    }
    const arr = groups.get(base);
    if (arr) arr.push(s);
    else groups.set(base, [s]);
  }
  for (const [base, arr] of groups) {
    if (arr.length === 1) {
      out.set(arr[0].id, base);
      continue;
    }
    // Plain byte-order comparison rather than localeCompare so the
    // assignment is locale-independent — a Turkish-locale SW must agree
    // with a US-locale collections page, and UUIDs are ASCII anyway.
    arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    arr.forEach((s, i) => out.set(s.id, `${base}#${i + 1}`));
  }
  return out;
}

// ---------- SW-side runtime ----------
//
// The SW maintains its own copy of {id → relativePath} for every
// stored script (regardless of status — error/missing scripts can
// still show up in update-check log lines). One full read at startup,
// then kept fresh via chrome.storage.onChanged.

let allInfo = new Map<string, LogIdInput>();
let numbers = new Map<string, number>();
let logIds = new Map<string, string>();
let loaded: Promise<void> | null = null;

export function ensureLogIdsLoaded(): Promise<void> {
  if (!loaded) loaded = loadAll();
  return loaded;
}

async function loadAll(): Promise<void> {
  const all = await scanAllStorage('log id table');
  const next = new Map<string, LogIdInput>();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SCRIPT_PREFIX)) continue;
    const s = value as StoredScript;
    next.set(s.id, { id: s.id, relativePath: s.relativePath });
  }
  allInfo = next;
  numbers = numberMap(numbersFrom(all[SCRIPT_NUMBERS_KEY]));
  recompute();
}

function recompute(): void {
  logIds = computeLogIds([...allInfo.values()], numbers);
}

let listenerInstalled = false;
export function installScriptLogIdListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let touched = false;
    if (SCRIPT_NUMBERS_KEY in changes) {
      numbers = numberMap(numbersFrom(changes[SCRIPT_NUMBERS_KEY].newValue));
      touched = true;
    }
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(SCRIPT_PREFIX)) continue;
      const id = key.slice(SCRIPT_PREFIX.length);
      if (change.newValue === undefined) {
        if (allInfo.delete(id)) touched = true;
        continue;
      }
      const s = change.newValue as StoredScript;
      const prior = allInfo.get(id);
      if (!prior || prior.relativePath !== s.relativePath) {
        allInfo.set(id, { id: s.id, relativePath: s.relativePath });
        touched = true;
      }
    }
    if (touched) recompute();
  });
}

/**
 * The script numbers, straight from the service worker's numbering, so
 * a label asked for right after a sync already has its `#E<n>`, rather
 * than waiting for the storage change event to bring it.
 */
export function noteScriptNumbers(next: Map<string, number>): void {
  numbers = next;
  recompute();
}

// Short human-readable label for SW log messages. Falls back to the
// first 8 chars of the UUID when the script isn't tracked — happens
// only for a brief window before ensureLogIdsLoaded() resolves, or
// for late sm:* reports from scripts that have since been removed.
export function getScriptLogLabel(id: string): string {
  return logIds.get(id) ?? id.slice(0, 8);
}

// Test/debug hook. Note: we do NOT flip listenerInstalled back to
// false — chrome.storage.onChanged.addListener can't be cleanly
// undone for an anonymous listener, and re-installing would queue
// duplicate callbacks.
export function _resetScriptLogIdsForTests(): void {
  allInfo = new Map();
  numbers = new Map();
  logIds = new Map();
  loaded = null;
}
