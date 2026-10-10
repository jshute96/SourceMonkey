// The typed commands that drive and read a tab's page (click, type,
// key, eval, snapshot, screenshot, savehtml, probe), driven directly
// as `sm-dev start` runs them, against a script that adds a button and a
// text field to the page and keeps its state in the scripts' world.

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/harness.js';
import { DialogTracker, runConsoleCommand, type ConsoleContext } from '../../lib/harness/console-commands.js';
import { RunLog } from '../../lib/harness/run-logs.js';

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
  // The run's log, as run.ts keeps it for `logs`.
  const logs = new RunLog();
  page.on('console', (msg) => logs.add({ source: 'script', kind: msg.type(), tab: 1, text: msg.text() }));
  const dialogs = await DialogTracker.attach(page, (t) => lines.push(`[sm-dev] ${t}`), { visible: false, commandsComing: true });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await expect(page.locator('button')).toHaveText('Add one');

  const tabs = [{ n: 1, page, link: attachment, dialogs, targetId: 'ABCDEF0123456789' }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined, logs };
  const run = async (line: string, cwd?: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx, { cwd });
    return [...lines];
  };

  // The selected script by default, where its state is, and the page's
  // world with --page.
  expect(await run('eval document.title')).toEqual(['"target"']);
  expect(await run('eval widget')).toEqual(['{\n  "clicks": 0\n}']);
  expect(await run('eval --page typeof widget')).toEqual(['"undefined"']);
  expect(await run('eval --script widget')).toEqual(['{\n  "clicks": 0\n}']);
  expect(await run('eval --page --script 1')).toEqual(['[sm-dev] ERROR: The eval command takes --page or --script, not both']);
  // Inside the script: its GM_* bindings and top-level declarations.
  expect(await run('eval GM_info.script.name')).toEqual(['"Widget"']);
  expect(await run('eval --script=Widget button.textContent')).toEqual(['"Add one"']);
  expect(await run('eval --script=1 typeof GM_log')).toEqual(['"function"']);
  expect(await run('eval --page typeof button')).toEqual(['"undefined"']);
  // Function-body code (await, return) runs there too.
  expect(await run('eval --script await 0; return input.getAttribute("aria-label")')).toEqual(['"Note"']);
  // An awaited expression is the value, as in the console.
  expect(await run('eval --script await Promise.resolve(button.localName)')).toEqual(['"button"']);
  expect(await run('eval --script missing')).toEqual(['[sm-dev] The expression threw: ReferenceError: missing is not defined']);
  expect(await run('eval --script=nope 1')).toEqual(['[sm-dev] No loaded script matches nope. Use scripts to list them.']);
  expect(await run('eval --script= 1')).toEqual(['[sm-dev] ERROR: The --script flag needs a value: --script=<script>']);
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
  // The id as `tabs` shows it names the tab.
  expect(await run('eval [targetId=ABCDEF0123456789] document.title')).toEqual(['"target"']);
  expect(await run('hover button')).toEqual(['[sm-dev] Hovered over button']);
  expect(await run('hover button --modifiers Shift --at 2,2')).toEqual(['[sm-dev] Hovered over button with Shift held, the mouse at 2,2 in it']);
  // A command that failed is false, so a line of several stops there.
  expect(await runConsoleCommand('click \'#nothing\'', ctx)).toBe(false);
  expect(await runConsoleCommand('eval nothing.here', ctx)).toBe(false);
  expect(await runConsoleCommand('eval 1', ctx)).not.toBe(false);

  expect(await run('type \'input[aria-label=Note]\' \'hello world\'')).toEqual(['[sm-dev] Typed into input[aria-label=Note]']);
  expect(await run('key Backspace Backspace')).toEqual(['[sm-dev] Pressed Backspace, Backspace']);
  // --clear empties the field first, or only empties it.
  expect(await run('type \'input[aria-label=Note]\' --clear bye')).toEqual(['[sm-dev] Cleared and typed into input[aria-label=Note]']);
  expect(await page.inputValue('input[aria-label=Note]')).toBe('bye');
  expect(await run('type \'input[aria-label=Note]\' --clear')).toEqual(['[sm-dev] Cleared input[aria-label=Note]']);
  expect(await page.inputValue('input[aria-label=Note]')).toBe('');
  expect(await run('type \'input[aria-label=Note]\' \'hello world\'')).toEqual(['[sm-dev] Typed into input[aria-label=Note]']);
  await run('key Backspace Backspace');
  expect(await run('key Nope')).toEqual(['[sm-dev] The key command failed: Nope is not a key name. Keys are named as in Enter, ArrowLeft, Shift+Tab (case-insensitive), or a single character.']);
  expect(await run('key Shift+')).toEqual(['[sm-dev] ERROR: Shift+ has a + with no key on one side. Join keys with +, as in Shift+Tab.']);
  // Through the keys alias, case-insensitive.
  expect(await run('keys end shift+home')).toEqual(['[sm-dev] Pressed End, Shift+Home']);
  expect(await run('eval document.querySelector("input").value')).toEqual(['"hello wor"']);
  // Several lines as a block, exactly: spaces kept, each line break an
  // Enter. From a file, as it is. The flag and selector
  // are on the command's line; a flag-like word in the text is text.
  await page.evaluate(() => { const t = document.createElement('textarea'); t.id = 'notes'; document.body.append(t); });
  const notes = 'eval document.querySelector("#notes").value';
  expect(await run('type #notes\n--nowait first  line\nend')).toEqual(['[sm-dev] Typed into #notes']);
  expect(await run(notes)).toEqual(['"--nowait first  line\\nend"']);
  writeFileSync(path.join(scriptsDir.path, 'notes.txt'), 'a\r\nb\r\n');
  expect(await run('type --file notes.txt #notes', scriptsDir.path)).toEqual(['[sm-dev] Typed into #notes']);
  expect(await run(notes)).toEqual(['"--nowait first  line\\nenda\\nb\\n"']);
  // Spaces and a blank line at the end are typed too.
  expect(await run('type #notes\n  \n')).toEqual(['[sm-dev] Typed into #notes']);
  expect(await run(notes)).toEqual(['"--nowait first  line\\nenda\\nb\\n  \\n"']);
  expect(await run('type\n#notes x')).toEqual(['[sm-dev] ERROR: The type command takes one selector before {{. Quote a selector that has spaces.']);
  expect(await run('type #notes --file notes.txt\nx', scriptsDir.path)).toEqual(['[sm-dev] ERROR: The type command takes text or --file, not both']);
  expect(await run('type #notes --file nope.txt', scriptsDir.path)).toEqual(['[sm-dev] ERROR: Couldn\'t read nope.txt: The file does not exist']);
  expect(await run('type #notes --file')).toEqual(['[sm-dev] ERROR: The --file flag needs a value: --file <path>']);
  expect(await run('type --file notes.txt')).toEqual(['[sm-dev] ERROR: The type command takes a selector and one file, e.g. type \'#notes\' --file notes.txt']);
  expect(await run('type #notes b\nc')).toEqual(['[sm-dev] ERROR: The type command takes one selector before {{. Quote a selector that has spaces.']);
  await page.evaluate(() => document.querySelector('#notes')!.remove());

  const tree = await run('snapshot');
  expect(tree.some((l) => /^  - button "Added 1" \[ref=e\d+\]$/.test(l))).toBe(true);
  expect(tree.some((l) => l.includes('textbox "Note"'))).toBe(true);
  expect(await run('snapshot button')).toEqual([expect.stringMatching(/^- button "Added 1" \[ref=e\d+\]$/)]);

  // Files are named from the directory given, as `sm-dev <command>` gives
  // the sender's.
  const dir = scriptsDir.path;
  expect(await run('snapshot --out tree.txt T1', dir)).toEqual([expect.stringMatching(/^\[sm-dev\] Wrote tree\.txt \(\d+ lines\) from http/)]);
  expect(readFileSync(path.join(dir, 'tree.txt'), 'utf8')).toContain('button "Added 1"');
  // A long eval result is cut when printed, and written whole with --out.
  const long = await run('eval "x".repeat(12000)');
  expect(long).toEqual([expect.stringMatching(/^"x{9999}\.\.\. \(12002 chars; eval --out FILE writes it all\)$/)]);
  expect(await run('eval --out long.json "x".repeat(12000)', dir)).toEqual(['[sm-dev] Wrote long.json (12002 chars)']);
  expect(readFileSync(path.join(dir, 'long.json'), 'utf8')).toBe(`"${'x'.repeat(12000)}"\n`);
  // Code written as a function body: its `return` is the value.
  expect(await run('eval const n = 2; return n * 3')).toEqual(['6']);
  expect(await run('eval await 0; return document.title')).toEqual(['"target"']);
  // Thrown as it ran, not as it compiled: not run again.
  expect(await run('eval window.runs = (window.runs ?? 0) + 1; eval("return 1")')).toEqual(['[sm-dev] The expression threw: SyntaxError: Illegal return statement']);
  expect(await run('eval runs')).toEqual(['1']);
  // A file's JavaScript, the flags in either order, and a trailing
  // comment kept off the wrapper's closing.
  writeFileSync(path.join(dir, 'probe.js'), 'const c = widget.clicks;\nreturn { c } // done');
  expect(await run('eval --file probe.js --script', dir)).toEqual(['{\n  "c": 1\n}']);
  expect(await run('eval --script T1 --file probe.js', dir)).toEqual(['{\n  "c": 1\n}']);
  expect(await run('eval --file nope.js', dir)).toEqual(['[sm-dev] ERROR: Couldn\'t read nope.js: The file does not exist']);
  expect(await run('eval --file probe.js 1 + 1', dir)).toEqual(['[sm-dev] ERROR: The eval command takes JavaScript or --file, not both']);
  expect(await run('eval --file', dir)).toEqual(['[sm-dev] ERROR: The --file flag needs a value: --file <path>']);
  expect(await run('eval --file --script', dir)).toEqual(['[sm-dev] ERROR: The --file flag needs a value: --file <path>']);
  expect(await run('eval --file probe.js --file probe.js', dir)).toEqual(['[sm-dev] ERROR: The --file flag can be given once']);
  mkdirSync(path.join(dir, 'probes'));
  expect(await run('eval --file probes', dir)).toEqual(['[sm-dev] ERROR: Couldn\'t read probes: It\'s a folder']);
  writeFileSync(path.join(dir, 'blank.js'), '\n');
  expect(await run('eval --file blank.js', dir)).toEqual(['[sm-dev] ERROR: The file blank.js is empty']);
  // Sent from another shell, as `sm-dev eval --file probe.js` does.
  lines.length = 0;
  await runConsoleCommand('eval --file probe.js --script', ctx, { cwd: dir, words: ['eval', '--file', 'probe.js', '--script'] });
  expect(lines).toEqual(['{\n  "c": 1\n}']);
  expect(await run('screenshot button b.png', dir)).toEqual([expect.stringMatching(/^\[sm-dev\] Wrote b\.png \(button\) from http/)]);
  expect(statSync(path.join(dir, 'b.png')).size).toBeGreaterThan(0);
  expect(await run('screenshot --full whole.png', dir)).toEqual([expect.stringMatching(/^\[sm-dev\] Wrote whole\.png from http/)]);
  expect(await run('screenshot button', dir)).toEqual(['[sm-dev] ERROR: The screenshot command writes a .png or .jpg file, and button is neither. Name the file last.']);
  expect(await run('savehtml nowhere/x.html', dir)).toEqual(['[sm-dev] The savehtml command failed: Could not write nowhere/x.html: Its folder doesn\'t exist']);
  const saved = await run('savehtml page.html', dir);
  expect(saved[0]).toMatch(/^\[sm-dev\] Wrote page\.html \(\d+ chars\) from http/);
  // A scripted tab's HTML has the script's changes, and says so.
  expect(saved[1]).toContain('It has the scripts\' changes in it');
  expect(readFileSync(path.join(dir, 'page.html'), 'utf8')).toContain('Added 1');

  expect(await run('probe main \'.missing\'')).toEqual(['found    main  (1)', 'missing  .missing']);
  expect(await run('probe main --html')).toEqual(['found    main  (1)', '    html: <main id="target">original content</main>']);
  // Both, paired for each match: the first ten, each on one line.
  expect(await run('probe main --html --css')).toEqual(['found    main  (1)', '    selector: #target', '    html: <main id="target">original content</main>']);
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', Array.from({ length: 12 }, (_, i) => `<i title="n${i}">\n  ${i}\n</i>`).join('')));
  expect(await run('probe i --css --html')).toEqual([
    'found    i  (12)',
    ...Array.from({ length: 10 }, (_, i) => [`    selector: i[title="n${i}"]`, `    html: <i title="n${i}"> ${i} </i>`]).flat(),
    '    (2 more)',
  ]);
  await page.evaluate(() => document.querySelectorAll('i').forEach((i) => i.remove()));
  // Quotes inside a selector are its own.
  expect(await run('probe css=main[id="target"] main[id=\'target\']')).toEqual(['found    css=main[id="target"]  (1)', 'found    main[id=\'target\']  (1)']);
  expect(await run('logs')).toContainEqual(expect.stringMatching(/^\d\d:\d\d:\d\d\.\d{3} T1 \[script log\] \[widget\] hovered$/));
  expect(await run('probe \'a[b\'')).toEqual(['invalid  a[b  (It isn\'t a valid selector)']);

  // A click that opens a dialog returns once it's up, so accept can
  // answer it, and the page commands wait until it has.
  const clicked = await run('click \'#warn\'');
  expect(clicked).toContain('[sm-dev] Clicked #warn. It opened a dialog, which is waiting for an answer.');
  expect(await run('eval 1')).toEqual(['[sm-dev] The page is waiting on an alert dialog. Use accept or dismiss first.']);
  expect(await run('accept')).toEqual(['[sm-dev] Accepted the dialog']);
  expect(await run('eval 1')).toEqual(['1']);
  expect(await run('eval confirm("sure?")')).toContain('[sm-dev] The expression opened a dialog, which is waiting for an answer.');
  expect(await run('dismiss')).toEqual(['[sm-dev] Dismissed the dialog']);
  expect(await run('screenshot')).toEqual([expect.stringContaining('The screenshot command needs a file')]);
  expect(await run('snapshot --deep')).toEqual(['[sm-dev] ERROR: The snapshot command has no --deep flag. It takes --visible, --out, --find, --up, --context, --limit, --timeout-seconds, --frame.']);
  // Every command, not only the ones with flags of their own; a quoted
  // selector with -- in it is one word, not a flag.
  expect(await run('status --bad')).toEqual(['[sm-dev] ERROR: The status command has no --bad flag. It takes --frames, --json, --nojson.']);
  expect(await run('eval T1 --script --x')).toEqual(['[sm-dev] ERROR: The eval command has no --x flag. It takes --page, --script, --file, --out, --timeout-seconds, --frame.']);
  expect(await run(`probe '.a --b'`)).not.toContainEqual(expect.stringContaining('flag'));

  // A navigation an expression doesn't live through is said as such,
  // not blamed on the expression.
  expect(await run('eval setTimeout(() => location.reload(), 50), new Promise(() => {})')).toEqual([
    '[sm-dev] The page navigated away before the expression finished',
  ]);
  await expect(page.locator('button')).toHaveText('Add one');

  // Raw CDP on the same tab: each result as JSON, stopping at a failure.
  expect(await run('cdp Runtime.evaluate \'{"expression": "document.title", "returnByValue": true}\'')).toEqual([
    JSON.stringify({ result: { type: 'string', value: 'target' } }, null, 2),
  ]);
  expect(await run('cdp T1 Target.getTargetInfo')).toEqual([expect.stringContaining('"type": "page"')]);
  expect(await run('cdp Nope.nothing')).toEqual([expect.stringMatching(/^\[sm-dev\] Nope\.nothing failed: /)]);
  expect(await run('cdp nope')).toEqual([expect.stringContaining('nope is not a CDP method')]);
  expect(await run('cdp Page.enable Page.reload')).toEqual([expect.stringContaining('A cdp command makes one call')]);
  // A block's calls share a session, so an override one sets holds for
  // the next; it ends with the command.
  const dark = '{"expression": "matchMedia(\'(prefers-color-scheme: dark)\').matches", "returnByValue": true}';
  expect(await run(`cdp T1\nEmulation.setEmulatedMedia {"features": [{"name": "prefers-color-scheme", "value": "dark"}]}\nRuntime.evaluate ${dark}`)).toEqual([
    '{}', JSON.stringify({ result: { type: 'boolean', value: true } }, null, 2),
  ]);
  // Undone as the block's session detaches, which Chrome finishes a
  // moment after.
  await expect.poll(() => run(`cdp Runtime.evaluate ${dark}`)).toEqual([JSON.stringify({ result: { type: 'boolean', value: false } }, null, 2)]);
  // A call cut off by the page loading a new document succeeds; a later
  // call's own failure still fails, the navigation being over by then.
  expect(await runConsoleCommand('cdp Runtime.evaluate {"expression": "new Promise(() => location.reload())", "awaitPromise": true}', ctx)).not.toBe(false);
  await expect(page.locator('button')).toHaveText(/Add one|Added/);
  expect(await runConsoleCommand('cdp\nPage.reload\nNope.nothing', ctx)).toBe(false);
  await expect(page.locator('button')).toHaveText(/Add one|Added/);
  // The same calls from a file.
  writeFileSync(path.join(scriptsDir.path, 'calls.txt'), 'Runtime.evaluate {"expression": "1 + 1"}\nRuntime.evaluate {"expression": "2 + 2"}\n');
  expect(await run('cdp --file calls.txt', scriptsDir.path)).toEqual([
    JSON.stringify({ result: { type: 'number', value: 2, description: '2' } }, null, 2),
    JSON.stringify({ result: { type: 'number', value: 4, description: '4' } }, null, 2),
  ]);
  expect(await run('cdp --file calls.txt Page.reload', scriptsDir.path)).toEqual([expect.stringContaining('not both')]);
  expect(await run('cdp --file')).toEqual(['[sm-dev] ERROR: The --file flag needs a value: --file <path>']);
  // A dialog a call opens stops the wait, and says so.
  expect(await run('cdp Runtime.evaluate {"expression": "alert(1)"}')).toContain('[sm-dev] Runtime.evaluate opened a dialog, which is waiting for an answer.');
  expect(await run('accept')).toEqual(['[sm-dev] Accepted the dialog']);

  // Enter submitting a form: the command returns once the next page is
  // there, so the next command sees it.
  expect(await run('type \'input[name=q]\' kittens')).toEqual(['[sm-dev] Typed into input[name=q]']);
  expect(await run('key Enter')).toEqual(['[sm-dev] Pressed Enter']);
  expect(await run('eval --page location.pathname + location.search')).toEqual(['"/other.html?q=kittens"']);
});

test('a tab closing mid-expression is said as such', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  const script = await loadScript({ relativePath: 'idle.user.js', meta: { name: 'Idle', match: ['*://*/target.html'] }, body: '' });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const pending = runConsoleCommand('eval --page new Promise(() => {})', ctx);
  await new Promise((r) => setTimeout(r, 200));
  await page.close();
  await pending;
  expect(lines).toEqual(['[sm-dev] The tab closed before the expression finished']);
});

