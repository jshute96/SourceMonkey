// `sm-dev start` follows the tabs its tab opens: a `window.open` popup
// and a `GM_openInTab` tab both get the loaded scripts, and their
// lines carry the tab's name. Also `--all`'s tab per script, tabs
// closing (T1 included), and `menu` firing a command on another tab.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../fixtures/harness.js';
import { launchDebugBrowser } from '../fixtures/debug-browser.js';
import { run, type RunOptions } from '../../lib/harness/run.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

// Run until every `wanted` text has appeared in a line, or 10s.
// How long a run gets to print what a test waits for, launching its
// browser included. It stops as soon as the lines are in, so this only
// bounds a failure, and is generous for a loaded machine, under the
// 30s test timeout.
const RUN_DEADLINE_MS = 25_000;

async function runUntil(
  opts: Omit<RunOptions, 'out' | 'until' | 'tempBrowser' | 'localRoots'>,
  // Each a line's part, or a whole line's pattern.
  wanted: (string | RegExp)[],
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const done = run({
    ...opts,
    tempBrowser: true,
    localRoots: [],
    out: (line) => {
      lines.push(line);
      if (wanted.every((w) => lines.some((l) => (typeof w === 'string' ? l.includes(w) : w.test(l))))) stop();
    },
    until,
  });
  const timer = setTimeout(stop, RUN_DEADLINE_MS);
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
  // The start reports: an opened tab is set up after its first load's
  // console lines (see TODO.md).
  const wanted = ['started on http://127.0.0.1:PORT/other.html?via=open', 'started on http://127.0.0.1:PORT/other.html?via=gm']
    .map((w) => w.replace('http://127.0.0.1:PORT', fixtureServer.baseUrl));
  const done = run({
    files: [file],
    urls: [`${fixtureServer.baseUrl}/target.html`],
    tempBrowser: true,
    collectionRoot: scriptsDir.path,
    localRoots: [],
    out: (line) => {
      lines.push(line);
      if (wanted.every((w) => lines.some((l) => l.endsWith(w)))) stop();
    },
    until,
  });
  const timer = setTimeout(stop, RUN_DEADLINE_MS);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }

  expect(lines).toContain('[script log] [opener] on /target.html');
  // Numbered in the order they appear, which the two opens don't fix.
  const tabLine = (w: string) => lines.find((l) => /^\[T\d+\] \[event\] Opener /.test(l) && l.endsWith(w));
  expect(tabLine(wanted[0])).toBeDefined();
  expect(tabLine(wanted[1])).toBeDefined();
  expect(lines.filter((l) => /^\[T\d+\] \[event\] Tab opened at .*, from T1 \[targetId=[0-9A-F]{32}\]$/.test(l))).toHaveLength(2);
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
    '[script log] [A] on /target.html', '[T2] [script log] [B] on /other.html', '[T2] [script log] [D] on /other.html',
    `Skipped script 3, C (${scriptsDir.path}/c.user.js): Its @match names no page to open`,
  ]);
  // Each with the id a CDP session alongside can name the tab by.
  expect(lines.some((l) => new RegExp(`^\\[sm-dev\\] Opening ${base}/target\\.html in T1 \\[targetId=[0-9A-F]{32}\\]$`).test(l))).toBe(true);
  // B and D share one page, so one tab, announced once, after T1.
  const opening = lines.filter((l) => l.startsWith('[sm-dev] Opening'));
  expect(opening).toHaveLength(2);
  expect(opening[1]).toMatch(new RegExp(`^\\[sm-dev\\] Opening ${base}/other\\.html in T2 \\[targetId=[0-9A-F]{32}\\]$`));
  expect(lines.filter((l) => /Tab opened/.test(l))).toEqual([]);
  const skipped = lines.indexOf(`[sm-dev] Skipped script 3, C (${scriptsDir.path}/c.user.js): Its @match names no page to open`);
  expect(skipped).toBeGreaterThan(lines.indexOf(opening[1]));
});

test('run takes URLs among its scripts and flags, in any order, one tab each', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const file = scriptsDir.write({
    relativePath: 'both.user.js',
    meta: { name: 'Both', match: ['*://*/target.html', '*://*/other.html'] },
    body: `console.log('[both] on ' + location.pathname);`,
  });
  const lines = await driveCli([`${base}/target.html`, '--root', scriptsDir.path, file, `${base}/other.html`], [
    ['[T2] [script log] [both] on /other.html', 'exit'],
  ]);
  expect(lines.some((l) => l.startsWith(`[sm-dev] Opening ${base}/target.html in T1 `))).toBe(true);
  expect(lines.some((l) => l.startsWith(`[sm-dev] Opening ${base}/other.html in T2 `))).toBe(true);
  expect(lines).toContain('[script log] [both] on /target.html');
});

test('start with no scripts opens each URL given once, however often it is given', async ({ fixtureServer }) => {
  const base = fixtureServer.baseUrl;
  const lines = await driveCli([`${base}/target.html`, `${base}/other.html`, `${base}/target.html`], [
    ['Started as run', 'tabs'],
    ['Tabs:', 'exit'],
  ]);
  expect(lines.filter((l) => l.startsWith('[sm-dev] Opening '))).toHaveLength(2);
  expect(lines.some((l) => l.startsWith(`[sm-dev] Opening ${base}/other.html in T2 `))).toBe(true);
});

