// The backup export: collections and their scripts, written as the zip
// format in docs/export-format.md#sourcemonkey. Tampermonkey's zip
// layout, so Tampermonkey and Violentmonkey can import it, plus a
// `script_manifest.json` only SourceMonkey reads.
//
// Two halves:
//   - `planExportEntries` is pure: rows, values and icon bytes in, zip
//     entries out. Unit-tested on its own.
//   - `runExport` gathers those inputs on the collections page, builds
//     the zip and hands it to Chrome's Save As.

import { MANIFEST_FILENAME } from '../collection-scan.js';
import { base64ToBytes } from '../bytes.js';
import { collectionKind, containerKind, isFileUrl, isHttpUrl, locationFsPath } from '../file-locations.js';
import { resolveScriptResource } from '../file-loader.js';
import { iconRefFromHeader } from '../script-icon.js';
import { fullSource, scriptBasename } from '../script-display.js';
import { getValue } from '../userscript-header.js';
import { effectiveDisplayName } from './collection-display.js';
import { isSmDevCollection } from './location-kinds.js';
import { isRelativeRef, mirrorPath, relativeRefPath } from './local-copy.js';
import { dataUrlContent, ensureIconForUrl } from './site-icon.js';
import {
  collectionUsesLocalFiles,
  getCollectionWithScripts,
  getCollections,
  isCollectionEnabled,
  isScriptEnabled,
  type StoredCollection,
  type StoredScript,
} from './script-store.js';
import { readScriptValues } from './worker-client.js';
import { buildZip, type ZipEntry } from './zip-writer.js';

export const EXPORT_FORMAT = 'sourcemonkey-export';
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportOptions {
  // Each script's GM values, as `<name>.storage.json`.
  values: boolean;
  // `@require` / `@resource` / `@icon` files, at `<host>/<path>`.
  files: boolean;
}

// One collection and its scripts, as read from storage, bodies included.
export interface ExportCollectionInput {
  collection: StoredCollection;
  scripts: StoredScript[];
}

export interface ExportInput {
  collections: ExportCollectionInput[];
  // GM values by script id. Only read when `options.values` is set.
  values: Record<string, Record<string, unknown>>;
  // Icon bytes by resolved icon URL. Only read when `options.files` is set.
  icons: Record<string, Uint8Array>;
  options: ExportOptions;
  now: number;
}

export interface ExportPlan {
  entries: ZipEntry[];
  scriptCount: number;
}

// ---------- Manifest shape ----------

interface ManifestCollection {
  uuid: string;
  name: string;
  kind: 'directory' | 'manifest' | 'scripts';
  location: string | null;
  builtin?: 'file' | 'http' | 'github';
  enabled: boolean;
  local_files: boolean;
}

interface ManifestScript {
  path: string;
  uuid: string;
  collection: string;
  location: string | null;
  enabled: boolean;
}

// ---------- Pure helpers ----------

// A GM value in the type-prefixed string form Tampermonkey and
// Violentmonkey both store (docs/export-format.md#gm-value-encoding).
// `undefined` has no entry: Violentmonkey would read `u` as a delete.
export function encodeExportValue(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string': return `s${value}`;
    case 'number': return `n${value}`;
    case 'boolean': return `b${value}`;
    case 'undefined': return undefined;
    default: return `o${JSON.stringify(value)}`;
  }
}

// Characters Tampermonkey or Violentmonkey would replace in a file
// name, plus control characters.
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|$\u0000-\u001f]/g;
// Longest name kept, in characters, before ` (2)` and the suffix: room
// to spare under the 255-byte limit most file systems put on a name.
const MAX_NAME_CHARS = 100;

// `text` made safe as one file or folder name: characters TM or VM
// would replace turned into `-`, trimmed, leading dots dropped, and cut
// to `MAX_NAME_CHARS`. `fallback` when nothing is left.
export function safeFileName(text: string, fallback: string): string {
  const cleaned = text.replace(UNSAFE_NAME_CHARS, '-').trim().replace(/^\.+/, '');
  return [...cleaned].slice(0, MAX_NAME_CHARS).join('').trim() || fallback;
}

