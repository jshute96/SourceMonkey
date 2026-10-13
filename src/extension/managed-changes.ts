// What sm-dev's collection and script commands change, and the details
// `script show`, `script print` and `script save` read: through the same store calls
// the collections page and the viewer make. See docs/sm-dev-managers.md.
//
// - Each call names its collection or script by the extension's own id;
//   sm-dev resolves `C3` / `E12` first.
// - A run's test collection is changed only by its run (writeRunScript,
//   releaseRun), so these refuse it. Its scripts can still be turned on
//   and off: sm-dev lets only their own run do that.
// - A refused change throws an Error with its message, which sm-dev
//   shows as it is.

import { bytesToBase64 } from '../bytes.js';
import { canonicalCollectionInput, containerPath, isContainerCollection, isHttpUrl } from '../file-locations.js';
import type { ScriptMeta } from '../script-build.js';
import {
  CONTAINER_TARGET_ONLY, LISTED_BY_LOCATION, RUN_COLLECTION_LOCKED,
  type CollectionRefresh, type ManagedCollection, type ManagedFile, type ManagedFileContent, type ManagedOnDisk, type ManagedScriptIcons, type ScriptIconsLoad, type ManagedScript, type ManagedScriptDetails,
  type ScriptEnable, type ScriptInstall, type ScriptRefresh,
} from '../sm-dev-protocol.js';
import { getValue, getValues, joinFullSource } from '../userscript-header.js';
import { containerKindForSingleFileInput, isScratchUrl, isSmDevCollection, scratchSourceKey, type ScratchSource } from './directories.js';
import { manifestToProbe, pendingOnDisk, probeFiles, scriptFileTag } from './file-changes.js';
import { countValues } from './value-store.js';
import { turnOffOtherCopies } from './script-identity.js';
import { setCollectionEnabledExclusive } from './script-enablement.js';
import { managedCollection, managedScript } from './managed-items.js';
import { mirrorPath } from './local-copy.js';
import { dataUrlContent, declaredIconFor, localIconFor, siteIconsFor } from './site-icon.js';
import { localRootsReady, localSearchRoots } from '../local-file-overrides.js';
import { iconRefFromHeader } from '../script-icon.js';
import { resolveScriptResource } from '../file-loader.js';
import {
  canonicalLocation, localFileScope, getAllScriptMetas, getCollection, getCollections, getCollectionWithScriptMeta, getScript, getScriptMeta, installScript, moveScript,
  removeScript, setCollectionOptions, setScriptEnabled, ALREADY_INSTALLED_IN_TARGET, COLLECTION_GONE, SCRIPT_GONE,
  type StoredCollection,
} from './script-store.js';
import { updateCollection, updateScript } from './script-updater.js';

// Where `script save` writes a file, relative to the script: an http(s)
// URL laid out as the viewer's local copy does, a `file:` URL by its
// file name. None for a `data:` URL.
function savePath(url: string): string | undefined {
  if (isHttpUrl(url)) return mirrorPath(url) ?? undefined;
  if (!url.startsWith('file:')) return undefined;
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || undefined;
  } catch {
    return undefined;
  }
}

