// Finding *other versions of the same script* that are already
// installed.
//
// Two independent notions of "the same script" live here, and they
// answer different questions:
//
//   - **Same location** — the canonicalized *absolute* URL matches.
//     This is literally the same file / URL, so whatever is at the
//     other end is the same bytes we would fetch.
//
//     The key is `fileUrl`, not `relativePath`. A script inside a
//     directory, manifest, or repo collection stores a path relative to
//     its collection root, which shares no text with the full URL the
//     same script carries when installed on its own — so comparing
//     `relativePath` (what the preview page did) can never match a
//     collection copy against a single-file copy. `fileUrl` is the
//     absolute form the load pipeline already builds for every collection
//     kind (`scriptFileUrl` in directories.ts), so it is the one
//     spelling all collection kinds agree on.
//
//     Display is unaffected: a collection copy still *shows* its
//     relative path, which is what the user recognizes. Only the
//     comparison uses the absolute form.
//
//   - **Same identity** — `@namespace` + `@name` match. This is the
//     userscript ecosystem's conventional unique ID: Greasemonkey
//     documents `@namespace` as the value that, "combined with the
//     name, forms a unique identifier", and both Tampermonkey and
//     Violentmonkey key their install-vs-update decision on the pair.
//     It catches the same script mirrored to a second host, vendored
//     into a repo, or edited into a local copy — cases where the
//     locations have nothing in common.
//
// SourceMonkey's own record identity stays what it was: a random UUID
// per stored row, kept stable across refreshes by `relativePath` (see
// [docs/storage.md]). Nothing here mints or rewrites an id — this
// module only *finds relatives* of a script so the UI can offer to
// jump between them.
//
// See [docs/script-identity.md].

import {
  containerKindForSingleFileInput,
  containerPath,
  isContainerCollection,
  isScratchUrl,
  isSmDevCollection,
  isSingleFileInput,
} from './directories.js';
import {
  getAllScripts, getCollections, isScriptEnabled, isCollectionEnabled, writeEnablement, type StoredScript, type StoredCollection,
} from './script-store.js';
import { CONTAINER_DISPLAY_NAMES, effectiveDisplayName } from './collection-display.js';
import { getValues, type ParsedHeader } from '../userscript-header.js';
import { identityKey, locationKey } from './script-keys.js';
import { startPhaseTimer, type PhaseTimer } from '../phase-timing.js';

// `identityKey` and `locationKey` live in script-keys.ts, so the store
// can use them too; re-exported here, where the rest of the lookup is.
export { identityKey, locationKey } from './script-keys.js';

// One installed row that relates to the script being viewed, paired
// with the collection that holds it so the UI can render both without a
// second lookup.
export interface RelatedScript {
  script: StoredScript;
  // `null` only if the row's `collectionId` dangles — shouldn't happen,
  // but the renderer must not crash on a partially-written store.
  collection: StoredCollection | null;
  // Why it matched. A row can be both: the same URL installed twice
  // under two collections still carries the same `@name`/`@namespace`.
  sameLocation: boolean;
  sameIdentity: boolean;
}

export interface RelatedVersions {
  // Installed rows at the very same location. Ordered by collection
  // display name so the list is stable across renders.
  sameLocation: RelatedScript[];
  // Installed rows that are the same script per `@namespace`+`@name`
  // but live somewhere else. Disjoint from `sameLocation` — a row
  // that matched by location is never repeated here, since the
  // stronger relationship is the one worth showing.
  sameIdentity: RelatedScript[];
  // Where a single-file install could land — the entries of the install
  // page's "Install into" dropdown, in display order. Present only when
  // the location is a single-file input (a script inside a
  // directory/manifest collection has no single-file spelling to
  // install); `undefined` otherwise.
  installOptions?: InstallOption[];
}