test('closing a followed tab and T1 is noticed, and the run carries on', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'closer.user.js',
    meta: { name: 'Closer', match: ['*://*/target.html', '*://*/other.html*'], grant: ['window.close'] },
    // A third tab stays open: the extension won't close a window's last.
    body: `
      if (location.pathname.endsWith('target.html')) {
        window.open('other.html?close');
        window.open('other.html?stay');
        setTimeout(() => window.close(), 3000);
      } else if (location.search === '?close') {
        // Once the run has found it.
        setTimeout(() => window.close(), 1500);
      }
    `,
  });
  const { code, lines } = await runUntil({
    files: [file], urls: [`${fixtureServer.baseUrl}/target.html`], collectionRoot: scriptsDir.path,
  }, [/^\[event\] Tab closed$/]);
  // T2 or T3, whichever opened first.
  expect(lines.filter((l) => /^\[T[23]\] \[event\] Tab closed$/.test(l)), lines.join('\n')).toHaveLength(1);
  expect(lines, lines.join('\n')).toContain('[event] Tab closed');
  expect(code).toBe(0);
});

test('a page sandboxed by its CSP header gets a note naming the page-context scripts, which run isolated', async ({ fixtureServer, scriptsDir }) => {
  const main = scriptsDir.write({
    relativePath: 'page-world.user.js',
    meta: { name: 'PageWorld', match: ['*://*/*'], grant: ['none'] },
    body: `console.log('[page-world] ran');`,
  });
  const content = scriptsDir.write({
    relativePath: 'content-world.user.js',
    meta: { name: 'ContentWorld', match: ['*://*/*'], grant: ['none'], extra: ['// @inject-into content'] },
    body: `console.log('[content-world] ran');`,
  });
  const { lines } = await runUntil({
    files: [main, content], urls: [`${fixtureServer.baseUrl}/__sandbox/target.html`], collectionRoot: scriptsDir.path,
  }, ['sandboxes it', '[content-world] ran', '[page-world] ran']);
  const note = lines.find((l) => l.includes('sandboxes it'));
  expect(note).toBe(
    `[sm-dev] This page's Content-Security-Policy header sandboxes it without allow-scripts, so SourceMonkey runs ` +
    `these scripts in the isolated context instead: ${scriptsDir.path}/page-world.user.js.`,
  );
  // Both run: the page-context one isolated.
  expect(lines).toContain('[script log] [content-world] ran');
  expect(lines).toContain('[script log] [page-world] ran');
});

test('--notab opens no tab, and no scripts open a blank page or the URL given', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'quiet.user.js',
    meta: { name: 'Quiet', match: ['*://*/target.html'] },
    body: `console.log('[quiet] ran');`,
  });
  const noTab: string[] = [];
  const code = await run({
    files: [file], noTab: true, tempBrowser: true, collectionRoot: scriptsDir.path, localRoots: [], out: (l) => noTab.push(l),
  });
  expect(code).toBe(0);
  expect(noTab.some((l) => l.startsWith('[sm-dev] Opening'))).toBe(false);

  const target = `${fixtureServer.baseUrl}/target.html`;
  const { code: noScriptCode, lines } = await runUntil({ files: [], urls: [target], collectionRoot: scriptsDir.path }, [
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
  // The line's own flags go first.
  const at = args.indexOf('--root');
  const root = at >= 0 ? args.splice(at, 2) : [];
  const child = spawn(process.execPath, [cli, '--stdin', ...root, 'start', ...args, '--stop-after-seconds', '25'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    ['Started as run', 'status'],
    ['1: Hello (', `newtab ${target}`],
    ['[script log] [hello] on /target.html', 'exit'],
  ]);
  expect(lines).toContain('[sm-dev] No tabs are active. Use `newtab` to open one.');
  expect(lines.some((l) => l.startsWith(`[sm-dev] Opening ${target} in T1 [targetId=`))).toBe(true);
  // Both the page's lines and the harness's own, without a [T1] prefix.
  expect(lines).toContain('[script log] [hello] on /target.html');
  expect(lines).toContain(`[event] Hello started on ${target}`);
  expect(lines.some((l) => l.startsWith('[T1]'))).toBe(false);
});

test('a followed tab keeps its menu commands, and menu fires them there', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'menu.user.js',
    meta: { name: 'Menu', match: ['*://*/target.html', '*://*/other.html'], grant: ['GM_registerMenuCommand'] },
    body: `
      if (location.pathname.endsWith('target.html')) window.open('other.html');
      else GM_registerMenuCommand('Only here', () => console.log('[menu] fired on ' + location.pathname));
    `,
  });
  const lines = await driveCli([file, `${fixtureServer.baseUrl}/target.html`], [
    ['[T2] [event] Menu started on', 'menu T2.Only here'],
    ['[T2] [script log] [menu] fired on /other.html', 'exit'],
  ]);
  expect(lines).toContain('[sm-dev] Fired "Only here"');
  expect(lines).toContain('[T2] [script log] [menu] fired on /other.html');
});

