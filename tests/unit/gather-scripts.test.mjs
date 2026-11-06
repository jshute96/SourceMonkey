// The test-script gatherer: which scripts each source yields, and the docs
// found beside them. Web sources use a local server; the GitHub and Greasy Fork
// URL handling is checked as pure functions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  declaredDependencies, gather, githubRawUrl, githubTree, greasyForkId, greasyForkInfo, isPrivateHost, linkedScripts,
  manifestEntries, safeFileName, standInPath,
} from '../../skills/SourceMonkey-dev/scripts/gather-scripts.mjs';

const script = (name, version = '1.0') =>
  `// ==UserScript==\n// @name ${name}\n// @version ${version}\n// @match https://example.com/*\n// ==/UserScript==\nconsole.log(1);\n`;

const withDeps = (name, lines) =>
  `// ==UserScript==\n// @name ${name}\n// @match https://example.com/*\n${lines.map((l) => `// ${l}\n`).join('')}// ==/UserScript==\n`;

/** Runs `body` with fetch answering from `routes`: a URL to a Response, or to a function giving one. */
async function withFetch(routes, body) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    asked.push(href);
    const route = routes[href];
    if (!route) return new Response('', { status: 404 });
    return typeof route === 'function' ? route() : route.clone();
  };
  try {
    return { result: await body(), asked };
  } finally {
    globalThis.fetch = real;
  }
}

const PAGES = {
  '/tutorial.html': ['text/html', '<html><body><pre>\n// ==UserScript==\n// @name Example\n// ==/UserScript==\n</pre><a href="/a/one.user.js">the real one</a></body></html>'],
  '/d/q?name=a': ['text/plain', 'a'],
  '/d/q?name=b': ['text/plain', 'b'],
  '/d/lib/util.js': ['text/javascript', '// util'],
  '/d/my%20data.bin': ['application/octet-stream', Buffer.from([0, 255, 1, 254])],
  '/a/one.user.js': ['text/javascript', script('One')],
  '/a/one.md': ['text/markdown', '# One doc'],
  '/a/README.md': ['text/markdown', '# Dir readme'],
  '/b/two.user.js': ['text/javascript', script('Two')],
  '/b/two.md': ['text/html', '<html>Not found, but 200</html>'],
  '/install?id=3': ['text/javascript', script('Three')],
  '/links.html': ['text/html', '<a href="a/one.user.js">x</a> <a href="/b/two.user.js#frag">y</a> <a href="/a/one.user.js">again</a> <a href="/other">z</a>'],
  '/none.html': ['text/html', '<a href="/other">nothing</a>'],
  '/m/script_manifest.json': ['application/json', JSON.stringify({ scripts: [{ path: '../a/one.user.js' }, '../b/two.user.js'] })],
};

let server;
let origin;
let dir;

