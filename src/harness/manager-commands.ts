// The `collection` and `script` commands: what the manager has
// installed, its collections and scripts, listed, shown and changed, as
// text or JSON. The same in a run (through its ExtensionLink) and
// without one (a connection of their own, see `openManagerLink`). See
// docs/sm-dev-managers.md. Under Violentmonkey or Tampermonkey, the
// same commands over `externalControl` (external-manager.ts).
//
// Collections are named `C3` and scripts `E12` by the numbers
// SourceMonkey gives them (sticky-numbers.ts), so a name means the same
// thing in every run and every command. Another manager's scripts go
// by its own numbers, in one collection, `C0`.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LISTED_BY_LOCATION, RUN_COLLECTION_LOCKED,
  type CollectionRefresh, type ManagedCollection, type ManagedFile, type ManagedOnDisk, type ManagedScript, type ManagedScriptDetails,
  type ScriptEnable, type ScriptInstall, type ScriptRefresh,
} from '../sm-dev-protocol.js';
import { pendingSummary } from '../script-display.js';
import {
  jsonResult, type Collection, type CollectionListData, type CollectionRef, type Script, type ScriptListData, type TabActivity,
} from './json-output.js';
import type * as J from './json-output.js';
import { commandSyntax } from './command-list.js';

/**
 * The calls these commands make into the manager: SourceMonkey's
 * (managed-changes.ts), or another's (external-manager.ts).
 */
