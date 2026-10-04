// `collection list` (`collections`) and `script list`: what SourceMonkey
// has installed, its collections and scripts, as text or JSON. The same
// in a run (through its ExtensionLink) and without one (a connection of
// their own, see `openManagerLink`). See docs/sm-dev-managers.md.
//
// Collections are named `C3` and scripts `E12` by the numbers
// SourceMonkey gives them (sticky-numbers.ts), so a name means the same
// thing in every run and every command.

import type { ManagedCollection, ManagedScript } from '../sm-dev-protocol.js';
import { jsonResult, type Collection, type CollectionListData, type CollectionRef, type Script, type ScriptListData } from './json-output.js';

/** The calls these commands make into SourceMonkey. */
export interface ManagerControl {
  collections(): Promise<ManagedCollection[]>;
  scripts(): Promise<ManagedScript[]>;
}

/**
 * A run's id in the extension (`D1-ab12`, see `linkRunId`) as sm-dev
 * names the run (`D1`).
 */
export function runOfLinkId(id: string): string {
  return id.replace(/-[0-9a-f]{4}$/, '');
}

// How a collection is named: `C3`, a run's test collection by its run,
// and (not yet numbered) by its own id.
function collectionLabel(c: ManagedCollection): string {
  return collectionId(c) ?? `id=${c.id}`;
}

/** In a run, what it knows of the scripts `script list` shows. */
export interface RunView {
  /** The run's own scripts' numbers (`2`), by the extension's id. */
  own: Map<string, string>;
  /** The selected script: by the extension's id, or by its E-id. */
  selected?: { internalId: string } | { label: string };
}

// A script in a run's test collection has no E-id: only its run knows
// its number (`1`), so another run's is shown by name alone.
function scriptLabel(s: ManagedScript, view: RunView | undefined): string | undefined {
  return view?.own.get(s.id) ?? (s.number !== undefined ? `E${s.number}` : undefined);
}

function isSelected(s: ManagedScript, view: RunView | undefined): boolean {
  const selected = view?.selected;
  if (!selected) return false;
  return 'internalId' in selected ? selected.internalId === s.id : selected.label === `E${s.number}`;
}

// Numbered ones by number, then the rest (runs' test collections) by name.
function sortedCollections(collections: readonly ManagedCollection[]): ManagedCollection[] {
  return [...collections].sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.name.localeCompare(b.name));
}

/** `1 script`, `2 scripts`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// Its id in JSON: `C3`, or a run's test collection's run (`D1`).
function collectionId(c: ManagedCollection): string | undefined {
  if (c.number !== undefined) return `C${c.number}`;
  return c.run !== undefined ? runOfLinkId(c.run) : undefined;
}

function collectionRef(c: ManagedCollection): CollectionRef {
  const id = collectionId(c);
  return { ...(id !== undefined ? { id } : {}), name: c.name };
}

function collectionJson(c: ManagedCollection): Collection {
  const id = collectionId(c);
  return {
    ...(id !== undefined ? { id } : {}),
    internalId: c.id,
    name: c.name,
    kind: c.kind,
    ...(c.location !== undefined ? { location: c.location } : {}),
    ...(c.run !== undefined ? { runCollection: runOfLinkId(c.run) } : {}),
    enabled: c.enabled,
    status: c.error ? 'load-failed' : 'ok',
    ...(c.error ? { error: c.error } : {}),
    scriptCount: c.scriptCount,
  };
}

function scriptJson(s: ManagedScript, collection: ManagedCollection | undefined, view: RunView | undefined): Script {
  const id = scriptLabel(s, view);
  return {
    ...(id !== undefined ? { id } : {}),
    kind: collection?.run !== undefined ? 'run' : 'installed',
    internalId: s.id,
    name: s.name,
    ...(s.namespace !== undefined ? { namespace: s.namespace } : {}),
    ...(s.version !== undefined ? { version: s.version } : {}),
    // A run's script: the file it was read from, and its path as given.
    location: s.sourceFile ?? s.location,
    ...(s.loadedAs !== undefined ? { file: s.loadedAs } : {}),
    ...(collection ? { collection: collectionRef(collection) } : {}),
    enabled: s.enabled,
    status: s.status,
    ...(s.error !== undefined ? { error: s.error } : {}),
    ...(s.refreshError !== undefined ? { refreshError: s.refreshError } : {}),
    ...(isSelected(s, view) ? { selected: true } : {}),
  };
}

/** Said for `collection <word>`, a verb it doesn't take. */
export function noSuchVerb(word: string): string {
  return `The collection command has no ${word} verb. Use collection list.`;
}