test('eval --script reaches a MAIN-world script and a script\'s IIFE, keeps strictness, and says when a script hasn\'t run', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  const main = await loadScript({
    relativePath: 'main.user.js',
    meta: { name: 'Main', match: ['*://*/target.html'], grant: ['none'] },
    body: '"use strict";\nconst strict = (function () { return this; })() === undefined;\nlet count = 1;',
  });
  const other = await loadScript({ relativePath: 'other.user.js', meta: { name: 'Other', match: ['*://*/other.html'], grant: ['GM_log'] }, body: 'window.otherRan = true;' });
  const iife = await loadScript({
    relativePath: 'iife.user.js',
    meta: { name: 'Iife', match: ['*://*/target.html'], grant: ['GM_log'] },
    body: '(function () {\n  \'use strict\';\n  const hidden = \'inside\';\n})();',
  });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await expect.poll(() => host.reports.started.length).toBe(2);
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [main, other, iife], out: (l) => lines.push(l), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx);
    return [...lines];
  };
  expect(await run('eval --script strict')).toEqual(['true']);
  // An assignment reaches the script's own let.
  expect(await run('eval --script count += 1')).toEqual(['2']);
  expect(await run('eval --script count')).toEqual(['2']);
  // Inside the script's IIFE, with its GM_* bindings still in reach.
  expect(await run('eval --script=Iife hidden + " " + typeof GM_log')).toEqual(['"inside function"']);
  // Other didn't match the page: selected, a bare eval runs in the
  // page, and --script in the shared world; named, that's a failure.
  ctx.current = other;
  expect(await run('eval typeof count')).toEqual([
    '[sm-dev] Other hasn\'t run on this page, so this ran in the page',
    '"undefined"',
  ]);
  expect(await run('eval --script document.title')).toEqual([
    '[sm-dev] Other hasn\'t run on this page, so this ran in the scripts\' shared world',
    '"target"',
  ]);
  expect(await run('eval --script=Other 1')).toEqual(['[sm-dev] Other hasn\'t run on this page, so its scope can\'t be reached. Load a page it matches, or reload this one.']);
  expect(await runConsoleCommand('eval --script=Other 1', ctx)).toBe(false);
});

