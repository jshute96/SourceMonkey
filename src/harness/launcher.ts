#!/usr/bin/env node
// The `sm-dev` command, as the package's `bin` installs it. It runs the
// project's own copy of sm-dev when there is one, rather than this one:
// a copy installed globally, run inside a repo that has `sourcemonkey`
// as a dependency (or inside a SourceMonkey checkout), hands off to the
// repo's copy, so it runs the same version as that repo's specs.
//
// - It looks up from the current directory, nearest first, for a
//   SourceMonkey checkout (a package.json named `sourcemonkey`), a
//   `node_modules/sourcemonkey` or `node_modules/sm-dev` (the wrapper
//   package, whose own `sourcemonkey` dependency it uses), or a
//   package.json that depends on either (not installed yet: an error,
//   rather than running some copy further up). It runs that copy's
//   lib/harness/cli.js.
// - With none found, or when that is this copy, it runs its own cli.js.
// - `SM_DEV_NO_LOCAL=1` turns the lookup off.
// - So does running from npx's or `pnpm dlx`'s cache: `npx sm-dev@latest`
//   keeps running the version asked for.
//
// The handoff imports the other copy's cli.js in this process, which
// runs it. Only output-style.js (which imports nothing) is loaded
// before, so that copy runs as if it were started directly, and
// `--version` reports where it is. It
// imports cli.js rather than the other copy's launcher, so it can't
// loop, and it works with copies older than this launcher.
//
// The `sm-dev` wrapper package (packages/sm-dev), for `npx sm-dev` and
// `npm install -g sm-dev`, runs this too.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ERROR_PREFIX, SM_DEV_PREFIX, quoted } from './output-style.js';

const CLI = path.join('lib', 'harness', 'cli.js');
const OWN_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const OWN_DIR = path.resolve(path.dirname(OWN_CLI), '..', '..');
const NO_LOCAL = 'SM_DEV_NO_LOCAL=1';

// `project` is the directory whose node_modules holds an installed copy.
type Found =
  | { kind: 'checkout' | 'uninstalled'; dir: string }
  | { kind: 'installed'; dir: string; project: string };

const PACKAGES = ['sourcemonkey', 'sm-dev'];

function readPackage(dir: string): { name?: unknown; packageManager?: unknown; dependencies?: object; devDependencies?: object } | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
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

// The nearest copy of sourcemonkey at or above `start`, or a project
// that depends on it without having it installed.
//
// A project that depends on it may still find it further up: a
// workspace (npm's, yarn's) installs its members' dependencies in the
// root's node_modules. So past such a project, only an installed copy
// counts; reaching a checkout or the top first means it isn't installed.
function nearestCopy(start: string): Found | null {
  let declared: string | null = null;
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const pkg = readPackage(dir);
    if (pkg?.name === 'sourcemonkey') return declared ? { kind: 'uninstalled', dir: declared } : { kind: 'checkout', dir };
    const installed = path.join(dir, 'node_modules', 'sourcemonkey');
    if (existsSync(path.join(installed, 'package.json'))) return { kind: 'installed', dir: installed, project: dir };
    const wrapper = wrappedCopy(path.join(dir, 'node_modules', 'sm-dev'));
    if (wrapper) return { kind: 'installed', dir: wrapper, project: dir };
    if (!declared && pkg && PACKAGES.some((name) => name in (pkg.dependencies ?? {}) || name in (pkg.devDependencies ?? {}))) {
      declared = dir;
    }
    if (path.dirname(dir) === dir) return declared ? { kind: 'uninstalled', dir: declared } : null;
  }
}

function realpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// Run from a one-off download (`npx`, `pnpm dlx`) rather than an install.
// The path as started is checked too: pnpm can link a dlx package into a
// shared store, whose real path has no `dlx` in it.
function fromDownloadCache(): boolean {
  return [realpath(OWN_CLI) ?? OWN_CLI, process.argv[1] ?? ''].some((p) => {
    const parts = p.split(path.sep);
    return parts.includes('_npx') || parts.includes('dlx');
  });
}

// The command that installs `project`'s dependencies, in this order:
// - its own lockfile, then its package.json's `packageManager`;
// - a lockfile further up (a workspace keeps one at its root);
// - npm, which comes with Node.
const LOCKFILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
];
function lockfileManager(dir: string): string | undefined {
  return LOCKFILES.find(([file]) => existsSync(path.join(dir, file)))?.[1];
}
function installCommand(project: string): string {
  const manager = readPackage(project)?.packageManager;
  const named = typeof manager === 'string' ? manager.split('@')[0] : '';
  let found = lockfileManager(project) ?? LOCKFILES.find(([, m]) => m === named)?.[1];
  for (let dir = path.dirname(project); !found && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    found = lockfileManager(dir);
  }
  return `${found ?? 'npm'} install`;
}

// Written plain, not painted for a terminal as cli.js's errors are, so
// the launcher loads nothing more before the handoff.
function fail(problem: string, fix: string): never {
  process.stderr.write(`${SM_DEV_PREFIX}${ERROR_PREFIX}${problem}. ${fix}, or set ${quoted(NO_LOCAL)} to run the sm-dev in ${OWN_DIR}.\n`);
  process.exit(1);
}

function cliToRun(): string {
  if (process.env.SM_DEV_NO_LOCAL === '1' || fromDownloadCache()) return OWN_CLI;
  const found = nearestCopy(process.cwd());
  if (!found) return OWN_CLI;
  if (found.kind === 'uninstalled') {
    fail(`This project's sm-dev isn't installed: ${found.dir} depends on it but it's not installed in node_modules`,
      `Run ${quoted(installCommand(found.dir))} to install it`);
  }
  const cli = path.join(found.dir, CLI);
  const real = realpath(cli);
  if (real && real === realpath(OWN_CLI)) return OWN_CLI;
  if (!real) {
    // An installed copy is a symlink into a checkout for a `link:`
    // dependency, which needs a build there rather than an install.
    const source = realpath(found.dir) ?? found.dir;
    // A published install always has lib/, so one without is incomplete.
    if (found.kind === 'installed' && source.split(path.sep).includes('node_modules')) {
      fail(`The SourceMonkey copy in ${found.dir} is incomplete: The file ${CLI} is missing`,
        `Run ${quoted(installCommand(found.project))} in ${found.project}`);
    }
    fail(`The SourceMonkey copy in ${source} isn't built: The file ${CLI} is missing`,
      `Run ${quoted('pnpm run build')} there`);
  }
  return cli;
}

await import(pathToFileURL(cliToRun()).href);