before(async () => {
  server = createServer((req, res) => {
    const page = PAGES[req.url];
    if (!page) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': page[0] });
    res.end(page[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  dir = await mkdtemp(path.join(tmpdir(), 'sm-gather-test-'));
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const names = (result) => result.scripts.map((s) => s.name);

test('a script URL is downloaded with the docs next to it', async () => {
  const out = path.join(dir, 'url');
  const result = await gather([`${origin}/a/one.user.js`], { out });
  assert.deepEqual(names(result), ['One']);
  const [s] = result.scripts;
  assert.equal(s.version, '1.0');
  assert.equal(s.downloaded, true);
  assert.equal(s.origin, `${origin}/a/one.user.js`);
  assert.ok(s.file.startsWith(out));
  assert.equal(await readFile(s.file, 'utf8'), script('One'));
  assert.deepEqual(s.docs.map((d) => path.basename(d.file)), ['one.md', 'README.md']);
  assert.equal(await readFile(s.docs[0].file, 'utf8'), '# One doc');
});

test('an HTML response is not taken as a doc', async () => {
  const result = await gather([`${origin}/b/two.user.js`], { out: path.join(dir, 'html-doc') });
  assert.deepEqual(result.scripts[0].docs, []);
});

test('a URL without .user.js is recognized by its metadata block and named .user.js', async () => {
  const result = await gather([`${origin}/install?id=3`], { out: path.join(dir, 'sniff') });
  assert.deepEqual(names(result), ['Three']);
  assert.ok(result.scripts[0].file.endsWith('.user.js'));
});

test('a page yields the scripts it links to, once each', async () => {
  const result = await gather([`${origin}/links.html`], { out: path.join(dir, 'page') });
  assert.deepEqual(names(result), ['One', 'Two']);
  assert.equal(new Set(result.scripts.map((s) => path.dirname(s.file))).size, 2);
});

test('a page with no scripts is an error, and other sources go on', async () => {
  const result = await gather([`${origin}/none.html`, `${origin}/a/one.user.js`], { out: path.join(dir, 'none') });
  assert.deepEqual(names(result), ['One']);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, `${origin}/none.html`);
});

test('a web manifest resolves entries against its own URL', async () => {
  const result = await gather([`${origin}/m/script_manifest.json`], { out: path.join(dir, 'manifest') });
  assert.deepEqual(names(result), ['One', 'Two']);
});

test('a missing download is reported per script', async () => {
  const result = await gather([`${origin}/gone.user.js`], { out: path.join(dir, 'gone') });
  assert.deepEqual(result.scripts, []);
  assert.match(result.errors[0].message, /HTTP 404/);
});

test('a script gets its name and version from its header, with absolute paths', async () => {
  const root = path.join(dir, 'header');
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'h.user.js');
  await writeFile(file, '// ==UserScript==\n// @name:de Name\n// @name N\n// @version 1.2\n// ==/UserScript==\n');
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const [script] = (await gather(['h.user.js'])).scripts;
    assert.equal(script.name, 'N');
    assert.equal(script.version, '1.2');
    assert.ok(path.isAbsolute(script.file));
    assert.ok(path.isAbsolute(script.origin));
  } finally {
    process.chdir(cwd);
  }
});

test('a local directory is walked in place, with docs, skipping node_modules', async () => {
  const root = path.join(dir, 'local');
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(root, 'sub', 'a.user.js'), script('A'));
  await writeFile(path.join(root, 'sub', 'a.md'), 'doc');
  await writeFile(path.join(root, 'sub', 'readme.md'), 'readme');
  await writeFile(path.join(root, 'sub', 'b.user.js'), script('B'));
  await writeFile(path.join(root, 'node_modules', 'x', 'c.user.js'), script('C'));

  const result = await gather([root]);
  assert.equal(result.out, undefined);
  assert.deepEqual(names(result), ['A', 'B']);
  const [a, b] = result.scripts;
  assert.equal(a.file, path.join(root, 'sub', 'a.user.js'));
  assert.equal(a.downloaded, false);
  assert.deepEqual(a.docs.map((d) => path.basename(d.file)), ['a.md', 'readme.md']);
  assert.deepEqual(b.docs.map((d) => path.basename(d.file)), ['readme.md']);
});

test('a local manifest lists scripts relative to itself, and a saved page gives its links', async () => {
  const root = path.join(dir, 'local-manifest');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'a.user.js'), script('A'));
  await writeFile(path.join(root, 'script_manifest.json'), JSON.stringify(['a.user.js']));
  await writeFile(path.join(root, 'saved.html'), `<!-- saved from url=(0020)${origin}/links.html --><a href="/a/one.user.js">x</a>`);

  const manifest = await gather([path.join(root, 'script_manifest.json')]);
  assert.deepEqual(names(manifest), ['A']);
  const page = await gather([path.join(root, 'saved.html')], { out: path.join(dir, 'saved'), allowHosts: ['127.0.0.1'] });
  assert.deepEqual(names(page), ['One']);
});

test('a missing local path is an error', async () => {
  const result = await gather([path.join(dir, 'nope.user.js')]);
  assert.deepEqual(result.scripts, []);
  assert.match(result.errors[0].message, /No such file/);
});

