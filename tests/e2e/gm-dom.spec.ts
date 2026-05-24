// End-to-end tests for the DOM-injection GM_* APIs (Phase 4).
//
// USER_SCRIPT-world DOM mutations are CSP-exempt (same dispensation
// content scripts get), so a script using these APIs on a strict-
// CSP page can still inject styles and elements that the page
// itself couldn't.

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
    await sm.addSource(scriptsDir.path);
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
    await sm.addSource(scriptsDir.path);
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
    await sm.addSource(scriptsDir.path);
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
    await sm.addSource(scriptsDir.path);
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
    await sm.addSource(scriptsDir.path);
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
    await sm.addSource(scriptsDir.path);
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
    await sm.addSource(scriptsDir.path);
    await sm.syncNow();

    const page = await extensionContext.newPage();
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect(page.locator('body')).toHaveAttribute('data-sm-add-style-type', 'undefined');
    await page.close();
  });
});
