// The service worker's copy of the structural rows (the collection
// index, collection rows, script rows), so a lookup across every script
// (finding a copy's related copies on an enable click, say) reads memory
// instead of storage. See docs/worker-writes.md#the-row-cache.
//
// Right by construction, not by expiry:
//   - Only the worker writes storage (docs/worker-writes.md#rules), and
//     `installRowCache` wraps this context's `chrome.storage.local`
//     writes, so every write it makes lands here as it lands in storage.
//   - As a safety net, a change event this context didn't cause (a write
//     from anywhere else) drops the copy, and the next read loads it
//     again from storage.
//
// Loaded only by a read that wants every script row anyway
// (`cachedScriptRows`). A point read before then goes to storage, so a
// worker that wakes for one row doesn't pay for all of them.
//
// Rows go out as copies, and are stored as the JSON storage would keep,
// so a caller that changes a row it read can't change the cache.

import { COLLECTION_PREFIX, COLLECTIONS_INDEX_KEY, SCRIPT_PREFIX } from './structural-keys.js';
import { scanStorageRows } from './storage-scan.js';
import { dlog } from '../debug-log.js';

function isCachedKey(key: string): boolean {
  return key === COLLECTIONS_INDEX_KEY || key.startsWith(COLLECTION_PREFIX) || key.startsWith(SCRIPT_PREFIX);
}

let installed = false;
let rows: Map<string, unknown> | null = null;
// Bumped by every change to the cached rows, so a load that overlapped
// one knows its read may predate it.
let generation = 0;
let loading: Promise<Map<string, unknown> | null> | null = null;
// How many times it was read from storage, for tests.
let loads = 0;

// The values this context has written to each key, in order, whose
// change events haven't arrived yet: how an event is told apart from a
// write made elsewhere. Chrome sends no event for a write that changes
// nothing, so one isn't expected then.
const pending = new Map<string, string[]>();
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

function expect(key: string, json: string): void {
  if (rows && rows.has(key) && stableJson(rows.get(key)) === json) return;
  const list = pending.get(key) ?? [];
  list.push(json);
  if (list.length > MAX_PENDING_PER_KEY) list.shift();
  pending.set(key, list);
}

function drop(reason: string): void {
  if (rows) dlog(`[SourceMonkey] row cache dropped: ${reason}`);
  rows = null;
  generation++;
}

// Wrap this context's writes, and watch for others'. Called once, by the
// service worker at startup. Nothing else turns the cache on, so pages
// and unit tests read storage as before.
export function installRowCache(): void {
  if (installed) return;
  installed = true;
  const area = chrome.storage.local;
  const set = area.set.bind(area);
  const remove = area.remove.bind(area);
  const clear = area.clear.bind(area);

  area.set = (async (items: Record<string, unknown>) => {
    const written: [string, string][] = [];
    for (const [key, value] of Object.entries(items)) {
      if (!isCachedKey(key)) continue;
      const json = stableJson(value);
      expect(key, json);
      written.push([key, json]);
    }
    await set(items);
    if (written.length === 0) return;
    generation++;
    if (!rows) return;
    for (const [key, json] of written) {
      if (json === REMOVED) rows.delete(key);
      else rows.set(key, JSON.parse(json));
    }
  }) as typeof area.set;

  area.remove = (async (keys: string | string[]) => {
    const removed = (Array.isArray(keys) ? keys : [keys]).filter(isCachedKey);
    for (const key of removed) expect(key, REMOVED);
    await remove(keys);
    if (removed.length === 0) return;
    generation++;
    if (rows) for (const key of removed) rows.delete(key);
  }) as typeof area.remove;

  area.clear = (async () => {
    await clear();
    pending.clear();
    drop('storage cleared');
  }) as typeof area.clear;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!isCachedKey(key)) continue;
      const json = stableJson(change.newValue);
      const list = pending.get(key);
      const at = list ? list.indexOf(json) : -1;
      if (list && at >= 0) {
        // Ours. Earlier values for this key that got no event of their
        // own are passed now too.
        list.splice(0, at + 1);
        if (list.length === 0) pending.delete(key);
        continue;
      }
      if (rows) drop(`${key} written elsewhere`);
      else generation++;
    }
  });
}

export function rowCacheInstalled(): boolean {
  return installed;
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
        const start = generation;
        loads++;
        const read = await scanStorageRows('row cache', isCachedKey);
        if (generation !== start) continue;
        rows = new Map(Object.entries(read));
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
  const all = await loaded();
  if (!all) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of all) {
    if (key.startsWith(SCRIPT_PREFIX)) out[key] = structuredClone(value);
  }
  return out;
}

export function rowCacheLoadsForTests(): number {
  return loads;
}
