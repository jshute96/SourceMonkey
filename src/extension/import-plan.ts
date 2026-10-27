// Plans an import (docs/import.md): which scripts in a backup are
// already here, how the two copies compare, and what the dialog's
// choices do to each. Pure, so the preview and the unit tests share it;
// the page reads the rows, and the worker applies the request it builds
// (`importScripts` in script-store.ts).

import { compareVersions } from '../version-compare.js';
import { getValue, type ParsedHeader } from '../userscript-header.js';
import { identityKey, locationKey } from './script-keys.js';
import { canonicalCollectionInput, containerKind, isContainerCollection, isFileUrl, isHttpUrl, locationFsPath } from '../file-locations.js';
import { githubDirScriptFileUrl, parseGithubUrl } from './github-provider.js';
import { isEmptyScript, type BackupCollection, type BackupScript, type ParsedBackup } from './import-backup.js';
import type { ImportAddition, ImportInstall, ImportNamed, ImportRequest, ImportRestore, ImportUpdate } from './script-store.js';

// A script installed here, as the planner needs it.
export interface InstalledCopy {
  id: string;
  collectionId: string;
  // Its collection's name, for the tooltip listing copies.
  collectionName: string;
  fileUrl: string;
  header: ParsedHeader | null;
  contentHash?: string;
  enabled: boolean;
  // Kept only as its text (imported or scratch).
  stored: boolean;
  // In a scripts collection, where replacing its text can also change
  // where it loads from (`locationChange`). In a directory, manifest or
  // GitHub collection, the collection says where.
  inScripts: boolean;
  // The id its import record gives it (`ImportInfo.foreignId`).
  importedId?: string;
}

// How what's here compares with the file's copy.
export type HereState =
  | 'new'          // Not here
  | 'same'         // The same text
  | 'older-here'   // The file's @version is newer
  | 'newer-here'   // Ours is newer
  | 'changed';     // Same @version, different text

export interface PlannedScript {
  script: BackupScript;
  // Every copy here, best match first.
  copies: InstalledCopy[];
  // The copy an update applies to.
  match?: InstalledCopy;
  matchedBy?: 'id' | 'location' | 'name';
  here: HereState;
}

// `hash` gives each script's content hash, as stored rows have it.
export function planImport(
  backup: ParsedBackup,
  installed: readonly InstalledCopy[],
  hashes: readonly string[],
): PlannedScript[] {
  return backup.scripts.map((script, i) => planOne(script, hashes[i], installed));
}

function planOne(script: BackupScript, hash: string, installed: readonly InstalledCopy[]): PlannedScript {
  const byId = script.foreignId
    ? installed.filter((c) => c.id === script.foreignId || c.importedId === script.foreignId)
    : [];
  const loc = script.location ? locationKey(script.location) : null;
  const byLocation = loc ? installed.filter((c) => locationKey(c.fileUrl) === loc) : [];
  const identity = identityKey(script.header);
  const byName = identity ? installed.filter((c) => identityKey(c.header) === identity) : [];

  const copies: InstalledCopy[] = [];
  for (const list of [byId, byLocation, byName]) {
    // An active copy first, as the one an update goes to.
    for (const c of [...list].sort((a, b) => Number(b.enabled) - Number(a.enabled))) {
      if (!copies.includes(c)) copies.push(c);
    }
  }
  if (copies.length === 0) return { script, copies, here: 'new' };
  const match = copies[0];
  const matchedBy = byId.includes(match) ? 'id' : byLocation.includes(match) ? 'location' : 'name';
  return { script, copies, match, matchedBy, here: compareCopies(script, hash, match) };
}

function compareCopies(script: BackupScript, hash: string, match: InstalledCopy): HereState {
  if (match.contentHash === hash) return 'same';
  const ours = match.header ? getValue(match.header, 'version') ?? '' : '';
  const cmp = compareVersions(script.version, ours);
  return cmp > 0 ? 'older-here' : cmp < 0 ? 'newer-here' : 'changed';
}

