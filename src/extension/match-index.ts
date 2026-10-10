// In-memory index of every injectable userscript's matching info so the
// background service worker can find matching scripts for a URL without
// touching chrome.storage.local on every navigation. "Injectable" means
// `status: 'ok'` (see toEntry).
//
// Built once on first access (ensureLoaded()), then kept fresh by a
// chrome.storage.local.onChanged listener. Storage I/O cost scales with
// the user's script count at SW startup; per-navigation cost is just an
// in-memory loop over the cache.
//
// Enabled state: a script is considered for matching only if BOTH its
// own `enabled` flag and its parent collection's `enabled` flag are
// true. We cache every injectable script (regardless of enabled) and
// separately track the set of disabled collections, so toggling a
// collection flips every script under it in O(1) without rewalking
// storage.

import { isFileUrl, scratchRunOf } from './directories.js';
import { compareScriptNames, scriptDisplayName } from '../script-display.js';
import { scanStorageRows } from './storage-scan.js';
import { sharedRows } from './row-cache.js';
import {
  ensureCollectionKeysMigrated,
  isScriptEnabled,
  isCollectionEnabled,
  sameStoredValue,
  withoutAnnotations,
  type ScriptMatching,
  type ScriptMeta,
  type StoredCollection,
} from './script-store.js';
import { urlMatchesScript } from '../url-match.js';
import { resolveScriptWorld, type InjectionWorld } from '../script-world.js';
import { grantedSubsystems, type ApiSubsystem } from '../gm-api-catalog.js';
import { isManualScript } from '../script-build.js';

export interface MatchedScript {
  id: string;
  name: string;       // @name, or the readable relativePath as a fallback
  matching: ScriptMatching;
  collectionId: string;
  // Which execution world the script would be injected into. Cached
  // here because the SW's bridge gate (`bridgeMayActAs` in
  // background.ts) has to answer "does this script run in MAIN world on
  // this URL?" synchronously per GM_* call; re-reading the header from
  // chrome.storage.local on every call would put I/O on that path.
  world: InjectionWorld;
  // A scratch script's sm-dev run, which pushed it: it runs only in
  // tabs that run's claim holds (sm-dev-link.ts).
  smDevRun?: string;
  // A manual script (`@run-at context-menu`), which runs only on
  // request. See docs/manual-scripts.md.
  manual?: true;
}

const SCRIPT_PREFIX = 'script:';
const COLLECTION_PREFIX = 'collection:';

interface CacheEntry extends MatchedScript {
  // The GM subsystems the script's grants reach, for the same gate:
  // a relayed request is honored only through an API the script has.
  subsystems: ReadonlySet<ApiSubsystem>;
  enabled: boolean;   // the script's own toggle (not the collection's)
  // Loaded from disk rather than over the network. Cached here so the
  // focus-triggered refresh can pick the local rows out of a tab's
  // match set without reading storage — see `localScriptIds`.
  local: boolean;
}

let cache = new Map<string, CacheEntry>();
// The match rules of `invalid` scripts, which `cache` leaves out. Read
// only by `findAllMatchingIds`, so the popup can list a script that
// targets the page but failed to load. Never injected or registered.
let invalidMatching = new Map<string, ScriptMatching>();
let disabledCollections = new Set<string>();
let loaded: Promise<void> | null = null;

// While loadAll() is awaiting its full `get(null)` snapshot, any
// storage change that fires would mutate the about-to-be-replaced
// `cache`, and the subsequent `cache = nextCache` assignment would
// discard it — a lost update until the next change to that key. During
// the load window we buffer raw changes here instead of applying them,
// then replay them onto the freshly-built cache. Null when not loading.
let pendingDuringLoad: { [key: string]: chrome.storage.StorageChange }[] | null = null;

// First call kicks off a single full read; later callers await the same
// promise. After it resolves, the cache is kept fresh by the onChanged
// listener installed by installStorageListener().
export function ensureLoaded(): Promise<void> {
  if (!loaded) loaded = loadAll();
  return loaded;
}

