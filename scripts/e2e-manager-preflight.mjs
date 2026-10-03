#!/usr/bin/env node
// Preflight check for the cross-manager e2e suites (Tampermonkey and
// Violentmonkey). Verifies the manager's test browser is in the right
// state for the requested mode and either fixes it (headed: launch the
// browser ourselves) or asks the user to (headless: focus the open
// browser and request a close), then exits before Playwright launches.
//
// Without this, a mis-stated browser state lets Playwright run every
// spec to failure — slow and noisy.
//
// Usage:
//   node scripts/e2e-manager-preflight.mjs <manager> --need-open
//   node scripts/e2e-manager-preflight.mjs <manager> --need-closed
//
// `--need-open` is headed mode (wants the browser running);
// `--need-closed` is headless mode (wants the profile free).
//
// The CDP port, profile path, and each manager's port-override env var
// come from tests/fixtures/managers.mjs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managerCdpPort, managerConfig, managerExtensionId } from '../tests/fixtures/managers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const [MANAGER, MODE] = process.argv.slice(2);

if (!MANAGER || (MODE !== '--need-open' && MODE !== '--need-closed')) {
  console.error(`Usage: e2e-manager-preflight.mjs <manager> (--need-open | --need-closed)`);
  process.exit(2);
}

let CFG;
try {
  CFG = managerConfig(MANAGER);
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(2);
}
let PORT;
try {
  PORT = managerCdpPort(MANAGER);
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(2);
}
/** `tm` / `vm` — the suffix the package scripts use, for error messages. */
const SHORT = CFG.scriptSuffix;
const PREFS = path.join(CFG.profileDir, 'Default', 'Preferences');

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

/**
 * Pre-grant Chrome's `downloads` permission to the manager in the test
 * profile. Only Tampermonkey needs it — Violentmonkey reaches for
 * `chrome.downloads` only when the permission is already granted and
 * falls back to an anchor download otherwise, so nothing blocks
 * there. `preGrantDownloads` in managers.mjs is the switch.
 *
 * `downloads` is an *optional* permission in TM's manifest: the first
 * `GM_download` call opens TM's own "Browser API Downloads — click OK"
 * page, whose OK button calls `chrome.permissions.request`. That needs
 * Chrome's native grant bubble, which a headless run can't show, so the
 * click does nothing, the GM call never settles, and the spec times out
 * with an empty log rather than a refusal. Writing the grant straight
 * into Preferences is the same shortcut `tests/fixtures/extension.ts`
 * takes for `user_scripts_enabled` on the SourceMonkey profile.
 *
 * Only safe with the browser closed — Chrome rewrites Preferences from
 * memory on exit and would drop the edit. Callers must check.
 *
 * Never throws. Silent when there's nothing to do — already granted,
 * or no profile / no TM in it yet, which is the first-run story
 * `tests/fixtures/manager.ts` reports better than we could here.
 * @returns {void}
 */
