// The enable toggles that keep one copy of each script active: its own
// flag and its collection's both on, so it fires on the pages it
// matches.
//
// The collections page's and the toolbar popup's enable controls, and
// sm-dev's `collection enable`, go through here, so they apply the same
// rules:
//   - Turning a copy on turns its other active copies off.
//   - Turning a collection on does the same for each copy it activates.
//   - Turning a collection off brings back the copies its own copies
//     displaced, when nothing has changed them since.
//   - "Enable all" in a collection turns on one copy per script.
// Ctrl/Cmd-click (`solo`) opts out and changes only what was clicked.
//
// Each one reads the whole store to find which copies are related, then
// decides which of those to change inside the write lock, from their
// stored state at that moment (`writeEnablementFrom`).
//
// The viewer works out the same single-script rule through
// `enableChanges` (script-identity.ts) itself, to paint its rows before
// the write lands, then writes through `enableWithin` here. Installs,
// moves and sm-dev's `script enable` use `turnOffOtherCopies` there.
//
// Design: docs/script-enablement.md.

import { isSmDevCollection } from './directories.js';
import {
  getAllScripts, getCollections, isCollectionEnabled, isScriptEnabled,
  writeEnablement, writeEnablementFrom, type EnablementResult, type EnablementRows, type EnablementTimes,
  type EnablementTimesMap, type StoredCollection, type StoredScript,
} from './script-store.js';
import {
  allRelatedRows, enableChanges, findRelatedVersions, isActive, otherActiveCopies,
  type RelatedScript,
} from './script-identity.js';
import { compareInCollection, preferredCopy, type CopyFacts } from './copy-preference.js';
import { sameScript } from './script-keys.js';
import { effectiveDisplayName } from './collection-display.js';
import { getValue } from '../userscript-header.js';
import { startPhaseTimer, type PhaseTimer } from '../phase-timing.js';

// What the read before the lock returns. Each enable below reads the
// whole store first, to find which copies are related, then plans from
// those copies re-read inside the write lock (`writeEnablementFrom`).
type Scan = Pick<EnablementRows, 'scripts' | 'collections'>;

// Marked on `timer` as `read all`, with what it returned. No size: the
// script rows come from a scan of all storage, whose own line has it.
async function scan(timer: PhaseTimer): Promise<Scan> {
  const [scripts, collections] = await Promise.all([getAllScripts(), getCollections()]);
  timer.mark('read all', `${scripts.length} scripts, ${collections.length} collections`);
  return { scripts, collections };
}

// Every installed copy related to `script` (same location or same
// `@namespace` + `@name`), itself included.
function relatedRows(snap: Scan, script: StoredScript): RelatedScript[] {
  return allRelatedRows(findRelatedVersions({
    ...snap, location: script.fileUrl, header: script.header ?? null,
  }));
}

// What `copy-preference.ts` orders a copy by.
export function copyFacts(
  script: StoredScript,
  collection: StoredCollection | undefined,
  times: EnablementTimes | undefined,
): CopyFacts {
  return {
    enabled: isScriptEnabled(script),
    collectionOn: collection ? isCollectionEnabled(collection) : true,
    collectionName: collection ? effectiveDisplayName(collection) : '',
    activeSince: times?.activeSince,
    inactiveSince: times?.inactiveSince,
    version: (script.header ? getValue(script.header, 'version')?.trim() : '') || null,
    location: script.fileUrl,
  };
}

// The ids of `scripts` and every copy related to any of them.
function relatedIds(snap: Scan, scripts: readonly StoredScript[]): Set<string> {
  const ids = new Set<string>();
  for (const script of scripts) {
    ids.add(script.id);
    for (const r of relatedRows(snap, script)) ids.add(r.script.id);
  }
  return ids;
}

// Turn one copy on or off. On, without `solo`, turns its other active
// copies off in the same write, when that makes it active. Ticked under
// a disabled collection it isn't active, so it displaces nothing. Off
// changes only this copy: nothing is promoted in its place.
//
// Returns the copy as stored after the write, and every row the write
// changed (the copies it turned off among them).
export async function setScriptEnabledExclusive(
  id: string,
  enabled: boolean,
  solo = false,
): Promise<{ script: StoredScript | null; changed: StoredScript[] }> {
  const timer = startPhaseTimer(enabled ? 'enable script' : 'disable script');
  let written: EnablementResult & { clicked: StoredScript | null };
  if (enabled && !solo) {
    const snap = await scan(timer);
    const script = snap.scripts.find((s) => s.id === id);
    written = await enableWithin(id, script ? relatedIds(snap, [script]) : [id], timer);
  } else {
    let clicked: StoredScript | null = null;
    const result = await writeEnablementFrom({ scriptIds: [id] }, (fresh) => {
      clicked = fresh.scripts.find((s) => s.id === id) ?? null;
      return { scripts: [{ id, enabled }] };
    }, timer);
    written = { ...result, clicked };
    timer.note('1 change(s)');
  }
  timer.done();
  // Nothing written when it was already in that state, and then the row
  // as read inside the lock is the stored one. Not read again here: an
  // await after the lock would let a later click's result reach the
  // caller first.
  const script = written.scripts.find((s) => s.id === id) ?? written.clicked;
  return { script, changed: written.scripts };
}