export interface ManagerControl {
  /** The manager's name, for what the commands say (`SourceMonkey`). */
  readonly label: string;
  collections(): Promise<ManagedCollection[]>;
  scripts(): Promise<ManagedScript[]>;
  /** What the disk says of local scripts and collections; null for an extension older than 1.5. */
  onDisk(): Promise<ManagedOnDisk | null>;
  setScriptEnabled(id: string, enabled: boolean): Promise<ScriptEnable>;
  setCollectionEnabled(id: string, enabled: boolean): Promise<ManagedCollection>;
  refreshScript(id: string): Promise<ScriptRefresh>;
  refreshCollection(id: string): Promise<CollectionRefresh>;
  /**
   * `replace`: another manager may replace a script of the person's own
   * with the same name and namespace; else it refuses (`ReplaceRefused`).
   */
  installScript(location: string, collectionId: string | null, replace?: boolean): Promise<ScriptInstall>;
  uninstallScript(id: string): Promise<ManagedScript>;
  moveScript(id: string, collectionId: string): Promise<ScriptEnable>;
  renameCollection(id: string, name: string): Promise<ManagedCollection>;
  scriptDetails(id: string): Promise<ManagedScriptDetails | null>;
  scriptText(id: string): Promise<string | null>;
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
// its number (`1`), so another run's is shown by name alone. Under
// another manager, a run's scripts are its scripts too, with E-ids.
function scriptLabel(s: ManagedScript, view: RunView | undefined): string | undefined {
  return s.number !== undefined ? `E${s.number}` : view?.own.get(s.id);
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

function collectionJson(c: ManagedCollection, disk?: ManagedOnDisk | null): Collection {
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
    ...(disk?.collections[c.id] ? { onDisk: disk.collections[c.id] } : {}),
  };
}

function scriptJson(s: ManagedScript, collection: ManagedCollection | undefined, view: RunView | undefined, disk?: ManagedOnDisk | null): Script {
  const id = scriptLabel(s, view);
  return {
    ...(id !== undefined ? { id } : {}),
    kind: collection?.run !== undefined || s.run !== undefined ? 'run' : 'installed',
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
    ...(disk?.scripts[s.id] ? { onDisk: disk.scripts[s.id] } : {}),
    ...(isSelected(s, view) ? { selected: true } : {}),
    ...(s.run !== undefined ? { run: s.run } : {}),
    ...(s.leftBy !== undefined ? { leftBy: s.leftBy } : {}),
  };
}

/** The verbs each command takes. `script` without one picks a script instead. */
export const MANAGER_VERBS = {
  collection: ['list', 'show', 'enable', 'disable', 'refresh', 'rename'],
  script: ['list', 'show', 'print', 'enable', 'disable', 'refresh', 'install', 'uninstall', 'move'],
} as const;

/** Said for `collection <words>` with no verb it takes: `C3 frob`, or one word alone. */
export function noSuchVerb(words: readonly string[]): string {
  const verbs = MANAGER_VERBS.collection.join(', ');
  if (words.length === 1) return `The collection command needs a verb: collection ${words[0]} <verb>. It takes ${verbs}.`;
  return `The collection command has no ${words[1]} verb. It takes ${verbs}.`;
}

/** `collection list`: each collection, numbered ones first. */
export async function collectionList(manager: ManagerControl, out: (line: string) => void, json: boolean): Promise<void> {
  const [listed, disk] = await Promise.all([manager.collections(), manager.onDisk()]);
  const collections = sortedCollections(listed);
  if (json) {
    out(jsonResult('collection list', { collections: collections.map((c) => collectionJson(c, disk)) } satisfies CollectionListData));
    return;
  }
  out(`Collections in ${manager.label}:`);
  if (collections.length === 0) out('  None');
  for (const c of collections) {
    const notes = [count(c.scriptCount, 'script'), ...(c.enabled ? [] : ['disabled'])];
    out(`  ${collectionLabel(c)}: ${c.name} (${c.kind}): ${notes.join(', ')}`);
    // Not when its name is its location, as a directory's is by default.
    if (c.location !== undefined && c.location !== c.name) out(`      ${c.location}`);
    if (c.error) out(`      Failed to load: ${c.error}`);
    const pending = pendingText(c, disk);
    if (pending) out(`      ${pending}`);
  }
}

// `Refresh pending: 1 file modified on disk`, as the collections page's chip says.
function pendingText(c: ManagedCollection, disk: ManagedOnDisk | null): string | undefined {
  const counts = disk?.collections[c.id];
  return counts ? `Refresh pending: ${pendingSummary(counts)} on disk` : undefined;
}

// A script's line in `script list` and `collection show`: `* E3: Name 1.2 (disabled): INVALID`.
function scriptLine(s: ManagedScript, view: RunView | undefined, disk: ManagedOnDisk | null): string {
  const name = s.version ? `${s.name} ${s.version}` : s.name;
  const label = scriptLabel(s, view);
  const onDisk = disk?.scripts[s.id];
  const notes = [
    ...(s.enabled ? [] : ['disabled']),
    ...(onDisk ? [`${onDisk} on disk`] : []),
    // Under another manager, where a run's scripts are among the rest.
    ...(s.run !== undefined ? [`run ${s.run}'s${view?.own.has(s.id) ? ` script ${view.own.get(s.id)}` : ''}`] : []),
    ...(s.leftBy !== undefined ? [`left by run ${s.leftBy}, which ended`] : []),
  ];
  return `${isSelected(s, view) ? '* ' : '  '}${label !== undefined ? `${label}: ` : ''}${name}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}${s.status === 'invalid' ? ': INVALID' : ''}`;
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
  const [collections, scripts, disk] = await Promise.all([manager.collections(), manager.scripts(), manager.onDisk()]);
  const picked = name === undefined ? undefined : pickCollection(collections, name);
  const shown = sortedCollections(picked ? [picked] : collections);
  const byCollection = new Map<string, ManagedScript[]>(shown.map((c) => [c.id, []]));
  for (const s of scripts) byCollection.get(s.collectionId)?.push(s);
  if (json) {
    out(jsonResult('script list', {
      ...(picked ? { collection: collectionRef(picked) } : {}),
      scripts: shown.flatMap((c) => byCollection.get(c.id)!.map((s) => scriptJson(s, c, view, disk))),
    } satisfies ScriptListData));
    return;
  }
  const listed = shown.filter((c) => picked || byCollection.get(c.id)!.length > 0);
  if (listed.length === 0) out(`No scripts are installed in ${manager.label}`);
  for (const c of listed) {
    out(`${collectionLabel(c)}: ${c.name}`);
    const these = byCollection.get(c.id)!;
    if (these.length === 0) out('  No scripts');
    for (const s of these) {
      out(scriptLine(s, view, disk));
      // A run's script by its path as the run was given it, rather than
      // its `scratch:` URL.
      const where = s.loadedAs ?? s.location;
      if (where) out(`      ${where}`);
      if (s.error) out(`      ${s.error}`);
      if (s.refreshError) out(`      Its last refresh failed: ${s.refreshError}`);
    }
  }
}

// ---------- Showing and changing one thing ----------

/** What a run adds to the commands that show and change things. */
export interface ManagerRun extends RunView {
  /** Re-reads one of the run's own scripts from disk, as `update` does. */
  updateOwn(internalId: string): Promise<void>;
  /** What a script does on each of the run's tabs, with the words `scripts` uses for it. */
  tabsOf(script: ManagedScript, label: string | undefined): Promise<{ activity: TabActivity; text: string }[]>;
}

/** Where the commands that show and change things run. */
export interface ManagerContext {
  manager: ManagerControl;
  out: (line: string) => void;
  json: boolean;
  /** In a run. */
  run?: ManagerRun;
  /**
   * The collections and scripts are the person's own (not a
   * `--temp-browser`'s), so a change that takes something away needs
   * `--force`.
   */
  guarded: boolean;
  /** Where a relative path given to `script install` is from. */
  cwd: string;
}

// What each verb takes after it, for the message when it's missing.
const NEEDS: Record<string, string> = {
  'script install': 'a .user.js file or URL', 'script move': 'the collection to move it to', 'collection rename': 'the new name',
};

/**
 * The script `name` names: a run's own by its number (`2`), `E12`,
 * `id=<id>`, or its name, whole or a part only it has, in any case. For
 * none or several, throws an error with the reason.
 */
export function pickManagedScript(scripts: readonly ManagedScript[], name: string, view?: RunView): ManagedScript {
  const none = noSuchScript(name);
  if (/^\d+$/.test(name)) {
    const id = [...view?.own ?? []].find(([, n]) => n === name)?.[0];
    const found = id === undefined ? undefined : scripts.find((s) => s.id === id);
    if (!found) throw new Error(view ? none : `There is no script ${name}: A number names one of a run's scripts, in that run. Name an installed script as E1.`);
    return found;
  }
  const numbered = /^[Ee](\d+)$/.exec(name);
  if (numbered) {
    const found = scripts.find((s) => s.number === Number(numbered[1]));
    if (!found) throw new Error(none);
    return found;
  }
  if (name.startsWith('id=')) {
    const found = scripts.find((s) => s.id === name.slice(3));
    if (!found) throw new Error(none);
    return found;
  }
  const lower = name.toLowerCase();
  const whole = scripts.filter((s) => s.name.toLowerCase() === lower);
  const found = whole.length > 0 ? whole : scripts.filter((s) => s.name.toLowerCase().includes(lower));
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`No script is named ${name}. Use script list to list them.`);
  const which = found.map((s) => scriptShown(s, view)).join(', ');
  throw new Error(`${name} names more than one script: ${which}. Name one by its number (E1), or id=<id>.`);
}

