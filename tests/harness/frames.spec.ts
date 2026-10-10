// sm-dev's view of a tab's iframes, on the frames example: the frame
// count on a tab's line, which scripts run in which frames (`tabs`,
// `status`, `frames`), frame ids that last across a frame's reload,
// menu commands labeled by frame and dropped with it, `match --frames`,
// and their JSON. See docs/sm-dev-frames.md.

import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../fixtures/harness.js';
import { runConsoleCommand, type ConsoleContext, type ControlledTab } from '../../lib/harness/console-commands.js';

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'frames');

test('frames: ids, the scripts in each frame, menus and match', async ({ page, fixtureServer, host, attachment, loadUserscript, watchPage, scriptsDir }) => {
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
  // Each frame's id, by its page, its CDP frame id, and its CDP target
  // when it has one of its own.
  const ids: Record<string, string> = {};
  const frameIds: Record<string, string> = {};
  const targets: Record<string, string | undefined> = {};
  for (const line of await run('frames')) {
    const m = /^\s*(F\d+): \S+\/frames\/frame-(a|b|nested)\.html \[frameId=(\w+)\](?: \[targetId=(\w+)\])?$/.exec(line);
    if (m) {
      ids[m[2]] = m[1];
      frameIds[m[2]] = m[3];
      targets[m[2]] = m[4];
    }
  }
  const { a, b, nested } = ids;
  expect([a, b, nested].every(Boolean)).toBe(true);
  // In document order. Frame B runs in a process of its own (another
  // site), whose target id is its frame id; the nested frame in B's.
  expect([a, b, nested]).toEqual(['F1', 'F2', 'F3']);
  expect(targets).toEqual({ a: undefined, b: frameIds.b, nested: undefined });
  // The frames' lines without their CDP ids.
  const plain = (lines: string[]) => lines.map((l) => l.replace(/ \[(frameId|targetId)=\w+\]/g, ''));
  // Frame B is on the other of localhost and 127.0.0.1.
  const other = (u: string) => (u.includes('127.0.0.1') ? u.replace('127.0.0.1', 'localhost') : u.replace('localhost', '127.0.0.1'));
  const frameA = `${fixtureServer.baseUrl}/frames/frame-a.html`;
  const frameB = other(`${fixtureServer.baseUrl}/frames/frame-b.html`);
  const frameNested = other(`${fixtureServer.baseUrl}/frames/frame-nested.html`);

  expect(plain(await run('frames'))).toEqual([
    `T1: ${url}`, '    Scripts: 1, 3',
    `  ${a}: ${frameA}`, '      Scripts: 1',
    `  ${b}: ${frameB}`, '      Scripts: 1, 2',
    `    ${nested}: ${frameNested}`, '        Scripts: 1',
  ]);
  expect(plain(await run(`frames T1.${b}`))).toEqual([
    `${b}: ${frameB}`, '    Scripts: 1, 2',
    `  ${nested}: ${frameNested}`, '      Scripts: 1',
  ]);
  // By its CDP id, as shown or by its start; a tab's target id is its tab.
  expect(plain(await run(`frames frameId=${frameIds.b.slice(0, 8)}`))[0]).toBe(`${b}: ${frameB}`);
  expect(plain(await run(`frames [targetId=${frameIds.b}]`))[0]).toBe(`${b}: ${frameB}`);
  expect(await run('frames frameId=ffffffffff')).toEqual(['[sm-dev] No frame\'s id starts with ffffffffff. Use frames all to list them.']);
  expect(await run(`eval --frame frameId=${frameIds.nested} location.pathname`)).toEqual(['"/frames/frame-nested.html"']);
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
  expect(plain(await run('tabs --frames'))).toEqual([
    'Tabs:', `* T1: ${url} (+3 frames)`, '      Scripts: 1, 3',
    `    ${a}: ${frameA}`, '        Scripts: 1',
    `    ${b}: ${frameB}`, '        Scripts: 1, 2',
    `      ${nested}: ${frameNested}`, '          Scripts: 1',
  ]);
  // A command from an iframe names it. Each script's are in the order
  // they were registered, which the frames race for: compared as a set.
  const menuLines = (await run('menu')).filter((l) => l.startsWith('    M')).map((l) => l.replace(/^ {4}M\d+: /, ''));
  expect(menuLines.sort()).toEqual([
    'Every frame: mark top',
    `Every frame: mark frame-a (${a})`,
    `Every frame: mark frame-b (${b})`,
    `Every frame: mark nested (${nested})`,
    `Frame B only: mark frame-b (${b})`,
  ].sort());

  const tabsJson = await json('tabs');
  expect(tabsJson.tabs[0].scripts).toEqual(['1', '3']);
  expect(tabsJson.tabs[0].frames).toEqual([
    { id: a, parent: 'T1', url: frameA, scripts: ['1'], frameId: frameIds.a },
    { id: b, parent: 'T1', url: frameB, scripts: ['1', '2'], frameId: frameIds.b, targetId: frameIds.b },
    { id: nested, parent: b, url: frameNested, scripts: ['1'], frameId: frameIds.nested },
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

  // eval and the page commands, in a frame. Frame B is cross-origin,
  // so it runs in a process of its own.
  expect(await run(`eval --frame ${b} --page location.pathname`)).toEqual(['"/frames/frame-b.html"']);
  expect(await run(`eval --frame T1.${b} SCRIPT`)).toEqual(['"every-frame"']);
  expect(await run(`eval --frame ${b} --script=2 SCRIPT + ' ' + page`)).toEqual(['"frame-b-only frame-b"']);
  expect(await run(`eval --frame ${a} --script=2 1`)).toEqual([
    `[sm-dev] SourceMonkey example: frames: Frame B only hasn't run in ${a}, so its scope can't be reached. Load a page it matches, or reload this one.`,
  ]);
  expect(await run(`eval --frame ${nested} --page document.querySelectorAll('#log li').length`)).toEqual(['1']);
  expect(await run('eval --frame F99 1')).toEqual(['[sm-dev] T1 has no frame F99 now. Use frames to list its frames.']);
  expect(await run(`eval --frame T2.${b} 1`)).toEqual([`[sm-dev] ERROR: The --frame flag names a frame in T2, but the command acts on T1`]);
  expect(await run('eval --frame T2 1')).toEqual(['[sm-dev] ERROR: The --frame flag names T2, but the command acts on T1']);
  expect(await run('eval --frame T1 location.pathname')).toEqual(['"/frames/frames.html"']);
  const before = Number(host.getValue(every.id!, 'count') ?? 0);
  expect((await run(`click --frame ${b} '#buttons button'`)).at(-1)).toBe(`[sm-dev] Clicked #buttons button in ${b}`);
  await expect.poll(() => host.getValue(every.id!, 'count')).toBe(before + 1);
  expect(await run(`probe --frame ${nested} --css '#log li'`)).toEqual(['found    #log li  (1)', '    selector: li']);
  expect(await run(`wait selector --frame ${nested} '#log li'`)).toEqual([`[sm-dev] Wait done: The selector #log li matches on T1.${nested}`]);

  // Refs reach into frames without --frame: from a whole-page snapshot,
  // and from one of a frame alone, which keeps the page's refs too.
  const refOf = (lines: string[], text: string) => /\[ref=(\w+)\]/.exec(lines.find((l) => l.includes(text))!)![1];
  const clickCount = async (ref: string) => {
    const was = Number(host.getValue(every.id!, 'count'));
    expect((await run(`click ${ref}`)).at(-1)).toBe(`[sm-dev] Clicked ${ref} (button "Count")`);
    await expect.poll(() => host.getValue(every.id!, 'count')).toBe(was + 1);
  };
  // A frame's element has the same ref in its frame's snapshot as in
  // the whole page's, and either way it works with no --frame.
  const whole = (await run('snapshot')).join('\n');
  const countInB = refOf(await run(`snapshot --frame ${b}`), 'button "Count"');
  expect(whole).toMatch(new RegExp(`button "Count" .*\\[ref=${countInB}\\]`));
  await run('snapshot');
  await clickCount(countInB);
  // One frame's snapshot after another's keeps the first's refs.
  await run(`snapshot --frame ${b}`);
  const countInA = refOf(await run(`snapshot --frame ${a}`), 'button "Count"');
  await clickCount(countInA);
  await clickCount(countInB);
  // A ref with --frame: its own frame does; another is said.
  expect((await run(`click --frame ${b} ${countInB}`)).at(-1)).toMatch(/^\[sm-dev\] Clicked /);
  expect(await run(`click --frame ${a} ${countInB}`)).toEqual([
    `[sm-dev] The ref ${countInB} is in ${b}, not ${a}. A ref names its own frame, so --frame can be left out.`,
  ]);
  expect((await run(`wait selector --frame ${b} ${countInB}`))).toEqual([`[sm-dev] Wait done: The selector ${countInB} matches on T1.${b}`]);
  expect(await run(`wait 10ms --frame ${b}`)).toEqual([
    '[sm-dev] ERROR: The --frame flag is for wait selector and wait selector-gone, which look for an element in a frame',
  ]);

  // A frame's own picture, its target for raw CDP, and a hidden one.
  const shot = path.join(scriptsDir.path, 'b.png');
  expect(await run(`screenshot --frame ${b} ${shot}`)).toEqual([`[sm-dev] Wrote ${shot} (in ${b}) from ${url}`]);
  expect(statSync(shot).size).toBeGreaterThan(1000);
  expect((await run(`cdp --frame ${b} Runtime.evaluate {"expression":"location.pathname","returnByValue":true}`)).join('\n')).toContain('/frames/frame-b.html');
  // A frame in another's process: that one's target, with a word on it.
  expect((await run(`cdp --frame ${a} Runtime.evaluate {"expression":"1"}`))[0])
    .toBe(`[sm-dev] ${a} is part of T1's target, so the calls go there. Name the frame in them by its frameId, ${frameIds.a}.`);
  expect((await run(`cdp --frame ${nested} Runtime.evaluate {"expression":"1"}`))[0])
    .toBe(`[sm-dev] ${nested} is part of ${b}'s target, so the calls go there. Name the frame in them by its frameId, ${frameIds.nested}.`);
  await page.evaluate(() => { document.getElementById('frame-a')!.style.display = 'none'; });
  expect(plain(await run('frames'))[2]).toBe(`  ${a}: ${frameA} (hidden)`);
  await page.evaluate(() => { document.getElementById('frame-a')!.style.display = ''; });

  // Frame B reloads: same id; its nested frame is a new frame.
  await page.evaluate(() => {
    const frame = document.getElementById('frame-b') as HTMLIFrameElement;
    frame.src = frame.src;
  });
  // Frame A goes, and its run and menu command with it.
  await page.evaluate(() => document.getElementById('frame-a')!.remove());
  await expect.poll(async () => (await run('frames')).filter((l) => l.trim().startsWith('Scripts: 1')).length).toBe(3);
  const after = await run('frames');
  // Its target is a new one: the reload made a new process.
  expect(after[2]).toMatch(new RegExp(`^  ${b}: ${frameB.replace(/[.]/g, '\\.')} \\[frameId=\\w+\\] \\[targetId=\\w+\\]$`));
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
