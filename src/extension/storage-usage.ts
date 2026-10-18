// Breakdown of what SourceMonkey keeps in `chrome.storage.local`, for the
// Options page's usage table. Pure: takes the rows a `get(null)` read
// returns and sorts them into the kinds a user would recognize.
//
// Sizes are measured the way Chrome charges them: the key plus the
// JSON-serialized value, in UTF-8 bytes. They are close to
// `getBytesInUse`, not identical to it, so the page takes its total
// from Chrome and lets "Other" absorb the difference (see
// `withRemainder`). `toWholeKb` then rounds so the shown sizes add up.
//
// `chrome.storage.session` isn't covered: it holds only this session's
// logs and tab state, has its own quota, and is nowhere near filling.

import { COLLECTION_PREFIX, COLLECTIONS_INDEX_KEY, SCRIPT_PREFIX } from './structural-keys.js';
import { BLOB_PREFIX } from './script-blobs.js';
import { VALUE_PREFIX as GM_VALUE_PREFIX } from './gm-values.js';
import { isIconCacheKey } from './site-icon.js';
import {
  IMPORT_INFO_KEY_PREFIX,
  isImportedUrl,
  SCRATCH_FILES_KEY_PREFIX,
  SCRATCH_SOURCE_KEY_PREFIX,
  SCRATCH_TEXT_KEY_PREFIX,
} from './location-kinds.js';

export interface UsageRow {
  label: string;
  // Shown as-is in the Count column; '' when a count would mean nothing.
  count: string;
  bytes: number;
}

const encoder = new TextEncoder();

export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? '').length;
}

// What Chrome charges for one row. Shared with the storage debug page
// (storage-breakdown.ts), so its sizes agree with this table.
export function rowBytes(key: string, value: unknown): number {
  return encoder.encode(key).length + jsonBytes(value);
}

type Kind = 'script' | 'require' | 'resource';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Scripts whose only copy is in storage, scratch and imported: the
// text, its pushed files, and its origin.
const SCRATCH_PREFIXES = [
  SCRATCH_TEXT_KEY_PREFIX, SCRATCH_FILES_KEY_PREFIX, SCRATCH_SOURCE_KEY_PREFIX, IMPORT_INFO_KEY_PREFIX,
];

// Whether a row under one of those prefixes is an imported script's.
function isImportedRow(key: string): boolean {
  const prefix = SCRATCH_PREFIXES.find((p) => key.startsWith(p)) ?? '';
  return isImportedUrl(key.slice(prefix.length));
}

function startsWithAny(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => key.startsWith(p));
}

