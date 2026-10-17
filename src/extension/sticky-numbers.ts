// Sticky numbers: a short number for each installed script and each
// collection, which sm-dev names them by (`E12`, `C3`). Log IDs carry the
// script's (`foo.user.js#E12`). See docs/storage.md#sticky-numbers.
//
// - Each kind has one row (`scriptNumbers`, `collectionNumbers`), rather
//   than a field on each script or collection row: those rows are
//   rewritten from many places, and a number lost in one of those
//   rewrites would be handed out again as a new one.
// - Only the service worker writes the rows (`assignNumbers`, run before
//   each registration sync), so two installs can't take the same number.
//   Pages only read them.
// - A removed item's number is held back for a while before reuse, so an
//   id someone saw a moment ago never names a different item.

import { sharedRows } from './row-cache.js';
import { assertWorkerContext } from '../run-context.js';
import { isSmDevCollection } from './directories.js';
import { ensureCollectionKeysMigrated, type StoredCollection } from './script-store.js';

export const SCRIPT_NUMBERS_KEY = 'scriptNumbers';
export const COLLECTION_NUMBERS_KEY = 'collectionNumbers';

/** How long a removed item's number waits before it can be reused. */
export const NUMBER_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** One kind's numbers: the stored shape of each row. */
export interface StickyNumbers {
  /** Each numbered item's number, by script or collection id. */
  byId: Record<string, number>;
  /** Numbers whose item was removed, with when they were last used (epoch ms). */
  retired: Record<string, number>;
}

/** The stored row, or an empty one; tolerates a malformed row. */
export function numbersFrom(value: unknown): StickyNumbers {
  const row = value as Partial<StickyNumbers> | undefined;
  return {
    byId: row?.byId && typeof row.byId === 'object' ? row.byId : {},
    retired: row?.retired && typeof row.retired === 'object' ? row.retired : {},
  };
}

/** The numbers by id, for log IDs. */
export function numberMap(numbers: StickyNumbers): Map<string, number> {
  return new Map(Object.entries(numbers.byId));
}

/**
 * The numbers after reconciling them with the items that should have
 * one (`wanted`, in the order new numbers are handed out):
 *
 * - a wanted item keeps its number; if two share one (a restored
 *   backup, say), the first keeps it and the other gets a new one;
 * - a number whose item is gone, or no longer wanted, is retired from
 *   `now`, unless it was already;
 * - a retired number held for `holdMs` is free again;
 * - a wanted item without a number gets the lowest free one.
 *
 * Pure. `changed` is false when nothing moved, so the caller can skip
 * the write.
 */
export function reconcileNumbers(
  prior: StickyNumbers, wanted: readonly string[], now: number, holdMs = NUMBER_HOLD_MS,
): { numbers: StickyNumbers; changed: boolean } {
  const byId: Record<string, number> = {};
  const retired: Record<string, number> = { ...prior.retired };
  const used = new Set<number>();
  for (const id of wanted) {
    const n = prior.byId[id];
    if (!Number.isInteger(n) || n < 1 || used.has(n)) continue;
    byId[id] = n;
    used.add(n);
    // In use again (a reconcile that went wrong earlier): not retired.
    delete retired[n];
  }
  for (const [id, n] of Object.entries(prior.byId)) {
    if (byId[id] === n || used.has(n) || String(n) in retired) continue;
    retired[n] = now;
  }
  for (const [n, at] of Object.entries(retired)) {
    if (now - at >= holdMs) delete retired[n];
  }
  let next = 1;
  for (const id of wanted) {
    if (id in byId) continue;
    while (used.has(next) || String(next) in retired) next++;
    byId[id] = next;
    used.add(next);
  }
  const numbers = { byId, retired };
  return { numbers, changed: !sameNumbers(prior, numbers) };
}

function sameNumbers(a: StickyNumbers, b: StickyNumbers): boolean {
  const same = (x: Record<string, number>, y: Record<string, number>): boolean => {
    const keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every((k) => x[k] === y[k]);
  };
  return same(a.byId, b.byId) && same(a.retired, b.retired);
}

