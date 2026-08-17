// SW-side persistent storage for `GM_setValue` / `GM_getValue` /
// `GM_deleteValue` / `GM_listValues` and their GM4 aliases.
//
// Layout. Each `(scriptId, key)` lives at its own
// `gmval:<scriptId>:<key>` row in chrome.storage.local. Rows are
// independent of `script:<id>` rows so a write doesn't churn the
// match-index cache; conversely, deleting a script doesn't lose its
// stored values without an explicit sweep.
//
// Why per-key rows (not a per-script object): chrome.storage.local
// rejects values larger than ~8 KB per row in some Chrome builds,
// but the per-row quota is much higher than the per-extension quota.
// Per-key rows let a single 64 KB value land without forcing the
// whole script's storage into one row that bumps against the
// per-row limit; they also let us write a single key delta without
// rewriting siblings.
//
// Type tagging. chrome.storage round-trips objects via JSON which
// is lossy for `undefined` and special values. We store the raw
// value untransformed — JSON-serializable objects survive; functions
// / circular refs would have been rejected by chrome.storage anyway.
// VM and TM both use a type-tag prefix encoding to round-trip more
// types (e.g. dates) — we don't, for simplicity. Userscripts that
// need date round-tripping should JSON.stringify themselves.
//
// Reading one script's values. chrome.storage has no prefix query, so
// the shape is `getKeys()` → filter → `get(thoseKeys)`. That matters
// more than it looks: the alternative, `get(null)`, returns every row
// the extension owns and is paid for on the reload fast path. See
// `loadAllValues`.

import { scanAllStorage, timeStorageRead } from './storage-scan.js';

const VALUE_PREFIX = 'gmval:';

// Compose / parse the storage key shape: `gmval:<scriptId>:<key>`.
// `scriptId` is a UUID so no `:` in it; `key` may contain `:`. We
// only split on the FIRST two colons to preserve any colons in the
// user-supplied key.
export function valueKey(scriptId: string, key: string): string {
  return `${VALUE_PREFIX}${scriptId}:${key}`;
}

export function valueKeyPrefix(scriptId: string): string {
  return `${VALUE_PREFIX}${scriptId}:`;
}

// Extract the user-supplied key from a `gmval:<scriptId>:<key>` row
// name. Returns `null` for rows that don't belong to this script.
export function parseValueKey(rowKey: string, scriptId: string): string | null {
  const prefix = valueKeyPrefix(scriptId);
  if (!rowKey.startsWith(prefix)) return null;
  return rowKey.slice(prefix.length);
}