// ---------- Restoring collections ----------

// A collection here, as matching the backup's needs it.
export interface HereCollection {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  scriptCount: number;
}

export interface PlannedCollection {
  collection: BackupCollection;
  // The backup's scripts a restore puts in it, by index.
  scripts: number[];
  // The collection here it already is. Such a collection isn't made
  // again: the scripts it doesn't have are added to it
  // (`addingScripts`), and the ones it has import one by one, as from
  // any backup.
  here?: HereCollection;
  // Set when it can't be restored: its scripts' paths in it aren't
  // known. Its scripts import one by one.
  cantRestore?: boolean;
}

// The backup's collections that have scripts to restore, each matched
// to a collection here by its id, its location, its built-in scheme,
// or (a scripts collection) its name.
export function planCollections(backup: ParsedBackup, here: readonly HereCollection[]): PlannedCollection[] {
  const out: PlannedCollection[] = [];
  for (const collection of backup.collections) {
    const members = backup.scripts.filter((s) => s.collection === collection.uuid);
    if (members.length === 0) continue;
    const scripts = members.filter((s) => restorePath(s, collection) !== null).map((s) => s.index);
    const planned: PlannedCollection = { collection, scripts };
    if (scripts.length < members.length) {
      planned.scripts = members.map((s) => s.index);
      planned.cantRestore = true;
    }
    const match = here.find((h) => h.id === collection.uuid) ?? here.find((h) => sameCollection(h, collection));
    if (match) planned.here = match;
    out.push(planned);
  }
  return out;
}

function sameCollection(h: HereCollection, c: BackupCollection): boolean {
  if (c.location) return canonicalCollectionInput(h.path) === canonicalCollectionInput(c.location);
  if (c.builtin) return containerKind(h.path) === c.builtin;
  return isContainerCollection(h.path) && !containerKind(h.path)
    && h.name.trim().toLowerCase() === c.name.trim().toLowerCase();
}

// Where `script` goes in a restored `collection`: '' for a scripts
// collection, which places it by its location; its path in a
// directory, manifest or GitHub one. Null when it isn't one of that
// collection's, or its path there isn't known: an export from before
// the manifest carried it, for a manifest. A local or GitHub
// directory's is worked out from the script's location.
export function restorePath(script: BackupScript, collection: BackupCollection): string | null {
  if (script.collection !== collection.uuid) return null;
  if (collection.kind === 'scripts') return '';
  if (script.relativePath) return script.relativePath;
  if (collection.kind !== 'directory' || !collection.location || !script.location) return null;
  const github = parseGithubUrl(collection.location);
  const dir = github ? githubDirScriptFileUrl(collection.location, '')
    : isHttpUrl(collection.location) ? null
      : locationFsPath(collection.location).replace(/\/+$/, '') + '/';
  const file = github ? script.location : locationFsPath(script.location);
  return dir && file.startsWith(dir) && file.length > dir.length ? file.slice(dir.length) : null;
}

// ---------- The dialog's choices ----------

// Each of the dialog's sections has its own choices. Scripts that come
// in fresh, restored or new, take the backup's values and enabled
// state by default; for a script already here those would overwrite
// what it has now, so they start off.
export interface ImportChoices {
  // The Directory collections section: restored collections and their
  // scripts, and collections here and the scripts added to them.
  restore: {
    values: boolean;
    enabled: boolean;
  };
  // New scripts.
  new: ArrivingChoices & {
    // Each goes into its scripts collection from the backup (one here by
    // that name, or one made like it) rather than `into`.
    byCollection: boolean;
  };
  // Scripts already here.
  existing: {
    // Which stored texts the backup's replaces.
    text: 'leave' | 'newer' | 'always';
    // The backup's stored values replace the script's.
    values: boolean;
    // The script takes the backup's enabled state.
    enabled: boolean;
  };
}

