// The service worker's copy of the structural rows (the collection
// index, collection rows, script rows), so a lookup across every script
// (finding a copy's related copies on an enable click, say) reads memory
// instead of storage. See docs/worker-writes.md#the-row-cache.
//
// Right by construction, not by expiry:
//   - Only the worker writes these rows (docs/worker-writes.md#rules),
//     and `installRowCache` wraps this context's `chrome.storage.local`
//     writes, so every write it makes lands here as it lands in storage.
//   - As a safety net, a change event this context didn't cause (a write
//     from anywhere else) drops the copy, and the next full read loads
//     it again from storage.
//
// Loaded only by a read that wants every script row anyway
// (`cachedScriptRows`). A point read before then goes to storage, so a
// worker that wakes for one row doesn't pay for all of them.
//
// Rows go out as copies, and are stored as the JSON storage would keep,
// so a caller that changes a row it read can't change the cache.

import { isStructuralKey, SCRIPT_PREFIX } from './structural-keys.js';
import { scanStorageRows } from './storage-scan.js';
import { dlog } from '../debug-log.js';

const isCachedKey = isStructuralKey;

let installed = false;
let rows: Map<string, unknown> | null = null;
// Bumped by every change to the cached rows, so a load that overlapped
// one knows its read may predate it.
let generation = 0;
let loading: Promise<Map<string, unknown> | null> | null = null;
// How many times it was read from storage, for tests.
let loads = 0;

// Every write this context makes to a cached key gets the next number.
// A write lands in the cache when its change event arrives or its call
// returns, whichever is first, and an older write never replaces a
// newer one (`applied`).
let nextSeq = 0;
// Writes at or below this number were in storage when the cache loaded.
let loadedAtSeq = 0;
const applied = new Map<string, number>();
// Writes to cached keys started and not yet returned: a load waits for
// none.
let inFlight = 0;
let idleWaiters: (() => void)[] = [];

// The values this context has written to each key whose change events
// haven't arrived yet: how an event is told apart from a write made
// elsewhere. Chrome sends no event for a write that changes nothing, so
// an entry can wait forever; one older than this no longer counts.
interface Pending { json: string; seq: number; at: number }
const pending = new Map<string, Pending[]>();
const PENDING_TTL_MS = 30_000;
const MAX_PENDING_PER_KEY = 16;
const REMOVED = '\u0000removed';

// Key order doesn't count: Chrome keeps an object's keys sorted, so a
// change event's `newValue` can list them in another order than the
// value written.
function stableJson(value: unknown): string {
  if (value === undefined) return REMOVED;
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

function apply(key: string, json: string, seq: number): void {
  if (!rows || seq <= loadedAtSeq || seq <= (applied.get(key) ?? 0)) return;
  if (json === REMOVED) rows.delete(key);
  else rows.set(key, JSON.parse(json));
  applied.set(key, seq);
}

function drop(reason: string): void {
  if (rows) dlog(`[SourceMonkey] row cache dropped: ${reason}`);
  rows = null;
  applied.clear();
  generation++;
}

// Run one of this context's writes, `entries` being its cached keys and
// their values (`REMOVED` for a removal).
async function track(entries: [string, string][], write: () => Promise<void>): Promise<void> {
  if (entries.length === 0) return await write();
  const now = Date.now();
  const mine = entries.map(([key, json]) => {
    const entry: Pending = { json, seq: ++nextSeq, at: now };
    const list = (pending.get(key) ?? []).filter((p) => now - p.at < PENDING_TTL_MS);
    list.push(entry);
    if (list.length > MAX_PENDING_PER_KEY) list.shift();
    pending.set(key, list);
    return [key, entry] as const;
  });
  inFlight++;
  try {
    await write();
  } catch (err) {
    for (const [key, entry] of mine) {
      const list = pending.get(key);
      const at = list ? list.indexOf(entry) : -1;
      if (at >= 0) list!.splice(at, 1);
    }
    throw err;
  } finally {
    if (--inFlight === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const wake of waiters) wake();
    }
  }
  generation++;
  for (const [key, entry] of mine) apply(key, entry.json, entry.seq);
}

