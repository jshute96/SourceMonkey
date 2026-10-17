#!/usr/bin/env node
// Sync every example userscript under tests/examples/ into a running
// Tampermonkey or Violentmonkey instance. Connects via CDP to the
// browser opened by `scripts/open-test-browser.sh <manager>`.
//
// Usage:
//   node scripts/sync-manager-scripts.mjs                       # default: TM, tests/examples/
//   node scripts/sync-manager-scripts.mjs --manager violentmonkey
//   node scripts/sync-manager-scripts.mjs --dir <path>          # alternate root
//   node scripts/sync-manager-scripts.mjs --dry-run             # plan only, don't install
//   node scripts/sync-manager-scripts.mjs --allow-downgrade     # also install older-than-installed
//
// Per-manager CDP port and extension-ID env vars live in
// tests/fixtures/managers.mjs (TM_CDP_PORT / TM_EXTENSION_ID,
// VM_CDP_PORT / VM_EXTENSION_ID).
//
// Decides per script (by comparing local @version against the
// installed @version with dotted-numeric ordering):
//   - INSTALL    if no script with that @name is installed
//   - UPDATE     if local > installed
//   - SKIP       if local == installed
//   - SKIP-OLDER if local <  installed (annotated "would downgrade")
//                  unless --allow-downgrade is set
//   - DOWNGRADE  if local <  installed AND --allow-downgrade
//
// It also lists installed examples (`@name` starting `SourceMonkey
// example: `) that no local script has the name of any more: renamed or
// deleted ones. They still run on the example pages, so specs counting
// rows can fail; it says to remove them rather than doing it, since
// removing goes through each manager's own dashboard.
//
// The drivers live in tests/fixtures/{tampermonkey,violentmonkey}-driver.mjs;
// this file is the CLI wrapper around them. They compare versions with
// the extension's own `compareVersions` from `dist/`, so run
// `pnpm run build` first on a fresh clone or after `pnpm run clean`.
//
// Under VM the sync also starts a throwaway static server over the
// scripts directory: VM installs a script *from a URL* and resolves
// its relative `@require` / `@resource` refs against it, so it needs
// the file reachable over http:// rather than just present on disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { TampermonkeyDriver } from '../tests/fixtures/tampermonkey-driver.mjs';
import { ViolentmonkeyDriver } from '../tests/fixtures/violentmonkey-driver.mjs';
import { managerCdpPort, managerConfig, managerExtensionId } from '../tests/fixtures/managers.mjs';
import { compareVersions, listUserscriptsRecursive } from '../tests/fixtures/userscript-files.mjs';
import { createStaticServer } from '../tests/fixtures/slow-route.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const MANAGER = args.manager || 'tampermonkey';
let CFG;
try {
  CFG = managerConfig(MANAGER);
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(2);
}
const SCRIPTS_DIR = path.resolve(ROOT, args.dir || 'tests/examples');
const DRY_RUN = !!args['dry-run'];
const ALLOW_DOWNGRADE = !!args['allow-downgrade'];
// What every example's `@name` starts with (tests/examples/README.md).
const EXAMPLE_NAME_PREFIX = 'SourceMonkey example: ';
const EXTENSION_ID = managerExtensionId(MANAGER);
const PORT = managerCdpPort(MANAGER);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out['dry-run'] = true; continue; }
    if (a === '--allow-downgrade') { out['allow-downgrade'] = true; continue; }
    // Take the value explicitly so a trailing `--dir` with nothing
    // after it is an error, not a silent fall-back to the default.
    if (a === '--dir' || a === '--manager') {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`${a} needs a value`);
        process.exit(2);
      }
      out[a === '--dir' ? 'dir' : 'manager'] = value;
      continue;
    }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    console.error(`Unknown arg: ${a}`);
    process.exit(2);
  }
  return out;
}

if (args.help) {
  console.log(
    'Usage: node scripts/sync-manager-scripts.mjs [--manager <name>] [--dir <path>]\n' +
    '                                            [--dry-run] [--allow-downgrade]\n' +
    '\n' +
    `Connects to the ${CFG.label} test browser on CDP port ${PORT}\n` +
    'and installs/updates every *.user.js found under <path>.\n' +
    '\n' +
    '  --manager <name>     tampermonkey (default) or violentmonkey\n' +
    '  --dry-run            print plan, do not install\n' +
    '  --allow-downgrade    also install when local @version < installed\n' +
    '  --dir <path>         alternate root (default: tests/examples/)'
  );
  process.exit(0);
}

