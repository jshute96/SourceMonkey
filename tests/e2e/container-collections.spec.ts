// Container collection lifecycle: adding individual `.user.js` URLs no
// longer mints its own collection row — the script is folded into the
// matching container (`Scripts from web`, `Scripts from local disk`,
// `Scripts from GitHub`). The container is created on first add and
// reused thereafter; per-script remove drops just one row.

import { test, expect } from '../fixtures/extension';
import { UserscriptServer } from '../fixtures/userscript-server';

function userscriptText(name: string, tail = ''): string {
  return `// ==UserScript==
// @name ${name}
// @match https://example.com/*
// ==/UserScript==
console.log('${name}');${tail}
`;
}

test.describe('container collections', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => { server = await UserscriptServer.start(); });
  test.afterEach(async () => { await server.stop(); });

  test('adding a single HTTP .user.js URL creates the http container', async ({ sm }) => {
    server.setRoute('/foo.user.js', userscriptText('Foo'));
    const collection = await sm.addCollection(`${server.baseUrl}/foo.user.js`);
    expect(collection).not.toBeNull();
    expect(collection!.path).toBe('container:http');

    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0].path).toBe('container:http');

    const result = await sm.getCollectionWithScripts(collection!.id);
    expect(result!.scripts).toHaveLength(1);
    expect(result!.scripts[0].relativePath).toBe(`${server.baseUrl}/foo.user.js`);
    expect(result!.scripts[0].status).toBe('ok');
  });

  test('a second URL of the same kind joins the existing container', async ({ sm }) => {
    server.setRoute('/foo.user.js', userscriptText('Foo'));
    server.setRoute('/bar.user.js', userscriptText('Bar'));

    const first = await sm.addCollection(`${server.baseUrl}/foo.user.js`);
    const second = await sm.addCollection(`${server.baseUrl}/bar.user.js`);
    expect(second!.id).toBe(first!.id);

    const collections = await sm.getCollections();
    expect(collections).toHaveLength(1);

    const result = await sm.getCollectionWithScripts(first!.id);
    expect(result!.scripts.map((s) => s.relativePath).sort()).toEqual([
      `${server.baseUrl}/bar.user.js`,
      `${server.baseUrl}/foo.user.js`,
    ]);
  });

  test('adding the same URL twice rejects the duplicate', async ({ sm }) => {
    server.setRoute('/foo.user.js', userscriptText('Foo'));
    const first = await sm.addCollection(`${server.baseUrl}/foo.user.js`);
    expect(first).not.toBeNull();

    const dup = await sm.addCollection(`${server.baseUrl}/foo.user.js`);
    expect(dup).toBeNull();

    const result = await sm.getCollectionWithScripts(first!.id);
    expect(result!.scripts).toHaveLength(1);
  });

  test('refreshing a container refetches every child script', async ({ sm }) => {
    server.setRoute('/foo.user.js', userscriptText('Foo'), { etag: 'W/"v1"' });
    server.setRoute('/bar.user.js', userscriptText('Bar'));
    const a = await sm.addCollection(`${server.baseUrl}/foo.user.js`);
    await sm.addCollection(`${server.baseUrl}/bar.user.js`);

    const before = await sm.getCollectionWithScripts(a!.id);
    const fooPrior = before!.scripts.find(
      (s) => s.relativePath === `${server.baseUrl}/foo.user.js`,
    )!;

    // Adding `bar` re-ran refresh on the container (which already
    // held `foo`), so foo's prior ETag is in storage and the second
    // refresh's conditional GET 304s. Manual refresh below adds a
    // third request; on a body-stable route that's another 304.
    const baselineNotModified = server.countResponses('/foo.user.js', 304);
    await new Promise((r) => setTimeout(r, 10));
    await sm.updateCollection(a!.id, 'manual');
    expect(server.countResponses('/foo.user.js', 304)).toBe(baselineNotModified + 1);

    const after = await sm.getCollectionWithScripts(a!.id);
    const fooAfter = after!.scripts.find(
      (s) => s.relativePath === `${server.baseUrl}/foo.user.js`,
    )!;
    expect(fooAfter.loadedAt).toBe(fooPrior.loadedAt);
  });

  test('a container row shows the @name and tooltips the whole URL', async ({
    extensionContext, extensionId, sm,
  }) => {
    // A container script's `relativePath` is its whole URL. The Name
    // column shows the `@name` (and shortens to the basename only when
    // there is no `@name` to show), but the tooltip has no width limit
    // and must carry the full URL — it's what tells two identically
    // named scripts apart. See docs/names-and-paths.md.
    server.setRoute('/deep/path/foo.user.js', userscriptText('Foo'));
    const collection = await sm.addCollection(`${server.baseUrl}/deep/path/foo.user.js`);
    const script = (await sm.getCollectionWithScripts(collection!.id))!.scripts[0];

    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/collections.html`);
    const nameLink = page.locator(
      `tr[data-script-id="${script.id}"] td.name-cell a:not(.site-icon-inner)`,
    );
    await expect(nameLink).toHaveText('Foo');
    await expect(nameLink).toHaveAttribute(
      'title',
      `${server.baseUrl}/deep/path/foo.user.js\n\nNo description`,
    );
    await page.close();
  });
});