async function loadAll(): Promise<void> {
  pendingDuringLoad = [];
  // Before the read, not after: a profile still on the pre-rename key
  // spelling would otherwise load an empty cache and inject nothing.
  await ensureCollectionKeysMigrated();
  const isRow = (k: string): boolean => k.startsWith(SCRIPT_PREFIX) || k.startsWith(COLLECTION_PREFIX);
  // From the worker's row cache when it's on (frozen rows, read only).
  const all = (await sharedRows(isRow)) ?? await scanStorageRows('match index', isRow);
  const nextCache = new Map<string, CacheEntry>();
  const nextInvalid = new Map<string, ScriptMatching>();
  const nextDisabled = new Set<string>();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(SCRIPT_PREFIX)) {
      const script = value as ScriptMeta;
      const entry = toEntry(script);
      if (entry) nextCache.set(entry.id, entry);
      else if (script.status === 'invalid' && script.matching) nextInvalid.set(script.id, script.matching);
    } else if (key.startsWith(COLLECTION_PREFIX)) {
      const collection = value as StoredCollection;
      if (!isCollectionEnabled(collection)) nextDisabled.add(collection.id);
    }
  }
  cache = nextCache;
  invalidMatching = nextInvalid;
  disabledCollections = nextDisabled;
  // Replay any changes that landed during the await on top of the
  // fresh snapshot, then stop buffering. A change for a key already in
  // the snapshot just re-applies the same (or newer) value; one for a
  // key the snapshot missed is now captured.
  const buffered = pendingDuringLoad;
  pendingDuringLoad = null;
  for (const changes of buffered) applyStorageChanges(changes);
}

function toEntry(script: ScriptMeta): CacheEntry | null {
  // Only `ok` scripts participate. `invalid` rows never do — their
  // header may be unparsed or the file failed validation.
  if (script.status !== 'ok') return null;
  const name = scriptDisplayName(script);
  return {
    id: script.id,
    name,
    matching: script.matching,
    collectionId: script.collectionId,
    world: resolveScriptWorld(script),
    subsystems: grantedSubsystems(script.header),
    enabled: isScriptEnabled(script),
    local: isFileUrl(script.fileUrl),
    ...smDevRunField(script.fileUrl),
    ...(isManualScript(script) ? { manual: true as const } : {}),
  };
}

function smDevRunField(fileUrl: string): { smDevRun?: string } {
  const run = scratchRunOf(fileUrl);
  return run === null ? {} : { smDevRun: run };
}

// Install the storage listener exactly once. Safe to call repeatedly.
let listenerInstalled = false;
export function installStorageListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    // If a full load is mid-flight, buffer this change for replay after
    // the snapshot lands rather than mutating the soon-to-be-replaced
    // cache (which would lose this update). See loadAll().
    if (pendingDuringLoad) {
      pendingDuringLoad.push(changes);
      return;
    }
    applyStorageChanges(changes);
  });
}

