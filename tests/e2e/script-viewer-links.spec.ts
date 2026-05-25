// Userscript viewer link rendering. Both the details panel (Match,
// Location) and the Prism-highlighted code block are walked and
// turned into open-in-new-tab anchors using the same rules as the
// site-favicon link at the top of the page.

import type { BrowserContext } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('userscript viewer link rendering', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  async function openViewer(extensionContext: BrowserContext, extensionId: string, scriptId: string) {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
    return page;
  }

  test('Match-row anchors use the wildcard-trim rule', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'A',
        match: [
          'https://example.com/posts/*/edit',
          'https://*.example.org/*',
        ],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const got = await sm.getSourceWithScripts(source!.id);
    const script = got!.scripts.find((s) => s.relativePath === 'a.user.js')!;

    const page = await openViewer(extensionContext, extensionId, script.id);
    const matchRow = page.locator('#header-summary dt', { hasText: 'Match' }).locator('+ dd');

    // First pattern keeps the literal leading path segment.
    const first = matchRow.locator('li').nth(0).locator('a');
    await expect(first).toHaveText('https://example.com/posts/*/edit');
    await expect(first).toHaveAttribute('href', 'https://example.com/posts/');
    await expect(first).toHaveAttribute('target', '_blank');

    // Subdomain wildcard is dewildcarded to the apex.
    const second = matchRow.locator('li').nth(1).locator('a');
    await expect(second).toHaveAttribute('href', 'https://example.org/');

    await page.close();
  });

  test('Location row renders an anchor pointing at the script URL', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['https://example.com/*'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const got = await sm.getSourceWithScripts(source!.id);
    const script = got!.scripts.find((s) => s.relativePath === 'b.user.js')!;

    const page = await openViewer(extensionContext, extensionId, script.id);
    const locationAnchor = page
      .locator('#header-summary dt', { hasText: 'Location' })
      .locator('+ dd a.filename-text');
    // Bare-fs-path display (no file:// scheme), but anchor href is the
    // canonical fetchable URL — file:// for an addSource(<dir>) case.
    await expect(locationAnchor).toHaveAttribute('target', '_blank');
    const href = await locationAnchor.getAttribute('href');
    expect(href).toMatch(/^file:\/\//);
    expect(href).toContain('b.user.js');
    await page.close();
  });

  test('Exclude-row anchors use the same rule as Match', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'e.user.js',
      meta: {
        name: 'E',
        match: ['https://example.com/*'],
        exclude: ['https://www.nytimes.com/athletic/*'],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const got = await sm.getSourceWithScripts(source!.id);
    const script = got!.scripts.find((s) => s.relativePath === 'e.user.js')!;

    const page = await openViewer(extensionContext, extensionId, script.id);
    const excludeAnchor = page
      .locator('#header-summary dt', { hasText: 'Exclude' })
      .locator('+ dd a');
    await expect(excludeAnchor).toHaveText('https://www.nytimes.com/athletic/*');
    await expect(excludeAnchor).toHaveAttribute(
      'href',
      'https://www.nytimes.com/athletic/',
    );
    await page.close();
  });

  test('header @match lines in the code body become anchors', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'c.user.js',
      meta: {
        name: 'C',
        match: ['https://example.com/posts/*/edit'],
        exclude: ['https://www.nytimes.com/athletic/*'],
        extra: [
          '// @updateURL  https://example.com/c.user.js',
          '// @resource   myCSS https://example.com/style.css',
          '// @connect    api.dictionaryapi.dev',
          '// @connect    *',
        ],
      },
      body: 'const x = 1;\n',
    });
    const source = await sm.addSource(scriptsDir.path);
    const got = await sm.getSourceWithScripts(source!.id);
    const script = got!.scripts.find((s) => s.relativePath === 'c.user.js')!;

    const page = await openViewer(extensionContext, extensionId, script.id);
    // Wait for Prism + linkifier to run.
    await expect(page.locator('#content .token.comment').first()).toBeVisible();

    // @match value linkified to the trimmed link URL.
    const matchAnchor = page.locator('#content a', {
      hasText: 'https://example.com/posts/*/edit',
    });
    await expect(matchAnchor).toHaveAttribute('href', 'https://example.com/posts/');
    await expect(matchAnchor).toHaveAttribute('target', '_blank');

    // @updateURL value (an absolute http URL) linkified to itself.
    const updateAnchor = page.locator('#content a', {
      hasText: 'https://example.com/c.user.js',
    });
    await expect(updateAnchor).toHaveAttribute('href', 'https://example.com/c.user.js');

    // @exclude goes through the same structural path as @match: the
    // anchor text is the full pattern (with `*`); the href is the
    // wildcard-trimmed link URL.
    const excludeAnchor = page.locator('#content a', {
      hasText: 'https://www.nytimes.com/athletic/*',
    });
    await expect(excludeAnchor).toHaveAttribute(
      'href',
      'https://www.nytimes.com/athletic/',
    );
    // Confirm no anchor's href ends with the bare wildcard.
    await expect(page.locator('#content a[href$="*"]')).toHaveCount(0);

    // @resource: only the URL portion linkifies; `myCSS` stays plain.
    const resourceAnchor = page.locator('#content a', {
      hasText: 'https://example.com/style.css',
    });
    await expect(resourceAnchor).toHaveAttribute(
      'href',
      'https://example.com/style.css',
    );
    // The `<name>` token must not be inside any anchor — otherwise
    // the phantom-relative-path bug from the @resource review issue
    // is back.
    await expect(page.locator('#content a', { hasText: 'myCSS' })).toHaveCount(0);

    // @connect: bare host linkifies to https://<host>/; the `*`
    // wildcard entry doesn't name a single site and stays plain text.
    const connectAnchor = page.locator('#content a', {
      hasText: 'api.dictionaryapi.dev',
    });
    await expect(connectAnchor).toHaveAttribute(
      'href',
      'https://api.dictionaryapi.dev/',
    );
    // No anchor should wrap the lone `*` from the second @connect line.
    await expect(page.locator('#content a', { hasText: /^\*$/ })).toHaveCount(0);

    await page.close();
  });

  test('relative @icon resolves against the script\'s parent dir', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'd.user.js',
      meta: {
        name: 'D',
        match: ['https://example.com/*'],
        extra: ['// @icon       ./icon.png'],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);
    const got = await sm.getSourceWithScripts(source!.id);
    const script = got!.scripts.find((s) => s.relativePath === 'd.user.js')!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    await expect(page.locator('#content .token.comment').first()).toBeVisible();

    // Relative `./icon.png` resolves against the script's file:// URL.
    const iconAnchor = page.locator('#content a', { hasText: './icon.png' });
    const href = await iconAnchor.getAttribute('href');
    expect(href).toMatch(/^file:\/\//);
    expect(href).toMatch(/\/icon\.png$/);
    await page.close();
  });

  test('a `// ==UserScript==` lookalike in a string literal does not flip header mode', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The real header carries no extra header tags after `@match`.
    // The body contains a string literal that looks like the open
    // marker, followed by a comment line that looks like a real
    // `@icon` tag. If the state machine were spoofed, the fake @icon
    // would linkify; it must not — we're not inside the metadata
    // block at that point.
    scriptsDir.write({
      relativePath: 'spoof.user.js',
      meta: { name: 'Spoof', match: ['https://example.com/*'] },
      body: [
        'const marker = "// ==UserScript==";',
        '// @icon ./icon.png',
        'console.log(marker);',
      ].join('\n'),
    });
    const source = await sm.addSource(scriptsDir.path);
    const got = await sm.getSourceWithScripts(source!.id);
    const script = got!.scripts.find((s) => s.relativePath === 'spoof.user.js')!;

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    await expect(page.locator('#content .token.comment').first()).toBeVisible();

    // The fake `@icon ./icon.png` body line is *outside* the real
    // metadata block, so structural tag linkification must NOT apply.
    // (Naked-URL mode also wouldn't pick `./icon.png` up — no scheme.)
    await expect(page.locator('#content a', { hasText: './icon.png' })).toHaveCount(0);
    await page.close();
  });
});
