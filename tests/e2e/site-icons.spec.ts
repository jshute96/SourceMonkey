// Favicon slot DOM contract: every script row paints an inner element
// containing a globe SVG placeholder. When the script's @match yields
// a usable origin the inner is a clickable <a target="_blank"> with
// the linkUrl; when it doesn't (e.g. `<all_urls>`), the inner is an
// inert <span>. The third test exercises the @icon header override
// using a `data:` URL so the swap-in is network-independent.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer } from '../fixtures/userscript-server';

// 1x1 transparent PNG bytes — used by the relative-`@icon` tests below
// as a real binary file alongside the userscript (file:// and HTTP).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

// Build a userscript text with `@icon <ref>` set to whatever value the
// test wants to exercise. Mirrors `userscriptText` in the fixture but
// keeps the icon header configurable inline.
function userscriptWithIcon(name: string, iconRef: string): string {
  return [
    '// ==UserScript==',
    `// @name        ${name}`,
    '// @match       https://example.com/*',
    `// @icon        ${iconRef}`,
    '// ==/UserScript==',
    '',
  ].join('\n');
}

test.describe('site-icon slot', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  test('renders an anchor + globe for scripts with a usable @match origin', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'A', match: ['https://example.com/posts/*/edit'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const row = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // Anchor wrapper with the segment-trimmed linkUrl.
    const anchor = slot.locator('a.site-icon-inner');
    await expect(anchor).toHaveAttribute('href', 'https://example.com/posts/');
    await expect(anchor).toHaveAttribute('target', '_blank');
    // Globe placeholder paints synchronously.
    await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
    await page.close();
  });

  test('@icon header takes priority over origin-discovered favicon', async ({
    extensionContext, extensionId, sm,
  }) => {
    // 1x1 transparent PNG inlined as a data: URL — `ensureIconForUrl`
    // returns it synchronously without any network round-trip, so the
    // swap-in happens deterministically in test.
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    scriptsDir.write({
      relativePath: 'icon.user.js',
      meta: {
        name: 'Pinned',
        match: ['https://example.com/*'],
        extra: [`// @icon       ${dataUrl}`],
      },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const row = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // Anchor still points at the @match-derived linkUrl — the @icon
    // header is a visual override only.
    await expect(slot.locator('a.site-icon-inner'))
      .toHaveAttribute('href', 'https://example.com/');
    // The img inside the anchor gets the data: URL from @icon, not a
    // network-discovered favicon. The expect-poll waits for the async
    // swap to complete.
    await expect(slot.locator('a.site-icon-inner img'))
      .toHaveAttribute('src', dataUrl);
    await page.close();
  });

  test('renders an inert span + globe for scripts without a usable origin', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'b.user.js',
      meta: { name: 'B', match: ['<all_urls>'] },
      body: '',
    });
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const row = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // No anchor — `<all_urls>` doesn't yield an origin to link to.
    await expect(slot.locator('a.site-icon-inner')).toHaveCount(0);
    await expect(slot.locator('span.site-icon-inner')).toHaveCount(1);
    await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
    await page.close();
  });

  test('@icon relative path resolves against the script\'s parent dir', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Drop a real PNG alongside the userscript and reference it with a
    // bare filename in `@icon`. This is the file-loader's relative-path
    // path end-to-end: the file:// XHR byte-fetcher reads the bytes and
    // site-icon.ts wraps them into a data: URL for <img src>.
    scriptsDir.write({
      relativePath: 'icon.user.js',
      meta: {
        name: 'Relative',
        match: ['https://example.com/*'],
        extra: ['// @icon       icon.png'],
      },
      body: '',
    });
    fs.writeFileSync(path.join(scriptsDir.path, 'icon.png'), PNG_BYTES);
    const source = await sm.addSource(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const row = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // The MIME prefix Chrome's file:// XHR layer reports is unreliable
    // across platforms (sometimes `image/png`, sometimes empty falling
    // back to `image/x-icon`); match by the base64 body, which is what
    // proves the file:// fetch actually ran and produced the bytes.
    await expect(slot.locator('a.site-icon-inner img'))
      .toHaveAttribute('src', new RegExp(`^data:image/[^;]+;base64,${PNG_BASE64.replace(/[=+/]/g, c => '\\' + c)}$`));
    await page.close();
  });

  test('@icon relative path resolves against an HTTP script\'s parent dir', async ({
    extensionContext, extensionId, sm,
  }) => {
    // HTTP twin of the previous test: a userscript loaded over HTTP
    // pointing at a sibling icon via a bare filename should reach the
    // same-origin `<dir>/icon.png` and inline the bytes. Exercises the
    // file-loader's relative-path resolution against an http(s)
    // scriptFileUrl plus the fetch()-based byte fetcher.
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/scripts/foo.user.js', userscriptWithIcon('HttpRel', 'icon.png'));
      server.setRoute('/scripts/icon.png', PNG_BYTES, { contentType: 'image/png' });
      const source = await sm.addSource(`${server.baseUrl}/scripts/foo.user.js`);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      const row = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`).first();
      const slot = row.locator('.site-icon');
      await expect(slot.locator('a.site-icon-inner img'))
        .toHaveAttribute('src', `data:image/png;base64,${PNG_BASE64}`);
      // The icon fetch actually went over the wire.
      expect(server.countResponses('/scripts/icon.png', 200)).toBeGreaterThanOrEqual(1);
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('two-tier cache: scripts on different deep paths get distinct icons', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Regression for the original "all nytimes scripts show the
    // spelling-bee icon" bug. Three scripts on the same synthetic
    // origin — two on distinct deep paths and one on the root —
    // should each end up with their own icon, not the first-discovered
    // one shared via the origin cache.
    //
    // We can't point @match at the local test server because
    // parseMatchPattern strips ports (Chrome match patterns don't
    // support them), so the discovery flow would never reach the
    // server. Instead we intercept HTML fetches to a synthetic host
    // via `context.route` — Playwright forwards SW fetches through the
    // same routing layer.
    const HOST = 'https://sm-icons-test.invalid';
    const iconHtml = (token: string): string =>
      `<html><head><link rel="icon" href="data:image/png;base64,${token}"></head></html>`;
    const ICON_A = 'AAAAA1';
    const ICON_B = 'BBBBB2';
    const ICON_ROOT = 'CCCCC3';

    await extensionContext.route(`${HOST}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.startsWith('/section-a/')
        ? iconHtml(ICON_A)
        : pathname.startsWith('/section-b/')
        ? iconHtml(ICON_B)
        : iconHtml(ICON_ROOT);
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });

    try {
      scriptsDir.write({
        relativePath: 'section-a.user.js',
        meta: { name: 'SectionA', match: [`${HOST}/section-a/*`] },
        body: '',
      });
      scriptsDir.write({
        relativePath: 'section-b.user.js',
        meta: { name: 'SectionB', match: [`${HOST}/section-b/*`] },
        body: '',
      });
      scriptsDir.write({
        relativePath: 'root.user.js',
        meta: { name: 'Root', match: [`${HOST}/*`] },
        body: '',
      });
      const source = await sm.addSource(scriptsDir.path);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      const rowFor = (name: string) =>
        page.locator(
          `section.directory[data-source-id="${source!.id}"] tbody tr:has-text("${name}")`,
        );

      // Each script gets its own probe URL → its own pathIcon entry.
      // The root script's probeUrl equals the origin root, so it bypasses
      // the path layer and lands on the origin-level fallback — which
      // begins with a root-HTML probe and therefore sees ICON_ROOT.
      await expect(rowFor('section-a.user.js').locator('.site-icon img'))
        .toHaveAttribute('src', `data:image/png;base64,${ICON_A}`);
      await expect(rowFor('section-b.user.js').locator('.site-icon img'))
        .toHaveAttribute('src', `data:image/png;base64,${ICON_B}`);
      await expect(rowFor('root.user.js').locator('.site-icon img'))
        .toHaveAttribute('src', `data:image/png;base64,${ICON_ROOT}`);
      await page.close();
    } finally {
      await extensionContext.unroute(`${HOST}/**`);
    }
  });

  test('@icon rejects path-traversal and absolute file:// refs end-to-end', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Three malicious `@icon` shapes that must all be rejected before
    // any fetch: literal `..`, percent-encoded `..`, and absolute
    // file:// pointing outside the script's tree. We drop a sibling
    // PNG into the parent directory so a successful traversal would
    // produce a visible img swap; the assertion is that none of them
    // do — the slot stays on its globe placeholder.
    const parent = fs.mkdtempSync(path.join(scriptsDir.path, '..', 'sm-parent-'));
    try {
      fs.writeFileSync(path.join(parent, 'secret.png'), PNG_BYTES);
      const child = path.join(parent, 'child');
      fs.mkdirSync(child);
      // The userscript lives in <parent>/child/. A `..` traversal from
      // here would reach <parent>/secret.png; a relative-then-resolved
      // absolute path would do the same.
      const traversals = [
        '../secret.png',
        '%2e%2e/secret.png',
        `file://${path.join(parent, 'secret.png')}`,
      ];
      for (let i = 0; i < traversals.length; i++) {
        fs.writeFileSync(
          path.join(child, `s${i}.user.js`),
          userscriptWithIcon(`Trav${i}`, traversals[i]),
        );
      }
      const source = await sm.addSource(child);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      // Every row's icon slot must show only the globe placeholder —
      // never an <img>. If any traversal had been honored we'd see the
      // PNG's data URL swapped in.
      const rows = page.locator(`section.directory[data-source-id="${source!.id}"] tbody tr`);
      const slots = rows.locator('.site-icon');
      const count = await slots.count();
      expect(count).toBe(traversals.length);
      for (let i = 0; i < count; i++) {
        const slot = slots.nth(i);
        await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
        // No img element should ever appear in the slot for these
        // rejected refs. (Origin discovery is the other code path that
        // could paint an img, but example.com isn't reachable in CI so
        // that fetch fails into a null cache entry and never paints.)
        await expect(slot.locator('img')).toHaveCount(0);
      }
      await page.close();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