function byPath(collections: readonly StoredCollection[]): StoredCollection[] {
  return [...collections].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The collections that get a number, by path. Not sm-dev's test
 * collections, which a run names itself, and adds and drops too often
 * to number.
 */
export function numberedCollectionIds(collections: readonly StoredCollection[]): string[] {
  return byPath(collections).filter((c) => !isSmDevCollection(c.path)).map((c) => c.id);
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
  for (const collection of byPath(collections)) {
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

export interface AllNumbers {
  scripts: StickyNumbers;
  collections: StickyNumbers;
}

let assigning: Promise<AllNumbers | null> = Promise.resolve(null);

/**
 * Reconciles the stored numbers with the stored scripts and collections,
 * writes the rows that moved, and resolves to the numbers (null when
 * they couldn't be read). Serialized, so two calls never write over each
 * other. Service worker only: it is the rows' one writer.
 *
 * Runs before every registration sync, so it reads only what it needs:
 * which scripts and collections exist (from the worker's row cache,
 * else the keys and the collection rows) and the numbers rows.
 */
export function assignNumbers(): Promise<AllNumbers | null> {
  const run = assigning.then(async () => {
    // Collection rows may still be under their old key spelling.
    await ensureCollectionKeysMigrated();
    // Which scripts and collections exist: from the worker's row cache
    // when it's on (frozen rows, read only), else from storage.
    const isRow = (k: string): boolean => k.startsWith('script:') || k.startsWith('collection:');
    const cached = await sharedRows(isRow);
    const keys = cached ? Object.keys(cached) : await chrome.storage.local.getKeys();
    const scriptIds = keys.filter((k) => k.startsWith('script:')).map((k) => k.slice('script:'.length));
    const got = {
      ...(cached ? Object.fromEntries(Object.entries(cached).filter(([k]) => k.startsWith('collection:'))) : {}),
      ...await chrome.storage.local.get([
        ...(cached ? [] : keys.filter((k) => k.startsWith('collection:'))), SCRIPT_NUMBERS_KEY, COLLECTION_NUMBERS_KEY,
      ]),
    };
    const collections = Object.entries(got)
      .filter(([k]) => k.startsWith('collection:'))
      .map(([, v]) => v as StoredCollection);
    const now = Date.now();
    const scripts = reconcileNumbers(numbersFrom(got[SCRIPT_NUMBERS_KEY]), numberedScriptIds(scriptIds, collections), now);
    const colls = reconcileNumbers(numbersFrom(got[COLLECTION_NUMBERS_KEY]), numberedCollectionIds(collections), now);
    const writes: Record<string, StickyNumbers> = {};
    if (scripts.changed) writes[SCRIPT_NUMBERS_KEY] = scripts.numbers;
    if (colls.changed) writes[COLLECTION_NUMBERS_KEY] = colls.numbers;
    assertWorkerContext('write storage');
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    return { scripts: scripts.numbers, collections: colls.numbers };
  });
  // A failure is logged, and doesn't block the next attempt.
  assigning = run.catch((err) => {
    console.info('[SourceMonkey] script and collection numbers could not be updated', err);
    return null;
  });
  return assigning;
}

/** The stored numbers, read fresh. */
export async function readNumbers(): Promise<AllNumbers> {
  const got = await chrome.storage.local.get([SCRIPT_NUMBERS_KEY, COLLECTION_NUMBERS_KEY]);
  return { scripts: numbersFrom(got[SCRIPT_NUMBERS_KEY]), collections: numbersFrom(got[COLLECTION_NUMBERS_KEY]) };
}

/** The stored script numbers, read fresh. */
export async function readScriptNumbers(): Promise<StickyNumbers> {
  const got = await chrome.storage.local.get(SCRIPT_NUMBERS_KEY);
  return numbersFrom(got[SCRIPT_NUMBERS_KEY]);
}
