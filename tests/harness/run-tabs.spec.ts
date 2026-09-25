// `sm-dev run` follows the tabs its tab opens: a `window.open` popup
// and a `GM_openInTab` tab both get the loaded scripts, and their
// lines carry the tab's name. Also `--all`'s tab per script, tabs
// closing (T1 included), and `--fire-menu` reaching another tab.

import { existsSync, utimesSync } from 'node:fs';
import path from 'node:path';

import { test, expect } from '../fixtures/harness.js';
import { run, type RunOptions } from '../../lib/harness/run.js';

// Run until every `wanted` text has appeared in a line, or 10s.
async function runUntil(
  opts: Omit<RunOptions, 'out' | 'until' | 'launch' | 'localRoots'>,
  wanted: string[],
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const done = run({
    ...opts,
    launch: true,
    localRoots: [],
    out: (line) => {
      lines.push(line);
      if (wanted.every((w) => lines.some((l) => l.includes(w)))) stop();
    },
    until,
  });
  const timer = setTimeout(stop, 10000);
  try {
    return { code: await done, lines };
  } finally {
    clearTimeout(timer);
  }
}

test('scripts run in the tabs the run tab opens', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'opener.user.js',
    meta: { name: 'Opener', match: ['*://*/target.html', '*://*/other.html*'], grant: ['GM_openInTab'] },
    body: `
      console.log('[opener] on ' + location.pathname + location.search);
      if (location.pathname.endsWith('target.html')) {
        window.open('other.html?via=open');
        GM_openInTab(location.href.replace('target.html', 'other.html?via=gm'));
      }
    `,
  });
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const wanted = ['on /other.html?via=open', 'on /other.html?via=gm'];
  const done = run({
    files: [file],
    url: `${fixtureServer.baseUrl}/target.html`,
    launch: true,
    collectionRoot: scriptsDir.path,
    localRoots: [],
    out: (line) => {
      lines.push(line);
      if (wanted.every((w) => lines.some((l) => l.endsWith(w)))) stop();
    },
    until,
  });
  const timer = setTimeout(stop, 10000);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }

  expect(lines).toContain('[page log] [opener] on /target.html');
  // Numbered in the order they appear, which the two opens don't fix.
  const tabLine = (w: string) => lines.find((l) => /^\[T\d+\] \[page log\] \[opener\] /.test(l) && l.endsWith(w));
  expect(tabLine(wanted[0])).toBeDefined();
  expect(tabLine(wanted[1])).toBeDefined();
  expect(lines.filter((l) => /^\[sm-dev\] Tab T\d+ opened at .*, from T1 \[targetId=[0-9A-F]{32}\]$/.test(l))).toHaveLength(2);
  // The host's own lines say which tab too.
  expect(lines.some((l) => /^\[T\d+\] \[sm-dev\] Opener started on .*other\.html\?via=gm$/.test(l))).toBe(true);
});

test('a followed tab keeps its menu commands, and --fire-menu reaches them there', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'menu.user.js',
    meta: { name: 'Menu', match: ['*://*/target.html', '*://*/other.html'], grant: ['GM_registerMenuCommand'] },
    body: `
      if (location.pathname.endsWith('target.html')) window.open('other.html');
      else GM_registerMenuCommand('Only here', () => console.log('[menu] fired on ' + location.pathname));
    `,
  });
  const { lines } = await runUntil({
    files: [file], url: `${fixtureServer.baseUrl}/target.html`, collectionRoot: scriptsDir.path, fireMenu: 'Only here',
  }, ['[T2] [page log] [menu] fired on /other.html']);
  expect(lines).toContain('[sm-dev] Fired menu command "Only here" on T2');
  expect(lines).toContain('[T2] [page log] [menu] fired on /other.html');
});

