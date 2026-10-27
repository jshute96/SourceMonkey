import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultCopyName,
  dependencyFiles,
  downloadsDirFromSaved,
  findDownloadsCollection,
  isCopyOfItself,
  mirrorPath,
  relativeRefPath,
  parseDownloadsCopiesSetting,
  planFiles,
  rewriteHeaderTags,
  validateCopyName,
  COPY_NAME_BAD_CHARS,
  COPY_NAME_NOT_RELATIVE,
  COPY_NAME_NOT_USERSCRIPT,
  COPY_NAME_REQUIRED,
  COPY_NAME_TOO_DEEP,
} from '../../dist/extension/local-copy.js';

// A stored row with just the fields the copy logic reads.
function script(overrides = {}) {
  return {
    id: 'id-1',
    collectionId: 'c-1',
    relativePath: 'https://example.com/scripts/Hello%20World.user.js',
    fileUrl: 'https://example.com/scripts/Hello%20World.user.js',
    status: 'ok',
    size: 10,
    leadingText: '',
    headerText: '// ==UserScript==\n// @name        Hello\n// @version     1.2\n// ==/UserScript==',
    bodyText: 'console.log(1);\n',
    header: null,
    matching: {},
    loadedAt: 0,
    enabled: true,
    ...overrides,
  };
}

test('validateCopyName: the shapes the download and the scan refuse', () => {
  assert.equal(validateCopyName('foo.user.js'), null);
  assert.equal(validateCopyName('a/b/foo.user.js'), null);
  assert.equal(validateCopyName('  '), COPY_NAME_REQUIRED);
  assert.equal(validateCopyName('foo.js'), COPY_NAME_NOT_USERSCRIPT);
  assert.equal(validateCopyName('.user.js'), COPY_NAME_NOT_USERSCRIPT);
  assert.equal(validateCopyName('/foo.user.js'), COPY_NAME_NOT_RELATIVE);
  assert.equal(validateCopyName('../foo.user.js'), COPY_NAME_NOT_RELATIVE);
  assert.equal(validateCopyName('a//foo.user.js'), COPY_NAME_NOT_RELATIVE);
  assert.equal(validateCopyName('a/b/c/foo.user.js'), COPY_NAME_TOO_DEEP);
  assert.equal(validateCopyName('a:b.user.js'), COPY_NAME_BAD_CHARS);
  assert.equal(validateCopyName('a\\b.user.js'), COPY_NAME_BAD_CHARS);
});

test('defaultCopyName: the decoded basename, made a .user.js', () => {
  assert.equal(defaultCopyName(script()), 'Hello World.user.js');
  assert.equal(
    defaultCopyName(script({ relativePath: 'https://example.com/x/lib.js', fileUrl: 'https://example.com/x/lib.js' })),
    'lib.user.js',
  );
});

test('isCopyOfItself: the target is the file the script is loaded from', () => {
  const local = script({
    relativePath: 'Hello World.user.js',
    fileUrl: 'file:///home/me/Downloads/SourceMonkey/Hello%20World.user.js',
  });
  assert.ok(isCopyOfItself(local, '/home/me/Downloads/SourceMonkey', 'Hello World.user.js'));
  assert.ok(!isCopyOfItself(local, '/home/me/Downloads/SourceMonkey', 'Hello World-2.user.js'));
  assert.ok(!isCopyOfItself(local, '/home/me/Other', 'Hello World.user.js'));
  assert.ok(!isCopyOfItself(script(), '/home/me/Downloads/SourceMonkey', 'Hello World.user.js'));
});

test('downloadsDirFromSaved: the reported path minus what we asked for', () => {
  assert.equal(downloadsDirFromSaved('/home/me/Downloads/SourceMonkey/a.user.js', 'SourceMonkey/a.user.js'), '/home/me/Downloads');
  assert.equal(downloadsDirFromSaved('/home/me/Elsewhere/a.user.js', 'SourceMonkey/a.user.js'), null);
  assert.equal(downloadsDirFromSaved('/SourceMonkey/a.user.js', 'SourceMonkey/a.user.js'), null);
});

test('rewriteHeaderTags: replaces a value in place, keeping the spacing', () => {
  const src = '// ==UserScript==\n// @name        Hello\n// @version     1.2\n// ==/UserScript==\nbody\n';
  assert.equal(
    rewriteHeaderTags(src, { version: '1.2-local' }),
    '// ==UserScript==\n// @name        Hello\n// @version     1.2-local\n// ==/UserScript==\nbody\n',
  );
});

