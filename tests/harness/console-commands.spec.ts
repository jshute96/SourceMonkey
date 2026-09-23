// The commands typed into `sm-dev run`, driven directly: with several
// scripts loaded, `use` picks which one `values`, `get` and `set` reach.

import { test, expect } from '../fixtures/harness.js';
import { runConsoleCommand, type ConsoleContext } from '../../lib/harness/console-commands.js';

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
    expect(await run('use')).toEqual(['* First  first.user.js', '  Second  second.user.js']);
    expect(await run('use second.user.js')).toEqual(['[sm-dev] using Second']);
    expect(await run('get who')).toEqual(['  who = "two"']);
    expect(await run('set who "changed"')).toEqual(['[sm-dev] set who (Second)']);
    expect(host.getValue(second.spec!.id, 'who')).toBe('changed');
    expect(host.getValue(first.spec!.id, 'who')).toBe('one');
    expect(await run('use Nobody')).toEqual(['[sm-dev] no loaded script is named Nobody; type use to list them']);
  });
});