test('--all opens a tab per script page, numbered in order, and lists the skipped ones last', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const write = (name: string, match: string) => scriptsDir.write({
    relativePath: `${name.toLowerCase()}.user.js`,
    meta: { name, match: [match] },
    body: `console.log('[${name}] on ' + location.pathname);`,
  });
  const files = [write('A', `${base}/target.html`), write('B', `${base}/other.html`), write('C', '*://*/*'), write('D', `${base}/other.html`)];
  const { lines } = await runUntil({ files, all: true, collectionRoot: scriptsDir.path }, [
    '[page log] [A] on /target.html', '[T2] [page log] [B] on /other.html', '[T2] [page log] [D] on /other.html',
    'Skipped script 3, C (c.user.js): Its @match names no page to open',
  ]);
  // Each with the id a CDP session alongside can name the tab by.
  expect(lines.some((l) => new RegExp(`^\\[sm-dev\\] Opening ${base}/target\\.html in T1 \\[targetId=[0-9A-F]{32}\\]$`).test(l))).toBe(true);
  // B and D share one page, so one tab, announced once, after T1.
  const opening = lines.filter((l) => l.startsWith('[sm-dev] Opening'));
  expect(opening).toHaveLength(2);
  expect(opening[1]).toMatch(new RegExp(`^\\[sm-dev\\] Opening ${base}/other\\.html in T2 \\[targetId=[0-9A-F]{32}\\]$`));
  expect(lines.filter((l) => /Tab T\d+ opened/.test(l))).toEqual([]);
  const skipped = lines.indexOf('[sm-dev] Skipped script 3, C (c.user.js): Its @match names no page to open');
  expect(skipped).toBeGreaterThan(lines.indexOf(opening[1]));
});

test('closing a followed tab and T1 is noticed, and the run carries on', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'closer.user.js',
    meta: { name: 'Closer', match: ['*://*/target.html', '*://*/other.html'], grant: ['window.close'] },
    body: `
      if (location.pathname.endsWith('target.html')) {
        window.open('other.html');
        setTimeout(() => window.close(), 1500);
      } else {
        setTimeout(() => window.close(), 300);
      }
    `,
  });
  const { code, lines } = await runUntil({
    files: [file], url: `${fixtureServer.baseUrl}/target.html`, collectionRoot: scriptsDir.path,
  }, ['[sm-dev] Tab T2 closed', '[sm-dev] Tab T1 closed']);
  expect(lines).toContain('[sm-dev] Tab T2 closed');
  expect(lines).toContain('[sm-dev] Tab T1 closed');
  expect(code).toBe(0);
});

test('a document-start script in a followed tab gets a may-have-run-late note', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'early.user.js',
    meta: { name: 'Early', match: ['*://*/target.html', '*://*/other.html'], runAt: 'document-start' },
    body: `if (location.pathname.endsWith('target.html')) window.open('other.html');`,
  });
  const note = 'Tab T2 had already started loading, so early.user.js (run-at document-start) may have run later there than it would in the extension';
  const { lines } = await runUntil({
    files: [file], url: `${fixtureServer.baseUrl}/target.html`, collectionRoot: scriptsDir.path,
  }, [note]);
  expect(lines).toContain(`[sm-dev] ${note}`);
});

test('--notab opens no tab, and no scripts open a blank page or --url', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'quiet.user.js',
    meta: { name: 'Quiet', match: ['*://*/target.html'] },
    body: `console.log('[quiet] ran');`,
  });
  const noTab: string[] = [];
  const code = await run({
    files: [file], noTab: true, launch: true, collectionRoot: scriptsDir.path, localRoots: [], out: (l) => noTab.push(l),
  });
  expect(code).toBe(0);
  expect(noTab.some((l) => l.startsWith('[sm-dev] Opening'))).toBe(false);

  const target = `${fixtureServer.baseUrl}/target.html`;
  const { code: noScriptCode, lines } = await runUntil({ files: [], url: target, collectionRoot: scriptsDir.path }, [
    `[sm-dev] Opening ${target} in T1`,
  ]);
  expect(noScriptCode).toBe(0);
  expect(lines.some((l) => l.startsWith(`[sm-dev] Opening ${target} in T1 [targetId=`))).toBe(true);
});

// Drive the real CLI through its input, as a person or an agent would:
// each command is sent once a line containing its `waitFor` prints
// after the command before it. A `send` function runs first (to edit a
// file, say) and returns the line to type.
type Step = [waitFor: string, send: string | (() => string)];

