// Spec for show-test-results.user.js, on the `sourcemonkey/harness`
// fixture. No live services: Greasy Fork pages come from saved copies in
// test-pages/ (served at their greasyfork.org URLs), and the script's
// requests for corpus.json and corpus-help.js are answered here from a
// small made-up corpus.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../../lib/harness/index.js';
import type { RequestInterceptor } from '../../lib/harness/index.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(dir, 'show-test-results.user.js');
const SCRIPT_PAGE = path.join(dir, 'test-pages/script-page.html');
const LISTING = path.join(dir, 'test-pages/user-listing.html');
const SCRIPT_URL = 'https://greasyfork.org/en/scripts/31-show-password-onfocus';
const LISTING_URL = 'https://greasyfork.org/en/users/4-loucypher';

const PUBLISHED = 'https://jshute96.github.io/SourceMonkey/greasyfork-testing/';
const LOCAL = 'http://localhost:8765/';
const PUBLISHED_ITEM = '☑ Published results (GitHub Pages)';
const LOCAL_ITEM = '☐ Local results (localhost:8765)';

// Scripts on the saved pages: 31 is the script page; 17, 2, 3 and 4 are
// on the listing (4 is left out of the corpus).
const CORPUS = {
  tags: { 'odd-site': 'The target site behaves oddly' },
  scripts: {
    '31': {
      valid: { status: 'ok', date: '2026-10-01', version: '0.0.1.20140630034959' },
      test: { status: 'pass', date: '2026-10-02', version: '0.0.1.20140630034959' },
      tags: ['odd-site'],
    },
    // Tested on an older version than the listing shows (3.0.1).
    '17': {
      valid: { status: 'ok', date: '2026-10-01', version: '3.0' },
      test: { status: 'fail', blame: 'script', date: '2026-10-03', version: '3.0' },
    },
    '2': {
      valid: {
        status: 'invalid', date: '2026-10-04', version: '1.1',
        error: '@require https://example.test/big.js: The file is larger than the 1 MB limit',
        tags: ['invalid:require-too-large'],
      },
    },
    '3': { valid: { status: 'ok', date: '2026-10-01', version: '1.0' } },
  },
};

const HELP = `// Made-up corpus-help.js.
var CORPUS_HELP = {
  "test": { "untested": "Not tried yet.", "pass": "It worked.", "fail": "It did not work." },
  "detail": { "script": "The script itself is broken." },
  "tag": { "invalid:require-too-large": "An @require file is too large." }
};
`;

// Answers the requests for both files under `base`, dated `modified`, and
// fails anything else.
function serveResults(base: string, modified = 'Mon, 02 Nov 2026 10:00:00 GMT', corpus: object = CORPUS): RequestInterceptor {
  return (request) => {
    const body = request.url === base + 'corpus.json' ? JSON.stringify(corpus)
      : request.url === base + 'corpus-help.js' ? HELP : null;
    if (body == null) return { kind: 'error', message: 'unexpected request' };
    const text = request.method === 'HEAD' ? '' : body;
    return {
      kind: 'load',
      response: {
        status: 200, statusText: 'OK', responseURL: request.url, finalUrl: request.url,
        responseText: text, response: text,
        responseHeaders: `content-type: text/plain\r\nlast-modified: ${modified}\r\n`,
      },
    };
  };
}

const unreachable: RequestInterceptor = () => ({ kind: 'error', message: 'no network' });