/** `collection list`: each collection, numbered ones first. */
export async function collectionList(manager: ManagerControl, out: (line: string) => void, json: boolean): Promise<void> {
  const collections = sortedCollections(await manager.collections());
  if (json) {
    out(jsonResult('collection list', { collections: collections.map(collectionJson) } satisfies CollectionListData));
    return;
  }
  out('Collections in SourceMonkey:');
  if (collections.length === 0) out('  None');
  for (const c of collections) {
    const notes = [count(c.scriptCount, 'script'), ...(c.enabled ? [] : ['disabled'])];
    out(`  ${collectionLabel(c)}: ${c.name} (${c.kind}): ${notes.join(', ')}`);
    // Not when its name is its location, as a directory's is by default.
    if (c.location !== undefined && c.location !== c.name) out(`      ${c.location}`);
    if (c.error) out(`      Failed to load: ${c.error}`);
  }
}

/**
 * The collection `name` names: `C3`, `id=<id>`, a run's (`D1`), or its
 * name, whole or a part only it has, in any case. For none or several,
 * throws an error with the reason.
 */
export function pickCollection(collections: readonly ManagedCollection[], name: string): ManagedCollection {
  const numbered = /^[Cc](\d+)$/.exec(name);
  if (numbered) {
    const found = collections.find((c) => c.number === Number(numbered[1]));
    if (!found) throw new Error(`There is no collection C${numbered[1]}. Use collection list to list them.`);
    return found;
  }
  if (name.startsWith('id=')) {
    const found = collections.find((c) => c.id === name.slice(3));
    if (!found) throw new Error(`There is no collection with ${name}. Use collection list to list them.`);
    return found;
  }
  const lower = name.toLowerCase();
  // A run's test collection by its run (`D1`), as `collection list` shows it.
  const run = collections.find((c) => c.run !== undefined && runOfLinkId(c.run).toLowerCase() === lower);
  if (run) return run;
  const whole = collections.filter((c) => c.name.toLowerCase() === lower);
  // Not runs' test collections by a part: they all share most of a name.
  const found = whole.length > 0 ? whole : collections.filter((c) => c.run === undefined && c.name.toLowerCase().includes(lower));
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`No collection is named ${name}. Use collection list to list them.`);
  const which = sortedCollections(found).map((c) => `${collectionLabel(c)} (${c.name})`).join(', ');
  throw new Error(`${name} names more than one collection: ${which}. Name one by its number (C1), or id=<id>.`);
}

/**
 * `script list [collection]`: the installed scripts, under their
 * collections, or one collection's. Throws for a collection it can't
 * find.
 */
export async function scriptList(
  manager: ManagerControl, name: string | undefined, out: (line: string) => void, json: boolean, view?: RunView,
): Promise<void> {
  const [collections, scripts] = await Promise.all([manager.collections(), manager.scripts()]);
  const picked = name === undefined ? undefined : pickCollection(collections, name);
  const shown = sortedCollections(picked ? [picked] : collections);
  const byCollection = new Map<string, ManagedScript[]>(shown.map((c) => [c.id, []]));
  for (const s of scripts) byCollection.get(s.collectionId)?.push(s);
  if (json) {
    out(jsonResult('script list', {
      ...(picked ? { collection: collectionRef(picked) } : {}),
      scripts: shown.flatMap((c) => byCollection.get(c.id)!.map((s) => scriptJson(s, c, view))),
    } satisfies ScriptListData));
    return;
  }
  const listed = shown.filter((c) => picked || byCollection.get(c.id)!.length > 0);
  if (listed.length === 0) out('No scripts are installed in SourceMonkey');
  for (const c of listed) {
    out(`${collectionLabel(c)}: ${c.name}`);
    const these = byCollection.get(c.id)!;
    if (these.length === 0) out('  No scripts');
    for (const s of these) {
      const name = s.version ? `${s.name} ${s.version}` : s.name;
      const label = scriptLabel(s, view);
      out(`${isSelected(s, view) ? '* ' : '  '}${label !== undefined ? `${label}: ` : ''}${name}${s.enabled ? '' : ' (disabled)'}${s.status === 'invalid' ? ': INVALID' : ''}`);
      // A run's script by its path as the run was given it, rather than
      // its `scratch:` URL.
      out(`      ${s.loadedAs ?? s.location}`);
      if (s.error) out(`      ${s.error}`);
      if (s.refreshError) out(`      Its last refresh failed: ${s.refreshError}`);
    }
  }
}
