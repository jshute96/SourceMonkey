// Script numbers: a short number for each installed script, which sm-dev
// names it by (`E12`) and log IDs carry (`foo.user.js#E12`). See
// docs/storage.md#script-numbers.
//
// - One `scriptNumbers` row holds them all, rather than a field on each
//   script row: script rows are rewritten from many places, and a number
//   lost in one of those rewrites would be handed out again as a new one.
// - Only the service worker writes the row (`assignScriptNumbers`, run
//   before each registration sync), so two installs can't take the same
//   number. Pages only read it.
// - A removed script's number is held back for a while before reuse, so
//   an E-id someone saw a moment ago never names a different script.

import { isSmDevCollection } from './directories.js';
import { ensureCollectionKeysMigrated, type StoredCollection } from './script-store.js';

export const SCRIPT_NUMBERS_KEY = 'scriptNumbers';

/** How long a removed script's number waits before it can be reused. */
export const NUMBER_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScriptNumbers {
  /** Each numbered script's number, by script id. */
  byScript: Record<string, number>;
  /** Numbers whose script was removed, with when they were last used (epoch ms). */
  retired: Record<string, number>;
}

export function emptyScriptNumbers(): ScriptNumbers {
  return { byScript: {}, retired: {} };
}

/** The stored row, or an empty one; tolerates a malformed row. */
export function scriptNumbersFrom(value: unknown): ScriptNumbers {
  const row = value as Partial<ScriptNumbers> | undefined;
  return {
    byScript: row?.byScript && typeof row.byScript === 'object' ? row.byScript : {},
    retired: row?.retired && typeof row.retired === 'object' ? row.retired : {},
  };
}

/** The numbers by script id, for log IDs. */
export function numberMap(numbers: ScriptNumbers): Map<string, number> {
  return new Map(Object.entries(numbers.byScript));
}

/**
 * The numbers after reconciling them with the scripts that should have
 * one (`wanted`, in the order new numbers are handed out):
 *
 * - a wanted script keeps its number; if two share one (a restored
 *   backup, say), the first keeps it and the other gets a new one;
 * - a number whose script is gone, or no longer wanted, is retired from
 *   `now`, unless it was already;
 * - a retired number held for `holdMs` is free again;
 * - a wanted script without a number gets the lowest free one.
 *
 * Pure. `changed` is false when nothing moved, so the caller can skip
 * the write.
 */
export function reconcileScriptNumbers(
  prior: ScriptNumbers, wanted: readonly string[], now: number, holdMs = NUMBER_HOLD_MS,
): { numbers: ScriptNumbers; changed: boolean } {
  const byScript: Record<string, number> = {};
  const retired: Record<string, number> = { ...prior.retired };
  const used = new Set<number>();
  for (const id of wanted) {
    const n = prior.byScript[id];
    if (!Number.isInteger(n) || n < 1 || used.has(n)) continue;
    byScript[id] = n;
    used.add(n);
    // In use again (a reconcile that went wrong earlier): not retired.
    delete retired[n];
  }
  for (const [id, n] of Object.entries(prior.byScript)) {
    if (byScript[id] === n || used.has(n) || String(n) in retired) continue;
    retired[n] = now;
  }
  for (const [n, at] of Object.entries(retired)) {
    if (now - at >= holdMs) delete retired[n];
  }
  let next = 1;
  for (const id of wanted) {
    if (id in byScript) continue;
    while (used.has(next) || String(next) in retired) next++;
    byScript[id] = next;
    used.add(next);
  }
  const numbers = { byScript, retired };
  return { numbers, changed: !sameNumbers(prior, numbers) };
}

function sameNumbers(a: ScriptNumbers, b: ScriptNumbers): boolean {
  const same = (x: Record<string, number>, y: Record<string, number>): boolean => {
    const keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every((k) => x[k] === y[k]);
  };
  return same(a.byScript, b.byScript) && same(a.retired, b.retired);
}

/**
 * The scripts that get a number, in the order new ones are handed out:
 * collections by path, then each collection's own order. Not the
 * scripts in sm-dev's test collections, which a run names `1`, `2`
 * itself, and pushes and removes too often to number.
 */
export function numberedScriptIds(scriptIds: readonly string[], collections: readonly StoredCollection[]): string[] {
  const present = new Set(scriptIds);
  const ids: string[] = [];
  const seen = new Set<string>();
  const sorted = [...collections].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const collection of sorted) {
    if (isSmDevCollection(collection.path)) {
      for (const id of collection.scriptIds) seen.add(id);
      continue;
    }
    for (const id of collection.scriptIds) {
      if (!present.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  // A script row whose collection doesn't list it still gets a number.
  for (const id of scriptIds) if (!seen.has(id)) ids.push(id);
  return ids;
}

// ---------- Service worker: assigning ----------

let assigning: Promise<ScriptNumbers | null> = Promise.resolve(null);

/**
 * Reconciles the stored numbers with the stored scripts, writes the row
 * when they moved, and resolves to the numbers (null when they couldn't
 * be read). Serialized, so two calls never write over each other.
 * Service worker only: it is the row's one writer.
 *
 * Runs before every registration sync, so it reads only what it needs:
 * the keys, the small collection rows and the numbers row, never the
 * script rows with their bodies.
 */
export function assignScriptNumbers(): Promise<ScriptNumbers | null> {
  const run = assigning.then(async () => {
    // Collection rows may still be under their old key spelling.
    await ensureCollectionKeysMigrated();
    const keys = await chrome.storage.local.getKeys();
    const scriptIds = keys.filter((k) => k.startsWith('script:')).map((k) => k.slice('script:'.length));
    const got = await chrome.storage.local.get([...keys.filter((k) => k.startsWith('collection:')), SCRIPT_NUMBERS_KEY]);
    const collections = Object.entries(got)
      .filter(([k]) => k.startsWith('collection:'))
      .map(([, v]) => v as StoredCollection);
    const prior = scriptNumbersFrom(got[SCRIPT_NUMBERS_KEY]);
    const { numbers, changed } = reconcileScriptNumbers(prior, numberedScriptIds(scriptIds, collections), Date.now());
    if (changed) await chrome.storage.local.set({ [SCRIPT_NUMBERS_KEY]: numbers });
    return numbers;
  });
  // A failure is logged, and doesn't block the next attempt.
  assigning = run.catch((err) => {
    console.info('[SourceMonkey] script numbers could not be updated', err);
    return null;
  });
  return assigning;
}

/** The stored numbers, read fresh. */
export async function readScriptNumbers(): Promise<ScriptNumbers> {
  const got = await chrome.storage.local.get(SCRIPT_NUMBERS_KEY);
  return scriptNumbersFrom(got[SCRIPT_NUMBERS_KEY]);
}
