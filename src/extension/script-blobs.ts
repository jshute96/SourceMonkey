// Storage format 2: script rows without their bodies. Each body (a
// script's `bodyText`, each `@require` source, each `@resource`'s bytes)
// is a `blob:<sha256>` row, shared by every row whose body has the same
// bytes, and the script row points at it with a `BlobRef`. See
// docs/storage.md#content-blobs.
//
// This module converts between the two shapes:
//   - `toStorage`: a full `StoredScript` (bodies inline, as the rest of
//     the code uses it) → the small row plus the blobs it needs.
//   - `fromStorage`: small rows → full `StoredScript`s, reading their
//     blobs in one call.
// and runs the one-time migration of format 1 rows (bodies inline in
// storage too), and the cleanup of blobs no row points at any more.
//
// Both directions take each body as it finds it: one already inline (a
// format 1 row, or a full script handed to a write) stays as it is.

import { assertWorkerContext } from '../run-context.js';
import type { ScriptMeta, StoredScript } from '../script-build.js';
import type { StoredRequire, StoredResource } from '../external-files.js';
import { base64ToBytes, bytesToBase64, sha256Hex } from '../bytes.js';
import { SCRIPT_PREFIX } from './structural-keys.js';
import { scanAllStorage } from './storage-scan.js';
import { dlog } from '../debug-log.js';
import { formatMs } from '../phase-timing.js';

export const BLOB_PREFIX = 'blob:';
export const STORE_FORMAT_KEY = 'storeFormat';
export const STORE_FORMAT = 2;
export const blobKey = (hash: string) => `${BLOB_PREFIX}${hash}`;

// The stored body, at `blob:<hash>`. Readers accept either encoding, so
// a require and a resource with the same bytes can share one blob.
export interface StoredBlob {
  encoding: 'text' | 'base64';
  data: string;
}

// What a row holds to point at a blob.
export interface BlobRef {
  // SHA-256 hex of the bytes the blob decodes to: its key, minus `blob:`.
  hash: string;
  // Byte length of the content, not of what's stored.
  size: number;
}

export type StoredRequireRow = Omit<StoredRequire, 'source'> & { blobRef: BlobRef };
export type StoredResourceRow = Omit<StoredResource, 'bytesBase64'> & { blobRef: BlobRef };

// A `script:<id>` row as stored.
export type ScriptRow = Omit<StoredScript, 'bodyText' | 'requires' | 'resources'> & {
  bodyBlobRef?: BlobRef;
  requires?: StoredRequireRow[];
  resources?: StoredResourceRow[];
};

// Shown on a script whose row points at a blob that isn't there (or
// that this build can't decode). The cleanup that deletes unused blobs
// could cause it, racing a write that doesn't take the lock (see
// `sweepUnusedBlobs`); Refresh fetches the file again, as for one that
// failed to load.
export const MISSING_BLOB_MESSAGE =
  'Part of the stored copy of this script is missing. Refresh the script to load it again.';

const encoder = new TextEncoder();
// `ignoreBOM` keeps a leading U+FEFF: the blob's bytes are exactly what
// was stored, and a require reading a blob a resource wrote first must
// get back the same text the require itself would have stored.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

type Blobs = Map<string, StoredBlob>;

// The ref and stored data behind each object `fromStorage` built (a
// script, a require or resource entry), so writing it back unchanged
// doesn't hash its body again. Entries survive the `{...script}` copies
// the store's writers make; a script object often doesn't, and its body
// is hashed again then.
const knownRefs = new WeakMap<object, { data: string; ref: BlobRef }>();

// Lets `to` reuse the body ref `from` was read with, when its body is
// the same text: a refresh rebuilds a new script object whose body came
// from the copy it started from, and would otherwise hash it again.
export function carryBodyRef(from: object | undefined, to: StoredScript): void {
  const known = from ? knownRefs.get(from) : undefined;
  if (known && known.data === to.bodyText) knownRefs.set(to, known);
}

function reuse(owner: object, data: string, encoding: StoredBlob['encoding'], blobs: Blobs): BlobRef | null {
  const known = knownRefs.get(owner);
  if (known?.data !== data) return null;
  // Offered again: the write only stores it if it's gone.
  blobs.set(blobKey(known.ref.hash), { encoding, data });
  return known.ref;
}

