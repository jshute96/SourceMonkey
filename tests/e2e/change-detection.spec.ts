// End-to-end coverage of the unified change-detection pipeline:
// every loaded script carries a `contentHash`, and an "unchanged
// content → preserved loadedAt" outcome must hold across every
// combination of source kind (directory, single-file, manifest) and
// scheme (file://, http(s)://) — using whichever cheap pre-fetch
// skip path the combo supports, with the post-fetch content-hash
// compare as the universal fallback.
//
// The local-directory + file:// case is already covered by
// sources.spec.ts ("refresh skips unchanged files…" / "rewriting a
// script body bumps loadedAt…"). This file fills in the others:
//
//   - HTTP single-file with no ETag/Last-Modified (content-hash path)
//   - HTTP single-file with ETag (HTTP 304 path)
//   - HTTP manifest, no validators (per-entry content-hash path)
//   - file:// manifest (per-entry content-hash path — manifest entries
//     never get a pre-fetch listing stat, so the hash IS the only
//     "unchanged" signal here)
//
// Each test asserts the symmetric pair in one go: unchanged content
// preserves `loadedAt`; mutated content bumps it.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';
import { UserscriptServer, userscriptText } from '../fixtures/userscript-server';

test.describe('change detection', () => {
  let server: UserscriptServer;
  test.beforeEach(async () => { server = await UserscriptServer.start(); });
  test.afterEach(async () => { await server.stop(); });

  test('HTTP single-file: no validators — identical refetch preserves loadedAt, mutated bumps it', async ({ sm }) => {
    // Server returns no ETag / Last-Modified, so the conditional GET
    // can't 304 — every refresh re-fetches the full body. The
    // post-fetch contentHash compare is what keeps loadedAt stable
    // when the bytes haven't changed.
    server.setRoute('/foo.user.js', userscriptText('Foo'));
    const source = await sm.addSource(`${server.baseUrl}/foo.user.js`);
    const before = await sm.getSourceWithScripts(source!.id);
    const priorLoadedAt = before!.scripts[0].loadedAt;
    expect(before!.scripts[0].status).toBe('ok');

    // Same body — different physical fetch, identical bytes → loadedAt unchanged.
    await new Promise((r) => setTimeout(r, 10));
    await sm.updateSource(source!.id, 'manual');
    let after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts[0].loadedAt).toBe(priorLoadedAt);

    // Now change the body. New bytes → loadedAt bumps.
    server.setRoute('/foo.user.js', userscriptText('Foo', ' /* v2 */'));
    await sm.updateSource(source!.id, 'manual');
    after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts[0].loadedAt).toBeGreaterThan(priorLoadedAt);
    expect(after!.scripts[0].bodyText).toContain('v2');
  });

  test('HTTP single-file: with ETag — conditional GET 304 preserves loadedAt, body change forces 200 + bump', async ({ sm }) => {
    // Server returns an ETag the SW captures on the first fetch and
    // replays as If-None-Match next time. The cheap-skip HTTP 304 path
    // fires (no body crosses the wire); content-hash never needed.
    server.setRoute('/bar.user.js', userscriptText('Bar'), { etag: 'W/"v1"' });
    const source = await sm.addSource(`${server.baseUrl}/bar.user.js`);
    const before = await sm.getSourceWithScripts(source!.id);
    const priorLoadedAt = before!.scripts[0].loadedAt;

    // Conditional GET → 304 → unchanged. loadedAt preserved. We assert
    // the 304 explicitly via the server's request log — without this
    // the content-hash fallback would produce the same observed
    // loadedAt and the test would silently double-cover the wrong
    // path.
    await new Promise((r) => setTimeout(r, 10));
    await sm.updateSource(source!.id, 'manual');
    let after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts[0].loadedAt).toBe(priorLoadedAt);
    expect(server.countResponses('/bar.user.js', 304)).toBe(1);
    const conditional = server.requestLog.find(
      (e) => e.path === '/bar.user.js' && e.status === 304,
    );
    expect(conditional?.ifNoneMatch).toBe('W/"v1"');

    // Rotate the ETag AND change the body. Conditional GET → 200,
    // new body, fresh validators captured, loadedAt bumped.
    server.setRoute('/bar.user.js', userscriptText('Bar', ' /* v2 */'), { etag: 'W/"v2"' });
    await sm.updateSource(source!.id, 'manual');
    after = await sm.getSourceWithScripts(source!.id);
    expect(after!.scripts[0].loadedAt).toBeGreaterThan(priorLoadedAt);
    expect(after!.scripts[0].bodyText).toContain('v2');
    // The third refresh request must have come back 200 (server still
    // had the old ETag, but the SW had captured v1; rotating the
    // route's body+ETag means the SW's If-None-Match no longer
    // matches → 200).
    expect(server.countResponses('/bar.user.js', 200)).toBeGreaterThanOrEqual(2);
  });

  test('HTTP manifest, no validators: per-entry unchanged content preserves loadedAt, only the changed entry bumps', async ({ sm }) => {
    // Manifests don't carry per-file stat at scan time, and an HTTP
    // server with no validators can't 304 — so every entry is
    // physically re-fetched every refresh. The content-hash compare
    // has to do the entire "what changed" job here. This is the
    // original failure mode that motivated the unified token: before
    // the fix every entry would flip its loadedAt every refresh.
    server.setRoute('/a.user.js', userscriptText('A'));
    server.setRoute('/b.user.js', userscriptText('B'));
    server.setManifest('/manifest.json', ['a.user.js', 'b.user.js']);

    const source = await sm.addSource(`${server.baseUrl}/manifest.json`);
    const before = await sm.getSourceWithScripts(source!.id);
    expect(before!.scripts).toHaveLength(2);
    const priorByPath = Object.fromEntries(
      before!.scripts.map((s) => [s.relativePath, s]),
    );
    expect(priorByPath['a.user.js'].status).toBe('ok');
    expect(priorByPath['b.user.js'].status).toBe('ok');

    // Refresh with everything identical. Both entries hit the
    // content-hash path → both loadedAt values preserved.
    await new Promise((r) => setTimeout(r, 10));
    await sm.updateSource(source!.id, 'manual');
    let after = await sm.getSourceWithScripts(source!.id);
    let afterByPath = Object.fromEntries(after!.scripts.map((s) => [s.relativePath, s]));
    expect(afterByPath['a.user.js'].loadedAt).toBe(priorByPath['a.user.js'].loadedAt);
    expect(afterByPath['b.user.js'].loadedAt).toBe(priorByPath['b.user.js'].loadedAt);

    // Change only `b`. `a`'s loadedAt must remain pinned to its prior
    // value while `b` advances — proves the new-file / updated-file
    // distinction the options page relies on for its highlights.
    server.setRoute('/b.user.js', userscriptText('B', ' /* v2 */'));
    await sm.updateSource(source!.id, 'manual');
    after = await sm.getSourceWithScripts(source!.id);
    afterByPath = Object.fromEntries(after!.scripts.map((s) => [s.relativePath, s]));
    expect(afterByPath['a.user.js'].loadedAt).toBe(priorByPath['a.user.js'].loadedAt);
    expect(afterByPath['b.user.js'].loadedAt).toBeGreaterThan(priorByPath['b.user.js'].loadedAt);
    expect(afterByPath['b.user.js'].bodyText).toContain('v2');
  });

  test('file:// manifest: identical content preserves loadedAt, mutated bumps it', async ({ sm }) => {
    // A manifest sitting on the local filesystem and pointing at local
    // file:// scripts. Per-entry file:// fetches are always physical
    // (manifest scans carry no listing stat), so this is the
    // content-hash path's responsibility, same as the HTTP-no-validator
    // case above — just with a different wire protocol.
    const scriptsDir = ScriptsDir.create();
    try {
      scriptsDir.write({
        relativePath: 'a.user.js',
        meta: { name: 'A', match: ['https://example.com/*'] },
        body: 'console.log("v1");',
      });
      const fs = await import('node:fs');
      const path = await import('node:path');
      const manifestPath = path.join(scriptsDir.path, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(['a.user.js']));

      const source = await sm.addSource(manifestPath);
      const before = await sm.getSourceWithScripts(source!.id);
      expect(before!.scripts).toHaveLength(1);
      expect(before!.scripts[0].status).toBe('ok');
      const priorLoadedAt = before!.scripts[0].loadedAt;

      // Refresh without touching anything. Manifest-entry file://
      // fetches always physically re-read; content-hash keeps
      // loadedAt stable.
      await new Promise((r) => setTimeout(r, 10));
      await sm.updateSource(source!.id, 'manual');
      let after = await sm.getSourceWithScripts(source!.id);
      expect(after!.scripts[0].loadedAt).toBe(priorLoadedAt);

      // Mutate the body → fresh hash → loadedAt bumps.
      scriptsDir.rewriteBody('a.user.js', 'console.log("v2");');
      await sm.updateSource(source!.id, 'manual');
      after = await sm.getSourceWithScripts(source!.id);
      expect(after!.scripts[0].loadedAt).toBeGreaterThan(priorLoadedAt);
      expect(after!.scripts[0].bodyText).toContain('v2');
    } finally {
      scriptsDir.cleanup();
    }
  });

  test('every loaded script carries a contentHash (the universal last-change token)', async ({ sm }) => {
    // Smoke test: an HTTP single-file source's row must come back with
    // contentHash populated regardless of whether the server supplied
    // validators. Without this field the post-fetch compare wouldn't
    // work on subsequent refreshes.
    server.setRoute('/c.user.js', userscriptText('C'));
    const source = await sm.addSource(`${server.baseUrl}/c.user.js`);
    const result = await sm.getSourceWithScripts(source!.id);
    expect(result!.scripts[0].status).toBe('ok');
    expect(typeof (result!.scripts[0] as { contentHash?: string }).contentHash).toBe('string');
  });
});
