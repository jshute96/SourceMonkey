// Where `chrome.storage.local` goes, script by script and file by file,
// for the storage debug page (src/extension/debug/storage.ts). Pure:
// takes the rows a `get(null)` read returns.
//
// Sizes are measured as storage-usage.ts measures them (key + JSON
// value, in UTF-8 bytes), so they agree with the Options page's table.
//
// What a script's storage is made of:
//   - `script`: its body, a `blob:` row (docs/storage.md#content-blobs).
//   - `metadata`: the `script:<id>` row itself, without any body.
//   - `require` / `resource`: each file, a `blob:` row.
//   - For a script sm-dev pushed (a scratch script): sm-dev's copy of
//     its text, and each file it pushed from disk.
// A body still inline in a format 1 row (not yet migrated) is counted
// as its own file, and taken out of the row's metadata.

import { blobKey, BLOB_PREFIX } from './script-blobs.js';
import { collectionKey, SCRIPT_PREFIX } from './structural-keys.js';
import { VALUE_PREFIX as GM_VALUE_PREFIX } from './gm-values.js';
import {
  IMPORT_INFO_KEY_PREFIX,
  importInfoKey,
  isImportedUrl,
  isStoredTextUrl,
  SCRATCH_FILES_KEY_PREFIX,
  SCRATCH_SOURCE_KEY_PREFIX,
  SCRATCH_TEXT_KEY_PREFIX,
  scratchFilesKey,
  scratchSourceKey,
  scratchTextKey,
} from './location-kinds.js';
import { effectiveDisplayName } from './collection-display.js';
import { compareScriptNames, displayLocation, scriptDisplayName } from '../script-display.js';
import { jsonBytes, rowBytes } from './storage-usage.js';
import type { StoredCollection } from './script-store.js';
import type { ParsedHeader } from '../userscript-header.js';

export type ItemKind = 'script' | 'metadata' | 'require' | 'resource' | 'smdev-text' | 'smdev-file' | 'imported-text' | 'imported-file';

// The script a part of storage belongs to.
export interface ScriptRef {
  scriptId: string;
  // '' when the script's collection row is missing.
  collectionId: string;
  collectionName: string;
  scriptName: string;
}

// One part of a script's storage.
export interface StorageItem {
  kind: ItemKind;
  // The `@resource` name.
  name?: string;
  // Readable location of the file; absent for `metadata` and the text kinds.
  location?: string;
  bytes: number;
  // A `blob:` row the script points at that isn't in storage.
  missing?: boolean;
  // How many uses there are of the stored file this item is: 1 when
  // it's the only one. Always 1 for `metadata`.
  shared: number;
}

export interface ScriptEntry extends ScriptRef {
  // Sum of the items: a shared file counts in full under each script.
  bytes: number;
  // Largest `shared` among the items, for sorting by shared copies.
  shared: number;
  items: StorageItem[];
}

export interface FileUse extends ScriptRef {
  kind: ItemKind;
  name?: string;
  location?: string;
}

// One stored file, with every script that uses it. Mostly `blob:`
// rows; a body stored anywhere else (sm-dev's rows, a format 1 row's
// inline body) is a file of its own, keyed by where it is.
//
// `uses` is empty for a row no script uses: a blob left by a remove or
// a replaced body until cleanup deletes it, or sm-dev rows whose
// script is gone.
export interface FileEntry {
  key: string;
  bytes: number;
  uses: FileUse[];
  // A `blob:` row scripts point at that isn't in storage. Sized from
  // the scripts' refs, and not counted as stored.
  missing?: boolean;
}

export interface ValueEntry {
  scriptId: string;
  // Absent when the script's row is gone.
  script?: ScriptRef;
  bytes: number;
  count: number;
}

export interface StorageBreakdown {
  scripts: ScriptEntry[];
  // Files some script uses. Metadata isn't a file, so it's not here.
  files: FileEntry[];
  unused: FileEntry[];
  values: ValueEntry[];
}

interface BlobRefLike { hash?: unknown; size?: unknown }

