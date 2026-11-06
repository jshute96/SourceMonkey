// `download-scripts.mjs --update` and `record-results.mjs list --stale`, `--gone`
// and `--not-gone`, run as the real CLIs against a local stand-in for GreasyFork's API and file host.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mirrorUrl } from '../../greasyfork-testing/corpus.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.resolve(here, '../../greasyfork-testing');

const script = (version, extra = '') =>
  `// ==UserScript==\n// @name S\n// @version ${version}\n${extra}// ==/UserScript==\nconsole.info(1);\n`;

/** A temp corpus and download root, with a server answering from `routes`. */
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-update-'));
  const routes = new Map();
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    let route = routes.get(req.url);
    if (typeof route === 'function') route = route(req);
    if (route === undefined) { res.writeHead(404); res.end(); return; }
    if (typeof route === 'number') { res.writeHead(route); res.end(); return; }
    res.end(typeof route === 'string' ? route : JSON.stringify(route));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const corpusFile = path.join(dir, 'corpus.json');
  const root = path.join(dir, 'files');
  const hostDir = path.join(root, new URL(origin).host);

  const env = {
    origin, routes, asked, root, corpusFile,
    /** A corpus record, its copy on disk, and the API row saying nothing changed. */
    addScript(corpus, id, { version, body = script(version), date = '2026-01-01' }) {
      const url = `${origin}/${id}.user.js`;
      corpus.scripts[id] = {
        listing: { name: `Script ${id}`, script_url: url, total_installs: 1, updated_date: date },
        version,
      };
      fs.mkdirSync(hostDir, { recursive: true });
      fs.writeFileSync(path.join(hostDir, `${id}.user.js`), body);
      routes.set(`/${id}.user.js`, body);
      routes.set(`/en/scripts/${id}.json`, env.apiRow(id, version, date));
    },
    apiRow: (id, version, date, name = `Script ${id}`) => ({
      id, name, url: `https://greasyfork.org/scripts/${id}-s`, code_url: `https://example.test/renamed/${id}.user.js`,
      total_installs: 5, version, code_updated_at: `${date}T00:00:00.000Z`, created_at: '2020-01-01T00:00:00.000Z',
    }),
    writeDep(name, text) {
      fs.mkdirSync(hostDir, { recursive: true });
      fs.writeFileSync(path.join(hostDir, name), text);
    },
    readDep: (name) => fs.readFileSync(path.join(hostDir, name), 'utf8'),
    save: (corpus) => fs.writeFileSync(corpusFile, JSON.stringify(corpus)),
    load: () => JSON.parse(fs.readFileSync(corpusFile, 'utf8')),
    async run() {
      return execFileAsync(process.execPath, [
        path.join(tools, 'download-scripts.mjs'), '--update', '--api-origin', origin, '--corpus', corpusFile,
        '--root', root, '--delay', '0', '--report', path.join(dir, 'report.json'),
      ]);
    },
    report: () => JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')),
  };
  return env;
}

test('--update downloads a changed script and its files, and leaves the others alone', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  const dep = `// @require ${env.origin}/dep.js\n`;
  env.addScript(corpus, 1, { version: '1.0', body: script('1.0', dep) });
  env.addScript(corpus, 2, { version: '1.0', body: script('1.0', `// @require ${env.origin}/other.js\n`) });
  env.save(corpus);
  env.writeDep('dep.js', 'old dep');
  env.writeDep('other.js', 'old other');
  env.routes.set('/dep.js', 'new dep');
  env.routes.set('/other.js', 'new other');
  env.routes.set('/new.js', 'brand new');

  env.routes.set('/1.user.js', script('2.0', `${dep}// @require ${env.origin}/new.js\n`));
  env.routes.set('/en/scripts/1.json', env.apiRow(1, '2.0', '2026-06-01', 'New name'));

  const { stdout } = await env.run();

  assert.equal(env.readDep('dep.js'), 'new dep', 'a changed script refreshes a file at the same URL');
  assert.equal(env.readDep('new.js'), 'brand new', 'and fetches a newly named one');
  assert.equal(env.readDep('other.js'), 'old other', "an unchanged script's file stays");
  assert.ok(!env.asked.includes('/2.user.js'), 'an unchanged script is not downloaded');
  assert.ok(!env.asked.includes('/other.js'), 'nor are its files');
  assert.match(stdout, /changed 1 Script 1: v1\.0 → v2\.0/);
  assert.match(stdout, /changed .*\/dep\.js/);

  const { scripts } = env.load();
  assert.equal(scripts[1].listing.updated_date, '2026-06-01');
  assert.equal(scripts[1].listing.name, 'Script 1', "the API's name for one script isn't the English one");
  assert.equal(scripts[1].listing.script_url, `${env.origin}/1.user.js`, 'the URL, and so the path, stays');
  assert.equal(scripts[1].listing.total_installs, 5, 'a downloaded script gets fresh counts');
  assert.match(scripts[1].listing.as_of, /^\d{4}-\d{2}-\d{2}$/, 'with their date');
  assert.deepEqual(scripts[2].listing, corpus.scripts[2].listing, "an unchanged script's listing stays");
  assert.equal(scripts[1].version, '1.0', 'the record\'s version is validate\'s to change');
});