// One entry of the "Install into" dropdown.
export interface InstallOption {
  // The container a copy would land in. `null` for the built-in default
  // of this location's scheme when no row exists yet — the install
  // creates it.
  collection: StoredCollection | null;
  // The container's stored path (`container:http`, `container:<uuid>`…).
  path: string;
  // What the dropdown shows.
  label: string;
  // This container already holds this location: listed, but not
  // installable a second time.
  installed: boolean;
  // The container is switched off, so a script installed into it would
  // not run. Still a legitimate target — the user may be about to turn
  // it back on — so it is marked rather than refused.
  collectionOff: boolean;
  // The built-in default for the location's scheme. Always listed
  // first — and pre-selected unless some other entry is `isCurrent`,
  // so that a second copy anywhere is a deliberate pick rather than
  // the one-click path.
  isDefault: boolean;
  // The collection this script is in right now. Only the move
  // dropdown sets it: the move list shows the current collection
  // rather than hiding it, so every script's list reads the same and
  // the pre-selection is a place the script already is — which makes
  // moving it anywhere a deliberate pick. Always `false` for an
  // install, which has no "current".
  isCurrent: boolean;
}

export interface RelatedVersionsQuery {
  scripts: readonly StoredScript[];
  collections: readonly StoredCollection[];
  // The **absolute** location of the script under consideration:
  // a stored row's `fileUrl`, or the URL/path a preview was opened
  // for. Canonicalized here, so either spelling of a local file
  // works.
  location: string;
  // Its parsed header, for the identity match. `null` (an unparseable
  // file) simply means only the location match runs.
  header: ParsedHeader | null;
}

export function findRelatedVersions(q: RelatedVersionsQuery): RelatedVersions {
  const loc = locationKey(q.location);
  const identity = identityKey(q.header);
  const collectionById = new Map(q.collections.map((s) => [s.id, s]));

  const sameLocation: RelatedScript[] = [];
  const sameIdentity: RelatedScript[] = [];

  for (const script of q.scripts) {
    const atLocation = locationKey(script.fileUrl) === loc;
    const isIdentity = identity !== null && identityKey(script.header) === identity;
    if (!atLocation && !isIdentity) continue;
    const rel: RelatedScript = {
      script,
      collection: collectionById.get(script.collectionId) ?? null,
      sameLocation: atLocation,
      sameIdentity: isIdentity,
    };
    // Location is the stronger claim, so a row that matches both is
    // only listed once, under location.
    (atLocation ? sameLocation : sameIdentity).push(rel);
  }

  const byName = (a: RelatedScript, b: RelatedScript): number =>
    collectionSortKey(a).localeCompare(collectionSortKey(b))
    || a.script.relativePath.localeCompare(b.script.relativePath);
  sameLocation.sort(byName);
  sameIdentity.sort(byName);

  return {
    sameLocation,
    sameIdentity,
    installOptions: installOptionsFor(loc, sameLocation, q.collections),
  };
}

// The containers a single-file install of `loc` could land in, in the
// order the dropdown lists them: the built-in default for the
// location's scheme first (offered as not-yet-existing when it has no
// row), then every other container in page order. Each is marked
// `installed` when one of the same-location rows already sits in it.
// The caller appends its own "New collection…" entry.
//
// `current` names the collection the script is in now — the move
// dropdown's caller. That entry is still listed, marked `isCurrent`
// so the dropdown can label it *(current)*, disable it and pre-select
// it. Listing it rather than dropping it keeps one list shape for
// every script, and makes the opening selection somewhere the script
// already is, so nothing moves without a deliberate pick.
export function installOptionsFor(
  loc: string,
  sameLocation: readonly RelatedScript[],
  collections: readonly StoredCollection[],
  current?: string,
): InstallOption[] | undefined {
  // A run's script stays in its sm-dev test collection, and nothing else
  // goes into one.
  if (!isSingleFileInput(loc) || isScratchUrl(loc)) return undefined;
  const kind = containerKindForSingleFileInput(loc);
  const defaultPath = containerPath(kind);
  const holding = new Set<string>();
  for (const r of sameLocation) {
    if (r.collection) holding.add(r.collection.id);
  }
  const containers = collections.filter((c) => isContainerCollection(c.path) && !isSmDevCollection(c.path));
  const def = containers.find((c) => c.path === defaultPath) ?? null;
  const options: InstallOption[] = [{
    collection: def,
    path: defaultPath,
    label: def ? effectiveDisplayName(def) : CONTAINER_DISPLAY_NAMES[kind],
    installed: def ? holding.has(def.id) : false,
    // A default that doesn't exist yet is created enabled.
    collectionOff: def ? !isCollectionEnabled(def) : false,
    isDefault: true,
    // `def?.id === current` alone would be `undefined === undefined`
    // for an install (no current) whose default has no row yet.
    isCurrent: current !== undefined && def?.id === current,
  }];
  for (const c of containers) {
    if (c.path === defaultPath) continue;
    options.push({
      collection: c,
      path: c.path,
      label: effectiveDisplayName(c),
      installed: holding.has(c.id),
      collectionOff: !isCollectionEnabled(c),
      isDefault: false,
      isCurrent: c.id === current,
    });
  }
  return options;
}

