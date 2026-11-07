// Spec for prefill-forms-from-hash.user.js.
//
// Greasy Fork's form pages all redirect to sign-in without a login, so
// copies in test-pages/ are served at the real greasyfork.org URLs, where
// the script's @match applies:
//   - They're the real forms, saved signed in, with the session token
//     replaced. new-version.html is from script 591403's page.
//   - An inline script in each stands in for Greasy Fork's Write/Preview
//     tabs, whose own script isn't served.
//
// Most URLs the script fetches (code_url, image_files, ...) are made up and
// answered with `gm.interceptRequests`, since it fetches through
// GM_xmlhttpRequest. They use the file server's URL form, which needs no
// connection prompt. One test runs the real server.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Page } from '@playwright/test';
import { test, expect } from '../../lib/harness/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'prefill-forms-from-hash.user.js');
const NEW_SCRIPT_FORM = path.join(here, 'test-pages/new-script.html');
const NEW_VERSION_FORM = path.join(here, 'test-pages/new-version.html');
const IMPORT_FORM = path.join(here, 'test-pages/import.html');
const OPENER_PAGE = path.join(here, 'open-prefilled-form.html');
const URL_TOOL = path.join(here, '../../skills/publish-on-GreasyFork/scripts/greasyfork-url.py');

const NEW_SCRIPT = 'https://greasyfork.org/en/script_versions/new';
const NEW_VERSION = 'https://greasyfork.org/en/scripts/591403/versions/new';
const IMPORT = 'https://greasyfork.org/en/import';
const SERVED = 'http://localhost:1/gf-prefill-0123456789abcdef';
const SERVER_TOOL = path.join(here, '../../skills/publish-on-GreasyFork/scripts/serve-files.py');
const OPENER = 'https://jshute96.github.io/SourceMonkey/userscripts/greasyfork/open-prefilled-form.html';

// Builds a hash the way the doc says: `key=value` pairs, each value
// encodeURIComponent-encoded. `true` gives a bare key.
function hash(params: Record<string, string | true>): string {
  return '#' + Object.entries(params)
    .map(([k, v]) => (v === true ? k : `${k}=${encodeURIComponent(v)}`)).join('&');
}

// Opens `url` and waits for the script's closing log line, collecting the
// `[gf-prefill]` lines it wrote.
async function openFilled(page: Page, url: string): Promise<string[]> {
  const lines: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().startsWith('[gf-prefill]')) lines.push(msg.text());
  });
  const done = page.waitForEvent('console', {
    predicate: (msg) => msg.text().startsWith('[gf-prefill] done'),
  });
  // Only to the commit: on the opener page, the script's redirect can
  // interrupt the wait for a full load.
  await page.goto(url, { waitUntil: 'commit' });
  await done;
  return lines;
}

