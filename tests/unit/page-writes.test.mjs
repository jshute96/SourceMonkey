// Only the service worker writes storage and places registrations
// (docs/worker-writes.md). Pages call worker-client.ts instead, which
// exports the same names. These checks catch a page module importing
// a writer straight from the module that defines it; the writers'
// funnels also throw in a page (`assertWorkerContext`).
//
// Page-only modules are the ones the pages' entry points reach and the
// service worker's doesn't: a module both load runs its writes in the
// worker, where pages ask for them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = path.join(root, 'src');

const PAGE_ENTRIES = [
  'extension/collections.ts', 'extension/userscript.ts', 'extension/options.ts', 'extension/compare.ts',
  'extension/popup.ts', 'extension/debug/icons.ts', 'extension/connect-prompt-page.ts', 'extension/page-heading.ts',
];
const WORKER_ENTRY = 'extension/background.ts';

// The writers, by the module that defines them (relative to
// src/extension/, without `.ts`).
const WRITERS = {
  'script-store': [
    'addCollection', 'createCollection', 'installScript', 'moveScript', 'removeScript', 'removeCollection',
    'moveCollection', 'setScriptEnabled', 'setScriptsEnabled', 'setCollectionEnabled', 'setCollectionOptions',
    'setCollectionLocalFiles', 'markFirstRunComplete', 'backfillCollectionDisplayNames',
    'reconcileScriptMembership', 'refreshCollection', 'refreshScript', 'refreshAllCollections',
    'writeEnablement', 'writeEnablementFrom', 'writeRunScript', 'removeSmDevCollection', 'setVersionProbes',
    'verifyParseChecks', 'recordMissingBlobs',
  ],
  'script-updater': ['updateScript', 'updateCollection', 'updateAllCollections'],
  'script-enablement': ['setScriptEnabledExclusive', 'setCollectionEnabledExclusive', 'setAllScriptsEnabled', 'enableWithin'],
  'script-identity': ['turnOffOtherCopies'],
  'connect-grants': ['revokeConnectHost', 'forgetDeniedHost'],
  'script-log': ['clearScriptLog'],
  'site-icon': ['refreshCachedIcon', 'deleteCachedIcon', 'deleteAllCachedIcons'],
  'local-copy': ['registerLocalCopy'],
  'injector': ['syncRegistrations', 'retryRejectedRegistrations', 'unregisterAllRegistrations', 'registerWithFallback'],
};

// A generated module (`generated-wrappers`) has no source here, and
// imports nothing.
function read(rel) {
  try {
    return readFileSync(path.join(src, rel), 'utf8');
  } catch {
    return '';
  }
}

// Runtime imports only: `import type` is erased.
function imports(rel) {
  const out = [];
  for (const m of read(rel).matchAll(/^(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+'(\.[^']+)'/gms)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2])).replace(/\.js$/, '.ts');
    const names = (m[1].match(/\{([^}]*)\}/)?.[1] ?? '')
      .split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type '))
      .map((n) => n.split(/\s+as\s+/)[0]);
    out.push({ target, names });
  }
  return out;
}

function reach(entries) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const { target } of imports(rel)) visit(target);
  };
  entries.forEach(visit);
  return seen;
}

const worker = reach([WORKER_ENTRY]);
const pageOnly = [...reach(PAGE_ENTRIES)].filter((rel) => !worker.has(rel));

test('page-only modules exist to check', () => {
  assert.ok(pageOnly.includes('extension/collections.ts'));
});

test('no page-only module imports a writer from where it is defined', () => {
  const found = [];
  for (const rel of pageOnly) {
    for (const { target, names } of imports(rel)) {
      const writers = WRITERS[target.replace(/^extension\//, '').replace(/\.ts$/, '')] ?? [];
      for (const name of names) if (writers.includes(name)) found.push(`${rel}: ${name} from ${target}`);
    }
  }
  assert.deepEqual(found, [], 'Import these from worker-client.ts instead.');
});

test('no page-only module writes storage or places registrations itself', () => {
  const found = [];
  const writes = /chrome\.storage\.(?:local|session|sync)\.(?:set|remove|clear)\(|chrome\.userScripts\.(?:register|update|unregister|configureWorld)\(/g;
  for (const rel of pageOnly) {
    const text = read(rel).replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(writes)) found.push(`${rel}: ${m[0]}`);
  }
  assert.deepEqual(found, []);
});
