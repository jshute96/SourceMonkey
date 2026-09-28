// The commands typed into `sm-dev start`, driven directly: with several
// scripts loaded, `scripts` picks which one `get` and `set` reach, and
// `menu` fires a command by label or by its M number in the list, a
// dialog a command opens waits for a typed answer, and with several
// tabs the commands name them as T1, T2 and act on the one picked.

import { test, expect } from '../fixtures/harness.js';
import { DialogTracker, runConsoleCommand, type ConsoleContext } from '../../lib/harness/console-commands.js';
import { attachPage } from '../../lib/harness/inject.js';

test.describe('sm-dev typed commands', () => {
  test('scripts picks the script values, get and set act on', async ({ page, fixtureServer, host, attachment, loadScript, scriptsDir }) => {
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
    const tabs = [{ n: 1, page, link: attachment }];
    const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [first, second], out: (l) => lines.push(l), stop: () => undefined };
    const run = async (line: string) => {
      lines.length = 0;
      await runConsoleCommand(line, ctx);
      return [...lines];
    };

    expect(await run('get who')).toEqual(['  who = "one"']);
    expect(await run('scripts')).toEqual([
      'Loaded scripts (with status on active tab T1):',
      `* 1: First (${scriptsDir.path}/first.user.js)`, '     Active',
      `  2: Second (${scriptsDir.path}/second.user.js)`, '     Active',
    ]);
    expect(await run('script 2')).toEqual([`[sm-dev] Using Second (${scriptsDir.path}/second.user.js) for get and set`]);
    expect(await run('get who')).toEqual(['  who = "two"']);
    expect(await run('set who "changed"')).toEqual(['[sm-dev] Set who (Second)']);
    expect(host.getValue(second.spec!.id, 'who')).toBe('changed');
    expect(host.getValue(first.spec!.id, 'who')).toBe('one');
    // By exact file name, or by a piece of a name that only one has.
    expect(await run('scripts first.user.js')).toEqual([`[sm-dev] Using First (${scriptsDir.path}/first.user.js) for get and set`]);
    expect(await run('scripts cond')).toEqual([`[sm-dev] Using Second (${scriptsDir.path}/second.user.js) for get and set`]);
    expect(await run('scripts user.js')).toEqual(['[sm-dev] Several loaded scripts match user.js (1, 2). Name one by its number.']);
    expect(await run('scripts Nobody')).toEqual(['[sm-dev] No loaded script matches Nobody. Use scripts to list them.']);
    expect(await run('scripts 3')).toEqual(['[sm-dev] There is no script 3. Use scripts to list them.']);

    expect(await run('values')).toEqual([
      'Stored values:', `  1: First (${scriptsDir.path}/first.user.js)`, '    who = "one"', `* 2: Second (${scriptsDir.path}/second.user.js)`, '    who = "changed"',
    ]);
    expect(await run('values 1')).toEqual(['Stored values:', `  1: First (${scriptsDir.path}/first.user.js)`, '    who = "one"']);
    expect(await run('values now')).toEqual(['[sm-dev] No loaded script matches now. Use scripts to list them.']);
    expect(await run('status now')).toEqual(['[sm-dev] ERROR: The status command takes no arguments']);
    expect(await run('reload now')).toEqual(['[sm-dev] ERROR: now is not a tab. Tabs are named T1, T2 and so on; use tabs to list them.']);
  });

  test('menu lists commands by script, and fires one by its M number', async ({ page, fixtureServer, host, attachment, loadScript, scriptsDir }) => {
    const script = await loadScript({
      relativePath: 'menus.user.js',
      meta: { name: 'Menus', match: ['*://*/target.html'], grant: ['GM_registerMenuCommand', 'GM_setValue'] },
      body: `GM_registerMenuCommand('Say one', () => GM_setValue('said', 1));
        GM_registerMenuCommand('Say two', () => GM_setValue('said', 2));`,
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    await expect.poll(() => host.reports.menuCommands.length).toBe(2);

    const lines: string[] = [];
    const tabs = [{ n: 1, page, link: attachment }];
    const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
    const run = async (line: string) => {
      lines.length = 0;
      await runConsoleCommand(line, ctx);
      return [...lines];
    };

    expect(await run('menu')).toEqual(['Menu commands:', `* 1: Menus (${scriptsDir.path}/menus.user.js)`, '    M1: Say one', '    M2: Say two']);
    expect(await run('menu M2')).toEqual(['[sm-dev] Fired "Say two"']);
    await expect.poll(() => host.getValue(script.spec!.id, 'said')).toBe(2);
    expect(await run('menu Say one')).toEqual(['[sm-dev] Fired "Say one"']);
    await expect.poll(() => host.getValue(script.spec!.id, 'said')).toBe(1);
    // A wrong name is reported at once while others are registered.
    const started = Date.now();
    expect(await run('menu abc')).toEqual(['[sm-dev] No menu command named "abc" is registered. Use menu to list them.']);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await run('menu M3')).toEqual(['[sm-dev] There is no menu command M3. Use menu to list them.']);
  });

  test('a dialog a menu command opens waits for accept, and blocks page commands meanwhile', async ({ page, fixtureServer, host, attachment, loadScript }) => {
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

    const tabs = [{ n: 1, page, link: attachment, dialogs }];
    const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
    const run = async (line: string) => {
      lines.length = 0;
      await runConsoleCommand(line, ctx);
      return [...lines];
    };

    expect(await run('menu M1')).toEqual([
      '[sm-dev] The page opened a prompt dialog: "Name?". Type accept [text] or dismiss.',
      '[sm-dev] Fired "Ask"',
    ]);
    // These would wait on the stopped page, and hold up the accept.
    const blocked = ['[sm-dev] The page is waiting on a prompt dialog. Type accept or dismiss first.'];
    expect(await run('menu M1')).toEqual(blocked);
    expect(await run('set name "x"')).toEqual(blocked);
    expect(await run('dismiss now')).toEqual(['[sm-dev] ERROR: The dismiss command takes no arguments']);
    expect(await run('accept Alice')).toEqual(['[sm-dev] Accepted the dialog']);
    await expect.poll(() => host.getValue(script.spec!.id, 'name')).toBe('Alice');
    expect(await run('accept')).toEqual(['[sm-dev] No dialog is open']);

    // A later prompt is tracked as the open one, not cleared by the
    // first one closing.
    await run('menu M1');
    expect(await run('accept')).toEqual(['[sm-dev] Accepted the dialog']);
    await expect.poll(() => host.getValue(script.spec!.id, 'name')).toBe('Bob');
  });

  test('with several tabs, commands act on the picked one, or on all', async ({ page, fixtureServer, host, attachment, loadScript, scriptsDir }) => {
    const script = await loadScript({
      relativePath: 'menus.user.js',
      meta: { name: 'Menus', match: ['*://*/target.html', '*://*/other.html'], grant: ['GM_registerMenuCommand', 'GM_setValue'] },
      body: `GM_registerMenuCommand('Hit ' + location.pathname, () => GM_setValue('hit', location.pathname));`,
    });
    const target = `${fixtureServer.baseUrl}/target.html`;
    const other = `${fixtureServer.baseUrl}/other.html`;
    await page.goto(target);
    const page2 = await page.context().newPage();
    const attachment2 = await attachPage(page2, host);
    try {
      await attachment2.inject(script);
      await page2.goto(other);
      await expect.poll(() => host.reports.menuCommands.length).toBe(2);

      const lines: string[] = [];
      const tabs = [
        { n: 1, page, link: attachment, targetId: 'AB12CD34EF56AB12CD34EF56AB12CD34' },
        { n: 2, page: page2, link: attachment2, openedBy: 1, targetId: 'AB12CD99EF56AB12CD34EF56AB12CD34' },
      ];
      const opened: (string | undefined)[] = [];
      const ctx: ConsoleContext = {
        host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined,
        // Stands in for run's, which opens a controlled tab.
        newTab: async (url) => {
          opened.push(url);
          return tabs[1];
        },
      };
      const run = async (line: string) => {
        lines.length = 0;
        await runConsoleCommand(line, ctx);
        return [...lines];
      };
      const row = `* 1: Menus (${scriptsDir.path}/menus.user.js)`;
      // The reload re-registers T2's command for its new document.
      const fromT2Menus = () => host.reports.menuCommands.filter((m) => host.pageOf(m) === attachment2).length;

      expect(await run('tabs')).toEqual([
        'Tabs:', `* T1: ${target} [targetId=AB12CD34EF56AB12CD34EF56AB12CD34]`, '   * 1: Menus',
        `  T2: ${other} (opened by T1) [targetId=AB12CD99EF56AB12CD34EF56AB12CD34]`, '     1: Menus',
      ]);
      // A tab by its CDP target id, whole or by a start only it has.
      expect(await run('focus ab12cd99')).toEqual(['[sm-dev] Brought T2 to the front']);
      expect(await run('focus AB12CD34EF56AB12CD34EF56AB12CD34')).toEqual(['[sm-dev] Brought T1 to the front']);
      // Or pasted from the output as it is.
      expect(await run('focus targetId=AB12CD99EF56AB12CD34EF56AB12CD34')).toEqual(['[sm-dev] Brought T2 to the front']);
      expect(await run('tabs [targetId=AB12CD34EF56AB12CD34EF56AB12CD34]')).toEqual([
        `[sm-dev] The page commands now act on T1 (${target})`,
      ]);
      expect(await run('focus AB12CD')).toEqual([
        '[sm-dev] Several tabs\' target ids start with AB12CD (T1, T2). Type more of it.',
      ]);
      expect(await run('reload ABCDEF')).toEqual(['[sm-dev] No open tab\'s target id starts with ABCDEF. Use tabs to list them.']);
      // Too short to be taken for an id, and a long number is still a slip.
      expect(await run('focus AB12C')).toEqual(['[sm-dev] ERROR: AB12C is not a tab. Tabs are named T1, T2 and so on; use tabs to list them.']);
      expect(await run('focus 123456')).toEqual(['[sm-dev] ERROR: Tabs are named T1, T2 and so on. Did you mean T123456?']);
      expect(await run('status')).toEqual([
        'Tabs:', `* T1: ${target} [targetId=AB12CD34EF56AB12CD34EF56AB12CD34]`, '   * 1: Menus',
        `  T2: ${other} (opened by T1) [targetId=AB12CD99EF56AB12CD34EF56AB12CD34]`, '     1: Menus',
        'Scripts (with status on active tab T1):', row, '     Active (Also active on T2.)', '     1 menu command',
      ]);
      expect(await run('status T2')).toEqual(['[sm-dev] ERROR: The status command takes no arguments']);
      expect(await run('menu')).toEqual(['Menu commands on T1:', row, '    M1: Hit /target.html']);
      expect(await run('menu all')).toEqual([
        'Menu commands:',
        `* Tab T1: ${target}`, `  ${row}`, '      M1: Hit /target.html',
        `  Tab T2: ${other}`, `  ${row}`, '      M1: Hit /other.html',
      ]);
      // Another tab's command, by its number there or by label.
      expect(await run('menu T2.M1')).toEqual(['[sm-dev] Fired "Hit /other.html"']);
      await expect.poll(() => host.getValue(script.spec!.id, 'hit')).toBe('/other.html');
      expect(await run('menu Hit /other.html')).toEqual([
        '[sm-dev] "Hit /other.html" is registered on T2, not T1. Type menu T2.Hit /other.html to fire it there.',
      ]);
      expect(await run('menu T3.M1')).toEqual(['[sm-dev] There is no open tab T3. Use tabs to list them.']);

      // Tabs and menu commands take their letter; a bare number gets a hint.
      expect(await run('tabs 2')).toEqual(['[sm-dev] ERROR: Tabs are named T1, T2 and so on. Did you mean T2?']);
      expect(await run('reload 2')).toEqual(['[sm-dev] ERROR: Tabs are named T1, T2 and so on. Did you mean T2?']);
      expect(await run('menu 1')).toEqual(['[sm-dev] ERROR: Menu commands are named M1, M2 and so on. Did you mean M1?']);
      // A file name that starts like a tab stays a script name.
      expect(await run('scripts t1.user.js')).toEqual(['[sm-dev] No loaded script matches t1.user.js. Use scripts to list them.']);
      expect(await run('values T2')).toEqual(['Stored values:', row, '    hit = "/other.html"']);
      expect(await run('focus T2')).toEqual(['[sm-dev] Brought T2 to the front']);
      await run('reload T2');
      await expect.poll(() => fromT2Menus()).toBe(1);
      // Every tab, at once.
      const reloaded = Promise.all([page.waitForEvent('load'), page2.waitForEvent('load')]);
      await run('reload all');
      await reloaded;
      expect(await run('update')).toEqual(['[sm-dev] This run cannot update scripts']);
      expect(await run('load x.user.js')).toEqual(['[sm-dev] This run cannot load scripts']);

      // Every script's, once: values belong to the script, not the tab.
      expect(await run('values all')).toEqual(await run('values'));

      // Picking a tab moves the page commands and the default for menu.
      expect(await run('tabs T2')).toEqual([`[sm-dev] The page commands now act on T2 (${other})`]);
      expect(await run('menu M1')).toEqual(['[sm-dev] Fired "Hit /other.html"']);
      expect(await run('scripts T1.1')).toEqual([`[sm-dev] Using Menus (${scriptsDir.path}/menus.user.js) for get and set, and T1 for the page commands`]);
      expect(await run('menu')).toEqual(['Menu commands on T1:', row, '    M1: Hit /target.html']);

      // `newtab` opens one, with a bare host given a scheme, and
      // picks it.
      expect(await run('newtab example.com/x')).toEqual([`[sm-dev] The page commands now act on T2 (${other})`]);
      expect(opened).toEqual(['http://example.com/x']);
      expect(await run('newtab all example.com/y')).toEqual(['[sm-dev] ERROR: The newtab command takes all by itself, to open each script\'s page']);
      expect(await run('tabs new')).toEqual(['[sm-dev] ERROR: The tabs command picks a tab. To open one, use newtab.']);

      // A closed tab gives way to T1.
      await run('tabs T2');
      tabs.pop();
      expect(await run('menu')).toEqual([
        '[sm-dev] T2 has closed, so the page commands now act on T1', 'Menu commands:', row, '    M1: Hit /target.html',
      ]);
    } finally {
      await attachment2.dispose();
      await page2.close();
    }
  });

  test('open and newtab take a script, meaning its default page', async ({ page, fixtureServer, host, attachment, loadScript, scriptsDir }) => {
    const target = `${fixtureServer.baseUrl}/target.html`;
    const pages = await loadScript({
      relativePath: 'pages.user.js',
      meta: { name: 'Pages', match: [target] },
      body: '',
    });
    const wild = await loadScript({
      relativePath: 'wild.user.js',
      meta: { name: 'Wild', match: ['*://*/*'] },
      body: '',
    });
    await page.goto(`${fixtureServer.baseUrl}/other.html`);

    const lines: string[] = [];
    const tabs = [{ n: 1, page, link: attachment }];
    const opened: (string | undefined)[] = [];
    const ctx: ConsoleContext = {
      host, tabs: () => tabs, scripts: [pages, wild], out: (l) => lines.push(l), stop: () => undefined,
      newTab: async (url) => {
        opened.push(url);
        return tabs[0];
      },
    };
    const run = async (line: string) => {
      lines.length = 0;
      await runConsoleCommand(line, ctx);
      return [...lines];
    };
    const noPage = `[sm-dev] Wild (${scriptsDir.path}/wild.user.js): Its @match names no page to open. Give a URL instead.`;

    // Bare, the selected script's page; by number or T<n>.<n>, that script's.
    expect(await run('open')).toEqual([]);
    expect(page.url()).toBe(target);
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    expect(await run('open T1.1')).toEqual([]);
    expect(page.url()).toBe(target);
    // A bare tab: the selected script's page, there.
    await page.goto(`${fixtureServer.baseUrl}/other.html`);
    expect(await run('open T1')).toEqual([]);
    expect(page.url()).toBe(target);
    expect(await run('open 2')).toEqual([noPage]);
    expect(await run('newtab all --offline')).toEqual(['[sm-dev] ERROR: The newtab command takes all by itself, to open each script\'s page']);
    // A glob matching several files is more than open can load.
    expect(await run(`open ${scriptsDir.path}/*.user.js`)).toEqual([
      '[sm-dev] ERROR: The open command opens one page, so it takes one URL, file or script. To open several, use newtab.',
    ]);
    expect(await run('newtab T1.1')).toEqual([
      '[sm-dev] ERROR: The newtab command opens a tab of its own, so it takes URLs, files or script numbers, not T1.1',
    ]);
    await run('script 2');
    expect(await run('open')).toEqual([noPage]);
    expect(await run('open 3')).toEqual(['[sm-dev] There is no script 3. Use scripts to list them.']);

    expect(await run('newtab 1')).toEqual([`[sm-dev] The page commands now act on T1 (${target})`]);
    expect(opened).toEqual([target]);
    opened.length = 0;
    // One tab per script that has a page, and the rest listed after.
    const skipped = `[sm-dev] Skipped script 2, Wild (${scriptsDir.path}/wild.user.js): Its @match names no page to open`;
    expect(await run('newtab all')).toEqual([skipped]);
    expect(opened).toEqual([target]);
    opened.length = 0;
    expect(await run('open all')).toEqual(['[sm-dev] ERROR: The open command navigates one tab. To open a tab for each script, use newtab all.']);

    // With every tab closed, the tab commands say so, and newtab all
    // still opens.
    tabs.pop();
    expect(await run('tabs')).toEqual(['Tabs:', '  No active tabs']);
    expect(await run('status')).toEqual([
      'Tabs:', '  No active tabs', 'Scripts:',
      `  1: Pages (${scriptsDir.path}/pages.user.js)`,
      `* 2: Wild (${scriptsDir.path}/wild.user.js)`,
    ]);
    // With no scripts loaded (--noscript), the lists say so.
    const scripts = ctx.scripts;
    ctx.scripts = [];
    try {
      expect(await run('scripts')).toEqual(['Loaded scripts:', '  No scripts are loaded']);
    } finally {
      ctx.scripts = scripts;
    }
    expect(await run('menu')).toEqual(['[sm-dev] No tabs are active. Use newtab to open one.']);
    expect(await run('newtab all')).toEqual([skipped]);
    expect(opened).toEqual([target]);
  });

  test('a dialog on another tab blocks set, and accept points to it', async ({ page, fixtureServer, host, attachment, loadScript }) => {
    const script = await loadScript({
      relativePath: 'store.user.js',
      meta: { name: 'Store', match: ['*://*/target.html', '*://*/other.html'], grant: ['GM_setValue'] },
      body: '',
    });
    await page.goto(`${fixtureServer.baseUrl}/target.html`);
    const page2 = await page.context().newPage();
    const attachment2 = await attachPage(page2, host);
    try {
      await attachment2.inject(script);
      const lines: string[] = [];
      const dialogs2 = await DialogTracker.attach(page2, (l) => lines.push(l), { visible: false, commandsComing: true });
      await page2.goto(`${fixtureServer.baseUrl}/other.html`);
      const tabs = [{ n: 1, page, link: attachment }, { n: 2, page: page2, link: attachment2, dialogs: dialogs2, openedBy: 1 }];
      const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: (l) => lines.push(l), stop: () => undefined };
      const run = async (line: string) => {
        lines.length = 0;
        await runConsoleCommand(line, ctx);
        return [...lines];
      };
      void page2.evaluate(() => setTimeout(() => alert('Hi'), 0));
      await expect.poll(() => dialogs2.current !== null).toBe(true);

      // `set` reaches every tab, so T2's dialog would hold it up.
      expect(await run('set k 1')).toEqual(['[sm-dev] T2 is waiting on an alert dialog. Type tabs T2, then accept or dismiss.']);
      expect(await run('accept')).toEqual(['[sm-dev] No dialog is open on T1. T2 has one; type tabs T2 first.']);
      expect(await run('tabs')).toEqual([
        'Tabs:', `* T1: ${fixtureServer.baseUrl}/target.html`, '   * 1: Store',
        `  T2: ${fixtureServer.baseUrl}/other.html (opened by T1)`, '    Waiting on an alert dialog: "Hi"', '     1: Store',
      ]);
      await run('tabs T2');
      expect(await run('accept')).toEqual(['[sm-dev] Accepted the dialog']);
      expect(await run('set k 1')).toEqual(['[sm-dev] Set k']);
    } finally {
      await attachment2.dispose();
      await page2.close();
    }
  });
});