test('start with no scripts: a blank page, and the lists say there are no scripts', async () => {
  const lines = await driveCli([], [
    ['Started as run', 'status'],
    ['No scripts are loaded', 'exit'],
  ]);
  // The tab as it opened, blank: nothing to open.
  expect(lines.some((l) => l.startsWith('[event] Tab opened [targetId='))).toBe(true);
  expect(lines.some((l) => l.startsWith('[sm-dev] Opening'))).toBe(false);
  expect(lines.some((l) => /^\* T1: about:blank \[targetId=/.test(l))).toBe(true);
  expect(lines).toContain('  No scripts are loaded');
});

test('start, update and load give a page --timeout-seconds to load', async ({ fixtureServer, scriptsDir }) => {
  // Its image holds load back for 5 seconds.
  const page = `${fixtureServer.baseUrl}/stalled-load.html`;
  const write = (name: string) => scriptsDir.write({
    relativePath: `${name.toLowerCase()}.user.js`,
    meta: { name, match: [page] },
    body: `console.log('[${name}] on');`,
  });
  const a = write('A');
  const b = write('B');
  const lines = await driveCli([a, page, '--timeout-seconds', '1'], [
    ['did not finish loading within 1s', () => { touch(a); return 'update --timeout-seconds 1'; }],
    ['T1 could not be reloaded', `load ${b} --timeout-seconds 1`],
    ['T1 could not be reloaded', 'exit'],
  ]);
  expect(lines).toContain('[sm-dev] Navigation failed: The page did not finish loading within 1s');
  expect(lines.filter((l) => l === '[sm-dev] T1 could not be reloaded: The page did not finish loading within 1s')).toHaveLength(2);
});

test('a script running only in an iframe: its lines name the frame, a frame\'s stackless error is the page\'s, and update reloads its tab', async ({ fixtureServer, scriptsDir }) => {
  // The frames example's Frame B, which the page itself doesn't match.
  const file = scriptsDir.write({
    relativePath: 'in-frame.user.js',
    meta: { name: 'In frame', match: ['*://*/frames/frame-b.html'] },
    body: `console.log('[in-frame] on ' + location.pathname);`,
  });
  const lines = await driveCli([file, `${fixtureServer.baseUrl}/frames/frames.html`], [
    ['[event] In frame started in an iframe on', 'status'],
    // A stackless error in a frame no script runs in is the page's.
    ['Active on T1 (F', 'eval --frame F3 --page setTimeout(() => { Promise.reject(\'stackless\') }); \'rejected\''],
    ['"rejected"', 'wait log --log-source page stackless'],
    ['Wait matched', 'logs --log-source page --find stackless'],
    ['[page error] stackless', () => { touch(file); return 'update 1'; }],
    ['[sm-dev] Reloading T1', 'exit'],
  ]);
  // Frame B is F2 (Frame A is F1, B's nested frame F3).
  expect(lines).toContain('[T1.F2] [script log] [in-frame] on /frames/frame-b.html');
  expect(lines.some((l) => / T1\.F3 \[page error\] stackless$/.test(l))).toBe(true);
  expect(lines.some((l) => /^\[T1\.F\d+\] \[event\] In frame started in an iframe on http:\/\/\S+\/frames\/frame-b\.html$/.test(l))).toBe(true);
  expect(lines.some((l) => /^\* T1: \S+\/frames\/frames\.html \(\+3 frames\)/.test(l))).toBe(true);
  expect(lines.some((l) => /^ {5}Active on T1 \(F\d+\)$/.test(l))).toBe(true);
});

test('a stackless error is the script\'s only where one could have thrown it', async ({ fixtureServer, scriptsDir }) => {
  const page = `${fixtureServer.baseUrl}/target.html`;
  const isolated = scriptsDir.write({
    relativePath: 'isolated.user.js',
    meta: { name: 'Isolated', match: [page], grant: ['GM_getValue'], injectInto: 'content' },
    body: `setTimeout(() => { Promise.reject('isolated-own') });`,
  });
  const pageWorld = scriptsDir.write({
    relativePath: 'page-world.user.js',
    meta: { name: 'PageWorld', match: [page], grant: ['none'] },
    body: `console.log('[page-world] on');`,
  });
  const reject = (text: string) => `eval --page setTimeout(() => { Promise.reject('${text}') }); 'rejected'`;
  const lines = await driveCli([isolated, page], [
    ['[script error] isolated-own', reject('page-own')],
    // Page errors aren't in the run's output by default.
    ['"rejected"', 'wait log --log-source page page-own'],
    ['Wait matched', 'logs --log-source page --find page-own'],
    ['[page error] page-own', `load ${pageWorld}`],
    // With a script in the page's world, there's no telling whose.
    ['[page-world] on', reject('either')],
    ['[script error] either', 'exit'],
  ]);
  expect(lines.some((l) => / T1 \[page error\] page-own$/.test(l))).toBe(true);
  expect(lines.some((l) => l.endsWith('[script error] page-own'))).toBe(false);
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
  const lines = await driveCli([a, `${base}/target.html`], [
    ['Started as run', `newtab ${base}/other.html`],
    ['The page commands now act on T2', `load ${b}`],
    // B matches only T2's page.
    ['[T2] [script log] [B] on /other.html', 'scripts 2'],
    ['Selected B', 'set k 1'],
    ['Set k', 'update 1'],
    // Untouched, so nothing to do; touched, only A's tab reloads.
    ["hasn't changed on disk", () => { touch(a); return 'update all'; }],
    ['[script log] [A] on /target.html', 'scripts'],
    ['Loaded scripts (', 'get k'],
    ['k = 1', `load ${b}`],
    // A directory: its scripts, both loaded already.
    ['is already loaded', `load ${scriptsDir.path}`],
    ['already loaded, as script 1', 'load nothing.user.js'],
    ['No such file or directory', () => { write('B', 'other.html', 'syntax error here('); return 'update 2'; }],
    ['INVALID', 'reload all'],
    ['[script log] [A] on /target.html', 'exit'],
  ]);
  expect(lines).toContain(`[sm-dev] Loaded ${b} as script 2`);
  expect(lines).toContain('[sm-dev] Reloading T2');
  expect(lines).toContain("[sm-dev] Script 1 hasn't changed on disk, so nothing was reloaded");
  // `update all` after touching A: only its tab, and the selection and
  // stored value are kept.
  expect(lines).toContain('[sm-dev] Reloading T1');
  expect(lines).not.toContain('[sm-dev] Reloading T1, T2');
  expect(lines).toContain(`* 2: B (${scriptsDir.path}/b.user.js)`);
  expect(lines).toContain('  k = 1');
  expect(lines).toContain(`[sm-dev] ${b} is already loaded, as script 2. Use \`update 2\` to re-read it.`);
  expect(lines).toContain(`[sm-dev] ${a} is already loaded, as script 1. Use \`update 1\` to re-read it.`);
  // Once for `load ${b}`, once for the directory.
  expect(lines.filter((l) => l === `[sm-dev] ${b} is already loaded, as script 2. Use \`update 2\` to re-read it.`)).toHaveLength(2);
  expect(lines).toContain('[sm-dev] No such file or directory: nothing.user.js');
  // The failed update changed nothing, so reloaded nothing.
  const invalid = lines.findIndex((l) => l.startsWith('INVALID'));
  expect(lines.slice(invalid).filter((l) => l.startsWith('[sm-dev] Reloading'))).toEqual([]);
  // `reload all` reloaded both tabs.
  expect(lines.slice(invalid).filter((l) => l.endsWith('[script log] [A] on /target.html'))).toHaveLength(1);
  expect(lines.slice(invalid).filter((l) => l.endsWith('[T2] [script log] [B] on /other.html'))).toHaveLength(1);
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
  const lines = await driveCli([a, `${base}/target.html`], [
    ['Started as run', `newtab --noscript ${base}/target.html`],
    ['The page commands now act on T2', 'eval T2 window.open("other.html"), "opened"'],
    // Its popup is a tab without scripts too.
    ['[T3] [event] Tab opened', `load ${b}`],
    // Only T1 runs scripts, so only it reloads.
    ['[script log] [B] on /target.html', `savehtml T2 ${saved}`],
    ['Wrote', 'exit'],
  ]);
  expect(lines.some((l) => /^\[T3\] \[event\] Tab opened at .*other\.html \(no scripts\), from T2 /.test(l))).toBe(true);
  expect(lines).toContain('[sm-dev] Reloading T1');
  expect(lines.some((l) => /Reloading .*T[23]/.test(l))).toBe(false);
  // Nothing ran in T2 or T3, and savehtml there has no scripts' changes
  // to warn of.
  expect(lines.filter((l) => /^\[T[23]\] .*\[(A|B)\] on/.test(l))).toEqual([]);
  expect(lines.some((l) => l.includes('It has the scripts\' changes'))).toBe(false);
  expect(existsSync(saved)).toBe(true);
});

test('open --noscript switches a tab to no scripts for good, and --script back', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    // A page of its own, for newtab all to open.
    meta: { name: 'A', match: [`${base}/target.html`] },
    body: `console.log('[A] on ' + location.pathname);`,
  });
  const lines = await driveCli([a, `${base}/target.html`], [
    ['[script log] [A] on /target.html', 'open --noscript'],
    ['runs no scripts from now on', 'tabs'],
    // The script stays out: a reload loads without it. (Through eval,
    // for a line to wait on: a reload with no scripts prints nothing.)
    ['(no scripts)', 'eval location.reload(), "reloading"'],
    // Once it's reloaded: an eval in the old page or the new one says
    // something either way.
    ['"reloading"', 'eval new Promise((r) => setTimeout(r, 1000)).then(() => document.readyState)'],
    ['', () => { touch(a); return 'update'; }],
    ['none was reloaded', 'open --script'],
    ['runs the scripts again', 'eval new Promise((r) => setTimeout(r, 1500)).then(() => "waited")'],
    ['"waited"', 'newtab all --noscript'],
    ['Opening', 'newtab --noscript 1'],
    ['The page commands now act on T3', 'tabs'],
    // reload switches too: every tab back to scripts, then T1 off.
    ['Tabs:', 'reload all --script'],
    ['[T3] [script log] [A] on /target.html', 'reload T1 --noscript'],
    // newtab takes --script too: a new tab's usual mode, said out.
    ['T1 runs no scripts from now on', `newtab --script ${base}/target.html`],
    ['[T4] [script log] [A] on /target.html', 'newtab --script --noscript'],
    ['not both', 'exit'],
  ]);
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  // Between switching off and back on, the script didn't run.
  const off = at('runs no scripts from now on');
  const on = at('runs the scripts again');
  expect(lines.slice(off, on).filter((l) => l.includes('[A] on'))).toEqual([]);
  expect(lines.slice(on).filter((l) => l === '[script log] [A] on /target.html').length).toBeGreaterThan(0);
  const row = lines.findIndex((l) => /^\* T1: .*target\.html \(no scripts\)/.test(l));
  expect(row).toBeGreaterThan(0);
  // And lists no script as running there.
  expect(lines[row + 1]).not.toMatch(/^ +\*? *1: A/);
  // update left the switched tab alone.
  expect(lines).toContain('[sm-dev] No open tab runs or matches the updated scripts, so none was reloaded');
  // newtab all --noscript: the script's page, in a tab without scripts.
  expect(lines.some((l) => /^ {2}T2: .*target\.html \(no scripts\)/.test(l))).toBe(true);
  // newtab --noscript with a script's number: its page, without it.
  expect(lines.some((l) => /^\* T3: .*target\.html \(no scripts\)/.test(l))).toBe(true);
  // reload all --script: T2 and T3 switched back, and the script ran
  // in both.
  const back = at('reload') >= 0 ? lines.findIndex((l) => l === '[sm-dev] T2 runs the scripts again') : -1;
  expect(back).toBeGreaterThan(0);
  expect(lines.slice(back)).toContain('[sm-dev] T3 runs the scripts again');
  expect(lines.slice(back)).toContain('[T2] [script log] [A] on /target.html');
  expect(lines).toContain('[T4] [script log] [A] on /target.html');
  expect(lines).toContain('[sm-dev] ERROR: The `newtab` command takes --noscript or --script, not both');
});

