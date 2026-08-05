// End-to-end coverage for the malformed-script examples under
// tests/bad-examples/. Two angles:
//
//   1. Source-addition: every bad script either reports the expected
//      ERROR status (with the right errorMessage), or — for the cases
//      SM tolerates (two-headers, leading-text) or can't detect at
//      load time (the `@require`s that only fail once injected) —
//      loads OK.
//   2. Viewer round-trip: opening each script in the viewer renders
//      a code block whose textContent equals the file on disk
//      verbatim. Catches the "leading text dropped" regression
//      (splitHeaderBody used to discard everything above
//      ==UserScript==). For the "extra blank line" regression the
//      textContent is whitespace-equivalent either way, so the
//      structural assertion in test #3 (the `.userscript-header`
//      span MUST consume the trailing newline) is what guards it.
//
// A valid script from tests/examples/gm-info/ is also exercised by
// the round-trip path so the test catches a regression that affects
// well-formed scripts too.
//
// The directory lives at tests/bad-examples/ rather than under
// tests/examples/ so the TM cross-manager sync (which walks
// tests/examples/ only) never sees these files — TM refuses to
// install most of them and installs the rest inconsistently. The
// separation also lets a developer add the dir as its own SM source
// and toggle it off without losing the good examples.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserContext, Page } from '@playwright/test';

import { test, expect } from '../fixtures/extension';
// The expectations are shared with the offline CLI's test — see the
// header of that module for why they can't live in either test.
import {
  BAD_CASES,
  BAD_SCRIPTS_DIR,
  badScriptFilesOnDisk,
  expectedErrorLine,
  expectedFilePattern,
  markedErrorLine,
} from '../fixtures/bad-script-cases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GM_INFO_DIR = path.resolve(__dirname, '..', 'examples', 'gm-info');

