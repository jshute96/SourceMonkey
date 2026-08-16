// Per-script "log ID" assignment.
//
// Goal: every script that appears in a log line or UI label can be
// referred to by a short, file-derived handle. If the basename of the
// script's relativePath is unique across all stored scripts, the log
// ID is just that basename (e.g. `bold-on-hover.user.js`). If two or
// more scripts share a basename, each gets a `#N` suffix
// (`bold-on-hover.user.js#1`, `bold-on-hover.user.js#2`, …) so they
// stay distinguishable.
//
// The basename comes from `scriptBasename`, so a script added by URL
// contributes its decoded filename (`My Script.user.js`), not the
// percent-encoded URL tail. `script-source-url.ts` re-encodes the
// label on its way into a `//# sourceURL=` directive.
//
// Dupe ordering: scripts sharing a basename are sorted by their stable
// UUID `id`. UUIDs are random, so the assignment isn't time-ordered,
// but it IS deterministic and stable for the lifetime of each script
// — adding/removing other scripts in the same dupe group can reshuffle
// numbers, which is acceptable for a logging convenience. The options
// page renders the same `#N` next to each filename so the user can
// correlate.

import { scriptBasename } from './script-display.js';
import type { StoredScript } from './script-store.js';

export interface LogIdInput {
  id: string;
  relativePath: string;
}

const SCRIPT_PREFIX = 'script:';

// ---------- Pure helpers ----------

export function computeLogIds(scripts: LogIdInput[]): Map<string, string> {
  const groups = new Map<string, LogIdInput[]>();
  for (const s of scripts) {
    const base = scriptBasename(s.relativePath);
    const arr = groups.get(base);
    if (arr) arr.push(s);
    else groups.set(base, [s]);
  }
  const out = new Map<string, string>();
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
let logIds = new Map<string, string>();
let loaded: Promise<void> | null = null;

export function ensureLogIdsLoaded(): Promise<void> {
  if (!loaded) loaded = loadAll();
  return loaded;
}

async function loadAll(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const next = new Map<string, LogIdInput>();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SCRIPT_PREFIX)) continue;
    const s = value as StoredScript;
    next.set(s.id, { id: s.id, relativePath: s.relativePath });
  }
  allInfo = next;
  recompute();
}

function recompute(): void {
  logIds = computeLogIds([...allInfo.values()]);
}

let listenerInstalled = false;
export function installScriptLogIdListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let touched = false;
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
  logIds = new Map();
  loaded = null;
}