/** Another manager won't replace the person's own script `shown` (`E3: Name`) without `replace`. */
export class ReplaceRefused extends Error {
  constructor(readonly shown: string) {
    super(`${shown} has the same name and namespace, and would be replaced`);
  }
}

/** Said for a script name that names none. */
export function noSuchScript(name: string): string {
  return `There is no script ${name}. Use script list to list the installed scripts.`;
}

// The run's selected script, for a script verb given none.
function selectedScript(scripts: readonly ManagedScript[], view: RunView): ManagedScript {
  const selected = view.selected!;
  if ('label' in selected) return pickManagedScript(scripts, selected.label, view);
  const found = scripts.find((s) => s.id === selected.internalId);
  if (!found) throw new Error('The selected script is not installed. Name one: script <script> <verb>.');
  return found;
}

// `E3: Name`, or a script with no label by its name alone.
function scriptShown(s: ManagedScript, view: RunView | undefined): string {
  const label = scriptLabel(s, view);
  return label !== undefined ? `${label}: ${s.name}` : s.name;
}

// `C3: Name`.
function collectionShown(c: ManagedCollection): string {
  return `${collectionLabel(c)}: ${c.name}`;
}

/**
 * `collection <C> <verb>`, `script [script] <verb>` and `script
 * install`. `subject`: what it acts on, named before the verb; a script
 * left out is the selected one. `args`: the words after the verb;
 * `flags`: the command's own. Returns false when it failed, having said
 * why.
 */