async function driveCli(args: string[], steps: Step[]): Promise<string[]> {
  const { spawn } = await import('node:child_process');
  const cli = new URL('../../lib/harness/cli.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, 'run', ...args, '--launch', '--seconds', '25'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let pending = [...steps];
  let since = 0;
  let buffer = '';
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      lines.push(line);
      while (pending[0] && lines.slice(since).some((l) => l.includes(pending[0][0]))) {
        const send = pending[0][1];
        since = lines.length;
        child.stdin.write(`${typeof send === 'string' ? send : send()}\n`);
        pending = pending.slice(1);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  await new Promise((resolve) => child.on('exit', resolve));
  return lines;
}

// A newer modification time, as a save would give it.
function touch(file: string): void {
  const later = new Date(Date.now() + 2000);
  utimesSync(file, later, later);
}

test('--notab: the first tab opened is T1, unprefixed like a normal run\'s', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'hello.user.js',
    meta: { name: 'Hello', match: ['*://*/target.html'] },
    body: `console.log('[hello] on ' + location.pathname);`,
  });
  const target = `${fixtureServer.baseUrl}/target.html`;
  const lines = await driveCli([file, '--notab'], [
    ['Ready for commands', 'status'],
    ['Not running, since no tabs are active', `tabs new ${target}`],
    ['[page log] [hello] on /target.html', 'quit'],
  ]);
  expect(lines).toContain('[sm-dev] No tabs are active. Type tabs new to open one.');
  expect(lines.some((l) => l.startsWith(`[sm-dev] Opening ${target} in T1 [targetId=`))).toBe(true);
  // Both the page's lines and the harness's own, without a [T1] prefix.
  expect(lines).toContain('[page log] [hello] on /target.html');
  expect(lines).toContain(`[sm-dev] Hello started on ${target}`);
  expect(lines.some((l) => l.startsWith('[T1]'))).toBe(false);
});

test('--noscript: a blank page, and the lists say there are no scripts', async () => {
  const lines = await driveCli(['--noscript'], [
    ['Ready for commands', 'status'],
    ['No scripts are loaded', 'quit'],
  ]);
  // The tab as it opened, blank: nothing to open.
  expect(lines.some((l) => l.startsWith('[sm-dev] Tab T1 opened [targetId='))).toBe(true);
  expect(lines.some((l) => l.startsWith('[sm-dev] Opening'))).toBe(false);
  expect(lines).toContain('Page: about:blank');
  expect(lines).toContain('  No scripts are loaded');
});

test('load, update and reload all reload just the tabs they affect', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const write = (name: string, page: string, body = `console.log('[${name}] on ' + location.pathname);`) => scriptsDir.write({
    relativePath: `${name.toLowerCase()}.user.js`,
    meta: { name, match: [`*://*/${page}`] },
    body,
  });
  const a = write('A', 'target.html');
  const b = write('B', 'other.html');
  const lines = await driveCli([a, '--url', `${base}/target.html`], [
    ['Ready for commands', `tabs new ${base}/other.html`],
    ['The page commands now act on T2', `load ${b}`],
    // B matches only T2's page.
    ['[T2] [page log] [B] on /other.html', 'scripts 2'],
    ['Using B', 'set k 1'],
    ['Set k', 'update 1'],
    // Untouched, so nothing to do; touched, only A's tab reloads.
    ["hasn't changed on disk", () => { touch(a); return 'update all'; }],
    ['[page log] [A] on /target.html', 'scripts'],
    ['Loaded scripts:', 'get k'],
    ['k = 1', `load ${b}`],
    ['is already loaded', `load ${scriptsDir.path}`],
    ['is a directory', 'load nothing.user.js'],
    ['No such file or directory', () => { write('B', 'other.html', 'syntax error here('); return 'update 2'; }],
    ['INVALID', 'reload all'],
    ['[page log] [A] on /target.html', 'quit'],
  ]);
  expect(lines).toContain(`[sm-dev] Loaded ${b} as script 2`);
  expect(lines).toContain('[sm-dev] Reloading T2');
  expect(lines).toContain("[sm-dev] Script 1 hasn't changed on disk, so nothing was reloaded");
  // `update all` after touching A: only its tab, and the selection and
  // stored value are kept.
  expect(lines).toContain('[sm-dev] Reloading T1');
  expect(lines).not.toContain('[sm-dev] Reloading T1, T2');
  expect(lines).toContain('* 2: B (b.user.js)');
  expect(lines).toContain('  k = 1');
  expect(lines).toContain(`[sm-dev] ${b} is already loaded, as script 2. Type update 2 to re-read it.`);
  expect(lines).toContain(`[sm-dev] ${scriptsDir.path} is a directory. Name a .user.js file.`);
  expect(lines).toContain('[sm-dev] No such file or directory: nothing.user.js');
  // The failed update changed nothing, so reloaded nothing.
  const invalid = lines.findIndex((l) => l.startsWith('INVALID'));
  expect(lines.slice(invalid).filter((l) => l.startsWith('[sm-dev] Reloading'))).toEqual([]);
  // `reload all` reloaded both tabs.
  expect(lines.slice(invalid).filter((l) => l.endsWith('[page log] [A] on /target.html'))).toHaveLength(1);
  expect(lines.slice(invalid).filter((l) => l.endsWith('[T2] [page log] [B] on /other.html'))).toHaveLength(1);
});