test('open and reload switch the tab they name, or the current one, and say when nothing changes', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: [`${base}/target.html`] },
    body: `console.log('[A] on ' + location.pathname);`,
  });
  const lines = await driveCli([a, `${base}/target.html`], [
    // Switched, and somewhere else.
    ['[script log] [A] on /target.html', `open --noscript ${base}/other.html`],
    ['T1 runs no scripts from now on', 'eval location.pathname'],
    ['"/other.html"', 'open --noscript'],
    ['T1 already runs no scripts', `newtab ${base}/target.html`],
    // A tab named, no page: its own page, back with the scripts.
    ['[T2] [script log] [A] on /target.html', 'open T1 --script'],
    ['T1 runs the scripts again', 'eval T1 location.pathname'],
    // A tab named, then a page.
    ['"/other.html"', `open T1 ${base}/target.html#t1`],
    ['[A] on /target.html', 'eval T1 location.hash'],
    // reload with no tab named: the current one, T2.
    ['"#t1"', 'reload --noscript'],
    // A mistake, found before it is sent, stops the piped commands.
    ['T2 runs no scripts from now on', 'open --bogus'],
  ]);
  expect(lines).toContain('ERROR: The `open` command has no --bogus flag. It takes --noscript, --script, --timeout-seconds, --from-saved, --url, --offline, --nowait.');
  expect(lines).toContain('That command failed, so the commands after it were not run');
  // T1 stayed on its page when switched back.
  expect(lines.filter((l) => l === '"/other.html"')).toHaveLength(2);
});

