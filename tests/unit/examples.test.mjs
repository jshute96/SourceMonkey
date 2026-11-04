// Checks on the example pages in userscripts/examples/: each one keeps the
// shared page skeleton's footer, its scripts' names start with the
// directory, it's linked from the index page, and
// the script_manifest.json files are up to date (see "Adding a new
// example" in userscripts/examples/README.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../userscripts/examples');
const dirs = fs.readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(EXAMPLES, d.name, `${d.name}.html`)))
  .map((d) => d.name);
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

  test(`${dir}: linked from the index`, () => {
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

// A script that names its page site-lessly (`*://*/...`) names the
// page's GitHub Pages URL first, with the same tag, so managers show
// that as the script's link and site.
test('example userscripts name their GitHub Pages page first', () => {
  const files = fs.readdirSync(EXAMPLES, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => f.endsWith('.user.js'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(EXAMPLES, file), 'utf8');
    const rules = [...text.matchAll(/^\/\/ @(match|include)\s+(\S+)$/gm)];
    const siteless = rules.find((r) => r[2].startsWith('*://*/'));
    if (!siteless) continue;
    const page = siteless[2].replace(/^\*:\/\/\*\/\*?/, '');
    assert.equal(`@${rules[0][1]} ${rules[0][2]}`,
      `@${siteless[1]} https://jshute96.github.io/SourceMonkey/userscripts/examples/${page}`, file);
  }
});

test('example userscripts use the SourceMonkey icon', () => {
  const files = fs.readdirSync(EXAMPLES, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => f.endsWith('.user.js'));
  for (const file of files) {
    const text = fs.readFileSync(path.join(EXAMPLES, file), 'utf8');
    const icon = /^\/\/ @icon\s+(\S+)$/m.exec(text)?.[1];
    assert.equal(icon, 'https://jshute96.github.io/SourceMonkey/src/icons/icon-48.png', file);
  }
});

// Each script_manifest.json lists every userscript under its directory,
// sorted, so loading it (in sm-dev or as a collection) gets them all.
// Update it with `pnpm sm-dev manifest <dir> --prune`.
for (const dir of [EXAMPLES, path.resolve(EXAMPLES, '../bad-examples')]) {
  test(`${path.basename(dir)}/script_manifest.json lists every userscript there`, () => {
    const files = fs.readdirSync(dir, { recursive: true })
      .map((f) => String(f).split(path.sep).join('/'))
      .filter((f) => f.endsWith('.user.js'))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const listed = JSON.parse(fs.readFileSync(path.join(dir, 'script_manifest.json'), 'utf8'));
    assert.deepEqual(listed, files, `Out of date: run pnpm sm-dev manifest ${path.relative(process.cwd(), dir)} --prune`);
  });
}
