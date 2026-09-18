// One table describing every userscript manager the cross-manager
// suite can drive, so the Playwright fixture, the preflight, the sync
// CLI, and the browser-opener shell script all agree on the profile
// directory, CDP port, and extension ID for each.
//
// "Manager" here means a userscript manager extension — SourceMonkey
// itself, Tampermonkey (TM), or Violentmonkey (VM). SourceMonkey is
// absent from this table on purpose: it is loaded unpacked from
// `dist/` into a throwaway profile (see sourcemonkey-launch.ts) and
// needs none of the persistent-profile machinery described here.
//
// Plain .mjs so the shell opener and the node CLIs can read it without
// a build step; the TypeScript fixture imports it the same way it
// already imports tampermonkey-driver.mjs.
//
// Also runnable as a CLI for shell consumers:
//   eval "$(node tests/fixtures/managers.mjs --shell tampermonkey)"

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

/**
 * @typedef {Object} ManagerConfig
 * @property {string} name             Playwright project name / `SM_MANAGER` value.
 * @property {string} label            Human-readable name for messages.
 * @property {string} cwsId            Chrome Web Store extension ID of the stable channel.
 * @property {string} cwsUrl           Web Store listing, printed in first-run instructions.
 * @property {string} idEnv            Env var overriding the extension ID (e.g. a beta channel).
 * @property {string} portEnv          Env var overriding the CDP port.
 * @property {string} headedEnv        Env var that selects headed (CDP-attach) mode.
 * @property {string} scriptSuffix     `tm` / `vm` — the package-script suffix
 *   (`test:e2e:<suffix>`), named here so messages don't re-derive it.
 * @property {number} defaultCdpPort   CDP port the opener script binds.
 * @property {string} profileDir       Absolute path to the persistent Chromium profile.
 * @property {boolean} preGrantDownloads  Whether the preflight must pre-grant Chrome's
 *   optional `downloads` permission for GM_download to work unattended.
 */

/** @type {Record<string, ManagerConfig>} */
export const MANAGERS = {
  tampermonkey: {
    name: 'tampermonkey',
    label: 'Tampermonkey',
    cwsId: 'dhdgffkkebhmkfjojejmpbldmpobfkfo',
    cwsUrl: 'https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo',
    idEnv: 'TM_EXTENSION_ID',
    portEnv: 'TM_CDP_PORT',
    headedEnv: 'TM_HEADED',
    scriptSuffix: 'tm',
    defaultCdpPort: 9223,
    profileDir: path.join(ROOT, '.chrome-tampermonkey-profile'),
    // TM calls chrome.permissions.request() from its own prompt page,
    // which needs Chrome's native grant bubble — headless can't show
    // one, so the grant has to be written into the profile instead.
    preGrantDownloads: true,
  },
  violentmonkey: {
    name: 'violentmonkey',
    label: 'Violentmonkey',
    cwsId: 'jinjaccalgkegednnccohejagnlnfdag',
    cwsUrl: 'https://chromewebstore.google.com/detail/jinjaccalgkegednnccohejagnlnfdag',
    idEnv: 'VM_EXTENSION_ID',
    portEnv: 'VM_CDP_PORT',
    headedEnv: 'VM_HEADED',
    scriptSuffix: 'vm',
    // A different port from TM's on purpose: the two profiles can be
    // open at the same time, and a shared port would attach the suite
    // to whichever browser won the bind.
    defaultCdpPort: 9224,
    profileDir: path.join(ROOT, '.chrome-violentmonkey-profile'),
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

/** Extension ID for this manager, honouring its override env var. */
export function managerExtensionId(name) {
  const cfg = managerConfig(name);
  return process.env[cfg.idEnv] || cfg.cwsId;
}

/**
 * CDP port for this manager, honouring its override env var.
 *
 * A junk override is rejected rather than passed on: `Number('http')`
 * is `NaN`, and `--remote-debugging-port=NaN` starts a browser that
 * nothing can attach to, which reads as "the manager isn't installed".
 */
export function managerCdpPort(name) {
  const cfg = managerConfig(name);
  const raw = process.env[cfg.portEnv];
  if (!raw) return cfg.defaultCdpPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${cfg.portEnv} must be a TCP port number; got ${JSON.stringify(raw)}`);
  }
  return port;
}

/** True when the caller asked for headed (attach-to-running-browser) mode. */
export function managerHeaded(name) {
  return process.env[managerConfig(name).headedEnv] === '1';
}

// ----- CLI: emit shell variable assignments -----
//
// `scripts/open-test-browser.sh` evals this so the profile path and
// CDP port have exactly one definition.

/**
 * Quote a value for `eval` in bash. Single quotes, not JSON: bash still
 * expands `$`, backticks and backslashes inside double quotes, and a
 * checkout path containing any of those would silently produce the
 * wrong profile directory rather than an error. Inside single quotes
 * nothing expands, so only `'` itself needs escaping.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, name] = process.argv.slice(2);
  if (flag !== '--shell' || !name) {
    console.error('Usage: node tests/fixtures/managers.mjs --shell <manager>');
    process.exit(2);
  }
  let cfg;
  try {
    cfg = managerConfig(name);
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(2);
  }
  let port;
  try {
    port = managerCdpPort(name);
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(2);
  }
  console.log(`MANAGER_LABEL=${shellQuote(cfg.label)}`);
  console.log(`MANAGER_PROFILE_DIR=${shellQuote(cfg.profileDir)}`);
  console.log(`MANAGER_CDP_PORT=${shellQuote(port)}`);
  console.log(`MANAGER_CWS_URL=${shellQuote(cfg.cwsUrl)}`);
}
