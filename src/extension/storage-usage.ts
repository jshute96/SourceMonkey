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
import { VALUE_PREFIX as GM_VALUE_PREFIX } from './gm-values.js';
import { isIconCacheKey } from './site-icon.js';
import {
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

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? '').length;
}

function rowBytes(key: string, value: unknown): number {
  return encoder.encode(key).length + jsonBytes(value);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// sm-dev's scratch scripts: the text, its pushed files, and its origin.
const SCRATCH_PREFIXES = [
  SCRATCH_TEXT_KEY_PREFIX, SCRATCH_FILES_KEY_PREFIX, SCRATCH_SOURCE_KEY_PREFIX,
];

function startsWithAny(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => key.startsWith(p));
}

// `chrome.storage.local`. A script row carries its `@require` and
// `@resource` bodies inline, so those are split out of the row rather
// than counted as script text.
export function summarizeLocalStorage(rows: Record<string, unknown>): UsageRow[] {
  let scripts = 0, scriptBytes = 0;
  let requires = 0, requireBytes = 0;
  let resources = 0, resourceBytes = 0;
  let icons = 0, iconBytes = 0;
  let values = 0, valueBytes = 0;
  const valueScripts = new Set<string>();
  let scratch = 0, scratchBytes = 0;
  let collections = 0, collectionBytes = 0;
  let otherBytes = 0;

  for (const [key, value] of Object.entries(rows)) {
    const bytes = rowBytes(key, value);
    if (key.startsWith(SCRIPT_PREFIX)) {
      const row = (value ?? {}) as { requires?: unknown[]; resources?: unknown[] };
      const req = Array.isArray(row.requires) ? row.requires : [];
      const res = Array.isArray(row.resources) ? row.resources : [];
      const reqBytes = req.length ? jsonBytes(req) : 0;
      const resBytes = res.length ? jsonBytes(res) : 0;
      scripts++;
      scriptBytes += bytes - reqBytes - resBytes;
      requires += req.length;
      requireBytes += reqBytes;
      resources += res.length;
      resourceBytes += resBytes;
    } else if (isIconCacheKey(key)) {
      icons++;
      iconBytes += bytes;
    } else if (key.startsWith(GM_VALUE_PREFIX)) {
      // `gmval:<scriptId>:<name>`
      values++;
      valueBytes += bytes;
      valueScripts.add(key.slice(GM_VALUE_PREFIX.length).split(':', 1)[0]);
    } else if (startsWithAny(key, SCRATCH_PREFIXES)) {
      if (key.startsWith(SCRATCH_TEXT_KEY_PREFIX)) scratch++;
      scratchBytes += bytes;
    } else if (key.startsWith(COLLECTION_PREFIX)) {
      collections++;
      collectionBytes += bytes;
    } else if (key === COLLECTIONS_INDEX_KEY) {
      collectionBytes += bytes;
    } else {
      otherBytes += bytes;
    }
  }

  return [
    { label: 'Scripts', count: plural(scripts, 'script'), bytes: scriptBytes },
    { label: '@require files', count: plural(requires, 'file'), bytes: requireBytes },
    { label: '@resource files', count: plural(resources, 'file'), bytes: resourceBytes },
    {
      label: 'Script values (GM_setValue)',
      count: `${plural(values, 'value')} in ${plural(valueScripts.size, 'script')}`,
      bytes: valueBytes,
    },
    { label: 'Site and script icons', count: plural(icons, 'icon'), bytes: iconBytes },
    { label: 'Scripts run by sm-dev', count: plural(scratch, 'script'), bytes: scratchBytes },
    { label: 'Collections', count: plural(collections, 'collection'), bytes: collectionBytes },
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