test('newtab all --noscript opens its tabs with none open', async ({ fixtureServer, scriptsDir }) => {
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: [`${fixtureServer.baseUrl}/target.html`] },
    body: `console.log('[A] on ' + location.pathname);`,
  });
  const lines = await driveCli([a, '--notab'], [
    ['No tabs are active', 'newtab all --noscript'],
    ['Opening', 'tabs'],
    ['Tabs:', 'exit'],
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
  const lines = await driveCli([a, b, `${base}/target.html`], [
    ['Started as run', `newtab ${base}/other.html`],
    ['opened an alert dialog', 'reload all'],
    // T1 still reloads; then update, which would reach T2, refuses.
    ['[event] A started on', () => { touch(b); return 'update 2'; }],
    ['is waiting on an alert dialog', 'exit'],
  ]);
  expect(lines).toContain('[sm-dev] T2 is waiting on a dialog, so it was not reloaded');
  // T2 is the current tab, having just been opened.
  expect(lines).toContain('[sm-dev] The page is waiting on an alert dialog. Use `accept` or `dismiss` first.');
  expect(lines.filter((l) => l.startsWith('[sm-dev] Reloading'))).toEqual([]);
  // `reload all` began with the dialog up, so it ends with a reminder;
  // `update` named it already in refusing, so it doesn't repeat it.
  expect(lines.filter((l) => l === '[sm-dev] *DIALOG* still waiting: The page is showing an alert dialog. Answer using `accept` or `dismiss`.'))
    .toHaveLength(1);
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
  const lines = await driveCli([a, `${base}/target.html`, '--watch'], [
    ['Started as run', `newtab ${base}/other.html`],
    ['The page commands now act on T2', `load ${b}`],
    ['[T2] [script log] [B] one', () => { write('B', 'other.html', 'two'); return ''; }],
    ['[T2] [script log] [B] two', 'exit'],
  ]);
  const saved = lines.indexOf('[sm-dev] Change detected, re-pushing');
  expect(saved).toBeGreaterThan(-1);
  expect(lines.slice(saved)).toContain('[sm-dev] Reloading T2');
  expect(lines.slice(saved).some((l) => l.includes('Reloading T1'))).toBe(false);
});

test('with no tab, load says nothing was reloaded', async ({ scriptsDir }) => {
  const a = scriptsDir.write({ relativePath: 'a.user.js', meta: { name: 'A', match: ['*://*/target.html'] }, body: '' });
  const b = scriptsDir.write({ relativePath: 'b.user.js', meta: { name: 'B', match: ['*://example.com/*'] }, body: '' });
  const lines = await driveCli([a, '--notab'], [
    ['Started as run', `load ${b}`],
    ['none was reloaded', 'exit'],
  ]);
  expect(lines).toContain('[sm-dev] No open tab matches it, so none was reloaded. Use `open 2` to open its page.');
});

test('--watch re-pushes on a save and reloads the tab it runs in', async ({ fixtureServer, scriptsDir }) => {
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
    files: [file], urls: [`${fixtureServer.baseUrl}/target.html`], watch: true, tempBrowser: true,
    collectionRoot: scriptsDir.path, localRoots: [], until,
    out: (line) => {
      lines.push(line);
      // Once the watcher is up; the page can log before it is.
      if (line.startsWith('[sm-dev] Watching')) scriptsDir.write(spec('after'));
      if (line === '[script log] [saved] after') stop();
    },
  });
  const timer = setTimeout(stop, RUN_DEADLINE_MS);
  await done.finally(() => clearTimeout(timer));
  expect(lines).toContain('[sm-dev] Change detected, re-pushing');
  expect(lines).toContain('[sm-dev] Reloading T1');
  expect(lines).toContain('[script log] [saved] after');
});