// Turn copy `id` on, and every other active copy in `scope` off,
// planned inside the write lock from those rows as stored then. `scope`
// is the copies the caller counts as this one's: every copy related to
// it, or for the viewer's versions table, every copy the table shows
// (related to the script on screen, which the clicked one may not be in
// both ways). For a caller that already knows them, so it needs no read
// of its own.
//
// `clicked` is the copy as stored after the write.
export async function enableWithin(
  id: string,
  scope: Iterable<string>,
  timer: PhaseTimer,
): Promise<EnablementResult & { clicked: StoredScript | null }> {
  let count = 0;
  let clicked: StoredScript | null = null;
  const written = await writeEnablementFrom({ scriptIds: scope }, (fresh) => {
    let changes = [{ id, enabled: true }];
    const script = fresh.scripts.find((s) => s.id === id);
    clicked = script ?? null;
    const collection = fresh.collections.find((c) => c.id === script?.collectionId);
    if (script && (!collection || isCollectionEnabled(collection))) {
      changes = enableChanges(id, true, asRows(fresh))
        .map((c) => ({ id: c.scriptId, enabled: c.enabled }));
    }
    count = changes.length;
    return { scripts: changes };
  }, timer);
  timer.note(`${count} change(s)`);
  return { ...written, clicked: written.scripts.find((s) => s.id === id) ?? clicked };
}

// Every row in `rows` as a related copy, without filtering by location
// or identity again: the caller already chose them. `enableChanges` reads
// only the row and its collection, not how it matched.
function asRows(rows: EnablementRows): RelatedScript[] {
  const byId = new Map(rows.collections.map((c) => [c.id, c]));
  return rows.scripts.map((script) => ({
    script,
    collection: byId.get(script.collectionId) ?? null,
    sameLocation: false,
    sameIdentity: false,
  }));
}

// Turn a collection on or off.
//   - On, without `solo`: each of its copies that becomes active turns
//     off its other active copies elsewhere. Two copies inside the
//     collection are both left as their own boxes say.
//   - Off, without `solo`: each of its active copies that displaced
//     others (they went inactive at the moment it became active, and
//     haven't been active since) brings them back, unless another copy
//     of that script is still active.
//
// Returns the collection as written and every script row whose flag
// changed (none of them in this collection).
export async function setCollectionEnabledExclusive(
  id: string,
  enabled: boolean,
  solo = false,
): Promise<EnablementResult> {
  const timer = startPhaseTimer(enabled ? 'enable collection' : 'disable collection');
  const snap = await scan(timer);
  const collection = snap.collections.find((c) => c.id === id);
  let written: EnablementResult;
  let count = 0;
  if (!collection || solo || isSmDevCollection(collection.path)) {
    written = await writeEnablement({ collection: { id, enabled } }, timer);
  } else {
    const scope = relatedIds(snap, snap.scripts.filter((s) => s.collectionId === id));
    written = await writeEnablementFrom({ scriptIds: scope, collectionIds: [id] }, (fresh) => {
      const current = fresh.collections.find((c) => c.id === id);
      let changes: { id: string; enabled: boolean }[] = [];
      if (current && isCollectionEnabled(current) !== enabled) {
        const own = fresh.scripts.filter((s) => s.collectionId === id && isScriptEnabled(s));
        changes = enabled ? displacedBy(fresh, own) : restoredFor(fresh, id, own);
      }
      count = changes.length;
      return { collection: { id, enabled }, scripts: changes };
    }, timer);
  }
  timer.note(`${count} other cop${count === 1 ? 'y' : 'ies'} changed`);
  timer.done();
  return written;
}

// The copies outside the collection that `starting` (its copies about to
// become active) switch off. One that landed `invalid` does too, as
// `turnOffOtherCopies` explains.
function displacedBy(snap: Scan, starting: readonly StoredScript[]): { id: string; enabled: boolean }[] {
  const off = new Set<string>();
  const startingCollections = new Set(starting.map((s) => s.collectionId));
  for (const script of starting) {
    for (const other of otherActiveCopies(relatedRows(snap, script), script.id)) {
      if (!startingCollections.has(other.script.collectionId)) off.add(other.script.id);
    }
  }
  return [...off].map((sid) => ({ id: sid, enabled: false }));
}