interface ScriptRowLike {
  collectionId?: unknown;
  relativePath?: unknown;
  fileUrl?: unknown;
  header?: ParsedHeader | null;
  bodyText?: unknown;
  bodyBlobRef?: BlobRefLike;
  requires?: Array<{ url?: unknown; source?: unknown; blobRef?: BlobRefLike }>;
  resources?: Array<{ name?: unknown; url?: unknown; bytesBase64?: unknown; blobRef?: BlobRefLike }>;
}

const SCRATCH_PREFIXES = [SCRATCH_TEXT_KEY_PREFIX, SCRATCH_FILES_KEY_PREFIX, SCRATCH_SOURCE_KEY_PREFIX, IMPORT_INFO_KEY_PREFIX];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function buildStorageBreakdown(rows: Record<string, unknown>): StorageBreakdown {
  // File key → its size and uses. A blob's key is its row key; a body
  // stored anywhere else is unique, keyed by where it is.
  const files = new Map<string, FileEntry>();
  const addUse = (key: string, item: Omit<StorageItem, 'shared'>, use: FileUse): void => {
    const entry = files.get(key);
    if (entry) entry.uses.push(use);
    else files.set(key, { key, bytes: item.bytes, uses: [use], ...(item.missing ? { missing: true } : {}) });
  };
  // A blob's size is its row's. A ref to a missing blob is sized from
  // the ref (its content's length, not what storing it would take), so
  // the script still shows roughly what it's meant to hold.
  const blobSize = (ref: BlobRefLike): { bytes: number; missing?: boolean } => {
    const key = blobKey(str(ref.hash));
    if (key in rows) return { bytes: rowBytes(key, rows[key]) };
    return { bytes: typeof ref.size === 'number' ? ref.size : 0, missing: true };
  };
  // sm-dev rows some script accounts for; the rest are leftovers.
  const claimedScratch = new Set<string>();

  const collectionNames = new Map<string, string>();
  const collectionName = (id: string): string => {
    let name = collectionNames.get(id);
    if (name === undefined) {
      const c = rows[collectionKey(id)] as StoredCollection | undefined;
      name = c ? effectiveDisplayName(c) : '';
      collectionNames.set(id, name);
    }
    return name;
  };

  // Per script: its ref and the file keys of its items, in order.
  const scriptRefs = new Map<string, ScriptRef>();
  const pending: Array<{ ref: ScriptRef; items: Array<{ item: Omit<StorageItem, 'shared'>; key?: string }> }> = [];

  for (const [rowKey, value] of Object.entries(rows)) {
    if (!rowKey.startsWith(SCRIPT_PREFIX) || !value || typeof value !== 'object') continue;
    const row = value as ScriptRowLike;
    const collectionId = str(row.collectionId);
    const relativePath = str(row.relativePath);
    const ref: ScriptRef = {
      scriptId: rowKey.slice(SCRIPT_PREFIX.length),
      collectionId: collectionId && collectionKey(collectionId) in rows ? collectionId : '',
      collectionName: collectionName(collectionId),
      scriptName: scriptDisplayName({ header: row.header ?? null, relativePath }),
    };
    scriptRefs.set(ref.scriptId, ref);
    const items: Array<{ item: Omit<StorageItem, 'shared'>; key?: string }> = [];
    const use = (item: Omit<StorageItem, 'shared'>, key: string): void => {
      items.push({ item, key });
      addUse(key, item, { ...ref, kind: item.kind, name: item.name, location: item.location });
    };
    // Bodies inline in the row come out of its metadata.
    let inline = 0;

    const scriptLocation = displayLocation(str(row.fileUrl) || relativePath);
    if (typeof row.bodyBlobRef?.hash === 'string') {
      use({ kind: 'script', location: scriptLocation, ...blobSize(row.bodyBlobRef) },
        BLOB_PREFIX + row.bodyBlobRef.hash);
    } else if (typeof row.bodyText === 'string') {
      const bytes = jsonBytes(row.bodyText);
      inline += bytes;
      use({ kind: 'script', location: scriptLocation, bytes }, `${rowKey}#body`);
    }
    const requires = Array.isArray(row.requires) ? row.requires : [];
    requires.forEach((r, i) => {
      const location = displayLocation(str(r.url));
      if (typeof r.blobRef?.hash === 'string') {
        use({ kind: 'require', location, ...blobSize(r.blobRef) }, BLOB_PREFIX + r.blobRef.hash);
      } else if (typeof r.source === 'string') {
        const bytes = jsonBytes(r);
        inline += bytes;
        use({ kind: 'require', location, bytes }, `${rowKey}#require${i}`);
      }
    });
    const resources = Array.isArray(row.resources) ? row.resources : [];
    resources.forEach((r, i) => {
      const name = str(r.name);
      const location = displayLocation(str(r.url));
      if (typeof r.blobRef?.hash === 'string') {
        use({ kind: 'resource', name, location, ...blobSize(r.blobRef) }, BLOB_PREFIX + r.blobRef.hash);
      } else if (typeof r.bytesBase64 === 'string') {
        const bytes = jsonBytes(r);
        inline += bytes;
        use({ kind: 'resource', name, location, bytes }, `${rowKey}#resource${i}`);
      }
    });
    items.push({ item: { kind: 'metadata', bytes: Math.max(0, rowBytes(rowKey, value) - inline) } });

    // The rows of a script whose only copy is in storage: its text
    // (with the record of where it came from: on disk for a scratch
    // script, the file for an imported one), and its pushed files.
    if (isStoredTextUrl(relativePath)) {
      const imported = isImportedUrl(relativePath);
      const textKey = scratchTextKey(relativePath);
      const sourceKey = imported ? importInfoKey(relativePath) : scratchSourceKey(relativePath);
      const filesKey = scratchFilesKey(relativePath);
      for (const key of [textKey, sourceKey, filesKey]) claimedScratch.add(key);
      if (textKey in rows || sourceKey in rows) {
        const bytes = (textKey in rows ? rowBytes(textKey, rows[textKey]) : 0)
          + (sourceKey in rows ? rowBytes(sourceKey, rows[sourceKey]) : 0);
        use({ kind: imported ? 'imported-text' : 'smdev-text', bytes }, textKey);
      }
      const pushed = rows[filesKey];
      if (pushed && typeof pushed === 'object') {
        for (const [fileRef, file] of Object.entries(pushed as Record<string, { url?: unknown }>)) {
          // The entry's share of the row: its key and its value.
          const bytes = jsonBytes(fileRef) + 1 + jsonBytes(file);
          use({ kind: imported ? 'imported-file' : 'smdev-file', location: displayLocation(str(file?.url) || fileRef), bytes },
            `${filesKey}#${fileRef}`);
        }
      }
    }
    pending.push({ ref, items });
  }

  const scripts: ScriptEntry[] = pending.map(({ ref, items }) => {
    const full = items.map(({ item, key }) => ({
      ...item,
      shared: key === undefined ? 1 : files.get(key)!.uses.length,
    }));
    return {
      ...ref,
      bytes: full.reduce((sum, it) => sum + it.bytes, 0),
      shared: Math.max(1, ...full.map((it) => it.shared)),
      items: full,
    };
  });

  const unused: FileEntry[] = [];
  const values = new Map<string, ValueEntry>();
  for (const [key, value] of Object.entries(rows)) {
    if (key.startsWith(BLOB_PREFIX)) {
      if (!files.has(key)) unused.push({ key, bytes: rowBytes(key, value), uses: [] });
    } else if (SCRATCH_PREFIXES.some((p) => key.startsWith(p))) {
      if (!claimedScratch.has(key)) unused.push({ key, bytes: rowBytes(key, value), uses: [] });
    } else if (key.startsWith(GM_VALUE_PREFIX)) {
      // `gmval:<scriptId>:<name>`
      const scriptId = key.slice(GM_VALUE_PREFIX.length).split(':', 1)[0];
      let entry = values.get(scriptId);
      if (!entry) {
        entry = { scriptId, script: scriptRefs.get(scriptId), bytes: 0, count: 0 };
        values.set(scriptId, entry);
      }
      entry.bytes += rowBytes(key, value);
      entry.count++;
    }
  }

  return { scripts, files: [...files.values()], unused, values: [...values.values()] };
}