async function textBlob(owner: object, text: string, blobs: Blobs): Promise<BlobRef> {
  const known = reuse(owner, text, 'text', blobs);
  if (known) return known;
  const bytes = encoder.encode(text);
  const hash = await sha256Hex(bytes);
  blobs.set(blobKey(hash), { encoding: 'text', data: text });
  return { hash, size: bytes.length };
}

async function base64Blob(owner: object, base64: string, blobs: Blobs): Promise<BlobRef> {
  const known = reuse(owner, base64, 'base64', blobs);
  if (known) return known;
  const bytes = base64ToBytes(base64);
  const hash = await sha256Hex(bytes);
  blobs.set(blobKey(hash), { encoding: 'base64', data: base64 });
  return { hash, size: bytes.byteLength };
}

// Does a stored row carry any body inline (format 1, or a full script
// handed to a write)?
export function hasInlineBodies(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Partial<StoredScript>;
  return typeof row.bodyText === 'string'
    || (row.requires ?? []).some((r) => typeof r.source === 'string')
    || (row.resources ?? []).some((r) => typeof r.bytesBase64 === 'string');
}

// A full script (or a format 1 row) → its small row, adding the blobs it
// needs to `blobs`. A body already in blob form passes through.
export async function toStorage(script: StoredScript | ScriptRow, blobs: Blobs): Promise<ScriptRow> {
  const { bodyText, requires, resources, ...rest } = script as StoredScript & Partial<ScriptRow>;
  const row: ScriptRow = { ...rest };
  // A row that never loaded has no body to point at (`size` is null
  // exactly then); every other row does, an empty body included.
  if (typeof bodyText === 'string' && (bodyText !== '' || script.size !== null)) {
    row.bodyBlobRef = await textBlob(script, bodyText, blobs);
  }
  if (requires) {
    row.requires = await Promise.all(requires.map(async (r) => {
      const { source, ...meta } = r as StoredRequire & Partial<StoredRequireRow>;
      return typeof source === 'string'
        ? { ...meta, blobRef: await textBlob(r, source, blobs) }
        : (r as unknown as StoredRequireRow);
    }));
  }
  if (resources) {
    row.resources = await Promise.all(resources.map(async (r) => {
      const { bytesBase64, ...meta } = r as StoredResource & Partial<StoredResourceRow>;
      return typeof bytesBase64 === 'string'
        ? { ...meta, blobRef: await base64Blob(r, bytesBase64, blobs) }
        : (r as unknown as StoredResourceRow);
    }));
  }
  return row;
}

// A blob's content in the form a reader wants, or null for an encoding
// this build doesn't know (written by a newer one), which reads like a
// missing blob rather than as garbage.
function blobText(blob: StoredBlob): string | null {
  if (blob.encoding === 'text') return blob.data;
  if (blob.encoding === 'base64') return decoder.decode(base64ToBytes(blob.data));
  return null;
}

function blobBase64(blob: StoredBlob): string | null {
  if (blob.encoding === 'base64') return blob.data;
  if (blob.encoding === 'text') return bytesToBase64(encoder.encode(blob.data));
  return null;
}

// The blob keys a stored row points at. A format 1 row has none.
export function blobKeysOf(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  const row = value as Partial<ScriptRow>;
  const keys: string[] = [];
  if (row.bodyBlobRef) keys.push(blobKey(row.bodyBlobRef.hash));
  for (const r of row.requires ?? []) if (r.blobRef) keys.push(blobKey(r.blobRef.hash));
  for (const r of row.resources ?? []) if (r.blobRef) keys.push(blobKey(r.blobRef.hash));
  return keys;
}

// A row whose blob is gone keeps its metadata but can't run. As an
// `invalid` row, the next refresh fetches it whatever its validators
// say; dropping them (or the file entry, which a refresh then fetches
// like a new one) is a backstop for that.
//
// Only readers that load bodies see this. The registration sync is one,
// and it saves the row this way (`markMissingBlobs`), so the readers of
// small rows (pages, the match index) see it from then on.
//
// A write of a full script built here stores it as it is: an invalid
// row with an empty body. That's consistent, and the refresh repairs it
// the same way.
function withMissingBlob<T extends ScriptMeta>(script: T, bodyMissing: boolean): T {
  const out: T = { ...script, status: 'invalid', errorMessage: MISSING_BLOB_MESSAGE };
  delete out.errorLocation;
  if (bodyMissing) {
    delete out.contentHash;
    delete out.fsMtime;
    delete out.httpEtag;
    delete out.httpLastModified;
  }
  return out;
}

