// The typed commands that drive and read a tab's page (click, type,
// key, eval, snapshot, screenshot, savehtml, probe), driven directly
// as `sm-dev run` runs them, against a script that adds a button and a
// text field to the page and keeps its state in the scripts' world.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/harness.js';
import { DialogTracker, runConsoleCommand, type ConsoleContext } from '../../lib/harness/console-commands.js';
import { recordLog } from '../../lib/harness/page-commands.js';

test('page commands drive the page and read it', async ({ page, fixtureServer, host, attachment, loadScript, scriptsDir }) => {
  const script = await loadScript({
    relativePath: 'widget.user.js',
    meta: { name: 'Widget', match: ['*://*/target.html'], grant: ['GM_log'] },
    body: `
      window.widget = { clicks: 0 };
      const button = document.createElement('button');
      button.textContent = 'Add one';
      button.addEventListener('click', () => { window.widget.clicks++; button.textContent = 'Added ' + window.widget.clicks; });
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Note');
      const warn = document.createElement('a');
      warn.id = 'warn';
      warn.textContent = 'Warn';
      warn.href = '#';
      warn.addEventListener('click', () => alert('careful'));
      const form = document.createElement('form');
      form.action = 'other.html';
      form.innerHTML = '<input name="q" aria-label="Search">';
      document.body.append(button, input, warn, form);
      button.addEventListener('mouseenter', () => console.log('[widget] hovered'));
    `,
  });
  const lines: string[] = [];
  page.on('console', (msg) => recordLog(page, `[${msg.type()}] ${msg.text()}`));
  const dialogs = await DialogTracker.attach(page, (l) => lines.push(l), { visible: false, commandsComing: true });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await expect(page.locator('button')).toHaveText('Add one');

  const tabs = [{ n: 1, page, link: attachment, dialogs, targetId: 'ABCDEF0123456789', pageId: 7 }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const run = async (line: string, cwd?: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx, { cwd });
    return [...lines];
  };

  // The page's world, and the scripts', where the script's state is.
  expect(await run('eval document.title')).toEqual(['"target"']);
  expect(await run('eval typeof widget')).toEqual(['"undefined"']);
  expect(await run('eval --script widget')).toEqual(['{\n  "clicks": 0\n}']);
  expect(await run('eval document.querySelector("main")')).toEqual(['main#target']);
  expect(await run('eval nothing.here')).toEqual(['[sm-dev] The expression threw: ReferenceError: nothing is not defined']);
  expect(await run('eval throw \'boom\'')).toEqual(['[sm-dev] The expression threw: "boom"']);
  // Typed JavaScript keeps its own quotes.
  expect(await run('eval "abc".length')).toEqual(['3']);
  // A promise gives what it settles to.
  expect(await run('eval new Promise((r) => setTimeout(() => r(42), 50))')).toEqual(['42']);
  expect(await run('eval Promise.reject(new Error("no"))')).toEqual(['[sm-dev] The expression threw: Error: no']);
  expect(await run('eval \'a\' + \'b\'')).toEqual(['"ab"']);
  expect(await run('eval new Map([[1, 2]])')).toEqual(['Map(1)']);
  expect(await run('eval [...document.querySelectorAll("main")]')).toEqual(['[\n  "main#target"\n]']);

  // A click the script sees, with the tab named, and the page settled
  // by the time it returns.
  expect(await run('click T1 button')).toEqual(['[sm-dev] Clicked button']);
  expect(await run('eval document.querySelector("button").textContent')).toEqual(['"Added 1"']);
  expect(await run('eval --script T1 widget.clicks')).toEqual(['1']);
  expect(await run('click \'#nothing\'')).toEqual(['[sm-dev] No element matches #nothing']);
  // The ids as `tabs` shows them name the tab.
  expect(await run('eval [targetId=ABCDEF0123456789 pageId=7] document.title')).toEqual(['"target"']);
  expect(await run('hover button')).toEqual(['[sm-dev] Hovered over button']);

  expect(await run('type \'input[aria-label=Note]\' \'hello world\'')).toEqual(['[sm-dev] Typed into input[aria-label=Note]']);
  expect(await run('key Backspace Backspace')).toEqual(['[sm-dev] Pressed Backspace, Backspace']);
  expect(await run('key Nope')).toEqual(['[sm-dev] The key command failed: Nope is not a key name. Keys are named as in Enter, ArrowLeft, Shift+Tab, or a single character.']);
  expect(await run('eval document.querySelector("input").value')).toEqual(['"hello wor"']);

  const tree = await run('snapshot');
  expect(tree).toContain('- button "Added 1"');
  expect(tree.some((l) => l.includes('textbox "Note"'))).toBe(true);
  expect(await run('snapshot button')).toEqual(['- button "Added 1"']);

  // Files are named from the directory given, as `sm-dev send` gives
  // the sender's.
  const dir = scriptsDir.path;
  expect(await run('snapshot --out tree.txt T1', dir)).toEqual([expect.stringMatching(/^\[sm-dev\] Wrote tree\.txt \(\d+ lines\) from http/)]);
  expect(readFileSync(path.join(dir, 'tree.txt'), 'utf8')).toContain('button "Added 1"');
  expect(await run('screenshot button b.png', dir)).toEqual([expect.stringMatching(/^\[sm-dev\] Wrote b\.png \(button\) from http/)]);
  expect(statSync(path.join(dir, 'b.png')).size).toBeGreaterThan(0);
  expect(await run('screenshot --full whole.png', dir)).toEqual([expect.stringMatching(/^\[sm-dev\] Wrote whole\.png from http/)]);
  expect(await run('screenshot button', dir)).toEqual(['[sm-dev] The screenshot command writes a .png or .jpg file, and button is neither. Name the file last.']);
  expect(await run('savehtml nowhere/x.html', dir)).toEqual(['[sm-dev] The savehtml command failed: Could not write nowhere/x.html: Its folder doesn\'t exist']);
  const saved = await run('savehtml page.html', dir);
  expect(saved[0]).toMatch(/^\[sm-dev\] Wrote page\.html \(\d+ chars\) from http/);
  // A scripted tab's HTML has the script's changes, and says so.
  expect(saved[1]).toContain('It has the scripts\' changes in it');
  expect(readFileSync(path.join(dir, 'page.html'), 'utf8')).toContain('Added 1');

  expect(await run('probe main \'.missing\'')).toEqual(['found    main  (1)', 'missing  .missing']);
  expect(await run('probe main --html')).toEqual(['found    main  (1)', '    <main id="target">original content</main>']);
  expect(await run('logs')).toContain('[log] [widget] hovered');
  expect(await run('probe \'a[b\'')).toEqual(['invalid  a[b  (It isn\'t a valid selector)']);

  // A click that opens a dialog returns once it's up, so accept can
  // answer it, and the page commands wait until it has.
  const clicked = await run('click \'#warn\'');
  expect(clicked).toContain('[sm-dev] Clicked #warn. It opened a dialog, which is waiting for an answer.');
  expect(await run('eval 1')).toEqual(['[sm-dev] The page is waiting on an alert dialog. Type accept or dismiss first.']);
  expect(await run('accept')).toEqual(['[sm-dev] Accepted the dialog']);
  expect(await run('eval 1')).toEqual(['1']);
  expect(await run('eval confirm("sure?")')).toContain('[sm-dev] The expression opened a dialog, which is waiting for an answer.');
  expect(await run('dismiss')).toEqual(['[sm-dev] Dismissed the dialog']);
  expect(await run('screenshot')).toEqual([expect.stringContaining('The screenshot command needs a file')]);
  expect(await run('snapshot --deep')).toEqual(['[sm-dev] The snapshot command has no --deep flag']);

  // A navigation an expression doesn't live through is said as such,
  // not blamed on the expression.
  expect(await run('eval setTimeout(() => location.reload(), 50), new Promise(() => {})')).toEqual([
    '[sm-dev] The page navigated away before the expression finished',
  ]);
  await expect(page.locator('button')).toHaveText('Add one');

  // Enter submitting a form: the command returns once the next page is
  // there, so the next command sees it.
  expect(await run('type \'input[name=q]\' kittens')).toEqual(['[sm-dev] Typed into input[name=q]']);
  expect(await run('key Enter')).toEqual(['[sm-dev] Pressed Enter']);
  expect(await run('eval location.pathname + location.search')).toEqual(['"/other.html?q=kittens"']);
});

test('a tab closing mid-expression is said as such', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  const script = await loadScript({ relativePath: 'idle.user.js', meta: { name: 'Idle', match: ['*://*/target.html'] }, body: '' });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const pending = runConsoleCommand('eval new Promise(() => {})', ctx);
  await new Promise((r) => setTimeout(r, 200));
  await page.close();
  await pending;
  expect(lines).toEqual(['[sm-dev] The tab closed before the expression finished']);
});
