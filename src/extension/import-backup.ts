// Reads a backup file for import (docs/import.md): SourceMonkey's
// export, Tampermonkey's zip or JSON backup, Violentmonkey's zip, or
// any zip of `.user.js` files. Whatever the format, the result is one
// `ParsedBackup`, which the preview dialog plans from and the import
// applies. The formats are in docs/export-format.md.
//
// Pure: bytes in, scripts out. No storage, no chrome.*, so it runs in a
// page and in the unit tests. A backup is a file the user picked, so
// everything is read defensively, and one unreadable script becomes a
// problem to report while the rest still import.

import { strFromU8, unzipSync, type Unzipped } from '../vendor/fflate.js';
import { getValue, parseHeader, type ParsedHeader } from '../userscript-header.js';
import { distillRequires, distillResources, type PushedFile } from '../external-files.js';
import { bytesToBase64 } from '../bytes.js';
import { exportFilePath } from './export-backup.js';
import type { ImportSource } from './location-kinds.js';

// One script in the backup.
export interface BackupScript {
  // Its place in the backup's own order, from 0.
  index: number;
  // Its `@name`, else the name the file gave it.
  name: string;
  // The `@namespace`, `@version` and header, read from the text.
  namespace: string;
  version: string;
  header: ParsedHeader | null;
  text: string;
  // Whether it ran in the manager that wrote the file. From
  // SourceMonkey, the script's own flag, whatever its collection's.
  enabled: boolean;
  // Where it loaded from, when the file says: a URL, or (from
  // SourceMonkey) a file path.
  location?: string;
  // The id the file gives it: Tampermonkey's uuid, or SourceMonkey's.
  // A script SourceMonkey exported keeps its id through Tampermonkey.
  foreignId?: string;
  // Its stored GM values, decoded. Absent when the file has none for it.
  values?: Record<string, unknown>;
  // `@require` / `@resource` bodies the file holds, by the ref the
  // header declares.
  files: Record<string, PushedFile>;
  // Edited in the other manager (Tampermonkey's `user_modified`), so its
  // location no longer serves what it runs.
  userModified?: boolean;
  // From SourceMonkey: the `uuid` of the collection it was in, and its
  // path in that collection when it is a directory, manifest or GitHub
  // one (the row a refresh of it matches).
  collection?: string;
  relativePath?: string;
}

// A collection in SourceMonkey's export (`collections` in its manifest).
export interface BackupCollection {
  uuid: string;
  name: string;
  kind: 'directory' | 'manifest' | 'scripts';
  // The folder, manifest or GitHub URL it loads from. Null for a
  // scripts collection.
  location: string | null;
  // For a built-in scripts collection: the scheme it is the default for.
  builtin?: 'file' | 'http' | 'github';
  enabled: boolean;
  localFiles: boolean;
}

export interface ParsedBackup {
  source: ImportSource;
  scripts: BackupScript[];
  collections: BackupCollection[];
  // Scripts the file has but that could not be read.
  problems: BackupProblem[];
}

// A script in the file that can't be imported: its zip entry (or, in
// Tampermonkey's JSON, its name), and why.
export interface BackupProblem {
  file: string;
  reason: string;
}

// Thrown for a file that is not a backup we can read. The message is
// for the user.
export class ImportFormatError extends Error {}

export const IMPORT_IS_USERSCRIPT =
  'This is a userscript, not a backup file. Add it with the Add field instead.';
export const IMPORT_NOT_A_BACKUP =
  'This is not a backup file SourceMonkey can read. Choose an export from SourceMonkey, Tampermonkey or Violentmonkey.';
export const IMPORT_NO_SCRIPTS = 'This backup has no userscripts in it';
export const IMPORT_SCRIPT_EMPTY = 'The script is empty';

// The manager's name, for "Imported from Tampermonkey".
export const SOURCE_NAMES: Record<ImportSource, string> = {
  sourcemonkey: 'SourceMonkey',
  tampermonkey: 'Tampermonkey',
  violentmonkey: 'Violentmonkey',
  other: 'a backup file',
};

export function readBackup(bytes: Uint8Array): ParsedBackup {
  if (bytes.length === 0) throw new ImportFormatError('The file is empty');
  // A zip starts with a local file header, `PK\x03\x04`, or for an
  // empty archive the end record, `PK\x05\x06`.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readZip(bytes);
  return readText(new TextDecoder().decode(bytes));
}

