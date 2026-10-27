// The worker's one store for `GM_setValue` values: every read and write
// of a script's values in the worker goes through here, so what it
// hands out always includes every write it has accepted, whether or
// not that write has reached disk yet.
//
// - State: each script's whole value map, read from storage the first
//   time it's needed and kept until the worker shuts down.
// - Writes change the map at once and get a sequence number, then go
//   to disk behind it: one `chrome.storage.local` write in flight per
//   script, with writes arriving meanwhile combined into the next one.
// - Sequence numbers are how documents order what they hear about a
//   key (their own write's reply, other tabs' broadcasts, snapshots).
//   They come from one counter, started from the clock, so a later
//   worker's numbers are above an earlier one's unless the clock has
//   stepped back by more than the earlier worker's lifetime (TODO.md).
//
// `gm-values.ts` is the row layer underneath; nothing else in the
// worker may use it for values (`tests/unit/value-store.test.mjs`).
// See docs/GM-APIs-storage.md.

import {
  applyBatchValues,
  countStoredValues,
  DELETED_SENTINEL,
  loadAllValues,
  wipeScriptValues,
  type ValueWrite,
} from './gm-values.js';

// One write as it crosses the port: a value, or a delete.
export interface WireValueWrite {
  key: string;
  value?: unknown;
  deleted?: boolean;
}

// A script's values as of one sequence number: every write numbered at
// or below `seq` is in `values`, and none above it.
export interface ValueSnapshot {
  values: Record<string, unknown>;
  seq: number;
}

// Microseconds since the epoch at worker start: a worker would need a
// million writes a second, sustained, to run into its successor's
// numbers. Well inside a double's exact integers.
let lastSeq = Date.now() * 1000;
// Numbers at or below this were handed out by an earlier worker, whose
// writes this one knows nothing about.
const workerStartSeq = lastSeq;

function nextSeq(): number {
  return ++lastSeq;
}

const DELETED: unique symbol = Symbol('sm:value-deleted');

interface ScriptValues {
  // The live map; null until loaded.
  values: Map<string, unknown> | null;
  loading: Promise<Map<string, unknown>> | null;
  // Changes not yet handed to storage, by key; the latest wins.
  unsaved: Map<string, unknown>;
  // The storage write in flight, if any.
  saving: Promise<void> | null;
  // The number of the last write or wipe, 0 for none in this worker.
  lastChange: number;
  // A save failed and was reported; cleared by the next one that works.
  saveFailed: boolean;
}

let scripts = new Map<string, ScriptValues>();

function stateFor(scriptId: string): ScriptValues {
  let st = scripts.get(scriptId);
  if (!st) {
    st = { values: null, loading: null, unsaved: new Map(), saving: null, lastChange: 0, saveFailed: false };
    scripts.set(scriptId, st);
  }
  return st;
}

// The script's map, loading it on first use. Callers that arrive while
// it loads share the load, and resume in the order they asked.
async function loaded(scriptId: string, st: ScriptValues): Promise<Map<string, unknown>> {
  if (st.values) return st.values;
  if (!st.loading) {
    const load = loadAllValues(scriptId).then(
      (obj) => {
        // A reset while this read was out leaves `st` orphaned; the
        // caller still gets the map, but nothing new lands in it.
        st.values = new Map(Object.entries(obj));
        st.loading = null;
        return st.values;
      },
      (err) => {
        st.loading = null;
        throw err;
      },
    );
    st.loading = load;
  }
  return st.loading;
}

// The script's values and the sequence number they're current to.
export async function readValues(scriptId: string): Promise<ValueSnapshot> {
  const map = await loaded(scriptId, stateFor(scriptId));
  return { values: Object.fromEntries(map), seq: lastSeq };
}

// Whether a script's values may have changed after sequence number
// `seq`. True when `seq` predates this worker, which can't say.
export function valuesChangedSince(scriptId: string, seq: number): boolean {
  if (seq <= workerStartSeq) return true;
  return (scripts.get(scriptId)?.lastChange ?? 0) > seq;
}

// A script's values, without keeping a map loaded for it: the loaded
// map when there is one, which holds writes not yet saved, else a read
// of storage. For reading many scripts at once (the backup export).
export async function peekValues(scriptId: string): Promise<Record<string, unknown>> {
  const st = scripts.get(scriptId);
  if (st?.values) return Object.fromEntries(st.values);
  if (st?.loading) return Object.fromEntries(await st.loading);
  return loadAllValues(scriptId);
}