export async function managerVerb(
  ctx: ManagerContext, command: 'collection' | 'script', verb: string, subject: string | undefined, args: string[],
  flags: Record<string, string | true>,
): Promise<boolean> {
  const usage = commandSyntax(command).usage.find((u) => new RegExp(`^\\S+ (\\S+ )?${verb}(\\s|$)`).test(u));
  // Not uninstall: removing the selected script by leaving it out is too easy a slip.
  const selectable = command === 'script' && verb !== 'uninstall' && ctx.run?.selected !== undefined;
  // The old order: `collection rename C3 New name`.
  if (command === 'collection' && subject === undefined && args.length > 0) {
    ctx.out(`[sm-dev] ERROR: Name the collection before the verb: collection ${args[0]} ${verb}${args.slice(1).map((w) => ` ${w}`).join('')}`);
    return false;
  }
  if (verb !== 'install' && subject === undefined && !selectable) {
    // Named, not optional, in the usage shown: it is needed here.
    const named = usage?.replace(`${command} [${command}]`, `${command} <${command}>`);
    const why = command === 'script' && verb !== 'uninstall' ? ` There is no selected script ${ctx.run ? 'in this run' : 'outside a run'}.` : '';
    ctx.out(`[sm-dev] ERROR: The ${command} ${verb} command needs ${command === 'script' ? 'a script' : 'a collection'}: ${named}${why ? `.${why}` : ''}`);
    return false;
  }
  const need = NEEDS[`${command} ${verb}`];
  if (need && args.length === 0) {
    ctx.out(`[sm-dev] ERROR: The ${command} ${verb} command needs ${need}: ${usage}`);
    return false;
  }
  try {
    if (command === 'collection') return await collectionVerb(ctx, verb, subject!, args);
    return await scriptVerb(ctx, verb, subject, args, flags);
  } catch (err) {
    // Its own message: these start with what they're about (`E2: One`).
    ctx.out(`[sm-dev] ${(err as Error).message}`);
    return false;
  }
}

// A change the manager refused, said with what it was: `Could not
// disable E3: One: <why>`.
async function attempt<T>(what: string, change: Promise<T>): Promise<T> {
  try {
    return await change;
  } catch (err) {
    throw new Error(`Could not ${what}: ${(err as Error).message}`, { cause: err });
  }
}

// Refused, saying why, when `--force` is needed and wasn't given.
function forced(ctx: ManagerContext, flags: Record<string, string | true>, what: string, change: string): boolean {
  if (!ctx.guarded || flags['--force'] === true) return true;
  ctx.out(`[sm-dev] ERROR: ${what} is installed in ${ctx.manager.label} in this browser, so this would ${change} for real. Use --force to continue.`);
  return false;
}

async function collectionVerb(ctx: ManagerContext, verb: string, subject: string, args: string[]): Promise<boolean> {
  const collections = await ctx.manager.collections();
  const picked = pickCollection(collections, subject);
  const shown = collectionShown(picked);
  const changed = (c: ManagedCollection, text: string): void => {
    if (ctx.json) ctx.out(jsonResult(`collection ${verb}`, { collection: collectionJson(c) } satisfies J.CollectionChangeData));
    else ctx.out(text);
  };
  switch (verb) {
    case 'show':
      await collectionShow(ctx, picked);
      return true;
    case 'enable':
    case 'disable': {
      const enabled = verb === 'enable';
      // Refused whatever --force says, so said first.
      if (picked.run !== undefined) throw new Error(`Could not ${verb} ${shown}: ${RUN_COLLECTION_LOCKED}`);
      const next = await attempt(`${verb} ${shown}`, ctx.manager.setCollectionEnabled(picked.id, enabled));
      changed(next, `${enabled ? 'Enabled' : 'Disabled'} ${collectionShown(next)}`);
      return true;
    }
    case 'rename': {
      const next = await attempt(`rename ${shown}`, ctx.manager.renameCollection(picked.id, args.join(' ')));
      changed(next, `Renamed ${collectionLabel(next)} to ${next.name}`);
      return true;
    }
    case 'refresh': {
      const result = await attempt(`refresh ${shown}`, ctx.manager.refreshCollection(picked.id));
      const view = ctx.run;
      if (ctx.json) {
        ctx.out(jsonResult('collection refresh', {
          collection: collectionJson(result.collection),
          updated: result.updated.map((s) => scriptJson(s, result.collection, view)),
          unchanged: result.unchanged,
          removed: result.removed.map((s) => scriptJson(s, result.collection, view)),
          ...(result.failed ? { failed: result.failed.map((s) => scriptJson(s, result.collection, view)) } : {}),
        } satisfies J.CollectionRefreshData));
        return true;
      }
      const failed = result.failed ?? [];
      const notes = [`${result.updated.length} updated`, `${result.unchanged} unchanged`, ...(result.removed.length > 0 ? [`${result.removed.length} removed`] : []),
        ...(failed.length > 0 ? [`${failed.length} failed`] : [])];
      ctx.out(`Refreshed ${collectionShown(result.collection)}: ${notes.join(', ')}`);
      if (result.collection.error) ctx.out(`  Failed to load: ${result.collection.error}`);
      for (const s of result.updated) {
        ctx.out(`  Updated ${scriptShown(s, view)}${s.status === 'invalid' ? ': INVALID' : ''}`);
        if (s.error) ctx.out(`      ${s.error}`);
        if (s.refreshError) ctx.out(`      Its last refresh failed: ${s.refreshError}`);
      }
      for (const s of result.removed) ctx.out(`  Removed ${scriptShown(s, view)}`);
      for (const s of failed) ctx.out(`  Failed to refresh ${scriptShown(s, view)}: ${s.refreshError ?? ''}`);
      return true;
    }
  }
  return false;
}

