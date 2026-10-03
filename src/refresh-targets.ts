// Which collections / scripts a targeted refresh should touch.
//
// The collections page's `?refresh` does a full Refresh All, which
// re-reads every http(s) and GitHub collection too — slow, and pointless
// when the thing that changed was a file on disk. The two narrower
// triggers (`?refresh_local`, `?refresh_file=<path>`) pick their targets
// with the pure helpers here, so the selection logic is testable without
// a page.
//
// Local collections come in two shapes and each needs its own treatment:
//   - A scanned collection (a directory, or a local `script_manifest.json`)
//     refreshes as a WHOLE, because only a re-scan notices files that
//     were added, renamed, or deleted.
//   - A container (`container:*`) has no directory of its own — each
//     script row carries its own absolute location, and a container may
//     hold web scripts alongside local ones — so its local rows are
//     selected individually.
//
// "Local" is decided by where the COLLECTION lives, not by where its
// rows point. So an http(s) manifest listing a `file://` entry is never
// selected (refreshing it would mean re-reading the manifest over the
// network, which is the cost these triggers exist to avoid), and a
// local manifest listing http(s) entries refreshes them along with the
// rest of its collection. See TODO.md.

import {
  isContainerCollection,
  isFileUrl,
  isManifestCollection,
  isNonPosixFileUrl,
  locationFsPath,
  parentDir,
} from './file-locations.js';
import { inferCollectionType } from './collection-display.js';
import type { StoredCollection, StoredScript } from './script-store.js';

// A collection plus the script rows it holds — what the selectors need
// to see, and what `getCollectionWithScripts` already returns.
export interface CollectionScripts {
  collection: StoredCollection;
  scripts: readonly StoredScript[];
}

// One individually-selected script row: its id, plus the collection
// that holds it so the caller can highlight that section without
// re-reading the row.
export interface ScriptTarget {
  id: string;
  collectionId: string;
}

// What to hand to `updateCollection` / `updateScript`. Disjoint by
// construction: a script is only listed on its own when its collection
// isn't being refreshed anyway.
export interface RefreshTargets {
  collectionIds: string[];
  scripts: ScriptTarget[];
}

// True for collections that can hold content on the local disk —
// scanned directories, local manifests, and every container (whose
// rows are then filtered one by one). Shares `inferCollectionType` with
// the UI's type bubble so "local" means the same thing the user sees on
// the page.
export function isLocalCollection(collection: StoredCollection): boolean {
  return inferCollectionType(collection.path) === 'file';
}