test('rewriteHeaderTags: adds a missing tag after @name, aligned to it', () => {
  const src = '// ==UserScript==\n// @name        Hello\n// @match       *://*/*\n// ==/UserScript==\nbody\n';
  assert.equal(
    rewriteHeaderTags(src, { description: 'A thing' }),
    '// ==UserScript==\n// @name        Hello\n// @description A thing\n// @match       *://*/*\n// ==/UserScript==\nbody\n',
  );
  // No @name to align to: straight after the opening marker.
  const bare = '// ==UserScript==\n// @match *://*/*\n// ==/UserScript==\nbody\n';
  assert.equal(
    rewriteHeaderTags(bare, { version: '1' }),
    '// ==UserScript==\n// @version 1\n// @match *://*/*\n// ==/UserScript==\nbody\n',
  );
});

test('rewriteHeaderTags: an empty value removes the line; undefined leaves it', () => {
  const src = '// ==UserScript==\n// @name  Hello\n// @description  Old\n// @version  1\n// ==/UserScript==\nbody\n';
  assert.equal(
    rewriteHeaderTags(src, { description: '' }),
    '// ==UserScript==\n// @name  Hello\n// @version  1\n// ==/UserScript==\nbody\n',
  );
  assert.equal(rewriteHeaderTags(src, {}), src);
  assert.equal(rewriteHeaderTags(src, { description: '' , version: '' }),
    '// ==UserScript==\n// @name  Hello\n// ==/UserScript==\nbody\n');
});

test('rewriteHeaderTags: CRLF endings and localized tags survive', () => {
  const src = '// ==UserScript==\r\n// @name Hello\r\n// @description:de Hallo\r\n// @version 1\r\n// ==/UserScript==\r\nbody\r\n';
  assert.equal(
    rewriteHeaderTags(src, { version: '2', description: 'Hi' }),
    '// ==UserScript==\r\n// @name Hello\r\n// @description Hi\r\n// @description:de Hallo\r\n// @version 2\r\n// ==/UserScript==\r\nbody\r\n',
  );
});

test('rewriteHeaderTags: no metadata block, nothing to write', () => {
  assert.equal(rewriteHeaderTags('just code\n', { version: '1' }), 'just code\n');
});

test('mirrorPath: host then path, decoded, unwritable names skipped, directories refused', () => {
  assert.equal(mirrorPath('https://cdn.example.com/lib/util.js'), 'cdn.example.com/lib/util.js');
  // A port puts a `:` in the host directory, which chrome.downloads
  // refuses — so the next-longest suffix is used.
  assert.equal(mirrorPath('http://localhost:8080/lib/a%20b.js'), 'lib/a b.js');
  assert.equal(mirrorPath('http://localhost:8080/a%3Ab.js'), null);
  assert.equal(mirrorPath('https://cdn.example.com/lib/'), null);
  assert.equal(mirrorPath('not a url'), null);
});

test('dependencyFiles: requires and resources, deduped, data: skipped', () => {
  const s = script({
    requires: [
      { ref: 'https://cdn.example.com/lib/a.js', url: 'https://cdn.example.com/lib/a.js', source: 'A', size: 1, contentHash: '', loadedAt: 0 },
      { ref: 'https://cdn.example.com/lib/a.js', url: 'https://cdn.example.com/lib/a.js', source: 'A', size: 1, contentHash: '', loadedAt: 0 },
      { ref: 'data:text/javascript,1', url: 'data:text/javascript,1', source: '1', size: 1, contentHash: '', loadedAt: 0 },
    ],
    resources: [
      { ref: 'https://cdn.example.com/img.png', url: 'https://cdn.example.com/img.png', name: 'img', bytesBase64: 'AQID', contentType: 'image/png', size: 3, contentHash: '', loadedAt: 0 },
    ],
  });
  const files = dependencyFiles(s);
  assert.deepEqual(files.map((f) => f.relativePath), ['cdn.example.com/lib/a.js', 'cdn.example.com/img.png']);
  assert.equal(files[0].size, 1);
  assert.equal(files[1].size, 3);
  assert.equal(files[1].body.type, 'image/png');
});

test('relativeRefPath: under the script folder, decoded, never climbing out', () => {
  assert.equal(relativeRefPath('lib/util.js'), 'lib/util.js');
  assert.equal(relativeRefPath('./lib/a%20b.js'), 'lib/a b.js');
  assert.equal(relativeRefPath('lib/util.js?v=2'), 'lib/util.js');
  assert.equal(relativeRefPath('lib/../x.js'), 'x.js');
  assert.equal(relativeRefPath('../x.js'), null);
  assert.equal(relativeRefPath('lib/'), null);
  assert.equal(relativeRefPath('..%2F..%2Fx.js'), null);
});

