// Keeps example userscripts in sync inside a Violentmonkey (VM)
// install. Same shape as tampermonkey-driver.mjs — listInstalled /
// getInstalledMap / installFromFile — so tests/fixtures/manager.ts can
// treat the two interchangeably.
//
// Callers pass the BrowserContext VM runs in, as for TM: the tests' own
// browser.
//
// Where this differs from the TM driver: we don't drive VM's UI.
//
//   - VM is open source, so its background command API is readable and
//     stable enough to call: this driver opens a page on VM's own
//     extension origin and posts `{cmd, data}` messages to the
//     background, which is precisely what VM's dashboard and its
//     install-confirmation page do.
//   - That skips the whole Vue dashboard — no selectors to keep up
//     with, no confirmation page to click through, and an install
//     costs one message instead of two page loads.
//   - The commands used are `GetData` (what the dashboard reads) and
//     `ParseScript` (what the confirm page calls on Install). Both are
//     `src/background/utils/db.js` in the VM tree.
//
// Version pinned by observation: VM 2.48.0. If a future VM renames
// those commands, nothing answers the message and the send fails with
// a closed port — `sendCommand` below turns that into a message naming
// the command.

import fs from 'node:fs';
import { listUserscripts } from './userscript-files.mjs';

/**
 * @typedef {Object} InstalledScript
 * @property {string} name
 * @property {string} version
 */

export class ViolentmonkeyDriver {
  /**
   * @param {import('@playwright/test').BrowserContext} context
   * @param {string} extensionId
   */
  constructor(context, extensionId) {
    /** @private */ this.context = context;
    /** @private */ this.extensionId = extensionId;
    /**
     * Cached `@name -> installed @version`, same contract as the TM
     * driver's: populated on first read, mutated in place after each
     * install, and only valid while nothing outside this driver
     * changes VM's script list.
     * @private
     * @type {Map<string, string> | null}
     */
    this._installedMap = null;
    /**
     * Long-lived page on VM's extension origin, used as the sender for
     * every background command. Recreated on demand — the examples
     * fixture closes pages a test opened when that test ends.
     * @private
     * @type {import('@playwright/test').Page | null}
     */
    this._cmdPage = null;
  }

  /** @returns {string} */
  dashboardUrl() {
    return `chrome-extension://${this.extensionId}/options/index.html`;
  }

  /**
   * A page whose origin is VM's own. VM's background refuses commands
   * from anywhere else (`handleCommandMessage` compares the sender's
   * origin against the extension's), so the message has to come from
   * inside a VM page rather than from a test page.
   * @private
   * @returns {Promise<import('@playwright/test').Page>}
   */
  async _page() {
    if (this._cmdPage && !this._cmdPage.isClosed()) return this._cmdPage;
    const page = await this.context.newPage();
    try {
      await page.goto(this.dashboardUrl());
    } catch (err) {
      await page.close().catch(() => {});
      throw new Error(
        `Could not open the Violentmonkey dashboard at ${this.dashboardUrl()}. ` +
        `Is VM installed in this profile? See docs/cross-manager-testing.md. ` +
        `Underlying error: ${err?.message ?? err}`
      );
    }
    this._cmdPage = page;
    return page;
  }

  /**
   * Send one command to VM's background and return its result.
   *
   * Response shape, measured against VM 2.48.0's MV3 build rather than
   * assumed: `chrome.runtime.sendMessage` resolves with the command's
   * raw return value, and *rejects* with the background's own error
   * text when the command throws. (VM's source wraps responses as
   * `[result, error]` for the channels its own pages use — its extension
   * pages reach the service worker over `navigator.serviceWorker`
   * postMessage, not `runtime.sendMessage` — but nothing wraps what
   * comes back here.)
   *
   * An unrecognized command has no handler to answer it, so the port
   * closes and the send rejects with Chrome's own wording; that is the
   * signal a VM release renamed something.
   * @param {string} cmd
   * @param {unknown} data
   * @returns {Promise<any>}
   */
  async sendCommand(cmd, data) {
    // The try/catch lives inside the page: a rejection crossing
    // `evaluate` arrives wrapped in Playwright's own framing, which
    // buries the one line that says what VM objected to.
    const run = async () => {
      const page = await this._page();
      return page.evaluate(
        async ([c, d]) => {
          try {
            return { ok: true, value: await chrome.runtime.sendMessage({ cmd: c, data: d }) };
          } catch (err) {
            return { ok: false, error: String(err?.message ?? err) };
          }
        },
        [cmd, data],
      );
    };
    let res;
    try {
      res = await run();
    } catch (err) {
      // The cached page can die between `_page()`'s isClosed check and
      // the evaluate — the browser is the developer's own and they may
      // be closing tabs in it. Drop the handle and try once more, so
      // that surfaces as a real result rather than a raw Playwright
      // "Target page ... has been closed".
      if (!String(err?.message ?? err).includes('has been closed')) throw err;
      this._cmdPage = null;
      res = await run();
    }
    if (!res.ok) {
      if (res.error.includes('message port closed')) {
        throw new Error(
          `Violentmonkey did not answer the '${cmd}' command. This VM build may have ` +
          `renamed or removed it; see tests/fixtures/violentmonkey-driver.mjs.`
        );
      }
      throw new Error(`Violentmonkey '${cmd}' failed: ${res.error}`);
    }
    return res.value;
  }

