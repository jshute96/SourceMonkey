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
// The URLs the script fetches (code_url, image_files, ...) are made up and
// answered with `gm.interceptRequests`, since it fetches through
// GM_xmlhttpRequest.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import { test, expect } from '../../lib/harness/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'prefill-forms-from-hash.user.js');
const NEW_SCRIPT_FORM = path.join(here, 'test-pages/new-script.html');
const NEW_VERSION_FORM = path.join(here, 'test-pages/new-version.html');
const IMPORT_FORM = path.join(here, 'test-pages/import.html');
const URL_TOOL = path.join(here, '../../skills/publish-on-GreasyFork/scripts/greasyfork-url.py');

const NEW_SCRIPT = 'https://greasyfork.org/en/script_versions/new';
const NEW_VERSION = 'https://greasyfork.org/en/scripts/591403/versions/new';
const IMPORT = 'https://greasyfork.org/en/import';

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
  await page.goto(url);
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
      'https://files.test/my.user.js': '// fetched code\n',
      'https://files.test/my.md': 'Fetched *info*',
      'https://files.test/shots/b-second.png': 'PNG-B',
      'https://files.test/shots/a-first.jpg': 'JPG-A',
      'https://files.test/shots/c-third.png': 'PNG-C',
    }));
    await openFilled(page, NEW_SCRIPT + hash({
      code_url: 'https://files.test/my.user.js',
      additional_info_markdown_url: 'https://files.test/my.md',
      // Not alphabetical, so the order is the one given.
      image_files: 'https://files.test/shots/b-second.png,https://files.test/shots/a-first.jpg, https://files.test/shots/c-third.png',
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
    await gm.interceptRequests(serveBodies({ 'https://files.test/up.user.js': '// uploaded\n' }));
    await openFilled(page, NEW_SCRIPT + hash({ code_upload: 'https://files.test/up.user.js' }));
    expect(await filesOf(page, '#code-upload')).toEqual([
      { name: 'up.user.js', type: 'text/javascript', text: '// uploaded\n' },
    ]);
    await expect(page.locator('#script_version_code')).toHaveValue('');
  });

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