test('dependencyFiles: a relative ref goes at its own path, local or remote', () => {
  const req = (ref, url) => ({ ref, url, source: 'X', size: 1, contentHash: '', loadedAt: 0 });
  const local = script({
    fileUrl: 'file:///home/me/scripts/hello.user.js',
    requires: [
      req('lib/util.js', 'file:///home/me/scripts/lib/util.js'),
      req('a%3Ab.js', 'file:///home/me/scripts/a:b.js'),
      req('https://cdn.example.com/a.js', 'https://cdn.example.com/a.js'),
    ],
    resources: [
      { ref: 'img/x.png', url: 'file:///home/me/scripts/img/x.png', name: 'x', bytesBase64: 'AQID', contentType: 'image/png', size: 3, contentHash: '', loadedAt: 0 },
    ],
  });
  assert.deepEqual(dependencyFiles(local).map((f) => f.relativePath), ['lib/util.js', 'cdn.example.com/a.js', 'img/x.png']);
  const remote = script({
    fileUrl: 'https://example.com/scripts/hello.user.js',
    requires: [req('lib/util.js', 'https://example.com/scripts/lib/util.js'), req('../up.js', 'https://example.com/up.js')],
  });
  assert.deepEqual(dependencyFiles(remote).map((f) => f.relativePath), ['lib/util.js']);
});

test('planFiles: the script first, dependencies under its own folder', () => {
  const s = script({
    requires: [{ ref: 'https://cdn.example.com/a.js', url: 'https://cdn.example.com/a.js', source: 'A', size: 1, contentHash: '', loadedAt: 0 }],
  });
  const plan = { fileName: 'sub/hello.user.js', version: '9', description: 'D', includeDependencies: true };
  const files = planFiles(s, plan);
  assert.deepEqual(files.map((f) => f.relativePath), ['sub/hello.user.js', 'sub/cdn.example.com/a.js']);
  const without = planFiles(s, { ...plan, includeDependencies: false });
  assert.deepEqual(without.map((f) => f.relativePath), ['sub/hello.user.js']);
});

test('planFiles: the script text carries the header edits', async () => {
  const s = script();
  const [file] = planFiles(s, { fileName: 'h.user.js', version: '1.2-local', description: 'New', includeDependencies: false });
  assert.equal(
    await file.body.text(),
    '// ==UserScript==\n// @name        Hello\n// @description New\n// @version     1.2-local\n// ==/UserScript==\nconsole.log(1);\n',
  );
});

test('findDownloadsCollection: by id, then by path, never a moved id', () => {
  const setting = { downloadsDir: '/home/me/Downloads', collectionId: 'c-1' };
  const here = { id: 'c-1', path: '/home/me/Downloads/SourceMonkey', lastRefreshedAt: 0, scriptIds: [], enabled: true };
  const moved = { id: 'c-1', path: '/old/Downloads/SourceMonkey', lastRefreshedAt: 0, scriptIds: [], enabled: true };
  const byHand = { id: 'c-2', path: 'file:///home/me/Downloads/SourceMonkey/', lastRefreshedAt: 0, scriptIds: [], enabled: true };
  assert.equal(findDownloadsCollection(setting, [here]), here);
  assert.equal(findDownloadsCollection(setting, [moved]), null);
  assert.equal(findDownloadsCollection(setting, [moved, byHand]), byHand);
  assert.equal(findDownloadsCollection({ ...setting, collectionId: null }, [byHand]), byHand);
  assert.equal(findDownloadsCollection(null, [here]), null);
});

test('parseDownloadsCopiesSetting: tolerant of what storage holds', () => {
  assert.deepEqual(parseDownloadsCopiesSetting({ downloadsDir: '/d', collectionId: 'x' }), { downloadsDir: '/d', collectionId: 'x' });
  assert.deepEqual(parseDownloadsCopiesSetting({ downloadsDir: '/d' }), { downloadsDir: '/d', collectionId: null });
  assert.equal(parseDownloadsCopiesSetting({ collectionId: 'x' }), null);
  assert.equal(parseDownloadsCopiesSetting(undefined), null);
  assert.equal(parseDownloadsCopiesSetting('nope'), null);
});