test('--from-saved serves a saved page at its URL, and the scripts match it', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: ['*://*/target.html'], extra: ['// @version     1.2.0'] },
    body: `console.log('[A] on ' + location.pathname + ' titled ' + document.title);`,
  });
  const plain = path.join(scriptsDir.path, 'plain.html');
  const scripted = path.join(scriptsDir.path, 'scripted.html');
  const lines = await driveCli([a, `${base}/target.html`], [
    ['Started as run', `savehtml ${scripted}`],
    ['Wrote', `newtab --noscript ${base}/target.html`],
    ['The page commands now act on T2', 'eval document.title = "as saved"'],
    ['"as saved"', `savehtml ${plain}`],
    ['Wrote', `newtab --from-saved ${plain}`],
    // The scripts match it by its URL, and run on the saved copy.
    ['[T3] [script log] [A] on /target.html titled as saved', 'tabs'],
    ['Tabs:', 'status'],
    ['Scripts (with status on active tab T3)', () => {
      writeFileSync(plain, readFileSync(plain, 'utf8').replace('as saved', 'edited'));
      return 'reload';
    }],
    // Read again from disk on each load.
    ['titled edited', 'tab T1'],
    ['now act on T1', `open ${scripted} --from-saved`],
    ['[script log] [A] on /target.html titled target', 'exit'],
  ]);
  const header = readFileSync(scripted, 'utf8').split('\n').slice(0, 3);
  expect(header).toEqual([
    '<!DOCTYPE html>',
    `<!-- saved from url=(${String(`${base}/target.html`.length).padStart(4, '0')})${base}/target.html -->`,
    '<!-- SourceMonkey: userscript active: A 1.2.0 -->',
  ]);
  expect(readFileSync(plain, 'utf8')).not.toContain('SourceMonkey: userscript active');
  expect(lines.some((l) => /^\[sm-dev\] Opening \S*plain\.html as http\S*\/target\.html in T3 \[targetId=/.test(l))).toBe(true);
  expect(lines.filter((l) => /^\* T3: \S*\/target\.html \(from saved: \/\S*plain\.html\)/.test(l))).toHaveLength(2);
  // Saved with A running, so opening it says A's changes are in it.
  expect(lines.some((l) => /^\[sm-dev\] .*scripted\.html was saved with userscripts running, so their changes are already in it: A 1\.2\.0$/.test(l))).toBe(true);
  expect(lines.filter((l) => l.includes('was saved with userscripts running'))).toHaveLength(1);
});

test('start --from-saved opens T1 on the saved page, and --offline blocks the rest', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const url = `${base}/target.html`;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: ['*://*/target.html'] },
    body: `console.log('[A] on ' + location.pathname + ' titled ' + document.title);`,
  });
  // As Chrome's Save Page As writes one.
  const file = path.join(scriptsDir.path, 'chrome.html');
  writeFileSync(file, `<!DOCTYPE html>\n<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n<html><head><title>from chrome</title></head><body></body></html>`);
  const lines = await driveCli([a, '--from-saved', file, '--offline'], [
    ['[script log] [A] on /target.html titled from chrome', 'eval fetch("other.html").then(() => "fetched", () => "blocked")'],
    ['"blocked"', 'exit'],
  ]);
  expect(lines.some((l) => /Opening .*chrome\.html as .*\/target\.html in T1/.test(l))).toBe(true);
});

test('a saved page that times out on the live site\'s files suggests --offline', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const url = `${base}/target.html`;
  const a = scriptsDir.write({ relativePath: 'a.user.js', meta: { name: 'A', match: ['*://*/target.html'] }, body: '' });
  // Its script is a live-site file that answers too late.
  const file = path.join(scriptsDir.path, 'slow.html');
  writeFileSync(file, `<!DOCTYPE html>\n<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n<html><head><script src="${base}/__slow/x.js?ms=3000"></script></head><body></body></html>`);
  const lines = await driveCli([a, `${base}/target.html`], [
    ['Started as run', `open --from-saved '${file}' --timeout-seconds 0.5`],
    ['--from-saved --offline to block', 'exit'],
  ]);
  expect(lines).toContain('[sm-dev] Navigation failed: The page did not finish loading within 0.5s. '
    + 'The saved page still loads its images, scripts and styles from the live site. Open it with --from-saved --offline to block those.');
});

test('--from-saved lasts for its URL only, --offline lets links out, and a missing file is said', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const url = `${base}/target.html`;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: ['*://*/target.html', '*://*/other.html'] },
    body: `console.log('[A] on ' + location.pathname + ' titled ' + document.title);`,
  });
  // A space in its name, as a browser's own saves have, so typed it's quoted.
  const file = path.join(scriptsDir.path, 'saved page.html');
  writeFileSync(file, `<!DOCTYPE html>\n<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n<html><head><title>saved</title></head><body></body></html>`);
  const lines = await driveCli([a, url], [
    ['Started as run', `open --from-saved '${file}' --offline`],
    ['[A] on /target.html titled saved', 'eval fetch("other.html").then(() => "fetched", () => "blocked")'],
    // A new page in the tab isn't blocked, and loads live.
    ['"blocked"', `open ${base}/other.html`],
    ['[A] on /other.html', 'eval fetch("other.html").then(() => "fetched", () => "blocked")'],
    // Back at its URL, the file again.
    ['"fetched"', `open ${url}`],
    ['[A] on /target.html titled saved', 'eval window.open("target.html"), "opened"'],
    // A tab it opens gets the live page. (Its first load's console
    // lines aren't shown, so its title is asked.)
    ['[T2] [event] A started on', 'eval T2 document.title'],
    ['"target"', () => {
      unlinkSync(file);
      return 'reload T1';
    }],
    // A mistake ends the commands, so it goes last.
    ['No such file or directory', `open ${url} --from-saved`],
  ]);
  expect(lines).toContain('[sm-dev] ERROR: The --from-saved flag opens .html files, and none was given');
  expect(lines).toContain(`[sm-dev] No such file or directory: ${file}`);
});

