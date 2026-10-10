// The service worker's copy of the structural rows (the collection
// index, collection rows, script rows) and the active times, so a lookup
// across every script (finding a copy's related copies on an enable
// click, say) reads memory instead of storage. See
// docs/worker-writes.md#the-row-cache.
//
// Right by construction, not by expiry:
//   - Only the worker writes these rows (docs/worker-writes.md#rules),
//     and `installRowCache` wraps this context's `chrome.storage.local`
//     writes, so every write it makes lands here as it lands in storage.
//   - As a safety net, a change event this context didn't cause (a write
//     from anywhere else) drops the copy, and the next full read loads
//     it again from storage.
//
// Loaded by the first read that wants every row: at a worker start, the
// match index, the log labels, sticky numbers or the registration sync,
// which share the one load. A point read before then goes to storage.
//
// Rows are stored frozen, as the JSON storage would keep. Most reads hand
// out copies, which a caller may change. `sharedRows` hands out the
// frozen rows themselves, for the worker's own readers that only read
// (the registration sync, the match index, the log labels, the
// numbers): a change to one throws, so it can't reach the cache.

import { ENABLEMENT_TIMES_KEY, isStructuralKey, SCRIPT_PREFIX } from './structural-keys.js';
import { identityKey, locationKey } from './script-keys.js';
import type { ParsedHeader } from '../userscript-header.js';
import { scanStorageRows } from './storage-scan.js';
import { dlog } from '../debug-log.js';

// The active times too: every enable re-reads them inside its lock,
// and from storage that read waits behind whatever else is reading it.
function isCachedKey(key: string): boolean {
  return isStructuralKey(key) || key === ENABLEMENT_TIMES_KEY;
}

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
  unindex(key);
  if (json === REMOVED) rows.delete(key);
  else {
    rows.set(key, deepFreeze(JSON.parse(json)));
    index(key);
  }
  applied.set(key, seq);
}

function drop(reason: string): void {
  if (rows) dlog(`[SourceMonkey] row cache dropped: ${reason}`);
  rows = null;
  applied.clear();
  byLocation.clear();
  byIdentity.clear();
  byCollection.clear();
  generation++;
}

// ---------- Indexes ----------
//
// Script ids by the two keys that make copies of one script related
// (script-identity.ts): the canonical location, and `@namespace` +
// `@name`. Kept with the rows, so they change exactly when a row does.

const byLocation = new Map<string, Set<string>>();
const byIdentity = new Map<string, Set<string>>();
// And by the collection each row names (`collectionId`), which isn't
// always one that lists it (see `reconcileScriptMembership`).
const byCollection = new Map<string, Set<string>>();

type IndexedRow = { id?: string; fileUrl?: string; header?: ParsedHeader | null; collectionId?: string };

function keysOf(row: IndexedRow): { location: string | null; identity: string | null } {
  return {
    location: typeof row.fileUrl === 'string' ? locationKey(row.fileUrl) : null,
    identity: identityKey(row.header ?? null),
  };
}

function addTo(map: Map<string, Set<string>>, key: string | null, id: string): void {
  if (key === null) return;
  let ids = map.get(key);
  if (!ids) map.set(key, ids = new Set());
  ids.add(id);
}

function removeFrom(map: Map<string, Set<string>>, key: string | null, id: string): void {
  if (key === null) return;
  const ids = map.get(key);
  if (!ids) return;
  ids.delete(id);
  if (ids.size === 0) map.delete(key);
}

function index(key: string): void {
  if (!key.startsWith(SCRIPT_PREFIX)) return;
  const row = rows?.get(key) as IndexedRow | undefined;
  if (!row?.id) return;
  const { location, identity } = keysOf(row);
  addTo(byLocation, location, row.id);
  addTo(byIdentity, identity, row.id);
  addTo(byCollection, row.collectionId ?? null, row.id);
}

function unindex(key: string): void {
  if (!key.startsWith(SCRIPT_PREFIX)) return;
  const row = rows?.get(key) as IndexedRow | undefined;
  if (!row?.id) return;
  const { location, identity } = keysOf(row);
  removeFrom(byLocation, location, row.id);
  removeFrom(byIdentity, identity, row.id);
  removeFrom(byCollection, row.collectionId ?? null, row.id);
}

// The ids of every script row naming collection `id`, loading the cache
// first if needed. Null when the cache isn't on in this context.
export async function scriptIdsInCollection(id: string): Promise<string[] | null> {
  if (!(await loaded())) return null;
  return [...(byCollection.get(id) ?? [])];
}

// The ids of every stored copy related to any of `scripts` (the same
// location, or the same `@namespace` + `@name`), themselves included,
// loading the cache first if needed. Null when the cache isn't on in
// this context: the caller scans the rows itself.
export async function relatedScriptIds(scripts: readonly IndexedRow[]): Promise<Set<string> | null> {
  if (!(await loaded())) return null;
  const out = new Set<string>();
  for (const script of scripts) {
    if (script.id) out.add(script.id);
    const { location, identity } = keysOf(script);
    for (const id of (location !== null && byLocation.get(location)) || []) out.add(id);
    for (const id of (identity !== null && byIdentity.get(identity)) || []) out.add(id);
  }
  return out;
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
// service worker at startup, before anything writes. Its change listener
// runs before every listener installed after it (one installed at module
// load, the popup's script cache, only drops entries). Nothing else
// turns the cache on, so pages and unit tests read storage as before.
//
// `checkWrite` sees the keys of every `set` first, and throws to refuse
// it: the store's check that script rows are written under its lock
// (`checkScriptRowWrite`).
export function installRowCache(checkWrite: (keys: readonly string[]) => void = () => undefined): void {
  if (installed) return;
  installed = true;
  const area = chrome.storage.local;
  const set = area.set.bind(area);
  const remove = area.remove.bind(area);
  const clear = area.clear.bind(area);

  area.set = ((items: Record<string, unknown>) => {
    try {
      checkWrite(Object.keys(items));
    } catch (err) {
      return Promise.reject(err);
    }
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
// on in this context, or a write kept landing during the load (three
// tries): the caller reads storage itself then, and the next read tries
// to load again. Under constant writes (a Refresh All) that is a scan
// per read until the writes pause.
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
        rows = new Map(Object.entries(read).map(([k, v]) => [k, deepFreeze(v)]));
        byLocation.clear();
        byIdentity.clear();
        byCollection.clear();
        for (const key of rows.keys()) index(key);
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

// Every cached row (index, collections, scripts, active times), as
// copies, likewise.
export async function allCachedRows(): Promise<Record<string, unknown> | null> {
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

// Every cached row whose key `keep` accepts, the frozen rows themselves
// rather than copies, loading the cache first if needed. Null when the
// cache isn't on in this context: the caller reads storage then.
export async function sharedRows(keep: (key: string) => boolean): Promise<Record<string, unknown> | null> {
  const all = await loaded();
  if (!all) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of all) if (keep(key)) out[key] = value;
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export function rowCacheLoadsForTests(): number {
  return loads;
}
