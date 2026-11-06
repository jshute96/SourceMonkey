// Finding the copies of sourcemonkey around a directory, and how this
// copy was installed. The launcher (launcher.ts) loads this before it
// hands off to another copy, so it imports nothing else of sm-dev's.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `project` is the directory whose node_modules holds an installed copy,
// and `dependency` the package the project installed to get it.
export type Found =
  | { kind: 'checkout' | 'uninstalled'; dir: string }
  | { kind: 'installed'; dir: string; project: string; dependency: Dependency };

export type Dependency = 'sourcemonkey' | 'sm-dev';

const PACKAGES: Dependency[] = ['sourcemonkey', 'sm-dev'];

function readPackage(dir: string): { name?: unknown; packageManager?: unknown; dependencies?: object; devDependencies?: object } | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

// The one of our packages a package.json lists, or else `fallback`. Where
// a copy was found doesn't show this: npm hoists the wrapper's
// `sourcemonkey` to the top of node_modules.
function dependencyOf(pkg: ReturnType<typeof readPackage>, fallback: Dependency): Dependency {
  return PACKAGES.find((name) => name in (pkg?.dependencies ?? {}) || name in (pkg?.devDependencies ?? {})) ?? fallback;
}

// The `sourcemonkey` an installed `sm-dev` wrapper package runs, or null.
// pnpm keeps it beside the wrapper in its store, not in the project's
// node_modules, so it's resolved from the wrapper.
function wrappedCopy(wrapper: string): string | null {
  if (!existsSync(path.join(wrapper, 'package.json'))) return null;
  try {
    const require = createRequire(path.join(realpathSync(wrapper), 'package.json'));
    return path.dirname(require.resolve('sourcemonkey/package.json'));
  } catch {
    return null;
  }
}

/**
 * The nearest copy of sourcemonkey at or above `start`, or a project
 * that depends on it without having it installed.
 *
 * A project that depends on it may still find it further up: a
 * workspace (npm's, yarn's) installs its members' dependencies in the
 * root's node_modules. So past such a project, only an installed copy
 * counts; reaching a checkout or the top first means it isn't installed.
 */
export function nearestCopy(start: string): Found | null {
  let declared: string | null = null;
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const pkg = readPackage(dir);
    if (pkg?.name === 'sourcemonkey') return declared ? { kind: 'uninstalled', dir: declared } : { kind: 'checkout', dir };
    const installed = path.join(dir, 'node_modules', 'sourcemonkey');
    // In a workspace, the member that lists it is the one to go by.
    const owner = declared ? readPackage(declared) : pkg;
    if (existsSync(path.join(installed, 'package.json'))) return { kind: 'installed', dir: installed, project: dir, dependency: dependencyOf(owner, 'sourcemonkey') };
    const wrapper = wrappedCopy(path.join(dir, 'node_modules', 'sm-dev'));
    if (wrapper) return { kind: 'installed', dir: wrapper, project: dir, dependency: dependencyOf(owner, 'sm-dev') };
    if (!declared && pkg && PACKAGES.some((name) => name in (pkg.dependencies ?? {}) || name in (pkg.devDependencies ?? {}))) {
      declared = dir;
    }
    if (path.dirname(dir) === dir) return declared ? { kind: 'uninstalled', dir: declared } : null;
  }
}

export function realpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * The tool that downloaded `file` for a one-off run, or null for an
 * install. The path as started is checked too: pnpm can link a dlx
 * package into a shared store, whose real path has no `dlx` in it.
 */
export function downloadTool(file: string): 'npx' | 'dlx' | null {
  const paths = [realpath(file) ?? file, process.argv[1] ?? ''].map((p) => p.split(path.sep));
  if (paths.some((parts) => parts.includes('_npx'))) return 'npx';
  return paths.some((parts) => parts.includes('dlx')) ? 'dlx' : null;
}

