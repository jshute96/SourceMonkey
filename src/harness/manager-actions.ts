// The `manager` verbs: `fetch` a manager into sm-dev's cache, `install`
// it into a browser, and `enable` or `disable` it there. sm-dev runs
// them itself, never in a run: they act on the browser's extensions,
// which a run doesn't hold.

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  allowUserScripts, installedManagers, loadUnpacked, otherManagersWarning, setExtensionEnabled, type InstalledManager,
} from './browser-extensions.js';
import { withTilde } from './browser-launch.js';
import { EXTENSION_DIR } from './extension-launch.js';
import { fetchManager, fetchedDir, fetchedVersion } from './manager-fetch.js';
import { MANAGERS, managerFlag, type ManagerName } from './managers.js';
import { cmd, id as idRole, message, quoted, SM_DEV_PREFIX, ui, url } from './output-style.js';
import { rebuildAdvice } from './rebuild-advice.js';

// A line of sm-dev's own, as a note, without its `[sm-dev] ` prefix.
const withoutPrefix = (line: string): string => (line.startsWith(SM_DEV_PREFIX) ? line.slice(SM_DEV_PREFIX.length) : line);

export type ManagerVerb = 'fetch' | 'install' | 'enable' | 'disable';

export interface ManagerActionOptions {
  verb: ManagerVerb;
  manager: ManagerName;
  /** The browser's CDP endpoint; not needed for `fetch`. */
  endpoint?: string;
  /** ` --browser <address>` for advice, when the browser isn't the default. */
  browserArg?: string;
  /** The runs using SourceMonkey in that browser, which `disable` can't turn it off under. */
  runsUsing?: string[];
  /** Results, for stdout. */
  out: (line: string) => void;
  /** Progress, warnings and failures, for stderr. */
  note: (line: string) => void;
}

/** A failure the person made in asking, rather than one doing it. */
export class ManagerUsageError extends Error {}

/** Does one verb. Returns false when it failed, having said why. */
export async function managerAction(o: ManagerActionOptions): Promise<boolean> {
  const { label } = MANAGERS[o.manager];
  if (o.verb === 'fetch') {
    if (o.manager === 'sourcemonkey') throw new ManagerUsageError(`${label} comes with sm-dev, so there is nothing to fetch. Use ${quoted('--manager')} to name another.`);
    const fetched = await fetchManager(o.manager, (line) => o.note(withoutPrefix(line)));
    if (!fetched.downloaded) {
      o.out(ui`${label} ${fetched.version} is the newest version, and is already in ${url(withTilde(fetched.dir))}`);
      return true;
    }
    o.out(ui`Fetched ${label} ${fetched.version} into ${url(withTilde(fetched.dir))}${fetched.replaced ? `, replacing ${fetched.replaced}` : ''}`);
    if (fetched.replaced) o.out(message(`A browser with it installed from there gets the new version with ${quoted(`sm-dev ${managerFlag(o.manager)} manager install`)}.`));
    return true;
  }
  const endpoint = o.endpoint!;
  const managers = await browserManagers(endpoint);
  const copies = managers.filter((m) => m.manager === o.manager);
  if (o.verb === 'install') {
    if (!await install(o, managers, copies)) return false;
  } else {
    if (copies.length === 0) {
      o.note(message(`${label} is not installed in this browser. Install it with ${quoted(`sm-dev${o.browserArg ?? ''} ${managerFlag(o.manager)} manager install`)}`));
      return false;
    }
    const enable = o.verb === 'enable';
    if (!enable && o.manager === 'sourcemonkey' && (o.runsUsing ?? []).length > 0) {
      const runs = o.runsUsing!;
      const ids = runs.map((run) => idRole(run)).join(', ');
      o.note(ui`SourceMonkey can't be turned off while ${runs.length === 1 ? ui`run ${ids} uses` : ui`runs ${ids} use`} it. Stop ${runs.length === 1 ? 'that run' : 'them'} first.`);
      return false;
    }
    for (const copy of copies) {
      if (copy.enabled === enable) {
        o.out(`${copy.name} ${copy.version} is already ${enable ? 'enabled' : 'disabled'}`);
        continue;
      }
      await setExtensionEnabled(endpoint, copy.id, enable);
      copy.enabled = enable;
      o.out(`${enable ? 'Enabled' : 'Disabled'} ${copy.name} ${copy.version}`);
    }
    if (enable && copies.some((c) => !c.userScripts)) {
      o.note(message(`Its Allow User Scripts is off, so it can't run scripts. ${quoted(`sm-dev${o.browserArg ?? ''} ${managerFlag(o.manager)} manager install`)} turns it on.`));
    }
  }
  // Not after turning it off, when it's no longer in use either.
  if (o.verb !== 'disable') for (const line of otherManagersWarning(managers, o.manager, o.browserArg)) o.note(line);
  return true;
}