// Apply one storage.onChanged delta to the in-memory cache. Shared by
// the live listener and loadAll()'s post-snapshot replay.
function applyStorageChanges(changes: { [key: string]: chrome.storage.StorageChange }): void {
  // Which rows moved, not just "something moved". The injector syncs
  // incrementally off this, so a listener that only said "changed"
  // would force it back to rebuilding every registration.
  const scriptIds: string[] = [];
  const collectionIds: string[] = [];
  for (const [key, change] of Object.entries(changes)) {
    if (key.startsWith(SCRIPT_PREFIX)) {
      // A write that only moved an annotation (`versionProbes`, or the
      // parse check's verdict) is not a change to anything downstream
      // of this listener, and saying otherwise is expensive: each one
      // schedules a registration sync. A "Refresh All" probes each
      // script in turn and writes each result as its own row, so
      // treating those as cache changes turned one refresh into a
      // re-registration per probed script — measured at 23 syncs
      // averaging 356ms for a 177-script profile, most of them landing
      // after the refresh had already finished. A verdict cost a second
      // sync after every edit.
      //
      // Safe for a probe because it is a display annotation and nothing
      // else: `toEntry` doesn't read it, and neither does `injector.ts`
      // (registration specs), `tab-status.ts`, or `background.ts`. The
      // pages that DO render it — the viewer and the collections page —
      // repaint from their own `chrome.storage.local.onChanged`
      // listeners, not from `onCacheChanged`, so the badge still
      // updates the moment a probe lands.
      //
      // Safe for a passing verdict for another reason: the sync reads
      // it (its gate checks rows without one), but it lands just after
      // the content change it checked, whose own write started a sync
      // then, and the registration built from the row is the same
      // either way. A failing one changes `status`, which is reported.
      if (onlyAnnotationsChanged(
        change.oldValue as ScriptMeta | undefined,
        change.newValue as ScriptMeta | undefined,
      )) {
        continue;
      }
      const id = key.slice(SCRIPT_PREFIX.length);
      scriptIds.push(id);
      invalidMatching.delete(id);
      if (change.newValue === undefined) {
        cache.delete(id);
        continue;
      }
      const script = change.newValue as ScriptMeta;
      const entry = toEntry(script);
      if (entry) cache.set(id, entry);
      else cache.delete(id);
      if (script.status === 'invalid' && script.matching) invalidMatching.set(id, script.matching);
    } else if (key.startsWith(COLLECTION_PREFIX)) {
      const id = key.slice(COLLECTION_PREFIX.length);
      const next = change.newValue as StoredCollection | undefined;
      // A collection row is rewritten on every scan (`lastScannedAt`
      // and friends), so reporting every write would re-register every
      // script under it on every refresh. Only what moves anything
      // downstream is reported: the enabled flag, and the row going
      // away.
      //
      // Deliberately NOT its arrival. A collection appears together
      // with the scripts under it, which are reported in their own
      // right, and the injector fetches a collection row it hasn't seen
      // when a script names one — so saying so here would buy nothing
      // and cost an extra sync per collection added.
      const wasDisabled = disabledCollections.has(id);
      if (next === undefined) {
        // Collection was removed entirely — its scripts will be deleted
        // via separate script:* changes; just drop our tracking row.
        disabledCollections.delete(id);
        collectionIds.push(id);
      } else if (!isCollectionEnabled(next)) {
        disabledCollections.add(id);
        if (!wasDisabled) collectionIds.push(id);
      } else {
        disabledCollections.delete(id);
        if (wasDisabled) collectionIds.push(id);
      }
    }
  }
  if (scriptIds.length > 0 || collectionIds.length > 0) {
    notifyChange({ scriptIds, collectionIds });
  }
}

// Whether a `script:*` write moved nothing but its annotations.
//
// Deliberately a diff of the two stored rows rather than of the derived
// cache entries. The entry holds only what MATCHING needs, but
// `notifyChange` also drives re-registration, which reads the whole row
// — body, `@require` bodies, grants, world, run-at. Comparing entries
// would call a body-only edit "no change" and leave the old code
// registered, which is a correctness bug, not a missed optimisation.
// So the rule is inverted: assume a change matters unless it is exactly
// the fields proven not to.
//
// Exported for unit tests.
export function onlyAnnotationsChanged(
  before: ScriptMeta | undefined,
  after: ScriptMeta | undefined,
): boolean {
  // A creation or a deletion is never "just an annotation".
  if (!before || !after) return false;
  return sameStoredValue(withoutAnnotations(before), withoutAnnotations(after));
}

// Allow the background SW to refresh open-tab badges when the script
// set changes (e.g. after a directory Refresh on the collections page,
// or a per-collection / per-script enabled toggle).
//
// The callback is handed the rows that moved. Listeners that only care
// that *something* moved can ignore it; the injector uses it to
// re-register just those scripts instead of the whole set.
export interface CacheChange {
  // Ids of `script:*` rows written, rewritten, or deleted. A row
  // whose write moved nothing but its annotations is not reported —
  // see `onlyAnnotationsChanged`.
  scriptIds: string[];
  // Ids of `collection:*` rows that went away or flipped their enabled
  // flag. Other collection-row writes — including a collection being
  // added — are not reported; see `applyStorageChanges`.
  collectionIds: string[];
}
type ChangeListener = (change: CacheChange) => void;
const changeListeners: ChangeListener[] = [];
export function onCacheChanged(fn: ChangeListener): void {
  changeListeners.push(fn);
}
function notifyChange(change: CacheChange): void {
  for (const fn of changeListeners) {
    try { fn(change); } catch { /* swallow listener errors */ }
  }
}

// The enabled scripts whose rules match `url`. Which kinds:
//   - 'load' (the default): the ones that run on page load, so what a
//     page is expected to run. Manual scripts are left out.
//   - 'manual': only the manual ones, which run on request.
//   - 'any': both, for "could this script be running here?".
export type MatchKind = 'load' | 'manual' | 'any';