test('--from-saved opens every .html file a glob matches, beside live URLs, and --url serves one elsewhere', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: ['*://*/target.html', '*://*/other.html'] },
    body: `console.log('[A] on ' + location.pathname + ' titled ' + document.title);`,
  });
  const save = (name: string, url: string | null, title: string): string => {
    const file = path.join(scriptsDir.path, name);
    const header = url ? `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n` : '';
    writeFileSync(file, `<!DOCTYPE html>\n${header}<html><head><title>${title}</title></head><body></body></html>`);
    return file;
  };
  save('multi one.html', `${base}/target.html`, 'one');
  save('multi two.html', `${base}/other.html`, 'two');
  const bare = save('bare.html', null, 'bare');
  const lines = await driveCli([a, '--notab'], [
    ['Started as run', `newtab '${scriptsDir.path}/multi*.html' ${base}/target.html --from-saved`],
    // Each in a tab of its own, in order: the two files, then the live page.
    ['[T3] [script log] [A] on /target.html titled target', 'tabs'],
    ['Tabs:', `newtab ${bare} --from-saved --url ${base}/other.html`],
    ['[T4] [script log] [A] on /other.html titled bare', 'exit'],
  ]);
  expect(lines).toContain('[script log] [A] on /target.html titled one');
  expect(lines).toContain('[T2] [script log] [A] on /other.html titled two');
  expect(lines.filter((l) => /^ {2}T\d: .*\(from saved: /.test(l) || /^\* T\d: .*\(from saved: /.test(l))).toHaveLength(2);
});

test('newtab of several saved pages picks the first, serves their _files folders, and shows offline', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const a = scriptsDir.write({
    relativePath: 'a.user.js',
    meta: { name: 'A', match: ['*://*/target.html', '*://*/other.html'] },
    body: `console.log('[A] on ' + location.pathname + ' titled ' + document.title);`,
  });
  const save = (name: string, url: string): void => {
    writeFileSync(path.join(scriptsDir.path, `${name}.html`), [
      '<!DOCTYPE html>',
      `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->`,
      `<html><head><title>${name}</title><link rel="stylesheet" href="./${name}_files/s.css"></head><body></body></html>`,
    ].join('\n'));
    mkdirSync(path.join(scriptsDir.path, `${name}_files`));
    writeFileSync(path.join(scriptsDir.path, `${name}_files`, 's.css'), 'body { color: rgb(1, 2, 3); }');
  };
  save('x one', `${base}/target.html`);
  save('x two', `${base}/other.html`);
  const lines = await driveCli([a, `${base}/target.html`], [
    ['Started as run', `newtab '${scriptsDir.path}/x *.html' --from-saved --offline`],
    ['[T3] [script log] [A] on /other.html titled x two', 'status'],
    // The first new tab is the current one.
    ['Scripts (with status on active tab T2)', 'eval T2 getComputedStyle(document.body).color'],
    // Served from the folder beside the file, though offline.
    ['"rgb(1, 2, 3)"', 'exit'],
  ]);
  expect(lines.some((l) => /^\* T2: \S*\/target\.html \(from saved: .*x one\.html, offline\)/.test(l))).toBe(true);
});

test('a request to an undeclared host reports SourceMonkey\'s prompt, and connect answers it', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  // The same server under another host name: cross-origin, undeclared.
  const other = base.replace('127.0.0.1', 'localhost');
  const file = scriptsDir.write({
    relativePath: 'asks.user.js',
    meta: { name: 'Asks', match: ['*://*/target.html'], grant: ['GM_xmlhttpRequest'] },
    body: `GM_xmlhttpRequest({ url: '${other}/other.html', onload: (r) => console.log('[asks] got ' + r.status) });`,
  });
  const lines = await driveCli([file, `${base}/target.html`], [
    ['*PERMISSION PROMPT*', 'status'],
    ['still waiting', 'connect allow'],
    ['[script log] [asks] got 200', 'exit'],
  ]);
  expect(lines).toContain(
    `[event] *PERMISSION PROMPT*: Asks requests permission to connect to localhost (GET ${other}/other.html). Answer using connect once|cancel|allow|deny|allow-all.`,
  );
  // `status` lists it under the script, and the command ends with a
  // reminder, since it was waiting when the command began.
  expect(lines.some((l) => l.includes(`*PERMISSION PROMPT* waiting: localhost (GET ${other}/other.html). Answer using \`connect\`.`))).toBe(true);
  expect(lines).toContain(
    '[sm-dev] *PERMISSION PROMPT* still waiting: Asks requests permission to connect to localhost. Answer using `connect once|cancel|allow|deny|allow-all`.',
  );
  expect(lines).toContain('[sm-dev] Allowed localhost for Asks');
  // Answered: the reminder stops.
  expect(lines.slice(lines.indexOf('[sm-dev] Allowed localhost for Asks')).some((l) => l.includes('still waiting'))).toBe(false);
  // The prompt's own Log entry would only repeat the line above.
  expect(lines.some((l) => l.includes('Opened permission request window'))).toBe(false);
});