export interface ArrivingChoices {
  // Bring the backup's stored values.
  values: boolean;
  // Take the backup's enabled state; otherwise it comes in enabled.
  enabled: boolean;
}

// Where a script arriving from the backup loads from: its location (a
// URL or a file), so it takes updates from there, else undefined, for
// one kept as its text. A script edited in the other manager is kept as
// that text: its location serves something else.
export function arrivingLocation(s: BackupScript): string | undefined {
  const url = s.location;
  return url && isLinkable(url) && !s.userModified ? url : undefined;
}

// Where an existing script loads from once the backup's text replaces
// its own, when that changes: a URL or file to link it to, or null to
// keep it as its text. One in a scripts collection becomes what a new
// install of the backup's would be; one in any other collection loads
// from where that collection says.
export function locationChange(p: PlannedScript): string | null | undefined {
  const m = p.match;
  if (!m?.inScripts) return undefined;
  const to = arrivingLocation(p.script);
  if (!to) return m.stored ? undefined : null;
  return !m.stored && locationKey(m.fileUrl) === locationKey(to) ? undefined : to;
}

export const DEFAULT_CHOICES: ImportChoices = {
  restore: { values: true, enabled: true },
  new: { values: true, enabled: true, byCollection: true },
  existing: { text: 'newer', values: false, enabled: false },
};

export type RowAction =
  | { kind: 'install'; linkTo?: string }
  // `text`: the script's text is replaced.
  | { kind: 'update'; text: boolean; values: boolean; enabled: boolean }
  | { kind: 'skip' };

// A location a script can be linked to: a URL, or a file (SourceMonkey
// writes a local script's location as its path).
function isLinkable(location: string): boolean {
  return isHttpUrl(location) || isFileUrl(location) || location.startsWith('/');
}

// What happens to one script of the New or Existing section.
export function actionFor(p: PlannedScript, choices: ImportChoices): RowAction {
  if (!p.match) return installAction(p.script);
  const { existing } = choices;
  // Always replaces even the same text, as it says, when something else
  // about the script changes: the backup's dependency files come with
  // it. A script with no changes at all the dialog never imports.
  // A script that loads from a URL or file takes the backup's text too,
  // until its next refresh loads what its location has then.
  const text = existing.text === 'always' || (existing.text === 'newer' && p.here === 'older-here');
  const values = existing.values && p.script.values !== undefined;
  const enabled = existing.enabled && p.script.enabled !== p.match.enabled;
  if (!text && !values && !enabled) return { kind: 'skip' };
  return { kind: 'update', text, values, enabled };
}

function installAction(s: BackupScript): RowAction & { kind: 'install' } {
  const linkTo = arrivingLocation(s);
  return linkTo ? { kind: 'install', linkTo } : { kind: 'install' };
}

// How an existing script compares with the backup's, and the copies
// here, for the Content cell's tooltip.
export function hereText(p: PlannedScript): { text: string; title: string } {
  const texts: Record<HereState, string> = {
    'new': 'New',
    'same': 'Same',
    'older-here': 'Backup is newer',
    'newer-here': 'Installed is newer',
    'changed': 'Same version, different text',
  };
  const titles: Record<HereState, string> = {
    'new': 'Not installed',
    'same': 'Installed with the same text',
    'older-here': 'The backup has a newer @version than the installed copy',
    'newer-here': 'The installed copy has a newer @version than the backup',
    'changed': 'Installed with the same @version but different text',
  };
  const where = p.copies.map((c) => `${p.copies.length > 1 && c === p.match ? '* ' : ''}${c.collectionName}`);
  const title = p.copies.length === 0 ? titles[p.here]
    : `${titles[p.here]}.\n${p.copies.length > 1 ? 'Copies in' : 'In'}: ${where.join(', ')}`;
  return { text: texts[p.here], title };
}

// ---------- The Existing table's columns ----------
//
// Each column shows the installed copy's value, or, where the backup's
// differs, `installed → backup`: what the import could change, whatever
// the choices. `∅` stands for nothing.