export function findMatchesForUrl(url: string, kind: MatchKind = 'load'): MatchedScript[] {
  const out: MatchedScript[] = [];
  for (const entry of cache.values()) {
    if (!entry.enabled) continue;
    if (disabledCollections.has(entry.collectionId)) continue;
    if (kind === 'load' && entry.manual) continue;
    if (kind === 'manual' && !entry.manual) continue;
    if (urlMatchesScript(url, entry.matching)) {
      out.push({
        id: entry.id,
        name: entry.name,
        matching: entry.matching,
        collectionId: entry.collectionId,
        world: entry.world,
        ...(entry.smDevRun !== undefined ? { smDevRun: entry.smDevRun } : {}),
        ...(entry.manual ? { manual: true as const } : {}),
      });
    }
  }
  // Stable display order for the tooltip.
  out.sort((a, b) => compareScriptNames(a.name, b.name));
  return out;
}

// Whether `id` is a manual script (`@run-at context-menu`). False for
// an id the index doesn't hold.
export function isManualScriptId(id: string): boolean {
  return cache.get(id)?.manual === true;
}

// Every script whose rules match `url`, enabled or not — the popup
// lists the disabled ones too, so they can be turned on from there.
// `invalid` ones as well: one that targets the page but failed to load
// is listed as such. Ids only: the popup reads the rows it needs from
// storage.
export function findAllMatchingIds(url: string): string[] {
  const out: string[] = [];
  for (const entry of cache.values()) {
    if (urlMatchesScript(url, entry.matching)) out.push(entry.id);
  }
  for (const [id, matching] of invalidMatching) {
    if (urlMatchesScript(url, matching)) out.push(id);
  }
  return out;
}

// Narrow a set of script ids to the ones loaded from `file://`.
//
// Keyed on each script's own `fileUrl`, not on its collection's
// location: a container collection holds individually-installed scripts
// of both kinds, so the collection is the wrong unit for this question.
// (`isLocalCollection` in refresh-targets.ts answers the collection-level
// version, and has to special-case containers for exactly this reason.)
//
// Ids the cache doesn't hold — a script that isn't injectable, or one
// deleted since the tab last matched — are dropped rather than assumed
// local: there is nothing to refresh either way.
export function localScriptIds(ids: readonly string[]): string[] {
  return ids.filter((id) => cache.get(id)?.local === true);
}

// Does the profile hold ANY injectable local script?
//
// The cheap gate in front of the focus-triggered refresh: it runs on
// every tab switch and window focus change, and a profile with only
// http collections has nothing for it to do. Answering from the
// in-memory cache keeps that case off `chrome.storage.session`.
export function hasLocalScripts(): boolean {
  for (const entry of cache.values()) if (entry.local) return true;
  return false;
}

export function cacheSize(): number {
  return cache.size;
}

// The execution world a script would be injected into, or null when the
// id isn't in the injectable cache at all.
//
// Used by the SW to stamp every push it sends into a tab with the world
// the receiving script lives in. `wrapper-bridge.js` re-posts pushes
// into MAIN world, where the page can read them, so it must relay only
// what is addressed to a MAIN-world script — otherwise an isolated
// script's stored values and XHR response bodies would become
// page-visible on any page that happens to also run a MAIN-world
// script. Callers treat `null` as "not MAIN" (fail closed).
export function scriptWorld(id: string): InjectionWorld | null {
  return cache.get(id)?.world ?? null;
}

// True iff the script's `@grant` lines reach one of the given
// subsystems. The second half of the bridge gate: being a MAIN-world
// script on the page only makes the APIs it granted page-reachable, so
// a request through any other API is refused even for that script.
// Unknown ids fail closed.
export function scriptGrantsSubsystem(
  id: string,
  subsystems: readonly ApiSubsystem[],
): boolean {
  const granted = cache.get(id)?.subsystems;
  if (!granted) return false;
  return subsystems.some((s) => granted.has(s));
}

// Test/debug: dump the current cache contents. Lets e2e tests
// distinguish "the script never landed in the cache" from "the URL
// pattern doesn't match" when a badge classification looks wrong.
export function debugDumpCache(): { entries: { id: string; name: string; enabled: boolean; collectionId: string; matching: ScriptMatching }[]; disabledCollections: string[] } {
  return {
    entries: [...cache.values()].map((e) => ({
      id: e.id, name: e.name, enabled: e.enabled, collectionId: e.collectionId, matching: e.matching,
    })),
    disabledCollections: [...disabledCollections],
  };
}