// One row's share of an enable/disable click. A plain click produces
// several at once, so the write path takes a list rather than a single
// id.
export interface ScriptEnableChange {
  scriptId: string;
  enabled: boolean;
}

// One click's worth of enable/disable writes: the copy that was
// clicked, plus — when it is being turned ON — every other copy that
// is currently active. Pass an empty `rows` to opt out.
//
// Disabling is never exclusive: it leaves none active, which is an
// ordinary thing to want, and there is no other copy that should be
// promoted in its place.
//
// Nor is enabling one of an sm-dev run's scripts: the run keeps its
// scripts off other tabs itself, so they don't compete.
export function enableChanges(
  scriptId: string,
  enabled: boolean,
  rows: readonly RelatedScript[],
): ScriptEnableChange[] {
  const changes: ScriptEnableChange[] = [{ scriptId, enabled }];
  if (!enabled) return changes;
  const own = rows.find((r) => r.script.id === scriptId);
  if (own && inRunCollection(own)) return changes;
  for (const other of otherActiveCopies(rows, scriptId)) {
    changes.push({ scriptId: other.script.id, enabled: false });
  }
  return changes;
}

// Whether a row is active: its own flag AND its collection's, so it
// fires on the pages it matches. `turnOffOtherCopies` asks it of the
// copy being enabled too: that copy has to be active itself before it
// is worth switching the others off.
export function isActive(rel: RelatedScript): boolean {
  if (!isScriptEnabled(rel.script)) return false;
  return rel.collection ? isCollectionEnabled(rel.collection) : true;
}

// The copies an exclusive enable of `keepId` has to switch off: every
// OTHER row that is currently active.
//
// Shared by both checkboxes the viewer puts on screen — the panel row's
// and the controls row's — so "enabling one copy turns the rest off"
// means the same thing wherever it is clicked.
//
// The exclusions, all deliberate:
//   - **Rows that aren't active already.** Nothing to gain by
//     rewriting a value they effectively hold.
//   - **Rows under a disabled collection.** Not competing with the copy
//     being enabled, and their own checkbox renders disabled — so a
//     flip made here could not be undone from the panel at all, and
//     would silently destroy the user's stored intent for whenever
//     they re-enable that collection.
//   - **An sm-dev run's scripts.** Only their run changes them, and it
//     keeps them off other tabs itself.
export function otherActiveCopies(
  rows: readonly RelatedScript[],
  keepId: string,
): RelatedScript[] {
  return rows.filter((r) => r.script.id !== keepId && isActive(r) && !inRunCollection(r));
}

function inRunCollection(rel: RelatedScript): boolean {
  return rel.collection !== null && isSmDevCollection(rel.collection.path);
}