async function openViewer(extensionContext: BrowserContext, extensionId: string, scriptId: string): Promise<Page> {
  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/userscript.html?script=${scriptId}`);
  // render() always sets document.title to `<relativePath> — SourceMonkey`,
  // even for the error cases (empty files, no-header files) where the
  // code box has no syntax tokens to wait on. Using the title as the
  // "viewer has hydrated" signal lets us cover both well-formed and
  // malformed scripts with the same wait.
  await page.waitForFunction(() => document.title.includes('—'));
  return page;
}

test.describe('bad-examples corpus', () => {
  test('addSource records the expected status for every bad script', async ({ sm }) => {
    const source = await sm.addSource(BAD_SCRIPTS_DIR);
    expect(source).not.toBeNull();
    const got = await sm.getSourceWithScripts(source!.id);
    expect(got).not.toBeNull();

    // Build an actual-by-filename map and assert each expected entry
    // independently. This gives a useful failure message even when
    // multiple cases regress at once.
    const byFile = new Map<string, typeof got.scripts[number]>();
    for (const s of got!.scripts) byFile.set(s.relativePath, s);

    for (const c of BAD_CASES) {
      const s = byFile.get(c.file);
      expect(s, `missing entry for ${c.file}`).toBeDefined();
      expect(s!.status, `wrong status for ${c.file}`).toBe(c.expectedStatus);
      if (c.errorMatcher) {
        expect(s!.errorMessage ?? '', `wrong errorMessage for ${c.file}`).toMatch(c.errorMatcher);
      } else {
        expect(s!.errorMessage ?? '', `expected no errorMessage for ${c.file}`).toBe('');
      }
      if (c.errorIn) {
        // Two assertions, because two different things have to hold.
        //
        // The structured `errorLocation` is what the viewer turns into
        // a clickable jump, so it is the field that has to be right —
        // `@require`s resolve to a full file:// URL and the script's
        // own body to its relative path, hence the tail match.
        const at = s!.errorLocation;
        expect(at?.file ?? '', `wrong error file for ${c.file}`)
          .toMatch(expectedFilePattern(c));
        expect(at?.line, `wrong error line for ${c.file}`).toBe(expectedErrorLine(c));
        if (c.expectColumn) {
          expect(at?.column, `no error column for ${c.file}`).toBeGreaterThan(0);
        } else {
          expect(at?.column, `unexpected error column for ${c.file}`).toBeUndefined();
        }
        // The *rendered* form is asserted by the offline CLI's test
        // instead (`locationPattern`, same fixture). Splitting it that
        // way keeps each test on the thing it is actually about — the
        // browser stores structure, the CLI prints text — while the
        // shared `expectedErrorLine` / `expectedFilePattern` stop the
        // two engines from disagreeing about the values.
      }
    }

    // The corpus's one non-invalid case. An unsupported `@grant` is a
    // parse-time WARNING, so it rides on `startupLogs` rather than
    // `errorMessage` — and it carries a location just like a failure
    // does, pointing at the first offending `@grant` line.
    const grants = byFile.get('unknown-grant.user.js');
    expect(grants?.startupLogs, 'unknown-grant should record a startup log').toHaveLength(1);
    expect(grants!.startupLogs![0].message).toMatch(/Ignoring @grant .* — unsupported APIs/);
    expect(grants!.startupLogs![0].location).toEqual({
      file: 'unknown-grant.user.js',
      line: markedErrorLine('unknown-grant.user.js'),
    });

    // Sanity-check that we covered every file in the directory; the
    // test fails loudly if someone adds a new bad script without
    // updating BAD_CASES.
    expect(badScriptFilesOnDisk()).toEqual(BAD_CASES.map((c) => c.file).sort());
  });

  test('the viewer round-trips each bad script byte-for-byte', async ({
    extensionContext, extensionId, sm,
  }) => {
    const source = await sm.addSource(BAD_SCRIPTS_DIR);
    const got = await sm.getSourceWithScripts(source!.id);
    const byFile = new Map<string, typeof got.scripts[number]>();
    for (const s of got!.scripts) byFile.set(s.relativePath, s);

    for (const c of BAD_CASES) {
      const s = byFile.get(c.file)!;
      const page = await openViewer(extensionContext, extensionId, s.id);
      try {
        const rendered = await page.locator('#content').textContent();
        const onDisk = fs.readFileSync(path.join(BAD_SCRIPTS_DIR, c.file), 'utf8');
        expect(rendered ?? '', `viewer textContent mismatch for ${c.file}`).toBe(onDisk);
      } finally {
        await page.close();
      }
    }
  });

  test('the viewer round-trips a valid script too', async ({
    extensionContext, extensionId, sm,
  }) => {
    // The valid baseline: any well-formed script from another examples
    // dir. gm-info is small and stable. This catches regressions where
    // the bad-script-driven path drifts away from the common case.
    const source = await sm.addSource(GM_INFO_DIR);
    const got = await sm.getSourceWithScripts(source!.id);
    const s = got!.scripts.find((x) => x.relativePath === 'gm-info.user.js');
    expect(s, 'gm-info.user.js missing from gm-info source').toBeDefined();
    expect(s!.status).toBe('ok');

    const page = await openViewer(extensionContext, extensionId, s!.id);
    try {
      const rendered = await page.locator('#content').textContent();
      const onDisk = fs.readFileSync(path.join(GM_INFO_DIR, 'gm-info.user.js'), 'utf8');
      expect(rendered ?? '').toBe(onDisk);
    } finally {
      await page.close();
    }
  });

  test('the userscript-header span consumes the trailing newline', async ({
    extensionContext, extensionId, sm,
  }) => {
    // textContent comparison can't tell whether the `\n` after
    // ==/UserScript== lives inside the header span (correct) or
    // outside it (the "extra blank line above body" regression — a
    // visual-only difference once `display: block` is in play).
    // Assert structurally: every bad-example with a properly-closed
    // header MUST end its `.userscript-header` span with `\n`.
    const source = await sm.addSource(BAD_SCRIPTS_DIR);
    const got = await sm.getSourceWithScripts(source!.id);
    const byFile = new Map<string, typeof got.scripts[number]>();
    for (const s of got!.scripts) byFile.set(s.relativePath, s);

    // The cases that have BOTH markers and a body line after — i.e.
    // every well-closed file in BAD_CASES. The ones with no header
    // (empty, no-header, unclosed-header) won't produce a span and
    // are skipped here.
    const closed = BAD_CASES.filter((c) => ![
      'empty.user.js',
      'no-header.user.js',
      'unclosed-header.user.js',
    ].includes(c.file));

    for (const c of closed) {
      const s = byFile.get(c.file)!;
      const page = await openViewer(extensionContext, extensionId, s.id);
      try {
        const tail = await page.locator('#content .userscript-header')
          .first()
          .evaluate((el) => (el.textContent ?? '').slice(-1));
        expect(tail, `header span trailing char for ${c.file}`).toBe('\n');
      } finally {
        await page.close();
      }
    }
  });
});
