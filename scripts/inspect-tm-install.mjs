#!/usr/bin/env node
//
// Diagnostic: drive one TM install (default script: gm-info), wait
// for the ask.html confirmation page, and dump every visible
// button-like element so we can pick the right selector for the
// action button (Install / Reinstall / Update / Downgrade).
//
// When to run it
//   - `sync-manager-scripts.mjs` reports "Install button not found" on
//     some script (selector drift, or a confirmation-page state we
//     hadn't seen before — TM uses different button labels for
//     install vs reinstall vs update vs downgrade).
//   - A TM upgrade landed and you want to confirm the four known
//     button values still cover all cases.
//
// How to run it
//   1. Start the TM test browser:
//      `scripts/open-test-browser.sh tampermonkey`
//   2. Make sure TM is installed and the script you want to inspect
//      is on disk. Default target: tests/examples/gm-info/gm-info.user.js.
//      Set SCRIPT=<absolute or repo-relative path> to inspect a
//      different one — useful for triggering specific confirmation
//      states:
//        - already-installed same version  -> Reinstall page
//        - local @version > installed      -> Update page
//        - local @version < installed      -> Downgrade page
//        - never-seen script               -> Install page
//   3. `node scripts/inspect-tm-install.mjs`
//      `SCRIPT=path/to/foo.user.js node scripts/inspect-tm-install.mjs`
//
// Env vars (optional)
//   SCRIPT            path to the .user.js to feed to the import flow
//   TM_CDP_PORT       CDP port (default 9223)
//   TM_EXTENSION_ID   TM extension ID (default Stable; set for Beta)
//
// Side-effect warning: this script does NOT click the action button,
// so nothing is actually installed. It does leave both the utils
// tab and the ask.html tab open in the TM browser when it exits
// (`browser.close()` on a CDP-attached connection just disconnects;
// it doesn't close the user's tabs). Close them manually if you
// don't want the leftover.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { managerCdpPort, managerExtensionId } from '../tests/fixtures/managers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TM_ID = managerExtensionId('tampermonkey');
const PORT = managerCdpPort('tampermonkey');
const SCRIPT = process.env.SCRIPT
  || path.resolve(__dirname, '../tests/examples/gm-info/gm-info.user.js');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];

const utilsPage = await ctx.newPage();
await utilsPage.goto(`chrome-extension://${TM_ID}/options.html#nav=utils`);
await utilsPage.waitForLoadState('domcontentloaded');
await utilsPage.waitForTimeout(500);

const newPagePromise = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
await utilsPage.locator('input[type="file"]').first().setInputFiles(SCRIPT);
const ask = await newPagePromise;
if (!ask) { console.error('no ask.html'); await browser.close(); process.exit(1); }
await ask.waitForLoadState('domcontentloaded');
await ask.waitForTimeout(800);

console.log(`Title: ${await ask.title()}`);
console.log(`URL: ${ask.url()}`);

const buttons = await ask.evaluate(() => {
  const els = Array.from(document.querySelectorAll('input, button, a.button'));
  return els.map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    value: el.getAttribute('value'),
    text: (el.textContent || '').trim().slice(0, 60),
    className: el.className,
    id: el.id,
    visible: !!(el.offsetWidth || el.offsetHeight),
  })).filter((b) => b.visible);
});
console.log('\nVisible button-like elements:');
for (const b of buttons) console.log(JSON.stringify(b));

await browser.close();
