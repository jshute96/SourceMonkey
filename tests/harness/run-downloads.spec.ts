// A download from one of a run's tabs gets a line saying where it was
// saved: a page's own, one from a new tab it opened, and one from a
// cross-site iframe. A `--temp-browser` saves beside the run's log under
// the file's own name, rather than in Playwright's temp folder, and
// `status` names that folder once something is in it; a connected
// browser keeps its own download setting.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '../fixtures/harness.js';
import { launchDebugBrowser } from '../fixtures/debug-browser.js';
import { run, type RunOptions } from '../../lib/harness/run.js';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));

// Saves `saved.txt` from a blob link, when `#save` is clicked, or at
// once with `now`.
function saver(now: boolean) {
  return {
    relativePath: 'saver.user.js',
    meta: { name: 'Saver', match: ['*://*/target.html'] },
    body: `
      const a = document.createElement('a');
      a.id = 'save';
      a.textContent = 'save';
      a.href = URL.createObjectURL(new Blob(['saved text'], { type: 'text/plain' }));
      a.download = 'saved.txt';
      document.body.append(a);
      ${now ? 'a.click();' : ''}
    `,
  };
}

// Run until a download's line, or 25s.
async function runUntilSaved(opts: Omit<RunOptions, 'out' | 'until' | 'localRoots'>): Promise<string[]> {
  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const timer = setTimeout(stop, 25_000);
  try {
    const code = await run({
      ...opts,
      localRoots: [],
      out: (line) => {
        lines.push(line);
        if (line.includes('Download saved')) stop();
      },
      until,
    });
    expect(code, lines.join('\n')).toBe(0);
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The line for `file`, from a tab of the run (any), from `from`.
function savedLine(file: string, from: string): RegExp {
  return new RegExp(`^(\\[T\\d+\\] )?\\[event\\] Download saved: ${escaped(file)} \\(from ${from}`);
}

test('a --temp-browser download is saved beside the run log, and status names the folder once it has one', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write(saver(false));
  const logs = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-downloads-test-'));
  try {
    // Each step: once a line has `wait`, send `send`.
    const steps: [string, string][] = [
      ['Saver started on', 'status'],
      ['Tabs:', 'click #save'],
      ['Download saved', 'status'],
      ['Tabs:', 'exit'],
    ];
    const child = spawn(process.execPath, [CLI, '--stdin', '--temp-browser', 'start', file, `${fixtureServer.baseUrl}/target.html`, '--seconds', '25'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SM_DEV_LOGS_DIR: logs },
    });
    const lines: string[] = [];
    let since = 0;
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        if (steps[0] && line.includes(steps[0][0]) && lines.length > since) {
          since = lines.length;
          child.stdin.write(`${steps.shift()![1]}\n`);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    await new Promise((resolve) => child.on('exit', resolve));
    expect(steps, lines.join('\n')).toEqual([]);

    const log = lines.find((l) => l.startsWith('Log: '))!.slice('Log: '.length).replace(/ \(.*\)$/, '');
    const dir = log.replace(/\.log$/, '-downloads');
    const saved = path.join(dir, 'saved.txt');
    expect(lines).toContainEqual(expect.stringMatching(savedLine(saved, 'blob:http://')));
    expect(readFileSync(saved, 'utf8')).toBe('saved text');
    // Only the status after the download names the folder.
    expect(lines.filter((l) => l.startsWith('Downloads: '))).toEqual([`Downloads: ${dir}`]);
    const second = lines.lastIndexOf(lines.find((l) => l.startsWith('Downloads: '))!);
    expect(second).toBeGreaterThan(lines.findIndex((l) => l.includes('Download saved')));
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
});

test('a download from a new tab the page opened is reported', async ({ fixtureServer, scriptsDir }) => {
  const file = scriptsDir.write({
    relativePath: 'opener.user.js',
    meta: { name: 'Opener', match: ['*://*/target.html'] },
    body: `window.open('/__attachment/popup.txt');`,
  });
  const logs = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-downloads-test-'));
  try {
    const lines = await runUntilSaved({
      files: [file],
      urls: [`${fixtureServer.baseUrl}/target.html`],
      collectionRoot: scriptsDir.path,
      tempBrowser: true,
      log: path.join(logs, 'sm-dev-test.log'),
    });
    const saved = path.join(logs, 'sm-dev-test-downloads', 'popup.txt');
    expect(lines).toContainEqual(expect.stringMatching(savedLine(saved, escaped(`${fixtureServer.baseUrl}/__attachment/popup.txt`))));
    expect(readFileSync(saved, 'utf8')).toBe('attachment popup.txt');
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
});

test('a download from a cross-site iframe is reported', async ({ fixtureServer, scriptsDir }) => {
  // 127.0.0.1 and localhost are different sites, so the iframe runs in
  // a process (and CDP target) of its own.
  const other = fixtureServer.baseUrl.replace('127.0.0.1', 'localhost');
  const file = scriptsDir.write({
    relativePath: 'framed.user.js',
    meta: { name: 'Framed', match: ['*://*/target.html'] },
    body: `
      const frame = document.createElement('iframe');
      frame.src = ${JSON.stringify(`${other}/__attachment/framed.txt`)};
      document.body.append(frame);
    `,
  });
  const logs = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-downloads-test-'));
  try {
    const lines = await runUntilSaved({
      files: [file],
      urls: [`${fixtureServer.baseUrl}/target.html`],
      collectionRoot: scriptsDir.path,
      tempBrowser: true,
      log: path.join(logs, 'sm-dev-test.log'),
    });
    const saved = path.join(logs, 'sm-dev-test-downloads', 'framed.txt');
    expect(lines).toContainEqual(expect.stringMatching(savedLine(saved, escaped(`${other}/__attachment/framed.txt`))));
    expect(readFileSync(saved, 'utf8')).toBe('attachment framed.txt');
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
});

test('a connected browser saves where its own setting says, and the run says where', async ({ fixtureServer, scriptsDir }) => {
  // The browser's own launch comes before the run's deadline.
  test.setTimeout(60_000);
  const file = scriptsDir.write(saver(true));
  const browser = await launchDebugBrowser({ downloads: true });
  try {
    const lines = await runUntilSaved({
      files: [file],
      urls: [`${fixtureServer.baseUrl}/target.html`],
      collectionRoot: scriptsDir.path,
      cdp: String(browser.port),
    });
    const saved = path.join(browser.dir, 'downloads', 'saved.txt');
    expect(lines).toContainEqual(expect.stringMatching(savedLine(saved, 'blob:http://')));
    expect(readFileSync(saved, 'utf8')).toBe('saved text');
  } finally {
    await browser.close();
  }
});