// A file name as a manifest entry. An entry is read as a URL, where `#`
// would start a fragment and `%` an escape, so those two are encoded.
// Everything else stays readable: the URL parser encodes spaces and
// non-ASCII itself, and `?` never reaches a name (`exportScriptName`).
export function manifestEntryPath(fileName: string): string {
  return fileName.replace(/%/g, '%25').replace(/#/g, '%23');
}

// Where a script loads from, for the manifest: a URL, or an absolute
// file path for a local one. `null` for a location that is neither.
function scriptLocation(script: StoredScript): string | null {
  if (isHttpUrl(script.fileUrl)) return script.fileUrl;
  if (isFileUrl(script.fileUrl)) return locationFsPath(script.fileUrl);
  return null;
}

function manifestCollection(collection: StoredCollection): ManifestCollection {
  const kind = collectionKind(collection.path);
  const out: ManifestCollection = {
    uuid: collection.id,
    name: effectiveDisplayName(collection),
    kind,
    location: kind === 'scripts' ? null : collection.path,
    enabled: isCollectionEnabled(collection),
    local_files: collectionUsesLocalFiles(collection),
  };
  const builtin = containerKind(collection.path);
  if (builtin) out.builtin = builtin;
  return out;
}

// Where a dependency or icon file goes, relative to its script's folder:
//   - A relative ref (`lib/util.js`) at that path, where it resolves
//     from the unzipped script. One that climbs out of the script's
//     folder (`../x.js`) has no such place.
//   - Anything else at `<host>/<path>` of its URL (a `file://` URL at
//     its path), where the local-file overrides look.
export function exportFilePath(ref: string, url: string): string | null {
  return (isRelativeRef(ref) && relativeRefPath(ref)) || mirrorPath(url);
}

// The resolved URL of a script's own icon, when it is one we can bundle.
export function scriptIconUrl(script: StoredScript): string | null {
  const ref = iconRefFromHeader(script.header);
  if (!ref) return null;
  const resolved = resolveScriptResource(ref, script.fileUrl);
  // A `data:` icon is in the header itself.
  return resolved && resolved.kind !== 'data' ? resolved.url : null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A collection's folder name: its last path segment for one named by a
// path.
function collectionFolderName(collection: StoredCollection): string {
  const name = effectiveDisplayName(collection);
  const last = name.split('/').filter(Boolean).pop() ?? name;
  return safeFileName(last, 'collection');
}

// `base`, or `base (2)`, `base (3)`, …: the first not in `used`, which
// holds lower-cased names. The one chosen is added.
function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
  used.add(name.toLowerCase());
  return name;
}

// One script's dependency and icon files, by path relative to its
// folder. `relative` marks a file named by a relative ref, which has to
// sit under the script's own folder (see `planExportEntries`).
type ScriptFiles = Map<string, { data: Uint8Array; relative: boolean }>;

function scriptFiles(script: StoredScript, icons: Record<string, Uint8Array>): ScriptFiles {
  const encoder = new TextEncoder();
  const files: ScriptFiles = new Map();
  const add = (ref: string, url: string, data: Uint8Array): void => {
    if (!isHttpUrl(url) && !isFileUrl(url)) return;
    const path = exportFilePath(ref, url);
    if (path && !files.has(path)) files.set(path, { data, relative: isRelativeRef(ref) });
  };
  for (const r of script.requires ?? []) add(r.ref, r.url, encoder.encode(r.source));
  for (const r of script.resources ?? []) add(r.ref, r.url, new Uint8Array(base64ToBytes(r.bytesBase64)));
  const iconRef = iconRefFromHeader(script.header);
  const iconUrl = scriptIconUrl(script);
  const icon = iconUrl ? icons[iconUrl] : undefined;
  if (iconRef && iconUrl && icon) add(iconRef, iconUrl, icon);
  return files;
}

// Every entry of the export. Each script gets a folder of its own,
// holding its `.user.js`, `.options.json` and `.storage.json`, and the
// dependency files only it uses; with more than one collection, the
// script folders sit in a folder per collection:
//
//   script_manifest.json
//   cdn.example.com/lib.js               shared by scripts, same bytes
//   My scripts/Foo/Foo.user.js
//   My scripts/Foo/lib/util.js           a relative ref: always here
//   My scripts/Foo/cdn.example.com/x.js  used by Foo only
//
// Laid out for the local-file overrides, so the unzipped folder, added
// as a manifest collection, runs every script on the bundled files.
// They search the script's own folder first, then the manifest's
// folder (docs/local-file-overrides.md#where-roots-come-from):
//   - A file at the top serves every script whose own folder doesn't
//     hold another version.
//   - A relative ref resolves straight to a path under the script's
//     folder, where the overrides don't look further, so its file is
//     always there.
export function planExportEntries(input: ExportInput): ExportPlan {
  const encoder = new TextEncoder();
  const json = (value: unknown, pretty = false): Uint8Array =>
    encoder.encode(JSON.stringify(value, null, pretty ? 2 : undefined));

  // Names first: each collection's folder, and each script's.
  const topNames = new Set<string>([MANIFEST_FILENAME]);
  const planned: {
    script: StoredScript;
    collection: StoredCollection;
    atName: string;
    folder: string;
    name: string;
    files: ScriptFiles;
  }[] = [];
  for (const { collection, scripts } of input.collections) {
    const collectionFolder = input.collections.length > 1
      ? `${uniqueName(collectionFolderName(collection), topNames)}/`
      : '';
    const scriptNames = collectionFolder ? new Set<string>() : topNames;
    for (const script of scripts) {
      // Every script goes in, with whatever text it has: one that is
      // empty, or never loaded, gets an empty `.user.js`.
      const atName = (script.header && getValue(script.header, 'name')?.trim())
        || scriptBasename(script.relativePath).replace(/\.user\.js$/i, '');
      const name = uniqueName(safeFileName(atName, 'script'), scriptNames);
      planned.push({
        script,
        collection,
        atName,
        folder: `${collectionFolder}${name}/`,
        name,
        files: input.options.files ? scriptFiles(script, input.icons) : new Map(),
      });
    }
  }

  // Which files go at the top: a path that scripts name with the same
  // bytes, the version the most scripts use. Not a relative ref's file,
  // and not one whose first folder would land in a collection's or
  // script's folder.
  const shared = new Map<string, Uint8Array>();
  const byPath = new Map<string, Uint8Array[]>();
  for (const p of planned) {
    for (const [path, f] of p.files) {
      if (f.relative || topNames.has(path.split('/')[0].toLowerCase())) continue;
      byPath.set(path, [...(byPath.get(path) ?? []), f.data]);
    }
  }
  for (const [path, versions] of byPath) {
    // Each copy is compared with the distinct versions seen so far,
    // usually one, rather than with every other copy: fifty scripts
    // sharing a large library would otherwise compare it 2,500 times.
    const groups: { data: Uint8Array; count: number }[] = [];
    for (const v of versions) {
      const group = groups.find((g) => sameBytes(g.data, v));
      if (group) group.count++;
      else groups.push({ data: v, count: 1 });
    }
    const best = groups.reduce((a, b) => (b.count > a.count ? b : a));
    if (best.count > 1) shared.set(path, best.data);
  }

  const entries: ZipEntry[] = [];
  const manifestScripts: ManifestScript[] = [];
  let position = 0;
  for (const { script, collection, atName, folder, name, files } of planned) {
    position++;
    const location = scriptLocation(script);
    const modified = script.loadedAt;
    const stem = `${folder}${name}`;
    entries.push({ path: `${stem}.user.js`, data: encoder.encode(fullSource(script)), modified });
    const meta: Record<string, unknown> = { name: atName, uuid: script.id, modified };
    if (location && isHttpUrl(location)) meta.file_url = location;
    entries.push({
      path: `${stem}.options.json`,
      data: json({
        meta,
        // TM and VM have no collections, so a script runs there when it
        // is active here.
        settings: { enabled: isCollectionEnabled(collection) && isScriptEnabled(script), position },
        // Required: VM skips a script without `options`. No `override`,
        // which TM would take as the script's real match rules.
        options: { check_for_updates: meta.file_url !== undefined },
      }),
      modified,
    });
    if (input.options.values) {
      const data: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.values[script.id] ?? {})) {
        const encoded = encodeExportValue(value);
        if (encoded !== undefined) data[key] = encoded;
      }
      if (Object.keys(data).length > 0) {
        entries.push({ path: `${stem}.storage.json`, data: json({ ts: input.now, data }), modified });
      }
    }
    // Its own files, unless the top holds the same bytes. A file can't
    // take one of the script's own entry names.
    const own = new Set([`${name}.user.js`, `${name}.options.json`, `${name}.storage.json`].map((n) => n.toLowerCase()));
    for (const [path, f] of files) {
      const top = shared.get(path);
      if (top && !f.relative && sameBytes(top, f.data)) continue;
      if (own.has(path.toLowerCase())) continue;
      entries.push({ path: `${folder}${path}`, data: f.data });
    }
    manifestScripts.push({
      path: manifestEntryPath(`${stem}.user.js`),
      uuid: script.id,
      collection: collection.id,
      location,
      enabled: isScriptEnabled(script),
    });
  }
  for (const [path, data] of shared) entries.push({ path, data });

  const manifest = {
    created_by: 'SourceMonkey',
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    exported_at: input.now,
    collections: input.collections.map(({ collection }) => manifestCollection(collection)),
    scripts: manifestScripts,
  };
  return {
    entries: [{ path: MANIFEST_FILENAME, data: json(manifest, true) }, ...entries],
    scriptCount: position,
  };
}