test('eval --script reaches a page-world script on a page whose CSP forbids eval', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  const main = await loadScript({ relativePath: 'csp.user.js', meta: { name: 'Csp', match: ['*://*/strict-script-csp.html'], grant: ['none'] }, body: 'const here = 1;' });
  await page.goto(`${fixtureServer.baseUrl}/strict-script-csp.html`);
  await expect.poll(() => host.reports.started.length).toBe(1);
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [main], out: (l) => lines.push(l), stop: () => undefined };
  // The hook's eval runs inside a CDP evaluation, which Chrome exempts
  // from the page's policy.
  await runConsoleCommand('eval --script here', ctx);
  expect(lines).toEqual(['1']);
});

test('click takes a button, modifiers and a count, and says which check its element failed', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  const script = await loadScript({ relativePath: 'idle.user.js', meta: { name: 'Idle', match: ['*://*/target.html'] }, body: '' });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'Press';
    // Each mouse event it gets: its type, button, click count and Shift.
    (window as unknown as { seen: string[] }).seen = [];
    for (const type of ['click', 'dblclick', 'auxclick', 'contextmenu']) {
      button.addEventListener(type, (e) => {
        const m = e as MouseEvent;
        (window as unknown as { seen: string[] }).seen.push(`${type} ${m.button} ${m.detail}${m.shiftKey ? ' shift' : ''}`);
        e.preventDefault();
      });
    }
    document.body.append(button);
  });
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx);
    return [...lines];
  };
  const seen = async () => page.evaluate(() => (window as unknown as { seen: string[] }).seen.splice(0));

  expect(await run('click --button right button')).toEqual(['[sm-dev] Clicked button with the right button']);
  expect(await seen()).toEqual(['contextmenu 2 0', 'auxclick 2 1']);
  expect(await run('click T1 button --count 2 --modifiers shift')).toEqual(['[sm-dev] Clicked button with Shift held, 2 clicks']);
  expect(await seen()).toEqual(['click 0 1 shift', 'click 0 2 shift', 'dblclick 0 2 shift']);
  expect(await run('click button --button back')).toEqual(['[sm-dev] ERROR: back is not a mouse button. Use left, right or middle.']);

  // Covered, it says by what, rather than listing what it might be.
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="over" style="position:fixed;inset:0"></div>'));
  expect(await run('click button')).toEqual(['[sm-dev] The click command failed: The element stayed covered for 5 seconds, by <div id="over"></div>']);
  // --timeout-seconds in place of each wait's default.
  expect(await run('click button --timeout-seconds 0.5')).toEqual(['[sm-dev] The click command failed: The element stayed covered for 0.5 seconds, by <div id="over"></div>']);
  expect(await run('cdp Runtime.evaluate {"expression": "new Promise(() => {})", "awaitPromise": true} --timeout-seconds 0.5')).toEqual([
    '[sm-dev] Runtime.evaluate got no answer within 0.5s. A paused page never answers.',
  ]);
  expect(await run('click button --timeout-seconds soon')).toEqual([expect.stringMatching(/^\[sm-dev\] ERROR: The --timeout-seconds flag needs a number of seconds/)]);
  // A page too busy to be captured. (The file would be written, were it.)
  await page.evaluate(() => setTimeout(() => {
    const until = Date.now() + 3000;
    while (Date.now() < until);
  }, 0));
  expect(await run(`screenshot ${path.join(test.info().outputDir, 'busy.png')} --timeout-seconds 0.5`)).toEqual([
    '[sm-dev] Screenshot failed: Browser did not capture the page within 0.5s',
  ]);
});

