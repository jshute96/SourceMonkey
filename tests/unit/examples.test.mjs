// Checks on the example pages in tests/examples/: each one keeps the
// shared page skeleton's footer, its scripts' names start with the
// directory, and it's listed in the README table and the index page (see "Adding a new example" in tests/examples/README.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples');
const dirs = fs.readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(EXAMPLES, d.name, `${d.name}.html`)))
  .map((d) => d.name);
const readme = fs.readFileSync(path.join(EXAMPLES, 'README.md'), 'utf8');
const index = fs.readFileSync(path.join(EXAMPLES, 'index.html'), 'utf8');

test('there are example pages to check', () => {
  assert.ok(dirs.length > 10);
});

for (const dir of dirs) {
  test(`${dir}: footer links back to the index and to its userscripts`, () => {
    const html = fs.readFileSync(path.join(EXAMPLES, dir, `${dir}.html`), 'utf8');
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(html)?.[1];
    assert.ok(footer, 'no <footer>');
    assert.match(footer, /href="\.\.\/index\.html"/);
    assert.match(footer, /href="[^"]+\.user\.js"/);
  });

  test(`${dir}: listed in the README table and the index`, () => {
    assert.ok(readme.includes(`| \`${dir}/\``), 'no README table row');
    assert.ok(index.includes(`href="${dir}/`), 'no index.html link');
  });
}

test('every example userscript is named for its directory', () => {
  for (const dir of fs.readdirSync(EXAMPLES, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const files = fs.readdirSync(path.join(EXAMPLES, dir.name), { recursive: true })
      .filter((f) => String(f).endsWith('.user.js'));
    for (const file of files) {
      const text = fs.readFileSync(path.join(EXAMPLES, dir.name, String(file)), 'utf8');
      const name = /^\/\/ @name\s+(.*)$/m.exec(text)?.[1];
      assert.ok(name?.startsWith(`SourceMonkey example: ${dir.name}: `), `${dir.name}/${file}: ${name}`);
    }
  }
});