test('greasyForkId takes script pages and code URLs only', () => {
  const id = (href) => greasyForkId(new URL(href));
  assert.equal(id('https://greasyfork.org/en/scripts/14178-name'), '14178');
  assert.equal(id('https://greasyfork.org/zh-CN/scripts/14178-name/feedback'), '14178');
  assert.equal(id('https://greasyfork.org/scripts/14178'), '14178');
  assert.equal(id('https://update.greasyfork.org/scripts/14178/name.user.js'), '14178');
  assert.equal(id('https://greasyfork.org/en/scripts/by-site/youtube.com'), null);
  assert.equal(id('https://greasyfork.org/en/scripts?q=x'), null);
  assert.equal(id('https://example.com/scripts/14178'), null);
});

test('GitHub URLs map to raw files and trees', () => {
  assert.equal(githubRawUrl(new URL('https://github.com/o/r/blob/main/src/x.user.js')), 'https://raw.githubusercontent.com/o/r/main/src/x.user.js');
  assert.equal(githubRawUrl(new URL('https://github.com/o/r')), null);
  assert.deepEqual(githubTree(new URL('https://github.com/o/r')), { owner: 'o', repo: 'r', ref: null, dir: '' });
  assert.deepEqual(githubTree(new URL('https://github.com/o/r/tree/main/a/b')), { owner: 'o', repo: 'r', ref: 'main', dir: 'a/b' });
  assert.equal(githubTree(new URL('https://github.com/o/r/blob/main/x.js')), null);
});

test('linkedScripts takes script links and bare .user.js URLs, and resolves relative ones', () => {
  const html = `<a href="x.user.js">a</a> <a href='https://greasyfork.org/en/scripts/5-n'>b</a> <a href="https://greasyfork.org/en/scripts/by-site/a.com">c</a>
    See https://example.org/y.user.js for more. <a href="javascript:void(0).user.js">d</a>`;
  assert.deepEqual(linkedScripts(html, 'https://site.test/dir/page'), [
    'https://site.test/dir/x.user.js', 'https://greasyfork.org/en/scripts/5-n', 'https://example.org/y.user.js',
  ]);
});

test('manifestEntries takes all the shapes SourceMonkey does', () => {
  assert.deepEqual(manifestEntries('["a.user.js"]'), ['a.user.js']);
  assert.deepEqual(manifestEntries('[{"path":"a.user.js"}]'), ['a.user.js']);
  assert.deepEqual(manifestEntries('{"scripts":["a.user.js",{"path":"b.user.js"}]}'), ['a.user.js', 'b.user.js']);
  assert.throws(() => manifestEntries('{"x":1}'), /no list of scripts/);
});

test('safeFileName keeps a server from choosing a path', () => {
  assert.equal(safeFileName('https://x.test/a/..%2F..%2Fevil.user.js', { script: true }), '.._.._evil.user.js'.replace(/^\.+/, ''));
  assert.equal(safeFileName('https://x.test/plain.js', { script: true }), 'plain.user.js');
  assert.equal(safeFileName('https://x.test/install', { script: true }), 'install.user.js');
  assert.equal(safeFileName('https://x.test/', { script: true }), 'script.user.js');
  assert.ok(!safeFileName('https://x.test/%2e%2e%2f%2e%2e%2fetc', { script: true }).includes('/'));
});

test('greasyForkInfo keeps the additional info section as HTML', () => {
  const body = '<h2>Help</h2><div class="note"><table><tr><td>Use &amp; enjoy</td></tr></table></div>';
  const html = `<section id="script-info"><div id="additional-info" class="user-content" lang="en">${body}<script>x()</script>\n</div>\n</div>\n</section><p>after</p>`;
  assert.equal(greasyForkInfo(html), `<!doctype html>\n<meta charset="utf-8">\n${body}`);
  assert.equal(greasyForkInfo('<p>nothing</p>'), null);
  assert.equal(greasyForkInfo('<div id="additional-info"><p> </p></div></section>'), null);
  assert.match(greasyForkInfo('<div id="additional-info"><img src="a.png"></div></section>'), /<img src="a\.png">$/);
});