test('a tab without scripts gets none, nor do its tabs, and load and savehtml leave it be', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const write = (name: string) => scriptsDir.write({
    relativePath: `${name.toLowerCase()}.user.js`,
    meta: { name, match: ['*://*/target.html', '*://*/other.html'] },
    body: `console.log('[${name}] on ' + location.pathname);`,
  });
  const a = write('A');
  const b = write('B');
  const saved = path.join(scriptsDir.path, 'plain.html');
  const lines = await driveCli([a, '--url', `${base}/target.html`], [
    ['Ready for commands', `tabs new --noscript ${base}/target.html`],
    ['The page commands now act on T2', 'eval T2 window.open("other.html"), "opened"'],
    // Its popup is a tab without scripts too.
    ['Tab T3 opened', `load ${b}`],
    // Only T1 runs scripts, so only it reloads.
    ['[page log] [B] on /target.html', `savehtml T2 ${saved}`],
    ['Wrote', 'eval T2 !!document.querySelector("link[data-sm-badge]")'],
    ['false', 'eval T1 !!document.querySelector("link[data-sm-badge]")'],
    ['true', 'quit'],
  ]);
  expect(lines.some((l) => /^\[sm-dev\] Tab T3 opened at .*other\.html \(no scripts\), from T2 /.test(l))).toBe(true);
  expect(lines).toContain('[sm-dev] Reloading T1');
  expect(lines.some((l) => /Reloading .*T[23]/.test(l))).toBe(false);
  // Nothing ran in T2 or T3, and savehtml there has no scripts' changes
  // to warn of.
  expect(lines.filter((l) => /^\[T[23]\] .*\[(A|B)\] on/.test(l))).toEqual([]);
  expect(lines.some((l) => l.includes('It has the scripts\' changes'))).toBe(false);
  expect(existsSync(saved)).toBe(true);
  // No badge in T2; T1 has one.
  const badges = lines.slice(lines.findIndex((l) => l.includes('Wrote')));
  expect(badges.filter((l) => l === 'false' || l === 'true')).toEqual(['false', 'true']);
});

