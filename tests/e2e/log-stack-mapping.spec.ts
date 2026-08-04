// The viewer's Log tab maps `Error.stack` line numbers back to the
// file they were written in.
//
// Why this needs its own coverage: under Mode A a script's `@require`
// bodies and its own body are concatenated into ONE injected entry, so
// V8 stamps every frame with the script's `.user.js` sourceURL at a
// GENERATED line. Chrome's console hides that — devtools applies the
// entry's inline source map to the display — but `err.stack` is a
// plain string, and that string is what reaches our log. Without the
// mapping, a throw inside a library is reported as the `.user.js` at a
// line that usually lands somewhere in its metadata header.
//
// Everything below is about the string the user actually reads and the
// tab a click actually lands on. The unit tests
// (source-map.test.mjs, the round-trip tests in injector.test.mjs)
// cover the coordinate arithmetic; this covers the wiring.

import fs from 'node:fs';
import path from 'node:path';

import type { BrowserContext } from '@playwright/test';
import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

// A library whose throw is on a line we can name exactly. `boom` is
// declared on line 3 and throws on line 4, and the call that reaches
// it comes from the body — so a correct mapping produces a frame at
// lib.js:4 and NOT at main.user.js.
const LIB_JS = [
  '// lib.js line 1',
  '// lib.js line 2',
  'function requireBoom() {',
  '  throw new Error("boom-from-require");',
  '}',
].join('\n');

// Line the throw sits on, 1-based, in lib.js above.
const THROW_LINE = 4;

