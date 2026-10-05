// sm-dev's `collection` and `script` commands, and a run's scripts,
// under a manager other than SourceMonkey: Violentmonkey now, and
// Tampermonkey later, behind `ExternalManager`. See
// docs/sm-dev-external-managers.md.
//
// - The manager has no collections, so one stands for all its scripts:
//   `C0`, a number SourceMonkey never gives.
// - sm-dev marks what it installs with a comment as the script's last
//   line (script-mark.ts): the file it came from, and for a run's
//   script, the run. That's how a run's scripts are told from the
//   person's own.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  CollectionRefresh, ManagedCollection, ManagedScript, ManagedScriptDetails, ScriptEnable, ScriptInstall, ScriptRefresh,
} from '../sm-dev-protocol.js';
import { getValue, parseHeader } from '../userscript-header.js';
import type { ConsoleContext, OtherScript } from './console-commands.js';
import { ReplaceRefused, type ManagerControl } from './manager-commands.js';
import type { ManagerName } from './managers.js';
import { explainMatch, prepareScript, type PreparedScript } from './prepare.js';
import { liveRuns } from './runs.js';
import { markedText, readMark, sameScript, withoutMark, type ScriptMark } from './script-mark.js';

/** One installed script, as sm-dev reads it from the manager. */
export interface ExternalScript {
  /** The manager's own number for it, sm-dev's E-id. */
  id: number;
  name: string;
  namespace?: string;
  version?: string;
  description?: string;
  author?: string;
  enabled: boolean;
  match: string[];
  include: string[];
  exclude: string[];
  excludeMatch: string[];
  runAt?: string;
  grants: string[];
  requires: string[];
  resources: { name: string; url: string }[];
  /** The URL it was installed from, when the manager keeps one. */
  installUrl?: string;
  /** When its text last changed, in epoch ms. */
  updatedAt?: number;
}

/** The contents of a script's `@require` and `@resource` files, by URL, handed over so the manager needn't fetch them. */
export interface InstallFiles {
  requires: Record<string, string>;
  resources: Record<string, { contentType: string; base64: string }>;
}

export interface InstallOptions {
  /** The script to replace. */
  id?: number;
  /** Where it's installed from, which its relative `@require`s resolve against. */
  url?: string;
  files?: InstallFiles;
  /** Read from a local file, which the manager can't check for updates. */
  local?: boolean;
}

/** What sm-dev needs of a manager. */
export interface ExternalManager {
  readonly name: ManagerName;
  readonly label: string;
  readonly version: string;
  readonly extensionId: string;
  scripts(): Promise<ExternalScript[]>;
  /** Each script's text as installed, by id. */
  texts(ids: number[]): Promise<Map<number, string>>;
  /** Installs `code`, or replaces script `id`, or else the one with the same name and namespace. */
  install(code: string, options?: InstallOptions): Promise<{ id: number; isNew: boolean }>;
  setEnabled(id: number, enabled: boolean): Promise<void>;
  /** Uninstalls a script so that it can be restored, as the manager's own page does. */
  uninstall(id: number): Promise<void>;
  /** Removes scripts for good. */
  remove(ids: number[]): Promise<void>;
  /** The manager's own switch for all its scripts. */
  applied(): Promise<boolean>;
  setApplied(on: boolean): Promise<void>;
  /** Lets scripts run on `file://` pages. True when that changed a setting. */
  allowFilePages(): Promise<boolean>;
  /** The script a stack frame's URL is the code of. */
  scriptIdOf(url: string): number | undefined;
  /** What every URL the manager runs code under starts with. */
  readonly scriptUrlPrefix: string;
  close(): Promise<void>;
}

/** The internal id of `C0`, the collection standing for all the manager's scripts. */
const ALL = 'all';

/** A script with what sm-dev's comment on it says. */
interface Listed {
  script: ExternalScript;
  mark: ScriptMark | null;
  /** A run's script whose run is live: the run's id. */
  liveRun?: string;
}

// Whether a run's mark is from a run that's still going.
async function liveMarks(): Promise<(mark: ScriptMark) => boolean> {
  const runs = await liveRuns().catch(() => []);
  return (mark) => mark.run !== undefined && runs.some((r) => r.id === mark.run && new Date(r.started).toISOString() === mark.started);
}

async function listAll(manager: ExternalManager): Promise<Listed[]> {
  const scripts = await manager.scripts();
  const [texts, live] = await Promise.all([manager.texts(scripts.map((s) => s.id)), liveMarks()]);
  return scripts.map((script) => {
    const text = texts.get(script.id);
    const mark = text === undefined ? null : readMark(text);
    return { script, mark, ...(mark && live(mark) ? { liveRun: mark.run } : {}) };
  });
}