test('declaredDependencies reads @require and @resource from the header only', () => {
  const body = withDeps('D', ['@require a.js', '@resource css https://x.test/c.css', '@resource https://x.test/bare.css', '@require a.js']);
  assert.deepEqual(declaredDependencies(`${body}// @require not-header.js\n`), ['a.js', 'https://x.test/c.css', 'https://x.test/bare.css']);
});

test('standInPath gives the path sm-dev looks in for a URL', () => {
  const at = (url) => standInPath('/r', new URL(url));
  assert.equal(at('https://cdn.test:8080/npm/@a/b%20c.js?v=1#sha256=x'), path.join('/r', 'cdn.test:8080', 'npm', '@a', 'b c.js'));
  assert.equal(at('https://cdn.test/a/../../../b.js'), path.join('/r', 'cdn.test', 'b.js'));
  assert.equal(at('https://cdn.test/'), null);
  assert.equal(at('https://cdn.test/dir/'), null);
  assert.equal(at('https://cdn.test/a%2fb.js'), null);
  assert.equal(at('https://../x.js'), null);
});

test('isPrivateHost picks out this machine and its local network', () => {
  for (const host of ['localhost', 'localhost.', 'a.localhost', 'nas.local', 'nas.local.', '127.0.0.1', '0.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '[::1]', '[fd00::1]', '[::ffff:7f00:1]']) {
    assert.ok(isPrivateHost(host), host);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', 'local.example.com']) assert.ok(!isPrivateHost(host), host);
});

test('a downloaded script gets its dependencies where sm-dev finds them', async () => {
  PAGES['/d/deps.user.js'] = ['text/javascript', withDeps('Deps', [
    '@require lib/util.js',
    `@require ${origin}/d/lib/util.js`,
    `@resource data ${origin}/d/my%20data.bin`,
    '@resource inline data:text/plain,hi',
    `@require ${origin}/d/missing.js`,
    '@require ../outside.js',
  ])];
  const out = path.join(dir, 'deps');
  const result = await gather([`${origin}/d/deps.user.js`], { out });
  const [s] = result.scripts;
  const scriptDir = path.dirname(s.file);
  const host = new URL(origin).host;
  assert.deepEqual(s.dependencies.map((d) => path.relative(scriptDir, d.file)), [
    path.join('lib', 'util.js'),
    path.join(host, 'd', 'lib', 'util.js'),
    path.join(host, 'd', 'my data.bin'),
  ]);
  assert.equal(s.localRoot, undefined);
  assert.equal(await readFile(s.dependencies[1].file, 'utf8'), '// util');
  assert.deepEqual([...await readFile(s.dependencies[2].file)], [0, 255, 1, 254]);
  assert.deepEqual(result.errors.map((e) => e.source).sort(), [`${origin}/d/missing.js`, '../outside.js'].sort());
  assert.ok(result.errors.every((e) => e.script === `${origin}/d/deps.user.js`));
  assert.match(result.errors.find((e) => e.source.endsWith('missing.js')).message, /HTTP 404/);
});

test('a dependency can\'t overwrite the script', async () => {
  PAGES['/d/self.user.js'] = ['text/javascript', withDeps('Self', ['@require self.user.js'])];
  const result = await gather([`${origin}/d/self.user.js`], { out: path.join(dir, 'self') });
  const [s] = result.scripts;
  assert.deepEqual(s.dependencies, []);
  assert.match(result.errors[0].message, /already has a file/);
  assert.equal(await readFile(s.file, 'utf8'), PAGES['/d/self.user.js'][1]);
});

test('a local script can\'t make it fetch from a private address', async () => {
  const root = path.join(dir, 'local-deps');
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'l.user.js');
  await writeFile(file, withDeps('L', ['@require beside.js', `@require ${origin}/d/lib/util.js`]));
  const out = path.join(dir, 'local-deps-out');
  const result = await gather([file], { out });
  const [s] = result.scripts;
  assert.equal(s.file, file);
  assert.deepEqual(s.dependencies, []);
  assert.equal(s.localRoot, undefined);
  assert.equal(result.errors[0].source, `${origin}/d/lib/util.js`);
  assert.equal(result.errors[0].script, file);
  assert.match(result.errors[0].message, /local network.*--allow-host 127\.0\.0\.1/);
});

test('a local script\'s remote dependencies go under --out, with a localRoot', async () => {
  const root = path.join(dir, 'local-root');
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'r.user.js');
  await writeFile(file, withDeps('R', ['@require beside.js', `@require ${origin}/d/lib/util.js`]));
  const out = path.join(dir, 'local-root-out');
  const result = await gather([file], { out, allowHosts: ['127.0.0.1'] });
  assert.deepEqual(result.errors, []);
  const [s] = result.scripts;
  assert.equal(s.file, file);
  assert.equal(path.dirname(s.localRoot), out);
  assert.deepEqual(s.dependencies, [{
    url: `${origin}/d/lib/util.js`,
    file: path.join(s.localRoot, new URL(origin).host, 'd', 'lib', 'util.js'),
  }]);
  assert.equal(await readFile(s.dependencies[0].file, 'utf8'), '// util');
});

