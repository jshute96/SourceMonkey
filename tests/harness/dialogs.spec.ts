// The `dialog` command's file chooser: a click on an `<input type=file>`,
// in the document or not, is caught before Chrome shows its chooser,
// shown as a dialog, and answered with files given from where the
// command ran. The page's JavaScript dialogs and connection prompts are
// covered in console-commands.spec.ts and run-tabs.spec.ts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test, expect } from '../fixtures/harness.js';
import { DialogTracker, runConsoleCommand, type ConsoleContext } from '../../lib/harness/console-commands.js';
import { plainLine } from '../../lib/harness/output-style.js';
import { jsonResultData } from '../../lib/harness/json-output.js';

let dir: string;
test.beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sm-dialogs-'));
  writeFileSync(path.join(dir, 'a.json'), '{"a":1}');
  writeFileSync(path.join(dir, 'b.json'), '{"b":2}');
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A page whose buttons open choosers the way scripts do: `.click()` on
// an input never added to the document, one for multiple files, and one
// that waits for a cancel. What each chose is in `window.chosen`.
const PAGE = `
  <button id="one">Import</button>
  <button id="many">Import multiple</button>
  <script>
    window.chosen = [];
    const choose = (multiple) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.multiple = multiple;
      input.addEventListener('change', async () => {
        for (const f of input.files) window.chosen.push(f.name + '=' + await f.text());
      });
      input.addEventListener('cancel', () => window.chosen.push('cancelled'));
      input.click();
    };
    document.querySelector('#one').onclick = () => choose(false);
    document.querySelector('#many').onclick = () => choose(true);
  </script>`;

test('a file chooser is caught, shown as a dialog, and answered with files', async ({ page, fixtureServer, host, attachment }) => {
  const lines: string[] = [];
  const dialogs = await DialogTracker.attach(page, (t) => lines.push(plainLine(`[sm-dev] ${t}`)), { visible: false, commandsComing: true });
  await page.route('**/chooser.html', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  const url = `${fixtureServer.baseUrl}/chooser.html`;
  await page.goto(url);
  const tabs = [{ n: 1, page, link: attachment, dialogs }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [], out: (l) => lines.push(plainLine(l)), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx, { cwd: dir });
    return [...lines];
  };
  const chosen = () => page.evaluate(() => (window as unknown as { chosen: string[] }).chosen);

  // The chooser doesn't stop the page, so the click returns as usual.
  expect(await run('click #one')).toContain('[sm-dev] Clicked #one');
  await expect.poll(() => dialogs.waiting.length).toBe(1);
  expect(lines.find((l) => l.includes('*DIALOG*'))).toBe([
    '[sm-dev] *DIALOG* T1.1  File chooser',
    `  From:     Chrome, for an <input type=file> on ${url}`,
    '  Choose:   One file',
    '  Accepts:  .json',
    '',
    '  Fields:',
    '    Field  Value   Set with',
    '    file   (none)  dialog set file <file>',
    '',
    '  Buttons:',
    '    Button  Command',
    '    Open    dialog accept [file]',
    '    Cancel  dialog cancel',
  ].join('\n'));
  // The page goes on meanwhile.
  expect(await run('eval 1 + 1')).toEqual(['2']);
  expect(await run('dialog accept')).toEqual(['[sm-dev] ERROR: Choose a file first: `dialog set file <file>`, or give it to `dialog accept`']);
  expect(await run('dialog accept nope.json')).toEqual(['[sm-dev] ERROR: There is no file at nope.json']);
  expect(await run('dialog accept a.json b.json')).toEqual(['[sm-dev] ERROR: File chooser dialog T1.1 takes one file']);
  expect(await run('dialog accept a.json')).toEqual(['[sm-dev] Clicked Open on File chooser dialog T1.1']);
  await expect.poll(chosen).toEqual(['a.json={"a":1}']);
  expect(dialogs.waiting).toEqual([]);

  // Multiple files, set first, a glob among them.
  await run('click #many');
  await expect.poll(() => dialogs.waiting.length).toBe(1);
  expect(await run('dialog set files *.json')).toEqual([`[sm-dev] Set files to "${dir}/a.json" "${dir}/b.json" on File chooser dialog T1.2`]);
  const shown = jsonResultData((await (async () => {
    ctx.json = true;
    try {
      return run('dialog show --json');
    } finally {
      ctx.json = undefined;
    }
  })())[0])!.data as { dialogs: { fields: { name: string; value: string[]; multiple: boolean }[] }[] };
  expect(shown.dialogs[0].fields[0]).toMatchObject({ name: 'files', multiple: true, value: [`${dir}/a.json`, `${dir}/b.json`] });
  await run('dialog accept');
  await expect.poll(chosen).toEqual(['a.json={"a":1}', 'a.json={"a":1}', 'b.json={"b":2}']);

  // Cancel reaches a page that listens for it.
  await run('click #one');
  await expect.poll(() => dialogs.waiting.length).toBe(1);
  expect(await run('dialog cancel')).toEqual(['[sm-dev] Clicked Cancel on File chooser dialog T1.3']);
  await expect.poll(chosen).toContain('cancelled');

  // A chooser left waiting goes away with its page.
  await run('click #one');
  await expect.poll(() => dialogs.waiting.length).toBe(1);
  await page.reload();
  await expect.poll(() => dialogs.waiting.length).toBe(0);
});

