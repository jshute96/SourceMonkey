#!/usr/bin/env node
// Preflight check for the TM e2e suites. Verifies the cross-manager
// test browser is in the right state for the requested mode and
// either fixes it (headed: launch the browser ourselves) or asks the
// user to (headless: focus the open browser and request a close),
// then exits before Playwright launches.
//
// Without this, a mis-stated browser state lets Playwright run every
// spec to failure — slow and noisy.
//
// Usage:
//   node scripts/e2e-tm-preflight.mjs --need-open    (headed mode wants the browser running)
//   node scripts/e2e-tm-preflight.mjs --need-closed  (headless mode wants the profile free)
//
// Env vars:
//   TM_CDP_PORT — CDP port to probe (default 9223; must match what
//                 scripts/open-test-browser-with-TamperMonkey.sh uses
//                 and what tests/fixtures/manager.ts reads).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TM_CDP_PORT || 9223);
const MODE = process.argv[2];

if (MODE !== '--need-open' && MODE !== '--need-closed') {
  console.error(`Usage: e2e-tm-preflight.mjs (--need-open | --need-closed)`);
  process.exit(2);
}

/** Returns true if a Chromium with --remote-debugging-port=PORT is up.
 *  Matches *any* Chromium on that port — doesn't verify the profile is
 *  ours. A stray unrelated browser bound to 9223 will false-positive,
 *  but that's exotic enough not to be worth fingerprinting around. */
async function probeCdp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort: activate the existing CDP-attached browser's first tab
 * via Page.bringToFront so the user has a hint about which window to
 * close. Behavior varies by platform: macOS usually raises the window
 * above other apps; Linux/X11 typically only switches the active tab
 * within the window without raising it; Windows flashes the taskbar
 * entry. Either way it's a hint, not a guarantee — the printed
 * message names the browser explicitly so users on Linux can find it.
 */
async function focusExistingBrowser() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const ctx = browser.contexts()[0];
    const page = ctx?.pages()[0];
    if (page) {
      try { await page.bringToFront(); } catch { /* best effort */ }
    }
    // Disconnect, don't close — closing here would close the user's browser.
    await browser.close();
  } catch {
    /* nothing to focus; the printed message will still guide them */
  }
}

async function waitForCdp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeCdp()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const isOpen = await probeCdp();

  if (MODE === '--need-closed') {
    if (!isOpen) return;
    await focusExistingBrowser();
    console.error(
      `\nThe Tampermonkey test browser is currently OPEN on CDP port ${PORT}.\n` +
      `Headless cross-manager tests (\`npm run test:e2e:tm\`) need it CLOSED:\n` +
      `Chromium can't share a profile directory between two processes.\n\n` +
      `→ Close the Tampermonkey test browser (I've tried to bring it\n` +
      `   forward; on Linux you may need to find it in your window list)\n` +
      `   and then re-run.\n\n` +
      `If you wanted to run against the already-open browser, use\n` +
      `\`npm run test:e2e:tm:headed\` instead.\n`
    );
    process.exit(1);
  }

  // --need-open
  if (isOpen) return;
  console.log(`Tampermonkey test browser isn't running — launching it now…`);
  const script = path.join(ROOT, 'scripts/open-test-browser-with-TamperMonkey.sh');
  // Detached + ignore so the child survives after this preflight exits.
  // The opener script execs Chromium directly, so the unrefed child IS
  // the browser; killing the preflight process won't take it down.
  const child = spawn('bash', [script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (!(await waitForCdp())) {
    console.error(
      `\nBrowser didn't come up on CDP port ${PORT} within 15s.\n` +
      `Try running scripts/open-test-browser-with-TamperMonkey.sh manually\n` +
      `to see what went wrong.\n`
    );
    process.exit(1);
  }
  console.log(`Browser is up on CDP port ${PORT}. Proceeding.`);
}

main().catch((err) => {
  console.error(`e2e-tm-preflight: ${err?.message ?? err}`);
  process.exit(1);
});
