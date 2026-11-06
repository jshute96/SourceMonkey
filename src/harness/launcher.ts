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
// runs it. Only output-style.js and project-copy.js (which import
// nothing else of sm-dev's) are loaded before, so that copy runs as if
// it were started directly, and `--version` reports where it is. It
// imports cli.js rather than the other copy's launcher, so it can't
// loop, and it works with copies older than this launcher.
//
// The `sm-dev` wrapper package (packages/sm-dev), for `npx sm-dev` and
// `npm install -g sm-dev`, runs this too.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ERROR_PREFIX, SM_DEV_PREFIX, quoted } from './output-style.js';
import { downloadTool, nearestCopy, projectManager, realpath } from './project-copy.js';

const CLI = path.join('lib', 'harness', 'cli.js');
const OWN_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const OWN_DIR = path.resolve(path.dirname(OWN_CLI), '..', '..');
const NO_LOCAL = 'SM_DEV_NO_LOCAL=1';

// The command that installs `project`'s dependencies.
function installCommand(project: string): string {
  return `${projectManager(project) ?? 'npm'} install`;
}

// Written plain, not painted for a terminal as cli.js's errors are, so
// the launcher loads nothing more before the handoff.
function fail(problem: string, fix: string): never {
  process.stderr.write(`${SM_DEV_PREFIX}${ERROR_PREFIX}${problem}. ${fix}, or set ${quoted(NO_LOCAL)} to run the sm-dev in ${OWN_DIR}.\n`);
  process.exit(1);
}

function cliToRun(): string {
  if (process.env.SM_DEV_NO_LOCAL === '1' || downloadTool(OWN_CLI)) return OWN_CLI;
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