test('open --noscript switches a tab to no scripts for good, and --script back', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    // A page of its own, for open all to open.
    meta: { name: 'A', match: [`${base}/target.html`] },
    body: `console.log('[A] on ' + location.pathname);`,
  });
  const badge = 'eval T1 !!document.querySelector("link[data-sm-badge]")';
  const lines = await driveCli([a, '--url', `${base}/target.html`], [
    ['[page log] [A] on /target.html', 'open --noscript'],
    ['runs no scripts from now on', 'tabs'],
    // The script stays out: a reload loads without it. (Through eval,
    // for a line to wait on: a reload with no scripts prints nothing.)
    ['(no scripts)', 'eval location.reload(), "reloading"'],
    // Once it's reloaded: an eval in the old page or the new one says
    // something either way.
    ['"reloading"', 'eval new Promise((r) => setTimeout(r, 1000)).then(() => document.readyState)'],
    ['', () => { touch(a); return 'update'; }],
    ['none was reloaded', badge],
    ['false', 'open --script'],
    ['runs the scripts again', 'eval new Promise((r) => setTimeout(r, 1500)).then(() => "waited")'],
    ['"waited"', badge],
    ['true', 'open all --noscript'],
    ['Opening', 'tabs new --noscript 1'],
    ['The page commands now act on T3', 'tabs'],
    // reload switches too: every tab back to scripts, then T1 off.
    ['Tabs:', 'reload all --script'],
    ['[T3] [page log] [A] on /target.html', 'reload T1 --noscript'],
    // tabs new takes --script too: a new tab's usual mode, said out.
    ['T1 runs no scripts from now on', `tabs new --script ${base}/target.html`],
    ['[T4] [page log] [A] on /target.html', 'tabs new --script --noscript'],
    ['not both', 'quit'],
  ]);
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  // Between switching off and back on, the script didn't run.
  const off = at('runs no scripts from now on');
  const on = at('runs the scripts again');
  expect(lines.slice(off, on).filter((l) => l.includes('[A] on'))).toEqual([]);
  expect(lines.slice(on).filter((l) => l === '[page log] [A] on /target.html').length).toBeGreaterThan(0);
  const row = lines.findIndex((l) => /^\* T1: .*target\.html \(no scripts\)/.test(l));
  expect(row).toBeGreaterThan(0);
  // And lists no script as running there.
  expect(lines[row + 1]).not.toMatch(/^ +\*? *1: A/);
  // update left the switched tab alone.
  expect(lines).toContain('[sm-dev] No open tab runs or matches the updated scripts, so none was reloaded');
  expect(lines.filter((l) => l === 'false' || l === 'true')).toEqual(['false', 'true']);
  // open all --noscript: the script's page, in a tab without scripts.
  expect(lines.some((l) => /^ {2}T2: .*target\.html \(no scripts\)/.test(l))).toBe(true);
  // tabs new --noscript with a script's number: its page, without it.
  expect(lines.some((l) => /^\* T3: .*target\.html \(no scripts\)/.test(l))).toBe(true);
  // reload all --script: T2 and T3 switched back, and the script ran
  // in both.
  const back = at('reload') >= 0 ? lines.findIndex((l) => l === '[sm-dev] T2 runs the scripts again') : -1;
  expect(back).toBeGreaterThan(0);
  expect(lines.slice(back)).toContain('[sm-dev] T3 runs the scripts again');
  expect(lines.slice(back)).toContain('[T2] [page log] [A] on /target.html');
  expect(lines).toContain('[T4] [page log] [A] on /target.html');
  expect(lines).toContain('[sm-dev] The tabs new command takes --noscript or --script, not both');
});

test('open and reload switch the tab they name, or the current one, and say when nothing changes', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: [`${base}/target.html`] },
    body: `console.log('[A] on ' + location.pathname);`,
  });
  const lines = await driveCli([a, '--url', `${base}/target.html`], [
    // Switched, and somewhere else.
    ['[page log] [A] on /target.html', `open --noscript ${base}/other.html`],
    ['T1 runs no scripts from now on', 'eval location.pathname'],
    ['"/other.html"', 'open --noscript'],
    ['T1 already runs no scripts', `tabs new ${base}/target.html`],
    // A tab named, no page: its own page, back with the scripts.
    ['[T2] [page log] [A] on /target.html', 'open T1 --script'],
    ['T1 runs the scripts again', 'eval T1 location.pathname'],
    // reload with no tab named: the current one, T2.
    ['"/other.html"', 'reload --noscript'],
    ['T2 runs no scripts from now on', 'open --bogus'],
    ['has no --bogus flag', 'reload --bogus'],
    ['has no --bogus flag', 'tabs new --bogus'],
    ['has no --bogus flag', 'quit'],
  ]);
  expect(lines).toContain('[sm-dev] The open command has no --bogus flag');
  expect(lines).toContain('[sm-dev] The reload command has no --bogus flag');
  expect(lines).toContain('[sm-dev] The tabs new command has no --bogus flag');
  // T1 stayed on its page when switched back.
  expect(lines.filter((l) => l === '"/other.html"')).toHaveLength(2);
});

test('open all --noscript opens its tabs with none open', async ({ fixtureServer, scriptsDir }) => {
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: [`${fixtureServer.baseUrl}/target.html`] },
    body: `console.log('[A] on ' + location.pathname);`,
  });
  const lines = await driveCli([a, '--notab'], [
    ['No tabs are active', 'open all --noscript'],
    ['Opening', 'tabs'],
    ['Tabs:', 'quit'],
  ]);
  expect(lines.some((l) => /^[* ] T1: .*target\.html \(no scripts\)/.test(l))).toBe(true);
  expect(lines.some((l) => l.includes('[A] on'))).toBe(false);
});