// Where a script came from: the file in sm-dev's comment, or the URL the
// manager keeps, a local file's (see LOCAL_BASE) as that file.
function sourceOf(listed: Listed): string | undefined {
  if (listed.mark?.file) return pathToFileURL(listed.mark.file).href;
  const url = listed.script.installUrl;
  return url?.startsWith(`${LOCAL_BASE}/`) ? `file://${url.slice(LOCAL_BASE.length)}` : url;
}

function managedOf(listed: Listed): ManagedScript {
  const { script, mark } = listed;
  return {
    id: String(script.id),
    number: script.id,
    name: script.name,
    ...(script.namespace !== undefined ? { namespace: script.namespace } : {}),
    ...(script.version !== undefined ? { version: script.version } : {}),
    location: sourceOf(listed) ?? '',
    ...(mark?.file ? { loadedAs: mark.file } : {}),
    collectionId: ALL,
    enabled: script.enabled,
    status: 'ok',
    ...(listed.liveRun !== undefined ? { run: listed.liveRun } : mark?.run !== undefined ? { leftBy: mark.run } : {}),
  };
}

function detailsOf(listed: Listed): ManagedScriptDetails {
  const { script } = listed;
  return {
    ...managedOf(listed),
    ...(script.description !== undefined ? { description: script.description } : {}),
    ...(script.author !== undefined ? { author: script.author } : {}),
    ...(script.updatedAt !== undefined ? { updatedAt: script.updatedAt } : {}),
    match: script.match,
    include: script.include,
    exclude: script.exclude,
    excludeMatch: script.excludeMatch,
    ...(script.runAt !== undefined ? { runAt: script.runAt } : {}),
    grants: script.grants,
    // The manager doesn't say whether each one loaded.
    requires: script.requires.map((url) => ({ url })),
    resources: script.resources.map(({ name, url }) => ({ name, url })),
  };
}

/** A script's text and its files, read from a `file://` or http(s) URL, as it would be installed. */
interface Read {
  text: string;
  files?: InstallFiles;
}

// Where a local file is said to be installed from. A manager resolves
// a script's relative `@require` and `@resource` against its install
// URL, but refuses `file://` ones (Violentmonkey's default
// `blacklistNet`), so a local script's is under `sm-dev.invalid`, a
// name that never resolves, with each file's contents handed over.
const LOCAL_BASE = 'https://sm-dev.invalid';

/** The URL a local file is installed from (see LOCAL_BASE). */
export function installUrlOf(fileUrl: string): string {
  return fileUrl.startsWith('file:') ? `${LOCAL_BASE}${new URL(fileUrl).pathname}` : fileUrl;
}

/** The files a prepared script read, for the manager, by the URLs it resolves them to. */
export function installFiles(prepared: PreparedScript): InstallFiles {
  const requires: InstallFiles['requires'] = {};
  const resources: InstallFiles['resources'] = {};
  for (const r of prepared.script.requires ?? []) requires[installUrlOf(r.url)] = r.source;
  for (const r of prepared.script.resources ?? []) resources[installUrlOf(r.url)] = { contentType: r.contentType ?? '', base64: r.bytesBase64 };
  return { requires, resources };
}