// `collection show`: the collection, then its scripts as `script list` shows them.
async function collectionShow(ctx: ManagerContext, picked: ManagedCollection): Promise<void> {
  const [all, disk] = await Promise.all([ctx.manager.scripts(), ctx.manager.onDisk()]);
  const scripts = all.filter((s) => s.collectionId === picked.id);
  if (ctx.json) {
    ctx.out(jsonResult('collection show', {
      collection: { ...collectionJson(picked, disk), scripts: scripts.map((s) => scriptJson(s, picked, ctx.run, disk)) },
    } satisfies J.CollectionShowData));
    return;
  }
  ctx.out(collectionShown(picked));
  const rows: [string, string][] = [
    ['Kind', picked.kind],
    ...(picked.location !== undefined ? [['Location', picked.location] as [string, string]] : []),
    ...(picked.run !== undefined ? [['Run', `the test collection of run ${runOfLinkId(picked.run)}`] as [string, string]] : []),
    ['Status', `${picked.enabled ? 'Enabled' : 'Disabled'}${picked.error ? `, failed to load: ${picked.error}` : ''}`],
    ...(disk?.collections[picked.id] ? [['On disk', `${pendingSummary(disk.collections[picked.id])}, not loaded yet`] as [string, string]] : []),
    ['Scripts', scripts.length === 0 ? 'None' : count(scripts.length, 'script')],
  ];
  for (const [name, value] of rows) ctx.out(`  ${`${name}:`.padEnd(12)}${value}`);
  for (const s of scripts) ctx.out(scriptLine(s, ctx.run, disk));
}

