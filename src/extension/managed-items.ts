// What sm-dev's `collection list` and `script list` read: the
// collections and installed scripts, in the shapes sm-dev-protocol.ts
// gives them (`ManagedCollection`, `ManagedScript`). See
// docs/sm-dev-managers.md.

import { collectionKind } from '../file-locations.js';
import { scriptDisplayName } from '../script-display.js';
import type { ScriptMeta } from '../script-build.js';
import type { ManagedCollection, ManagedScript } from '../sm-dev-protocol.js';
import { getValue } from '../userscript-header.js';
import { effectiveDisplayName } from './collection-display.js';
import { smDevRunOfContainer, type ScratchSource } from './directories.js';
import { isCollectionEnabled, type StoredCollection } from './script-store.js';

export function managedCollection(collection: StoredCollection, number: number | undefined): ManagedCollection {
  const kind = collectionKind(collection.path);
  const run = smDevRunOfContainer(collection.path);
  return {
    id: collection.id,
    ...(number !== undefined ? { number } : {}),
    name: effectiveDisplayName(collection),
    kind: kind === 'scripts' ? 'container' : kind,
    ...(kind !== 'scripts' ? { location: collection.path } : {}),
    ...(run !== null ? { run } : {}),
    enabled: isCollectionEnabled(collection),
    ...(collection.scanError ? { error: collection.scanError } : {}),
    scriptCount: collection.scriptIds.length,
  };
}

export function managedScript(script: ScriptMeta, number: number | undefined, source?: ScratchSource): ManagedScript {
  const header = (tag: string): string | undefined => (script.header ? getValue(script.header, tag)?.trim() : undefined) || undefined;
  const namespace = header('namespace');
  const version = header('version');
  return {
    id: script.id,
    ...(number !== undefined ? { number } : {}),
    name: scriptDisplayName(script),
    ...(namespace ? { namespace } : {}),
    ...(version ? { version } : {}),
    location: script.fileUrl,
    ...(source ? { sourceFile: source.fileUrl, loadedAs: source.given } : {}),
    collectionId: script.collectionId,
    enabled: script.enabled !== false,
    status: script.status,
    ...(script.status === 'invalid' && script.errorMessage ? { error: script.errorMessage } : {}),
    ...(script.refreshError ? { refreshError: script.refreshError } : {}),
  };
}

/** The installed scripts, each collection's in its own order, runs' test collections' too. */
export function managedScripts(
  collections: readonly StoredCollection[], scripts: readonly ScriptMeta[], numbers: Record<string, number>,
  sources: Record<string, ScratchSource> = {},
): ManagedScript[] {
  const byId = new Map(scripts.map((s) => [s.id, s]));
  const listed: ManagedScript[] = [];
  for (const collection of collections) {
    for (const id of collection.scriptIds) {
      const script = byId.get(id);
      if (script) listed.push(managedScript(script, numbers[id], sources[script.fileUrl]));
    }
  }
  return listed;
}