test('--lang sets the languages of each tab, in a launched browser and in one connected to', async ({ fixtureServer, scriptsDir }) => {
  test.setTimeout(60_000);
  // `xhrHeader`: a GM_xmlhttpRequest, sent from Node, asks for the same
  // languages as the tab's own request.
  const file = scriptsDir.write({
    relativePath: 'lang.user.js',
    meta: { name: 'Lang', match: ['*://*/target.html*'], grant: ['GM_xmlhttpRequest'], connect: ['127.0.0.1'] },
    body: `
      const echo = (url) => new Promise((resolve) => GM_xmlhttpRequest({ url, responseType: 'json', onload: (r) => resolve(r.response) }));
      Promise.all([fetch('/__echo').then((r) => r.json()), echo(location.origin + '/__echo')]).then(([page, xhr]) => {
        console.log('[lang] ' + location.search + ' ' + JSON.stringify({
          languages: navigator.languages,
          intl: Intl.DateTimeFormat().resolvedOptions().locale,
          header: page.headers['accept-language'],
          xhrHeader: xhr.headers['accept-language'],
        }));
      });
    `,
  });
  const urls = [`${fixtureServer.baseUrl}/target.html?one`, `${fixtureServer.baseUrl}/target.html?two`];
  // Two tabs: T1, and T2 the run opens itself.
  const wanted = ['[lang] ?one ', '[lang] ?two '];
  // The extension's request asks as the browser does, not the tab:
  // `xhr` is what it should carry.
  const expectLangs = (lines: string[], where: string, xhr: unknown): void => {
    for (const w of wanted) {
      const line = lines.find((l) => l.includes(w));
      expect(line, `${w} in ${where}`).toBeDefined();
      const got = JSON.parse(line!.slice(line!.indexOf('{')));
      expect(got).toEqual({
        languages: ['zh-CN', 'en'], intl: 'zh-CN', header: expect.stringMatching(/^zh-CN,en/),
        xhrHeader: xhr,
      });
    }
  };

  // A launched browser, from the command line: in this process,
  // Playwright's test runner would give the browser a locale of its own.
  const cli = await new Promise<string>((resolve) => {
    execFile(process.execPath, [CLI, '--root', scriptsDir.path, 'start', '--lang', 'zh-cn,en', file, ...urls, '--', 'wait', 'log', '[lang] ?two'],
      (_err, stdout, stderr) => resolve(stdout + stderr));
  });
  // A launched one's flags, which Chrome expands (`zh-CN,zh;q=0.9,en;q=0.8`).
  expectLangs(cli.split('\n'), 'a launched browser', expect.stringMatching(/^zh-CN,/));

  // A browser the run connects to, as a shared one.
  const shared = await launchDebugBrowser();
  const port = shared.port;
  try {
    const lines: string[] = [];
    let stop!: () => void;
    const until = new Promise<void>((resolve) => { stop = resolve; });
    const done = run({
      files: [file],
      urls,
      cdp: String(port),
      lang: ['zh-CN', 'en'],
      collectionRoot: scriptsDir.path,
      localRoots: [],
      out: (line) => {
        lines.push(line);
        if (wanted.every((w) => lines.some((l) => l.includes(w)))) stop();
      },
      until,
    });
    const timer = setTimeout(stop, 15000);
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
    // A connected one's own languages.
    expectLangs(lines, 'a connected browser', expect.any(String));
  } finally {
    await shared.close();
  }
});

test('a manual script waits to be run, again after going back, and not in a tab without scripts', async ({ fixtureServer, scriptsDir }) => {
  const base = fixtureServer.baseUrl;
  const m = scriptsDir.write({
    relativePath: 'm.user.js',
    meta: { name: 'M', match: [`${base}/target.html`], runAt: 'context-menu' },
    body: `console.log('[M] ran on ' + location.pathname);`,
  });
  // Each awaited result is built up, so the echoed command doesn't match it.
  const lines = await driveCli([m, `${base}/target.html`], [
    ['is waiting to be run', 'menu M1'],
    ['[M] ran on /target.html', `eval location.href = "${base}/other.html", "aw" + "ay"`],
    ['"away"', 'eval setTimeout(() => history.back(), 500), "go" + "ing"'],
    // Back on target.html (a back/forward navigation), it's waiting again.
    ['is waiting to be run', 'menu'],
    ['M1: Run this script', `newtab --noscript ${base}/target.html`],
    ['The page commands now act on T2', 'eval new Promise((r) => setTimeout(r, 1000)).then(() => "sett" + "led")'],
    ['"settled"', 'menu T2'],
    ['No menu commands', 'exit'],
  ]);
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  // Waiting again once back on the page, with Run listed.
  expect(lines.slice(at('"going"')).some((l) => l.includes('M1: Run this script'))).toBe(true);
  // Nothing about it in the tab without scripts.
  expect(lines.filter((l) => l.startsWith('[T2]') && l.includes('is waiting to be run'))).toEqual([]);
  expect(lines.slice(at('"settled"')).some((l) => l.includes('No menu commands are registered on T2'))).toBe(true);
});

test('--browser gives a temp browser its port, which must be free', async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const taken = (blocker.address() as net.AddressInfo).port;
  // Free again, for the browser to take.
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(p));
    });
  });
  const cli = (...args: string[]): Promise<string> => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (_err, stdout, stderr) => resolve(stdout + stderr));
  });
  try {
    expect(await cli('--browser', String(port), 'start', '--', 'status')).toContain(`browser 127.0.0.1:${port}`);
    expect(await cli('--browser', String(taken), 'start', '--', 'status')).toContain(`Port ${taken} is already in use`);
  } finally {
    blocker.close();
  }
});
