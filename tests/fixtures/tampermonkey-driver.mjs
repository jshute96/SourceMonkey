// Drives the Tampermonkey dashboard to keep example userscripts in
// sync. Shared between the Playwright fixture (manager.ts) and the
// standalone CLI (scripts/sync-manager-scripts.mjs) so the install/list
// logic and selectors stay in one place.
//
// The Violentmonkey equivalent is violentmonkey-driver.mjs, which
// exposes the same shape (listInstalled / getInstalledMap /
// installFromFile) over a completely different mechanism — TM is
// closed-source so we drive its UI; VM is not, so we can talk to its
// background directly.
//
// Callers pass the BrowserContext TM runs in: the tests' own browser
// (tests/fixtures/manager-launch.ts), or one opened with
// `scripts/open-test-browser.sh tampermonkey` and reached over CDP (the
// sync CLI).
//
// All UI selectors used here are reasonable best-guesses against
// Tampermonkey v5's dashboard. Update them if TM renames anything in a
// future release — `scripts/inspect-tm-*.mjs` produce the diagnostic
// dumps needed to pick new selectors.

import { managerExtensionId } from './managers.mjs';
import { compareVersions, listUserscripts } from './userscript-files.mjs';

/**
 * Tampermonkey's extension ID in this profile. Defaults to TM Stable's
 * Chrome Web Store ID; `TM_EXTENSION_ID` overrides it (e.g. TM Beta).
 * @returns {string}
 */
export function getTampermonkeyExtensionId() {
  return managerExtensionId('tampermonkey');
}

/**
 * @typedef {Object} InstalledScript
 * @property {string} name
 * @property {string} version
 */

export class TampermonkeyDriver {
  /**
   * @param {import('@playwright/test').BrowserContext} context
   * @param {string} extensionId
   */
  constructor(context, extensionId) {
    /** @private */ this.context = context;
    /** @private */ this.extensionId = extensionId;
    /**
     * Cached map of `@name -> installed @version`, populated on the
     * first `getInstalledMap()` call. Reading the TM dashboard takes
     * ~1s per call (page open + wait + scrape); the test suite needs
     * this answer per spec, so we cache once per driver lifetime and
     * mutate in place after `installFromFile` succeeds.
     *
     * Assumes exclusive ownership: nothing outside this driver
     * modifies TM's installed scripts during the cache's lifetime.
     * Call `invalidateInstalledCache()` if that assumption breaks.
     * @private
     * @type {Map<string, string> | null}
     */
    this._installedMap = null;
    /**
     * Set by `autoApprovePermissionPrompts()`; kept so a second call
     * doesn't attach a duplicate listener.
     * @private
     * @type {((page: import('@playwright/test').Page) => void) | null}
     */
    this._permissionHandler = null;
  }

  /**
   * Auto-answer TM's permission prompts so an unattended run doesn't
   * sit in front of one.
   *
   * TM gates some GM APIs behind a confirmation page it opens as a new
   * tab (`ask.html`), and with nobody to answer it the GM call never
   * settles — the spec times out on an empty log rather than seeing a
   * result either way.
   *
   * NOT sufficient on its own for `GM_download`. Its prompt ("Browser
   * API Downloads: Click OK to allow Tampermonkey to start instant
   * downloads") calls `chrome.permissions.request`, which needs
   * Chrome's own native grant bubble — headless can't show one, so the
   * click lands and nothing happens. That permission is pre-granted in
   * the profile by `tests/fixtures/manager-launch.ts`; don't drop that on
   * the assumption this handler covers it.
   *
   * Only `input.button.permission[value="Ok"]` is clicked. The install
   * confirmation on the same page uses `.button.install`, so this
   * can't race `installFromFile` into approving an install.
   * @returns {void}
   */
  autoApprovePermissionPrompts() {
    if (this._permissionHandler) return;
    const askUrl = new RegExp(`^chrome-extension://${this.extensionId}/ask\\.html`);
    this._permissionHandler = (page) => {
      void (async () => {
        try {
          // The `page` event fires while the tab is still about:blank,
          // so a synchronous url() check here always misses. Wait for
          // the navigation, then for the prompt's own button.
          await page.waitForURL(askUrl, { timeout: 5000 });
          const ok = page.locator('input.button.permission[value="Ok"]').first();
          await ok.waitFor({ state: 'visible', timeout: 5000 });
          // Never touch a page that also carries an install action.
          // The class split below is TM 5.5.0's; if a later build ever
          // labels an install button "Ok", this keeps us from
          // approving an install out from under `installFromFile`.
          if (await page.locator('.button.install').count()) return;
          await ok.click();
        } catch {
          // Not a permission prompt (an ordinary test page or an
          // install confirmation), or it closed on its own. Either way
          // there's nothing to answer.
        }
      })();
    };
    this.context.on('page', this._permissionHandler);
  }

  /**
   * @param {'dashboard' | 'utils'} [nav]
   * @returns {string}
   */
  dashboardUrl(nav = 'dashboard') {
    return `chrome-extension://${this.extensionId}/options.html#nav=${nav}`;
  }