async function scriptVerb(
  ctx: ManagerContext, verb: string, subject: string | undefined, args: string[], flags: Record<string, string | true>,
): Promise<boolean> {
  if (verb === 'install') return scriptInstall(ctx, args[0], flags);
  const [scripts, collections] = await Promise.all([ctx.manager.scripts(), ctx.manager.collections()]);
  const view = ctx.run;
  const picked = subject !== undefined ? pickManagedScript(scripts, subject, view) : selectedScript(scripts, view!);
  const collection = collections.find((c) => c.id === picked.collectionId);
  const shown = scriptShown(picked, view);
  const own = view?.own.has(picked.id) === true;
  // Another run's script, or one left by a run that ended. Under
  // another manager, only a live run's.
  const othersRun = own ? undefined : collection?.run !== undefined ? runOfLinkId(collection.run) : picked.run;
  const changed = (s: ManagedScript, text: string, extra: object = {}): void => {
    const into = collections.find((c) => c.id === s.collectionId);
    if (ctx.json) ctx.out(jsonResult(`script ${verb}`, { script: scriptJson(s, into, view), ...extra } satisfies J.ScriptChangeData));
    else ctx.out(text);
  };
  // With what turning it on did besides.
  const enableChanged = (result: ScriptEnable, text: string): void => {
    const into = collections.find((c) => c.id === result.script.collectionId);
    if (ctx.json) {
      ctx.out(jsonResult(`script ${verb}`, {
        script: scriptJson(result.script, into, view), ...enableEffectsJson(result, into, collections, view),
      } satisfies J.ScriptChangeData));
      return;
    }
    ctx.out(text);
    for (const line of enableEffects(result, into, collections, view)) ctx.out(`  ${line}`);
  };
  switch (verb) {
    case 'show':
      await scriptShow(ctx, picked, collection);
      return true;
    case 'print': {
      const text = await ctx.manager.scriptText(picked.id);
      if (text === null) throw new Error(noSuchScript(scriptShown(picked, view)));
      const id = scriptLabel(picked, view);
      if (ctx.json) ctx.out(jsonResult('script print', { ...(id !== undefined ? { script: id } : {}), name: picked.name, text } satisfies J.ScriptPrintData));
      else for (const line of text.replace(/\n$/, '').split('\n')) ctx.out(line);
      return true;
    }
    case 'enable':
    case 'disable': {
      const enabled = verb === 'enable';
      if (othersRun !== undefined) throw new Error(`${shown} is a script of run ${othersRun}, which only that run changes`);
      const next = await attempt(`${verb} ${shown}`, ctx.manager.setScriptEnabled(picked.id, enabled));
      enableChanged(next, `${enabled ? 'Enabled' : 'Disabled'} ${scriptShown(next.script, view)}`);
      return true;
    }
    case 'refresh': {
      // From disk, as `update` does, so the run knows its new text.
      if (own) {
        const before = await ctx.manager.scriptText(picked.id);
        await view!.updateOwn(picked.id);
        if (ctx.json) {
          const [after] = (await ctx.manager.scripts()).filter((s) => s.id === picked.id);
          const updated = (await ctx.manager.scriptText(picked.id)) !== before;
          ctx.out(jsonResult('script refresh', { script: scriptJson(after ?? picked, collection, view), updated } satisfies J.ScriptRefreshData));
        }
        return true;
      }
      if (othersRun !== undefined) throw new Error(`${shown} is a script of run ${othersRun}, which only that run changes`);
      const result = await attempt(`refresh ${shown}`, ctx.manager.refreshScript(picked.id));
      const s = result.script;
      if (ctx.json) {
        ctx.out(jsonResult('script refresh', { script: scriptJson(s, collection, view), updated: result.updated } satisfies J.ScriptRefreshData));
        return true;
      }
      ctx.out(`Refreshed ${scriptShown(s, view)}: ${result.updated ? 'updated' : 'no change'}${s.status === 'invalid' ? ', and it is INVALID' : ''}`);
      if (s.error) ctx.out(`  ${s.error}`);
      if (s.refreshError) ctx.out(`  The refresh failed, so its last good copy still runs: ${s.refreshError}`);
      return true;
    }
    case 'uninstall': {
      if (own) throw new Error(`${shown} is one of this run's own scripts, which go when the run ends`);
      if (othersRun !== undefined) throw new Error(`${shown} is a script of run ${othersRun}, which only that run changes`);
      // Refused whatever --force says, so said first.
      if (collection && collection.kind !== 'container') throw new Error(`Could not uninstall ${shown}: ${LISTED_BY_LOCATION}`);
      if (!forced(ctx, flags, shown, 'remove it')) return false;
      const was = await attempt(`uninstall ${shown}`, ctx.manager.uninstallScript(picked.id));
      changed(was, `Uninstalled ${scriptShown(was, view)}${collection ? ` from ${collectionShown(collection)}` : ''}`, { removed: true });
      return true;
    }
    case 'move': {
      if (own) throw new Error(`${shown} is one of this run's own scripts, which stay in its test collection`);
      const target = pickCollection(collections, args[0]);
      if (target.id === picked.collectionId) throw new Error(`${shown} is already in ${collectionShown(target)}`);
      const moved = await attempt(`move ${shown} to ${collectionShown(target)}`, ctx.manager.moveScript(picked.id, target.id));
      enableChanged(moved, `Moved ${scriptShown(moved.script, view)} to ${collectionShown(target)}`);
      return true;
    }
  }
  return false;
}