// How many values a script has, without keeping a map loaded for it.
export async function countValues(scriptId: string): Promise<number> {
  const st = scripts.get(scriptId);
  if (st?.values) return st.values.size;
  if (st?.loading) return (await st.loading).size;
  return countStoredValues(scriptId);
}

// Told when a script's values can't be saved (`save`), or loaded to
// take a write (`load`), once until a save works again. The worker
// logs it on the script (`background.ts`).
export type ValueFailureKind = 'save' | 'load';
type SaveFailureHandler = (scriptId: string, err: unknown, kind: ValueFailureKind) => void;
let onSaveFailed: SaveFailureHandler = () => undefined;
export function onValueSaveFailed(handler: SaveFailureHandler): void {
  onSaveFailed = handler;
}

// Apply one document's writes, in order, and return their sequence
// number. The map changes before this returns; disk follows.
export async function writeValues(
  scriptId: string,
  writes: readonly WireValueWrite[],
): Promise<number> {
  const st = stateFor(scriptId);
  let map: Map<string, unknown>;
  try {
    map = await loaded(scriptId, st);
  } catch (err) {
    // No map to apply them to, so the writes are refused: the page
    // hears so in the reply, and the script's Log the same way as a
    // failed save.
    console.info(`[SourceMonkey] Reading stored values for script ${scriptId} failed, so its writes were not saved:`, err);
    reportSaveFailure(st, scriptId, err, 'load');
    throw err;
  }
  const seq = nextSeq();
  st.lastChange = seq;
  for (const w of writes) {
    if (w.deleted) {
      map.delete(w.key);
      st.unsaved.set(w.key, DELETED);
    } else {
      map.set(w.key, w.value);
      st.unsaved.set(w.key, w.value);
    }
  }
  // Only with something to save. With nothing, the loop would finish
  // before this assignment, so `saving` would keep its settled promise
  // and `valueWritesSaved` (and `wipeValues`) would wait on it forever.
  if (!st.saving && st.unsaved.size > 0) st.saving = saveLoop(scriptId, st);
  return seq;
}

function reportSaveFailure(st: ScriptValues, scriptId: string, err: unknown, kind: ValueFailureKind): void {
  if (st.saveFailed) return;
  st.saveFailed = true;
  onSaveFailed(scriptId, err, kind);
}

// Hands `unsaved` to storage until it stays empty. Started only with
// something to save, so the first `await` comes before it can finish
// and clear `saving`.
async function saveLoop(scriptId: string, st: ScriptValues): Promise<void> {
  try {
    while (st.unsaved.size > 0) {
      const batch = st.unsaved;
      st.unsaved = new Map();
      const writes: ValueWrite[] = [];
      for (const [key, value] of batch) {
        writes.push({ key, value: value === DELETED ? DELETED_SENTINEL : value });
      }
      try {
        await applyBatchValues(scriptId, writes);
        st.saveFailed = false;
      } catch (err) {
        // Most likely the storage quota. The documents running the
        // script, and this map, keep the values until the worker shuts
        // down; only disk is behind. Not `console.warn`: see CLAUDE.md.
        console.info(`[SourceMonkey] Saving stored values for script ${scriptId} failed:`, err);
        reportSaveFailure(st, scriptId, err, 'save');
      }
    }
  } finally {
    st.saving = null;
  }
}

// Remove all of a script's values, saved and unsaved.
export async function wipeValues(scriptId: string): Promise<number> {
  const st = stateFor(scriptId);
  // Let a load or save in flight finish first, so neither can put
  // values back.
  if (st.loading) await st.loading.catch(() => undefined);
  while (st.saving) await st.saving;
  st.unsaved.clear();
  st.values = new Map();
  st.lastChange = nextSeq();
  return wipeScriptValues(scriptId);
}

// Saves still running for states `forgetLoadedValues` dropped.
const forgottenSaves = new Set<Promise<void>>();

// Resolves once every accepted write is on disk.
export async function valueWritesSaved(): Promise<void> {
  for (;;) {
    const pending = [
      ...[...scripts.values()].map((st) => st.saving).filter((p) => p != null),
      ...forgottenSaves,
    ];
    if (pending.length === 0) return;
    await Promise.all(pending);
  }
}

// Tests only: forget every loaded map, after something changed
// `gmval:` rows behind the store's back (clearing or seeding storage).
export function forgetLoadedValues(): void {
  // Their saves still land, so `valueWritesSaved` keeps waiting for them.
  for (const st of scripts.values()) {
    const saving = st.saving;
    if (!saving) continue;
    forgottenSaves.add(saving);
    void saving.finally(() => forgottenSaves.delete(saving));
  }
  scripts = new Map();
}