  /**
   * Read the current dashboard table and return one entry per installed
   * userscript. TM v5 marks real script rows with class `scripttr` and
   * tags the name / version cells with `.script_name` / `.script_version`.
   * Hidden placeholder rows ("No script is installed", "<New userscript>")
   * are filtered out by the visibility check.
   * @returns {Promise<InstalledScript[]>}
   */
  async listInstalled() {
    const page = await this.context.newPage();
    try {
      await page.goto(this.dashboardUrl('dashboard'));
      await page.waitForLoadState('domcontentloaded');
      // The script list is hydrated from IDB after DOMContentLoaded,
      // and how long that takes varies with the profile's size and the
      // machine. Wait for the first name cell instead of guessing: a
      // fixed sleep that expires early reports "nothing installed",
      // and the sync path then reinstalls every script on every test.
      //
      // The timeout is the empty-dashboard cost — a profile with no
      // scripts waits it out once and correctly returns [].
      try {
        await page.locator('td.script_name').first().waitFor({ state: 'attached', timeout: 15000 });
      } catch {
        // Say so. An empty list is indistinguishable from "TM renamed
        // the class", and that mistake reads as "nothing installed" —
        // which makes every spec reinstall its scripts, silently.
        console.log(
          `[tm-driver] No script rows on the TM dashboard after 15s. Either the ` +
          `profile has no userscripts, or td.script_name changed in this TM build.`
        );
        return [];
      }

      return await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tr.scripttr'))
          .filter((tr) => !tr.classList.contains('hide') && tr.offsetParent !== null);
        const out = [];
        for (const tr of rows) {
          const nameCell = tr.querySelector('td.script_name');
          const versionCell = tr.querySelector('td.script_version');
          const name = (nameCell?.textContent || '').trim();
          const version = (versionCell?.textContent || '').trim();
          if (name) out.push({ name, version });
        }
        return out;
      });
    } finally {
      await page.close();
    }
  }

  /**
   * Cached version of `listInstalled` keyed by `@name`. First call
   * reads the dashboard; subsequent calls reuse the in-memory map.
   * Callers that install or update a script should call
   * `recordInstalled` so the cache stays in sync.
   *
   * Keying by `@name` collapses duplicate installs, so this also warns
   * about them — a profile holding the same script twice runs it twice
   * on every page, and the only symptom is an example spec counting
   * two of something it expects one of. That is a slow thing to
   * diagnose from the spec end. It can only happen in a persistent
   * profile (the sync CLI's); see "Removing stale copies" in
   * `docs/cross-manager-testing.md`.
   * @returns {Promise<Map<string, string>>}
   */
  async getInstalledMap() {
    if (this._installedMap === null) {
      const list = await this.listInstalled();
      const seen = new Set();
      const duplicated = new Set();
      for (const s of list) {
        if (seen.has(s.name)) duplicated.add(s.name);
        seen.add(s.name);
      }
      if (duplicated.size) {
        console.log(
          `[tm-driver] Tampermonkey has more than one copy of: ${[...duplicated].join(', ')}. ` +
          `Each copy runs on every matching page, so specs that count elements will fail. ` +
          `Remove the extras from TM's dashboard (select the rows, Apply → Delete).`
        );
      }
      this._installedMap = new Map(list.map((s) => [s.name, s.version]));
    }
    return this._installedMap;
  }

  /**
   * Update the cached installed-versions map. No-op when the cache
   * hasn't been populated yet (next `getInstalledMap` will read fresh
   * state from the dashboard anyway).
   * @param {string} name
   * @param {string} version
   */
  recordInstalled(name, version) {
    if (this._installedMap !== null) {
      this._installedMap.set(name, version);
    }
  }

  /**
   * Drop the cached installed-versions map. Forces the next
   * `getInstalledMap` call to re-read the dashboard. Use if anything
   * outside the driver may have changed TM's installed scripts.
   */
  invalidateInstalledCache() {
    this._installedMap = null;
  }

  /**
   * Release any pages the driver is holding. This driver opens and
   * closes a page per operation, so there's nothing to do — it exists
   * so callers can treat both manager drivers alike (the VM one caches
   * a page and does need closing).
   */
  async close() {}

  /**
   * Install (or reinstall / update / downgrade) a single userscript by
   * feeding the file to Tampermonkey's "Import from file" flow. TM
   * auto-detects existing scripts by @namespace+@name and offers one
   * of Install / Reinstall / Update / Downgrade on the confirmation
   * page; we click whichever is present.
   *
   * Does NOT update the cached installed-versions map — callers that
   * track versions (e.g. `syncTampermonkeyScripts`) should call
   * `recordInstalled` after a successful install.
   * @param {string} filepath
   * @returns {Promise<void>}
   */
  async installFromFile(filepath) {
    const page = await this.context.newPage();
    try {
      await page.goto(this.dashboardUrl('utils'));
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(300);

      // Find the import-from-file input. TM hides it behind a styled
      // button — Playwright's setInputFiles works on hidden inputs.
      //
      // Wait for it rather than counting once: the dashboard ships an
      // empty <body> and builds the DOM from JS, so an immediate
      // count() races the render and reports 0 on a page that is fine.
      const fileInputs = page.locator('input[type="file"]');
      try {
        await fileInputs.first().waitFor({ state: 'attached', timeout: 10000 });
      } catch {
        throw new Error(
          `No file input found on TM utils page (${this.dashboardUrl('utils')}). ` +
          `Selector may have changed in this TM build.`
        );
      }

      // TM opens the install confirmation in a new tab when the file
      // input fires its change handler. Listen for that tab.
      const installPagePromise = this.context.waitForEvent('page', { timeout: 5000 });
      await fileInputs.first().setInputFiles(filepath);

      let installPage;
      try {
        installPage = await installPagePromise;
        await installPage.waitForLoadState('domcontentloaded');
      } catch {
        // Some TM builds render the confirmation in-place instead of a
        // new tab. Reuse the utils page in that case.
        installPage = page;
        await installPage.waitForTimeout(500);
      }

      await this.clickInstallButton(installPage);

      // Settle: TM closes the ask tab on a successful install — the
      // waitForTimeout can race against that close, so swallow the
      // resulting "Target page closed" error.
      try { await installPage.waitForTimeout(500); } catch { /* TM closed it */ }
      if (installPage !== page && !installPage.isClosed()) {
        try { await installPage.close(); } catch { /* already closed by TM */ }
      }
    } finally {
      if (!page.isClosed()) {
        try { await page.close(); } catch { /* ignore */ }
      }
    }
  }

  /**
   * @private
   * @param {import('@playwright/test').Page} page
   * @returns {Promise<void>}
   */
  async clickInstallButton(page) {
    // TM v5's ask.html action button:
    //   - new install             -> value="Install"
    //   - same-version reinstall  -> value="Reinstall"
    //   - newer-version update    -> value="Update"
    //   - older-version downgrade -> value="Downgrade"
    // All four are <input type="button" class="button install">, and
    // Cancel uses the same class — disambiguate by value attribute,
    // not class. The id is a base64 token and not stable.
    const candidates = [
      'input[type="button"][value="Install"]',
      'input[type="button"][value="Reinstall"]',
      'input[type="button"][value="Update"]',
      'input[type="button"][value="Downgrade"]',
      // Older TM versions (kept as fallbacks).
      'button#buttonInstall',
      'input[type="submit"][value*="nstall" i]',
    ];
    // ask.html is served as an empty <body> and populated by its own
    // scripts, so `domcontentloaded` fires well before the buttons
    // exist. Wait on the union of the candidates — probing each with a
    // one-shot count() finds nothing and throws on a healthy page.
    const anyButton = page.locator(candidates.join(', ')).first();
    try {
      await anyButton.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      throw new Error(
        `Could not find an Install button on the TM confirmation page. ` +
        `URL: ${page.url()}. Tried: ${candidates.join(', ')}`
      );
    }
    // Re-probe in candidate order so Install wins over a same-page
    // Cancel if a build ever renders more than one match. Test
    // visibility, not existence: `count()` also matches a hidden
    // element, and clicking one stalls on actionability even though
    // the wait above was satisfied by a different, visible candidate.
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await clickClosing(page, loc);
        return;
      }
    }
    await clickClosing(page, anyButton);
  }
}

