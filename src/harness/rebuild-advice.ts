// How to bring this sm-dev up to date, for messages that need it.
//
// The build records the checkout it was built from in
// lib/build-info.json. That covers both ways sm-dev runs:
//   - In the checkout itself (scripts/sm-dev), from its own lib/.
//   - In a repo of userscripts, from the copy `pnpm install` took (with
//     no src/ of its own). `pnpm install` copies the checkout's lib/ as
//     it is, without building it first, so the fix needs a build there
//     too.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoted } from './output-style.js';

// lib/, beside this module's lib/harness/.
const LIB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How to rebuild what this sm-dev runs from, as a sentence: in the
 * checkout itself, or in the checkout an installed copy came from and
 * then here.
 */
export function rebuildAdvice(): string {
  const source = buildSource();
  if (!source) return 'Run `pnpm run build` in SourceMonkey, and `pnpm install` again where it is installed.';
  if (path.resolve(source, 'lib') === LIB_DIR) return 'Run `pnpm run build`.';
  return `Run ${quoted('pnpm run build')} in ${source}, then ${quoted('pnpm install')} here.`;
}

// The checkout lib/ was built from, or null: built before
// build-info.json existed, or not by build.mjs, leaves nothing to go by.
function buildSource(): string | null {
  try {
    const info = JSON.parse(readFileSync(path.join(LIB_DIR, 'build-info.json'), 'utf8')) as { source?: unknown };
    return typeof info.source === 'string' ? info.source : null;
  } catch {
    return null;
  }
}