test('--update reports a same-version edit, and not a same-bytes upload', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0' });
  env.addScript(corpus, 2, { version: '1.0' });
  env.save(corpus);
  env.routes.set('/1.user.js', `${script('1.0')}console.info(2);\n`);
  env.routes.set('/en/scripts/1.json', env.apiRow(1, '1.0', '2026-06-01'));
  env.routes.set('/en/scripts/2.json', env.apiRow(2, '1.0', '2026-06-01'));

  const { stdout } = await env.run();

  assert.match(stdout, /changed 1 Script 1: v1\.0, the same version/);
  assert.doesNotMatch(stdout, /changed 2 /);
  assert.deepEqual(env.report().update.sameVersion, [1]);
});

test('--update goes by the date for a copy with no version', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  const style = '/* ==UserStyle==\n@version 76\n==/UserStyle== */\n';
  env.addScript(corpus, 1, { version: undefined, body: style });
  env.addScript(corpus, 2, { version: undefined, body: style });
  env.save(corpus);
  env.routes.set('/en/scripts/1.json', env.apiRow(1, '76', '2026-01-01'));
  env.routes.set('/en/scripts/2.json', env.apiRow(2, '77', '2026-06-01'));
  env.routes.set('/2.user.js', `${style}/* new */\n`);

  await env.run();

  const { scripts } = env.load();
  assert.deepEqual(scripts[1].listing, corpus.scripts[1].listing, 'the same date: not downloaded');
  assert.equal(scripts[2].listing.updated_date, '2026-06-01');
  assert.equal(env.readDep('2.user.js'), `${style}/* new */\n`);
});

test('--update keeps the copy of a gone or failed script, and retries the failed one', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0' });
  env.addScript(corpus, 2, { version: '1.0' });
  env.addScript(corpus, 3, { version: '1.0' });
  env.save(corpus);
  env.routes.delete('/en/scripts/1.json');
  env.routes.set('/en/scripts/2.json', { ...env.apiRow(2, '1.0', '2026-01-01'), deleted: true });
  env.routes.set('/en/scripts/3.json', env.apiRow(3, '2.0', '2026-06-01'));
  env.routes.delete('/3.user.js');

  const { stdout } = await env.run();

  assert.match(stdout, /gone {4}1 Script 1/);
  assert.match(stdout, /gone {4}2 Script 2/);
  assert.match(stdout, /failed {2}3 Script 3: HTTP 404/);
  assert.equal(env.readDep('3.user.js'), script('1.0'));
  assert.equal(env.load().scripts[3].listing.updated_date, '2026-01-01', 'so the next run still sees it as changed');

  env.routes.set('/3.user.js', script('2.0'));
  await env.run();
  assert.equal(env.readDep('3.user.js'), script('2.0'));
  assert.equal(env.load().scripts[3].listing.updated_date, '2026-06-01');
});