function hydrate(row: ScriptRow, blobs: Record<string, unknown>): StoredScript {
  const get = (ref: BlobRef) => blobs[blobKey(ref.hash)] as StoredBlob | undefined;
  // `bodyText` is there only on a row with its body inline.
  const { bodyBlobRef, requires, resources, ...rest } = row as ScriptRow & { bodyText?: string };
  let missing = false;
  let bodyMissing = false;
  const script = { ...rest, bodyText: rest.bodyText ?? '' } as StoredScript;
  // An inline body wins over a ref: it's what a format 1 row, or a test
  // writing one, put there.
  if (typeof rest.bodyText !== 'string' && bodyBlobRef) {
    const blob = get(bodyBlobRef);
    const text = blob ? blobText(blob) : null;
    if (text === null) missing = bodyMissing = true;
    else {
      script.bodyText = text;
      knownRefs.set(script, { data: text, ref: bodyBlobRef });
    }
  }
  if (requires) {
    script.requires = requires.flatMap((r): StoredRequire[] => {
      const inline = r as unknown as StoredRequire;
      if (typeof inline.source === 'string' || !r.blobRef) return [inline];
      const blob = get(r.blobRef);
      const source = blob ? blobText(blob) : null;
      if (source === null) { missing = true; return []; }
      const { blobRef, ...meta } = r;
      const entry = { ...meta, source };
      knownRefs.set(entry, { data: source, ref: blobRef });
      return [entry];
    });
  }
  if (resources) {
    script.resources = resources.flatMap((r): StoredResource[] => {
      const inline = r as unknown as StoredResource;
      if (typeof inline.bytesBase64 === 'string' || !r.blobRef) return [inline];
      const blob = get(r.blobRef);
      const bytesBase64 = blob ? blobBase64(blob) : null;
      if (bytesBase64 === null) { missing = true; return []; }
      const { blobRef, ...meta } = r;
      const entry = { ...meta, bytesBase64 };
      knownRefs.set(entry, { data: bytesBase64, ref: blobRef });
      return [entry];
    });
  }
  return missing ? withMissingBlob(script, bodyMissing) : script;
}

// A stored row as reading it shows when a blob it points at is missing
// or unreadable (see `withMissingBlob`), for saving it that way; null
// when all of its blobs are there. `blobs` holds what's stored under
// the row's blob keys. Bodies inline on the row (format 1) count as
// there.
export function markMissingBlobs(row: ScriptRow, blobs: Record<string, unknown>): ScriptRow | null {
  const there = (ref: BlobRef | undefined): boolean => {
    if (!ref) return true;
    const blob = blobs[blobKey(ref.hash)] as StoredBlob | undefined;
    return blob?.encoding === 'text' || blob?.encoding === 'base64';
  };
  const bodyMissing = typeof (row as { bodyText?: unknown }).bodyText !== 'string' && !there(row.bodyBlobRef);
  const requires = row.requires?.filter((r) => there(r.blobRef));
  const resources = row.resources?.filter((r) => there(r.blobRef));
  if (!bodyMissing && requires?.length === row.requires?.length && resources?.length === row.resources?.length) {
    return null;
  }
  const out = withMissingBlob({ ...row }, bodyMissing);
  if (requires) out.requires = requires;
  if (resources) out.resources = resources;
  return out;
}

// Small rows → full scripts. `have` is blobs the caller already read
// (a whole-store scan has them all); the rest are read in one call.
export async function fromStorage(
  rows: readonly ScriptRow[],
  have: Record<string, unknown> = {},
): Promise<StoredScript[]> {
  const need = [...new Set(rows.flatMap(blobKeysOf))].filter((k) => !(k in have));
  const blobs = need.length > 0 ? { ...have, ...await chrome.storage.local.get(need) } : have;
  return rows.map((row) => hydrate(row, blobs));
}

// In place over a `get` result: every `script:` value becomes a full
// script. For readers that take rows by key from a mixed read.
export async function hydrateScriptRows(got: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = Object.keys(got).filter((k) => k.startsWith(SCRIPT_PREFIX) && got[k] != null);
  if (keys.length === 0) return got;
  const full = await fromStorage(keys.map((k) => got[k] as ScriptRow), got);
  keys.forEach((k, i) => { got[k] = full[i]; });
  return got;
}