// Reads a script to install: a file with its local `@require` and
// `@resource` files, or a URL, whose files the manager fetches itself.
async function readSource(location: string): Promise<Read> {
  if (location.startsWith('file:')) {
    const file = fileURLToPath(location);
    const prepared = await prepareScript({ file, collectionRoot: path.dirname(file), localRoots: [] });
    if (prepared.status !== 'ok') throw new Error(prepared.diagnostic ?? prepared.errorMessage ?? 'The script is not valid');
    return { text: await readFile(file, 'utf8'), files: installFiles(prepared) };
  }
  let res: Response;
  try {
    res = await fetch(location, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new Error(`It could not be downloaded: ${(err as Error).message}`, { cause: err });
  }
  if (!res.ok) throw new Error(`It could not be downloaded: HTTP ${res.status}`);
  return { text: await res.text() };
}

// How a script read from `location` is installed: a local one with its
// files, and no update checks, since the manager can't fetch it.
function installOptions(location: string, read: Read, id?: number): InstallOptions {
  return {
    ...(id !== undefined ? { id } : {}),
    url: installUrlOf(location),
    ...(read.files ? { files: read.files } : {}),
    ...(location.startsWith('file:') ? { local: true } : {}),
  };
}

// The name and namespace a script's header gives, which the manager
// tells scripts apart by.
function identityOf(text: string): { name: string; namespace: string } {
  const header = parseHeader(text);
  const name = header ? getValue(header, 'name') : undefined;
  if (!header || !name) throw new Error('It has no @name in a ==UserScript== header');
  return { name, namespace: getValue(header, 'namespace') ?? '' };
}

function sameIdentity(script: ExternalScript, id: { name: string; namespace: string }): boolean {
  return script.name === id.name && (script.namespace ?? '') === id.namespace;
}

/** `E3: Name`. */
function shown(script: ExternalScript): string {
  return `E${script.id}: ${script.name}`;
}

/** The `collection` and `script` commands' calls, made of the manager's. */
export function externalControl(manager: ExternalManager): ManagerControl {
  const { label } = manager;
  const find = async (id: string): Promise<Listed> => {
    const found = (await listAll(manager)).find((l) => String(l.script.id) === id);
    if (!found) throw new Error(`There is no script E${id}. Use script list to list the installed scripts.`);
    return found;
  };
  const collection = async (scripts?: number): Promise<ManagedCollection> => ({
    id: ALL,
    number: 0,
    name: label,
    kind: 'container',
    enabled: await manager.applied(),
    scriptCount: scripts ?? (await manager.scripts()).length,
  });
  // Re-reads one script from where it came from, and installs it in
  // place when its text changed. Its comment is kept.
  const refresh = async (listed: Listed): Promise<boolean> => {
    const source = sourceOf(listed);
    if (!source) throw new Error(`${shown(listed.script)} has no file or URL to refresh from`);
    const read = await readSource(source);
    const before = (await manager.texts([listed.script.id])).get(listed.script.id) ?? '';
    if (sameScript(before, read.text)) return false;
    await manager.install(listed.mark ? markedText(read.text, listed.mark) : read.text, installOptions(source, read, listed.script.id));
    return true;
  };
  return {
    label,
    collections: async () => [await collection()],
    scripts: async () => (await listAll(manager)).map(managedOf),
    onDisk: async () => null,
    setScriptEnabled: async (id, enabled): Promise<ScriptEnable> => {
      await manager.setEnabled(Number(id), enabled);
      return { script: managedOf(await find(id)), turnedOff: [] };
    },
    setCollectionEnabled: async (_id, enabled) => {
      await manager.setApplied(enabled);
      return collection();
    },
    refreshScript: async (id): Promise<ScriptRefresh> => {
      const updated = await refresh(await find(id));
      return { script: managedOf(await find(id)), updated };
    },
    refreshCollection: async (): Promise<CollectionRefresh> => {
      const all = await listAll(manager);
      const updated: number[] = [];
      let unchanged = 0;
      // Not a live run's scripts, which only their run changes; nor
      // those with nowhere to read from.
      for (const listed of all) {
        if (listed.liveRun !== undefined || !sourceOf(listed)) {
          unchanged++;
          continue;
        }
        if (await refresh(listed)) updated.push(listed.script.id);
        else unchanged++;
      }
      const after = await listAll(manager);
      return {
        collection: await collection(after.length),
        updated: after.filter((l) => updated.includes(l.script.id)).map(managedOf),
        unchanged,
        removed: [],
      };
    },
    installScript: async (location, _collection, replace = false): Promise<ScriptInstall> => {
      const read = await readSource(location);
      const identity = identityOf(read.text);
      const all = await listAll(manager);
      const existing = all.find((l) => sameIdentity(l.script, identity));
      if (existing?.liveRun !== undefined) {
        throw new Error(`${shown(existing.script)} has the same name and namespace, and is a script of run ${existing.liveRun}, which only that run changes`);
      }
      const file = location.startsWith('file:') ? fileURLToPath(location) : undefined;
      if (existing && sameScript((await manager.texts([existing.script.id])).get(existing.script.id) ?? '', read.text)) {
        return { script: managedOf(existing), turnedOff: [], already: true };
      }
      // The person's own, or one sm-dev installed to stay; not one an
      // ended run left.
      if (existing && !existing.mark?.run && !replace) throw new ReplaceRefused(shown(existing.script));
      const code = file ? markedText(read.text, { file }) : read.text;
      const { id } = await manager.install(code, installOptions(location, read));
      return { script: managedOf(await find(String(id))), turnedOff: [], ...(existing ? { replaced: true } : {}) };
    },
    uninstallScript: async (id) => {
      const listed = await find(id);
      await manager.uninstall(listed.script.id);
      return managedOf(listed);
    },
    moveScript: async () => {
      throw new Error(`${label} has one collection, C0, which holds all its scripts`);
    },
    renameCollection: async () => {
      throw new Error(`C0 stands for all of ${label}'s scripts, so it has no name of its own to change`);
    },
    scriptDetails: async (id) => detailsOf(await find(id)),
    scriptText: async (id) => {
      const text = (await manager.texts([Number(id)])).get(Number(id));
      return text === undefined ? null : withoutMark(text);
    },
  };
}

/**
 * A run's scripts in the manager: installed marked as the run's, and
 * removed when it ends. Scripts that aren't the run's are never
 * replaced.
 */
export class ExternalRunScripts {
  /** The manager's id for each of the run's scripts, by the file it came from. */
  private readonly ids = new Map<string, number>();

  constructor(
    private readonly manager: ExternalManager,
    private readonly run: { id: string; started: string },
  ) {}

  private isOwn(mark: ScriptMark | null): boolean {
    return mark?.run === this.run.id && mark.started === this.run.started;
  }

  /**
   * Removes the scripts runs that have ended left behind (ones that
   * crashed), returning a line saying so for each such run.
   */
  async removeLeftovers(): Promise<string[]> {
    const all = await listAll(this.manager);
    const left = all.filter((l) => l.mark?.run !== undefined && l.liveRun === undefined && !this.isOwn(l.mark));
    if (left.length === 0) return [];
    await this.manager.remove(left.map((l) => l.script.id));
    const byRun = new Map<string, Listed[]>();
    for (const l of left) byRun.set(l.mark!.run!, [...byRun.get(l.mark!.run!) ?? [], l]);
    return [...byRun].map(([run, scripts]) =>
      `Removed ${scripts.length === 1 ? 'a script' : `${scripts.length} scripts`} run ${run} left in ${this.manager.label} when it ended: ${scripts.map((l) => shown(l.script)).join(', ')}`);
  }

  /**
   * Installs one of the run's scripts, or replaces its copy. Returns
   * the manager's id for it, or throws saying why it can't be.
   */
  async push(prepared: PreparedScript, text: string): Promise<{ id: number; replaced: boolean }> {
    const file = fileURLToPath(prepared.script.fileUrl);
    const identity = identityOf(text);
    const all = await listAll(this.manager);
    const before = this.ids.get(file);
    const clash = all.find((l) => sameIdentity(l.script, identity) && l.script.id !== before);
    let id = before;
    if (clash) {
      const { label } = this.manager;
      if (clash.liveRun !== undefined && !this.isOwn(clash.mark)) {
        throw new Error(`${label} has ${shown(clash.script)} with the same name and namespace, loaded by run ${clash.liveRun}. Two runs can't both load one script.`);
      }
      if (!clash.mark?.run) {
        throw new Error(`${label} has ${shown(clash.script)} with the same name and namespace, installed apart from this run, which a run doesn't replace. To load this one, uninstall that one first: script E${clash.script.id} uninstall --force.`);
      }
      // One an ended run left: replaced.
      id ??= clash.script.id;
    }
    const code = markedText(text, { run: this.run.id, started: this.run.started, file });
    const result = await this.manager.install(code, { ...(id !== undefined ? { id } : {}), url: installUrlOf(prepared.script.fileUrl), files: installFiles(prepared), local: true });
    this.ids.set(file, result.id);
    return { id: result.id, replaced: before !== undefined || !result.isNew };
  }

  /** Removes the run's scripts, as it ends. */
  async removeAll(): Promise<void> {
    const all = await listAll(this.manager);
    await this.manager.remove(all.filter((l) => this.isOwn(l.mark)).map((l) => l.script.id));
  }
}

/**
 * The manager's other scripts, for `scripts` and `status`
 * (`ConsoleContext.others`): those expected on a tab, by sm-dev's own
 * matching of their rules, since the manager doesn't say what ran.
 * `runScripts`: the manager's ids of the run's own, which the run lists
 * apart.
 */
export function externalOthers(
  manager: ExternalManager, runScripts: () => Set<string | undefined>, guarded: boolean,
): NonNullable<ConsoleContext['others']> {
  const known = new Map<string, OtherScript>();
  const other = (id: number, name: string): OtherScript => {
    const label = `E${id}`;
    const found = known.get(label) ?? {
      label,
      name,
      collection: '',
      status: 'EXPECTED',
      values: async () => {
        throw new Error(`${manager.label} doesn't give sm-dev a script's stored values`);
      },
      setValues: async () => {
        throw new Error(`${manager.label} doesn't let sm-dev change a script's stored values`);
      },
    };
    known.set(label, found);
    return found;
  };
  return {
    guarded,
    kind: `${manager.label} scripts expected`,
    byLabel: (label) => known.get(label),
    onTab: async (tab) => {
      const url = tab.page.url();
      if (!await manager.applied()) return [];
      const own = runScripts();
      return (await manager.scripts())
        .filter((s) => s.enabled && !own.has(String(s.id)) && explainMatch(matchingOf(s), url).matches)
        .map((s) => other(s.id, s.name));
    },
    installed: (id, _label, name) => other(Number(id), name),
  };
}

/** A script's rules, as sm-dev's matching takes them. */
export function matchingOf(script: ExternalScript): { matches: string[]; includes: string[]; excludes: string[] } {
  // `@exclude-match` is a match pattern, which reads the same as a glob
  // in nearly every case.
  return { matches: script.match, includes: script.include, excludes: [...script.exclude, ...script.excludeMatch] };
}