test('--update stops at a 429, and the next run picks up what it missed', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0', body: script('1.0', `// @require ${env.origin}/dep.js\n`) });
  env.save(corpus);
  env.writeDep('dep.js', 'old dep');
  env.routes.set('/en/scripts/1.json', env.apiRow(1, '2.0', '2026-06-01'));
  env.routes.set('/1.user.js', script('2.0', `// @require ${env.origin}/dep.js\n`));
  env.routes.set('/dep.js', 429);

  await assert.rejects(env.run(), (err) => err.code === 1 && /run stopped early/.test(err.stdout));
  assert.equal(env.load().scripts[1].listing.updated_date, '2026-01-01');

  env.routes.set('/dep.js', 'new dep');
  await env.run();
  assert.equal(env.readDep('dep.js'), 'new dep');
  assert.equal(env.load().scripts[1].listing.updated_date, '2026-06-01');
});

test('--update refuses --force and --include', async () => {
  for (const args of [['--force'], ['--include', 'scripts']]) {
    await assert.rejects(
      execFileAsync(process.execPath, [path.join(tools, 'download-scripts.mjs'), '--update', ...args]),
      /takes neither/,
    );
  }
});

test('mirrorUrl keeps a pinned version pinned', () => {
  const mirror = 'https://update.greasyfork.org';
  assert.equal(mirrorUrl('https://greasyfork.org/scripts/1-lib/code/L.js'), `${mirror}/scripts/1/L.js`);
  assert.equal(mirrorUrl('https://greasyfork.org/en/scripts/1-lib/code/L.js?version=7'), `${mirror}/scripts/1/7/L.js`);
  assert.equal(mirrorUrl(`${mirror}/scripts/1/L.js?version=7`), `${mirror}/scripts/1/7/L.js`);
  assert.equal(mirrorUrl(`${mirror}/scripts/1/7/L.js`), null);
  assert.equal(mirrorUrl('https://greasyfork.org/libraries/a/1/L.js'), `${mirror}/libraries/a/1/L.js`);
  assert.equal(mirrorUrl('https://example.test/L.js?version=7'), null);
});

test('--update retries a 403 with its own user agent', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0', body: script('1.0', `// @require ${env.origin}/dep.js\n`) });
  env.save(corpus);
  env.routes.set('/en/scripts/1.json', env.apiRow(1, '2.0', '2026-06-01'));
  env.routes.set('/1.user.js', script('2.0', `// @require ${env.origin}/dep.js\n`));
  env.routes.set('/dep.js', (req) => (/Chrome/.test(req.headers['user-agent']) ? 403 : 'dep'));
  await env.run();
  assert.equal(env.readDep('dep.js'), 'dep');
});

/** Script 1, changed, naming the files given, with their routes set. */
function changedScript(env, files) {
  const corpus = { tags: {}, scripts: {} };
  const requires = Object.keys(files).map((name) => `// @require ${env.origin}/${name}\n`).join('');
  env.addScript(corpus, 1, { version: '1.0', body: script('1.0', requires) });
  env.save(corpus);
  env.routes.set('/1.user.js', script('2.0', requires));
  env.routes.set('/en/scripts/1.json', env.apiRow(1, '2.0', '2026-06-01'));
  for (const [name, route] of Object.entries(files)) env.routes.set(`/${name}`, route);
}

test('--update retries a script whose file failed in a way that may pass', async (t) => {
  const env = await setup(t);
  changedScript(env, { 'dep.js': 500 });

  const { stdout } = await env.run();

  assert.match(stdout, /retry {3}1 Script 1/);
  assert.match(stdout, /failed {2}.*\/dep\.js: HTTP 500/);
  assert.equal(env.load().scripts[1].listing.updated_date, '2026-01-01');

  env.routes.set('/dep.js', 'dep');
  const second = await env.run();
  assert.equal(env.readDep('dep.js'), 'dep');
  assert.equal(env.load().scripts[1].listing.updated_date, '2026-06-01');
  assert.match(second.stdout, /0 scripts changed, 1 downloaded\. Next: `record-results\.mjs validate`/);
});

test("--update doesn't retry for a file a 404 or 403 refused, and lists skipped files", async (t) => {
  const env = await setup(t);
  changedScript(env, { 'a.js': 404, 'b.js': 403, 'c.js': 403, 'd.js': 403, 'e.js': 403 });

  const { stdout } = await env.run();

  assert.match(stdout, /failed {2}.*\/a\.js: HTTP 404/);
  assert.match(stdout, /failed {2}.*\/d\.js: HTTP 403/);
  assert.match(stdout, /failed {2}.*\/e\.js: .*gave up after 3 strikes/, 'the one skipped after the cutoff');
  assert.doesNotMatch(stdout, /retry {3}/);
  assert.equal(env.load().scripts[1].listing.updated_date, '2026-06-01');
});