// ---------- GM values ----------

// One stored value as TM and VM write it: a type letter, then the value
// (docs/export-format.md#gm-value-encoding). `undefined` for a value
// that is `undefined`, which isn't stored. Anything that doesn't decode
// is kept as written.
export function decodeStoredValue(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  const rest = raw.slice(1);
  switch (raw[0]) {
    case 's': return rest;
    case 'n': {
      const n = Number(rest);
      return Number.isNaN(n) && rest !== 'NaN' ? raw : n;
    }
    case 'b': return rest === 'true';
    case 'u': return undefined;
    case 'o':
      try { return JSON.parse(rest); } catch { return raw; }
    // Tampermonkey's old form: base64 of UTF-8 JSON.
    case 'x':
      try { return JSON.parse(utf8FromBase64(rest)); } catch { return raw; }
    default: return raw;
  }
}

// A `data` object of encoded values, decoded. Absent when there are none:
// an empty store in the file means the values were left out (Tampermonkey
// writes `{}` when storage is unchecked), not that the script has none.
function decodeValues(data: unknown): Record<string, unknown> | undefined {
  if (!isObject(data)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(data)) {
    const value = decodeStoredValue(raw);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------- Text files ----------

function readText(text: string): ParsedBackup {
  const trimmed = text.trim();
  if (!trimmed) throw new ImportFormatError('The file is empty');
  if (/^\s*\/\/\s*==UserScript==/m.test(trimmed.slice(0, 4096))) throw new ImportFormatError(IMPORT_IS_USERSCRIPT);
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    throw new ImportFormatError(IMPORT_NOT_A_BACKUP);
  }
  if (!isObject(root) || !Array.isArray(root.scripts)) throw new ImportFormatError(IMPORT_NOT_A_BACKUP);
  const scripts: BackupScript[] = [];
  const problems: BackupProblem[] = [];
  const order: number[] = [];
  root.scripts.forEach((entry, i) => {
    try {
      const script = readTampermonkeyJsonScript(entry, i);
      scripts.push(script);
      order.push(numberOr(isObject(entry) ? entry.position : undefined, Infinity));
    } catch (err) {
      const name = isObject(entry) ? stringOr(entry.name, '') : '';
      problems.push({ file: name || `Script ${i + 1}`, reason: errorText(err) });
    }
  });
  return finish({ source: 'tampermonkey', scripts: sortBy(scripts, order), collections: [], problems });
}

// One script of Tampermonkey's JSON backup: flat fields, base64 text.
function readTampermonkeyJsonScript(entry: unknown, i: number): BackupScript {
  if (!isObject(entry)) throw new Error('The entry is not a script');
  const label = stringOr(entry.name, '') || `Script ${i + 1}`;
  let text: string;
  try {
    text = utf8FromBase64(stringOr(entry.source, ''));
  } catch {
    throw new Error('Its text could not be read');
  }
  const options = isObject(entry.options) ? entry.options : {};
  const deps: Dependency[] = [];
  for (const [list, resource] of [[entry.requires, false], [entry.resources, true]] as const) {
    if (!Array.isArray(list)) continue;
    for (const dep of list) {
      if (!isObject(dep) || !isObject(dep.meta) || typeof dep.meta.url !== 'string') continue;
      try {
        // A resource's bytes were each taken as a character before the
        // UTF-8 and base64 (docs/export-format.md#json-format).
        const decoded = resource ? latin1Bytes(utf8FromBase64(stringOr(dep.source, ''))) : bytesFromBase64(stringOr(dep.source, ''));
        deps.push({ url: dep.meta.url, bytes: decoded, mimetype: stringOr(dep.meta.mimetype, '') });
      } catch { /* a body that won't decode is fetched instead */ }
    }
  }
  return script({
    index: i,
    fallbackName: label,
    text,
    enabled: entry.enabled !== false,
    location: stringOr(entry.file_url, '') || undefined,
    foreignId: stringOr(entry.uuid, '') || undefined,
    values: decodeValues(isObject(entry.storage) ? entry.storage.data : undefined),
    userModified: options.user_modified != null && options.user_modified !== false,
    deps,
  });
}

// A script with no text: one only a restore brings back, as the empty
// file it was. Imported on its own it would be a script that does
// nothing, so the dialog lists it as invalid.
export function isEmptyScript(text: string): boolean {
  return !text.trim();
}

// ---------- Zip files ----------

// A dependency body the file holds, by its absolute URL.
interface Dependency {
  url: string;
  bytes: Uint8Array;
  mimetype: string;
}

function readZip(bytes: Uint8Array): ParsedBackup {
  let entries: Unzipped;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ImportFormatError('This zip file could not be read. It may be damaged or incomplete.');
  }
  // Folders, and the resource forks macOS's archiver adds.
  const paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/'));
  const json = (path: string | undefined): Record<string, unknown> | undefined => {
    if (path === undefined || !(path in entries)) return undefined;
    try {
      const parsed: unknown = JSON.parse(strFromU8(entries[path]));
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const manifest = json('script_manifest.json');
  const sm = manifest?.format === 'sourcemonkey-export' ? manifest : undefined;
  const vmPath = paths.find((p) => p.toLowerCase() === 'violentmonkey');
  const vm = json(vmPath);
  // SourceMonkey's manifest, by each script's entry path.
  const smEntries = new Map<string, Record<string, unknown>>();
  const smOrder = new Map<string, number>();
  if (sm && Array.isArray(sm.scripts)) {
    sm.scripts.forEach((e, i) => {
      if (!isObject(e) || typeof e.path !== 'string') return;
      const path = manifestPathToEntry(e.path);
      smEntries.set(path, e);
      smOrder.set(path, i);
    });
  }
  // A dependency can end in `.user.js` too: TM names its copy
  // `<name>.user.js-<md5>-<basename>`, and SourceMonkey's sits at its
  // own path, so its manifest's list is the scripts.
  const scriptPaths = paths.filter((p) => p.toLowerCase().endsWith('.user.js') && !p.includes('.user.js-')
    && (smEntries.size === 0 || smEntries.has(p)));
  if (scriptPaths.length === 0) {
    if (sm || vm || paths.some((p) => p.endsWith('.options.json'))) throw new ImportFormatError(IMPORT_NO_SCRIPTS);
    throw new ImportFormatError(IMPORT_NOT_A_BACKUP);
  }
  const source: ImportSource = sm ? 'sourcemonkey'
    : vm ? 'violentmonkey'
      : paths.some((p) => p.endsWith('.options.json') || p.endsWith('.global.json')) ? 'tampermonkey'
        : 'other';

  const vmScripts = vm && isObject(vm.scripts) ? vm.scripts : {};
  const vmValues = vm && isObject(vm.values) ? vm.values : {};
  const tmDeps = tampermonkeyDependencies(entries, paths);

  const scripts: BackupScript[] = [];
  const order: number[] = [];
  const problems: BackupProblem[] = [];
  scriptPaths.forEach((path, fileIndex) => {
    const stem = path.slice(0, -'.user.js'.length);
    const base = stem.slice(stem.lastIndexOf('/') + 1);
    try {
      const text = strFromU8(entries[path]);
      const options = json(`${stem}.options.json`);
      const meta = options && isObject(options.meta) ? options.meta : {};
      const settings = options && isObject(options.settings) ? options.settings : {};
      const opts = options && isObject(options.options) ? options.options : {};
      const storage = json(`${stem}.storage.json`);
      const smEntry = smEntries.get(path);
      const vmEntry = isObject(vmScripts[base]) ? vmScripts[base] : undefined;
      const vmConfig = vmEntry && isObject(vmEntry.config) ? vmEntry.config : {};
      const vmCustom = vmEntry && isObject(vmEntry.custom) ? vmEntry.custom : {};
      const header = parseHeader(text);

      let enabled = true;
      if (smEntry && typeof smEntry.enabled === 'boolean') enabled = smEntry.enabled;
      else if (options) enabled = settings.enabled !== false;
      // VM's older exports put `enabled` on the script itself.
      else if (vmEntry) enabled = (vmConfig.enabled ?? vmEntry.enabled ?? 1) !== 0;

      const location = smEntry ? stringOr(smEntry.location, '') || null
        : stringOr(meta.file_url, '') || stringOr(vmCustom.downloadURL, '') || stringOr(vmCustom.lastInstallURL, '') || undefined;

      let values = decodeValues(storage?.data);
      if (!values && vmEntry && header) values = decodeValues(vmValues[violentmonkeyNameUri(header)]);

      const deps = [...(tmDeps.get(stem) ?? [])];
      if (sm) deps.push(...sourceMonkeyDependencies(entries, path, header, location ?? ''));

      scripts.push(script({
        index: fileIndex,
        fallbackName: stringOr(meta.name, '') || base,
        text,
        enabled,
        location,
        foreignId: stringOr(smEntry?.uuid, '') || stringOr(meta.uuid, '') || undefined,
        values,
        userModified: opts.user_modified != null && opts.user_modified !== false,
        collection: stringOr(smEntry?.collection, '') || undefined,
        relativePath: stringOr(smEntry?.relative_path, '') || undefined,
        allowEmpty: smEntry !== undefined,
        deps,
      }));
      order.push(smOrder.get(path) ?? numberOr(settings.position ?? vmEntry?.position, Infinity));
    } catch (err) {
      problems.push({ file: path, reason: errorText(err) });
    }
  });

  const collections: BackupCollection[] = [];
  if (sm && Array.isArray(sm.collections)) {
    for (const c of sm.collections) {
      if (!isObject(c) || typeof c.uuid !== 'string') continue;
      const kind = c.kind === 'directory' || c.kind === 'manifest' || c.kind === 'scripts' ? c.kind : null;
      const location = typeof c.location === 'string' && c.location ? c.location : null;
      // A collection this importer can't recreate is left out; its
      // scripts still import one by one.
      if (!kind || (kind !== 'scripts' && !location)) continue;
      const collection: BackupCollection = {
        uuid: c.uuid,
        name: stringOr(c.name, ''),
        kind,
        location: kind === 'scripts' ? null : location,
        enabled: c.enabled !== false,
        localFiles: c.local_files !== false,
      };
      if (kind === 'scripts' && (c.builtin === 'file' || c.builtin === 'http' || c.builtin === 'github')) collection.builtin = c.builtin;
      collections.push(collection);
    }
  }
  return finish({ source, scripts: sortBy(scripts, order), collections, problems });
}

// A manifest entry is a URL, with `#` and `%` percent-encoded
// (docs/export-format.md#script_manifestjson); the zip entry is not.
function manifestPathToEntry(path: string): string {
  return path.replace(/%23/gi, '#').replace(/%25/gi, '%');
}

// Tampermonkey's zip keeps each dependency as
// `<name>.user.js-<md5>-<basename>`, with its meta beside it in
// `….requires.json` or `….resources.json`. By the script's stem.
function tampermonkeyDependencies(entries: Unzipped, paths: readonly string[]): Map<string, Dependency[]> {
  const out = new Map<string, Dependency[]>();
  for (const metaPath of paths) {
    const suffix = metaPath.endsWith('.requires.json') ? '.requires.json'
      : metaPath.endsWith('.resources.json') ? '.resources.json' : null;
    if (!suffix) continue;
    const bodyPath = metaPath.slice(0, -suffix.length);
    const marker = bodyPath.lastIndexOf('.user.js-');
    if (marker < 0 || !(bodyPath in entries)) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(strFromU8(entries[metaPath]));
    } catch {
      continue;
    }
    if (isObject(meta) && isObject(meta.meta)) meta = meta.meta;
    if (!isObject(meta) || typeof meta.url !== 'string') continue;
    const stem = bodyPath.slice(0, marker);
    const list = out.get(stem) ?? [];
    list.push({ url: meta.url, bytes: entries[bodyPath], mimetype: stringOr(meta.mimetype, '') });
    out.set(stem, list);
  }
  return out;
}

// SourceMonkey's export keeps each dependency at the path a local copy
// would (`exportFilePath`): in the script's folder, or at the top when
// scripts share it (docs/export-format.md#dependency-bodies). The
// script's folder is looked in first, as the local-file overrides do.
function sourceMonkeyDependencies(
  entries: Unzipped, scriptPath: string, header: ParsedHeader | null, location: string,
): Dependency[] {
  const folder = scriptPath.includes('/') ? scriptPath.slice(0, scriptPath.lastIndexOf('/') + 1) : '';
  const out: Dependency[] = [];
  for (const ref of declaredRefs(header)) {
    const url = absoluteUrl(ref, location);
    if (!url) continue;
    const path = exportFilePath(ref, url);
    if (!path) continue;
    const found = [`${folder}${path}`, path].find((p) => p in entries);
    if (found) out.push({ url, bytes: entries[found], mimetype: '' });
  }
  return out;
}

// What `@require` and `@resource` refs a header declares.
function declaredRefs(header: ParsedHeader | null): string[] {
  return [...distillRequires(header), ...distillResources(header).map((d) => d.ref)];
}

// A ref as an absolute URL: as written, or resolved against where the
// script loaded from. A bare file path becomes a `file://` URL. Null for
// a relative ref with nothing to resolve it against.
function absoluteUrl(ref: string, location: string): string | null {
  const base = location.startsWith('/') ? `file://${encodeURI(location)}` : location;
  try {
    return new URL(ref, base || undefined).href;
  } catch {
    return null;
  }
}

// Violentmonkey keys its values by `@namespace` and `@name`, escaped as
// a file name (docs/export-format.md#values-keys).
export function violentmonkeyNameUri(header: ParsedHeader): string {
  const raw = `${getValue(header, 'namespace') ?? ''}\n${getValue(header, 'name') ?? ''}\n`;
  return raw.replace(/[-\\/:*?"<>|%\s]/g, (m) => `-${m.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// ---------- Shared ----------

function script(args: {
  index: number;
  fallbackName: string;
  text: string;
  enabled: boolean;
  // Undefined when the file doesn't say, null when it says there is none.
  location?: string | null;
  foreignId?: string;
  values?: Record<string, unknown>;
  userModified?: boolean;
  collection?: string;
  relativePath?: string;
  // A script SourceMonkey exported is read even when empty: it was a
  // row there, which a restore brings back. Anything else does nothing
  // with it (`isEmptyScript`).
  allowEmpty?: boolean;
  deps: readonly Dependency[];
}): BackupScript {
  if (!args.allowEmpty && isEmptyScript(args.text)) throw new Error(IMPORT_SCRIPT_EMPTY);
  const header = parseHeader(args.text);
  // Unsaid, the header's `@downloadURL` is where it came from. SourceMonkey
  // says so outright, `null` for a script it kept only as text.
  const location = args.location === undefined
    ? (header ? httpUrlOrUndefined(getValue(header, 'downloadURL')) : undefined)
    : args.location ?? undefined;
  const out: BackupScript = {
    index: args.index,
    name: (header ? getValue(header, 'name')?.trim() : '') || args.fallbackName,
    namespace: (header ? getValue(header, 'namespace')?.trim() : '') ?? '',
    version: (header ? getValue(header, 'version')?.trim() : '') ?? '',
    header,
    text: args.text,
    enabled: args.enabled,
    files: filesByRef(header, location ?? '', args.deps),
  };
  if (location) out.location = location;
  if (args.foreignId) out.foreignId = args.foreignId;
  if (args.values) out.values = args.values;
  if (args.userModified) out.userModified = true;
  if (args.collection) out.collection = args.collection;
  if (args.relativePath) out.relativePath = args.relativePath;
  return out;
}

// The file's dependency bodies, by the ref the header declares them as.
function filesByRef(header: ParsedHeader | null, location: string, deps: readonly Dependency[]): Record<string, PushedFile> {
  const files: Record<string, PushedFile> = {};
  if (deps.length === 0) return files;
  const byUrl = new Map(deps.map((d) => [d.url, d]));
  for (const ref of declaredRefs(header)) {
    const url = absoluteUrl(ref, location);
    const dep = (url ? byUrl.get(url) : undefined) ?? byUrl.get(ref);
    if (!dep) continue;
    files[ref] = {
      url: dep.url,
      bytesBase64: bytesToBase64(dep.bytes),
      contentType: dep.mimetype || 'application/octet-stream',
    };
  }
  return files;
}

function finish(backup: ParsedBackup): ParsedBackup {
  if (backup.scripts.length === 0) {
    throw new ImportFormatError(backup.problems.length > 0
      ? `No script in this backup could be read. ${backup.problems[0].file}: ${backup.problems[0].reason}.`
      : IMPORT_NO_SCRIPTS);
  }
  backup.scripts.forEach((s, i) => { s.index = i; });
  return backup;
}

// `items` in the order `keys` gives, ties kept in file order.
function sortBy<T>(items: T[], keys: number[]): T[] {
  return items.map((item, i) => ({ item, key: keys[i], i }))
    .sort((a, b) => (a.key - b.key) || (a.i - b.i))
    .map((e) => e.item);
}

function httpUrlOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

function utf8FromBase64(base64: string): string {
  return new TextDecoder().decode(bytesFromBase64(base64));
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  return latin1Bytes(binary);
}

// Each character's code as one byte.
function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
