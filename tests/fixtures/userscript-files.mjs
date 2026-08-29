// Reading `*.user.js` files off disk for the cross-manager harness:
// locating them, and pulling the `@name` / `@version` that every
// manager's install-or-skip decision turns on.
//
// Shared by the Tampermonkey and Violentmonkey drivers and by the
// standalone sync CLI, so all three classify the same file the same
// way.

import fs from 'node:fs';
import path from 'node:path';

// `@version` ordering comes from the extension's own comparator so the
// sync tooling and the shipped update-probe agree on which of two
// versions is newer. Re-exported so a driver importing this module
// gets the comparator too.
import { compareVersions } from '../../dist/version-compare.js';

export { compareVersions };

/**
 * @typedef {Object} UserscriptHeader
 * @property {string} name
 * @property {string} version
 * @property {string} filepath  Absolute path to the source file.
 */

/**
 * Read a `*.user.js` and extract its `@name` and `@version`.
 * @param {string} filepath
 * @returns {UserscriptHeader}
 */
export function parseUserscriptHeader(filepath) {
  const src = fs.readFileSync(filepath, 'utf8');
  const block = src.match(/==UserScript==([\s\S]*?)==\/UserScript==/);
  if (!block) throw new Error(`No UserScript metadata block in ${filepath}`);
  const name = readTag(block[1], 'name');
  const version = readTag(block[1], 'version');
  if (!name) throw new Error(`Missing @name in ${filepath}`);
  if (!version) throw new Error(`Missing @version in ${filepath}`);
  return { name, version, filepath };
}

function readTag(metaBlock, tag) {
  const re = new RegExp(`^\\s*//\\s*@${tag}\\s+(.+?)\\s*$`, 'm');
  const m = metaBlock.match(re);
  return m ? m[1] : null;
}

/**
 * List every `*.user.js` directly under `dir` (non-recursive). Used by
 * the per-spec install flow where each spec only cares about the
 * userscripts in its own directory.
 * @param {string} dir
 * @returns {UserscriptHeader[]}
 */
export function listUserscripts(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.user.js'))
    .map((f) => parseUserscriptHeader(path.join(dir, f)));
}

/**
 * List every `*.user.js` under `dir` recursively. Used by the
 * standalone sync CLI to walk all of `tests/examples/` in one pass.
 * @param {string} dir
 * @returns {UserscriptHeader[]}
 */
export function listUserscriptsRecursive(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.user.js')) out.push(p);
    }
  };
  walk(dir);
  return out.map(parseUserscriptHeader);
}