export const ARROW = ' \u2192 ';
export const NOTHING = '\u2205';
export const CHECK = '\u2713';

// `1.0`, or `1.0 → 2.0 (Newer)`: the backup's version against the
// installed one, newer or older by @version order.
export function versionText(p: PlannedScript): string {
  const ours = p.match?.header ? getValue(p.match.header, 'version') ?? '' : '';
  const theirs = p.script.version;
  if (ours === theirs) return ours;
  const order = p.here === 'older-here' ? ' (Newer)' : p.here === 'newer-here' ? ' (Older)' : '';
  return `${ours || NOTHING}${ARROW}${theirs || NOTHING}${order}`;
}

export function contentText(p: PlannedScript): string {
  return p.here === 'same' ? 'Same' : 'Different';
}

// The Values column. A backup without values for the script leaves the
// installed ones, so that shows only whether it has any; one with
// values (even none) replaces them whole.
export function valuesText(installed: Record<string, unknown> | undefined, backup: Record<string, unknown> | undefined): string {
  const here = installed !== undefined && Object.keys(installed).length > 0;
  if (backup === undefined) return here ? CHECK : '';
  const there = Object.keys(backup).length > 0;
  if (!here && !there) return '';
  if (!here) return `${NOTHING}${ARROW}${CHECK}`;
  if (!there) return `${CHECK}${ARROW}${NOTHING}`;
  return sameValues(installed, backup) ? `${CHECK} (Same)` : `${CHECK}${ARROW}${CHECK} (Different)`;
}

function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return stableJson(a) === stableJson(b);
}

// JSON with object keys sorted, so key order doesn't count.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// The scripts `restoring` (collections, by the backup's uuid) puts in
// restored collections.
export function restoredScripts(collections: readonly PlannedCollection[], restoring: ReadonlySet<string>): Set<number> {
  const out = new Set<number>();
  for (const c of collections) {
    if (restorable(c) && restoring.has(c.collection.uuid)) for (const i of c.scripts) out.add(i);
  }
  return out;
}

// The scripts the Directory collections section takes, which the New
// and Existing sections leave out: all those of the collections it can
// restore, and all those it can add to collections here, checked or
// not. An unchecked collection's scripts aren't imported.
export function collectionScripts(collections: readonly PlannedCollection[], plan: readonly PlannedScript[]): Set<number> {
  const out = new Set<number>();
  for (const c of collections) for (const i of restorable(c) ? c.scripts : addingScripts(c, plan)) out.add(i);
  return out;
}

// The backup's scripts a directory, manifest or GitHub collection here
// doesn't have, which an import adds to it at their paths, as a restore
// would: those with no copy here.
export function addingScripts(c: PlannedCollection, plan: readonly PlannedScript[]): number[] {
  if (!c.here || c.cantRestore || c.collection.kind === 'scripts') return [];
  return c.scripts.filter((i) => !plan[i].match);
}

// A directory, manifest or GitHub collection here that an import can
// add scripts to.
export function updatable(c: PlannedCollection, plan: readonly PlannedScript[]): boolean {
  return addingScripts(c, plan).length > 0;
}

// A directory, manifest or GitHub collection that isn't here and can be
// made again. A scripts collection's scripts import as new or existing
// ones instead, by its name (`backupScriptsCollection`).
export function restorable(c: PlannedCollection): boolean {
  return c.collection.kind !== 'scripts' && !c.here && !c.cantRestore;
}

// The backup's scripts collection `s` was in, if any.
export function backupScriptsCollection(s: BackupScript, collections: readonly PlannedCollection[]): PlannedCollection | undefined {
  return collections.find((c) => c.collection.uuid === s.collection && c.collection.kind === 'scripts');
}

