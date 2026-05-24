// Drives the Tampermonkey dashboard to keep example userscripts in
// sync. Shared between the Playwright fixture (manager.ts) and the
// standalone CLI (scripts/sync-tm-scripts.mjs) so the install/list
// logic and selectors stay in one place.
//
// TM is not loaded as an unpacked extension under our control — the
// test browser is opened via scripts/open-test-browser-with-TamperMonkey.sh
// and the user installed TM from the Chrome Web Store into the
// persistent profile (one-time setup). Callers connect to that browser
// over CDP and pass the resulting BrowserContext to TampermonkeyDriver.
//
// All UI selectors used here are reasonable best-guesses against
// Tampermonkey v5's dashboard. Update them if TM renames anything in a
// future release — `scripts/inspect-tm-*.mjs` produce the diagnostic
// dumps needed to pick new selectors.

import fs from 'node:fs';
import path from 'node:path';

/** Chrome Web Store ID for Tampermonkey Stable. Override with TM_EXTENSION_ID. */
export const TAMPERMONKEY_STABLE_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

/** @returns {string} */
export function getTampermonkeyExtensionId() {
  return process.env.TM_EXTENSION_ID || TAMPERMONKEY_STABLE_ID;
}

/**
 * @typedef {Object} UserscriptHeader
 * @property {string} name
 * @property {string} version
 * @property {string} filepath  Absolute path to the source file.
 */

/**
 * @typedef {Object} InstalledScript
 * @property {string} name
 * @property {string} version
 */

/**
 * Read a `*.user.js` and extract its `@name` and `@version`.
 * @param {string} filepath
 * @returns {UserscriptHeader}
 */
export function parseUserscriptHeader(filepath) {
  const src = fs.readFileSync(filepath, 'utf8');
  const block = src.match(/==UserScript==([\s\S]*?)==\/UserScript==/);
  if (!block) throw new Error(`No UserScript metadata block in ${filepath}`);
  const name = readTag(block[1], 'name');
  const version = readTag(block[1], 'version');
  if (!name) throw new Error(`Missing @name in ${filepath}`);
  if (!version) throw new Error(`Missing @version in ${filepath}`);
  return { name, version, filepath };
}

function readTag(metaBlock, tag) {
  const re = new RegExp(`^\\s*//\\s*@${tag}\\s+(.+?)\\s*$`, 'm');
  const m = metaBlock.match(re);
  return m ? m[1] : null;
}

/**
 * List every `*.user.js` directly under `dir` (non-recursive). Used by
 * the per-spec install flow where each spec only cares about the
 * userscripts in its own directory.
 * @param {string} dir
 * @returns {UserscriptHeader[]}
 */
export function listUserscripts(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.user.js'))
    .map((f) => parseUserscriptHeader(path.join(dir, f)));
}

/**
 * List every `*.user.js` under `dir` recursively. Used by the
 * standalone sync CLI to walk all of `tests/examples/` in one pass.
 * @param {string} dir
 * @returns {UserscriptHeader[]}
 */
export function listUserscriptsRecursive(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.user.js')) out.push(p);
    }
  };
  walk(dir);
  return out.map(parseUserscriptHeader);
}

/**
 * Compare two `1.2.3`-style versions. Returns -1 / 0 / 1.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

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
      // The script list is hydrated from IDB after DOMContentLoaded.
      await page.waitForTimeout(1000);

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
   * @returns {Promise<Map<string, string>>}
   */
  async getInstalledMap() {
    if (this._installedMap === null) {
      const list = await this.listInstalled();
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
      const fileInputs = page.locator('input[type="file"]');
      const inputCount = await fileInputs.count();
      if (inputCount === 0) {
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
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click();
        return;
      }
    }
    throw new Error(
      `Could not find an Install button on the TM confirmation page. ` +
      `URL: ${page.url()}. Tried: ${candidates.join(', ')}`
    );
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