function grantDownloadsPermission() {
  if (!CFG.preGrantDownloads) return;
  if (!fs.existsSync(PREFS)) return;
  const id = managerExtensionId(MANAGER);
  let prefs;
  try {
    prefs = JSON.parse(fs.readFileSync(PREFS, 'utf8'));
  } catch (err) {
    console.error(
      `Could not read the ${CFG.label} profile's Preferences (${PREFS}): ${err?.message ?? err}\n` +
      `GM_download specs will hang on its permission prompt until it's granted.`
    );
    return;
  }
  const entry = prefs?.extensions?.settings?.[id];
  if (!entry) return; // The manager isn't installed in this profile yet.

  // Both lists matter: `granted_permissions` is what the user has ever
  // approved, `active_permissions` is what the extension holds now.
  let changed = false;
  let wroteSomewhere = false;
  for (const key of ['granted_permissions', 'active_permissions']) {
    const bucket = entry[key];
    if (!bucket) continue;
    // An extension holding no optional permissions yet can have the
    // bucket without the array. Create it rather than skipping: a
    // `continue` here is indistinguishable from "already granted"
    // below, and lands us back at the silent hang.
    if (!Array.isArray(bucket.api)) bucket.api = [];
    wroteSomewhere = true;
    if (!bucket.api.includes('downloads')) {
      bucket.api.push('downloads');
      changed = true;
    }
  }
  if (!wroteSomewhere) {
    console.error(
      `${CFG.label}'s profile entry has no permissions to write to, so GM_download's ` +
      `"downloads" grant could not be pre-applied. Those specs will time out ` +
      `on its permission prompt; grant Downloads to ${CFG.label} by hand.`
    );
    return;
  }
  if (!changed) return;

  // Keep one pre-edit copy around: this file is the profile's identity,
  // and a bad write means re-installing TM by hand.
  const backup = `${PREFS}.pre-sm-downloads-grant`;
  if (!fs.existsSync(backup)) fs.copyFileSync(PREFS, backup);
  fs.writeFileSync(PREFS, JSON.stringify(prefs));

  // Read back rather than trusting the write. Chrome keeps extension
  // state in `Secure Preferences` (HMAC-protected) on some profile
  // shapes, where editing this copy is a no-op — and the symptom of
  // that would be the same silent timeout, minus any clue.
  try {
    const after = JSON.parse(fs.readFileSync(PREFS, 'utf8'));
    const api = after?.extensions?.settings?.[id]?.granted_permissions?.api;
    if (!Array.isArray(api) || !api.includes('downloads')) {
      console.error(
        `The "downloads" grant for ${CFG.label} did not stick in ${PREFS}. ` +
        `Chrome may keep this profile's extension state elsewhere. GM_download ` +
        `specs will time out; grant Downloads to ${CFG.label} by hand.`
      );
      return;
    }
  } catch {
    // Read-back is a diagnostic, not a gate — the write already
    // succeeded or threw.
  }
  console.log(
    `Granted Chrome's "downloads" permission to ${CFG.label} in the test profile ` +
    `(needed by GM_download; backup at ${path.relative(ROOT, backup)}).`
  );
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
    if (!isOpen) {
      grantDownloadsPermission();
      return;
    }
    await focusExistingBrowser();
    console.error(
      `\nThe ${CFG.label} test browser is currently OPEN on CDP port ${PORT}.\n` +
      `Headless cross-manager tests (\`pnpm run test:e2e:${SHORT}\`) need it CLOSED:\n` +
      `Chromium can't share a profile directory between two processes.\n\n` +
      `→ Close the ${CFG.label} test browser (I've tried to bring it\n` +
      `   forward; on Linux you may need to find it in your window list)\n` +
      `   and then re-run.\n\n` +
      `If you wanted to run against the already-open browser, use\n` +
      `\`pnpm run test:e2e:${SHORT}:headed\` instead.\n`
    );
    process.exit(1);
  }

  // --need-open
  if (isOpen) return;
  // Before launching, while the profile is still ours to edit — Chrome
  // rewrites Preferences from memory on exit, so a later edit is lost.
  grantDownloadsPermission();
  console.log(`${CFG.label} test browser isn't running, launching it now…`);
  const script = path.join(ROOT, 'scripts/open-test-browser.sh');
  // Detached + ignore so the child survives after this preflight exits.
  // The opener script execs Chromium directly, so the unrefed child IS
  // the browser; killing the preflight process won't take it down.
  const child = spawn('bash', [script, MANAGER], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (!(await waitForCdp())) {
    console.error(
      `\nBrowser didn't come up on CDP port ${PORT} within 15s.\n` +
      `Try running \`scripts/open-test-browser.sh ${MANAGER}\` manually\n` +
      `to see what went wrong.\n`
    );
    process.exit(1);
  }
  console.log(`Browser is up on CDP port ${PORT}. Proceeding.`);
}

main().catch((err) => {
  console.error(`e2e-manager-preflight: ${err?.message ?? err}`);
  process.exit(1);
});
