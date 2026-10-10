// sm-dev's view of a tab's iframes, on the frames example: the frame
// count on a tab's line, which scripts run in which frames (`tabs`,
// `status`, `frames`), frame ids that last across a frame's reload,
// menu commands labeled by frame and dropped with it, `match --frames`,
// and their JSON. See docs/sm-dev-frames.md.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../fixtures/harness.js';
import { runConsoleCommand, type ConsoleContext, type ControlledTab } from '../../lib/harness/console-commands.js';

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'frames');

test('frames: ids, the scripts in each frame, menus and match', async ({ page, fixtureServer, host, attachment, loadUserscript, watchPage }) => {
  const load = (file: string) => loadUserscript(path.join(EXAMPLE, file), { collectionRoot: EXAMPLE });
  const every = await load('every-frame.user.js');
  const bOnly = await load('frame-b-only.user.js');
  const topOnly = await load('top-only.user.js');
  const url = `${fixtureServer.baseUrl}/frames/frames.html`;
  await page.goto(url);

  const lines: string[] = [];
  const tabs: ControlledTab[] = [{ n: 1, page, link: attachment }];
  const ctx: ConsoleContext = {
    host, tabs: () => tabs, scripts: [every, bOnly, topOnly], out: (l) => lines.push(l), stop: () => undefined, json: false,
  };
  const run = async (line: string) => {
    lines.length = 0;
    // A command's --json is kept on the context; each line here says.
    ctx.json = false;
    await runConsoleCommand(line, ctx);
    return [...lines];
  };
  // The result line, after its marker.
  const json = async (line: string) => JSON.parse((await run(`${line} --json`))[0].replace(/^[^{]*/, ''));

  // The four documents' starts are in: the nested frame's last.
  await expect.poll(async () => (await run('frames')).filter((l) => l.trim().startsWith('Scripts: 1')).length).toBe(4);
  // Each frame's id, by its page: the order frames are first seen.
  const ids: Record<string, string> = {};
  for (const line of await run('frames')) {
    const m = /^\s*(F\d+): \S+\/frames\/frame-(a|b|nested)\.html$/.exec(line);
    if (m) ids[m[2]] = m[1];
  }
  const { a, b, nested } = ids;
  expect([a, b, nested].every(Boolean)).toBe(true);
  // Frame B is on the other of localhost and 127.0.0.1.
  const other = (u: string) => (u.includes('127.0.0.1') ? u.replace('127.0.0.1', 'localhost') : u.replace('localhost', '127.0.0.1'));
  const frameA = `${fixtureServer.baseUrl}/frames/frame-a.html`;
  const frameB = other(`${fixtureServer.baseUrl}/frames/frame-b.html`);
  const frameNested = other(`${fixtureServer.baseUrl}/frames/frame-nested.html`);

  expect(await run('frames')).toEqual([
    `T1: ${url}`, '    Scripts: 1, 3',
    `  ${a}: ${frameA}`, '      Scripts: 1',
    `  ${b}: ${frameB}`, '      Scripts: 1, 2',
    `    ${nested}: ${frameNested}`, '        Scripts: 1',
  ]);
  expect(await run(`frames T1.${b}`)).toEqual([
    `${b}: ${frameB}`, '    Scripts: 1, 2',
    `  ${nested}: ${frameNested}`, '      Scripts: 1',
  ]);
  expect(await run('frames T2.F1')).toEqual(['[sm-dev] ERROR: T2 has no frame F1. Use frames all to list them.']);

  // Not in the top frame: only where; in the top frame only: nothing.
  expect(await run('tabs')).toEqual([
    'Tabs:', `* T1: ${url} (+3 frames)`,
    `   * 1: SourceMonkey example: frames: every frame (T1, ${a}, ${b}, ${nested})`,
    `     2: SourceMonkey example: frames: Frame B only (${b})`,
    '     3: SourceMonkey example: frames: top frame only',
  ]);
  const status = await run('status');
  expect(status).toContain(`     Active on T1 (T1, ${a}, ${b}, ${nested})`);
  expect(status).toContain(`     Active on T1 (${b})`);
  expect(status.filter((l) => l === '     Active')).toHaveLength(1);
  expect(await run('tabs --frames')).toEqual([
    'Tabs:', `* T1: ${url} (+3 frames)`, '      Scripts: 1, 3',
    `    ${a}: ${frameA}`, '        Scripts: 1',
    `    ${b}: ${frameB}`, '        Scripts: 1, 2',
    `      ${nested}: ${frameNested}`, '          Scripts: 1',
  ]);
  // A command from an iframe names it.
  expect((await run('menu')).filter((l) => l.startsWith('    M'))).toEqual([
    '    M1: Every frame: mark top',
    `    M2: Every frame: mark frame-a (${a})`,
    `    M3: Every frame: mark frame-b (${b})`,
    `    M4: Every frame: mark nested (${nested})`,
    `    M5: Frame B only: mark frame-b (${b})`,
  ]);

  const tabsJson = await json('tabs');
  expect(tabsJson.tabs[0].scripts).toEqual(['1', '3']);
  expect(tabsJson.tabs[0].frames).toEqual([
    { id: a, parent: 'T1', url: frameA, scripts: ['1'] },
    { id: b, parent: 'T1', url: frameB, scripts: ['1', '2'] },
    { id: nested, parent: b, url: frameNested, scripts: ['1'] },
  ]);
  const scriptsJson = await json('scripts');
  expect(scriptsJson.scripts.map((s: { tabs: unknown[] }) => s.tabs)).toEqual([
    [{ tab: 'T1', state: 'running', frames: ['T1', a, b, nested] }],
    [{ tab: 'T1', state: 'running', frames: [b] }],
    [{ tab: 'T1', state: 'running' }],
  ]);

  // @noframes keeps top-only out of every frame its rules match.
  const match = await run('match 3 --frames');
  expect(match).toContain(`  no match ${a}: ${frameA}`);
  expect(match).toContain('      Kept out by: @noframes');
  const matchJson = await json('match 2 --frames');
  expect(matchJson.results[0].pages[0].frames.map((f: { id: string; matches: boolean }) => [f.id, f.matches])).toEqual([
    [a, false], [b, true], [nested, false],
  ]);

  // Frame B reloads: same id; its nested frame is a new frame.
  await page.evaluate(() => {
    const frame = document.getElementById('frame-b') as HTMLIFrameElement;
    frame.src = frame.src;
  });
  // Frame A goes, and its run and menu command with it.
  await page.evaluate(() => document.getElementById('frame-a')!.remove());
  await expect.poll(async () => (await run('frames')).filter((l) => l.trim().startsWith('Scripts: 1')).length).toBe(3);
  const after = await run('frames');
  expect(after[2]).toBe(`  ${b}: ${frameB}`);
  expect(after[4]).toMatch(/^ {4}F\d+: /);
  expect(after[4]).not.toContain(`${nested}:`);
  expect((await run('tabs'))[1]).toBe(`* T1: ${url} (+2 frames)`);
  expect((await run('menu')).some((l) => l.includes('mark frame-a'))).toBe(false);

  // A second tab none of them match: each line names the tabs and frames.
  const page2 = await page.context().newPage();
  const attachment2 = await watchPage(page2);
  for (const script of [every, bOnly, topOnly]) await attachment2.inject(script);
  await page2.goto(`${fixtureServer.baseUrl}/target.html`);
  tabs.push({ n: 2, page: page2, link: attachment2 });
  expect(await run('status')).toContain(`     Active on T1 (${b})`);
  ctx.tab = tabs[1];
  const onT2 = await run('status');
  expect(onT2).toContain(`     Not active on T2. Active on T1 (${b}).`);
  expect(onT2).toContain('     Not active on T2. Active on T1.');
});