// `script install <file|url>`: a path is the sender's, made a `file://` URL.
async function scriptInstall(ctx: ManagerContext, given: string, flags: Record<string, string | true>): Promise<boolean> {
  const location = /^[a-z][a-z0-9+.-]*:/i.test(given) && !/^[a-z]:[\\/]/i.test(given)
    ? given
    : pathToFileURL(path.resolve(ctx.cwd, given)).href;
  if (!/\.user\.js$/i.test(new URL(location).pathname)) {
    throw new Error(`${given} is not a .user.js file or URL, so it can't be installed as a script`);
  }
  const collections = await ctx.manager.collections();
  const into = typeof flags['--collection'] === 'string' ? pickCollection(collections, flags['--collection']) : null;
  // A guarded one stops before it replaces the person's own script.
  const replace = !ctx.guarded || flags['--force'] === true;
  let result: ScriptInstall;
  try {
    result = await attempt(`install ${given}`, ctx.manager.installScript(location, into?.id ?? null, replace));
  } catch (err) {
    const refused = (err as Error).cause;
    if (!(refused instanceof ReplaceRefused)) throw err;
    forced(ctx, flags, refused.shown, 'replace it');
    return false;
  }
  const s = result.script;
  // The collection it went into, perhaps made just now.
  const holder = into ?? (await ctx.manager.collections()).find((c) => c.id === s.collectionId);
  if (ctx.json) {
    ctx.out(jsonResult('script install', {
      script: scriptJson(s, holder, ctx.run),
      ...enableEffectsJson(result, holder, collections, ctx.run),
      ...(result.already ? { already: true } : {}),
      ...(result.replaced ? { replaced: true } : {}),
    } satisfies J.ScriptInstallData));
    return true;
  }
  const where = holder ? ` in ${collectionShown(holder)}` : '';
  if (result.already) {
    ctx.out(`${scriptShown(s, ctx.run)} is already installed${where}`);
    return true;
  }
  ctx.out(`${result.replaced ? 'Replaced the script with the same name and namespace: ' : 'Installed '}${scriptShown(s, ctx.run)}${where}${s.enabled ? '' : ', disabled'}${s.status === 'invalid' ? ', but it is INVALID' : ''}`);
  if (s.error) ctx.out(`  ${s.error}`);
  for (const line of enableEffects(result, holder, collections, ctx.run)) ctx.out(`  ${line}`);
  return true;
}

// Whether an enabled script sits in a disabled collection, so it doesn't run.
function inDisabledCollection(s: ManagedScript, collection: ManagedCollection | undefined): collection is ManagedCollection {
  return s.enabled && collection !== undefined && !collection.enabled;
}

// What turning a script on did besides, one line each: its other copies
// it turned off, as the viewer does, and whether it runs at all.
function enableEffects(
  result: ScriptEnable, collection: ManagedCollection | undefined, collections: readonly ManagedCollection[], view: RunView | undefined,
): string[] {
  const lines = result.turnedOff.map((s) => {
    const label = scriptLabel(s, view);
    const shown = s.version !== undefined ? `Version ${s.version}${label !== undefined ? ` (${label})` : ''}` : scriptShown(s, view);
    const holder = collections.find((c) => c.id === s.collectionId);
    return `Another version of this script was disabled: ${shown}${holder ? ` in collection ${collectionShown(holder)}` : ''}`;
  });
  if (inDisabledCollection(result.script, collection)) {
    lines.push(`${scriptShown(result.script, view)} is enabled, but won't run because it's inside disabled collection ${collectionShown(collection)}`);
  }
  return lines;
}

function enableEffectsJson(
  result: ScriptEnable, collection: ManagedCollection | undefined, collections: readonly ManagedCollection[], view: RunView | undefined,
): Pick<J.ScriptChangeData, 'turnedOff' | 'collectionDisabled'> {
  return {
    ...(result.turnedOff.length > 0
      ? { turnedOff: result.turnedOff.map((s) => scriptJson(s, collections.find((c) => c.id === s.collectionId), view)) }
      : {}),
    ...(inDisabledCollection(result.script, collection) ? { collectionDisabled: true } : {}),
  };
}

// `2026-10-03 08:12`, in local time.
function shortTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function fileJson(f: ManagedFile): J.FileStatus {
  return {
    url: f.url,
    ...(f.loaded !== undefined ? { status: f.loaded ? 'ok' : 'not-loaded' } : {}),
    ...(f.local !== undefined ? { local: f.local } : {}),
  };
}