test('--update downloads a same-day upload, by its version', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0' });
  env.save(corpus);
  env.routes.set('/1.user.js', script('2.0'));
  env.routes.set('/en/scripts/1.json', env.apiRow(1, '2.0', '2026-01-01'));

  const { stdout } = await env.run();

  assert.equal(env.readDep('1.user.js'), script('2.0'));
  assert.match(stdout, /1 script changed, 1 downloaded/);
});

test('--update treats an API answer about another script as gone', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0' });
  env.save(corpus);
  env.routes.set('/en/scripts/1.json', env.apiRow(99, '2.0', '2026-06-01'));

  const { stdout } = await env.run();

  assert.match(stdout, /gone {4}1 Script 1/);
  const { gone_as_of: goneAsOf, ...listing } = env.load().scripts[1].listing;
  assert.match(goneAsOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(listing, corpus.scripts[1].listing, 'the rest of the listing stays');
});

test('--update marks a gone script, keeps the first date, and clears the mark when it returns', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0' });
  env.addScript(corpus, 2, { version: '1.0' });
  env.addScript(corpus, 3, { version: '1.0' });
  env.addScript(corpus, 4, { version: '1.0' });
  corpus.scripts[2].listing.gone_as_of = '2026-01-02';
  corpus.scripts[3].listing.gone_as_of = '2026-01-02';
  corpus.scripts[4].listing.gone_as_of = '2026-01-02';
  env.save(corpus);
  env.routes.delete('/en/scripts/1.json');
  env.routes.delete('/en/scripts/2.json');
  // 3 is back with nothing new. 4 is back with a new version, and a file failing
  // in a way that may pass holds back its listing.
  const dep = `// @require ${env.origin}/dep.js\n`;
  env.routes.set('/4.user.js', script('2.0', dep));
  env.routes.set('/dep.js', 503);
  env.routes.set('/en/scripts/4.json', env.apiRow(4, '2.0', '2026-06-01'));

  await env.run();

  const { scripts } = env.load();
  assert.match(scripts[1].listing.gone_as_of, /^\d{4}-\d{2}-\d{2}$/, 'a newly gone script gets a date');
  assert.notEqual(scripts[1].listing.gone_as_of, '2026-01-02');
  assert.equal(scripts[2].listing.gone_as_of, '2026-01-02', 'a script still gone keeps its first date');
  assert.equal(scripts[3].listing.gone_as_of, undefined, 'a returned script loses the mark');
  assert.equal(scripts[4].listing.gone_as_of, undefined, 'even with its listing held back');
  assert.equal(scripts[4].listing.updated_date, '2026-01-01');
});

test('--update saves gone marks from the answers it got before aborting', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0' });
  env.addScript(corpus, 2, { version: '1.0' });
  env.addScript(corpus, 3, { version: '1.0' });
  env.addScript(corpus, 4, { version: '1.0' });
  corpus.scripts[2].listing.gone_as_of = '2026-01-02';
  corpus.scripts[3].listing.gone_as_of = '2026-01-02';
  env.save(corpus);
  env.routes.delete('/en/scripts/1.json');
  env.routes.set('/en/scripts/3.json', 400);
  env.routes.set('/en/scripts/4.json', 429);

  const failure = await env.run().catch((err) => err);
  assert.equal(failure.code, 1, 'the run aborted');

  const { scripts } = env.load();
  assert.match(scripts[1].listing.gone_as_of, /^\d{4}-\d{2}-\d{2}$/, 'a gone answer marks the script');
  assert.equal(scripts[2].listing.gone_as_of, undefined, 'a normal answer clears the mark');
  assert.equal(scripts[3].listing.gone_as_of, '2026-01-02', 'a failed answer changes nothing');
});