// The copies to bring back when collection `id` turns off and
// `stopping` (its active copies) go inactive.
function restoredFor(
  snap: EnablementRows,
  id: string,
  stopping: readonly StoredScript[],
): { id: string; enabled: boolean }[] {
  const on = new Set<string>();
  for (const script of stopping) {
    const activeSince = snap.times[script.id]?.activeSince;
    if (activeSince === undefined) continue;
    const rows = relatedRows(snap, script).filter((r) => r.script.collectionId !== id);
    // Another copy is still active: bringing one back would make two.
    // An sm-dev run's copies don't count, as everywhere.
    if (rows.some((r) => isActive(r) && !(r.collection && isSmDevCollection(r.collection.path)))) continue;
    for (const r of rows) {
      if (
        !isScriptEnabled(r.script)
        && snap.times[r.script.id]?.inactiveSince === activeSince
        && (r.collection ? isCollectionEnabled(r.collection) : true)
        && !(r.collection && isSmDevCollection(r.collection.path))
      ) on.add(r.script.id);
    }
  }
  return [...on].map((sid) => ({ id: sid, enabled: true }));
}

// The collections page's bulk toggle.
//   - Off: every script in the collection off.
//   - On: one copy per script on, the first by `compareInCollection`,
//     and any other copy of it in the collection off. Without `solo`,
//     each copy turned on also turns off its other active copies
//     elsewhere, when the collection is on. With `solo`, every script.
//
// Returns every script row whose flag changed, here and elsewhere.
export async function setAllScriptsEnabled(
  collectionId: string,
  enabled: boolean,
  solo = false,
): Promise<StoredScript[]> {
  const timer = startPhaseTimer(enabled ? 'enable all' : 'disable all');
  const snap = await scan(timer);
  const collection = snap.collections.find((c) => c.id === collectionId);
  if (!collection) {
    timer.note('collection gone');
    timer.done();
    return [];
  }
  const scripts = snap.scripts.filter((s) => s.collectionId === collectionId);
  if (!enabled || solo || isSmDevCollection(collection.path)) {
    const written = await writeEnablement({ scripts: scripts.map((s) => ({ id: s.id, enabled })) }, timer);
    timer.note(`${scripts.length} script(s)`);
    timer.done();
    return written.scripts;
  }
  let count = 0;
  const written = await writeEnablementFrom(
    { scriptIds: relatedIds(snap, scripts), collectionIds: [collectionId] },
    (fresh) => {
      const current = fresh.collections.find((c) => c.id === collectionId);
      if (!current) return null;
      const w = enableAllWrite(fresh, current);
      count = w.scripts.length;
      return w;
    },
    timer,
  );
  timer.note(`${count} change(s)`);
  timer.done();
  return written.scripts;
}

// What "Enable all" writes for `collection`, from `snap`.
function enableAllWrite(
  snap: EnablementRows,
  collection: StoredCollection,
): { scripts: { id: string; enabled: boolean }[]; started: string[] } {
  const scripts = snap.scripts.filter((s) => s.collectionId === collection.id);
  const picks = pickOnePerScript(scripts, collection, snap.times);
  const changes = scripts.map((s) => ({ id: s.id, enabled: picks.has(s.id) }));
  // A pick that was already active and now displaces copies is stamped
  // as becoming active now, so turning this collection off brings them
  // back (`turnOffOtherCopies` does the same).
  const started: string[] = [];
  if (isCollectionEnabled(collection)) {
    for (const pick of scripts.filter((s) => picks.has(s.id))) {
      const off = displacedBy(snap, [pick]);
      const sameCollectionOff = scripts.filter((s) =>
        !picks.has(s.id) && isScriptEnabled(s) && sameScript(s, pick));
      if (isScriptEnabled(pick) && (off.length > 0 || sameCollectionOff.length > 0)) started.push(pick.id);
      changes.push(...off);
    }
  }
  return { scripts: changes, started };
}

// One id per script among `scripts` (all in `collection`): the first by
// `compareInCollection` among each copy and the copies it shares a
// location or `@namespace` + `@name` with (`sameScript`).
export function pickOnePerScript(
  scripts: readonly StoredScript[],
  collection: StoredCollection,
  times: EnablementTimesMap,
): Set<string> {
  const picks = new Set<string>();
  for (const s of scripts) {
    const group = scripts.filter((o) => sameScript(o, s));
    if (preferredCopy(group, (c) => copyFacts(c, collection, times[c.id]), compareInCollection) === s) picks.add(s.id);
  }
  return picks;
}
