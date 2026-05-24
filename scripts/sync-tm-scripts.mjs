#!/usr/bin/env node
// Sync every example userscript under tests/examples/ into the running
// Tampermonkey instance. Connects via CDP to the browser opened by
// scripts/open-test-browser-with-TamperMonkey.sh.
//
// Usage:
//   node scripts/sync-tm-scripts.mjs                  # default: tests/examples/
//   node scripts/sync-tm-scripts.mjs --dir <path>     # alternate root
//   node scripts/sync-tm-scripts.mjs --dry-run        # plan only, don't install
//   node scripts/sync-tm-scripts.mjs --allow-downgrade  # also install older-than-installed
//
// Env vars:
//   TM_CDP_PORT      — CDP port (default 9223)
//   TM_EXTENSION_ID  — TM extension ID (default Stable; override for Beta)
//
// Decides per script (by comparing local @version against the
// installed @version with dotted-numeric ordering):
//   - INSTALL    if no script with that @name is in the dashboard
//   - UPDATE     if local > installed
//   - SKIP       if local == installed
//   - SKIP-OLDER if local <  installed (annotated "would downgrade")
//                  unless --allow-downgrade is set
//   - DOWNGRADE  if local <  installed AND --allow-downgrade
//
// The TM driver (listing + install via the dashboard UI) lives in
// tests/fixtures/tampermonkey-driver.mjs; this file is the CLI wrapper
// around it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  TampermonkeyDriver,
  compareVersions,
  getTampermonkeyExtensionId,
  listUserscriptsRecursive,
} from '../tests/fixtures/tampermonkey-driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const SCRIPTS_DIR = path.resolve(ROOT, args.dir || 'tests/examples');
const DRY_RUN = !!args['dry-run'];
const ALLOW_DOWNGRADE = !!args['allow-downgrade'];
const TM_ID = getTampermonkeyExtensionId();
const PORT = Number(process.env.TM_CDP_PORT || 9223);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out['dry-run'] = true; continue; }
    if (a === '--allow-downgrade') { out['allow-downgrade'] = true; continue; }
    if (a === '--dir') { out.dir = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    console.error(`Unknown arg: ${a}`);
    process.exit(2);
  }
  return out;
}

if (args.help) {
  console.log(
    'Usage: node scripts/sync-tm-scripts.mjs [--dir <path>] [--dry-run] [--allow-downgrade]\n' +
    '\n' +
    `Connects to the TM test browser on CDP port ${PORT}\n` +
    'and installs/updates every *.user.js found under <path>.\n' +
    '\n' +
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

  console.log(`\nConnecting to TM browser at http://127.0.0.1:${PORT}…`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch((err) => {
    console.error(
      `\nCould not connect: ${err?.message ?? err}\n` +
      `Start the TM browser with: scripts/open-test-browser-with-TamperMonkey.sh`
    );
    process.exit(1);
  });
  const ctx = browser.contexts()[0];
  if (!ctx) {
    console.error('Connected but no context found.');
    process.exit(1);
  }
  const driver = new TampermonkeyDriver(ctx, TM_ID);

  try {
    console.log(`Reading dashboard…`);
    const installed = await driver.listInstalled();
    console.log(`TM has ${installed.length} script(s) installed:`);
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
        detail: `(installed v${current}, local is older — pass --allow-downgrade to install anyway)`,
      };
    });

    console.log(`\nPlan:`);
    for (const p of plan) {
      console.log(`  [${p.action.toUpperCase()}] ${p.script.name}  local=v${p.script.version}  ${p.detail}`);
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

    console.log(`\nInstalling/updating ${toDo.length} script(s)…`);
    for (const p of toDo) {
      process.stdout.write(`  ${p.action} ${p.script.name}… `);
      try {
        await driver.installFromFile(p.script.filepath);
        console.log(`ok`);
      } catch (err) {
        console.log(`FAILED`);
        console.error(`    ${err?.message ?? err}`);
      }
    }

    console.log(`\nDone. Re-reading dashboard to confirm…`);
    const after = await driver.listInstalled();
    console.log(`TM now has ${after.length} script(s) installed.`);
  } finally {
    // Don't close the browser — it's the user's interactive session.
    await browser.close().catch(() => {});
  }
}

await main();
