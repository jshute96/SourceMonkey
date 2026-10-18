// The toolbar popup loads every module it imports, one file each, on
// every open, before it can draw. These checks keep it off the heavy
// modules it once reached for a few small helpers. See
// docs/status-popup.md#load-time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

// The compiled modules a page's script loads, relative to dist/.
function loads(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    // `from '…'`, a side-effect `import '…'`, and `import('…')`. A
    // match in a comment only makes the check stricter.
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      walk(path.resolve(path.dirname(file), m[1]));
    }
  };
  walk(path.join(dist, entry));
  return [...seen].map((f) => path.relative(dist, f).split(path.sep).join('/'));
}

const popup = loads('extension/popup.js');

test('the popup loads neither the script store nor the location scanner', () => {
  // The store brings the script build and file loading; the scanner,
  // GitHub and HTTP reading. The worker does that work for the popup.
  for (const heavy of ['extension/script-store.js', 'extension/directories.js']) {
    assert.ok(!popup.includes(heavy), `popup.js reaches ${heavy}:\n${popup.join('\n')}`);
  }
});

test('the popup stays small', () => {
  // Room to grow, but a jump past this means a new import pulled in a
  // tree, which is worth a look before raising it.
  assert.ok(popup.length <= 21, `popup.js loads ${popup.length} modules:\n${popup.join('\n')}`);
});