// `chrome.storage.local`. Bodies live in shared `blob:` rows
// (docs/storage.md#content-blobs); each is counted once, under the kind
// of the first row found pointing at it: a script body, a `@require`,
// or a `@resource`. A blob nothing points at (left by a remove, or a
// refresh that replaced a body, until cleanup deletes it)
// gets its own row. A format 1 row, not yet migrated, carries its
// `@require` / `@resource` bodies inline, so those are split out of the
// row instead.
export function summarizeLocalStorage(rows: Record<string, unknown>): UsageRow[] {
  let scripts = 0, scriptBytes = 0;
  let requires = 0, requireBytes = 0;
  let resources = 0, resourceBytes = 0;
  let icons = 0, iconBytes = 0;
  let values = 0, valueBytes = 0;
  const valueScripts = new Set<string>();
  let scratch = 0, scratchBytes = 0;
  let imported = 0, importedBytes = 0;
  let collections = 0, collectionBytes = 0;
  let otherBytes = 0;
  // Blob key → the kind whose size it counts under (the first found).
  const claimed = new Map<string, Kind>();
  // Per kind: files stored as blobs, and their distinct blobs. A blob
  // shared across kinds is distinct in each, though sized under one.
  const withRef = { script: 0, require: 0, resource: 0 };
  const distinct = { script: new Set<string>(), require: new Set<string>(), resource: new Set<string>() };
  const claim = (ref: unknown, kind: Kind) => {
    const hash = (ref as { hash?: unknown } | undefined)?.hash;
    if (typeof hash !== 'string') return;
    const key = BLOB_PREFIX + hash;
    withRef[kind]++;
    distinct[kind].add(key);
    if (!claimed.has(key)) claimed.set(key, kind);
  };

  for (const [key, value] of Object.entries(rows)) {
    if (!key.startsWith(SCRIPT_PREFIX)) continue;
    const row = (value ?? {}) as { bodyBlobRef?: unknown; requires?: unknown[]; resources?: unknown[] };
    const req = Array.isArray(row.requires) ? row.requires as { source?: unknown; blobRef?: unknown }[] : [];
    const res = Array.isArray(row.resources) ? row.resources as { bytesBase64?: unknown; blobRef?: unknown }[] : [];
    const inlineReq = req.filter((r) => typeof r.source === 'string');
    const inlineRes = res.filter((r) => typeof r.bytesBase64 === 'string');
    const reqBytes = inlineReq.length ? jsonBytes(inlineReq) : 0;
    const resBytes = inlineRes.length ? jsonBytes(inlineRes) : 0;
    scripts++;
    scriptBytes += rowBytes(key, value) - reqBytes - resBytes;
    requires += req.length;
    requireBytes += reqBytes;
    resources += res.length;
    resourceBytes += resBytes;
    claim(row.bodyBlobRef, 'script');
    for (const r of req) claim(r.blobRef, 'require');
    for (const r of res) claim(r.blobRef, 'resource');
  }

  let unused = 0, unusedBytes = 0;
  for (const [key, value] of Object.entries(rows)) {
    if (key.startsWith(SCRIPT_PREFIX)) continue;
    const bytes = rowBytes(key, value);
    if (key.startsWith(BLOB_PREFIX)) {
      const kind = claimed.get(key);
      if (kind === 'script') scriptBytes += bytes;
      else if (kind === 'require') requireBytes += bytes;
      else if (kind === 'resource') resourceBytes += bytes;
      else { unused++; unusedBytes += bytes; }
    } else if (isIconCacheKey(key)) {
      icons++;
      iconBytes += bytes;
    } else if (key.startsWith(GM_VALUE_PREFIX)) {
      // `gmval:<scriptId>:<name>`
      values++;
      valueBytes += bytes;
      valueScripts.add(key.slice(GM_VALUE_PREFIX.length).split(':', 1)[0]);
    } else if (startsWithAny(key, SCRATCH_PREFIXES)) {
      const text = key.startsWith(SCRATCH_TEXT_KEY_PREFIX);
      if (isImportedRow(key)) {
        if (text) imported++;
        importedBytes += bytes;
      } else {
        if (text) scratch++;
        scratchBytes += bytes;
      }
    } else if (key.startsWith(COLLECTION_PREFIX)) {
      collections++;
      collectionBytes += bytes;
    } else if (key === COLLECTIONS_INDEX_KEY) {
      collectionBytes += bytes;
    } else {
      otherBytes += bytes;
    }
  }

  // "(N unique)" when files stored as blobs share some. A file not
  // stored as a blob (never loaded, or not yet migrated) counts as
  // unique, so it can't make the count look like sharing.
  const total: Record<Kind, number> = { script: scripts, require: requires, resource: resources };
  const withUnique = (text: string, kind: Kind) => {
    const unique = total[kind] - (withRef[kind] - distinct[kind].size);
    return unique < total[kind] ? `${text} (${unique} unique)` : text;
  };
  return [
    { label: 'Scripts', count: withUnique(plural(scripts, 'script'), 'script'), bytes: scriptBytes },
    { label: '@require files', count: withUnique(plural(requires, 'file'), 'require'), bytes: requireBytes },
    { label: '@resource files', count: withUnique(plural(resources, 'file'), 'resource'), bytes: resourceBytes },
    {
      label: 'Script values (GM_setValue)',
      count: `${plural(values, 'value')} in ${plural(valueScripts.size, 'script')}`,
      bytes: valueBytes,
    },
    { label: 'Site and script icons', count: plural(icons, 'icon'), bytes: iconBytes },
    { label: 'Imported scripts kept only here', count: plural(imported, 'script'), bytes: importedBytes },
    { label: 'Scripts run by sm-dev', count: plural(scratch, 'script'), bytes: scratchBytes },
    { label: 'Collections', count: plural(collections, 'collection'), bytes: collectionBytes },
    { label: 'Stored files no script uses', count: plural(unused, 'file'), bytes: unusedBytes },
    { label: 'Other', count: '', bytes: otherBytes },
  ];
}

// Makes the rows add up to Chrome's own total: the last row ("Other")
// takes whatever our measurement and `getBytesInUse` disagree on, so
// the table never shows parts that sum to more or less than the whole.
export function withRemainder(rows: UsageRow[], total: number): UsageRow[] {
  const measured = rows.slice(0, -1).reduce((sum, r) => sum + r.bytes, 0);
  const last = rows[rows.length - 1];
  return [...rows.slice(0, -1), { ...last, bytes: Math.max(0, total - measured) }];
}

// Whole-KB sizes that sum exactly to the rounded total, by giving the
// leftover KB to the rows that lost most to rounding (largest
// remainder). Rounding each row on its own makes a column whose parts
// visibly don't add up to the total under it.
export function toWholeKb(rows: UsageRow[], total: number): number[] {
  const exact = rows.map((r) => r.bytes / 1024);
  const kb = exact.map(Math.floor);
  let left = Math.round(total / 1024) - kb.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let n = 0; left > 0 && n < order.length; n++, left--) kb[order[n].i]++;
  // Short of the total only by rounding above. Over it means the rows
  // were measured larger than Chrome's total (`withRemainder` clamps
  // "Other" at 0): take the excess back from the largest rows, which
  // it changes least. The excess is a few KB at most, so one KB at a
  // time is cheap.
  for (; left < 0; left++) {
    const i = kb.indexOf(Math.max(...kb));
    if (i < 0 || kb[i] === 0) break;
    kb[i]--;
  }
  return kb;
}