// Absolute filesystem path for a `file://` URL or a raw path, with any
// trailing slash removed so directory and file spellings compare the
// same way. Non-local inputs (http(s) URLs, the synthetic
// `container:*` paths) have no filesystem form — they come back as-is
// and simply fail every comparison below.
export function toFsPath(input: string): string {
  const p = locationFsPath(input.trim());
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// True when `child` is `parent` itself or sits somewhere beneath it.
// The `/` boundary check keeps `/a/scripts-old` from reading as a child
// of `/a/scripts`. An empty `parent` is nobody's ancestor — without the
// guard its `base` would be `/`, which every absolute path is under.
function isAtOrUnder(child: string, parent: string): boolean {
  if (parent === '') return false;
  if (child === parent) return true;
  const base = parent === '/' ? '/' : parent + '/';
  return child.startsWith(base);
}

// True when the two paths refer to the same place or one contains the
// other. Both directions matter: a `?refresh_file=/a/b/x.user.js` has to
// find the `/a/b` collection that scans it, and a
// `?refresh_file=/a` (the user pointing at a whole tree) has to find the
// `/a/b` collections inside it.
export function pathsOverlap(a: string, b: string): boolean {
  return isAtOrUnder(a, b) || isAtOrUnder(b, a);
}

// Directory a scanned collection covers: the manifest's own directory
// for a manifest collection, the path itself otherwise.
function collectionScanDir(path: string): string {
  const fs = toFsPath(path);
  return isManifestCollection(path) ? parentDir(fs) : fs;
}

// Every local collection, refreshed whole — except containers, whose
// local rows are picked out individually so their web rows aren't
// refetched. Used by `?refresh_local`.
export function localRefreshTargets(entries: readonly CollectionScripts[]): RefreshTargets {
  const collectionIds: string[] = [];
  const scripts: ScriptTarget[] = [];
  for (const { collection, scripts: rows } of entries) {
    if (!isLocalCollection(collection)) continue;
    if (isContainerCollection(collection.path)) {
      for (const s of rows) {
        if (isFileUrl(s.fileUrl)) scripts.push({ id: s.id, collectionId: collection.id });
      }
      continue;
    }
    collectionIds.push(collection.id);
  }
  return { collectionIds, scripts };
}

// Local collections and scripts touching `target` — a file or directory
// path (raw or `file://`). Used by `?refresh_file=<path>`.
//
// A scanned collection is selected when its directory overlaps the
// target, so a rename or a brand-new file in that directory is picked
// up even though no existing row points at it. It's also selected when
// one of its rows points at the target even if the directory test
// missed — a manifest may list entries outside its own directory.
export function pathRefreshTargets(
  entries: readonly CollectionScripts[],
  targetPath: string,
): RefreshTargets {
  const target = toFsPath(targetPath);
  const collectionIds: string[] = [];
  const scriptTargets: ScriptTarget[] = [];
  for (const { collection, scripts } of entries) {
    if (!isLocalCollection(collection)) continue;
    const matchingScripts = scripts.filter((s) => scriptMatchesPath(s, target));
    if (isContainerCollection(collection.path)) {
      // No directory to re-scan: the container's rows ARE its contents,
      // so refresh exactly the ones that point at the target.
      for (const s of matchingScripts) {
        scriptTargets.push({ id: s.id, collectionId: collection.id });
      }
      continue;
    }
    if (pathsOverlap(collectionScanDir(collection.path), target) || matchingScripts.length > 0) {
      collectionIds.push(collection.id);
    }
  }
  return { collectionIds, scripts: scriptTargets };
}

// True when a stored row's file is the target or lives under it. Only
// local rows can match — a container holds http(s) and GitHub scripts
// alongside the local ones.
function scriptMatchesPath(script: StoredScript, target: string): boolean {
  if (!isFileUrl(script.fileUrl)) return false;
  return isAtOrUnder(toFsPath(script.fileUrl), target);
}

// What every `?refresh_file=` rejection leads with, so the line on the
// page says which action didn't happen before it says why. The tail is
// a message in its own right, hence its capital.
export const REFRESH_FAILED_PREFIX = 'Refresh failed: ';

// Shapes `?refresh_file=` accepts, as the tail of "Refresh path …".
// Narrower than `LOCATION_SHAPES`: the trigger exists for files on
// local disk, so an http(s) URL has nothing to refresh against.
export const REFRESH_PATH_SHAPES =
  'must be a file:// URL, or an absolute path starting with /';

// Why a `?refresh_file=` value can't be used, or null when it can.
// Rejects the shapes `toFsPath` would mangle rather than comparing a
// path that points somewhere other than what was asked for:
//   - Windows drive-letter and UNC `file://` URLs (`locationFsPath`
//     drops the host — the same hazard `canonicalCollectionInput`
//     sidesteps), and
//   - anything resolving to bare `/`, which would overlap every local
//     collection. `isValidLocationShape` refuses the root in the Add
//     field for the same reason, and the two shouldn't disagree.
export function refreshPathProblem(input: string): string | null {
  const value = input.trim();
  if (!value.startsWith('/') && !isFileUrl(value)) {
    // Every rejection echoes the value: the caller here is usually a
    // tool that built the URL, and the path it actually sent is the
    // thing that needs fixing.
    return `Refresh path ${REFRESH_PATH_SHAPES}: ${value}`;
  }
  if (isFileUrl(value) && isNonPosixFileUrl(value)) {
    return `Refresh path must be a POSIX file:// URL, without a host: ${value}`;
  }
  if (toFsPath(value).length <= 1) {
    return `Refresh path must name something below the filesystem root: ${value}`;
  }
  return null;
}