// A write's items with every full `script:` value split into its small
// row plus blobs. A blob already stored isn't written again: same key,
// same bytes. Rows and their blobs go out in the caller's one `set`, so
// no reader sees a row before its blobs.
export async function withBlobs(items: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = Object.keys(items).filter((k) => k.startsWith(SCRIPT_PREFIX) && hasInlineBodies(items[k]));
  if (keys.length === 0) return items;
  const blobs: Blobs = new Map();
  const out: Record<string, unknown> = { ...items };
  for (const k of keys) out[k] = await toStorage(items[k] as StoredScript, blobs);
  return { ...out, ...newBlobItems(blobs, new Set(await chrome.storage.local.getKeys())) };
}

// A full script's stored form: its small row, and the blobs it points
// at. For a writer that compares the row with what's stored before
// deciding to write: it then writes the row and the blobs not yet
// stored, rather than the full script, which `withBlobs` would hash
// again.
export async function storedForm(script: StoredScript): Promise<{ row: ScriptRow; blobs: Blobs }> {
  const blobs: Blobs = new Map();
  return { row: await toStorage(script, blobs), blobs };
}

// The blobs among `blobs` whose keys aren't in `stored` (the keys in
// storage), as items for a `set`. A stored one has the same bytes under
// the same key, so it isn't written again.
export function newBlobItems(
  blobs: ReadonlyMap<string, StoredBlob>,
  stored: ReadonlySet<string>,
): Record<string, StoredBlob> {
  const out: Record<string, StoredBlob> = {};
  for (const [k, blob] of blobs) if (!stored.has(k)) out[k] = blob;
  return out;
}

// What the given scripts' rows take in storage, without their bodies,
// as Chrome counts it: what a metadata read of them loads. For debug
// timing lines.
export async function scriptRowBytes(scriptIds: readonly string[]): Promise<number> {
  if (scriptIds.length === 0) return 0;
  return await chrome.storage.local.getBytesInUse(scriptIds.map((id) => SCRIPT_PREFIX + id));
}

// ---------- Migration from format 1 ----------

// Rows per `set`. Each call replaces its rows' inline bodies with blobs,
// so storage use barely moves within one call, and an interrupted run
// keeps what earlier calls converted.
export const MIGRATE_BATCH = 25;

// Set in session storage when a run fails, so a store too full to
// convert isn't rescanned on every worker wake. The next browser
// session tries again.
const MIGRATION_FAILED_KEY = 'storeFormatMigrationFailed';

// Converts every format 1 row, then records format 2. Safe to re-run:
// converted rows are skipped. Only the service worker runs it, before
// anything else there writes (see `storeFormatReady` in script-store).
//
// Logged in full whenever it moves anything, since that's once per
// profile; finding nothing to move, at each worker start or on a new
// profile, only with debug logging on.
export async function migrateToBlobs(): Promise<void> {
  const format = (await chrome.storage.local.get(STORE_FORMAT_KEY))[STORE_FORMAT_KEY];
  if (typeof format === 'number' && format >= STORE_FORMAT) {
    dlog('[SourceMonkey] storage format 2: already in place');
    return;
  }
  if ((await chrome.storage.session.get(MIGRATION_FAILED_KEY))[MIGRATION_FAILED_KEY]) {
    console.info('[SourceMonkey] storage format 2: not moving script bodies again until the browser restarts, since it failed earlier');
    return;
  }
  const started = performance.now();
  let moved = 0;
  let written = 0;
  try {
    const all = await scanAllStorage('blob migration');
    const stored = new Set(Object.keys(all));
    const old = Object.entries(all).filter(([k, v]) => k.startsWith(SCRIPT_PREFIX) && hasInlineBodies(v));
    if (old.length > 0) {
      console.info(`[SourceMonkey] storage format 2: moving the bodies of ${old.length} script(s) to shared storage`);
    }
    for (let i = 0; i < old.length; i += MIGRATE_BATCH) {
      const blobs: Blobs = new Map();
      const items: Record<string, unknown> = {};
      const batch = old.slice(i, i + MIGRATE_BATCH);
      for (const [k, v] of batch) items[k] = await toStorage(v as StoredScript, blobs);
      let fresh = 0;
      for (const [k, blob] of blobs) {
        if (stored.has(k)) continue;
        items[k] = blob;
        stored.add(k);
        fresh++;
      }
      assertWorkerContext('write storage');
      await chrome.storage.local.set(items);
      moved += batch.length;
      written += fresh;
    }
    await chrome.storage.local.set({ [STORE_FORMAT_KEY]: STORE_FORMAT });
    if (old.length === 0) {
      // A new profile, or one whose rows were all converted already.
      dlog('[SourceMonkey] storage format 2: no script bodies to move');
    } else {
      console.info(
        `[SourceMonkey] storage format 2: moved ${moved} script(s), ${written} stored file(s), `
        + `in ${formatMs(performance.now() - started)}`,
      );
    }
  } catch (err) {
    console.info(
      `[SourceMonkey] storage format 2: stopped after moving ${moved} script(s), ${written} stored file(s); `
      + 'the rest stay as they were until the browser restarts',
    );
    await chrome.storage.session.set({ [MIGRATION_FAILED_KEY]: true });
    throw err;
  }
}