// What a file group's heading shows: the kind when every use is the
// same kind, and then the `@resource` name and the location wherever
// those agree too. Whatever the heading leaves out, each use shows on
// its own line. Mixed kinds put everything on the lines.
export interface FileIdentity {
  kind: ItemKind | null;
  sameName: boolean;
  sameLocation: boolean;
  name?: string;
  location?: string;
}

export function fileIdentity(file: FileEntry): FileIdentity {
  const [first, ...rest] = file.uses;
  if (!first || rest.some((u) => u.kind !== first.kind)) {
    return { kind: null, sameName: false, sameLocation: false };
  }
  return {
    kind: first.kind,
    sameName: rest.every((u) => u.name === first.name),
    sameLocation: rest.every((u) => u.location === first.location),
    name: first.name,
    location: first.location,
  };
}

// ---------- Sorting ----------
//
// The page's tables sort by a column; ties go to the collection name,
// then the script name, always A to Z.

export type SortKey = 'collection' | 'script' | 'size' | 'shared' | 'count';
export type SortDir = 'asc' | 'desc';

// Numbers start largest first; names start A to Z.
export function defaultSortDir(key: SortKey): SortDir {
  return key === 'collection' || key === 'script' ? 'asc' : 'desc';
}

interface Sortable {
  collectionName: string;
  scriptName: string;
  bytes: number;
  shared: number;
  count: number;
}