test('list --gone and --not-gone select on the mark, and other filters treat gone scripts like any others', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0' });
  env.addScript(corpus, 2, { version: '1.0' });
  corpus.scripts[1].listing.gone_as_of = '2026-01-02';
  env.save(corpus);
  const list = async (...args) => (await execFileAsync(process.execPath, [
    path.join(tools, 'record-results.mjs'), 'list', ...args, '--corpus', env.corpusFile, '--root', env.root,
  ])).stdout;

  const gone = await list('--gone');
  assert.match(gone, /Script 1 {2}\(gone as of 2026-01-02\)/);
  assert.doesNotMatch(gone, /Script 2/);

  const untested = await list('--untested');
  assert.match(untested, /Script 2/);
  assert.match(untested, /Script 1 {2}\(gone as of 2026-01-02\)/);

  const both = await list('--untested', '--gone');
  assert.match(both, /Script 1/);
  assert.doesNotMatch(both, /Script 2/);

  const notGone = await list('--untested', '--not-gone');
  assert.match(notGone, /Script 2/);
  assert.doesNotMatch(notGone, /Script 1/);

  await assert.rejects(list('--gone', '--not-gone'), /Pass --gone or --not-gone, not both/);

  const tagged = await list('--tag', 'script-gone');
  assert.match(tagged, /Script 1/);
  assert.doesNotMatch(tagged, /Script 2/);

  const results = async (...args) => (await execFileAsync(process.execPath, [
    path.join(tools, 'record-results.mjs'), ...args, '--corpus', env.corpusFile, '--root', env.root,
  ])).stdout;
  assert.match(await results('tag', 'list'), /\b1 {2}script-gone/, 'tag list counts it');

  // Derived from the mark, so it can't be stored on a record.
  const before = fs.readFileSync(env.corpusFile, 'utf8');
  const byHand = /The script-gone tag comes from listing\.gone_as_of/;
  await assert.rejects(results('set', '2', '--tag', 'script-gone'), byHand);
  await assert.rejects(results('set', '1', '--untag', 'script-gone'), byHand);
  await results('tag', 'add', 'my-tag', 'A tag.');
  const defined = fs.readFileSync(env.corpusFile, 'utf8');
  assert.notEqual(defined, before);
  await assert.rejects(results('tag', 'merge', 'my-tag', 'script-gone'), byHand);
  assert.equal(fs.readFileSync(env.corpusFile, 'utf8'), defined, 'the refusals change nothing');
});

test('--update stops the check at a 429, and downloads nothing', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  env.addScript(corpus, 1, { version: '1.0' });
  env.addScript(corpus, 2, { version: '1.0' });
  env.save(corpus);
  env.routes.set('/en/scripts/1.json', env.apiRow(1, '2.0', '2026-06-01'));
  env.routes.set('/en/scripts/2.json', 429);

  await assert.rejects(env.run(), (err) => err.code === 1 && /HTTP 429/.test(err.stdout));
  assert.ok(!env.asked.includes('/1.user.js'));
  assert.equal(env.load().scripts[1].listing.updated_date, '2026-01-01');
});

test('--update stops the check after API failures in a row', async (t) => {
  const env = await setup(t);
  const corpus = { tags: {}, scripts: {} };
  for (let id = 1; id <= 12; id++) {
    env.addScript(corpus, id, { version: '1.0' });
    env.routes.set(`/en/scripts/${id}.json`, 400);
  }
  env.save(corpus);

  await assert.rejects(env.run(), (err) => err.code === 1 && /10 API failures in a row/.test(err.stdout));
  assert.ok(!env.asked.includes('/en/scripts/11.json'));
});

test('list --stale gives the tests run on another version', async (t) => {
  const env = await setup(t);
  const record = (version, testVersion) => ({
    listing: { name: `v${version}`, script_url: 'https://example.test/a.user.js' },
    version,
    ...(testVersion && { test: { status: 'pass', date: '2026-01-01', version: testVersion } }),
  });
  env.save({ tags: {}, scripts: { 1: record('2.0', '1.0'), 2: record('1.0', '1.0'), 3: record('1.0') } });
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(tools, 'record-results.mjs'), 'list', '--stale', '--corpus', env.corpusFile, '--root', env.root,
  ]);
  const ids = stdout.trim().split('\n').slice(1).map((line) => line.trim().split(/\s+/)[0]);
  assert.deepEqual(ids, ['1']);
  assert.match(stdout, /tested v1\.0, now v2\.0/);
});