// Load every stored value for a script as a plain object. Used by the
// injector to bake the initial cache into the wrapper at registration
// time, and by the check-pending handler to seed a reload swap.
//
// There is no prefix query, so the shape has to be "narrow the key set,
// then read only those rows". `getKeys()` (Chrome 130+) returns names
// without values, which is the cheap half; the fallback reads
// everything the way this always did.
//
// Why it matters that this is narrow: the caller on the reload fast
// path runs it INSIDE the 500 ms swap window, and a full-namespace
// read is not merely bigger — deserializing it occupies the worker's
// single thread, so it delays the swap decision and every unrelated
// callback waiting alongside it. Measured on a 266-row profile: ~155 ms
// for the whole namespace versus a handful of `gmval:` rows.
// See docs/diagnostics.md#storage-scans.
export async function loadAllValues(scriptId: string): Promise<Record<string, unknown>> {
  const prefix = valueKeyPrefix(scriptId);
  const out: Record<string, unknown> = {};
  // Timed around BOTH legs — the key listing is part of what the narrow
  // path costs, and the line exists to be compared against the full
  // scan it replaced.
  const narrow = await timeStorageRead('gm snapshot (narrow)', async () => {
    const keys = await listValueKeys(prefix);
    if (!keys) return null;
    return keys.length === 0 ? {} : await chrome.storage.local.get(keys);
  });
  if (narrow) {
    for (const [k, v] of Object.entries(narrow)) out[k.slice(prefix.length)] = v;
    return out;
  }
  const all = await scanAllStorage('gm snapshot');
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

// Every stored key starting with `prefix`, or null when the browser has
// no `getKeys` — in which case the caller falls back to a full scan.
// A throw is treated the same as absence: this is an optimisation, and
// nothing about it should be able to fail a value read.
async function listValueKeys(prefix: string): Promise<string[] | null> {
  const area = chrome.storage.local as typeof chrome.storage.local & {
    getKeys?: () => Promise<string[]>;
  };
  if (typeof area.getKeys !== 'function') return null;
  try {
    return (await area.getKeys()).filter((k) => k.startsWith(prefix));
  } catch {
    return null;
  }
}

// One key/value pair in a batch write.
export interface ValueWrite {
  key: string;
  // Sentinel: `__SM_DELETED__` means "delete this key" (chrome.storage
  // requires an explicit `remove`, but we want a single round-trip
  // for mixed sets + deletes from the runtime's batched flush).
  value: unknown;
}

// The deletion sentinel. Compared by reference in the SW handler so a
// userscript that happens to set the value to the same string literal
// is not treated as a delete.
export const DELETED_SENTINEL = Object.freeze({ __sm_deleted__: true });

export function isDeletionSentinel(v: unknown): boolean {
  return v === DELETED_SENTINEL;
}

// Apply a batched mixed set/delete operation. Returns the changed
// keys so a future broadcast phase can ship the delta to other tabs.
//
// Pure semantics: if the same key appears multiple times in the
// batch, the LAST write wins (matches what a sequence of GM_setValue
// + GM_deleteValue calls would do).
export async function applyBatchValues(
  scriptId: string,
  writes: readonly ValueWrite[],
): Promise<{ setKeys: string[]; deletedKeys: string[] }> {
  if (writes.length === 0) return { setKeys: [], deletedKeys: [] };

  // Resolve last-write-wins per key.
  const finalSets = new Map<string, unknown>();
  const finalDeletes = new Set<string>();
  for (const w of writes) {
    if (isDeletionSentinel(w.value)) {
      finalDeletes.add(w.key);
      finalSets.delete(w.key);
    } else {
      finalDeletes.delete(w.key);
      finalSets.set(w.key, w.value);
    }
  }

  // chrome.storage.local.set + remove are independent calls; do them
  // in parallel. We never want a partial application — if either
  // rejects, the caller should re-try the whole batch. We don't
  // attempt rollback because chrome.storage doesn't expose that.
  const setObj: Record<string, unknown> = {};
  for (const [k, v] of finalSets) setObj[valueKey(scriptId, k)] = v;
  const removeKeys = [...finalDeletes].map((k) => valueKey(scriptId, k));

  const ops: Promise<void>[] = [];
  if (Object.keys(setObj).length > 0) ops.push(chrome.storage.local.set(setObj));
  if (removeKeys.length > 0) ops.push(chrome.storage.local.remove(removeKeys));
  await Promise.all(ops);

  return {
    setKeys: [...finalSets.keys()],
    deletedKeys: [...finalDeletes],
  };
}

// Sweep every `gmval:<scriptId>:*` row when a script is removed. Not
// wired up yet — leaving stale storage rows lets users restore a
// deleted script with its prior values, which TM/VM both do.
// Exported so a future "wipe all data for this script" UI action can
// call it.
//
// When this is wired up, the caller must also drop the script's
// entry from the SW's `gmValueOverlay` (in `background.ts`).
// Otherwise an in-flight write that lands during the wipe leaves
// an orphan overlay entry that would seed a freshly-loaded
// document with bogus pre-wipe state.
export async function wipeScriptValues(scriptId: string): Promise<number> {
  const prefix = valueKeyPrefix(scriptId);
  const keys = await listValueKeys(prefix)
    ?? Object.keys(await scanAllStorage('gm value wipe')).filter((k) => k.startsWith(prefix));
  if (keys.length === 0) return 0;
  await chrome.storage.local.remove(keys);
  return keys.length;
}
