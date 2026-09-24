// `sm-dev run` follows the tabs its tab opens: a `window.open` popup
// and a `GM_openInTab` tab both get the loaded scripts, and their
// lines carry the tab's name. Also `--all`'s tab per script, tabs
// closing (T1 included), and `--fire-menu` reaching another tab.

import { test, expect } from '../fixtures/harness.js';
import { run, type RunOptions } from '../../lib/harness/run.js';

// Run until every `wanted` line has appeared (by suffix), or 10s.
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
      if (wanted.every((w) => lines.some((l) => l.endsWith(w)))) stop();
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
  expect(lines.filter((l) => /^\[sm-dev\] Tab T\d+ opened at .*, from T1$/.test(l))).toHaveLength(2);
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
  expect(lines).toContain(`[sm-dev] Opening ${base}/target.html`);
  // B and D share one page, so one tab.
  expect(lines).toContain(`[sm-dev] Opening ${base}/other.html in T2`);
  expect(lines.filter((l) => /Tab T\d+ opened/.test(l))).toEqual(['[sm-dev] Tab T2 opened']);
  const skipped = lines.indexOf('[sm-dev] Skipped script 3, C (c.user.js): Its @match names no page to open');
  expect(skipped).toBeGreaterThan(lines.indexOf(`[sm-dev] Opening ${base}/other.html in T2`));
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
    `[sm-dev] Opening ${target}`,
  ]);
  expect(noScriptCode).toBe(0);
  expect(lines).toContain(`[sm-dev] Opening ${target}`);
});

// Drive the real CLI through its input, as a person or an agent would:
// each command is sent once the line before it in `steps` has printed.
async function driveCli(args: string[], steps: [waitFor: string, send: string][]): Promise<string[]> {
  const { spawn } = await import('node:child_process');
  const cli = new URL('../../lib/harness/cli.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, 'run', ...args, '--launch', '--seconds', '20'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let pending = [...steps];
  let buffer = '';
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      lines.push(line);
      while (pending[0] && lines.some((l) => l.includes(pending[0][0]))) {
        child.stdin.write(`${pending[0][1]}\n`);
        pending = pending.slice(1);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  await new Promise((resolve) => child.on('exit', resolve));
  return lines;
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
  expect(lines).toContain('[sm-dev] Tab T1 opened');
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
  expect(lines).toContain('[sm-dev] Opening about:blank');
  expect(lines).toContain('Page: about:blank');
  expect(lines).toContain('  No scripts are loaded');
});
