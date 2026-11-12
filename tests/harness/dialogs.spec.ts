// The `dialog` command:
// - A click on an `<input type=file>`, in the document or not, is
//   caught before Chrome shows its chooser, shown as a dialog, and
//   answered with files given from where the command ran.
// - A chooser whose `change` handler opens a confirm is answered
//   without waiting for the confirm's answer.
// - Multiple dialogs at once get their own ids, a dialog that blocks
//   the page is the default, and a chooser it blocks is refused.
// - The last test answers the dialogs example's dialogs
//   (userscripts/examples/dialogs/), and checks its pickers are refused.
// The page's JavaScript dialogs and connection prompts are covered
// further in console-commands.spec.ts and run-tabs.spec.ts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../fixtures/harness.js';
import { DialogTracker, runConsoleCommand, type ConsoleContext } from '../../lib/harness/console-commands.js';
import { PICKER_REFUSED } from '../../lib/harness/dialogs.js';
import { plainLine } from '../../lib/harness/output-style.js';
import { jsonResultData } from '../../lib/harness/json-output.js';

const EXAMPLE = fileURLToPath(new URL('../../userscripts/examples/dialogs', import.meta.url));

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

// An import like 4chan X's: the input's change handler asks with a
// confirm before going on.
const CONFIRMING_PAGE = `
  <button id="import">Import</button>
  <script>
    window.chosen = [];
    document.querySelector('#import').onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.addEventListener('change', () => window.chosen.push(confirm('Overwrite?') ? input.files[0].name : 'kept'));
      input.click();
    };
  </script>`;

