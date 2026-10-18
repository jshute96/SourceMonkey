// Plans an import (docs/import.md): which scripts in a backup are
// already here, how the two copies compare, and what the dialog's
// choices do to each. Pure, so the preview and the unit tests share it;
// the page reads the rows, and the worker applies the request it builds
// (`importScripts` in script-store.ts).

import { compareVersions } from '../version-compare.js';
import { getValue, type ParsedHeader } from '../userscript-header.js';
import { identityKey, locationKey } from './script-keys.js';
import { isHttpUrl } from '../file-locations.js';
import type { BackupScript, ParsedBackup } from './import-backup.js';
import type { ImportInstall, ImportRequest, ImportUpdate } from './script-store.js';

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

// ---------- The dialog's choices ----------

export interface ImportChoices {
  // What to do with scripts already here.
  existing: 'leave' | 'newer' | 'always';
  // Bring the file's stored values. They replace an updated script's.
  values: boolean;
  // Take the file's on/off state; otherwise new scripts come in off,
  // and updated ones keep theirs.
  enabledFromFile: boolean;
  // Install a script with a web address so it loads and updates from
  // there; otherwise it is kept as its text.
  followUrls: boolean;
}

export const DEFAULT_CHOICES: ImportChoices = {
  existing: 'newer',
  values: true,
  enabledFromFile: true,
  followUrls: true,
};

export type RowAction =
  | { kind: 'install'; followUrl?: string }
  // `text`: the stored text is replaced.
  | { kind: 'update'; text: boolean; values: boolean; enabled: boolean }
  // `located`: a copy here that loads from its own location, with
  // nothing else to replace.
  | { kind: 'skip'; located?: boolean };

export function actionFor(p: PlannedScript, choices: ImportChoices): RowAction {
  if (!p.match) {
    const url = p.script.location;
    // A script edited in the other manager is kept as that text: its
    // web address serves something else.
    const follow = choices.followUrls && url && isHttpUrl(url) && !p.script.userModified;
    return follow ? { kind: 'install', followUrl: url } : { kind: 'install' };
  }
  if (choices.existing === 'leave') return { kind: 'skip' };
  if (choices.existing === 'newer' && p.here !== 'older-here') return { kind: 'skip' };
  const text = p.match.stored && p.here !== 'same';
  const values = choices.values && p.script.values !== undefined;
  const enabled = choices.enabledFromFile && p.script.enabled !== p.match.enabled;
  if (!text && !values && !enabled) return p.match.stored || p.here === 'same' ? { kind: 'skip' } : { kind: 'skip', located: true };
  return { kind: 'update', text, values, enabled };
}

// What the Result column says.
export function actionText(action: RowAction, p: PlannedScript): string {
  switch (action.kind) {
    case 'install':
      return action.followUrl ? 'Install, updating from its web address' : 'Install as imported text';
    case 'skip':
      if (action.located) return 'Leave as it is: it loads from its own location';
      return p.match ? 'Leave as it is' : 'Skip';
    case 'update': {
      const parts = [
        ...(action.text ? ['text'] : []),
        ...(action.values ? ['values'] : []),
        ...(action.enabled ? ['on/off state'] : []),
      ];
      const list = parts.length === 1 ? parts[0]
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
      return `Replace its ${list}`;
    }
  }
}

// What the Here column says, and its tooltip.
export function hereText(p: PlannedScript): { text: string; title: string } {
  const texts: Record<HereState, string> = {
    'new': 'New',
    'same': 'Same',
    'older-here': 'Older here',
    'newer-here': 'Newer here',
    'changed': 'Changed',
  };
  const titles: Record<HereState, string> = {
    'new': 'Not installed here',
    'same': 'Installed here with the same text',
    'older-here': 'The file has a newer @version than the copy here',
    'newer-here': 'The copy here has a newer @version than the file',
    'changed': 'Installed here with the same @version but different text',
  };
  const where = p.copies.map((c) => `${p.copies.length > 1 && c === p.match ? '* ' : ''}${c.collectionName}`);
  const title = p.copies.length === 0 ? titles[p.here]
    : `${titles[p.here]}.\n${p.copies.length > 1 ? 'Copies in' : 'In'}: ${where.join(', ')}`;
  return { text: texts[p.here], title };
}

// The request the worker applies, for the rows the user kept checked.
export function buildImportRequest(
  backup: ParsedBackup,
  plan: readonly PlannedScript[],
  checked: ReadonlySet<number>,
  choices: ImportChoices,
  into: ImportRequest['into'],
): ImportRequest {
  const installs: ImportInstall[] = [];
  const updates: ImportUpdate[] = [];
  for (const p of plan) {
    if (!checked.has(p.script.index)) continue;
    const action = actionFor(p, choices);
    const s = p.script;
    if (action.kind === 'install') {
      const item: ImportInstall = { name: s.name, text: s.text, enabled: choices.enabledFromFile ? s.enabled : false };
      if (action.followUrl) item.followUrl = action.followUrl;
      if (s.location) item.location = s.location;
      if (s.foreignId) item.foreignId = s.foreignId;
      if (choices.values && s.values) item.values = s.values;
      if (Object.keys(s.files).length > 0) item.files = s.files;
      installs.push(item);
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
  return { source: backup.source, into, installs, updates };
}
