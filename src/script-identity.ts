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
  canonicalCollectionInput,
  containerKindForSingleFileInput,
  containerPath,
  isContainerCollection,
  isSingleFileInput,
} from './directories.js';
import { isScriptEnabled, isCollectionEnabled, type StoredScript, type StoredCollection } from './script-store.js';
import { CONTAINER_DISPLAY_NAMES, effectiveDisplayName } from './collection-display.js';
import { getValue, type ParsedHeader } from './userscript-header.js';

// The ecosystem identity key: `@namespace` and `@name`, trimmed and
// joined by a separator that can't occur in either.
//
// `null` when there is no `@name` — with nothing to key on we decline
// to match rather than fold every nameless script together. A missing
// `@namespace` is NOT the same case: the empty namespace is a real
// (if unwise) value, and two scripts that both omit it and share a
// name are treated as the same script, which is exactly what TM and
// VM do. That is the convention's known weak spot, not ours to fix
// unilaterally.
//
// Comparison is exact after trimming — no case folding, no URL
// normalization of the namespace. `HTTP://Example.com/` and
// `http://example.com/` are different namespaces to every other
// manager, and quietly disagreeing would make our "same script"
// answer differ from the one the user sees in Tampermonkey.
//
// Spelled as an escape, never as a literal NUL byte: a raw NUL makes
// grep treat the whole source file as binary and print nothing for
// every match in it.
const IDENTITY_SEP = '\u0000';

export function identityKey(header: ParsedHeader | null): string | null {
  if (!header) return null;
  const name = getValue(header, 'name')?.trim();
  if (!name) return null;
  const namespace = getValue(header, 'namespace')?.trim() ?? '';
  return `${namespace}${IDENTITY_SEP}${name}`;
}

// The location key: the one true spelling of an absolute script
// location. `canonicalCollectionInput` is the same helper
// `addCollection` uses, so a `file://` URL and the bare path spelling
// of the same file collapse together — which is what lets a directory
// collection's `fileUrl` (always a `file://` URL) match a container
// row's bare path, and what makes a capture's URL match a row stored
// before canonicalization existed.
export function locationKey(absoluteUrl: string): string {
  return canonicalCollectionInput(absoluteUrl);
}

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
  if (!isSingleFileInput(loc)) return undefined;
  const kind = containerKindForSingleFileInput(loc);
  const defaultPath = containerPath(kind);
  const holding = new Set<string>();
  for (const r of sameLocation) {
    if (r.collection) holding.add(r.collection.id);
  }
  const containers = collections.filter((c) => isContainerCollection(c.path));
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
// is currently running. Pass an empty `rows` to opt out.
//
// Disabling is never exclusive: it leaves none running, which is an
// ordinary thing to want, and there is no other copy that should be
// promoted in its place.
export function enableChanges(
  scriptId: string,
  enabled: boolean,
  rows: readonly RelatedScript[],
): ScriptEnableChange[] {
  const changes: ScriptEnableChange[] = [{ scriptId, enabled }];
  if (!enabled) return changes;
  for (const other of otherRunningCopies(rows, scriptId)) {
    changes.push({ scriptId: other.script.id, enabled: false });
  }
  return changes;
}

// Whether a row is actually running: its own flag AND its collection's.
//
// Exported because the sweep has a second question to ask with it: a
// copy that is about to be enabled has to be running itself before it
// is worth switching the others off (see `soloRunningCopy` in
// userscript.ts).
export function isRunning(rel: RelatedScript): boolean {
  if (!isScriptEnabled(rel.script)) return false;
  return rel.collection ? isCollectionEnabled(rel.collection) : true;
}

// The copies an exclusive enable of `keepId` has to switch off: every
// OTHER row that is currently running.
//
// Shared by both checkboxes the viewer puts on screen — the panel row's
// and the controls row's — so "enabling one copy turns the rest off"
// means the same thing wherever it is clicked.
//
// Two exclusions, both deliberate:
//   - **Rows that aren't running already.** Nothing to gain by
//     rewriting a value they effectively hold.
//   - **Rows under a disabled collection.** Not competing with the copy
//     being enabled, and their own checkbox renders disabled — so a
//     flip made here could not be undone from the panel at all, and
//     would silently destroy the user's stored intent for whenever
//     they re-enable that collection.
export function otherRunningCopies(
  rows: readonly RelatedScript[],
  keepId: string,
): RelatedScript[] {
  return rows.filter((r) => r.script.id !== keepId && isRunning(r));
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