test('a chooser whose change handler opens a confirm is answered without waiting for the confirm', async ({ page, fixtureServer, host, attachment }) => {
  const lines: string[] = [];
  const dialogs = await DialogTracker.attach(page, (t) => lines.push(plainLine(`[sm-dev] ${t}`)), { visible: false, commandsComing: true });
  await page.route('**/confirming.html', (route) => route.fulfill({ contentType: 'text/html', body: CONFIRMING_PAGE }));
  await page.goto(`${fixtureServer.baseUrl}/confirming.html`);
  const tabs = [{ n: 1, page, link: attachment, dialogs }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [], out: (l) => lines.push(plainLine(l)), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx, { cwd: dir });
    return [...lines];
  };

  await run('click #import');
  await expect.poll(() => dialogs.waiting.length).toBe(1);
  // The answer returns once the confirm opens, rather than waiting for
  // the confirm's answer.
  const answered = await run('dialog accept a.json');
  expect(answered).toContain('[sm-dev] Clicked Open on File chooser dialog T1.1');
  expect(dialogs.waiting.map((d) => d.title)).toEqual(['Confirm']);
  expect(await run('dialog accept')).toEqual(['[sm-dev] Clicked OK on Confirm dialog T1.2']);
  await expect.poll(() => page.evaluate(() => (window as unknown as { chosen: string[] }).chosen)).toEqual(['a.json']);
  expect(dialogs.waiting).toEqual([]);
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
  // The answer's wait shows the next confirm as it opens.
  const first = await run('dialog accept');
  expect(first[0]).toBe('[sm-dev] Clicked OK on Confirm dialog T1.1');
  expect(first.slice(1).join('\n')).toContain('*DIALOG* T1.2  Confirm');
  await expect.poll(() => dialogs.waiting.map((d) => d.id)).toEqual(['T1.2']);
  expect((await run('dialog show')).slice(0, 3)).toEqual(['T1 has 1 dialog waiting.', '', 'T1.2  Confirm (default for `dialog` commands)']);
  expect(await run('dialog accept')).toEqual(['[sm-dev] Clicked OK on Confirm dialog T1.2']);
  await expect.poll(() => page.evaluate(() => (window as unknown as { second?: boolean }).second)).toBe(true);

  // A chooser, then an alert while it waits. The alert stops the page,
  // so it becomes the default, while its block still names it, as a
  // block shown with another dialog waiting does.
  await run('click #one');
  await expect.poll(() => dialogs.waiting.length).toBe(1);
  lines.length = 0;
  page.evaluate(() => alert('Press ` to go on')).catch(() => undefined);
  await expect.poll(() => dialogs.waiting.length).toBe(2);
  expect(lines.find((l) => l.includes('*DIALOG* T1.4'))).toContain('    OK      dialog accept --dialog T1.4');
  const shown = await run('dialog show');
  expect(shown[0]).toBe('T1 has 2 dialogs waiting. `dialog` commands apply to T1.4 by default. Use --dialog or `dialog select` to choose another.');
  expect(shown).toContain('T1.3  File chooser');
  expect(shown).toContain('T1.4  Alert (default for `dialog` commands)');
  // The chooser's answer would wait on the page, which the alert holds.
  expect(await run('dialog cancel --dialog T1.3')).toEqual(['[sm-dev] ERROR: File chooser dialog T1.3 can\'t be answered while Alert dialog T1.4 blocks its page. Answer T1.4 first. Use `dialog show` to see how.']);
  // The page's own backtick stays text: the command after it is intact.
  expect(await run('tabs')).toContain('    Waiting on Alert dialog T1.4: "Press ` to go on". Use `dialog show` to see how to answer it.');
  expect(await run('dialog accept')).toEqual(['[sm-dev] Clicked OK on Alert dialog T1.4']);
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

// The dialogs example (userscripts/examples/dialogs/), answered with
// `dialog` commands as a person at sm-dev would.
test('the dialogs example: its dialogs answered with `dialog`, and its pickers refused', async ({ page, fixtureServer, host, attachment, loadUserscript }) => {
  const lines: string[] = [];
  const dialogs = await DialogTracker.attach(page, (t) => lines.push(plainLine(`[sm-dev] ${t}`)), { visible: false, commandsComing: true });
  const url = `${fixtureServer.baseUrl}/dialogs/dialogs.html`;
  await loadUserscript(path.join(EXAMPLE, 'dialogs.user.js'), { url });
  await page.goto(url);
  await expect(page.locator('#runStatus')).toHaveClass(/ran/);
  const tabs = [{ n: 1, page, link: attachment, dialogs }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [], out: (l) => lines.push(plainLine(l)), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx, { cwd: dir });
    return [...lines];
  };
  const result = (kind: string) => page.locator(`#log li[data-kind="${kind}"]`).first();

  await run('click #btn-confirm');
  // A message's blank line stays blank, and its later lines line up.
  expect(lines.find((l) => l.includes('*DIALOG* T1.1'))).toContain('  Message:  Delete the sample item?\n\n            This can\'t be undone.\n');
  await run('dialog accept');
  await expect(result('confirm')).toHaveAttribute('data-result', 'true');

  await run('click #btn-prompt');
  await run('dialog accept "Ann Lee Jr"');
  await expect(result('prompt')).toHaveAttribute('data-result', 'Ann Lee Jr');

  await run('click #btn-two-confirms');
  const answered = await run('dialog accept');
  expect(answered[0]).toBe('[sm-dev] Clicked OK on Confirm dialog T1.3');
  expect(answered.slice(1).join('\n')).toContain('*DIALOG* T1.4  Confirm');
  await expect.poll(() => dialogs.waiting.map((d) => d.id)).toEqual(['T1.4']);
  await run('dialog cancel');
  await expect(result('two-confirms')).toHaveAttribute('data-result', 'true,false');

  await run('click #btn-file');
  await run('dialog accept a.json');
  await expect(result('file')).toContainText('a.json (7 bytes)');
  await run('click #btn-files');
  await run('dialog cancel');
  await expect(result('files')).toHaveAttribute('data-result', 'cancelled');

  // Chrome refuses a picker while file choosers are caught, so nothing
  // is left waiting, and the run says why.
  for (const kind of ['open', 'save', 'directory']) {
    await run(`click #btn-${kind}-picker`);
    await expect(result(`${kind}-picker`)).toHaveAttribute('data-result', 'cancelled');
    await expect.poll(() => lines).toContain(plainLine(`[sm-dev] Warning: ${PICKER_REFUSED}`));
  }
  expect(dialogs.waiting).toEqual([]);

  await run('click #leave');
  await run('reload');
  await expect.poll(() => dialogs.waiting.map((d) => d.title)).toEqual(['Leave site']);
  await run('dialog cancel');
  // The page stayed: a reload would have cleared its log.
  await expect(result('file')).toContainText('a.json');
});