test('a tab waiting on a dialog is left out of reload all, and blocks update', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const a = scriptsDir.write({ relativePath: 'a.user.js', meta: { name: 'A', match: ['*://*/target.html'] }, body: '' });
  const b = scriptsDir.write({
    relativePath: 'b.user.js', meta: { name: 'B', match: ['*://*/other.html'] }, body: `setTimeout(() => alert('Hi'), 100);`,
  });
  const lines = await driveCli([a, b, '--url', `${base}/target.html`], [
    ['Ready for commands', `tabs new ${base}/other.html`],
    ['opened an alert dialog', 'reload all'],
    // T1 still reloads; then update, which would reach T2, refuses.
    ['[sm-dev] A started on', () => { touch(b); return 'update 2'; }],
    ['is waiting on an alert dialog', 'quit'],
  ]);
  expect(lines).toContain('[sm-dev] T2 is waiting on a dialog, so it was not reloaded');
  // T2 is the current tab, having just been opened.
  expect(lines).toContain('[sm-dev] The page is waiting on an alert dialog. Type accept or dismiss first.');
  expect(lines.filter((l) => l.startsWith('[sm-dev] Reloading'))).toEqual([]);
});

test('--watch follows a loaded script, and a save reloads only its tabs', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const write = (name: string, page: string, word: string) => scriptsDir.write({
    relativePath: `${name.toLowerCase()}.user.js`,
    meta: { name, match: [`*://*/${page}`] },
    body: `console.log('[${name}] ${word}');`,
  });
  const a = write('A', 'target.html', 'one');
  const b = write('B', 'other.html', 'one');
  const lines = await driveCli([a, '--url', `${base}/target.html`, '--watch'], [
    ['Ready for commands', `tabs new ${base}/other.html`],
    ['The page commands now act on T2', `load ${b}`],
    ['[T2] [page log] [B] one', () => { write('B', 'other.html', 'two'); return ''; }],
    ['[T2] [page log] [B] two', 'quit'],
  ]);
  const saved = lines.indexOf('[sm-dev] Change detected, re-injecting');
  expect(saved).toBeGreaterThan(-1);
  expect(lines.slice(saved)).toContain('[sm-dev] Reloading T2');
  expect(lines.slice(saved).some((l) => l.includes('Reloading T1'))).toBe(false);
});

test('with no tab, load says nothing was reloaded', async ({ scriptsDir }) => {
  const a = scriptsDir.write({ relativePath: 'a.user.js', meta: { name: 'A', match: ['*://*/target.html'] }, body: '' });
  const b = scriptsDir.write({ relativePath: 'b.user.js', meta: { name: 'B', match: ['*://example.com/*'] }, body: '' });
  const lines = await driveCli([a, '--notab'], [
    ['Ready for commands', `load ${b}`],
    ['none was reloaded', 'quit'],
  ]);
  expect(lines).toContain('[sm-dev] No open tab matches it, so none was reloaded. Type open 2 to open its page.');
});

test('--watch re-injects on a save and reloads the tab it runs in', async ({ fixtureServer, scriptsDir }) => {
  const spec = (word: string) => ({
    relativePath: 'saved.user.js',
    meta: { name: 'Saved', match: ['*://*/target.html'] },
    body: `console.log('[saved] ${word}');`,
  });
  const file = scriptsDir.write(spec('before'));
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const done = run({
    files: [file], url: `${fixtureServer.baseUrl}/target.html`, watch: true, launch: true,
    collectionRoot: scriptsDir.path, localRoots: [], until,
    out: (line) => {
      lines.push(line);
      // Once the watcher is up; the page can log before it is.
      if (line.startsWith('[sm-dev] Watching')) scriptsDir.write(spec('after'));
      if (line === '[page log] [saved] after') stop();
    },
  });
  const timer = setTimeout(stop, 10000);
  await done.finally(() => clearTimeout(timer));
  expect(lines).toContain('[sm-dev] Change detected, re-injecting');
  expect(lines).toContain('[sm-dev] Reloading T1');
  expect(lines).toContain('[page log] [saved] after');
});