function installItem(s: BackupScript, choices: ArrivingChoices, linkTo: string | undefined): ImportInstall {
  const item: ImportInstall = { name: s.name, text: s.text, enabled: choices.enabled ? s.enabled : true };
  if (linkTo) item.linkTo = linkTo;
  if (s.location) item.location = s.location;
  if (s.foreignId) item.foreignId = s.foreignId;
  if (choices.values && s.values) item.values = s.values;
  if (Object.keys(s.files).length > 0) item.files = s.files;
  return item;
}

// The request the worker applies: the collections in `restoring` with
// all their scripts (or, for one here, the scripts it doesn't have),
// then the rows the user kept checked. With
// `byCollection`, a new script from one of the backup's scripts
// collections goes into it by name; the rest go `into`.
export function buildImportRequest(
  backup: ParsedBackup,
  plan: readonly PlannedScript[],
  checked: ReadonlySet<number>,
  choices: ImportChoices,
  into: ImportRequest['into'],
  collections: readonly PlannedCollection[] = [],
  restoring: ReadonlySet<string> = new Set(),
): ImportRequest {
  const restores: ImportRestore[] = [];
  for (const c of collections) {
    if (!restorable(c) || !restoring.has(c.collection.uuid)) continue;
    const bc = c.collection;
    // Its scripts load from its location, so they aren't linked one by one.
    const installs = c.scripts.map((i) => ({ ...installItem(plan[i].script, choices.restore, undefined), relativePath: restorePath(plan[i].script, bc)! }));
    const restore: ImportRestore = {
      name: bc.name, kind: bc.kind, location: bc.location,
      enabled: choices.restore.enabled ? bc.enabled : true, localFiles: bc.localFiles, installs,
    };
    if (bc.builtin) restore.builtin = bc.builtin;
    restores.push(restore);
  }
  const additions: ImportAddition[] = [];
  for (const c of collections) {
    if (!updatable(c, plan) || !restoring.has(c.collection.uuid)) continue;
    const bc = c.collection;
    const installs = addingScripts(c, plan).map((i) => ({ ...installItem(plan[i].script, choices.restore, undefined), relativePath: restorePath(plan[i].script, bc)! }));
    additions.push({ collectionId: c.here!.id, installs });
  }
  const restored = collectionScripts(collections, plan);
  const installs: ImportInstall[] = [];
  const named = new Map<string, ImportNamed>();
  const updates: ImportUpdate[] = [];
  for (const p of plan) {
    if (!checked.has(p.script.index) || restored.has(p.script.index) || isEmptyScript(p.script.text)) continue;
    const action = actionFor(p, choices);
    const s = p.script;
    if (action.kind === 'install') {
      const item = installItem(s, choices.new, action.linkTo);
      const c = choices.new.byCollection ? backupScriptsCollection(s, collections) : undefined;
      if (!c) {
        installs.push(item);
        continue;
      }
      let group = named.get(c.collection.uuid);
      if (!group) {
        const bc = c.collection;
        group = c.here ? { collectionId: c.here.id, installs: [] } : {
          create: {
            name: bc.name, kind: 'scripts', location: null, ...(bc.builtin ? { builtin: bc.builtin } : {}),
            enabled: choices.new.enabled ? bc.enabled : true, localFiles: bc.localFiles,
          },
          installs: [],
        };
        named.set(bc.uuid, group);
      }
      group.installs.push(item);
    } else if (action.kind === 'update' && p.match) {
      const update: ImportUpdate = { scriptId: p.match.id };
      if (action.text) {
        update.text = s.text;
        update.files = s.files;
        const to = locationChange(p);
        if (to !== undefined) {
          update.relink = { to, name: s.name };
          if (s.location) update.relink.location = s.location;
          if (s.foreignId) update.relink.foreignId = s.foreignId;
        }
      }
      if (action.enabled) update.enabled = s.enabled;
      if (action.values && s.values) update.values = s.values;
      updates.push(update);
    }
  }
  const request: ImportRequest = { source: backup.source, into, installs, updates };
  if (restores.length > 0) request.restores = restores;
  if (additions.length > 0) request.additions = additions;
  if (named.size > 0) request.named = [...named.values()];
  return request;
}
