// Importing a Tampermonkey backup through the collections page's
// Import dialog. Drives the real dialog and the real store, so this
// covers the whole path a migrating user takes — the parse, the pinned
// vs located split, the enable mirroring, and the fact that a Refresh
// All afterwards leaves the imported bodies alone.
//
// The backup format is documented in docs/export-format.md.

import { test, expect } from '../fixtures/extension';
import type { SmApi } from '../fixtures/sw-api';
import { UserscriptServer } from '../fixtures/userscript-server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function userscript(name: string, extraHeaderLines: string[] = []): string {
  return [
    '// ==UserScript==',
    `// @name         ${name}`,
    '// @match        https://example.com/*',
    ...extraHeaderLines,
    '// ==/UserScript==',
    '',
    `console.log(${JSON.stringify(name)});`,
  ].join('\n');
}

interface BackupScript {
  name: string;
  enabled?: boolean;
  position?: number;
  file_url?: string | null;
  options?: Record<string, unknown>;
  storage?: { ts: number; data: Record<string, unknown> };
  headerLines?: string[];
}

function backupJson(scripts: BackupScript[]): string {
  return JSON.stringify({
    settings: {},
    scripts: scripts.map((s, i) => ({
      uuid: `uuid-${i + 1}`,
      name: s.name,
      file_url: s.file_url ?? null,
      enabled: s.enabled ?? true,
      position: s.position ?? i + 1,
      options: s.options ?? {},
      storage: s.storage ?? { ts: 0, data: {} },
      source: b64(userscript(s.name, s.headerLines)),
      requires: [],
      resources: [],
    })),
  });
}

