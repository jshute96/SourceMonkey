// One table describing every userscript manager the cross-manager
// suite can drive besides SourceMonkey, so the Playwright fixture and
// the test-browser launch agree on each one's name, env var and setup.
//
// "Manager" here means a userscript manager extension — SourceMonkey
// itself, Tampermonkey (TM), or Violentmonkey (VM). SourceMonkey is
// absent from this table on purpose: it is loaded unpacked from
// `dist/` (see sourcemonkey-launch.ts).
//
// Plain .mjs, like the drivers, so plain-node callers can read it too.

/**
 * @typedef {Object} ManagerConfig
 * @property {string} name             Playwright project name / `SM_MANAGER` value.
 * @property {string} label            Human-readable name for messages.
 * @property {string} headedEnv        Env var that shows the test browser's windows.
 * @property {string} scriptSuffix     `tm` / `vm` — the package-script suffix
 *   (`test:e2e:<suffix>`), also sm-dev's `--manager` name.
 * @property {boolean} preGrantDownloads  Whether the test browser's profile pre-grants Chrome's
 *   optional `downloads` permission for GM_download to work unattended.
 */

/** @type {Record<string, ManagerConfig>} */
export const MANAGERS = {
  tampermonkey: {
    name: 'tampermonkey',
    label: 'Tampermonkey',
    headedEnv: 'TM_HEADED',
    scriptSuffix: 'tm',
    // TM calls chrome.permissions.request() from its own prompt page,
    // which needs Chrome's native grant bubble — headless can't show
    // one, so the grant has to be written into the profile instead.
    preGrantDownloads: true,
  },
  violentmonkey: {
    name: 'violentmonkey',
    label: 'Violentmonkey',
    headedEnv: 'VM_HEADED',
    scriptSuffix: 'vm',
    // VM only reaches for chrome.downloads when the permission is
    // already granted, and falls back to an anchor download otherwise.
    // Nothing blocks, so there is nothing to pre-grant.
    preGrantDownloads: false,
  },
};

/** Names of the external managers, i.e. everything except SourceMonkey. */
export const EXTERNAL_MANAGERS = Object.keys(MANAGERS);

/**
 * @param {string} name
 * @returns {ManagerConfig}
 */
export function managerConfig(name) {
  const cfg = MANAGERS[name];
  if (!cfg) {
    throw new Error(
      `Unknown manager ${JSON.stringify(name)}; expected one of: ${EXTERNAL_MANAGERS.join(', ')}`
    );
  }
  return cfg;
}

/** True when the caller asked to see the test browser's windows. */
export function managerHeaded(name) {
  return process.env[managerConfig(name).headedEnv] === '1';
}