// Only for the test surface: forget a failed run, as a new browser
// session would.
export async function clearMigrationFailureForTests(): Promise<void> {
  await chrome.storage.session.remove(MIGRATION_FAILED_KEY);
}

// ---------- Cleanup ----------
//
// A blob no row points at goes once it's been unused on two checks at
// least `SWEEP_GRACE_MS` apart. One check isn't enough: each context
// has its own write lock, so a page could be saving a row that points
// at a blob (one it found already stored, so it isn't writing it) just
// as the worker decides that blob is unused. The wait leaves such a
// write time to land. The service worker is the only context that
// sweeps.

export const SWEEP_GRACE_MS = 2 * 60_000;

// Session storage: blob key → when a check first found it unused. Kept
// there, not in memory, because the worker is often stopped between
// two checks.
const SWEEP_CANDIDATES_KEY = 'blobSweepCandidates';

export interface SweepResult {
  checked: number;
  removed: number;
  // Unused blobs not yet old enough to go: the caller checks again.
  waiting: number;
}

export async function sweepUnusedBlobs(now = Date.now()): Promise<SweepResult> {
  const keys = await chrome.storage.local.getKeys();
  const blobKeys = keys.filter((k) => k.startsWith(BLOB_PREFIX));
  const prior = ((await chrome.storage.session.get(SWEEP_CANDIDATES_KEY))[SWEEP_CANDIDATES_KEY] ?? {}) as Record<string, number>;
  if (blobKeys.length === 0) {
    if (Object.keys(prior).length > 0) await chrome.storage.session.remove(SWEEP_CANDIDATES_KEY);
    return { checked: 0, removed: 0, waiting: 0 };
  }
  // The small rows only: refs are all a check needs.
  const rows = await chrome.storage.local.get(keys.filter((k) => k.startsWith(SCRIPT_PREFIX)));
  const used = new Set(Object.values(rows).flatMap(blobKeysOf));
  const next: Record<string, number> = {};
  const remove: string[] = [];
  for (const k of blobKeys) {
    if (used.has(k)) continue;
    const since = prior[k];
    if (since !== undefined && now - since >= SWEEP_GRACE_MS) remove.push(k);
    else next[k] = since ?? now;
  }
  assertWorkerContext('write storage');
  if (remove.length > 0) await chrome.storage.local.remove(remove);
  // Unchanged most of the time; a write would still fire
  // `storage.onChanged` in every open page.
  const same = Object.keys(next).length === Object.keys(prior).length
    && Object.entries(next).every(([k, t]) => prior[k] === t);
  if (!same) await chrome.storage.session.set({ [SWEEP_CANDIDATES_KEY]: next });
  return { checked: blobKeys.length, removed: remove.length, waiting: Object.keys(next).length };
}

// Are there unused blobs a check found that haven't been deleted yet?
// A worker starting up sweeps only then: blobs left unused while it ran
// are what this records, and a change since schedules its own check.
export async function hasSweepCandidates(): Promise<boolean> {
  const got = (await chrome.storage.session.get(SWEEP_CANDIDATES_KEY))[SWEEP_CANDIDATES_KEY];
  return got != null && typeof got === 'object' && Object.keys(got).length > 0;
}

// Did a change to a script row leave a blob it pointed at unused by it:
// a removed row, or one now pointing elsewhere? The worker's cue to
// sweep.
export function droppedBlobRefs(oldValue: unknown, newValue: unknown): boolean {
  const before = blobKeysOf(oldValue);
  if (before.length === 0) return false;
  const after = new Set(blobKeysOf(newValue));
  return before.some((k) => !after.has(k));
}
