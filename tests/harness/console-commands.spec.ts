// The commands typed into `sm-dev run`, driven directly: with several
// scripts loaded, `use` picks which one `get` and `set` reach, and
// `menu` fires a command by label or by its number in the list, and a
// dialog a command opens waits for a typed answer.

import { test, expect } from '../fixtures/harness.js';
import { DialogTracker, runConsoleCommand, type ConsoleContext } from '../../lib/harness/console-commands.js';

test.describe('sm-dev typed commands', () => {
  test('use picks the script values, get and set act on', async ({ page, fixtureServer, host, loadScript }) => {
    const spec = (name: string, value: string) => ({
      relativePath: `${name.toLowerCase()}.user.js`,
      meta: { name, match: ['*://*/target.html'], grant: ['GM_setValue'] },
      body: `GM_setValue('who', '${value}');`,
    });
    const first = await loadScript(spec('First', 'one'));
    const second = await loadScript(spec('Second', 'two'));
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => [host.getValue(first.spec!.id, 'who'), host.getValue(second.spec!.id, 'who')]).toEqual(['one', 'two']);

    const lines: string[] = [];
    const ctx: ConsoleContext = { host, page, scripts: [first, second], out: (l) => lines.push(l), stop: () => undefined };
    const run = async (line: string) => {
      lines.length = 0;
      await runConsoleCommand(line, ctx);
      return [...lines];
    };

    expect(await run('get who')).toEqual(['  who = "one"']);
    expect(await run('use')).toEqual(['Loaded scripts:', '* 1: First (first.user.js)', '  2: Second (second.user.js)']);
    expect(await run('use 2')).toEqual(['[sm-dev] Using Second (second.user.js) for get and set']);
    expect(await run('get who')).toEqual(['  who = "two"']);
    expect(await run('set who "changed"')).toEqual(['[sm-dev] Set who (Second)']);
    expect(host.getValue(second.spec!.id, 'who')).toBe('changed');
    expect(host.getValue(first.spec!.id, 'who')).toBe('one');
    // By exact file name, or by a piece of a name that only one has.
    expect(await run('use first.user.js')).toEqual(['[sm-dev] Using First (first.user.js) for get and set']);
    expect(await run('use cond')).toEqual(['[sm-dev] Using Second (second.user.js) for get and set']);
    expect(await run('use user.js')).toEqual(['[sm-dev] Several loaded scripts match user.js (1, 2). Name one by its number.']);
    expect(await run('use Nobody')).toEqual(['[sm-dev] No loaded script matches Nobody. Type use to list them.']);
    expect(await run('use 3')).toEqual(['[sm-dev] There is no script 3. Type use to list them.']);

    expect(await run('values')).toEqual([
      'Stored values:', '  1: First (first.user.js)', '    who = "one"', '* 2: Second (second.user.js)', '    who = "changed"',
    ]);
    expect(await run('values 1')).toEqual(['Stored values:', '  1: First (first.user.js)', '    who = "one"']);
    expect(await run('reload now')).toEqual(['[sm-dev] The reload command takes no arguments']);
  });

  test('menu lists commands by script, and fires one by number', async ({ page, fixtureServer, host, loadScript }) => {
    const script = await loadScript({
      relativePath: 'menus.user.js',
      meta: { name: 'Menus', match: ['*://*/target.html'], grant: ['GM_registerMenuCommand', 'GM_setValue'] },
      body: `GM_registerMenuCommand('Say one', () => GM_setValue('said', 1));
        GM_registerMenuCommand('Say two', () => GM_setValue('said', 2));`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.menuCommands.length).toBe(2);

    const lines: string[] = [];
    const ctx: ConsoleContext = { host, page, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
    const run = async (line: string) => {
      lines.length = 0;
      await runConsoleCommand(line, ctx);
      return [...lines];
    };

    expect(await run('menu')).toEqual(['Menu commands:', '* 1: Menus (menus.user.js)', '    1: Say one', '    2: Say two']);
    expect(await run('menu 2')).toEqual(['[sm-dev] Fired "Say two"']);
    await expect.poll(() => host.getValue(script.spec!.id, 'said')).toBe(2);
    expect(await run('menu Say one')).toEqual(['[sm-dev] Fired "Say one"']);
    await expect.poll(() => host.getValue(script.spec!.id, 'said')).toBe(1);
    // A wrong name is reported at once while others are registered.
    const started = Date.now();
    expect(await run('menu abc')).toEqual(['[sm-dev] No menu command named "abc" is registered. Type menu to list them.']);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await run('menu 3')).toEqual(['[sm-dev] There is no menu command 3. Type menu to list them.']);
  });

  test('a dialog a menu command opens waits for accept, and blocks page commands meanwhile', async ({ page, fixtureServer, host, loadScript }) => {
    const script = await loadScript({
      relativePath: 'ask.user.js',
      meta: { name: 'Ask', match: ['*://*/target.html'], grant: ['GM_registerMenuCommand', 'GM_setValue'] },
      body: `GM_registerMenuCommand('Ask', () => {
        const answer = prompt('Name?', 'Bob');
        if (answer !== null) GM_setValue('name', answer);
      });`,
    });
    const lines: string[] = [];
    const dialogs = await DialogTracker.attach(page, (l) => lines.push(l), { visible: false, commandsComing: true });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.menuCommands.length).toBe(1);

    const ctx: ConsoleContext = { host, page, scripts: [script], dialogs, out: (l) => lines.push(l), stop: () => undefined };
    const run = async (line: string) => {
      lines.length = 0;
      await runConsoleCommand(line, ctx);
      return [...lines];
    };

    expect(await run('menu 1')).toEqual([
      '[sm-dev] The page opened a prompt dialog: "Name?". Type accept [text] or dismiss.',
      '[sm-dev] Fired "Ask"',
    ]);
    // These would wait on the stopped page, and hold up the accept.
    const blocked = ['[sm-dev] The page is waiting on a prompt dialog. Type accept or dismiss first.'];
    expect(await run('menu 1')).toEqual(blocked);
    expect(await run('set name "x"')).toEqual(blocked);
    expect(await run('dismiss now')).toEqual(['[sm-dev] The dismiss command takes no arguments']);
    expect(await run('accept Alice')).toEqual(['[sm-dev] Accepted the dialog']);
    await expect.poll(() => host.getValue(script.spec!.id, 'name')).toBe('Alice');
    expect(await run('accept')).toEqual(['[sm-dev] No dialog is open']);

    // A later prompt is tracked as the open one, not cleared by the
    // first one closing.
    await run('menu 1');
    expect(await run('accept')).toEqual(['[sm-dev] Accepted the dialog']);
    await expect.poll(() => host.getValue(script.spec!.id, 'name')).toBe('Bob');
  });
});
