// Whether this sm-dev was built from older source than its SourceMonkey
// checkout now has, so commands the docs describe may be missing.
//
// The build records where it was built from, and when, in
// lib/build-info.json. That covers both ways sm-dev runs:
//   - In the checkout itself (scripts/sm-dev), from its own lib/.
//   - In a repo of userscripts, from the copy `pnpm install` took (with
//     no src/ of its own), which goes stale when the checkout changes.
//     `pnpm install` copies the checkout's lib/ as it is, without
//     building it first, so the fix may need a build there too.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/, beside this module's lib/harness/.
const LIB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What `scripts/build.mjs` writes to lib/build-info.json. */
interface BuildInfo {
  /** The checkout it was built from. */
  source: string;
  /** When the build started, in ms since the epoch. */
  builtAt: number;
}

/** A warning to print when the source has changed since the build, or null. */
export function staleBuildWarning(): string | null {
  const info = buildInfo(LIB_DIR);
  // The checkout may be gone, or on another machine.
  if (!info || !newerFile(path.join(info.source, 'src'), info.builtAt)) return null;
  const checkoutLib = path.join(info.source, 'lib');
  if (path.resolve(checkoutLib) === LIB_DIR) {
    return 'sm-dev: src/ has changes newer than lib/, so this sm-dev may be out of date. Run pnpm run build to rebuild.';
  }
  // An installed copy: the checkout's own build may already be newer.
  const checkout = buildInfo(checkoutLib);
  const built = checkout !== null && !newerFile(path.join(info.source, 'src'), checkout.builtAt);
  return `sm-dev: SourceMonkey at ${info.source} has changes since this copy was installed, so it may be out of date. `
    + (built ? 'Run pnpm install here to copy its new build.' : `Run pnpm run build in ${info.source}, then pnpm install here.`);
}

// A lib/'s build-info.json, or null: built before the file existed, or
// not by build.mjs, leaves nothing to go by.
function buildInfo(libDir: string): BuildInfo | null {
  try {
    const info = JSON.parse(readFileSync(path.join(libDir, 'build-info.json'), 'utf8')) as BuildInfo;
    return typeof info.source === 'string' && info.builtAt > 0 ? info : null;
  } catch {
    return null;
  }
}

// Whether any file under `dir` was modified after `since`. Stops at the
// first, so an up-to-date build costs one walk of the tree.
function newerFile(dir: string, since: number): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (newerFile(full, since)) return true;
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // A link's target, as the build reads it.
      try {
        if (statSync(full).mtimeMs > since) return true;
      } catch {
        // Gone since the listing, or a broken link.
      }
    }
  }
  return false;
}
