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
// The viewer applies the same single-script rule through `enableChanges`
// (script-identity.ts) itself, because it paints its panel's rows
// before the write lands. Installs, moves and sm-dev's `script enable`
// use `turnOffOtherCopies` there.
//
// Design: docs/script-enablement.md.

import { isSmDevCollection } from './directories.js';
import {
  getAllScripts, getCollections, getEnablementTimes, getScript, isCollectionEnabled, isScriptEnabled,
  writeEnablement, type EnablementTimes, type EnablementTimesMap, type StoredCollection, type StoredScript,
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

interface Snapshot {
  scripts: StoredScript[];
  collections: StoredCollection[];
  times: EnablementTimesMap;
}

// Marked on `timer` as `read all`, with what it returned. No size: the
// script rows come from a scan of all storage, whose own line has it.
async function snapshot(timer: PhaseTimer): Promise<Snapshot> {
  const [scripts, collections, times] = await Promise.all([getAllScripts(), getCollections(), getEnablementTimes()]);
  timer.mark('read all', `${scripts.length} scripts, ${collections.length} collections`);
  return { scripts, collections, times };
}

// Every installed copy related to `script` (same location or same
// `@namespace` + `@name`), itself included.
function relatedRows(snap: Snapshot, script: StoredScript): RelatedScript[] {
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

// Turn one copy on or off. On, without `solo`, turns its other active
// copies off in the same write, when that makes it active. Ticked under
// a disabled collection it isn't active, so it displaces nothing. Off
// changes only this copy: nothing is promoted in its place.
export async function setScriptEnabledExclusive(
  id: string,
  enabled: boolean,
  solo = false,
): Promise<StoredScript | null> {
  const timer = startPhaseTimer(enabled ? 'enable script' : 'disable script');
  let changes = [{ id, enabled }];
  if (enabled && !solo) {
    const snap = await snapshot(timer);
    const script = snap.scripts.find((s) => s.id === id);
    const collection = snap.collections.find((c) => c.id === script?.collectionId);
    if (script && (!collection || isCollectionEnabled(collection))) {
      changes = enableChanges(id, true, relatedRows(snap, script))
        .map((c) => ({ id: c.scriptId, enabled: c.enabled }));
    }
    timer.mark('plan');
  }
  const { scripts } = await writeEnablement({ scripts: changes }, timer);
  timer.note(`${changes.length} change(s)`);
  timer.done();
  // Nothing written when it was already in that state.
  return scripts.find((s) => s.id === id) ?? (await getScript(id)) ?? null;
}

// Turn a collection on or off.
//   - On, without `solo`: each of its copies that becomes active turns
//     off its other active copies elsewhere. Two copies inside the
//     collection are both left as their own boxes say.
//   - Off, without `solo`: each of its active copies that displaced
//     others (they went inactive at the moment it became active, and
//     haven't been active since) brings them back, unless another copy
//     of that script is still active.
export async function setCollectionEnabledExclusive(
  id: string,
  enabled: boolean,
  solo = false,
): Promise<StoredCollection | null> {
  const timer = startPhaseTimer(enabled ? 'enable collection' : 'disable collection');
  const snap = await snapshot(timer);
  const collection = snap.collections.find((c) => c.id === id);
  let changes: { id: string; enabled: boolean }[] = [];
  if (collection && !solo && !isSmDevCollection(collection.path)
      && isCollectionEnabled(collection) !== enabled) {
    const own = snap.scripts.filter((s) => s.collectionId === id && isScriptEnabled(s));
    changes = enabled ? displacedBy(snap, own) : restoredFor(snap, id, own);
  }
  timer.mark('plan');
  const written = await writeEnablement({ collection: { id, enabled }, scripts: changes }, timer);
  timer.note(`${changes.length} other cop${changes.length === 1 ? 'y' : 'ies'} changed`);
  timer.done();
  return written.collection;
}

// The copies outside the collection that `starting` (its copies about to
// become active) switch off. One that landed `invalid` does too, as
// `turnOffOtherCopies` explains.
function displacedBy(snap: Snapshot, starting: readonly StoredScript[]): { id: string; enabled: boolean }[] {
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
  snap: Snapshot,
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
export async function setAllScriptsEnabled(
  collectionId: string,
  enabled: boolean,
  solo = false,
): Promise<void> {
  const timer = startPhaseTimer(enabled ? 'enable all' : 'disable all');
  const snap = await snapshot(timer);
  const collection = snap.collections.find((c) => c.id === collectionId);
  if (!collection) {
    timer.note('collection gone');
    timer.done();
    return;
  }
  const scripts = snap.scripts.filter((s) => s.collectionId === collectionId);
  if (!enabled || solo || isSmDevCollection(collection.path)) {
    await writeEnablement({ scripts: scripts.map((s) => ({ id: s.id, enabled })) }, timer);
    timer.note(`${scripts.length} script(s)`);
    timer.done();
    return;
  }
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
  timer.mark('plan');
  await writeEnablement({ scripts: changes, started }, timer);
  timer.note(`${changes.length} change(s)`);
  timer.done();
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