/**
 * Clicks `loc` on TM's confirmation page, which TM closes as soon as
 * the install is done. On a busy machine that can happen before
 * Playwright's click returns, which then throws "Target page, context
 * or browser has been closed" for a click that worked. A failed install
 * leaves the page open, so that error is still thrown.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} loc
 * @returns {Promise<void>}
 */
async function clickClosing(page, loc) {
  try {
    await loc.click();
  } catch (err) {
    if (!page.isClosed()) throw err;
  }
}

/**
 * Install every `*.user.js` directly under `dir` into Tampermonkey,
 * skipping any already installed at the same-or-newer version.
 *
 * Uses the driver's cached installed-versions map, so calling this
 * repeatedly across a worker's tests doesn't re-scrape the dashboard
 * each time. The cache is mutated in place after each successful
 * install.
 *
 * Used by the Playwright fixture (`tests/fixtures/manager.ts`) on
 * per-test setup — no downgrade path because tests shouldn't roll a
 * script back. The standalone CLI implements a richer plan with
 * `--allow-downgrade`.
 * @param {TampermonkeyDriver} driver
 * @param {string} dir
 * @returns {Promise<{installed: string[]; updated: string[]; skipped: string[]}>}
 */
export async function syncTampermonkeyScripts(driver, dir) {
  const local = listUserscripts(dir);
  const byName = await driver.getInstalledMap();

  const result = { installed: [], updated: [], skipped: [] };
  for (const script of local) {
    const current = byName.get(script.name);
    if (current === undefined) {
      await driver.installFromFile(script.filepath);
      driver.recordInstalled(script.name, script.version);
      result.installed.push(script.name);
    } else if (compareVersions(script.version, current) > 0) {
      await driver.installFromFile(script.filepath);
      driver.recordInstalled(script.name, script.version);
      result.updated.push(script.name);
    } else {
      result.skipped.push(script.name);
    }
  }
  return result;
}