test('a second gather into the same --out gets new folders and all its dependencies', async () => {
  PAGES['/d/again.user.js'] = ['text/javascript', withDeps('Again', [`@require ${origin}/d/lib/util.js`])];
  const out = path.join(dir, 'again');
  const first = await gather([`${origin}/d/again.user.js`], { out });
  const second = await gather([`${origin}/d/again.user.js`], { out });
  assert.deepEqual(second.errors, []);
  assert.equal(second.scripts[0].dependencies.length, 1);
  assert.notEqual(path.dirname(second.scripts[0].file), path.dirname(first.scripts[0].file));
});

test('URLs differing only by query both stay unsaved, and a repeat with a hash is one', async () => {
  PAGES['/d/query.user.js'] = ['text/javascript', withDeps('Query', [
    `@resource a ${origin}/d/q?name=a`,
    `@resource b ${origin}/d/q?name=b`,
    `@require ${origin}/d/lib/util.js#sha256=abc`,
    `@require ${origin}/d/lib/util.js`,
  ])];
  const result = await gather([`${origin}/d/query.user.js`], { out: path.join(dir, 'query') });
  assert.deepEqual(result.scripts[0].dependencies.map((d) => d.url), [`${origin}/d/lib/util.js`]);
  assert.deepEqual(result.errors.map((e) => e.source), [`${origin}/d/q?name=a`, `${origin}/d/q?name=b`]);
  assert.match(result.errors[0].message, /same local path/);
});

test('a web page showing a metadata block is read for its links', async () => {
  const result = await gather([`${origin}/tutorial.html`], { out: path.join(dir, 'tutorial') });
  assert.deepEqual(names(result), ['One']);
});

test('links on a page can\'t reach a private host that no source names', async () => {
  const root = path.join(dir, 'private-link');
  await mkdir(root, { recursive: true });
  const page = path.join(root, 'page.html');
  await writeFile(page, `<a href="${origin}/a/one.user.js">x</a>`);
  const result = await gather([page], { out: path.join(dir, 'private-link-out') });
  assert.deepEqual(result.scripts, []);
  assert.match(result.errors[0].message, /local network/);
});

test('a redirect to a private host isn\'t followed', async () => {
  const { result, asked } = await withFetch({
    'https://public.test/r.user.js': new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } }),
  }, () => gather(['https://public.test/r.user.js'], { out: path.join(dir, 'redirect') }));
  assert.deepEqual(asked, ['https://public.test/r.user.js']);
  assert.match(result.errors[0].message, /192\.168\.1\.1.*local network/);
});