test.describe('show-test-results', () => {
  test('a tested script page gets a panel beside its stats', async ({ page, loadUserscript, gm, reports, serveHtml }) => {
    await gm.interceptRequests(serveResults(PUBLISHED));
    await loadUserscript(SCRIPT, { url: SCRIPT_URL });
    await page.goto(await serveHtml(SCRIPT_PAGE, SCRIPT_URL, { block: true }));
    await reports.waitForStart();

    const panel = page.locator('.smts-row > .smts-panel');
    await expect(panel).toHaveCount(1);
    // Placed beside the stats block, in a row with it.
    await expect(page.locator('.smts-row > .script-meta-block #script-stats')).toHaveCount(1);
    await expect(panel.locator('.smts-icon')).toHaveText('✓');
    await expect(panel.locator('.smts-title')).toHaveText('SourceMonkey test status');
    await expect(panel.locator('.smts-title')).toHaveAttribute('href', PUBLISHED + 'results.html?q=31');
    await expect(panel.locator('.smts-body > div').first()).toHaveText('Passed');
    await expect(panel.locator('.smts-body > div').first()).toHaveAttribute('title', 'It worked.');
    // The same version as the page, so no "older version".
    await expect(panel.locator('.smts-muted')).toHaveText('Updated: 2026-10-02');
    await expect(panel.locator('.smts-tag')).toHaveText(['odd-site']);
    await expect(panel.locator('.smts-tag')).toHaveAttribute('title', 'The target site behaves oddly');
    expect(reports.errors()).toEqual([]);
  });

  test('a listing marks the scripts in the corpus and leaves the rest alone', async ({ page, loadUserscript, gm, reports, serveHtml }) => {
    await gm.interceptRequests(serveResults(PUBLISHED));
    await loadUserscript(SCRIPT, { url: LISTING_URL });
    await page.goto(await serveHtml(LISTING, LISTING_URL, { block: true }));
    await reports.waitForStart();

    const panelOf = (id: string) => page.locator(`li[data-script-id="${id}"] .smts-panel`);
    await expect(page.locator('.smts-panel')).toHaveCount(3);

    // Failed, on an older version than the listing's.
    await expect(panelOf('17').locator('.smts-icon')).toHaveText('✗');
    await expect(panelOf('17')).toContainText('Failed: script problem');
    await expect(panelOf('17').locator('.smts-muted')).toHaveText('Updated: 2026-10-03, older version 3.0');

    // Invalid: the error shortened, with the full one as its hover.
    await expect(panelOf('2').locator('.smts-icon')).toHaveText('✗');
    await expect(panelOf('2').locator('.smts-clip')).toHaveText('Validation failed: @require file over 1 MB');
    await expect(panelOf('2').locator('.smts-tag')).toHaveText(['require-too-large']);
    await expect(panelOf('2').locator('.smts-tag')).toHaveAttribute('title', 'An @require file is too large.');

    // In the corpus but untested.
    await expect(panelOf('3').locator('.smts-icon')).toHaveText('?');
    await expect(panelOf('3')).toContainText('Not tested yet');

    // Not in the corpus: no panel, and its stats block isn't wrapped.
    await expect(panelOf('4')).toHaveCount(0);
    await expect(page.locator('li[data-script-id="4"] .smts-row')).toHaveCount(0);
    expect(reports.errors()).toEqual([]);
  });

  test('the menu switches between the published and local results', async ({ page, loadUserscript, gm, serveHtml }) => {
    await gm.interceptRequests((request) => serveResults(request.url.startsWith(LOCAL) ? LOCAL : PUBLISHED)(request, ''));
    await loadUserscript(SCRIPT, { url: SCRIPT_URL });
    await page.goto(await serveHtml(SCRIPT_PAGE, SCRIPT_URL, { block: true }));
    const title = page.locator('.smts-title');
    await expect(title).toHaveText('SourceMonkey test status');
    await expect.poll(() => gm.menuCommands()).toEqual([PUBLISHED_ITEM, LOCAL_ITEM]);

    // Choosing the item already in use does nothing.
    expect(await gm.fireMenu(PUBLISHED_ITEM)).toBe(true);
    expect(gm.get('source')).toBeUndefined();

    // Choosing the other saves it and reloads, now reading localhost.
    expect(await gm.fireMenu(LOCAL_ITEM)).toBe(true);
    await expect.poll(() => gm.get('source')).toBe('local');
    await expect(title).toHaveText('SourceMonkey test status (local)');
    await expect(title).toHaveAttribute('href', LOCAL + 'results.html?q=31');
    await expect.poll(() => gm.menuCommands())
      .toEqual(['☐ Published results (GitHub Pages)', '☑ Local results (localhost:8765)']);
    // Each source keeps its own stored copy.
    expect(gm.get('corpus:published')).toBeTruthy();
    expect(gm.get('corpus:local')).toBeTruthy();

    expect(await gm.fireMenu('☐ Published results (GitHub Pages)')).toBe(true);
    await expect.poll(() => gm.get('source')).toBe('published');
    await expect(title).toHaveText('SourceMonkey test status');
  });

  test('the stored copy is used when unchanged, or when the server fails', async ({ page, loadUserscript, gm, serveHtml }) => {
    await gm.interceptRequests(serveResults(PUBLISHED));
    await loadUserscript(SCRIPT, { url: SCRIPT_URL });
    await page.goto(await serveHtml(SCRIPT_PAGE, SCRIPT_URL, { block: true }));
    const status = page.locator('.smts-panel .smts-body > div').first();
    await expect(status).toHaveText('Passed');
    await expect.poll(() => gm.get('corpus:published')).toMatchObject({ lastModified: 'Mon, 02 Nov 2026 10:00:00 GMT' });

    // Unchanged: only the HEAD checks go out.
    const before = gm.requests().length;
    await page.reload();
    await expect(status).toHaveText('Passed');
    await expect.poll(() => gm.requests().slice(before).map((r) => r.method).sort()).toEqual(['HEAD', 'HEAD']);

    // A newer file is downloaded again: 31 now fails.
    const failing = structuredClone(CORPUS);
    failing.scripts['31'].test = { status: 'fail', blame: 'script', date: '2026-10-05', version: '0.0.1.20140630034959' } as never;
    await gm.interceptRequests(serveResults(PUBLISHED, 'Tue, 03 Nov 2026 10:00:00 GMT', failing));
    await page.reload();
    await expect(status).toHaveText('Failed: script problem');

    // The server can't be reached: the stored copy still shows.
    await gm.interceptRequests(unreachable);
    await page.reload();
    await expect(status).toHaveText('Failed: script problem');
    await expect(page.locator('.smts-panel .smts-tag')).toHaveText(['odd-site']);
  });

  test('without a stored copy, one panel says the results could not load', async ({ page, loadUserscript, gm, serveHtml }) => {
    await gm.failHosts('jshute96.github.io');
    await loadUserscript(SCRIPT, { url: LISTING_URL });
    await page.goto(await serveHtml(LISTING, LISTING_URL, { block: true }));
    const panel = page.locator('.smts-panel');
    // On the first script only, not one per row.
    await expect(panel).toHaveCount(1);
    await expect(page.locator('li[data-script-id="17"] .smts-panel')).toHaveCount(1);
    await expect(panel.locator('.smts-icon')).toHaveText('!');
    await expect(panel).toContainText('Could not load test results.');
    await expect(panel).toContainText('The server on jshute96.github.io returned HTTP 503.');
  });

  test('an unreachable local server gets the command to start it', async ({ page, loadUserscript, gm, serveHtml }) => {
    await gm.interceptRequests(unreachable);
    await loadUserscript(SCRIPT, { url: SCRIPT_URL, values: { source: 'local' } });
    await page.goto(await serveHtml(SCRIPT_PAGE, SCRIPT_URL, { block: true }));
    const panel = page.locator('.smts-panel');
    await expect(panel).toContainText('Server not reachable on localhost:8765.');
    await expect(panel.locator('code')).toHaveText('greasyfork-testing/serve-results.mjs');
  });
});