test.describe('log stack mapping', () => {
  let scriptsDir: ScriptsDir;
  test.beforeEach(() => { scriptsDir = ScriptsDir.create(); });
  test.afterEach(() => { scriptsDir.cleanup(); });

  async function installThrowingScript(
    sm: { addSource: (p: string) => Promise<unknown>; syncNow: () => Promise<unknown>;
          getSources: () => Promise<{ scriptIds: string[] }[]> },
    matchBase: string,
  ): Promise<string> {
    fs.writeFileSync(path.join(scriptsDir.path, 'lib.js'), LIB_JS);
    scriptsDir.write({
      relativePath: 'main.user.js',
      meta: {
        name: 'StackMapping',
        match: [`${matchBase}/*`],
        runAt: 'document-end',
        extra: ['// @require     lib.js'],
      },
      // The body calls into the library, so the top frame is in
      // lib.js and the frame below it is in the body — one stack,
      // both files, which is what makes the per-frame mapping visible.
      body: 'requireBoom();',
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();
    const sources = await sm.getSources();
    const scriptIds = sources.flatMap((s) => s.scriptIds);
    expect(scriptIds.length).toBe(1);
    return scriptIds[0];
  }

  async function openLogTab(
    extensionContext: BrowserContext, extensionId: string, scriptId: string,
  ) {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}#Log`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#log-pane table')).toBeVisible();
    return page;
  }

  test('a throw inside a @require is logged against lib.js, not the .user.js', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    const scriptId = await installThrowingScript(sm, fixtureServer.baseUrl);

    const target = await extensionContext.newPage();
    await target.goto(`${fixtureServer.baseUrl}/target.html`);
    await target.waitForTimeout(500);
    await target.close();

    // The raw stack really does name the .user.js — that's the thing
    // being corrected, so pin it. If this ever stops being true the
    // mapping below is compensating for something that no longer
    // happens, and the test should be revisited rather than adjusted.
    const raw = await sm.getScriptLog(scriptId);
    const rawError = raw.find((e) => e.level === 'error' && /boom-from-require/.test(e.message));
    expect(rawError, 'the throw should be logged').toBeTruthy();
    expect(rawError!.message).toMatch(/main\.user\.js:\d+:\d+/);
    expect(rawError!.message).not.toMatch(/lib\.js:/);

    const page = await openLogTab(extensionContext, extensionId, scriptId);

    // ...and the rendered row names lib.js at the line the throw is
    // on. The link text is the mapped ref, not the raw one.
    const link = page.locator('.log-stack-link', { hasText: 'lib.js' }).first();
    await expect(link).toBeVisible();
    await expect(link).toHaveText(new RegExp(`/lib\\.js:${THROW_LINE}:\\d+$`));

    await page.close();
  });

  test('clicking a mapped ref opens the require tab at the throwing line', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    const scriptId = await installThrowingScript(sm, fixtureServer.baseUrl);

    const target = await extensionContext.newPage();
    await target.goto(`${fixtureServer.baseUrl}/target.html`);
    await target.waitForTimeout(500);
    await target.close();

    const page = await openLogTab(extensionContext, extensionId, scriptId);
    await page.locator('.log-stack-link', { hasText: 'lib.js' }).first().click();

    // The view state lives in the URL hash, so it's the honest
    // assertion for "which tab, which line".
    await expect.poll(() => page.evaluate(() => location.hash))
      .toMatch(new RegExp(`^#lib\\.js:${THROW_LINE}:\\d+$`));

    // And the code pane really is showing lib.js.
    await expect(page.locator('#tabs .tab.active')).toHaveText('lib.js');
    await expect(page.locator('#content')).toContainText('throw new Error("boom-from-require")');

    await page.close();
  });

  test('the body frame in the same stack maps to the .user.js at its own line', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    // The other half of the mapping: the caller frame belongs to the
    // script itself, and must come back as the line the call is
    // written on in the file the user edits — NOT the generated line,
    // which sits several lines lower because lib.js precedes it.
    const scriptId = await installThrowingScript(sm, fixtureServer.baseUrl);

    const target = await extensionContext.newPage();
    await target.goto(`${fixtureServer.baseUrl}/target.html`);
    await target.waitForTimeout(500);
    await target.close();

    const page = await openLogTab(extensionContext, extensionId, scriptId);

    const mainLink = page.locator('.log-stack-link', { hasText: 'main.user.js' }).first();
    await expect(mainLink).toBeVisible();
    const text = await mainLink.textContent();
    const line = Number(/main\.user\.js:(\d+):/.exec(text ?? '')?.[1]);
    expect(Number.isFinite(line)).toBe(true);

    // Resolve it against the stored file rather than hardcoding a
    // number, so the assertion survives changes to the header the
    // fixture writes.
    const stored = fs.readFileSync(path.join(scriptsDir.path, 'main.user.js'), 'utf8');
    expect(stored.split('\n')[line - 1]).toContain('requireBoom();');

    await page.close();
  });

  test('a ref on a line that belongs to our wrap is not a link', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    // Not every generated line is user code. Line 1 is the wrap head;
    // the `// @require` markers and the `;` ASI guards between
    // concatenated files are ours too. Those have no honest original
    // line, and the generated number indexes the concatenated program
    // — so following it would land on unrelated code, or past EOF
    // where the click does nothing at all. They must render as plain
    // text instead.
    const scriptId = await installThrowingScript(sm, fixtureServer.baseUrl);
    const label = 'main.user.js';
    const entryUrl = `sourcemonkey://SourceMonkey/main/${label}`;
    await sm.appendScriptLog(scriptId, {
      level: 'error',
      source: 'wrapper',
      // Generated line 1 is the wrap head — before any require's text.
      message: `Error: synthetic\n    at wrapHead (${entryUrl}:1:5)`,
    });

    const page = await openLogTab(extensionContext, extensionId, scriptId);
    const row = page.locator('#log-pane td.log-msg', { hasText: 'synthetic' });
    await expect(row).toContainText(`${entryUrl}:1:5`);
    // Present as text, absent as a link.
    await expect(row.locator('.log-stack-link')).toHaveCount(0);

    await page.close();
  });

  test('entries older than the current body are left unmapped', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    // The log outlives refreshes — nothing clears it but the user's
    // Clear button. An entry recorded against an older arrangement of
    // requires would map to a confidently wrong file and line if we
    // applied today's segments to it, which is worse than the
    // obviously-generated number it already carries.
    const scriptId = await installThrowingScript(sm, fixtureServer.baseUrl);
    const sources = await sm.getSources();
    const withScripts = await sm.getSourceWithScripts(sources[0].id);
    const loadedAt = withScripts!.scripts.find((s) => s.id === scriptId)!.loadedAt;
    const label = 'main.user.js';
    const entryUrl = `sourcemonkey://SourceMonkey/main/${label}`;
    // Same generated line the real throw maps to lib.js from, but
    // stamped before this body loaded.
    await sm.appendScriptLog(scriptId, {
      level: 'error',
      source: 'wrapper',
      message: `Error: stale-entry\n    at old (${entryUrl}:5:9)`,
      timestamp: loadedAt - 1000,
    });

    const page = await openLogTab(extensionContext, extensionId, scriptId);
    const row = page.locator('#log-pane td.log-msg', { hasText: 'stale-entry' });
    // Untouched: still the entry URL at the generated line, not lib.js.
    await expect(row).toContainText(`${entryUrl}:5:9`);
    await expect(row).not.toContainText('lib.js');

    await page.close();
  });

  test('an encoded log-ID suffix is shown decoded', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    // What a SECOND `main.user.js` really produces. The log label
    // `main.user.js#2` cannot go into `//# sourceURL=` as written — a
    // bare `#` starts a fragment, splitting the path — so the emitted
    // URL, and therefore every frame V8 stamps with it, carries `%232`.
    // Correct on the wire, unreadable in the log.
    const scriptId = await installThrowingScript(sm, fixtureServer.baseUrl);
    const encoded = 'sourcemonkey://SourceMonkey/main%232/main.user.js';
    await sm.appendScriptLog(scriptId, {
      level: 'error',
      source: 'wrapper',
      message: `Error: encoded-label\n    at f (${encoded}:3:1)`,
    });

    const page = await openLogTab(extensionContext, extensionId, scriptId);
    const row = page.locator('#log-pane td.log-msg', { hasText: 'encoded-label' });
    await expect(row).toContainText('sourcemonkey://SourceMonkey/main#2/main.user.js:3:1');
    await expect(row).not.toContainText('%232');

    await page.close();
  });

  test('a percent escape in a real URL is left encoded', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    // Only our own scheme decodes. An `http(s)` ref names a file the
    // user may want to compare against a `@require` line or paste into
    // the address bar, and `%2F` there is a literal slash in a segment
    // — decoding it would silently rename the file it points at.
    const scriptId = await installThrowingScript(sm, fixtureServer.baseUrl);
    const real = 'https://cdn.example.com/a%2Fb/lib%20one.js';
    await sm.appendScriptLog(scriptId, {
      level: 'error',
      source: 'wrapper',
      message: `Error: real-url\n    at f (${real}:7:2)`,
    });

    const page = await openLogTab(extensionContext, extensionId, scriptId);
    const row = page.locator('#log-pane td.log-msg', { hasText: 'real-url' });
    await expect(row).toContainText(`${real}:7:2`);

    await page.close();
  });

  test('a script with no @require is left alone', async ({
    extensionContext, extensionId, fixtureServer, sm,
  }) => {
    // Nothing is concatenated, so nothing shifted, so the mapping must
    // be a no-op — a script without requires has to keep reporting its
    // own line numbers. This is the case that would break if the
    // viewer applied a layout it hadn't checked for emptiness.
    scriptsDir.write({
      relativePath: 'plain.user.js',
      meta: {
        name: 'PlainThrow',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
      },
      body: 'throw new Error("plain-boom");',
    });
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();
    const sources = await sm.getSources();
    const scriptId = sources.flatMap((s) => s.scriptIds)[0];

    const target = await extensionContext.newPage();
    await target.goto(`${fixtureServer.baseUrl}/target.html`);
    await target.waitForTimeout(500);
    await target.close();

    const page = await openLogTab(extensionContext, extensionId, scriptId);
    const link = page.locator('.log-stack-link').first();
    await expect(link).toBeVisible();
    const text = await link.textContent();
    expect(text).toMatch(/plain\.user\.js:\d+:\d+$/);
    const line = Number(/plain\.user\.js:(\d+):/.exec(text ?? '')?.[1]);
    const stored = fs.readFileSync(path.join(scriptsDir.path, 'plain.user.js'), 'utf8');
    expect(stored.split('\n')[line - 1]).toContain('plain-boom');

    await page.close();
  });
});
