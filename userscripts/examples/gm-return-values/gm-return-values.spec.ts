// E2E coverage for the gm-return-values example: what the GM_ and GM.
// form of each API returns, under each manager.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '../../../tests/fixtures/manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Each row: what the GM_ call returned | what the GM. call returned |
// what awaiting the GM. result gave. Measured under TM 5.5 and VM 2.49.

// TM's values, the baseline: every GM. form returns a Promise of what
// the GM_ form returns.
const BASELINE: Record<string, string> = {
  setValue: 'undefined | Promise | undefined',
  getValue: 'number | Promise | number',
  listValues: 'object | Promise | object',
  getResourceText: 'string | Promise | string',
  getResourceURL: 'string | Promise | string',
  addStyle: 'element | Promise | element',
  addElement: 'element | Promise | element',
  log: 'undefined | Promise | undefined',
  registerMenuCommand: 'number | Promise | number',
};

// Where each manager differs from the baseline. A new difference fails
// the test until it's added here.
const DIFFERENCES: Record<string, Record<string, string>> = {
  tampermonkey: {},
  sourcemonkey: {
    // Deliberately as VM: the element, with a `then`, so both `await`
    // and direct use of the element work.
    addStyle: 'element with then | element with then | element',
    addElement: 'element with then | element with then | element',
    // Menu command ids are strings, as in VM.
    registerMenuCommand: 'string | Promise | string',
  },
  violentmonkey: {
    // Its awaited GM.setValue gives null.
    setValue: 'undefined | Promise | null',
    // Only some GM. forms return a Promise.
    getResourceText: 'string | string | string',
    log: 'undefined | undefined | undefined',
    registerMenuCommand: 'string | string | string',
    addStyle: 'element with then | element with then | element',
    addElement: 'element with then | element with then | element',
  },
};

// Rows where awaiting the GM. result gives a different kind of value
// than the GM_ call returns.
const AWAIT_MISMATCHES: Record<string, string[]> = {
  tampermonkey: [],
  sourcemonkey: [],
  violentmonkey: ['setValue'],
};

// The thenable element awaits to the element itself.
const sameKind = (legacy: string, awaited: string) =>
  legacy === awaited || (legacy === 'element with then' && awaited === 'element');

test.describe('examples / gm-return-values', () => {
  // Run the page's calls and read the table, as { api: row }.
  async function readRows(page: Page, baseUrl: string): Promise<Record<string, string>> {
    await page.goto(`${baseUrl}/gm-return-values/gm-return-values.html`);
    await expect(page.locator('#runStatus')).toHaveText(/Userscript ran/);
    await page.locator('#btn-run').click();
    await expect(page.locator('#runStatus')).toHaveAttribute('data-done', 'true');
    const rows = await page.locator('#results tbody tr').evaluateAll((trs) =>
      Object.fromEntries(trs.map((tr) => [
        (tr as HTMLElement).dataset.api,
        [...tr.querySelectorAll('td')].map((td) => td.textContent).join(' | '),
      ])),
    );
    return rows;
  }

  test('awaiting a GM. call gives what the GM_ call returns', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(__dirname);
    const page = await extensionContext.newPage();
    const rows = await readRows(page, fixtureServer.baseUrl);
    await page.close();
    const mismatches = Object.entries(rows)
      .filter(([, row]) => {
        const [legacy, , awaited] = row.split(' | ');
        return !sameKind(legacy, awaited);
      })
      .map(([api]) => api);
    expect(mismatches).toEqual(AWAIT_MISMATCHES[setup.manager]);
  });

  test('return values differ from the baseline only where listed', async ({ extensionContext, fixtureServer, setup }) => {
    await setup.installScriptsFrom(__dirname);
    const page = await extensionContext.newPage();
    const rows = await readRows(page, fixtureServer.baseUrl);
    await page.close();
    expect(rows).toEqual({ ...BASELINE, ...DIFFERENCES[setup.manager] });
  });
});