// Answers the script's fetches from `bodies`, keyed by URL, with the
// Content-Type from the extension.
const TYPES: Record<string, string> = { js: 'text/javascript', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg' };
function serveBodies(bodies: Record<string, string>) {
  return (request: { url: string }) => {
    const body = bodies[request.url];
    if (body === undefined) return null;
    const type = TYPES[request.url.split('.').pop()!] ?? 'text/plain';
    return {
      kind: 'load' as const,
      response: {
        status: 200, statusText: 'OK', responseURL: request.url, responseText: body, response: body,
        responseHeaders: `content-type: ${type}`, responseMimeType: type, finalUrl: request.url,
      },
    };
  };
}

// The files a file input holds, as name, type and text.
function filesOf(page: Page, selector: string) {
  return page.locator(selector).evaluate((input: HTMLInputElement) => Promise.all(
    [...input.files!].map(async (f) => ({ name: f.name, type: f.type, text: await f.text() }))));
}

test.describe('prefill-forms-from-hash', () => {
  test.beforeEach(async ({ loadUserscript, serveHtml }) => {
    // `block` applies to all three: requests the later routes don't
    // answer fall through to this one, which aborts them.
    await serveHtml(NEW_SCRIPT_FORM, NEW_SCRIPT, { block: true });
    await serveHtml(NEW_VERSION_FORM, NEW_VERSION);
    await serveHtml(IMPORT_FORM, IMPORT);
    await loadUserscript(SCRIPT);
  });

  test('new script: code, markdown info with Preview, library fields, locale', async ({ page }) => {
    // A "+" and "&" in the code must survive: the hash is not parsed as a query string.
    const code = '// ==UserScript==\nconst a = 1 + 2 && "x&y";\n';
    await openFilled(page, NEW_SCRIPT + hash({
      code,
      additional_info_markdown: '# Title\n\nSome *text*.',
      script_type: 'library',
      name: 'My lib',
      description: 'Helpers',
      script_locale: 'es',
      adult: true,
    }));

    await expect(page.locator('#script_version_code')).toHaveValue(code);
    await expect(page.locator('#script-version-additional-info-0')).toHaveValue('# Title\n\nSome *text*.');
    await expect(page.locator('#script_version_additional_info_0_value_markup_markdown')).toBeChecked();
    const infoPane = page.locator('.previewable').first();
    await expect(infoPane.locator('span:has(> a.preview-tab)')).toHaveClass(/current/);
    await expect(infoPane.locator('span:has(> a.write-tab)')).not.toHaveClass(/current/);
    await expect(page.locator('#script_script_type_3')).toBeChecked();
    await expect(page.locator('#library-name')).toHaveValue('My lib');
    await expect(page.locator('#library-description')).toHaveValue('Helpers');
    await expect(page.locator('select[name="script[locale_id]"]')).toHaveValue('42');
    await expect(page.locator('#script_adult_content_self_report')).toBeChecked();
    // The hash is stripped once applied.
    expect(page.url()).toBe(NEW_SCRIPT);
  });

  test('new script: html info, script_type by number, locale by label', async ({ page }) => {
    await openFilled(page, NEW_SCRIPT + hash({
      additional_info_html: '<p>Hi</p>',
      script_type: '2',
      // The name alone; the option's label is "Spanish (es)".
      script_locale: 'Spanish',
    }));
    await expect(page.locator('#script_version_additional_info_0_value_markup_html')).toBeChecked();
    await expect(page.locator('#script-version-additional-info-0')).toHaveValue('<p>Hi</p>');
    await expect(page.locator('#script_script_type_2')).toBeChecked();
    await expect(page.locator('select[name="script[locale_id]"]')).toHaveValue('42');
  });

  test('new script: code, info and images loaded from URLs, images in order', async ({ page, gm }) => {
    await gm.interceptRequests(serveBodies({
      [`${SERVED}/files/my.user.js`]: '// fetched code\n',
      [`${SERVED}/files/my.md`]: 'Fetched *info*',
      [`${SERVED}/files/shots/b-second.png`]: 'PNG-B',
      [`${SERVED}/files/shots/a-first.jpg`]: 'JPG-A',
      [`${SERVED}/files/shots/c-third.png`]: 'PNG-C',
    }));
    await openFilled(page, NEW_SCRIPT + hash({
      code_url: `${SERVED}/files/my.user.js`,
      additional_info_markdown_url: `${SERVED}/files/my.md`,
      // Not alphabetical, so the order is the one given.
      image_files: `${SERVED}/files/shots/b-second.png,${SERVED}/files/shots/a-first.jpg, ${SERVED}/files/shots/c-third.png`,
    }));

    await expect(page.locator('#script_version_code')).toHaveValue('// fetched code\n');
    await expect(page.locator('#script-version-additional-info-0')).toHaveValue('Fetched *info*');
    await expect(page.locator('#script_version_additional_info_0_value_markup_markdown')).toBeChecked();
    expect(await filesOf(page, '#script_version_attachments')).toEqual([
      { name: 'b-second.png', type: 'image/png', text: 'PNG-B' },
      { name: 'a-first.jpg', type: 'image/jpeg', text: 'JPG-A' },
      { name: 'c-third.png', type: 'image/png', text: 'PNG-C' },
    ]);
  });

  test('new script: code_upload attaches the file', async ({ page, gm }) => {
    await gm.interceptRequests(serveBodies({ [`${SERVED}/files/up.user.js`]: '// uploaded\n' }));
    await openFilled(page, NEW_SCRIPT + hash({ code_upload: `${SERVED}/files/up.user.js` }));
    expect(await filesOf(page, '#code-upload')).toEqual([
      { name: 'up.user.js', type: 'text/javascript', text: '// uploaded\n' },
    ]);
    await expect(page.locator('#script_version_code')).toHaveValue('');
  });

  test('another site needs the person to allow the connection', async ({ page, gm }) => {
    await gm.interceptRequests(serveBodies({ 'https://files.test/my.user.js': '// fetched\n' }));
    const filled = openFilled(page, NEW_SCRIPT + hash({ code_url: 'https://files.test/my.user.js' }));
    await expect.poll(() => gm.connectPrompts().length).toBe(1);
    expect(gm.connectPrompts()[0].host).toBe('files.test');
    await gm.answerConnectPrompt(gm.connectPrompts()[0].promptId, 'once');
    await filled;
    await expect(page.locator('#script_version_code')).toHaveValue('// fetched\n');
  });

  // A link anyone wrote can name these, so nothing is requested for them.
  for (const source of ['file:///etc/hostname', '/etc/hostname', 'data:text/plain,x', 'http://localhost:8080/admin', 'http://127.0.0.1/gf-prefill-short/x', 'http://[::1]/x']) {
    test(`refuses to load ${source}`, async ({ page, gm }) => {
      const stopped = page.waitForEvent('console', {
        predicate: (msg) => msg.text().startsWith('[gf-prefill] stopped'),
      });
      await page.goto(NEW_SCRIPT + hash({ code_url: source }));
      await stopped;
      await expect(page.locator('#script_version_code')).toHaveValue('');
      expect(gm.requests()).toEqual([]);
      expect(gm.connectPrompts()).toEqual([]);
    });
  }

  test('new script: changelog only applies on the new-version page', async ({ page }) => {
    const lines = await openFilled(page, NEW_SCRIPT + hash({ changelog_html: 'Nope', bogus: '1' }));
    await expect(page.locator('#script_version_changelog')).toHaveCount(0);
    expect(lines).toContain('[gf-prefill] parameter "changelog_html" is not available on the new-script page; ignored');
    expect(lines).toContain('[gf-prefill] unknown parameter "bogus"; ignored');
  });

  test('new version: changelog with Preview on both panes, remove_images=all', async ({ page }) => {
    await openFilled(page, NEW_VERSION + hash({
      additional_info_html: '<b>Info</b>',
      changelog_markdown: 'Fixed *it*.',
      remove_images: 'all',
    }));
    await expect(page.locator('#script-version-additional-info-0')).toHaveValue('<b>Info</b>');
    await expect(page.locator('#script_version_changelog')).toHaveValue('Fixed *it*.');
    await expect(page.locator('#script_version_changelog_markup_markdown')).toBeChecked();
    for (const pane of await page.locator('.previewable').all()) {
      await expect(pane.locator('span:has(> a.preview-tab)')).toHaveClass(/current/);
    }
    await expect(page.locator('#remove-attachment-833615')).toBeChecked();
    expect(page.url()).toBe(NEW_VERSION);
  });

  test('import: urls from commas, language and sync type', async ({ page }) => {
    await openFilled(page, IMPORT + hash({
      urls: 'https://example.test/a.user.js, https://example.test/b.user.css',
      language: 'css',
      // Automatic is the page's default, so ask for the other one.
      sync_type: 'manual',
    }));
    await expect(page.locator('#sync-urls')).toHaveValue('https://example.test/a.user.js\nhttps://example.test/b.user.css');
    await expect(page.locator('#sync-language-css')).toBeChecked();
    await expect(page.locator('#sync-type-1')).toBeChecked();
    expect(page.url()).toBe(IMPORT);
  });

  test('keep_hash leaves the parameters in the address bar', async ({ page }) => {
    const url = IMPORT + hash({ urls: 'https://example.test/a.user.js', keep_hash: true });
    await openFilled(page, url);
    await expect(page.locator('#sync-urls')).toHaveValue('https://example.test/a.user.js');
    expect(page.url()).toBe(url);
  });

  test('an empty hash does nothing', async ({ page, reports }) => {
    const lines: string[] = [];
    page.on('console', (msg) => { if (msg.text().startsWith('[gf-prefill]')) lines.push(msg.text()); });
    await page.goto(NEW_SCRIPT + '#');
    await reports.waitForStart();
    await expect(page.locator('#script_version_code')).toHaveValue('');
    await expect(page.locator('#script_version_additional_info_0_value_markup_html')).toBeChecked();
    await expect(page.locator('.previewable span:has(> a.write-tab)').first()).toHaveClass(/current/);
    expect(lines).toEqual([]);
    expect(reports.errors()).toEqual([]);
  });

  test('submit is refused: the form is filled but not posted', async ({ page }) => {
    // A submit would navigate away and lose this marker.
    await page.addInitScript(() => {
      document.addEventListener('submit', () => { (window as any).submitted = true; }, true);
    });
    const lines = await openFilled(page, NEW_VERSION + hash({ changelog_html: 'x', submit: '1' }));
    await expect(page.locator('#script_version_changelog')).toHaveValue('x');
    expect(lines).toContain(`[gf-prefill] "submit" is disabled; review the filled form and click the site's own button`);
    expect(await page.evaluate(() => (window as any).submitted ?? false)).toBe(false);
    expect(page.url()).toBe(NEW_VERSION);
  });

  test("the form is filled after the page's own DOMContentLoaded listeners", async ({ page, serveHtml }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-prefill-'));
    try {
      const html = (await readFile(IMPORT_FORM, 'utf8')).replace('<head>', `<head><script>
        document.addEventListener('DOMContentLoaded', () => {
          window.urlsAtPageReady = document.querySelector('#sync-urls').value;
        });
      </script>`);
      const form = path.join(dir, 'import.html');
      await writeFile(form, html);
      await serveHtml(form, IMPORT);
      await openFilled(page, IMPORT + hash({ urls: 'https://example.test/a.user.js' }));
      await expect(page.locator('#sync-urls')).toHaveValue('https://example.test/a.user.js');
      expect(await page.evaluate(() => (window as any).urlsAtPageReady)).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a URL from greasyfork-url.py --print fills the form', async ({ page }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-prefill-'));
    try {
      const code = '// ==UserScript==\n// @name Tool test\n// ==/UserScript==\nconst a = 1 + 2;\n';
      await writeFile(path.join(dir, 'tool.user.js'), code);
      const url = execFileSync('python3', [URL_TOOL, '--print', 'new',
        '--code-file', path.join(dir, 'tool.user.js'),
        '--info-text', 'Hi **there**', '--info-format', 'markdown',
        '--script-locale', 'es'], { encoding: 'utf8' }).trim();
      expect(url.split('#')[0]).toBe(NEW_SCRIPT);
      await openFilled(page, url);
      await expect(page.locator('#script_version_code')).toHaveValue(code);
      await expect(page.locator('#script-version-additional-info-0')).toHaveValue('Hi **there**');
      await expect(page.locator('#script_version_additional_info_0_value_markup_markdown')).toBeChecked();
      await expect(page.locator('select[name="script[locale_id]"]')).toHaveValue('42');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe('prefill-forms-from-hash: opener page', () => {
  const openerFor = (to: string) => `${OPENER}?to=${encodeURIComponent(to)}`;

  // Answers the script's sign-in check, and leaves other requests alone.
  function greasyForkAnswers(signedIn: boolean) {
    return (request: { url: string }) => {
      if (!request.url.startsWith('https://greasyfork.org/')) return null;
      const finalUrl = signedIn ? request.url : 'https://greasyfork.org/en/users/sign_in';
      return {
        kind: 'load' as const,
        response: {
          status: 200, statusText: 'OK', responseURL: finalUrl, responseText: 'x', response: 'x',
          responseHeaders: 'content-type: text/html', responseMimeType: 'text/html', finalUrl,
        },
      };
    };
  }

  test.beforeEach(async ({ serveHtml, gm }) => {
    await serveHtml(NEW_SCRIPT_FORM, NEW_SCRIPT, { block: true });
    await serveHtml(NEW_VERSION_FORM, NEW_VERSION);
    await serveHtml(IMPORT_FORM, IMPORT);
    await gm.interceptRequests(greasyForkAnswers(true));
  });

  // Runs greasyfork-url.py with a fake browser, and gives the URL the tool
  // opened in it. The launcher page for a long URL goes in `dir` too.
  async function urlOpenedByTool(dir: string, args: string[]): Promise<string> {
    const opened = path.join(dir, 'opened-url');
    const browser = path.join(dir, 'browser.sh');
    await writeFile(browser, `#!/bin/sh\nprintf %s "$1" > '${opened}'\n`, { mode: 0o755 });
    execFileSync('python3', [URL_TOOL, '--browser', browser, ...args], {
      env: { ...process.env, TMPDIR: dir }, stdio: 'pipe',
    });
    await expect.poll(() => readFile(opened, 'utf8').catch(() => '')).not.toBe('');
    return readFile(opened, 'utf8');
  }

  test('redirects to the form with the hash intact, and stays out of history', async ({ page, loadUserscript, serveHtml }) => {
    await loadUserscript(SCRIPT);
    await serveHtml(OPENER_PAGE, openerFor('/en/import'));
    await page.goto('about:blank');
    await openFilled(page, openerFor('/en/import') + hash({ urls: 'https://example.test/a+b.user.js' }));
    await expect(page.locator('#sync-urls')).toHaveValue('https://example.test/a+b.user.js');
    expect(page.url()).toBe(IMPORT);
    await page.goBack();
    expect(page.url()).toBe('about:blank');
  });

  test('without the script it shows instructions, and a reload after installing continues', async ({ page, loadUserscript, serveHtml }) => {
    const url = openerFor('/en/import');
    await serveHtml(OPENER_PAGE, url);
    await page.goto(url + hash({ urls: 'https://example.test/a.user.js' }));
    await expect(page.locator('#manager-row')).toHaveAttribute('data-state', 'unknown');
    await expect(page.locator('#manager-fix')).toBeVisible();
    await expect(page.locator('#script-row')).toHaveAttribute('data-state', 'bad');
    await expect(page.locator('#script-fix a[href="prefill-forms-from-hash.user.js"]')).toBeVisible();
    await expect(page.locator('#sign-in-row')).toBeHidden();
    await expect(page.locator('#continue')).toBeVisible();
    await expect(page.locator('#usage')).toBeHidden();

    await loadUserscript(SCRIPT);
    const done = page.waitForEvent('console', {
      predicate: (msg) => msg.text().startsWith('[gf-prefill] done'),
    });
    await page.getByRole('button', { name: 'Reload' }).click();
    await done;
    await expect(page.locator('#sync-urls')).toHaveValue('https://example.test/a.user.js');
    expect(page.url()).toBe(IMPORT);
  });

  for (const to of ['/en/users/1', '//evil.test/import', 'https://evil.test/import', '/en/scripts/1?x/versions/new', '/en/scripts/../versions/new']) {
    test(`stays on the page for the target ${to}`, async ({ page, loadUserscript, serveHtml }) => {
      await loadUserscript(SCRIPT);
      const url = openerFor(to);
      await serveHtml(OPENER_PAGE, url);
      await page.goto(url + hash({ urls: 'https://example.test/a.user.js' }));
      await expect(page.locator('#link-row')).toBeVisible();
      await expect(page.locator('#continue')).toBeHidden();
      await expect(page.locator('#usage')).toBeVisible();
      await expect(page.locator('#sign-in-row')).toBeHidden();
      expect(new URL(page.url()).origin).toBe(new URL(OPENER).origin);
    });
  }

  for (const [name, url] of [['no target', OPENER], ['no form values', openerFor('/en/import')]]) {
    test(`stays on the page and reports the manager and script with ${name}`, async ({ page, loadUserscript, serveHtml }) => {
      await loadUserscript(SCRIPT);
      await serveHtml(OPENER_PAGE, url);
      await page.goto(url);
      await expect(page.locator('#manager-row')).toHaveAttribute('data-state', 'ok');
      await expect(page.locator('#manager')).toHaveText(/^SourceMonkey \d/);
      await expect(page.locator('#manager-fix')).toBeHidden();
      await expect(page.locator('#script-row')).toHaveAttribute('data-state', 'ok');
      await expect(page.locator('#script')).toHaveText(/^installed, version \d/);
      await expect(page.locator('#script-fix')).toBeHidden();
      await expect(page.locator('#continue')).toBeHidden();
      await expect(page.locator('#usage')).toBeVisible();
      await expect(page.locator('#link-row')).toBeHidden();
      await expect(page.locator('#sign-in-row')).toBeHidden();
      await expect(page.locator('#files-row')).toBeHidden();
      expect(page.url()).toBe(url);
    });
  }

  test('signed out, it says to sign in, and a reload continues to the form', async ({ page, gm, loadUserscript, serveHtml }) => {
    await loadUserscript(SCRIPT);
    await gm.interceptRequests(greasyForkAnswers(false));
    const url = openerFor('/en/import');
    await serveHtml(OPENER_PAGE, url);
    await page.goto(url + hash({ urls: 'https://example.test/a.user.js' }));
    await expect(page.locator('#sign-in-row')).toHaveAttribute('data-state', 'bad');
    await expect(page.locator('#sign-in')).toHaveText('not signed in');
    await expect(page.locator('#sign-in-fix a')).toHaveAttribute('href', 'https://greasyfork.org/users/sign_in?return_to=/');
    await expect(page.locator('#sign-in-fix a')).toHaveAttribute('target', '_blank');
    await expect(page.locator('#script-row')).toHaveAttribute('data-state', 'ok');
    // The form's values name no local files.
    await expect(page.locator('#files-row')).toBeHidden();
    await expect(page.locator('#continue')).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(OPENER).origin);

    await gm.interceptRequests(greasyForkAnswers(true));
    const done = page.waitForEvent('console', {
      predicate: (msg) => msg.text().startsWith('[gf-prefill] done'),
    });
    await page.locator('#continue button').click();
    await done;
    await expect(page.locator('#sync-urls')).toHaveValue('https://example.test/a.user.js');
  });

  test('a failed sign-in check still goes to the form', async ({ page, gm, loadUserscript, serveHtml }) => {
    await loadUserscript(SCRIPT);
    await gm.failHosts('greasyfork.org');
    const url = openerFor('/en/import');
    await serveHtml(OPENER_PAGE, url);
    await openFilled(page, url + hash({ urls: 'https://example.test/a.user.js' }));
    await expect(page.locator('#sync-urls')).toHaveValue('https://example.test/a.user.js');
  });

  test('a stopped file server stays on the page and says to run the command again', async ({ page, loadUserscript, serveHtml }) => {
    await loadUserscript(SCRIPT);
    const url = openerFor('/en/script_versions/new');
    await serveHtml(OPENER_PAGE, url);
    // Nothing listens on port 1.
    await page.goto(url + hash({ image_files: `${SERVED}/files/shot.png` }));
    await expect(page.locator('#files-row')).toHaveAttribute('data-state', 'bad');
    await expect(page.locator('#files')).toHaveText('no longer available');
    await expect(page.locator('#files-fix')).toHaveText('Rerun the greasyfork-url.py command.');
    // Reload can't bring the files back.
    await expect(page.locator('#continue')).toBeHidden();
    expect(new URL(page.url()).origin).toBe(new URL(OPENER).origin);
  });

  test('signed out with the file server running, it shows the files available, and a reload fills the form', async ({ page, gm, loadUserscript, serveHtml }) => {
    await loadUserscript(SCRIPT);
    await gm.interceptRequests(greasyForkAnswers(false));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-prefill-'));
    try {
      await writeFile(path.join(dir, 'shot.png'), 'PNG');
      const url = await urlOpenedByTool(dir, ['update', '591403', '--image-files', path.join(dir, 'shot.png')]);
      await serveHtml(OPENER_PAGE, url.split('#')[0]);
      await page.goto(url);
      await expect(page.locator('#sign-in-row')).toHaveAttribute('data-state', 'bad');
      await expect(page.locator('#files-row')).toHaveAttribute('data-state', 'ok');
      await expect(page.locator('#files')).toHaveText('available');
      await expect(page.locator('#files-fix')).toBeHidden();
      await expect(page.locator('#continue')).toBeVisible();
      expect(new URL(page.url()).origin).toBe(new URL(OPENER).origin);

      await gm.interceptRequests(greasyForkAnswers(true));
      const done = page.waitForEvent('console', {
        predicate: (msg) => msg.text().startsWith('[gf-prefill] done'),
      });
      await page.locator('#continue button').click();
      await done;
      expect(await filesOf(page, 'input[type=file]#script_version_attachments')).toEqual([
        { name: 'shot.png', type: 'image/png', text: 'PNG' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('images on disk reach the form through the real file server', async ({ page, loadUserscript, serveHtml }) => {
    await loadUserscript(SCRIPT);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-prefill-'));
    try {
      // Two files with the same name, in different folders.
      await mkdir(path.join(dir, 'new'));
      await writeFile(path.join(dir, 'new', 'b shot.png'), 'PNG-NEW');
      await mkdir(path.join(dir, 'old'));
      await writeFile(path.join(dir, 'old', 'b shot.png'), 'PNG-OLD');
      const url = await urlOpenedByTool(dir, ['update', '591403',
        '--image-files', `${path.join(dir, 'new', 'b shot.png')},${path.join(dir, 'old', 'b shot.png')}`]);
      expect(decodeURIComponent(url)).toMatch(/\/gf-prefill-[\w-]+\/files\/new\/b%20shot\.png,/);
      await serveHtml(OPENER_PAGE, url.split('#')[0]);
      await openFilled(page, url);
      // This page also has a hidden input with that id, for its existing image.
      expect(await filesOf(page, 'input[type=file]#script_version_attachments')).toEqual([
        { name: 'b shot.png', type: 'image/png', text: 'PNG-NEW' },
        { name: 'b shot.png', type: 'image/png', text: 'PNG-OLD' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('greasyfork-url.py opens the opener page, which reaches the form', async ({ page, loadUserscript, serveHtml }) => {
    await loadUserscript(SCRIPT);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-prefill-'));
    try {
      const url = await urlOpenedByTool(dir, ['update', '591403', '--changelog-text', 'Fixed & done']);
      expect(url.split('#')[0]).toBe(openerFor('/en/scripts/591403/versions/new').replaceAll('%2F', '/'));
      await serveHtml(OPENER_PAGE, url.split('#')[0]);
      await openFilled(page, url);
      await expect(page.locator('#script_version_changelog')).toHaveValue('Fixed & done');
      expect(page.url()).toBe(NEW_VERSION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a long URL reaches the form through the launcher and the opener page', async ({ page, loadUserscript, serveHtml }) => {
    await loadUserscript(SCRIPT);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-prefill-'));
    try {
      const code = `// ==UserScript==\n// ==/UserScript==\n// ${'x + y & z '.repeat(1500)}\n`;
      await writeFile(path.join(dir, 'long.user.js'), code);
      const launcher = await urlOpenedByTool(dir, ['new', '--code-file', path.join(dir, 'long.user.js')]);
      expect(launcher).toMatch(/^file:/);
      await serveHtml(OPENER_PAGE, openerFor('/en/script_versions/new').replaceAll('%2F', '/'));
      // At an https URL, since the routes above abort a file:// load. Its
      // redirect runs the same.
      const launcherAt = 'https://launcher.test/';
      await serveHtml(fileURLToPath(launcher), launcherAt);
      await openFilled(page, launcherAt);
      await expect(page.locator('#script_version_code')).toHaveValue(code);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('greasyfork-url.py --direct and a custom --base skip the opener page', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-prefill-'));
    try {
      expect((await urlOpenedByTool(dir, ['--direct', 'import', 'https://example.test/a.user.js'])).split('#')[0]).toBe(IMPORT);
      await rm(path.join(dir, 'opened-url'));
      expect((await urlOpenedByTool(dir, ['--base', 'http://localhost:1234', 'import', 'https://example.test/a.user.js'])).split('#')[0])
        .toBe('http://localhost:1234/en/import');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('greasyfork-url.py update refuses a file path in place of the script id', () => {
    const run = spawnSync('python3', [URL_TOOL, '--print', 'update', 'my.user.js', '--changelog-text', 'x'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('my.user.js is not a Greasy Fork script id');
  });

  test('greasyfork-url.py --print gives the form, and with --no-direct the opener page or --opener-page', () => {
    const printed = (...args: string[]) =>
      execFileSync('python3', [URL_TOOL, '--print', ...args, 'import', 'https://example.test/a.user.js'], { encoding: 'utf8' }).trim().split('#')[0];
    expect(printed()).toBe(IMPORT);
    expect(printed('--no-direct')).toBe(openerFor('/en/import').replaceAll('%2F', '/'));
    expect(printed('--no-direct', '--opener-page', 'file:///x/open-prefilled-form.html'))
      .toBe('file:///x/open-prefilled-form.html?to=/en/import');
    expect(printed('--no-direct', '--opener-page', OPENER_PAGE)).toBe(`${pathToFileURL(OPENER_PAGE)}?to=/en/import`);
  });
});

test.describe('serve-files.py', () => {
  // Starts the server on `paths` under `root`, and gives its base URL and a promise for its exit.
  async function startServer(root: string, paths: string[], ...args: string[]) {
    const server = spawn('python3', [SERVER_TOOL, ...args, '--', root, ...paths], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => server.on('exit', resolve));
    const line = await new Promise<string>((resolve) => server.stdout.once('data', (data) => resolve(String(data))));
    return { base: JSON.parse(line).base as string, exited, server };
  }

  test('serves only the files it was given, and exits once idle', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-prefill-'));
    try {
      await mkdir(path.join(dir, 'img'));
      await writeFile(path.join(dir, 'img', 'shot one.png'), 'PNG');
      await writeFile(path.join(dir, 'other.txt'), 'private');
      const { base, exited } = await startServer(dir, ['img/shot one.png'], '--idle-seconds', '2');
      expect(base).toMatch(/^http:\/\/localhost:\d+\/gf-prefill-[\w-]{16,}$/);

      const shot = await fetch(`${base}/files/img/shot%20one.png`);
      expect(await shot.text()).toBe('PNG');
      expect(shot.headers.get('content-type')).toBe('image/png');
      expect((await fetch(`${base}/alive`)).status).toBe(200);

      expect((await fetch(`${base}/files/other.txt`)).status).toBe(404);
      expect((await fetch(`${base}/files/img/../other.txt`)).status).toBe(404);
      expect((await fetch(`${base}/img/shot%20one.png`)).status).toBe(404);
      expect((await fetch(`${new URL(base).origin}/files/img/shot%20one.png`)).status).toBe(404);

      expect(await exited).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('exits if nothing ever contacts it', async () => {
    const { exited } = await startServer(os.tmpdir(), [], '--first-contact-seconds', '1');
    expect(await exited).toBe(0);
  });
});
