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
import type { ImportInstall, ImportRequest, ImportRestore, ImportUpdate } from './script-store.js';

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
  // Kept only as its text, so an import can replace it.
  stored: boolean;
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
}

export interface PlannedCollection {
  collection: BackupCollection;
  // The backup's scripts a restore puts in it, by index.
  scripts: number[];
  // The collection here it already is. Such a collection isn't made
  // again: its scripts import one by one, as from any backup.
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
  // Restored collections and their scripts.
  restore: ArrivingChoices;
  // New scripts.
  new: ArrivingChoices;
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
  // Link a script with a location (a URL or a file) to it, so it can
  // take updates from there; otherwise it is kept as its text. A
  // restored directory or manifest collection's scripts always link.
  link: boolean;
}

export const DEFAULT_CHOICES: ImportChoices = {
  restore: { values: true, enabled: true, link: true },
  new: { values: true, enabled: true, link: true },
  existing: { text: 'newer', values: false, enabled: false },
};

export type RowAction =
  | { kind: 'install'; linkTo?: string }
  // `text`: the stored text is replaced.
  | { kind: 'update'; text: boolean; values: boolean; enabled: boolean }
  | { kind: 'skip' };

// A location a script can be linked to: a URL, or a file (SourceMonkey
// writes a local script's location as its path).
function isLinkable(location: string): boolean {
  return isHttpUrl(location) || isFileUrl(location) || location.startsWith('/');
}

// What happens to one script of the New or Existing section.
export function actionFor(p: PlannedScript, choices: ImportChoices): RowAction {
  if (!p.match) return installAction(p.script, choices.new);
  const { existing } = choices;
  // Always replaces even the same text, as it says: the backup's
  // dependency files come with it.
  const text = p.match.stored
    && (existing.text === 'always' || (existing.text === 'newer' && p.here === 'older-here'));
  const values = existing.values && p.script.values !== undefined;
  const enabled = existing.enabled && p.script.enabled !== p.match.enabled;
  if (!text && !values && !enabled) return { kind: 'skip' };
  return { kind: 'update', text, values, enabled };
}

function installAction(s: BackupScript, choices: ArrivingChoices): RowAction & { kind: 'install' } {
  const url = s.location;
  // A script edited in the other manager is kept as that text: its
  // location serves something else.
  const link = choices.link && url && isLinkable(url) && !s.userModified;
  return link ? { kind: 'install', linkTo: url } : { kind: 'install' };
}

// How an existing script compares with the backup's, for its table's
// Compared column, and its tooltip naming the copies here.
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

// The scripts `restoring` (collections, by the backup's uuid) puts in
// collections, which the New and Existing sections then leave out.
export function restoredScripts(collections: readonly PlannedCollection[], restoring: ReadonlySet<string>): Set<number> {
  const out = new Set<number>();
  for (const c of collections) {
    if (!c.here && !c.cantRestore && restoring.has(c.collection.uuid)) for (const i of c.scripts) out.add(i);
  }
  return out;
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
// all their scripts, then the rows the user kept checked.
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
    if (c.here || c.cantRestore || !restoring.has(c.collection.uuid)) continue;
    const bc = c.collection;
    const installs = c.scripts.map((i) => {
      const p = plan[i];
      if (bc.kind === 'scripts') return installItem(p.script, choices.restore, installAction(p.script, choices.restore).linkTo);
      return { ...installItem(p.script, choices.restore, undefined), relativePath: restorePath(p.script, bc)! };
    });
    const restore: ImportRestore = {
      name: bc.name, kind: bc.kind, location: bc.location,
      enabled: choices.restore.enabled ? bc.enabled : true, localFiles: bc.localFiles, installs,
    };
    if (bc.builtin) restore.builtin = bc.builtin;
    restores.push(restore);
  }
  const restored = restoredScripts(collections, restoring);
  const installs: ImportInstall[] = [];
  const updates: ImportUpdate[] = [];
  for (const p of plan) {
    if (!checked.has(p.script.index) || restored.has(p.script.index) || isEmptyScript(p.script.text)) continue;
    const action = actionFor(p, choices);
    const s = p.script;
    if (action.kind === 'install') {
      installs.push(installItem(s, choices.new, action.linkTo));
    } else if (action.kind === 'update' && p.match) {
      const update: ImportUpdate = { scriptId: p.match.id };
      if (action.text) {
        update.text = s.text;
        update.files = s.files;
      }
      if (action.enabled) update.enabled = s.enabled;
      if (action.values && s.values) update.values = s.values;
      updates.push(update);
    }
  }
  const request: ImportRequest = { source: backup.source, into, installs, updates };
  if (restores.length > 0) request.restores = restores;
  return request;
}