test('without commands to answer it, Chrome keeps its own file chooser', async ({ page, fixtureServer, host, attachment }) => {
  const dialogs = await DialogTracker.attach(page, () => undefined, { visible: false, commandsComing: false });
  await page.route('**/chooser.html', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto(`${fixtureServer.baseUrl}/chooser.html`);
  void host;
  void attachment;
  // Playwright sees the chooser only when Chrome would show it.
  const seen = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#one');
  const chooser = await seen;
  await chooser.setFiles(path.join(dir, 'a.json'));
  await expect.poll(() => page.evaluate(() => (window as unknown as { chosen: string[] }).chosen)).toEqual(['a.json={"a":1}']);
  expect(dialogs.waiting).toEqual([]);
});

test('two dialogs in a row, and two at once, each get their own id', async ({ page, fixtureServer, host, attachment }) => {
  const lines: string[] = [];
  const dialogs = await DialogTracker.attach(page, (t) => lines.push(plainLine(`[sm-dev] ${t}`)), { visible: false, commandsComing: true });
  await page.route('**/chooser.html', (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto(`${fixtureServer.baseUrl}/chooser.html`);
  const tabs = [{ n: 1, page, link: attachment, dialogs }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [], out: (l) => lines.push(plainLine(l)), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx, { cwd: dir });
    return [...lines];
  };

  // A confirm answered, then another at once: the second is the one
  // waiting, not the first.
  page.evaluate(() => { (window as unknown as { second?: boolean }).second = confirm('first') && confirm('second'); }).catch(() => undefined);
  await expect.poll(() => dialogs.waiting.map((d) => d.id)).toEqual(['T1.1']);
  expect(await run('dialog accept')).toEqual(['[sm-dev] Clicked OK on Confirm dialog T1.1']);
  await expect.poll(() => dialogs.waiting.map((d) => d.id)).toEqual(['T1.2']);
  expect((await run('dialog show')).slice(0, 3)).toEqual(['T1 has 1 dialog waiting.', '', 'T1.2  Confirm (default for `dialog` commands)']);
  expect(await run('dialog accept')).toEqual(['[sm-dev] Clicked OK on Confirm dialog T1.2']);
  await expect.poll(() => page.evaluate(() => (window as unknown as { second?: boolean }).second)).toBe(true);

  // A chooser, then an alert while it waits: the alert's commands name
  // it, since the chooser is the default.
  await run('click #one');
  await expect.poll(() => dialogs.waiting.length).toBe(1);
  lines.length = 0;
  page.evaluate(() => alert('Press ` to go on')).catch(() => undefined);
  await expect.poll(() => dialogs.waiting.length).toBe(2);
  expect(lines.find((l) => l.includes('*DIALOG* T1.4'))).toContain('    OK      dialog accept --dialog T1.4');
  const shown = await run('dialog show');
  expect(shown[0]).toBe('T1 has 2 dialogs waiting. `dialog` commands apply to T1.3 by default. Use --dialog or `dialog select` to choose another.');
  expect(shown).toContain('T1.3  File chooser (default for `dialog` commands)');
  expect(shown).toContain('T1.4  Alert');
  // The page's own backtick stays text: the command after it is intact.
  expect(await run('tabs')).toContain('    Waiting on Alert dialog T1.4: "Press ` to go on". Use `dialog show` to see how to answer it.');
  expect(await run('dialog accept --dialog T1.4')).toEqual(['[sm-dev] Clicked OK on Alert dialog T1.4']);
  expect(await run('dialog cancel')).toEqual(['[sm-dev] Clicked Cancel on File chooser dialog T1.3']);
  expect(await run('dialog accept --dialog T1.4')).toEqual(['[sm-dev] No dialog T1.4 is waiting, and no others are']);
});

test('a dialog from a cross-site iframe stays listed while the rest of the page runs', async ({ page, fixtureServer, host, attachment }) => {
  const dialogs = await DialogTracker.attach(page, () => undefined, { visible: false, commandsComing: true });
  // The same server under another host name: a site of its own, so the
  // iframe runs in a process of its own.
  const other = fixtureServer.baseUrl.replace('127.0.0.1', 'localhost');
  await page.route('**/outer.html', (route) => route.fulfill({ contentType: 'text/html', body: `<iframe src="${other}/inner.html"></iframe>` }));
  await page.route('**/inner.html', (route) => route.fulfill({ contentType: 'text/html', body: '<script>setTimeout(() => alert("from the frame"), 100)</script>' }));
  await page.goto(`${fixtureServer.baseUrl}/outer.html`);
  await expect.poll(() => dialogs.waiting.length).toBe(1);
  expect(await page.evaluate(() => 1)).toBe(1);
  await dialogs.verify();
  expect(dialogs.waiting.map((d) => d.title)).toEqual(['Alert']);
  void host;
  void attachment;
});
