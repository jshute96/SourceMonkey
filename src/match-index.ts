// In-memory index of every `status: 'ok'` userscript's matching info so
// the background service worker can find matching scripts for a URL
// without touching chrome.storage.local on every navigation.
//
// Built once on first access (ensureLoaded()), then kept fresh by a
// chrome.storage.local.onChanged listener. Storage I/O cost scales with
// the user's script count at SW startup; per-navigation cost is just an
// in-memory loop over the cache.
//
// Enabled state: a script is considered for matching only if BOTH its
// own `enabled` flag and its parent source's `enabled` flag are true.
// We cache every ok script (regardless of enabled) and separately track
// the set of disabled sources, so toggling a source flips every script
// under it in O(1) without rewalking storage.

import { getValue } from './userscript-header.js';
import {
  isScriptEnabled,
  isSourceEnabled,
  type ScriptMatching,
  type StoredScript,
  type StoredSource,
} from './script-store.js';
import { urlMatchesScript } from './url-match.js';

export interface MatchedScript {
  id: string;
  name: string;       // @name, or relativePath as a fallback
  matching: ScriptMatching;
  sourceId: string;
}

const SCRIPT_PREFIX = 'script:';
const SOURCE_PREFIX = 'source:';

interface CacheEntry extends MatchedScript {
  enabled: boolean;   // the script's own toggle (not the source's)
}

let cache = new Map<string, CacheEntry>();
let disabledSources = new Set<string>();
let loaded: Promise<void> | null = null;

// First call kicks off a single full read; later callers await the same
// promise. After it resolves, the cache is kept fresh by the onChanged
// listener installed by installStorageListener().
export function ensureLoaded(): Promise<void> {
  if (!loaded) loaded = loadAll();
  return loaded;
}

async function loadAll(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const nextCache = new Map<string, CacheEntry>();
  const nextDisabled = new Set<string>();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(SCRIPT_PREFIX)) {
      const entry = toEntry(value as StoredScript);
      if (entry) nextCache.set(entry.id, entry);
    } else if (key.startsWith(SOURCE_PREFIX)) {
      const source = value as StoredSource;
      if (!isSourceEnabled(source)) nextDisabled.add(source.id);
    }
  }
  cache = nextCache;
  disabledSources = nextDisabled;
}

function toEntry(script: StoredScript): CacheEntry | null {
  // Only ok scripts participate in matching. error/missing entries keep
  // their last-known content for the viewer but shouldn't be injected.
  if (script.status !== 'ok') return null;
  const name = (script.header && getValue(script.header, 'name')) || script.relativePath;
  return {
    id: script.id,
    name,
    matching: script.matching,
    sourceId: script.sourceId,
    enabled: isScriptEnabled(script),
  };
}

// Install the storage listener exactly once. Safe to call repeatedly.
let listenerInstalled = false;
export function installStorageListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    let touched = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith(SCRIPT_PREFIX)) {
        touched = true;
        const id = key.slice(SCRIPT_PREFIX.length);
        if (change.newValue === undefined) {
          cache.delete(id);
          continue;
        }
        const entry = toEntry(change.newValue as StoredScript);
        if (entry) cache.set(id, entry);
        else cache.delete(id);
      } else if (key.startsWith(SOURCE_PREFIX)) {
        const id = key.slice(SOURCE_PREFIX.length);
        const next = change.newValue as StoredSource | undefined;
        if (next === undefined) {
          // Source was removed entirely — its scripts will be deleted
          // via separate script:* changes; just drop our tracking row.
          if (disabledSources.delete(id)) touched = true;
        } else if (!isSourceEnabled(next)) {
          if (!disabledSources.has(id)) { disabledSources.add(id); touched = true; }
        } else {
          if (disabledSources.delete(id)) touched = true;
        }
      }
    }
    if (touched) notifyChange();
  });
}

// Allow the background SW to refresh open-tab badges when the script
// set changes (e.g. after a directory Refresh on the options page, or a
// per-source / per-script enabled toggle).
type ChangeListener = () => void;
const changeListeners: ChangeListener[] = [];
export function onCacheChanged(fn: ChangeListener): void {
  changeListeners.push(fn);
}
function notifyChange(): void {
  for (const fn of changeListeners) {
    try { fn(); } catch { /* swallow listener errors */ }
  }
}

export function findMatchesForUrl(url: string): MatchedScript[] {
  const out: MatchedScript[] = [];
  for (const entry of cache.values()) {
    if (!entry.enabled) continue;
    if (disabledSources.has(entry.sourceId)) continue;
    if (urlMatchesScript(url, entry.matching)) {
      out.push({
        id: entry.id,
        name: entry.name,
        matching: entry.matching,
        sourceId: entry.sourceId,
      });
    }
  }
  // Stable display order for the tooltip.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function cacheSize(): number {
  return cache.size;
}