type Named = Pick<Sortable, 'collectionName' | 'scriptName'>;

function compareNames(a: Named, b: Named): number {
  return compareScriptNames(a.collectionName, b.collectionName) || compareScriptNames(a.scriptName, b.scriptName);
}

function compareBy(key: SortKey, dir: SortDir): (a: Sortable, b: Sortable) => number {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    let c = 0;
    if (key === 'collection') c = compareScriptNames(a.collectionName, b.collectionName);
    else if (key === 'script') c = compareScriptNames(a.scriptName, b.scriptName);
    else if (key === 'size') c = a.bytes - b.bytes;
    else if (key === 'shared') c = a.shared - b.shared;
    else c = a.count - b.count;
    return sign * c || compareNames(a, b);
  };
}

const KIND_ORDER: ItemKind[] = ['script', 'require', 'resource', 'smdev-text', 'smdev-file', 'imported-text', 'imported-file', 'metadata'];

// Scripts by the column; each script's items largest first.
export function sortScripts(scripts: ScriptEntry[], key: SortKey, dir: SortDir): ScriptEntry[] {
  const cmp = compareBy(key, dir);
  return scripts
    .map((s) => ({
      ...s,
      items: [...s.items].sort((a, b) =>
        b.bytes - a.bytes
        || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
        || (a.location ?? '').localeCompare(b.location ?? '')),
    }))
    .sort((a, b) => cmp({ ...a, count: 0 }, { ...b, count: 0 }));
}

// Files sort only by size or shared copies: a file has no one
// collection or script to sort by. Ties go to the other of the two,
// largest first, then to the first use's collection and script. Each
// file's uses are listed by collection, then script.
export function sortFiles(files: FileEntry[], key: 'size' | 'shared', dir: SortDir): FileEntry[] {
  const sign = dir === 'asc' ? 1 : -1;
  const size = (a: FileEntry, b: FileEntry) => a.bytes - b.bytes;
  const shared = (a: FileEntry, b: FileEntry) => a.uses.length - b.uses.length;
  const [primary, secondary] = key === 'size' ? [size, shared] : [shared, size];
  const firstUse = (f: FileEntry): Named => f.uses[0] ?? { collectionName: '', scriptName: '' };
  return files
    .map((f) => ({ ...f, uses: [...f.uses].sort(compareNames) }))
    .sort((a, b) =>
      sign * primary(a, b)
      || -secondary(a, b)
      || compareNames(firstUse(a), firstUse(b))
      || a.key.localeCompare(b.key));
}

export function sortValues(values: ValueEntry[], key: SortKey, dir: SortDir): ValueEntry[] {
  const asSortable = (v: ValueEntry): Sortable => ({
    collectionName: v.script?.collectionName ?? '',
    scriptName: v.script?.scriptName ?? v.scriptId,
    bytes: v.bytes,
    shared: 0,
    count: v.count,
  });
  const cmp = compareBy(key, dir);
  return [...values].sort((a, b) => cmp(asSortable(a), asSortable(b)));
}
