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

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LISTED_BY_LOCATION, RUN_COLLECTION_LOCKED,
  type CollectionRefresh, type ManagedCollection, type ManagedFile, type ManagedFileContent, type ManagedOnDisk, type ManagedScript,
  type ManagedScriptDetails, type ScriptEnable, type ScriptInstall, type ScriptRefresh,
} from '../sm-dev-protocol.js';
import { pendingSummary } from '../script-display.js';
import {
  jsonResult, type Collection, type CollectionListData, type CollectionRef, type Script, type ScriptListData, type TabActivity,
} from './json-output.js';
import type * as J from './json-output.js';
import { commandSyntax, noSuchFlag } from './command-list.js';
import { errorSentence, writeProblem } from './input-file.js';
import { shownPath } from './prepare.js';
import {
  asError, cmd, code, err as errorLine, heading, id as idRole, MISTAKE_PREFIX, name as nameRole, plainLine, quoted, selected, SM_DEV_PREFIX, ui, url,
} from './output-style.js';

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
  /** A script's `@require` and `@resource` files as installed; null for no script. Absent when the manager doesn't give them. */
  scriptFiles?(id: string): Promise<ManagedFileContent[] | null>;
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
  script: ['list', 'show', 'print', 'save', 'enable', 'disable', 'refresh', 'install', 'uninstall', 'move'],
} as const;

/**
 * Said for a flag given to a verb of `command` that only another verb
 * takes (`script save --file`), since the flags are the command's; null
 * when there is none. Flags in no verb's usage (`--json`) go with every
 * verb.
 */
export function otherVerbsFlag(command: 'collection' | 'script', verb: string, flags: Record<string, string | true>): string | null {
  const usages = commandSyntax(command).usage;
  const flagsIn = (text: string): string[] => text.match(/--[\w-]+/g) ?? [];
  const own = new Set(usages.filter((u) => new RegExp(`^\\S+ (\\S+ )?${verb}(\\s|$)`).test(u)).flatMap(flagsIn));
  const verbs = new Set(usages.flatMap(flagsIn));
  const wrong = Object.keys(flags).find((f) => verbs.has(f) && !own.has(f));
  return wrong === undefined ? null : noSuchFlag(`${command} ${verb}`, wrong, [...own]);
}

/** Said for `collection <words>` with no verb it takes: `C3 frob`, or one word alone. */
export function noSuchVerb(words: readonly string[]): string {
  const verbs = MANAGER_VERBS.collection.join(', ');
  if (words.length === 1) return `The ${quoted('collection')} command needs a verb: ${quoted(`collection ${words[0]} <verb>`)}. It takes ${verbs}.`;
  return `The ${quoted('collection')} command has no ${quoted(words[1])} verb. It takes ${verbs}.`;
}