async function main() {
  if (!fs.existsSync(SCRIPTS_DIR)) {
    console.error(`Scripts directory not found: ${SCRIPTS_DIR}`);
    process.exit(1);
  }

  const local = listUserscriptsRecursive(SCRIPTS_DIR);
  console.log(`Found ${local.length} local userscript(s) under ${path.relative(ROOT, SCRIPTS_DIR)}/`);
  for (const s of local) {
    console.log(`  ${s.name}  v${s.version}  (${path.relative(ROOT, s.filepath)})`);
  }

  console.log(`\nConnecting to the ${CFG.label} browser at http://127.0.0.1:${PORT}…`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch((err) => {
    console.error(
      `\nCould not connect: ${err?.message ?? err}\n` +
      `Start the browser with: scripts/open-test-browser.sh ${MANAGER}`
    );
    process.exit(1);
  });
  const ctx = browser.contexts()[0];
  if (!ctx) {
    console.error('Connected but no context found.');
    process.exit(1);
  }
  const isVm = MANAGER === 'violentmonkey';
  const driver = isVm
    ? new ViolentmonkeyDriver(ctx, EXTENSION_ID)
    : new TampermonkeyDriver(ctx, EXTENSION_ID);

  try {
    console.log(`Reading the installed-script list…`);
    const installed = await driver.listInstalled();
    console.log(`${CFG.label} has ${installed.length} script(s) installed:`);
    for (const s of installed) {
      console.log(`  ${s.name}  v${s.version || '?'}`);
    }

    const byName = new Map(installed.map((s) => [s.name, s.version]));
    const plan = local.map((script) => {
      const current = byName.get(script.name);
      if (current === undefined) {
        return { script, current, action: 'install', detail: '(not installed)' };
      }
      const cmp = compareVersions(script.version, current);
      if (cmp > 0) {
        return { script, current, action: 'update', detail: `(installed v${current}, local is newer)` };
      }
      if (cmp === 0) {
        return { script, current, action: 'skip', detail: `(installed v${current}, same)` };
      }
      // local < installed — would downgrade.
      if (ALLOW_DOWNGRADE) {
        return { script, current, action: 'downgrade', detail: `(installed v${current}, local is older)` };
      }
      return {
        script, current, action: 'skip-older',
        detail: `(installed v${current}, local is older; pass --allow-downgrade to install anyway)`,
      };
    });

    console.log(`\nPlan:`);
    for (const p of plan) {
      console.log(`  [${p.action.toUpperCase()}] ${p.script.name}  local=v${p.script.version}  ${p.detail}`);
    }
    const localNames = new Set(local.map((s) => s.name));
    const stale = installed.filter((s) => s.name.startsWith(EXAMPLE_NAME_PREFIX) && !localNames.has(s.name));
    if (stale.length) {
      console.log(`\n${CFG.label} has example scripts no local file is named for any more (renamed or deleted):`);
      for (const s of stale) console.log(`  [STALE] ${s.name}  v${s.version || '?'}`);
      console.log(`They still run on the example pages. Remove them from ${CFG.label}'s dashboard.`);
    }

    if (DRY_RUN) {
      console.log(`\n--dry-run: not performing installs.`);
      return;
    }

    const actionable = new Set(['install', 'update', 'downgrade']);
    const toDo = plan.filter((p) => actionable.has(p.action));
    if (!toDo.length) {
      console.log(`\nNothing to do.`);
      return;
    }

    // VM installs from a URL, so the scripts have to be reachable over
    // http:// for the duration — see the header comment.
    const server = isVm ? createStaticServer(SCRIPTS_DIR) : null;
    const baseUrl = server ? await server.listen(0) : null;
    if (baseUrl) console.log(`Serving ${path.relative(ROOT, SCRIPTS_DIR)}/ on ${baseUrl} for the install URLs.`);

    console.log(`\nInstalling/updating ${toDo.length} script(s)…`);
    try {
      for (const p of toDo) {
        process.stdout.write(`  ${p.action} ${p.script.name}… `);
        try {
          if (baseUrl) {
            const rel = path.relative(SCRIPTS_DIR, p.script.filepath).split(path.sep).join('/');
            await driver.installFromFile(p.script.filepath, `${baseUrl}/${rel}`);
          } else {
            await driver.installFromFile(p.script.filepath);
          }
          console.log(`ok`);
        } catch (err) {
          console.log(`FAILED`);
          console.error(`    ${err?.message ?? err}`);
        }
      }
    } finally {
      await server?.close();
    }

    console.log(`\nDone. Re-reading the installed-script list to confirm…`);
    const after = await driver.listInstalled();
    console.log(`${CFG.label} now has ${after.length} script(s) installed.`);
  } finally {
    // Release the driver's own page before disconnecting: the VM driver
    // keeps one open for its whole lifetime, and this is the user's
    // interactive browser, not a throwaway one.
    await driver.close().catch(() => {});
    // Don't close the browser — it's the user's interactive session.
    await browser.close().catch(() => {});
  }
}

await main();
