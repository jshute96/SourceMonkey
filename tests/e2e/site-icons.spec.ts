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
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const row = page.locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // Anchor wrapper with the segment-trimmed linkUrl.
    const anchor = slot.locator('a.site-icon-inner');
    await expect(anchor).toHaveAttribute('href', 'https://example.com/posts/');
    await expect(anchor).toHaveAttribute('target', '_blank');
    // Globe placeholder paints synchronously.
    await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
    await page.close();
  });

  test('sites with no favicon collapse to one globe; the column re-fits', async ({
    extensionContext, extensionId, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'one.user.js',
      meta: { name: 'One', match: ['https://a.example/*'] },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'two.user.js',
      meta: {
        name: 'Two',
        // www./scheme variants of a.example collapse into one site;
        // b.example is the second.
        match: ['https://www.a.example/x/*', 'http://a.example/*', 'https://b.example/*'],
      },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
    const rowFor = (name: string) =>
      section.locator('tbody tr', { has: page.locator('td.name-cell', { hasText: name }) });

    // Neither `.example` host resolves, so both of Two's icons end on
    // the globe — and two globes fold into one that names both sites,
    // linked to the first. (The real-icon collapse test below pins
    // what the slot shows before the fetches settle.)
    const twoIcon = rowFor('Two').locator('.site-icon a.site-icon-inner');
    await expect(twoIcon).toHaveCount(1);
    await expect(twoIcon).toHaveAttribute('href', 'https://www.a.example/x/');
    await expect(twoIcon).toHaveAttribute(
      'title', 'https://www.a.example/x/\nhttps://b.example/',
    );
    await expect(rowFor('One').locator('.site-icon a.site-icon-inner')).toHaveCount(1);

    // Once settled the column re-fits to one icon, and both slots are
    // the same width so the names share a left edge.
    await expect(section.locator('table.script-table')).toHaveCSS('--icon-cols', '1');
    const width = async (name: string) =>
      (await rowFor(name).locator('.site-icon').boundingBox())!.width;
    expect(await width('One')).toBe(await width('Two'));
    await page.close();
  });

  test('sites sharing one favicon collapse to a single icon; the column re-fits', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Two hosts serving the same icon bytes (think maps.google.com and
    // www.google.com), plus a third with its own. Same `context.route`
    // interception the two-tier test below relies on.
    const SAME = 'data:image/png;base64,SAMESAME';
    const OTHER = 'data:image/png;base64,OTHER000';
    const html = (icon: string) =>
      `<html><head><link rel="icon" href="${icon}"></head></html>`;
    // Held until the test has looked at the slot mid-load.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await extensionContext.route('https://*.sm-dupe.invalid/**', async (route) => {
      await released;
      const host = new URL(route.request().url()).host;
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: html(host.startsWith('other.') ? OTHER : SAME),
      });
    });
    try {
      scriptsDir.write({
        relativePath: 'dupe.user.js',
        meta: {
          name: 'Dupe',
          match: [
            'https://maps.sm-dupe.invalid/*',
            'https://www.sm-dupe.invalid/maps*',
            'https://other.sm-dupe.invalid/*',
          ],
        },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const section = page.locator(`section.collection[data-collection-id="${collection!.id}"]`);
      const icons = section.locator('tbody tr .site-icon a.site-icon-inner');
      // While the favicons load, three sites show as one globe rather
      // than three that would then collapse.
      await expect(icons).toHaveCount(1);
      await expect(icons.locator('img')).toHaveCount(0);
      await expect(section.locator('table.script-table')).toHaveCSS('--icon-cols', '1');
      release();
      // Then the two identical favicons fold into one, whose tooltip
      // names both sites, and the distinct one joins it.
      await expect(icons).toHaveCount(2);
      await expect(icons.nth(0).locator('img')).toHaveAttribute('src', SAME);
      await expect(icons.nth(0)).toHaveAttribute(
        'title', 'https://maps.sm-dupe.invalid/\nhttps://www.sm-dupe.invalid/maps',
      );
      await expect(icons.nth(0)).toHaveAttribute('href', 'https://maps.sm-dupe.invalid/');
      await expect(icons.nth(1).locator('img')).toHaveAttribute('src', OTHER);
      // The column was sized for one and re-fits to two once the
      // favicons have settled.
      await expect(section.locator('table.script-table')).toHaveCSS('--icon-cols', '2');
      await page.close();
    } finally {
      await extensionContext.unroute('https://*.sm-dupe.invalid/**');
    }
  });

  test('cached favicons are drawn at once on a later visit, with no globe first', async ({
    extensionContext, extensionId, sm,
  }) => {
    await extensionContext.route('https://*.sm-cached.invalid/**', async (route) => {
      const host = new URL(route.request().url()).host;
      const icon = `data:image/png;base64,${host.split('.')[0].toUpperCase()}0000`;
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<html><head><link rel="icon" href="${icon}"></head></html>`,
      });
    });
    try {
      scriptsDir.write({
        relativePath: 'cached.user.js',
        meta: { name: 'Cached', match: ['https://one.sm-cached.invalid/*', 'https://two.sm-cached.invalid/*'] },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);
      const slotSelector = `section.collection[data-collection-id="${collection!.id}"] tbody tr .site-icon`;

      // The first visit fetches both favicons and caches them.
      const first = await extensionContext.newPage();
      await first.goto(`chrome-extension://${extensionId}/collections.html`);
      await expect(first.locator(`${slotSelector} img`)).toHaveCount(2);
      await first.close();

      // The second records, from before the page's own scripts run,
      // anything the slot ever shows other than its two favicons.
      const second = await extensionContext.newPage();
      await second.addInitScript((selector) => {
        const seen: string[] = [];
        (window as unknown as { smSeen: string[] }).smSeen = seen;
        new MutationObserver(() => {
          const slot = document.querySelector(selector);
          if (!slot) return;
          if (slot.querySelector('.site-icon-globe')) seen.push('globe');
          if (slot.children.length !== 2) seen.push(`${slot.children.length} icons`);
        }).observe(document, { childList: true, subtree: true });
      }, slotSelector);
      await second.goto(`chrome-extension://${extensionId}/collections.html`);
      await expect(second.locator(`${slotSelector} img`)).toHaveCount(2);
      expect(await second.evaluate(() => (window as unknown as { smSeen: string[] }).smSeen)).toEqual([]);
      await second.close();
    } finally {
      await extensionContext.unroute('https://*.sm-cached.invalid/**');
    }
  });

  test('the viewer heading shows more sites than a collections row', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Distinct icons per host so nothing collapses and the counts are
    // the steady state, not a snapshot taken before failing fetches
    // fold every globe into one.
    await extensionContext.route('https://*.sm-many.invalid/**', async (route) => {
      const host = new URL(route.request().url()).host;
      const icon = `data:image/png;base64,${host.split('.')[0].toUpperCase()}0000`;
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<html><head><link rel="icon" href="${icon}"></head></html>`,
      });
    });
    try {
      const hosts = Array.from({ length: 5 }, (_, i) => `https://h${i}.sm-many.invalid/*`);
      scriptsDir.write({
        relativePath: 'many.user.js',
        meta: { name: 'Many', match: hosts },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);
      const withScripts = await sm.getCollectionWithScripts(collection!.id);
      const scriptId = withScripts!.scripts[0].id;

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const rowIcons = page.locator(
        `section.collection[data-collection-id="${collection!.id}"] tbody tr .site-icon a.site-icon-inner`,
      );
      await expect(rowIcons).toHaveCount(3);
      await expect(rowIcons.locator('img')).toHaveCount(3);
      await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
      const headingIcons = page.locator('h1 .site-icon a.site-icon-inner');
      await expect(headingIcons).toHaveCount(5);
      await expect(headingIcons.locator('img')).toHaveCount(5);
      await page.close();
    } finally {
      await extensionContext.unroute('https://*.sm-many.invalid/**');
    }
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
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const row = page.locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`).first();
    const slot = row.locator('.site-icon');
    // Anchor still points at the @match-derived linkUrl — the @icon
    // header is a visual override only.
    await expect(slot.locator('a.site-icon-inner'))
      .toHaveAttribute('href', 'https://example.com/');
    // The tooltip says whose icon this is — the script's — before the
    // site it opens.
    await expect(slot.locator('a.site-icon-inner'))
      .toHaveAttribute('title', 'Pinned\nhttps://example.com/');
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
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const row = page.locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`).first();
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
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const row = page.locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`).first();
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
      const collection = await sm.addCollection(`${server.baseUrl}/scripts/foo.user.js`);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const row = page.locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`).first();
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

  test('large icons are de-duped into one shared blob: URL across rows', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The collections-page size fix: an icon whose data: URL exceeds the
    // inline threshold is converted ONCE to a blob: URL and shared by
    // every row that uses it, instead of each row inlining the full
    // base64 (which, with dozens of scripts per site, ballooned the
    // page). Two scripts declaring the same large @icon must end up with
    // the identical blob: src, and it must decode back to the original
    // bytes.
    const payload = 'A'.repeat(800);                 // base64 → > inline threshold
    const bigIcon = `data:image/png;base64,${payload}`;
    scriptsDir.write({
      relativePath: 'one.user.js',
      meta: { name: 'One', match: ['https://example.com/*'], extra: [`// @icon ${bigIcon}`] },
      body: '',
    });
    scriptsDir.write({
      relativePath: 'two.user.js',
      meta: { name: 'Two', match: ['https://example.com/*'], extra: [`// @icon ${bigIcon}`] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const imgs = page.locator(
      `section.collection[data-collection-id="${collection!.id}"] .site-icon a.site-icon-inner img`,
    );
    await expect(imgs).toHaveCount(2);
    const src0 = await imgs.nth(0).getAttribute('src');
    const src1 = await imgs.nth(1).getAttribute('src');
    // Both blob:, both the SAME handle → deduped, not inlined per row.
    expect(src0).toMatch(/^blob:/);
    expect(src1).toBe(src0);

    // The shared blob decodes back to the original icon bytes.
    const roundTripped = await page.evaluate(async (u) => {
      const buf = await (await fetch(u)).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }, src0!);
    expect(roundTripped).toBe(payload);
    await page.close();
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
      const collection = await sm.addCollection(scriptsDir.path);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      // The Name column shows each script's `@name`, not its filename.
      const rowFor = (name: string) =>
        page.locator(
          `section.collection[data-collection-id="${collection!.id}"] tbody tr:has-text("${name}")`,
        );

      // Each deep-section script gets its own page URL → its own
      // pathIcon entry. The root script's page URL equals the origin
      // root, so it bypasses the path layer and lands on the
      // origin-level fallback — which begins with a root-HTML probe
      // and therefore sees ICON_ROOT.
      await expect(rowFor('SectionA').locator('.site-icon img'))
        .toHaveAttribute('src', `data:image/png;base64,${ICON_A}`);
      await expect(rowFor('SectionB').locator('.site-icon img'))
        .toHaveAttribute('src', `data:image/png;base64,${ICON_B}`);
      await expect(rowFor('Root').locator('.site-icon img'))
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
    // Pin the origin-discovery path. This test asserts that NO <img>
    // appears, and that must not depend on whether the test machine can
    // reach example.com — which serves `<link rel="icon" href="data:,">`
    // and would otherwise decide the outcome. Both legs that leave the
    // machine are cut: the @match origin and the Google S2 fallback.
    // Unrouted in the `finally` below. `extensionContext` is
    // worker-scoped, so a route left installed blackholes these hosts
    // for every later test that lands in this worker — and which tests
    // those are is scheduling-dependent now the suite runs in parallel.
    await extensionContext.route('https://example.com/**', (route) => route.abort());
    await extensionContext.route('https://www.google.com/**', (route) => route.abort());

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
      const collection = await sm.addCollection(child);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      // Every row's icon slot must show only the globe placeholder —
      // never an <img>. If any traversal had been honored we'd see the
      // PNG's data URL swapped in.
      const rows = page.locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`);
      const slots = rows.locator('.site-icon');
      // `toHaveCount`, not `await slots.count()`: the page renders its
      // rows asynchronously after load, so a one-shot read can see zero
      // and "pass" the traversal check by finding nothing to check.
      await expect(slots).toHaveCount(traversals.length);
      for (let i = 0; i < traversals.length; i++) {
        const slot = slots.nth(i);
        await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
        // No img element should ever appear in the slot for these
        // rejected refs. Origin discovery is the other code path that
        // could paint one, and the routes above make it fail into a
        // null cache entry rather than leaving it up to the network.
        await expect(slot.locator('img')).toHaveCount(0);
      }
      await page.close();
    } finally {
      await extensionContext.unroute('https://example.com/**');
      await extensionContext.unroute('https://www.google.com/**');
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test('a cached empty data: URL heals instead of painting a broken img', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A build predating the empty-`data:` check cached example.com's
    // `<link rel="icon" href="data:,">` marker as though it were an
    // icon. Rows keyed on such an entry painted `<img src="data:,">` —
    // a broken image where the globe belongs — and would have kept
    // doing so until the 7-day success TTL expired. Reads now treat a
    // row they wouldn't paint as a miss, which hides it at once and
    // overwrites it on the refetch.
    //
    // Both legs that would leave the machine are cut, so the refetch
    // lands on "no icon" — a rewritten `dataUrl: null` — no matter
    // what the test host can reach.
    await extensionContext.route('https://example.com/**', (route) => route.abort());
    await extensionContext.route('https://www.google.com/**', (route) => route.abort());
    try {
      scriptsDir.write({
        relativePath: 'poisoned.user.js',
        meta: { name: 'Poisoned', match: ['https://example.com/*'] },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      // Seed the poisoned row from the page (extension pages hold the
      // same chrome.storage.local the icon cache uses), then reload so
      // the render reads it fresh.
      const key = 'siteIcon:https://example.com';
      await page.evaluate(
        ([k]) => chrome.storage.local.set({ [k]: { dataUrl: 'data:,', fetchedAt: Date.now() } }),
        [key],
      );
      await page.reload();

      // Assert the rewrite FIRST: the poll only settles once the
      // refetch has finished and replaced the row, which is the point
      // past which "no img" means the fix worked rather than the paint
      // simply not having happened yet. `toHaveCount(0)` retries until
      // it passes, so on its own it would be satisfied by that earlier
      // state too.
      await expect
        .poll(async () => (await page.evaluate(
          ([k]) => chrome.storage.local.get(k).then(
            (got) => (k in got ? got[k].dataUrl : 'absent'),
          ),
          [key],
        )))
        .toBe(null);

      const slot = page
        .locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`)
        .first()
        .locator('.site-icon');
      await expect(slot.locator('a.site-icon-inner'))
        .toHaveAttribute('href', 'https://example.com/');
      await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
      await expect(slot.locator('img')).toHaveCount(0);
      await page.close();
    } finally {
      await extensionContext.unroute('https://example.com/**');
      await extensionContext.unroute('https://www.google.com/**');
    }
  });

  test('a cached row from an older discovery schema is refetched', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Rows written before cross-host redirect rejection may hold the
    // SSO host's icon under the app's key. They carry no `v`, so the
    // read counts them as a miss and the refetch overwrites them with
    // whatever the current discovery finds — here the site's own icon.
    const POISONED = 'data:image/png;base64,SSOROBOT';
    await extensionContext.route('https://healed.sm-schema.invalid/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/favicon.png') {
        await route.fulfill({ contentType: 'image/png', body: PNG_BYTES });
        return;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><link rel="icon" type="image/png" href="/favicon.png"></head></html>',
      });
    });
    await extensionContext.route('https://www.google.com/**', (route) => route.abort());
    try {
      scriptsDir.write({
        relativePath: 'healed.user.js',
        meta: { name: 'Healed', match: ['https://healed.sm-schema.invalid/*'] },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      const key = 'siteIcon:https://healed.sm-schema.invalid';
      await page.evaluate(
        ([k, poisoned]) => chrome.storage.local.set({ [k]: { dataUrl: poisoned, fetchedAt: Date.now() } }),
        [key, POISONED],
      );
      await page.reload();

      await expect
        .poll(async () => page.evaluate(
          ([k]) => chrome.storage.local.get(k).then((got) => got[k]),
          [key],
        ))
        .toMatchObject({ dataUrl: `data:image/png;base64,${PNG_BASE64}`, v: 2 });

      const slot = page
        .locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`)
        .first()
        .locator('.site-icon');
      await expect(slot.locator('a.site-icon-inner img')).toHaveCount(1);
      await expect(slot.locator('img')).not.toHaveAttribute('src', POISONED);
      await page.close();
    } finally {
      await extensionContext.unroute('https://healed.sm-schema.invalid/**');
      await extensionContext.unroute('https://www.google.com/**');
    }
  });

  test('rejects cross-host SSO redirects instead of caching the login host\'s icon', async ({
    extensionContext, extensionId, sm,
  }) => {
    const SSO_ICON = 'data:image/png;base64,SSOROBOT';
    await extensionContext.route('https://app.sm-sso.invalid/**', async (route) => {
      await route.fulfill({
        status: 302,
        headers: { Location: 'https://login.sm-sso.invalid/request?d=app' },
      });
    });
    await extensionContext.route('https://login.sm-sso.invalid/**', async (route) => {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<html><head><link rel="icon" href="${SSO_ICON}"></head></html>`,
      });
    });
    await extensionContext.route('https://www.google.com/**', (route) => route.abort());

    try {
      scriptsDir.write({
        relativePath: 'corp.user.js',
        meta: { name: 'CorpApp', match: ['https://app.sm-sso.invalid/issues/*'] },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);

      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);

      // Wait until the origin fallback has finished probing and written its
      // settled cache entry (`dataUrl: null`) rather than storing SSO_ICON.
      await expect
        .poll(async () => page.evaluate(
          () => chrome.storage.local.get('siteIcon:https://app.sm-sso.invalid').then(
            (got) => ('siteIcon:https://app.sm-sso.invalid' in got
              ? got['siteIcon:https://app.sm-sso.invalid'].dataUrl
              : 'absent'),
          ),
        ))
        .toBe(null);

      const slot = page
        .locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`)
        .first()
        .locator('.site-icon');
      await expect(slot.locator('svg.site-icon-globe')).toBeVisible();
      await expect(slot.locator('img')).toHaveCount(0);
      await page.close();
    } finally {
      await extensionContext.unroute('https://app.sm-sso.invalid/**');
      await extensionContext.unroute('https://login.sm-sso.invalid/**');
      await extensionContext.unroute('https://www.google.com/**');
    }
  });

  test('uses Chrome\'s _favicon database for visited pages even when network fetches redirect to SSO', async ({
    extensionContext, extensionId, sm,
  }) => {
    // Serve a real 1x1 PNG icon when a user tab visits the page so
    // Chromium records the icon in its internal Favicon database.
    let ssoGateOpen = true;
    await extensionContext.route('https://visited.sm-chrome-db.invalid/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/favicon.png') {
        await route.fulfill({ contentType: 'image/png', body: PNG_BYTES });
        return;
      }
      if (!ssoGateOpen) {
        await route.fulfill({
          status: 302,
          headers: { Location: 'https://login.sm-sso.invalid/request' },
        });
        return;
      }
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><link rel="icon" type="image/png" href="/favicon.png"></head><body>ok</body></html>',
      });
    });
    await extensionContext.route('https://login.sm-sso.invalid/**', async (route) => {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><link rel="icon" href="data:image/png;base64,SSOROBOT"></head></html>',
      });
    });
    await extensionContext.route('https://www.google.com/**', (route) => route.abort());

    try {
      // Visit the target URL in a real tab and wait for Chromium's
      // internal favicon DB (`/_favicon/`) to report a non-default icon.
      const tab = await extensionContext.newPage();
      await tab.goto('https://visited.sm-chrome-db.invalid/app/');
      const extProbe = await extensionContext.newPage();
      await extProbe.goto(`chrome-extension://${extensionId}/collections.html`);
      // `fetchChromeFavicon` is the production lookup: it already
      // compares against the miss sentinel, so a non-null answer is a
      // real DB hit.
      const chromeFavicon = (pageUrl: string, exactPage: boolean) => extProbe.evaluate(
        async ([u, exact]) => {
          // Specifier through a variable: the module is resolved in the
          // extension page, not from tests/ where TypeScript looks.
          const spec = '/extension/site-icon.js';
          const mod = await import(spec) as typeof import('../../src/extension/site-icon');
          return mod.fetchChromeFavicon(u as string, { exactPage: exact as boolean });
        },
        [pageUrl, exactPage],
      );
      await expect
        .poll(() => chromeFavicon('https://visited.sm-chrome-db.invalid/app/', true))
        .not.toBe(null);
      await tab.close();

      // An unvisited page on the same host: Chrome's default host
      // fallback answers with the host icon, the exact-page lookup the
      // path tier uses does not (it would otherwise pin the host icon
      // onto every deep URL before HTML discovery ever ran there).
      const unvisited = 'https://visited.sm-chrome-db.invalid/other/';
      expect(await chromeFavicon(unvisited, false)).not.toBe(null);
      expect(await chromeFavicon(unvisited, true)).toBe(null);
      // A host Chrome has never seen: the globe sentinel filters the
      // default PNG so the lookup reports a miss, not an icon.
      expect(await chromeFavicon('https://never-visited.sm-chrome-db.invalid/', false)).toBe(null);

      // Now close the SSO gate so any direct network fetch to
      // `visited.sm-chrome-db.invalid` bounces to `login.sm-sso.invalid`.
      ssoGateOpen = false;

      scriptsDir.write({
        relativePath: 'visited.user.js',
        meta: { name: 'VisitedApp', match: ['https://visited.sm-chrome-db.invalid/app/*'] },
        body: '',
      });
      const collection = await sm.addCollection(scriptsDir.path);

      await extProbe.reload();
      const slot = extProbe
        .locator(`section.collection[data-collection-id="${collection!.id}"] tbody tr`)
        .first()
        .locator('.site-icon');
      // The row must paint the icon from Chrome's `/_favicon/` DB.
      await expect(slot.locator('a.site-icon-inner img')).toHaveCount(1);
      await extProbe.close();
    } finally {
      await extensionContext.unroute('https://visited.sm-chrome-db.invalid/**');
      await extensionContext.unroute('https://login.sm-sso.invalid/**');
      await extensionContext.unroute('https://www.google.com/**');
    }
  });

  test('an @icon too large to show is a load-time warning on its line', async ({ sm }) => {
    // Shown nowhere else: the slot just keeps its globe.
    scriptsDir.writeRaw('big.png', 'x'.repeat(200 * 1024));
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: { name: 'Big icon', match: ['https://example.com/*'], extra: ['// @icon       big.png'] },
      body: '',
    });
    const collection = await sm.addCollection(scriptsDir.path);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];
    expect(script.status).toBe('ok');
    const warning = (script.startupLogs ?? []).find((l) => l.message.startsWith('@icon '));
    expect(warning).toMatchObject({
      level: 'warn',
      message: '@icon big.png: The file is larger than the 128 KB limit',
      location: { file: 'a.user.js' },
    });
    expect(warning!.location!.line).toBeGreaterThan(1);

    // Refreshes of an unchanged file start from the stored row, which
    // already holds the warning: it must not pile up, and it goes once
    // the icon is fixed.
    await sm.updateCollection(collection!.id, 'manual');
    await sm.updateCollection(collection!.id, 'opportunistic');
    const iconLogs = async () => ((await sm.getCollectionWithScripts(collection!.id))!.scripts[0].startupLogs ?? [])
      .filter((l) => l.message.startsWith('@icon '));
    expect(await iconLogs()).toHaveLength(1);
    scriptsDir.writeRaw('big.png', 'x'.repeat(1024));
    await sm.updateCollection(collection!.id, 'manual');
    expect(await iconLogs()).toHaveLength(0);
  });
});
