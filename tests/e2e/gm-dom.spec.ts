// End-to-end tests for the DOM-injection GM_* APIs (Phase 4).
//
// The page's CSP doesn't apply to USER_SCRIPT-world DOM mutations, so
// a script using these APIs on a strict-CSP page can still inject
// styles and elements that the page itself couldn't. A MAIN-world
// script's calls hand the insert to the bridge in USER_SCRIPT world. Inserted scripts
// are covered in user-script-world-csp.spec.ts.

import { test, expect } from '../fixtures/extension';
import { ScriptsDir } from '../fixtures/scripts-dir';

test.describe('GM_addStyle / GM_addElement (Phase 4)', () => {
  let scriptsDir: ScriptsDir;

  test.beforeEach(() => {
    scriptsDir = ScriptsDir.create();
  });
  test.afterEach(() => {
    scriptsDir.cleanup();
  });

  test('GM_addStyle injects a <style> with the given CSS', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'AddStyle',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addStyle'],
      },
      body: `
        const styleEl = GM_addStyle('#target { color: rgb(255, 0, 0); }');
        document.body.dataset.smStyleTag = String(styleEl && styleEl.tagName);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    // The script returned the <style> element.
    await expect(page.locator('body')).toHaveAttribute('data-sm-style-tag', 'STYLE');
    // The CSS was actually applied to #target.
    const targetColor = await page.locator('#target').evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(targetColor).toBe('rgb(255, 0, 0)');
    await page.close();
  });

  test('a MAIN-world GM_addStyle / GM_addElement is exempt from page CSP too', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The runtime hands the insert to the bridge in USER_SCRIPT world,
    // so a strict style-src doesn't drop the rules, and nothing is
    // reported. A parent in a shadow root goes the same way.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CspStyle',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addStyle', 'GM_addElement', 'GM_log'],
        injectInto: 'page',
      },
      body: `
        const style = GM_addStyle('#target { color: rgb(1, 2, 3); }');
        GM_addElement('style', { textContent: '#target { font-weight: 700; }' });
        const host = document.body.appendChild(document.createElement('div'));
        const root = host.attachShadow({ mode: 'open' });
        const inner = root.appendChild(document.createElement('span'));
        inner.id = 'inner';
        GM_addElement(root, 'style', { textContent: '#inner { color: rgb(4, 5, 6); }' });
        document.body.dataset.smInDoc = String(style.isConnected);
        document.body.dataset.smDone = '1';
        GM_log('inserts done');
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const scriptId = (await sm.getCollectionWithScripts(added!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/strict-csp.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-done', '1');
    // In the document by the time GM_addStyle returned.
    await expect(page.locator('body')).toHaveAttribute('data-sm-in-doc', 'true');
    await expect(page.locator('#target')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(page.locator('#target')).toHaveCSS('font-weight', '700');
    await expect(page.locator('#inner')).toHaveCSS('color', 'rgb(4, 5, 6)');
    // A block would be reported ahead of the GM_log line sent after it.
    await expect.poll(async () => (await sm.getScriptLog(scriptId)).some((e) => e.source === 'gm-log')).toBe(true);
    expect((await sm.getScriptLog(scriptId)).filter((e) => e.source === 'gm-dom')).toHaveLength(0);
    await page.close();
  });

  test('a MAIN-world style in a closed shadow root is under page CSP, and is reported once', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    // The bridge can't name a parent in a closed shadow root (it sees
    // the host), so the runtime inserts it itself: in the right place,
    // under the page's CSP. One warning per script per document.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CspClosedRoot',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addElement'],
        injectInto: 'page',
      },
      body: `
        const host = document.body.appendChild(document.createElement('div'));
        host.id = 'host';
        const root = host.attachShadow({ mode: 'closed' });
        const inner = root.appendChild(document.createElement('span'));
        inner.textContent = 'x';
        const a = GM_addElement(root, 'style', { textContent: 'span { color: rgb(1, 2, 3); }' });
        GM_addElement(root, 'style', { textContent: 'span { font-weight: 700; }' });
        document.body.dataset.smInRoot = String(a.parentNode === root);
        document.body.dataset.smHostKids = String(host.childNodes.length);
        document.body.dataset.smColor = getComputedStyle(inner).color;
        document.body.dataset.smDone = '1';
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const scriptId = (await sm.getCollectionWithScripts(added!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/strict-csp.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-done', '1');
    await expect(page.locator('body')).toHaveAttribute('data-sm-in-root', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-sm-host-kids', '0');
    await expect(page.locator('body')).not.toHaveAttribute('data-sm-color', 'rgb(1, 2, 3)');

    await expect.poll(async () => (await sm.getScriptLog(scriptId)).filter((e) => e.source === 'gm-dom').length).toBe(1);
    const entry = (await sm.getScriptLog(scriptId)).find((e) => e.source === 'gm-dom')!;
    expect(entry.level).toBe('warning');
    expect(entry.message).toMatch(/Content Security Policy blocked the style GM_addElement added/);
    // It names the one cause it was.
    expect(entry.message).toMatch(/can't exempt a style added inside a closed shadow root\./);
    expect(entry.message).not.toMatch(/another frame/);
    await page.close();
  });

  test('an isolated-world GM_addStyle is exempt from page CSP, and nothing is reported', async ({
    extensionContext, fixtureServer, sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CspStyleIsolated',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addStyle'],
        injectInto: 'content',
      },
      body: `
        GM_addStyle('#target { color: rgb(1, 2, 3); }');
        document.body.dataset.smDone = '1';
      `,
    });
    const added = await sm.addCollection(scriptsDir.path);
    await sm.syncNow();
    const scriptId = (await sm.getCollectionWithScripts(added!.id))!.scripts[0].id;

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/strict-csp.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-done', '1');
    await expect(page.locator('#target')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await page.waitForTimeout(300);
    expect((await sm.getScriptLog(scriptId)).filter((e) => e.source === 'gm-dom')).toHaveLength(0);
    await page.close();
  });

  test('GM_addElement(tag, attrs) routes head-tags to <head>', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'AddElementToHead',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addElement'],
      },
      body: `
        const el = GM_addElement('meta', { name: 'sm-test', content: 'phase4' });
        document.body.dataset.smElementTag = String(el && el.tagName);
        document.body.dataset.smElementContent = String(el && el.getAttribute('content'));
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-element-tag', 'META');
    await expect(page.locator('body')).toHaveAttribute('data-sm-element-content', 'phase4');
    const inHead = await page.evaluate(
      () => !!document.head.querySelector('meta[name="sm-test"]'),
    );
    expect(inHead).toBe(true);
    await page.close();
  });

  test('GM_addElement default parent: tag matching is case-insensitive and covers title/base', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Covers two contract details at once:
    //   - tagName matching is case-insensitive ("TITLE" / "Base" hit
    //     the head bucket the same as "title" / "base")
    //   - title and base are part of the head list (the original
    //     four-tag list was script/style/link/meta; widening to six
    //     matches what VM's helper does).
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'CaseInsensitiveHeadTags',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addElement'],
      },
      body: `
        const t = GM_addElement('TITLE', { textContent: 'sm-new-title' });
        const b = GM_addElement('Base',  { href: 'https://example.com/' });
        document.body.dataset.smTitleParent = String(t && t.parentElement && t.parentElement.tagName);
        document.body.dataset.smBaseParent  = String(b && b.parentElement && b.parentElement.tagName);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-title-parent', 'HEAD');
    await expect(page.locator('body')).toHaveAttribute('data-sm-base-parent', 'HEAD');
    await page.close();
  });

  test('GM_addElement(tag, attrs) routes body-tags to <body> (matches TM/VM)', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Regression guard for the tag-aware default parent. Pre-fix,
    // any default-parent call landed in <head>, including visible
    // tags like <p> — which made them invisible.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'AddElementToBody',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addElement'],
      },
      body: `
        const el = GM_addElement('p', { id: 'sm-injected-p', textContent: 'visible' });
        document.body.dataset.smParentTag =
          String(el && el.parentElement && el.parentElement.tagName);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-parent-tag', 'BODY');
    await expect(page.locator('#sm-injected-p')).toHaveText('visible');
    const inHead = await page.evaluate(
      () => !!document.head.querySelector('#sm-injected-p'),
    );
    expect(inHead).toBe(false);
    await page.close();
  });

  test('GM_addElement(parent, tag, attrs) appends to the given parent', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'AddElementToParent',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addElement'],
      },
      body: `
        const target = document.getElementById('target');
        const span = GM_addElement(target, 'span', {
          id: 'sm-injected-span',
          textContent: 'hi from GM_addElement',
        });
        document.body.dataset.smParent = String(span && span.parentNode && span.parentNode.id);
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-parent', 'target');
    await expect(page.locator('#sm-injected-span')).toHaveText('hi from GM_addElement');
    await page.close();
  });

  test('GM.addStyle (GM4 alias) also works', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'GMAddStyleAlias',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        grant: ['GM_addStyle'],
      },
      body: `
        GM.addStyle('#target { font-weight: 700; }');
        document.body.dataset.smChecked = 'true';
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-checked', 'true');
    const weight = await page.locator('#target').evaluate(
      (el) => getComputedStyle(el).fontWeight,
    );
    expect(weight).toBe('700');
    await page.close();
  });

  test('ungranted GM_addStyle is not callable', async ({
    extensionContext,
    fixtureServer,
    sm,
  }) => {
    // Verifies the permissions story still holds for new APIs.
    scriptsDir.write({
      relativePath: 'a.user.js',
      meta: {
        name: 'NoGrant',
        match: [`${fixtureServer.baseUrl}/*`],
        runAt: 'document-end',
        // No @grant for GM_addStyle.
        grant: ['GM_setValue'],
      },
      body: `
        document.body.dataset.smAddStyleType = typeof GM_addStyle;
      `,
    });
    await sm.addCollection(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-add-style-type', 'undefined');
    await page.close();
  });
});