// `sourcemonkey-backup-<iso>.zip`, the timestamp as Tampermonkey writes
// its own: `toISOString()` with `.` and `:` turned into `-`.
export function exportFileName(now: number): string {
  return `sourcemonkey-backup-${new Date(now).toISOString().replace(/[.:]/g, '-')}.zip`;
}

// ---------- Page side ----------

// What to export: every collection, or one.
export type ExportScope = { all: true } | { collectionId: string };

// Read everything the plan needs. sm-dev's test collections are left
// out: their scripts belong to a run, and only that run changes them.
export async function gatherExportInput(scope: ExportScope, options: ExportOptions, now: number): Promise<ExportInput> {
  const all = await getCollections();
  const chosen = ('all' in scope ? all : all.filter((c) => c.id === scope.collectionId))
    .filter((c) => !isSmDevCollection(c.path));
  const collections: ExportCollectionInput[] = [];
  for (const c of chosen) {
    const got = await getCollectionWithScripts(c.id);
    if (got) collections.push(got);
  }
  const scripts = collections.flatMap((c) => c.scripts);
  const values = options.values ? await readScriptValues(scripts.map((s) => s.id)) : {};
  const icons: Record<string, Uint8Array> = {};
  if (options.files) {
    const urls = [...new Set(scripts.map(scriptIconUrl).filter((u): u is string => u !== null))];
    await Promise.all(urls.map(async (url) => {
      const dataUrl = await ensureIconForUrl(url).catch(() => null);
      const content = dataUrl ? dataUrlContent(dataUrl) : null;
      if (content) icons[url] = new Uint8Array(base64ToBytes(content.base64));
    }));
  }
  return { collections, values, icons, options, now };
}