// A copy that just became active follows the same exclusive rule as
// the panel's checkboxes: it is the one wanted active, and leaving an
// older copy of the same script on means both register and both run on
// every page they match. Returns the copies it turned off.
//
// For a copy that is newly active: an install, a local copy, a move
// into an enabled collection, and sm-dev's `script enable`. With no
// other copy active, it does nothing. Skipped when the copy's
// collection is disabled, so it isn't active itself.
//
// A copy that landed `invalid` still takes over: it is the one asked
// for, and leaving a working copy on beside it would make two enabled
// copies. Nothing runs until it is fixed, and then it runs without
// another click.
//
// A run's test collection is left out both ways, as by `enableChanges`.
export async function turnOffOtherCopies(scriptId: string): Promise<StoredScript[]> {
  const timer = startPhaseTimer('turn off other copies');
  const [scripts, collections] = await Promise.all([getAllScripts(), getCollections()]);
  timer.mark('read all', `${scripts.length} scripts, ${collections.length} collections`);
  const off = await planAndTurnOff(scriptId, scripts, collections, timer);
  timer.done();
  return off;
}

async function planAndTurnOff(
  scriptId: string,
  scripts: StoredScript[],
  collections: StoredCollection[],
  timer: PhaseTimer,
): Promise<StoredScript[]> {
  const copy = scripts.find((s) => s.id === scriptId);
  if (!copy) return [];
  // The STORED row's location and header: what the rest of the store is
  // compared against, and for a github blob URL the resolved raw one.
  const related = findRelatedVersions({ scripts, collections, location: copy.fileUrl, header: copy.header ?? null });
  const rows = allRelatedRows(related);
  const own = rows.find((r) => r.script.id === scriptId);
  if (!own || !isActive(own) || inRunCollection(own)) return [];
  const off = new Set(otherActiveCopies(rows, scriptId).map((r) => r.script.id));
  if (off.size === 0) return [];
  // `started`: the copy became active in an earlier write, but it is
  // stamped as becoming active now, the moment the copies it displaces
  // go inactive (docs/script-enablement.md).
  timer.mark('plan');
  await writeEnablement({ scripts: [...off].map((id) => ({ id, enabled: false })), started: [scriptId] }, timer);
  timer.note(`${off.size} cop${off.size === 1 ? 'y' : 'ies'} turned off`);
  return rows.filter((r) => off.has(r.script.id)).map((r) => r.script);
}

// Every related row in one list, in the order the panel draws them.
// The exclusive rule spans both sections: the point is that one copy
// of this script runs, not one copy per section.
export function allRelatedRows(related: RelatedVersions): RelatedScript[] {
  return [...related.sameLocation, ...related.sameIdentity];
}

// Sorts by the name the row will actually show. Using the raw
// `displayName` would leave any collection without one — directory and
// manifest collections, which only get an inferred name — sorted under
// a string the user never sees, so the table would look unsorted.
function collectionSortKey(r: RelatedScript): string {
  return r.collection ? effectiveDisplayName(r.collection) : '';
}

// What the panel's Compare column compares: a copy's own source text
// plus every `@require` body it loaded, in declaration order. Built
// from the hashes the store already keeps for each (`contentHash` on
// the row and on each require entry), so it is string assembly, not
// hashing — and it is comparable across pages: a preview's download
// gets the same shape from its text hash and the parse check's
// requires.
//
// Requires are part of it because they are part of what runs: two
// copies with the same body but a library that moved on behave
// differently. `@resource` is not: it is data the script reads, not
// code that runs.
//
// `undefined` when there is no content to compare: the row never
// loaded, or its header declares `@require`s and none is stored — a
// dependency that would not load leaves the list empty, and a preview
// has none until its parse check lands. A body-only answer there would
// call a broken copy DIFFERENT from a healthy twin with the same text,
// or two broken copies SAME.
export function contentFingerprint(script: {
  contentHash?: string;
  header: ParsedHeader | null;
  requires?: readonly { contentHash: string }[];
}): string | undefined {
  if (!script.contentHash) return undefined;
  const requires = script.requires ?? [];
  const declared = script.header ? getValues(script.header, 'require').length > 0 : false;
  if (declared && requires.length === 0) return undefined;
  return [script.contentHash, ...requires.map((r) => r.contentHash)].join('\n');
}