test('an Escape that leaves the page fullscreen says how to exit', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  const script = await loadScript({
    relativePath: 'full.user.js',
    meta: { name: 'Full', match: ['*://*/target.html'], grant: ['none'] },
    body: `
      addEventListener('keydown', (e) => {
        if (e.key === 'f') document.querySelector('main').requestFullscreen();
        // Escape ends it here once asked to, as some pages do themselves.
        if (e.key === 'Escape' && window.exitOnEscape) document.exitFullscreen();
      });
    `,
  });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx);
    return [...lines];
  };
  const stillFullscreen = '[sm-dev] The page is still fullscreen. Escape sent by sm-dev goes to the page rather than to Chrome. To exit, use eval document.exitFullscreen().';

  // Not fullscreen: Escape is just a key, even with a later key entering it.
  expect(await run('key Escape')).toEqual(['[sm-dev] Pressed Escape']);
  expect(await run('key Escape f')).toEqual(['[sm-dev] Pressed Escape, f']);
  expect(await run('eval document.fullscreenElement')).toEqual(['main#target']);
  // The key reaches the page, and fullscreen stays.
  expect(await run('key esc')).toEqual(['[sm-dev] Pressed Escape', stillFullscreen]);
  expect(await run('key Shift+Escape')).toEqual(['[sm-dev] Pressed Shift+Escape', stillFullscreen]);
  expect(await run('eval document.exitFullscreen()')).toEqual(['undefined']);
  // A page that leaves fullscreen on Escape itself gets no note.
  await run('eval window.exitOnEscape = true');
  await run('key f');
  expect(await run('key Escape')).toEqual(['[sm-dev] Pressed Escape']);
  expect(await run('eval document.fullscreenElement')).toEqual(['null']);
});

