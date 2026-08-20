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
  isSingleFileInput,
  type ContainerKind,
} from './directories.js';
import { isScriptEnabled, isCollectionEnabled, type StoredScript, type StoredCollection } from './script-store.js';
import { effectiveDisplayName } from './collection-display.js';
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
  // Where a "keep your own single-file copy" install would land: the
  // container collection matching the location's scheme. Present only
  // when the location is a single-file input (a script inside a
  // directory/manifest collection has no single-file spelling to
  // install) and no `sameLocation` row already sits in that container.
  //
  // `collection` is `null` when the container doesn't exist yet — the
  // first single-file install of that scheme creates it.
  installTarget?: {
    kind: ContainerKind;
    path: string;
    collection: StoredCollection | null;
  };
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

  return { sameLocation, sameIdentity, installTarget: installTargetFor(loc, sameLocation, q.collections) };
}

// The container a single-file install of `loc` would land in — but
// only when installing there would actually add something. If one of
// the same-location rows already sits in that container, the user has
// their own copy and the offer would be a no-op.
function installTargetFor(
  loc: string,
  sameLocation: readonly RelatedScript[],
  collections: readonly StoredCollection[],
): RelatedVersions['installTarget'] {
  if (!isSingleFileInput(loc)) return undefined;
  const kind = containerKindForSingleFileInput(loc);
  const path = containerPath(kind);
  if (sameLocation.some((r) => r.collection?.path === path)) return undefined;
  return { kind, path, collection: collections.find((s) => s.path === path) ?? null };
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
// is worth switching the others off (see `soloNewlyInstalled` in
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