// `https://x/lib.js (ok)`, with its local stand-in. No status when the
// manager doesn't say.
function fileText(f: ManagedFile): string {
  const status = f.loaded === undefined ? undefined : f.loaded ? (f.local !== undefined ? `ok, read from ${f.local}` : 'ok') : 'not loaded';
  return `${f.name !== undefined ? `${f.name} ` : ''}${f.url}${status ? ` (${status})` : ''}`;
}

// `script show`: one script in full.
async function scriptShow(ctx: ManagerContext, picked: ManagedScript, collection: ManagedCollection | undefined): Promise<void> {
  const [details, disk] = await Promise.all([ctx.manager.scriptDetails(picked.id), ctx.manager.onDisk()]);
  if (!details) throw new Error(noSuchScript(scriptShown(picked, ctx.run)));
  const onDisk = disk?.scripts[details.id];
  const label = scriptLabel(details, ctx.run);
  const tabs = ctx.run ? await ctx.run.tabsOf(details, label) : [];
  if (ctx.json) {
    ctx.out(jsonResult('script show', {
      script: {
        ...scriptJson(details, collection, ctx.run, disk),
        ...(details.description !== undefined ? { description: details.description } : {}),
        ...(details.author !== undefined ? { author: details.author } : {}),
        ...(details.updatedAt !== undefined ? { updatedAt: new Date(details.updatedAt).toISOString() } : {}),
        matching: { match: details.match, include: details.include, exclude: details.exclude, excludeMatch: details.excludeMatch },
        runAt: details.runAt ?? 'document-idle',
        grants: details.grants,
        requires: details.requires.map(fileJson),
        resources: details.resources.map((f) => ({ ...fileJson(f), name: f.name ?? '' })),
        ...(ctx.run ? { tabs: tabs.map((t) => t.activity) } : {}),
        ...(details.valueCount !== undefined ? { valueCount: details.valueCount } : {}),
      },
    } satisfies J.ScriptShowData));
    return;
  }
  ctx.out(`${label !== undefined ? `${label}: ` : ''}${details.name}${details.version ? ` ${details.version}` : ''}`);
  const rows: [string, string | string[]][] = [];
  const add = (name: string, value: string | string[] | undefined): void => {
    if (value !== undefined && value.length > 0) rows.push([name, value]);
  };
  add('Namespace', details.namespace);
  add('Description', details.description);
  add('Author', details.author);
  add('Collection', collection ? collectionShown(collection) : undefined);
  add('Run', details.run !== undefined ? `A script of run ${details.run}` : details.leftBy !== undefined ? `Left by run ${details.leftBy}, which ended` : undefined);
  add('Location', details.loadedAs ?? details.location);
  add('Status', `${details.enabled ? 'Enabled' : 'Disabled'}, ${details.status === 'invalid' ? 'INVALID' : 'ok'}${onDisk ? `, ${onDisk} on disk` : ''}`);
  add('Error', details.error);
  add('Refresh', details.refreshError ? `The last refresh failed, so its last good copy runs: ${details.refreshError}` : undefined);
  add('Updated', details.updatedAt !== undefined ? shortTime(details.updatedAt) : undefined);
  add('@match', details.match);
  add('@include', details.include);
  add('@exclude', details.exclude);
  add('@exclude-match', details.excludeMatch);
  add('@run-at', details.runAt);
  add('@grant', details.grants.length > 0 ? details.grants.join(', ') : undefined);
  add('@require', details.requires.map(fileText));
  add('@resource', details.resources.map(fileText));
  if (ctx.run) add('Tabs', tabs.length > 0 ? tabs.map((t) => `${t.activity.tab}: ${t.text}`) : 'None open');
  if (details.valueCount !== undefined) {
    add('Values', details.valueCount === 0 ? 'None' : `${details.valueCount} stored${ctx.run && label !== undefined ? ` (values ${label} to see them)` : ''}`);
  }
  const width = Math.max(...rows.map(([name]) => name.length)) + 2;
  for (const [name, value] of rows) {
    const lines = typeof value === 'string' ? [value] : value;
    lines.forEach((line, i) => ctx.out(`  ${(i === 0 ? `${name}:` : '').padEnd(width)}${line}`));
  }
}
