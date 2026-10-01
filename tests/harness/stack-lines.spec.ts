// Stack lines in sm-dev's output name the file and line the code was
// written on, for a script with a `@require`. The injected entry is the
// requires followed by the script, all under the script's URL, so the
// raw frames count lines from the top of the requires; sm-dev maps them
// back (src/stack-link.ts `remapStackText`).

import { test, expect } from '../fixtures/harness.js';
import { run } from '../../lib/harness/run.js';

const ROOT = 'sourcemonkey://SourceMonkey/stacky';

test('frames in a @require and in the script name their own file and line', async ({ fixtureServer, scriptsDir }) => {
  // Line 2 of the library calls back into the script.
  scriptsDir.writeRaw('lib.js', [
    '// a library',
    'function libCall(fn) { return fn(); }',
    '',
  ].join('\n'));
  const file = scriptsDir.write({
    relativePath: 'stacky.user.js',
    meta: { name: 'Stacky', match: ['*://*/target.html'], extra: ['// @require     lib.js'] },
    // The metadata block is lines 1-5, so the body starts on line 6:
    // `console.error` on line 7, `throw` on line 9.
    body: [
      '',
      'libCall(function logged() { console.error(new Error("logged")); });',
      'libCall(function thrown() {',
      '  throw new Error("thrown");',
      '});',
      '',
    ].join('\n'),
  });

  const lines: string[] = [];
  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const wanted = ['Stacky threw: thrown', '[page error] Error: logged'];
  const done = run({
    files: [file],
    urls: [`${fixtureServer.baseUrl}/target.html`],
    tempBrowser: true,
    collectionRoot: scriptsDir.path,
    localRoots: [],
    out: (line) => {
      lines.push(line);
      if (wanted.every((w) => lines.some((l) => l.includes(w)))) stop();
    },
    until,
  });
  const timer = setTimeout(stop, 10000);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }

  const text = lines.join('\n');
  // The script's own console.error: the frame in the script, then the
  // library's.
  const logged = lines.find((l) => l.startsWith('[page error] Error: logged'));
  expect(logged, text).toBeDefined();
  expect(logged).toContain(`at logged (${ROOT}/stacky.user.js:7:`);
  expect(logged).toContain(`at libCall (${ROOT}/file/`);
  expect(logged).toMatch(/\/lib\.js:2:\d+\)/);
  // The host's `threw` report shows the same mapping.
  expect(text).toContain(`at thrown (${ROOT}/stacky.user.js:9:`);
  expect(text).toMatch(/at libCall \(sourcemonkey:\/\/SourceMonkey\/stacky\/file\/.*\/lib\.js:2:\d+\)/);
});