// Wrap this context's writes, and watch for others'. Called once, by the
// service worker at startup, before anything writes: its change listener
// then runs before the worker's others, so they read the cache as
// storage now is. Nothing else turns the cache on, so pages and unit
// tests read storage as before.
export function installRowCache(): void {
  if (installed) return;
  installed = true;
  const area = chrome.storage.local;
  const set = area.set.bind(area);
  const remove = area.remove.bind(area);
  const clear = area.clear.bind(area);

  area.set = ((items: Record<string, unknown>) => {
    // A key set to `undefined` is left as it is by Chrome.
    const entries = Object.entries(items)
      .filter(([key, value]) => isCachedKey(key) && value !== undefined)
      .map(([key, value]): [string, string] => [key, stableJson(value)]);
    return track(entries, () => set(items));
  }) as typeof area.set;

  area.remove = ((keys: string | string[]) => {
    const entries = (Array.isArray(keys) ? keys : [keys])
      .filter(isCachedKey)
      .map((key): [string, string] => [key, REMOVED]);
    return track(entries, () => remove(keys));
  }) as typeof area.remove;

  area.clear = (async () => {
    await clear();
    pending.clear();
    drop('storage cleared');
  }) as typeof area.clear;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const now = Date.now();
    for (const [key, change] of Object.entries(changes)) {
      if (!isCachedKey(key)) continue;
      const json = stableJson(change.newValue);
      const list = (pending.get(key) ?? []).filter((p) => now - p.at < PENDING_TTL_MS);
      const at = list.findIndex((p) => p.json === json);
      if (at >= 0) {
        // Ours. Earlier writes to this key that got no event of their
        // own are passed now too.
        apply(key, json, list[at].seq);
        list.splice(0, at + 1);
      }
      if (list.length > 0) pending.set(key, list);
      else pending.delete(key);
      if (at >= 0) continue;
      if (rows) drop(`${key} written elsewhere`);
      else generation++;
    }
  });
}

// Every cached row, loaded first when needed. Null when the cache isn't
// on in this context, or a write kept landing during the load: the
// caller reads storage itself then.
async function loaded(): Promise<Map<string, unknown> | null> {
  if (!installed) return null;
  if (rows) return rows;
  loading ??= (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // With no write in flight, every write numbered so far is in
        // what the scan reads.
        while (inFlight > 0) await new Promise<void>((wake) => idleWaiters.push(wake));
        const start = generation;
        const startSeq = nextSeq;
        loads++;
        const read = await scanStorageRows('row cache', isCachedKey);
        if (generation !== start) continue;
        rows = new Map(Object.entries(read));
        loadedAtSeq = startSeq;
        applied.clear();
        return rows;
      }
      return null;
    } finally {
      loading = null;
    }
  })();
  return await loading;
}

// `keys`' rows, as copies, for the keys the cache holds, when it is
// loaded: `rest` is the keys it doesn't keep, for the caller to read
// from storage. Null when it isn't loaded, without loading it.
export function cachedRows(keys: readonly string[]): { found: Record<string, unknown>; rest: string[] } | null {
  if (!rows) return null;
  const found: Record<string, unknown> = {};
  const rest: string[] = [];
  for (const key of keys) {
    if (!isCachedKey(key)) rest.push(key);
    else if (rows.has(key)) found[key] = structuredClone(rows.get(key));
  }
  return { found, rest };
}

// Every script row, as copies, loading the cache first if needed. Null
// when the cache isn't on in this context.
export async function cachedScriptRows(): Promise<Record<string, unknown> | null> {
  return await cachedRowsWhere((key) => key.startsWith(SCRIPT_PREFIX));
}

// Every cached row (index, collections, scripts), as copies, likewise.
export async function cachedStructuralRows(): Promise<Record<string, unknown> | null> {
  return await cachedRowsWhere(() => true);
}

async function cachedRowsWhere(keep: (key: string) => boolean): Promise<Record<string, unknown> | null> {
  const all = await loaded();
  if (!all) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of all) {
    if (keep(key)) out[key] = structuredClone(value);
  }
  return out;
}

export function rowCacheLoadsForTests(): number {
  return loads;
}