test('a fetch that can\'t connect gives the reason', async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${closed.address().port}/x.user.js`;
  await new Promise((resolve) => closed.close(resolve));
  const result = await gather([url], { out: path.join(dir, 'closed') });
  assert.match(result.errors[0].message, /^Fetching .* failed: .*ECONNREFUSED/);
});

test('a public redirect is followed', async () => {
  const { result } = await withFetch({
    'https://public.test/r.user.js': new Response(null, { status: 302, headers: { location: '/real.user.js' } }),
    'https://public.test/real.user.js': new Response(script('Real')),
  }, () => gather(['https://public.test/r.user.js'], { out: path.join(dir, 'redirect-ok') }));
  assert.deepEqual(names(result), ['Real']);
});

test('a failed GitHub listing is reported, and the page is still read', async () => {
  const { result } = await withFetch({
    'https://api.github.com/repos/o/r': new Response('rate limited', { status: 403 }),
    'https://github.com/o/r': new Response('<a href="https://public.test/one.user.js">x</a>'),
    'https://public.test/one.user.js': new Response(script('Linked')),
  }, () => gather(['https://github.com/o/r'], { out: path.join(dir, 'gh-fail') }));
  assert.deepEqual(names(result), ['Linked']);
  assert.match(result.errors[0].message, /Listing this repo's files failed.*HTTP 403/);
});

test('a GitHub directory with an encoded name finds its scripts, and a cut-short list is reported', async () => {
  const tree = { truncated: true, tree: [
    { type: 'blob', path: 'My Scripts/a.user.js' },
    { type: 'blob', path: 'other/b.user.js' },
  ] };
  const { result } = await withFetch({
    'https://api.github.com/repos/o/r/git/trees/main?recursive=1': new Response(JSON.stringify(tree)),
    'https://raw.githubusercontent.com/o/r/main/My%20Scripts/a.user.js': new Response(script('A')),
  }, () => gather(['https://github.com/o/r/tree/main/My%20Scripts'], { out: path.join(dir, 'gh-tree') }));
  assert.deepEqual(names(result), ['A']);
  assert.match(result.errors[0].message, /only part of this repo's file list/);
});

test('a Greasy Fork script gets its code, additional info and dependencies', async () => {
  const code = 'https://update.greasyfork.org/scripts/5/s.user.js';
  const { result } = await withFetch({
    'https://api.greasyfork.org/scripts/5.json': new Response(JSON.stringify({ url: 'https://greasyfork.org/scripts/5-s', code_url: code })),
    [code]: new Response(withDeps('GF', ['@require https://cdn.test/lib.js'])),
    'https://greasyfork.org/scripts/5-s': new Response('<div id="additional-info"><table><tr><td>Info</td></tr></table></div></section>'),
    'https://cdn.test/lib.js': new Response('// lib'),
  }, () => gather(['https://greasyfork.org/en/scripts/5-s'], { out: path.join(dir, 'gf') }));
  assert.deepEqual(result.errors, []);
  const [s] = result.scripts;
  assert.equal(s.origin, 'https://greasyfork.org/scripts/5-s');
  assert.equal(path.basename(s.docs[0].file), 'greasyfork-additional-info.html');
  assert.match(await readFile(s.docs[0].file, 'utf8'), /<table>/);
  assert.equal(await readFile(path.join(path.dirname(s.file), 'cdn.test', 'lib.js'), 'utf8'), '// lib');
});

test('scripts sharing a dependency each get a copy', async () => {
  PAGES['/d/s1.user.js'] = ['text/javascript', withDeps('S1', [`@require ${origin}/d/lib/util.js`])];
  PAGES['/d/s2.user.js'] = ['text/javascript', withDeps('S2', [`@require ${origin}/d/lib/util.js`])];
  const result = await gather([`${origin}/d/s1.user.js`, `${origin}/d/s2.user.js`], { out: path.join(dir, 'shared') });
  const [a, b] = result.scripts.map((s) => s.dependencies[0].file);
  assert.notEqual(a, b);
  assert.equal(await readFile(b, 'utf8'), '// util');
});