// `manager install`: loads the manager unpacked, from sm-dev's copy of
// SourceMonkey or the fetched copy of another, with "Allow User
// Scripts" on. One there already is left as it is, but for turning
// that on, and for a fetched copy, updating it to the version fetched
// since.
async function install(o: ManagerActionOptions, managers: InstalledManager[], copies: InstalledManager[]): Promise<boolean> {
  const { label } = MANAGERS[o.manager];
  const endpoint = o.endpoint!;
  let dir: string;
  let version: string | null;
  if (o.manager === 'sourcemonkey') {
    dir = EXTENSION_DIR;
    if (!existsSync(path.join(dir, 'manifest.json'))) {
      o.note(ui`The built extension is missing from ${url(dir)}. ${message(rebuildAdvice())}`);
      return false;
    }
    version = null;
  } else {
    // Fetched the first time it's wanted, as `manager fetch` would.
    version = fetchedVersion(o.manager) ?? (await fetchManager(o.manager, (line) => o.note(withoutPrefix(line)))).version;
    dir = fetchedDir(o.manager);
  }
  const ours = copies.find((m) => m.path !== undefined && path.resolve(m.path) === path.resolve(dir));
  const copy = ours ?? copies[0];
  if (copy) {
    if (ours && version !== null && ours.version !== version) {
      await loadUnpacked(endpoint, dir);
      o.out(ui`Updated ${copy.name} from ${copy.version} to ${version}, from ${url(withTilde(dir))}`);
    } else {
      // Where Chrome says it came from, when it says.
      const from = copy.path ? ui`, from ${url(withTilde(copy.path))}` : copy.fromStore ? ', from the Chrome Web Store' : '';
      o.out(ui`${copy.name} ${copy.version} is already installed${from}${copy.enabled ? '' : ui`, but disabled. Turn it on with ${cmd(`sm-dev${o.browserArg ?? ''} ${managerFlag(o.manager)} manager enable`)}.`}`);
    }
    if (!copy.userScripts) {
      await allowUserScripts(endpoint, copy.id);
      o.out('Turned on its Allow User Scripts');
    }
    return true;
  }
  const id = await loadUnpacked(endpoint, dir);
  await allowUserScripts(endpoint, id);
  const loaded = (await browserManagers(endpoint)).find((m) => m.id === id);
  managers.push(...(loaded ? [loaded] : []));
  o.out(ui`Installed ${label}${loaded ? ` ${loaded.version}` : ''} from ${url(withTilde(dir))}, with Allow User Scripts on`);
  return true;
}

// The managers in the browser, or a failure naming it.
async function browserManagers(endpoint: string): Promise<InstalledManager[]> {
  try {
    return await installedManagers(endpoint);
  } catch (err) {
    throw new Error(`Could not read the extensions of the browser at ${endpoint.replace(/^https?:\/\//, '')}: ${(err as Error).message}`);
  }
}