test('snapshot refs name elements for the other commands, and it can show only the screen; probe --css gives selectors', async ({ page, fixtureServer, host, attachment, loadScript, scriptsDir }) => {
  const script = await loadScript({ relativePath: 'idle.user.js', meta: { name: 'Idle', match: ['*://*/target.html'] }, body: '' });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', `
      <nav><button data-testid="save">Save</button><input aria-label="Note"></nav>
      <div style="height: 3000px"></div>
      <button class="far">Far away</button>`);
    document.querySelector('[data-testid=save]')!.addEventListener('click', (e) => { (e.target as HTMLElement).dataset.clicked = 'yes'; });
  });
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const run = async (line: string, cwd?: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx, { cwd });
    return [...lines];
  };
  const refIn = (tree: string[], text: string): string => /\[ref=(\w+)\]/.exec(tree.find((l) => l.includes(text))!)![1];

  expect(await run('click e1')).toEqual(['[sm-dev] This tab has no snapshot yet. Take one with snapshot.']);
  const tree = await run('snapshot');
  const save = refIn(tree, 'button "Save"');
  const note = refIn(tree, 'textbox "Note"');
  const far = refIn(tree, 'button "Far away"');

  // A snapshot of part of the page leaves the rest's refs working.
  expect(await run('snapshot nav')).toHaveLength(3);
  expect(await run(`click ${save}`)).toEqual([`[sm-dev] Clicked ${save} (button "Save")`]);
  expect(await page.locator('[data-testid=save]').getAttribute('data-clicked')).toBe('yes');
  expect(await run(`type [ref=${note}] hello`)).toEqual([`[sm-dev] Typed into [ref=${note}] (textbox "Note")`]);
  await expect(page.locator('input[aria-label=Note]')).toHaveValue('hello');
  expect(await run(`hover ref=${far}`)).toEqual([`[sm-dev] Hovered over ref=${far} (button "Far away")`]);
  expect(await run(`probe ${save} e9999`)).toEqual([`found    ${save}  (1)`, 'missing  e9999']);
  expect(await run(`snapshot ${save}`)).toEqual([`- button "Save" [ref=${save}]`]);
  expect(await run(`screenshot ${save} save.png`, scriptsDir.path)).toEqual([expect.stringMatching(/^\[sm-dev\] Wrote save\.png \(e\d+ \(button "Save"\)\) from http/)]);
  expect(await run('click e9999')).toEqual(['[sm-dev] No element has the ref e9999. Take a new snapshot for the page\'s refs.']);

  // Only what's on screen: the far button is below it, until scrolled to.
  await page.evaluate(() => window.scrollTo(0, 0));
  const visible = await run('snapshot --visible');
  expect(visible.some((l) => l.includes('button "Save"'))).toBe(true);
  expect(visible.some((l) => l.includes('Far away'))).toBe(false);
  expect(visible.join('\n')).not.toContain('[box=');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const scrolled = await run('snapshot --visible');
  expect(scrolled.some((l) => l.includes('Far away'))).toBe(true);
  expect(scrolled.some((l) => l.includes('button "Save"'))).toBe(false);

  // probe --css: a selector for a ref's element, or one per match.
  const selectorOf = async (selector: string): Promise<string> => (await run(`probe --css '${selector}'`))[1].replace('    selector: ', '');
  expect(await run(`probe --css ${save}`)).toEqual([`found    ${save}  (1)`, '    selector: button[data-testid="save"]']);
  expect(await selectorOf(refIn(scrolled, 'Far away'))).toBe('button.far');
  expect(await selectorOf('input[aria-label=Note]')).toBe('input');
  expect(await run('snapshot --css')).toEqual(['[sm-dev] ERROR: The snapshot command has no --css flag. It takes --visible, --out, --find, --up, --context, --limit, --timeout-seconds, --frame.']);

  // Refs reach into a frame and a shadow root, where selectors are
  // suggested for neither; and look-alike buttons get told apart.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('afterbegin', '<button>Twin</button><button>Twin</button><div id="host"></div><iframe srcdoc="<button onclick=&quot;this.textContent=\'Hit\'&quot;>In frame</button>"></iframe>');
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadowed</button>';
  });
  await expect(page.frameLocator('iframe').locator('button')).toHaveText('In frame');
  const twins = await run('probe --css \'body > button:nth-of-type(-n+2)\'');
  expect(twins[0]).toBe('found    body > button:nth-of-type(-n+2)  (2)');
  const [first, second] = twins.slice(1).map((l) => l.replace('    selector: ', ''));
  expect(first).not.toBe(second);
  for (const [i, css] of [first, second].entries()) {
    expect(await page.locator(css).count()).toBe(1);
    expect(await page.locator(css).evaluate((el, n) => el === document.querySelectorAll('body > button')[n], i)).toBe(true);
  }
  const more = await run('snapshot');
  const inFrame = refIn(more, 'In frame');
  expect(await run(`probe --css ${inFrame} ${refIn(more, 'Shadowed')}`)).toEqual([
    `found    ${inFrame}  (1)`, '    selector: (none: in a frame)',
    `found    ${refIn(more, 'Shadowed')}  (1)`, '    selector: (none: in a shadow root)',
  ]);
  expect(await run(`click ${inFrame}`)).toEqual([`[sm-dev] Clicked ${inFrame} (button "In frame")`]);
  await expect(page.frameLocator('iframe').locator('button')).toHaveText('Hit');
  expect(await run(`click ${refIn(more, 'Shadowed')}`)).toEqual([`[sm-dev] Clicked ${refIn(more, 'Shadowed')} (button "Shadowed")`]);

  // A load takes the snapshot's refs with the old document; a route
  // change within the page doesn't.
  await page.evaluate(() => history.pushState({}, '', '#elsewhere'));
  expect(await run(`probe ${save}`)).toEqual([`found    ${save}  (1)`]);
  await page.reload();
  expect(await run(`click ${save}`)).toEqual(['[sm-dev] The page reloaded since the last snapshot. Take a new snapshot.']);
});

test('snapshot shows each of a selector\'s matches, and --find the elements containing text', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  const script = await loadScript({ relativePath: 'idle.user.js', meta: { name: 'Idle', match: ['*://*/target.html'] }, body: '' });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await page.evaluate(() => {
    document.body.innerHTML = `
      <ul>${[1, 2, 3, 4, 5, 6, 7].map((n) => `<li class="item"><div><a href="/${n}">Item <span class="n">${n}</span></a></div></li>`).join('')}</ul>
      <p>Total <b class="price">$5</b> [draft]</p>
      <div style="display: none" class="gone">Hidden</div>`;
  });
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx);
    return [...lines];
  };

  // The first 5 matches, numbered, and a count of them all.
  const items = await run('snapshot .item');
  expect(items.filter((l) => l.startsWith('# Match'))).toHaveLength(5);
  expect(items.at(-1)).toBe('# Showed 5 of 7 matches. --limit 0 shows all.');
  expect((await run('snapshot .item --limit 0')).filter((l) => l.startsWith('# Match'))).toHaveLength(7);

  // A match that is only text shows as the element the tree folds it into.
  expect(await run('snapshot .price')).toEqual(['- paragraph [ref=' + /ref=(\w+)/.exec((await run('snapshot p'))[0])![1] + ']: Total $5 [draft]']);
  expect(await run('snapshot .gone')).toEqual(['[sm-dev] No selector match is in the accessibility tree, which leaves out hidden elements']);

  // --find: the link containing the text, any case, a [bracketed] name
  // included; within a selector's matches; with its containers.
  const link = await run('snapshot --find \'ITEM 3\'');
  expect(link[0]).toMatch(/^- link "Item 3" \[ref=e\d+\]:$/);
  expect(await run('snapshot --find draft')).toHaveLength(1);
  expect(await run('snapshot .gone --find item')).toEqual(['[sm-dev] No element in the selector\'s matches contains "item"']);
  expect((await run('snapshot .item --find item --limit 0')).filter((l) => l.startsWith('# Match'))).toHaveLength(7);
  const some = await run('snapshot .item --find item --limit 2');
  expect(some.filter((l) => l.startsWith('# Match'))).toHaveLength(2);
  expect(some.at(-1)).toBe('# Showed 2 matches. 5 more selector matches were not searched for find matches. --limit 0 shows all.');
  expect((await run('snapshot --find \'item 3\' --up 1'))[0]).toMatch(/^- listitem \[ref=/);
  expect((await run('snapshot --find \'item 3\' --up 2'))[0]).toMatch(/^- list \[ref=/);
  expect((await run('snapshot --find \'item 3\' --context'))[0]).toMatch(/^- listitem \[ref=/);

  // Refs from a part work, beside the rest's.
  const ref = /ref=(\w+)/.exec(link[0])![1];
  expect(await run(`probe ${ref}`)).toEqual([`found    ${ref}  (1)`]);
  expect(await run('snapshot --up 1')).toEqual(['[sm-dev] ERROR: The --up flag goes with a selector or --find']);
});

test('snapshot shows a panel added after <body>, and refs from a snapshot of it work', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  const script = await loadScript({ relativePath: 'idle.user.js', meta: { name: 'Idle', match: ['*://*/target.html'] }, body: '' });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  // As scripts often add a panel: on <html>, in an open shadow root.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button onclick="this.textContent=\'Body hit\'">In body</button>');
    const panel = document.createElement('div');
    panel.id = 'panel';
    panel.attachShadow({ mode: 'open' }).innerHTML = '<div><button onclick="this.textContent=\'Hit\'">Panel button</button></div>';
    document.documentElement.append(panel);
  });
  const lines: string[] = [];
  const tabs = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx);
    return [...lines];
  };
  const refIn = (tree: string[], text: string): string => /\[ref=(\w+)\]/.exec(tree.find((l) => l.includes(text))!)![1];

  // The whole page: <body> unindented as before, and the panel after it.
  const tree = await run('snapshot');
  expect(tree[0]).toMatch(/^- generic \[active\] \[ref=\w+\]:$/);
  expect(tree.some((l) => /^- button "Panel button" \[ref=\w+\]$/.test(l))).toBe(true);
  // Named, it is the same.
  expect(await run('snapshot html')).toEqual(tree);

  // A ref from a snapshot of the panel alone works, and so does one
  // from the whole page's.
  const panel = refIn(await run('snapshot #panel'), 'Panel button');
  expect(await run(`click ${panel}`)).toEqual([`[sm-dev] Clicked ${panel} (button "Panel button")`]);
  await expect(page.locator('#panel button')).toHaveText('Hit');
  const body = refIn(tree, 'In body');
  expect(await run(`click ${body}`)).toEqual([`[sm-dev] Clicked ${body} (button "In body")`]);
  await expect(page.locator('body > button')).toHaveText('Body hit');
});

test('click and hover say when the mouse can\'t reach the point', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  test.setTimeout(60_000);
  const script = await loadScript({
    relativePath: 'panel.user.js',
    meta: { name: 'Panel', match: ['*://*/target.html'] },
    // A slide-out panel showing 14 of its 164 pixels, and one entirely off the page.
    body: `
      const panel = document.createElement('div');
      panel.id = 'panel';
      panel.style.cssText = 'position:fixed;left:-150px;top:20px;width:164px;height:40px;background:#ccc';
      const gone = document.createElement('div');
      gone.id = 'gone';
      gone.style.cssText = 'position:fixed;left:-500px;top:20px;width:100px;height:40px;background:#ccc';
      document.body.append(panel, gone);
    `,
  });
  const lines: string[] = [];
  const dialogs = await DialogTracker.attach(page, (t) => lines.push(`[sm-dev] ${t}`), { visible: false, commandsComing: true });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  await expect(page.locator('#panel')).toHaveCount(1);
  const tabs = [{ n: 1, page, link: attachment, dialogs, targetId: 'ABCDEF0123456789' }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
  const run = async (line: string) => {
    lines.length = 0;
    await runConsoleCommand(line, ctx);
    return [...lines];
  };

  expect(await run('hover #panel --at 155,20')).toEqual(['[sm-dev] Hovered over #panel with the mouse at 155,20 in it']);
  expect(await run('click #panel --at 300,20')).toEqual(['[sm-dev] The click command failed: The point 300,20 is outside the element, which is 164x40 pixels (--at counts from its top left corner)']);
  expect(await run('click #panel --at 10,20')).toEqual(['[sm-dev] The click command failed: The point 10,20 in the element is outside the 800x600 window, at -140,40, so pick a point in the element\'s visible part']);
  // Playwright's own reason stands when it gives one.
  expect(await run('hover #gone')).toEqual(['[sm-dev] The hover command failed: The element stayed outside the viewport for 5 seconds, where it can\'t be scrolled to']);
});