/** `collection list`: each collection, numbered ones first. */
export async function collectionList(manager: ManagerControl, out: (line: string) => void, json: boolean): Promise<void> {
  const [listed, disk] = await Promise.all([manager.collections(), manager.onDisk()]);
  const collections = sortedCollections(listed);
  if (json) {
    out(jsonResult('collection list', { collections: collections.map((c) => collectionJson(c, disk)) } satisfies CollectionListData));
    return;
  }
  out(ui`${heading(`Collections in ${manager.label}`)}:`);
  if (collections.length === 0) out('  None');
  for (const c of collections) {
    const notes = [count(c.scriptCount, 'script'), ...(c.enabled ? [] : ['disabled'])];
    out(ui`  ${collectionMarked(c)} (${c.kind}): ${notes.join(', ')}`);
    // Not when its name is its location, as a directory's is by default.
    if (c.location !== undefined && c.location !== c.name) out(ui`      ${url(c.location)}`);
    if (c.error) out(asError(`      Failed to load: ${c.error}`));
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
  const label = scriptLabel(s, view);
  const onDisk = disk?.scripts[s.id];
  const notes = [
    ...(s.enabled ? [] : ['disabled']),
    ...(onDisk ? [`${onDisk} on disk`] : []),
    // Under another manager, where a run's scripts are among the rest.
    ...(s.run !== undefined ? [`run ${s.run}'s${view?.own.has(s.id) ? ` script ${view.own.get(s.id)}` : ''}`] : []),
    ...(s.leftBy !== undefined ? [`left by run ${s.leftBy}, which ended`] : []),
  ];
  return ui`${isSelected(s, view) ? ui`${selected('*')} ` : '  '}${label !== undefined ? ui`${idRole(label)}: ` : ''}${nameRole(s.name)}${s.version ? ` ${s.version}` : ''}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}${s.status === 'invalid' ? ': INVALID' : ''}`;
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
    if (!found) throw new Error(`There is no collection ${quoted(`C${numbered[1]}`)}. Use ${quoted('collection list')} to list them.`);
    return found;
  }
  if (name.startsWith('id=')) {
    const found = collections.find((c) => c.id === name.slice(3));
    if (!found) throw new Error(`There is no collection with ${quoted(name)}. Use ${quoted('collection list')} to list them.`);
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
  if (found.length === 0) throw new Error(`No collection is named ${quoted(name)}. Use ${quoted('collection list')} to list them.`);
  const which = sortedCollections(found).map((c) => `${collectionLabel(c)} (${c.name})`).join(', ');
  throw new Error(`${quoted(name)} names more than one collection: ${which}. Name one by its number (${quoted('C1')}), or ${quoted('id=<id>')}.`);
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
    out(ui`${collectionMarked(c)}`);
    const these = byCollection.get(c.id)!;
    if (these.length === 0) out('  No scripts');
    for (const s of these) {
      out(scriptLine(s, view, disk));
      // A run's script by its path as the run was given it, rather than
      // its `scratch:` URL.
      const where = s.loadedAs ?? s.location;
      if (where) out(ui`      ${url(where)}`);
      if (s.error) out(`      ${s.error}`);
      if (s.refreshError) out(asError(`      Its last refresh failed: ${s.refreshError}`));
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
  'script install': 'a .user.js file or URL', 'script save': 'a directory to save into', 'script move': 'the collection to move it to', 'collection rename': 'the new name',
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
    if (!found) throw new Error(view ? none : `There is no script ${quoted(name)}: A number names one of a run's scripts, in that run. Name an installed script as ${quoted('E1')}.`);
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
  if (found.length === 0) throw new Error(`No script is named ${quoted(name)}. Use ${quoted('script list')} to list them.`);
  const which = found.map((s) => scriptShown(s, view)).join(', ');
  throw new Error(`${quoted(name)} names more than one script: ${which}. Name one by its number (${quoted('E1')}), or ${quoted('id=<id>')}.`);
}

/** Another manager won't replace the person's own script `shown` (`E3: Name`) without `replace`. */
export class ReplaceRefused extends Error {
  constructor(readonly shown: string) {
    super(`${shown} has the same name and namespace, and would be replaced`);
  }
}

/** Said for a script name that names none. */
export function noSuchScript(name: string): string {
  return `There is no script ${quoted(name)}. Use ${quoted('script list')} to list the installed scripts.`;
}

// The run's selected script, for a script verb given none.
function selectedScript(scripts: readonly ManagedScript[], view: RunView): ManagedScript {
  const selected = view.selected!;
  if ('label' in selected) return pickManagedScript(scripts, selected.label, view);
  const found = scripts.find((s) => s.id === selected.internalId);
  if (!found) throw new Error('The selected script is not installed. Name one: `script <script> <verb>`.');
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

// scriptShown and collectionShown marked up, for output lines (not errors).
function scriptMarked(s: ManagedScript, view: RunView | undefined): string {
  const label = scriptLabel(s, view);
  return label !== undefined ? ui`${idRole(label)}: ${nameRole(s.name)}` : nameRole(s.name);
}

function collectionMarked(c: ManagedCollection): string {
  return ui`${idRole(collectionLabel(c))}: ${nameRole(c.name)}`;
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
    ctx.out(`${MISTAKE_PREFIX}Name the collection before the verb: ${quoted(`collection ${args[0]} ${verb}${args.length > 1 ? ' ...' : ''}`)}`);
    return false;
  }
  if (verb !== 'install' && subject === undefined && !selectable) {
    // Named, not optional, in the usage shown: it is needed here.
    const named = usage?.replace(`${command} [${command}]`, `${command} <${command}>`);
    const why = command === 'script' && verb !== 'uninstall' ? ` There is no selected script ${ctx.run ? 'in this run' : 'outside a run'}.` : '';
    ctx.out(`${MISTAKE_PREFIX}The ${quoted(`${command} ${verb}`)} command needs ${command === 'script' ? 'a script' : 'a collection'}: ${quoted(named)}${why ? `.${why}` : ''}`);
    return false;
  }
  const need = NEEDS[`${command} ${verb}`];
  if (need && args.length === 0) {
    ctx.out(`${MISTAKE_PREFIX}The ${quoted(`${command} ${verb}`)} command needs ${need}: ${quoted(usage)}`);
    return false;
  }
  try {
    if (command === 'collection') return await collectionVerb(ctx, verb, subject!, args);
    return await scriptVerb(ctx, verb, subject, args, flags);
  } catch (err) {
    if (err instanceof MarkedFailure) {
      ctx.out(SM_DEV_PREFIX + err.lines[0]);
      for (const line of err.lines.slice(1)) ctx.out(line);
      return false;
    }
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
  ctx.out(`${MISTAKE_PREFIX}${what} is installed in ${ctx.manager.label} in this browser, so this would ${change} for real. Use ${quoted('--force')} to continue.`);
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
      changed(next, ui`${enabled ? 'Enabled' : 'Disabled'} ${collectionMarked(next)}`);
      return true;
    }
    case 'rename': {
      const next = await attempt(`rename ${shown}`, ctx.manager.renameCollection(picked.id, args.join(' ')));
      changed(next, ui`Renamed ${idRole(collectionLabel(next))} to ${nameRole(next.name)}`);
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
      ctx.out(ui`Refreshed ${collectionMarked(result.collection)}: ${notes.join(', ')}`);
      if (result.collection.error) ctx.out(asError(`  Failed to load: ${result.collection.error}`));
      for (const s of result.updated) {
        ctx.out(ui`  Updated ${scriptMarked(s, view)}${s.status === 'invalid' ? ': INVALID' : ''}`);
        if (s.error) ctx.out(`      ${s.error}`);
        if (s.refreshError) ctx.out(asError(`      Its last refresh failed: ${s.refreshError}`));
      }
      for (const s of result.removed) ctx.out(ui`  Removed ${scriptMarked(s, view)}`);
      for (const s of failed) ctx.out(asError(ui`  Failed to refresh ${scriptMarked(s, view)}: ${s.refreshError ?? ''}`));
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
  ctx.out(collectionMarked(picked));
  // Values are markup.
  const rows: [string, string][] = [
    ['Kind', picked.kind],
    ...(picked.location !== undefined ? [['Location', url(picked.location)] as [string, string]] : []),
    ...(picked.run !== undefined ? [['Run', ui`The test collection of run ${idRole(runOfLinkId(picked.run))}`] as [string, string]] : []),
    ['Status', `${picked.enabled ? 'Enabled' : 'Disabled'}${picked.error ? `, failed to load: ${picked.error}` : ''}`],
    ...(disk?.collections[picked.id] ? [['On disk', `${pendingSummary(disk.collections[picked.id])}, not loaded yet`] as [string, string]] : []),
    ['Scripts', scripts.length === 0 ? 'None' : count(scripts.length, 'script')],
  ];
  for (const [name, value] of rows) ctx.out(ui`  ${heading(name)}:${' '.repeat(Math.max(0, 11 - name.length))}${value}`);
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
    case 'print':
      return scriptPrint(ctx, picked, flags);
    case 'save':
      return scriptSave(ctx, picked, args[0], flags);
    case 'enable':
    case 'disable': {
      const enabled = verb === 'enable';
      if (othersRun !== undefined) throw new Error(`${shown} is a script of run ${othersRun}, which only that run changes`);
      const next = await attempt(`${verb} ${shown}`, ctx.manager.setScriptEnabled(picked.id, enabled));
      enableChanged(next, ui`${enabled ? 'Enabled' : 'Disabled'} ${scriptMarked(next.script, view)}`);
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
      ctx.out(ui`Refreshed ${scriptMarked(s, view)}: ${result.updated ? 'updated' : 'no change'}${s.status === 'invalid' ? ', and it is INVALID' : ''}`);
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
      changed(was, ui`Uninstalled ${scriptMarked(was, view)}${collection ? ui` from ${collectionMarked(collection)}` : ''}`, { removed: true });
      return true;
    }
    case 'move': {
      if (own) throw new Error(`${shown} is one of this run's own scripts, which stay in its test collection`);
      const target = pickCollection(collections, args[0]);
      if (target.id === picked.collectionId) throw new Error(`${shown} is already in ${collectionShown(target)}`);
      const moved = await attempt(`move ${shown} to ${collectionShown(target)}`, ctx.manager.moveScript(picked.id, target.id));
      enableChanged(moved, ui`Moved ${scriptMarked(moved.script, view)} to ${collectionMarked(target)}`);
      return true;
    }
  }
  return false;
}

// ---------- Printing and saving a script's files ----------

/**
 * A failure said as lines of markup: the first after `[sm-dev] `, the
 * rest as they are. Its message is the same as plain text.
 */
class MarkedFailure extends Error {
  constructor(readonly lines: string[]) {
    super(lines.map(plainLine).join('\n'));
  }
}

// Said when the manager doesn't give sm-dev the files.
function noFilesUnder(label: string): string {
  return `${label} doesn't give sm-dev its scripts' @require and @resource files, so only the script itself can be printed or saved`;
}

// The script's `@require` and `@resource` files as installed.
async function filesOf(ctx: ManagerContext, script: ManagedScript): Promise<ManagedFileContent[]> {
  if (!ctx.manager.scriptFiles) throw new Error(noFilesUnder(ctx.manager.label));
  const files = await ctx.manager.scriptFiles(script.id);
  if (files === null) throw new Error(noSuchScript(scriptShown(script, ctx.run)));
  return files;
}

// The installed text.
async function textOf(ctx: ManagerContext, script: ManagedScript): Promise<string> {
  const text = await ctx.manager.scriptText(script.id);
  if (text === null) throw new Error(noSuchScript(scriptShown(script, ctx.run)));
  return text;
}

// A file's URL as shown: a `data:` URL by its type alone, since it
// holds the whole file.
function fileUrlShown(f: ManagedFileContent): string {
  return f.url.startsWith('data:') ? `${f.url.split(',')[0]},...` : f.url;
}

// `@resource icon https://x/icon.png`, `@require https://x/lib.js`, marked up.
function fileMarked(f: ManagedFileContent): string {
  return ui`@${f.kind} ${f.name !== undefined ? ui`${code(f.name)} ` : ''}${url(fileUrlShown(f))}`;
}

/**
 * The file of `files` that `name` names: a `@resource`'s name, exactly,
 * or a part of its URL only it has; or `script` for the script itself.
 * For none or several, throws a failure listing them. `shown`: the
 * script, marked up.
 */
export function pickScriptFile(files: readonly ManagedFileContent[], name: string, shown: string): ManagedFileContent | 'script' {
  const named = files.filter((f) => f.name === name);
  if (named.length === 1) return named[0];
  if (name === 'script') return 'script';
  const lower = name.toLowerCase();
  const found = files.filter((f) => f.url.toLowerCase().includes(lower));
  if (found.length === 1) return found[0];
  if (files.length === 0) throw new MarkedFailure([ui`${shown} has no @require or @resource files`]);
  const listed = (these: readonly ManagedFileContent[]): string[] => these.map((f) => ui`  ${fileMarked(f)}`);
  if (found.length === 0) throw new MarkedFailure([ui`No file of ${shown} matches ${cmd(name)}. Its files:`, ...listed(files)]);
  throw new MarkedFailure([ui`The name ${cmd(name)} matches multiple files of ${shown}. Give more of the URL, or a @resource's name:`, ...listed(found)]);
}

// Bytes as text, or null for bytes that aren't text: not UTF-8, or with a NUL.
function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Why a file or directory couldn't be written.
function writeFailure(err: unknown): string {
  return writeProblem(err) ?? errorSentence(err);
}

// Does `work`, which writes `shown`, saying which and why when it can't.
async function writing(shown: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    throw new MarkedFailure([ui`Could not write ${url(shown)}: ${writeFailure(err)}`]);
  }
}

// `script [script] print [--file <name>] [--out <file>]`.
async function scriptPrint(ctx: ManagerContext, script: ManagedScript, flags: Record<string, string | true>): Promise<boolean> {
  const view = ctx.run;
  const which = typeof flags['--file'] === 'string' ? pickScriptFile(await filesOf(ctx, script), flags['--file'], scriptMarked(script, view)) : 'script';
  const file = which === 'script' ? undefined : which;
  const bytes = file ? Buffer.from(file.base64, 'base64') : Buffer.from(await textOf(ctx, script));
  const id = scriptLabel(script, view);
  const about = {
    ...(id !== undefined ? { script: id } : {}),
    name: script.name,
    ...(file ? { file: { kind: file.kind, url: file.url, ...(file.name !== undefined ? { name: file.name } : {}) } } : {}),
  };
  const outFile = flags['--out'];
  if (typeof outFile === 'string') {
    const target = path.resolve(ctx.cwd, outFile);
    const shown = shownPath(target, ctx.cwd);
    await writing(shown, () => writeFile(target, bytes));
    if (ctx.json) ctx.out(jsonResult('script print', { ...about, out: target } satisfies J.ScriptPrintData));
    else ctx.out(ui`Wrote ${url(shown)} (${count(bytes.length, 'byte')})`);
    return true;
  }
  const text = asText(bytes);
  if (text === null) {
    throw new MarkedFailure([
      ui`${fileMarked(file!)} is not text${file!.contentType ? ` (${file!.contentType})` : ''}, so it can't be printed. Use ${cmd('--out <file>')} to write it to a file.`,
    ]);
  }
  if (ctx.json) ctx.out(jsonResult('script print', { ...about, text } satisfies J.ScriptPrintData));
  else for (const line of text.replace(/\n$/, '').split('\n')) ctx.out(line);
  return true;
}

/** What `script save --only` takes. */
const SAVE_PARTS = ['script', 'requires', 'resources'] as const;
type SavePart = typeof SAVE_PARTS[number];

// The file name a saved script takes: its own, when that's a
// `.user.js`, else its name made one.
function scriptFileName(s: ManagedScript): string {
  const where = s.loadedAs ?? s.location ?? '';
  let last = where.split(/[?#]/)[0].split(/[\\/]/).pop() ?? '';
  try {
    last = decodeURIComponent(last);
  } catch {
    // Kept as written.
  }
  if (/\.user\.js$/i.test(last) && !/[\\/:*?"<>|]/.test(last)) return last;
  return `${s.name.replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
}

// A `file:` dependency's path from the script's own folder, as a
// relative `@require` names it (`lib/util.js`), so a saved copy finds
// it there too. Undefined for one outside that folder. A run's script
// by the file it was read from.
function besideScript(fileUrl: string, script: ManagedScript): string | undefined {
  const own = script.sourceFile ?? script.location;
  if (!own?.startsWith('file:')) return undefined;
  const folder = own.slice(0, own.lastIndexOf('/') + 1);
  if (!fileUrl.startsWith(folder)) return undefined;
  try {
    return decodeURIComponent(fileUrl.slice(folder.length));
  } catch {
    return undefined;
  }
}

// One file `script save` writes.
interface SavedFile {
  kind: 'script' | 'require' | 'resource';
  url?: string;
  name?: string;
  /** Relative to the directory, with `/`. */
  path: string;
  bytes: Buffer;
}

// `script [script] save <dir> [--only <parts>] [--flat] [--force]`.
async function scriptSave(ctx: ManagerContext, script: ManagedScript, dirGiven: string, flags: Record<string, string | true>): Promise<boolean> {
  const view = ctx.run;
  const shown = scriptMarked(script, view);
  let parts: Set<SavePart> = new Set(SAVE_PARTS);
  if (typeof flags['--only'] === 'string') {
    const given = flags['--only'].split(',').map((p) => p.trim()).filter(Boolean);
    const unknown = given.find((p) => !(SAVE_PARTS as readonly string[]).includes(p));
    if (unknown !== undefined || given.length === 0) {
      ctx.out(`${MISTAKE_PREFIX}The ${quoted('--only')} flag takes ${SAVE_PARTS.map((p) => quoted(p)).join(', ')}, comma-separated${unknown !== undefined ? `, and not ${quoted(unknown)}` : ''}`);
      return false;
    }
    parts = new Set(given as SavePart[]);
  }
  const flat = flags['--flat'] === true;
  const dir = path.resolve(ctx.cwd, dirGiven);
  const files: SavedFile[] = [];
  // What wasn't saved and why: plain for JSON, and marked up.
  const notes: { plain: string; marked: string }[] = [];
  const note = (marked: string): void => {
    notes.push({ plain: plainLine(marked), marked });
  };
  if (parts.has('script')) files.push({ kind: 'script', path: scriptFileName(script), bytes: Buffer.from(await textOf(ctx, script)) });
  if (parts.has('requires') || parts.has('resources')) {
    // Without `--only`, under a manager that doesn't give them, the script alone.
    if (!ctx.manager.scriptFiles && typeof flags['--only'] !== 'string') note(ui`${noFilesUnder(ctx.manager.label)}`);
    else {
      for (const f of await filesOf(ctx, script)) {
        if (!parts.has(`${f.kind}s` as SavePart)) continue;
        const kept = f.url.startsWith('file:') ? besideScript(f.url, script) ?? f.path : f.path;
        const where = kept === undefined ? undefined : flat ? path.posix.basename(kept) : kept;
        // Not one that would land outside the directory.
        if (where === undefined || !path.resolve(dir, where).startsWith(dir + path.sep)) {
          note(ui`Skipped ${fileMarked(f)}: It has no file name to save it as`);
          continue;
        }
        files.push({ kind: f.kind, url: f.url, ...(f.name !== undefined ? { name: f.name } : {}), path: where, bytes: Buffer.from(f.base64, 'base64') });
      }
    }
  }
  // One URL declared twice writes one file; two files with one name can't be.
  const byPath = new Map<string, SavedFile>();
  const clashes: string[] = [];
  for (const f of files) {
    const same = byPath.get(f.path);
    if (!same) byPath.set(f.path, f);
    else if (!same.bytes.equals(f.bytes)) clashes.push(f.path);
  }
  const shownFile = (relative: string): string => shownPath(path.join(dir, relative), ctx.cwd);
  if (clashes.length > 0) {
    throw new MarkedFailure([
      ui`Multiple files of ${shown} would be saved under the same name${flat ? ui`. Leave out ${cmd('--flat')} to save them in folders by URL` : ''}:`,
      ...[...new Set(clashes)].map((p) => ui`  ${url(shownFile(p))}`),
    ]);
  }
  const saving = [...byPath.values()];
  if (saving.length === 0) {
    const what = [...parts].map((p) => `@${p.slice(0, -1)}`).join(' or ');
    throw new MarkedFailure([ui`${shown} has no ${what} files to save`, ...notes.map((n) => ui`  ${n.marked}`)]);
  }
  const existing = saving.filter((f) => existsSync(path.join(dir, f.path)));
  if (existing.length > 0 && flags['--force'] !== true) {
    ctx.out(MISTAKE_PREFIX + errorLine(ui`These files already exist. Use ${cmd('--force')} to replace them:`));
    for (const f of existing) ctx.out(ui`  ${url(shownFile(f.path))}`);
    return false;
  }
  const dirShown = shownPath(dir, ctx.cwd);
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new MarkedFailure([ui`Could not create the directory ${url(dirShown)}: ${writeFailure(error)}`]);
  }
  for (const f of saving) {
    const target = path.join(dir, f.path);
    await writing(shownFile(f.path), async () => {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.bytes);
    });
  }
  const id = scriptLabel(script, view);
  if (ctx.json) {
    ctx.out(jsonResult('script save', {
      ...(id !== undefined ? { script: id } : {}),
      name: script.name,
      dir,
      files: saving.map((f) => ({
        kind: f.kind, ...(f.url !== undefined ? { url: f.url } : {}), ...(f.name !== undefined ? { name: f.name } : {}), path: path.join(dir, f.path),
      })),
      ...(notes.length > 0 ? { notes: notes.map((n) => n.plain) } : {}),
    } satisfies J.ScriptSaveData));
    return true;
  }
  ctx.out(ui`Saved ${shown} to ${url(dirShown)}: ${count(saving.length, 'file')}`);
  for (const f of saving) ctx.out(ui`  ${url(shownFile(f.path))}`);
  for (const n of notes) ctx.out(ui`  ${n.marked}`);
  return true;
}

// `script install <file|url>`: a path is the sender's, made a `file://` URL.
async function scriptInstall(ctx: ManagerContext, given: string, flags: Record<string, string | true>): Promise<boolean> {
  const location = /^[a-z][a-z0-9+.-]*:/i.test(given) && !/^[a-z]:[\\/]/i.test(given)
    ? given
    : pathToFileURL(path.resolve(ctx.cwd, given)).href;
  if (!/\.user\.js$/i.test(new URL(location).pathname)) {
    throw new Error(`${quoted(given)} is not a .user.js file or URL, so it can't be installed as a script`);
  }
  const collections = await ctx.manager.collections();
  const into = typeof flags['--collection'] === 'string' ? pickCollection(collections, flags['--collection']) : null;
  // A guarded one stops before it replaces the person's own script.
  const replace = !ctx.guarded || flags['--force'] === true;
  let result: ScriptInstall;
  try {
    result = await attempt(`install ${quoted(given)}`, ctx.manager.installScript(location, into?.id ?? null, replace));
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
  const where = holder ? ui` in ${collectionMarked(holder)}` : '';
  if (result.already) {
    ctx.out(ui`${scriptMarked(s, ctx.run)} is already installed${where}`);
    return true;
  }
  ctx.out(ui`${result.replaced ? 'Replaced the script with the same name and namespace: ' : 'Installed '}${scriptMarked(s, ctx.run)}${where}${s.enabled ? '' : ', disabled'}${s.status === 'invalid' ? ', but it is INVALID' : ''}`);
  if (s.error) ctx.out(`  ${s.error}`);
  for (const line of enableEffects(result, holder, collections, ctx.run)) ctx.out(`  ${line}`);
  return true;
}

// Whether an enabled script sits in a disabled collection, so it doesn't run.
function inDisabledCollection(s: ManagedScript, collection: ManagedCollection | undefined): collection is ManagedCollection {
  return s.enabled && collection !== undefined && !collection.enabled;
}

// What turning a script on did besides, one line each, marked up for
// output: its other copies it turned off, as the viewer does, and
// whether it runs at all.
function enableEffects(
  result: ScriptEnable, collection: ManagedCollection | undefined, collections: readonly ManagedCollection[], view: RunView | undefined,
): string[] {
  const lines = result.turnedOff.map((s) => {
    const label = scriptLabel(s, view);
    const shown = s.version !== undefined ? ui`Version ${s.version}${label !== undefined ? ui` (${idRole(label)})` : ''}` : scriptMarked(s, view);
    const holder = collections.find((c) => c.id === s.collectionId);
    return ui`Another version of this script was disabled: ${shown}${holder ? ui` in collection ${collectionMarked(holder)}` : ''}`;
  });
  if (inDisabledCollection(result.script, collection)) {
    lines.push(ui`${scriptMarked(result.script, view)} is enabled, but won't run because it's inside disabled collection ${collectionMarked(collection)}`);
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

// `https://x/lib.js (ok)`, with its local stand-in, marked up. No
// status when the manager doesn't say.
function fileText(f: ManagedFile): string {
  const status = f.loaded === undefined ? undefined : f.loaded ? (f.local !== undefined ? ui`ok, read from ${url(f.local)}` : 'ok') : 'not loaded';
  return ui`${f.name !== undefined ? ui`${code(f.name)} ` : ''}${url(f.url)}${status ? ui` (${status})` : ''}`;
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
  ctx.out(ui`${scriptMarked(details, ctx.run)}${details.version ? ` ${details.version}` : ''}`);
  // Values are markup.
  const rows: [string, string | string[]][] = [];
  const add = (name: string, value: string | string[] | undefined): void => {
    if (value !== undefined && value.length > 0) rows.push([name, value]);
  };
  // Plain text, escaped as markup; none when empty, as `add` skips.
  const plain = (text: string | undefined): string | undefined => (text ? ui`${text}` : undefined);
  const codes = (values: string[]): string[] => values.map((v) => code(v));
  add('Namespace', plain(details.namespace));
  add('Description', plain(details.description));
  add('Author', plain(details.author));
  add('Collection', collection ? collectionMarked(collection) : undefined);
  add('Run', details.run !== undefined ? ui`A script of run ${idRole(details.run)}` : details.leftBy !== undefined ? ui`Left by run ${idRole(details.leftBy)}, which ended` : undefined);
  const location = details.loadedAs ?? details.location;
  add('Location', location ? url(location) : undefined);
  add('Status', plain(`${details.enabled ? 'Enabled' : 'Disabled'}, ${details.status === 'invalid' ? 'INVALID' : 'ok'}${onDisk ? `, ${onDisk} on disk` : ''}`));
  add('Error', details.error ? asError(details.error) : undefined);
  add('Refresh', details.refreshError ? asError(`The last refresh failed, so its last good copy runs: ${details.refreshError}`) : undefined);
  add('Updated', details.updatedAt !== undefined ? plain(shortTime(details.updatedAt)) : undefined);
  add('@match', codes(details.match));
  add('@include', codes(details.include));
  add('@exclude', codes(details.exclude));
  add('@exclude-match', codes(details.excludeMatch));
  add('@run-at', details.runAt ? code(details.runAt) : undefined);
  add('@grant', details.grants.length > 0 ? details.grants.map((g) => code(g)).join(', ') : undefined);
  add('@require', details.requires.map(fileText));
  add('@resource', details.resources.map(fileText));
  if (ctx.run) add('Tabs', tabs.length > 0 ? tabs.map((t) => ui`${idRole(t.activity.tab)}: ${t.text}`) : 'None open');
  if (details.valueCount !== undefined) {
    add('Values', details.valueCount === 0 ? 'None' : ui`${details.valueCount} stored${ctx.run && label !== undefined ? ui` (${cmd(`values ${label}`)} to see them)` : ''}`);
  }
  const width = Math.max(...rows.map(([name]) => name.length)) + 2;
  for (const [name, value] of rows) {
    const lines = typeof value === 'string' ? [value] : value;
    lines.forEach((line, i) => ctx.out(ui`  ${i === 0 ? ui`${heading(name)}:` : ''}${' '.repeat(Math.max(0, width - (i === 0 ? name.length + 1 : 0)))}${line}`));
  }
}