  /**
   * One entry per installed (non-deleted) userscript, read from the
   * same `GetData` command VM's dashboard uses.
   * @returns {Promise<InstalledScript[]>}
   */
  async listInstalled() {
    const data = await this.sendCommand('GetData', {});
    const scripts = data?.scripts ?? [];
    return scripts
      .filter((s) => !s?.config?.removed)
      .map((s) => ({ name: s?.meta?.name ?? '', version: s?.meta?.version ?? '' }))
      .filter((s) => s.name);
  }

  /**
   * Cached `listInstalled` keyed by `@name`. Warns about duplicate
   * names for the same reason the TM driver does: two copies of a
   * script both run on every matching page, and the only symptom is a
   * spec counting two of something it expects one of.
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
          `[vm-driver] Violentmonkey has more than one copy of: ${[...duplicated].join(', ')}. ` +
          `Each copy runs on every matching page, so specs that count elements will fail. ` +
          `Remove the extras from VM's dashboard.`
        );
      }
      this._installedMap = new Map(list.map((s) => [s.name, s.version]));
    }
    return this._installedMap;
  }

  /**
   * Update the cached installed-versions map. No-op before the cache
   * is populated — the next `getInstalledMap` reads fresh state anyway.
   * @param {string} name
   * @param {string} version
   */
  recordInstalled(name, version) {
    if (this._installedMap !== null) this._installedMap.set(name, version);
  }

  /** Force the next `getInstalledMap` to re-read VM's script list. */
  invalidateInstalledCache() {
    this._installedMap = null;
  }

  /**
   * Install (or update) one userscript from a local file, telling VM it
   * came from `installUrl`.
   *
   * **`installUrl` is load-bearing, not cosmetic.** VM resolves a
   * script's relative `@require` / `@resource` / `@icon` refs against
   * the URL it was installed from (`buildPathMap`), and records it as
   * `lastInstallURL`. Handing VM the local path instead would leave
   * those refs unresolvable and diverge from how a real VM user
   * installs — so callers pass the URL the fixture server serves the
   * same file at, and VM fetches the dependencies from there.
   *
   * Does NOT update the cached installed-versions map; callers that
   * track versions call `recordInstalled` after a successful install.
   * @param {string} filepath
   * @param {string} installUrl
   * @returns {Promise<void>}
   */
  async installFromFile(filepath, installUrl) {
    const code = fs.readFileSync(filepath, 'utf8');
    await this.sendCommand('ParseScript', {
      code,
      url: installUrl,
      from: installUrl,
      // Both maps are empty on purpose: VM only fetches `@require` /
      // `@resource` targets it wasn't handed, which is what we want
      // (they come off the fixture server), and a present-but-empty
      // `cache` is also what makes VM *await* those fetches before
      // resolving. Omit it and the install returns with dependencies
      // still in flight, so a spec that navigates immediately can find
      // a script whose `@require` hasn't landed.
      require: {},
      cache: {},
      bumpDate: true,
    });
  }
}

/**
 * Install every `*.user.js` directly under `dir` into Violentmonkey
 * that isn't installed yet, by `@name` (see syncTampermonkeyScripts).
 *
 * @param {ViolentmonkeyDriver} driver
 * @param {string} dir
 * @param {(filepath: string) => string} installUrlFor  Maps a local
 *   file to the URL VM should treat as its install source — see
 *   `installFromFile`.
 * @returns {Promise<void>}
 */
export async function syncViolentmonkeyScripts(driver, dir, installUrlFor) {
  const byName = await driver.getInstalledMap();
  for (const script of listUserscripts(dir)) {
    if (byName.has(script.name)) continue;
    await driver.installFromFile(script.filepath, installUrlFor(script.filepath));
    driver.recordInstalled(script.name, script.version);
  }
}
