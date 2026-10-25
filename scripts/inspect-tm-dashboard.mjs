#!/usr/bin/env node
//
// Diagnostic: dump the Tampermonkey dashboard's first visible script
// row with cell-level class and id info, so we can pick stable
// selectors for `listInstalled` in scripts/sync-manager-scripts.mjs and
// tests/fixtures/tampermonkey-driver.mjs.
//
// When to run it
//   - `sync-manager-scripts.mjs` reports 0 installed scripts even though
//     the dashboard shows them (selector drift).
//   - A TM upgrade landed and you want to verify the row / cell
//     classes haven't changed before relying on them.
//
// How to run it
//   1. Start the TM test browser:
//      `scripts/open-test-browser.sh tampermonkey`
//   2. Have at least one userscript installed in TM (otherwise
//      "first visible row" returns nothing useful).
//   3. `node scripts/inspect-tm-dashboard.mjs`
//
// Env vars (optional)
//   TM_CDP_PORT       CDP port (default 9223)
//   TM_EXTENSION_ID   TM extension ID (default Stable; set for Beta)
//
// Output is JSON-printed — copy the `script_name` / `script_version`
// (or whatever the new class names are) into `listInstalled`'s
// `tr.querySelector(...)` calls.

import { chromium } from '@playwright/test';
import { managerCdpPort, managerExtensionId } from '../tests/fixtures/managers.mjs';

const TM_ID = managerExtensionId('tampermonkey');
const PORT = managerCdpPort('tampermonkey');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.goto(`chrome-extension://${TM_ID}/options.html#nav=dashboard`);
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const tbl = document.querySelector('table.scripttable');
  if (!tbl) return { error: 'no scripttable' };
  const rows = Array.from(tbl.querySelectorAll('tbody tr'))
    .filter((tr) => !tr.classList.contains('hide') && tr.offsetParent !== null);
  if (!rows.length) return { error: 'no visible rows' };
  const sampleRow = rows[0];
  const cells = Array.from(sampleRow.querySelectorAll('td'));
  return {
    rowAttrs: Object.fromEntries(Array.from(sampleRow.attributes).map((a) => [a.name, a.value])),
    rowClass: sampleRow.className,
    visibleRowCount: rows.length,
    cells: cells.map((td, idx) => ({
      idx,
      classes: td.className,
      id: td.id || null,
      text: (td.textContent || '').trim().slice(0, 40),
    })),
  };
});

console.log(JSON.stringify(info, null, 2));

await browser.close();