export interface ExportResult {
  // Where Chrome saved the file.
  path: string;
  scriptCount: number;
}

// Message for a Save As the person cancelled. Not an error to show.
export const EXPORT_CANCELLED = 'The export was cancelled';

// Build the zip and save it through Chrome's Save As. Resolves once
// the file is written.
export async function runExport(scope: ExportScope, options: ExportOptions): Promise<ExportResult> {
  const now = Date.now();
  const plan = planExportEntries(await gatherExportInput(scope, options, now));
  const bytes = buildZip(plan.entries, now);
  const path = await saveFile(new Blob([bytes as BlobPart], { type: 'application/zip' }), exportFileName(now));
  return { path, scriptCount: plan.scriptCount };
}

// Chrome's reasons a download stopped, in words, for the ones a save
// to disk realistically hits. Others show Chrome's code.
const SAVE_FAILURES: Record<string, string> = {
  FILE_NO_SPACE: 'The disk is full',
  FILE_ACCESS_DENIED: 'Chrome was not allowed to write to that folder',
  FILE_NAME_TOO_LONG: 'The file name is too long',
  FILE_TOO_LARGE: 'The file is too large for that disk',
  FILE_TRANSIENT_ERROR: 'The disk was busy. Try again.',
  FILE_BLOCKED: 'Chrome or the system blocked the file',
};

export function saveFailureMessage(reason: string | undefined): string {
  return (reason && SAVE_FAILURES[reason]) || `Chrome stopped the save (${reason || 'no reason given'})`;
}

// Test seam: headless Chrome can't show a Save As, and reports it as
// cancelled. An e2e test sets this on the page to save straight to the
// Downloads folder instead. Nothing in the extension sets it.
interface ExportTestHooks { smExportSkipSaveAs?: boolean }

// The saved path once download `id` completes, from Chrome's change
// events. Checked once at the start too, for a download that finished
// before the listener was added.
function downloadFinished(id: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const settle = (item: chrome.downloads.DownloadItem | undefined): boolean => {
      if (!item) {
        reject(new Error(EXPORT_CANCELLED));
        return true;
      }
      if (item.state === 'complete') {
        resolve(item.filename);
        return true;
      }
      if (item.state === 'interrupted') {
        reject(new Error(item.error === 'USER_CANCELED' ? EXPORT_CANCELLED : saveFailureMessage(item.error)));
        return true;
      }
      return false;
    };
    const check = (): void => {
      void chrome.downloads.search({ id }).then(([item]) => {
        if (settle(item)) chrome.downloads.onChanged.removeListener(onChanged);
      }, (err: unknown) => {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(err);
      });
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id === id && (delta.state || delta.error)) check();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    check();
  });
}

async function saveFile(blob: Blob, fileName: string): Promise<string> {
  const url = URL.createObjectURL(blob);
  const saveAs = (globalThis as ExportTestHooks).smExportSkipSaveAs !== true;
  try {
    let id: number;
    try {
      id = await chrome.downloads.download({ url, filename: fileName, saveAs, conflictAction: 'uniquify' });
    } catch (err) {
      // A Save As closed without choosing a file can reject here, with
      // Chrome's "Download canceled".
      const text = err instanceof Error ? err.message : String(err);
      if (/cancel/i.test(text)) throw new Error(EXPORT_CANCELLED);
      throw new Error(`Chrome refused to save the file (${text})`);
    }
    // No deadline: the Save As waits on the person.
    return await downloadFinished(id);
  } finally {
    URL.revokeObjectURL(url);
  }
}