// What `script save` names a site icon: the site's host, without
// `www.` and with a port after `_`, then the page's path when the icon
// is that page's own. Characters a file name can't hold become `_`.
function siteIconName(linkUrl: string, fromPage: boolean): string {
  const at = new URL(linkUrl);
  const host = at.host.replace(/^www\./, '').replace(':', '_');
  const segments = fromPage ? at.pathname.split('/').filter(Boolean).map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  }) : [];
  return [host, ...segments].map((part) => (part === '..' ? '_' : part.replace(/[\\:*?"<>|]/g, '_'))).join('/');
}

// A run's script: the file it was read from, as `managedScripts` gives it.
async function scratchSourceOf(script: ScriptMeta): Promise<ScratchSource | undefined> {
  const key = isScratchUrl(script.fileUrl) ? scratchSourceKey(script.fileUrl) : null;
  return key === null ? undefined : (await chrome.storage.local.get(key))[key] as ScratchSource | undefined;
}

/** The numbers sm-dev names things by, assigned first: `assignAllNumbers` in background.ts. */
export interface Numbers {
  scripts: Record<string, number>;
  collections: Record<string, number>;
}

async function scriptRow(id: string): Promise<ScriptMeta> {
  const script = await getScriptMeta(id);
  if (!script) throw new Error(SCRIPT_GONE);
  return script;
}

async function collectionRow(id: string): Promise<StoredCollection> {
  const collection = await getCollection(id);
  if (!collection) throw new Error(COLLECTION_GONE);
  return collection;
}

// One a person can change: not a run's test collection.
async function changeableCollection(id: string): Promise<StoredCollection> {
  const collection = await collectionRow(id);
  if (isSmDevCollection(collection.path)) throw new Error(RUN_COLLECTION_LOCKED);
  return collection;
}

// The target of an install or move: a container a person can change.
async function targetContainer(id: string): Promise<StoredCollection> {
  const collection = await changeableCollection(id);
  if (!isContainerCollection(collection.path)) throw new Error(CONTAINER_TARGET_ONLY);
  return collection;
}

// A script in a container collection, for a move or uninstall. A run's
// scripts are refused as their collection is.
async function containerScript(id: string): Promise<ScriptMeta> {
  const script = await scriptRow(id);
  const collection = await collectionRow(script.collectionId);
  if (isSmDevCollection(collection.path)) throw new Error(RUN_COLLECTION_LOCKED);
  if (!isContainerCollection(collection.path)) throw new Error(LISTED_BY_LOCATION);
  return script;
}

/** The calls, with `numbers` to name what they return by. */
export function managedChanges(numbers: () => Promise<Numbers>) {
  // `known`: the numbers, when the caller has them already.
  const shownScript = async (script: ScriptMeta, known?: Numbers): Promise<ManagedScript> =>
    managedScript(script, (known ?? await numbers()).scripts[script.id], await scratchSourceOf(script));
  // `sweep`: it may have started running, so its other copies go off.
  const shownEnable = async (script: ScriptMeta, sweep: boolean): Promise<ScriptEnable> => {
    const turnedOff = sweep ? await turnOffOtherCopies(script.id) : [];
    const known = await numbers();
    return {
      script: await shownScript(script, known),
      turnedOff: await Promise.all(turnedOff.map((s) => shownScript({ ...s, enabled: false }, known))),
    };
  };
  const shownCollection = async (collection: StoredCollection): Promise<ManagedCollection> =>
    managedCollection(collection, (await numbers()).collections[collection.id]);

  return {
    /**
     * Turns a script on or off. Turning it on turns its other running
     * copies off, as the viewer's toggle does.
     */
    async setScriptEnabled(id: string, enabled: boolean): Promise<ScriptEnable> {
      await scriptRow(id);
      const next = await setScriptEnabled(id, enabled);
      if (!next) throw new Error(SCRIPT_GONE);
      return shownEnable(next, enabled);
    },

    /**
     * Turns a whole collection on or off, keeping one copy of each
     * script running as the collections page's toggle does.
     */
    async setCollectionEnabled(id: string, enabled: boolean): Promise<ManagedCollection> {
      await changeableCollection(id);
      const { collection: next } = await setCollectionEnabledExclusive(id, enabled);
      if (!next) throw new Error(COLLECTION_GONE);
      return shownCollection(next);
    },

    /**
     * Re-reads a script from its location, as its Refresh button does.
     * A run's script too: from its stored text, which only its run
     * changes.
     */
    async refreshScript(id: string): Promise<ScriptRefresh> {
      const before = await scriptRow(id);
      const after = await updateScript(id, 'manual', 'force');
      if (!after) throw new Error(SCRIPT_GONE);
      return { script: await shownScript(after), updated: after.contentHash !== before.contentHash };
    },

    /** Re-reads a collection from its location, as its Refresh button does. */
    async refreshCollection(id: string): Promise<CollectionRefresh> {
      await changeableCollection(id);
      const before = await getCollectionWithScriptMeta(id);
      if (!before) throw new Error(COLLECTION_GONE);
      // Before the refresh: a removed script's number is retired after it.
      const numbersBefore = await numbers();
      const after = await updateCollection(id, 'manual');
      if (!after) throw new Error(COLLECTION_GONE);
      const numbersAfter = await numbers();
      const prior = new Map(before.scripts.map((s) => [s.id, s]));
      const updated: ManagedScript[] = [];
      let unchanged = 0;
      for (const script of after.scripts) {
        if (prior.has(script.id) && prior.get(script.id)!.contentHash === script.contentHash) unchanged++;
        else updated.push(await shownScript(script, numbersAfter));
      }
      const kept = new Set(after.scripts.map((s) => s.id));
      const removed = await Promise.all(before.scripts.filter((s) => !kept.has(s.id)).map((s) => shownScript(s, numbersBefore)));
      return { collection: managedCollection(after.collection, numbersAfter.collections[id]), updated, unchanged, removed };
    },

    /**
     * Installs a `.user.js` file or URL into a container collection, or
     * the built-in one for its scheme, as the viewer's Install does,
     * turning its other running copies off.
     */
    async installScript(location: string, collectionId: string | null): Promise<ScriptInstall> {
      if (collectionId !== null) await targetContainer(collectionId);
      const result = await installScript(location, collectionId !== null ? { collectionId } : { schemeDefault: true });
      if (!result) {
        // Already there: the one with the same location.
        const canonical = await canonicalLocation(location);
        const path = collectionId === null ? containerPath(containerKindForSingleFileInput(canonical)) : null;
        const container = (await getCollections()).find((c) => (path !== null ? c.path === path : c.id === collectionId));
        const rows = container ? (await getCollectionWithScriptMeta(container.id))?.scripts ?? [] : [];
        const found = rows.find((s) => canonicalCollectionInput(s.relativePath) === canonical);
        if (!found) throw new Error(SCRIPT_GONE);
        return { script: await shownScript(found), turnedOff: [], already: true };
      }
      const id = result.kind === 'existingContainer' ? result.scriptId : result.collection.scriptIds[0];
      const installed = await getScriptMeta(id);
      if (!installed) throw new Error(SCRIPT_GONE);
      return shownEnable(installed, true);
    },

    /** Removes a container collection's script, as its trash can does. Returns it as it was. */
    async uninstallScript(id: string): Promise<ManagedScript> {
      const script = await containerScript(id);
      const shown = await shownScript(script);
      await removeScript(id);
      return shown;
    },

    /**
     * Moves a script from one container collection to another, as the
     * viewer's Move does, turning its other running copies off.
     * Refused when the target holds its location already.
     */
    async moveScript(id: string, collectionId: string): Promise<ScriptEnable> {
      await containerScript(id);
      await targetContainer(collectionId);
      const moved = await moveScript(id, { collectionId });
      if (!moved) throw new Error(ALREADY_INSTALLED_IN_TARGET);
      return shownEnable(moved, true);
    },

    /** Renames a collection, as its dialog does. */
    async renameCollection(id: string, name: string): Promise<ManagedCollection> {
      await changeableCollection(id);
      const next = await setCollectionOptions(id, { displayName: name });
      if (!next) throw new Error(COLLECTION_GONE);
      return shownCollection(next);
    },

    /** A script in full, for `script show`; null for none. */
    async scriptDetails(id: string): Promise<ManagedScriptDetails | null> {
      const script = await getScriptMeta(id);
      if (!script) return null;
      const header = script.header;
      const tag = (name: string): string | undefined => (header ? getValue(header, name)?.trim() : undefined) || undefined;
      const all = (name: string): string[] => (header ? getValues(header, name).map((v) => v.trim()).filter(Boolean) : []);
      // Each declared file, matched to its loaded copy by how the header wrote it.
      const requires: ManagedFile[] = all('require').map((url) => {
        const loaded = script.requires?.find((r) => r.ref === url);
        return { url, loaded: loaded !== undefined, ...(loaded?.localUrl ? { local: loaded.localUrl } : {}) };
      });
      const resources: ManagedFile[] = all('resource').map((line) => {
        const [name = '', url = ''] = line.split(/\s+/);
        const loaded = script.resources?.find((r) => r.name === name);
        return { url, name, loaded: loaded !== undefined, ...(loaded?.localUrl ? { local: loaded.localUrl } : {}) };
      });
      const description = tag('description');
      const author = tag('author');
      const runAt = tag('run-at');
      return {
        ...await shownScript(script),
        ...(description ? { description } : {}),
        ...(author ? { author } : {}),
        ...(script.contentHash ? { updatedAt: script.loadedAt } : {}),
        match: script.matching.matches,
        include: script.matching.includes,
        exclude: script.matching.excludes,
        excludeMatch: all('exclude-match'),
        ...(runAt ? { runAt } : {}),
        grants: all('grant'),
        requires,
        resources,
        valueCount: await countValues(id),
      };
    },

    /**
     * What the disk says of the local scripts and collections, as the
     * collections page's chips show it: a file modified or deleted since
     * it was loaded, and what a refresh of a collection would load.
     */
    async onDisk(): Promise<ManagedOnDisk> {
      const [collections, scripts] = await Promise.all([getCollections(), getAllScriptMetas()]);
      const byId = new Map(collections.map((c) => [c.id, c]));
      const tagged = scripts.flatMap((script) => {
        const collection = byId.get(script.collectionId);
        const tag = collection ? scriptFileTag(script, collection.path) : null;
        return tag ? [{ script, tag }] : [];
      });
      const states = await probeFiles(tagged.map(({ tag }) => ({ path: tag.fsPath, size: tag.size, mtime: tag.mtime })));
      const result: ManagedOnDisk = { scripts: {}, collections: {} };
      tagged.forEach(({ script }, i) => {
        if (states[i] === 'missing') result.scripts[script.id] = 'deleted';
        else if (states[i] === 'modified') result.scripts[script.id] = 'modified';
      });
      await Promise.all(collections.map(async (collection) => {
        const files = tagged.flatMap(({ script, tag }, i) => (script.collectionId === collection.id ? [{ fsPath: tag.fsPath, state: states[i] }] : []));
        const counts = await pendingOnDisk(collection.path, manifestToProbe(collection), files);
        if (counts && (counts.manifest || counts.modified + counts.deleted + counts.added > 0)) result.collections[collection.id] = counts;
      }));
      return result;
    },

    /** A script's installed text, as the viewer's Source tab shows it; null for none. */
    async scriptText(id: string): Promise<string | null> {
      const script = await getScript(id);
      return script ? joinFullSource(script.leadingText ?? '', script.headerText, script.bodyText) : null;
    },

    /** A script's `@require` and `@resource` files as installed; null for no script. */
    async scriptFiles(id: string): Promise<ManagedFileContent[] | null> {
      const script = await getScript(id);
      if (!script) return null;
      const file = (kind: ManagedFileContent['kind'], url: string, base64: string, contentType: string): ManagedFileContent => {
        const path = savePath(url);
        return { kind, url, ...(path ? { path } : {}), base64, ...(contentType ? { contentType } : {}) };
      };
      const encoder = new TextEncoder();
      return [
        ...(script.requires ?? []).map((r) => file('require', r.url, bytesToBase64(encoder.encode(r.source)), 'text/javascript')),
        ...(script.resources ?? []).map((r) => ({ ...file('resource', r.url, r.bytesBase64, r.contentType), name: r.name })),
      ];
    },

    /**
     * A script's `@icon` and site icons; null for no script. `load.icon`
     * reads the `@icon`, else it has its URL alone. `load.sites` looks
     * up site icons not in the cache, as a page showing them would;
     * else they are given only when all are cached.
     */
    async scriptIcons(id: string, load: ScriptIconsLoad): Promise<ManagedScriptIcons | null> {
      const script = await getScriptMeta(id);
      if (!script) return null;
      const result: ManagedScriptIcons = {};
      const ref = iconRefFromHeader(script.header ?? null);
      // A run's script by the file it was read from, so a relative
      // `@icon` is found beside it.
      const source = await scratchSourceOf(script);
      const iconUrl = ref ? resolveScriptResource(ref, source?.fileUrl ?? script.fileUrl)?.url : undefined;
      if (iconUrl) {
        const path = savePath(iconUrl);
        // A local stand-in, as the pages use: looked for even without
        // `load.icon`, so `show` can say which.
        const collection = await getCollection(script.collectionId);
        const scope = collection ? localFileScope(collection) : { enabled: false };
        if (scope.enabled) await localRootsReady();
        const roots = localSearchRoots(script.fileUrl, scope);
        const standIn = isHttpUrl(iconUrl) && roots.length > 0 ? await localIconFor(iconUrl, roots) : null;
        const dataUrl = standIn?.dataUrl ?? (load.icon ? await declaredIconFor(iconUrl) : null);
        const content = load.icon && dataUrl ? dataUrlContent(dataUrl) : null;
        result.icon = { url: iconUrl, ...(path ? { path } : {}), ...(standIn ? { local: standIn.local } : {}), ...(content ?? {}) };
      }
      const slot = await siteIconsFor(script.matching.matches, load.sites === true);
      if (slot) {
        result.siteIcons = slot.map((icon) => {
          const content = icon.dataUrl ? dataUrlContent(icon.dataUrl) : null;
          return {
            sites: icon.sites.map((t) => t.linkUrl),
            name: siteIconName(icon.sites[0].linkUrl, icon.fromPage),
            ...(icon.source ? { source: icon.source } : {}),
            ...(content ?? {}),
          };
        });
      }
      return result;
    },
  };
}
