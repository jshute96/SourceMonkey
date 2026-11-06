// How to bring this sm-dev up to date, for messages that need it.
//
// The build records the checkout it was built from in
// lib/build-info.json. That covers both ways sm-dev runs:
//   - In the checkout itself (scripts/sm-dev), from its own lib/.
//   - In a repo of userscripts, from the copy `pnpm install` took (with
//     no src/ of its own). `pnpm install` copies the checkout's lib/ as
//     it is, without building it first, so the fix needs a build there
//     too.
//
// A published package has `{ "release": true }` there instead, written
// by scripts/pack-npm.sh, so it names no directory of the publisher's.
// The update check (update-check.ts) runs only for those copies.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoted } from './output-style.js';
import { ownUpdateCommand } from './project-copy.js';

// lib/, beside this module's lib/harness/.
const LIB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How to rebuild what this sm-dev runs from, as a sentence: in the
 * checkout itself, or in the checkout an installed copy came from and
 * then here.
 */
export function rebuildAdvice(): string {
  if (isReleaseBuild()) {
    const command = ownUpdateCommand();
    return command ? `Run ${quoted(command)}.` : 'Update the package the way you installed it.';
  }
  const source = buildSource();
  if (!source) return 'Run `pnpm run build` in SourceMonkey, and `pnpm install` again where it is installed.';
  if (path.resolve(source, 'lib') === LIB_DIR) return 'Run `pnpm run build`.';
  return `Run ${quoted('pnpm run build')} in ${source}, then ${quoted('pnpm install')} here.`;
}

/** Whether this copy came from a published package, not a local build. */
export function isReleaseBuild(): boolean {
  return buildInfo()?.release === true;
}

// The checkout lib/ was built from, or null: built before
// build-info.json existed, or not by build.mjs, leaves nothing to go by.
function buildSource(): string | null {
  const source = buildInfo()?.source;
  return typeof source === 'string' ? source : null;
}

function buildInfo(): { source?: unknown; release?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path.join(LIB_DIR, 'build-info.json'), 'utf8'));
  } catch {
    return null;
  }
}