test.describe('import from Tampermonkey', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-import-'));
  });
  test.afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Write a backup to disk and run it through the dialog. Returns the
  // page so the caller can assert against the section it landed on.
  async function importBackup(
    page: import('@playwright/test').Page,
    contents: string,
    filename = 'tampermonkey-backup.txt',
  ): Promise<void> {
    const file = path.join(dir, filename);
    fs.writeFileSync(file, contents, 'utf8');
    await page.locator('#open-import').click();
    await expect(page.locator('#import-dialog')).toBeVisible();
    await page.locator('#import-file').setInputFiles(file);
    await page.locator('#import-run').click();
  }

  test('creates one collection holding every script in the backup', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    await importBackup(page, backupJson([
      { name: 'Alpha', position: 1 },
      { name: 'Beta', position: 2 },
    ]));

    await expect(page.locator('#import-dialog')).toBeHidden();
    const section = page.locator('section.collection');
    await expect(section).toHaveCount(1);
    await expect(section.locator('h2 .collection-display-name'))
      .toHaveText(/^Imported from Tampermonkey \(.+\)$/);
    await expect(section.locator('h2 .collection-type-bubble')).toHaveText('imported');
    await expect(section.locator('tbody tr')).toHaveCount(2);

    // The row shows the script's `@name`; the synthesized filename is
    // what the store holds, in the backup's own order.
    await expect(section.locator('tbody tr td.name-cell')).toHaveText(['Alpha', 'Beta']);
    expect((await allScripts(sm)).map((s) => s.relativePath))
      .toEqual(['Alpha.user.js', 'Beta.user.js']);
    for (const s of await allScripts(sm)) expect(s.status).toBe('ok');
    await page.close();
  });

  test('orders scripts by the dashboard position, not file order', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    await importBackup(page, backupJson([
      { name: 'Last', position: 9 },
      { name: 'First', position: 1 },
    ]));

    await expect(page.locator('section.collection tbody tr td.name-cell'))
      .toHaveText(['First', 'Last']);
    // The stored order is what matters beyond the render — `scriptIds`
    // is the collection's own sequence, not something the page derives.
    expect((await allScripts(sm)).map((s) => s.relativePath))
      .toEqual(['First.user.js', 'Last.user.js']);
    await page.close();
  });

  test('mirrors each script\'s enabled state from the backup', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    await importBackup(page, backupJson([
      { name: 'On', position: 1, enabled: true },
      { name: 'Off', position: 2, enabled: false },
    ]));

    await expect(page.locator('section.collection tbody tr')).toHaveCount(2);
    const scripts = await allScripts(sm);
    const byName = new Map(scripts.map((s) => [s.relativePath, s.enabled]));
    expect(byName.get('On.user.js')).toBe(true);
    expect(byName.get('Off.user.js')).toBe(false);
    await page.close();
  });

  test('records a location for a web-installed script and pins the rest', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    await importBackup(page, backupJson([
      { name: 'Web', position: 1, file_url: 'https://example.com/web.user.js' },
      { name: 'Header', position: 2,
        headerLines: ['// @downloadURL https://example.com/header.user.js'] },
      { name: 'Homegrown', position: 3 },
      // Edited inside Tampermonkey: a URL exists, but refetching it
      // would discard the edit, so this one is pinned too.
      { name: 'Edited', position: 4,
        file_url: 'https://example.com/edited.user.js',
        options: { user_modified: 1777135224538 } },
    ]));

    await expect(page.locator('section.collection tbody tr')).toHaveCount(4);
    const byName = new Map((await allScripts(sm)).map((s) => [s.relativePath, s.fileUrl]));
    expect(byName.get('Web.user.js')).toBe('https://example.com/web.user.js');
    expect(byName.get('Header.user.js')).toBe('https://example.com/header.user.js');
    expect(byName.get('Homegrown.user.js')).toMatch(/^sourcemonkey:\/\/imported\//);
    expect(byName.get('Edited.user.js')).toMatch(/^sourcemonkey:\/\/imported\//);
    await page.close();
  });

  test('a pinned script says so instead of showing a location', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await importBackup(page, backupJson([{ name: 'Homegrown' }]));
    await expect(page.locator('section.collection tbody tr')).toHaveCount(1);

    const [script] = await allScripts(sm);
    const viewer = await extensionContext.newPage();
    await viewer.goto(`chrome-extension://${extensionId}/userscript.html?script=${script.id}`);
    const locationRow = viewer.locator('.location-none');
    await expect(locationRow).toHaveText('Imported from Tampermonkey, with no external location');
    // Nothing to open and nothing to copy, so neither affordance is drawn.
    await expect(viewer.locator('.filename-cell a')).toHaveCount(0);
    await viewer.close();
    await page.close();
  });

  test('Refresh is offered for a located import and refused for a pinned one', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await importBackup(page, backupJson([
      { name: 'Web', position: 1, file_url: 'https://example.com/web.user.js' },
      { name: 'Homegrown', position: 2 },
    ]));
    await expect(page.locator('section.collection tbody tr')).toHaveCount(2);

    const byName = new Map((await allScripts(sm)).map((s) => [s.relativePath, s.id]));
    const viewer = await extensionContext.newPage();

    // Pinned: nothing to refresh from, so the button says why instead
    // of spinning and changing nothing.
    await viewer.goto(
      `chrome-extension://${extensionId}/userscript.html?script=${byName.get('Homegrown.user.js')}`,
    );
    await expect(viewer.locator('#refresh-btn')).toBeDisabled();
    await expect(viewer.locator('#refresh-btn'))
      .toHaveAttribute('title', /imported and has no location to refresh from/);

    // Located: an ordinary web-backed row, so Refresh works as usual.
    await viewer.goto(
      `chrome-extension://${extensionId}/userscript.html?script=${byName.get('Web.user.js')}`,
    );
    await expect(viewer.locator('#refresh-btn')).toBeEnabled();
    await viewer.close();
    await page.close();
  });

  // Regression: the fetch half of refresh derives its URL separately
  // from the write half. When only the write half knew about import
  // collections, refreshing a located row fetched
  // `file:///import%3A<uuid>/<name>.user.js` and left a permanent
  // REFRESH FAILED badge — on the opportunistic per-navigation check as
  // well as an explicit click, so it appeared on its own. Asserting the
  // button is merely enabled does not catch that; this clicks it.
  test('a located import refreshes from its real URL and picks up new content', async ({
    extensionContext, extensionId, sm,
  }) => {
    const server = await UserscriptServer.start();
    try {
      server.setRoute('/web.user.js', userscript('Web', ['// @version 2.0.0']));
      const page = await extensionContext.newPage();
      await page.goto(`chrome-extension://${extensionId}/collections.html`);
      // The backup carries the same bytes the server is serving right
      // now — that is what a real export looks like.
      await importBackup(page, backupJson([
        { name: 'Web', file_url: `${server.baseUrl}/web.user.js`,
          headerLines: ['// @version 2.0.0'] },
      ]));
      await expect(page.locator('section.collection tbody tr')).toHaveCount(1);

      const [before] = await allScripts(sm);
      expect(before.fileUrl).toBe(`${server.baseUrl}/web.user.js`);

      // Upstream moves on, then the user clicks Refresh in the viewer.
      server.setRoute('/web.user.js', userscript('Web', ['// @version 3.0.0']));
      const viewer = await extensionContext.newPage();
      await viewer.goto(`chrome-extension://${extensionId}/userscript.html?script=${before.id}`);
      await viewer.locator('#refresh-btn').click();
      await expect(viewer.locator('#refresh-btn')).toBeEnabled();

      const [after] = await allScripts(sm);
      expect(after.refreshError).toBeUndefined();
      expect(after.status).toBe('ok');
      // Assert on the header, not `bodyText`: the split puts the
      // metadata block in `headerText`, so a version bump alone leaves
      // the body byte-identical.
      expect(before.headerText).toContain('@version 2.0.0');
      expect(after.headerText).toContain('@version 3.0.0');
      await viewer.close();
      await page.close();
    } finally {
      await server.stop();
    }
  });

  test('carries GM_setValue data across so scripts keep their settings', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    await importBackup(page, backupJson([
      { name: 'Stateful', storage: { ts: 1, data: { theme: 'dark', count: 7 } } },
    ]));
    await expect(page.locator('section.collection tbody tr')).toHaveCount(1);

    const [script] = await allScripts(sm);
    const values = await readValues(sm, script.id);
    expect(values).toEqual({ theme: 'dark', count: 7 });
    await page.close();
  });

  test('Refresh All leaves imported bodies alone', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    await importBackup(page, backupJson([{ name: 'Homegrown' }]));
    await expect(page.locator('section.collection tbody tr')).toHaveCount(1);

    const before = (await allScripts(sm))[0];
    await page.locator('#refresh-all').click();
    // Wait for the refresh to settle rather than racing the assertion.
    await expect(page.locator('#refresh-all')).toBeEnabled();

    const after = (await allScripts(sm))[0];
    expect(after.status).toBe('ok');
    expect(after.refreshError).toBeUndefined();
    expect(after.bodyText).toBe(before.bodyText);
    expect(after.loadedAt).toBe(before.loadedAt);
    await page.close();
  });

  test('importing twice makes a second collection rather than merging', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    await importBackup(page, backupJson([{ name: 'Alpha' }]), 'first.txt');
    await expect(page.locator('section.collection')).toHaveCount(1);
    await importBackup(page, backupJson([{ name: 'Alpha' }]), 'second.txt');
    await expect(page.locator('section.collection')).toHaveCount(2);

    // Two collections, two distinct synthetic paths — which is what
    // keeps the duplicate-path check from rejecting the second import.
    const paths = (await sm.getCollections()).map((c) => c.path);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    for (const p of paths) expect(p).toMatch(/^import:/);
    await page.close();
  });

  test('a userscript handed to the dialog is redirected to Add', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    await importBackup(page, userscript('Not a backup'), 'thing.user.js');

    // Dialog stays open with the complaint, and nothing was created.
    await expect(page.locator('#import-dialog')).toBeVisible();
    await expect(page.locator('#import-error'))
      .toHaveText(/Add it with the Add field instead/);
    await expect(page.locator('section.collection')).toHaveCount(0);
    expect(await sm.getCollections()).toEqual([]);
    await page.close();
  });

  test('an unreadable script is reported while the rest import', async ({
    extensionContext, extensionId, sm,
  }) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);

    // Hand-built so one entry's source is not base64 at all.
    const broken = JSON.parse(backupJson([
      { name: 'Good', position: 1 },
      { name: 'Broken', position: 2 },
    ]));
    broken.scripts[1].source = '!!! not base64 !!!';

    await importBackup(page, JSON.stringify(broken));

    await expect(page.locator('#import-dialog')).toBeHidden();
    await expect(page.locator('section.collection tbody tr')).toHaveCount(1);
    await expect(page.locator('#import-warnings')).toBeVisible();
    await expect(page.locator('#import-warnings')).toContainText('Broken');
    expect((await allScripts(sm)).map((s) => s.relativePath)).toEqual(['Good.user.js']);
    await page.close();
  });
});

// Every script row in storage. The import tests only ever create one
// collection at a time, so this reads as "the imported scripts". Goes
// through the collection index rather than a bulk read because that is
// what the SW test surface exposes.
async function allScripts(sm: SmApi) {
  const collections = await sm.getCollections();
  const out: ScriptRow[] = [];
  for (const c of collections) {
    const withScripts = await sm.getCollectionWithScripts(c.id);
    if (withScripts) out.push(...(withScripts.scripts as unknown as ScriptRow[]));
  }
  return out;
}

interface ScriptRow {
  id: string;
  relativePath: string;
  fileUrl: string;
  status: string;
  enabled: boolean;
  headerText: string;
  bodyText: string;
  loadedAt: number;
  refreshError?: string;
}

async function readValues(sm: SmApi, scriptId: string) {
  return await sm.getGmValues(scriptId);
}