// The package manager a project uses, in this order:
// - its own lockfile, then its package.json's `packageManager`;
// - a lockfile further up (a workspace keeps one at its root).
const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
];
function lockfileManager(dir: string): string | undefined {
  return LOCKFILES.find(([file]) => existsSync(path.join(dir, file)))?.[1];
}
export function projectManager(project: string): string | undefined {
  const manager = readPackage(project)?.packageManager;
  const named = typeof manager === 'string' ? manager.split('@')[0] : '';
  let found = lockfileManager(project) ?? LOCKFILES.find(([, m]) => m === named)?.[1];
  for (let dir = path.dirname(project); !found && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    found = lockfileManager(dir);
  }
  return found;
}

/**
 * How a copy was installed, as far as it can be told for certain.
 * - `project`: the dependency of the project around the current directory.
 * - `global`: a global install, from a path that matches npm's or pnpm's.
 * - `download`: a one-off npx or `pnpm dlx` run.
 * - `unknown`: anything else. Package managers can change their layouts,
 *   so nothing is assumed: a wrong command could install a second copy.
 */
export type Install =
  | { kind: 'project'; manager: string | undefined; dependency: string }
  | { kind: 'global'; manager: 'npm' | 'pnpm'; dependency: Dependency }
  | { kind: 'download'; tool: 'npx' | 'dlx' }
  | { kind: 'unknown' };

/**
 * The command that gets a copy to the newest version, or null when
 * there's none we're sure of. For a one-off run, it runs that version:
 * there's nothing installed to update. `npm update` stays inside package.json's
 * range, and on 0.x a caret range only allows patch releases, so only
 * `npm install @latest` reaches a new minor.
 */
export function updateCommand(install: Install): string | null {
  switch (install.kind) {
    case 'download':
      return install.tool === 'npx' ? 'npx sm-dev@latest' : 'pnpm dlx sm-dev@latest';
    case 'global':
      return install.manager === 'pnpm' ? `pnpm update -g --latest ${install.dependency}` : `npm update -g ${install.dependency}`;
    case 'project':
      if (install.manager === 'pnpm') return `pnpm update --latest ${install.dependency}`;
      return install.manager === 'npm' ? `npm install -D ${install.dependency}@latest` : null;
    case 'unknown':
      return null;
  }
}

const OWN_FILE = fileURLToPath(import.meta.url);
const OWN_DIR = path.resolve(path.dirname(OWN_FILE), '..', '..');

/**
 * How a copy that isn't in the current project was installed, given the
 * real paths of its directory and of the script that started it.
 * - pnpm keeps global packages under `global/.../.pnpm`, or in newer
 *   versions under its store's `links` directory.
 * - npm keeps them in `lib/node_modules`, or `npm/node_modules` on Windows.
 * - A script outside the copy is the `sm-dev` wrapper package's. Its own
 *   bin is inside.
 */
export function globalInstall(dir: string, started: string): Install {
  const parts = dir.split(path.sep);
  const pnpm = (parts.includes('.pnpm') && parts.includes('global')) || /[\\/]store[\\/]v\d+[\\/]links[\\/]/.test(dir);
  const npm = !pnpm && /[\\/](lib|npm)[\\/]node_modules[\\/]/.test(dir);
  if (!pnpm && !npm) return { kind: 'unknown' };
  return {
    kind: 'global',
    manager: pnpm ? 'pnpm' : 'npm',
    dependency: started.startsWith(dir + path.sep) ? 'sourcemonkey' : 'sm-dev',
  };
}

// How this copy was installed.
function ownInstall(): Install {
  const tool = downloadTool(OWN_FILE);
  if (tool) return { kind: 'download', tool };
  const own = realpath(OWN_DIR);
  const found = nearestCopy(process.cwd());
  if (found?.kind === 'installed' && realpath(found.dir) === own) {
    return { kind: 'project', manager: projectManager(found.project), dependency: found.dependency };
  }
  const started = process.argv[1] ?? '';
  return globalInstall(own ?? OWN_DIR, realpath(started) ?? started);
}

/** Whether this copy is a one-off npx or `pnpm dlx` run, not an install. */
export function isDownloadRun(): boolean {
  return downloadTool(OWN_FILE) !== null;
}

/**
 * The command that gets the newest version, if we're sure of one. For a
 * one-off run, it runs that version rather than updating anything.
 */
export function ownUpdateCommand(): string | null {
  return updateCommand(ownInstall());
}
