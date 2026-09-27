// Unit tests for the argument checks in `sm-dev` (src/harness/cli.ts,
// compiled to lib/harness/cli.js): `start` flag combinations that would
// do nothing or stall, and commands sent to a run, `stop` and `list` arguments they
// can't act on, are refused up front, before any browser or run is
// reached. Also `match`, which needs no browser at all.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../lib/harness/cli.js', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../examples/gm-menu/gm-menu.user.js', import.meta.url));

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, 'start', ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim().split('\n')[0] };
}

test('match lists every rule that excluded or matched each URL', () => {
  const script = fileURLToPath(new URL('../examples/headers-match-hash/exclude-hash.user.js', import.meta.url));
  const page = 'http://127.0.0.1/headers-match-hash/headers-match-hash.html';
  const r = spawnSync(process.execPath, [CLI, 'match', script, page, `${page}#part`, 'http://127.0.0.1/other.html'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, [
    `match    ${page}`,
    '    Matched by:  @match *://*/headers-match-hash/headers-match-hash.html',
    `no match ${page}#part`,
    '    Excluded by: @exclude *#part',
    '    Matched by:  @match *://*/headers-match-hash/headers-match-hash.html',
    'no match http://127.0.0.1/other.html',
    '    No @match or @include covers this URL',
    '',
  ].join('\n'));
});

test('match takes several scripts and URLs in any order, a heading per script', () => {
  const dir = fileURLToPath(new URL('../examples/headers-match-hash/', import.meta.url));
  const page = 'http://127.0.0.1/headers-match-hash/headers-match-hash.html';
  const rel = (name) => path.relative(process.cwd(), path.join(dir, name));
  const r = spawnSync(process.execPath, [CLI, 'match', `${page}#part`, path.join(dir, 'match-exact.user.js'), path.join(dir, 'include-hash.user.js'), page], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, [
    rel('match-exact.user.js'),
    `match    ${page}#part`,
    '    Matched by:  @match *://*/headers-match-hash/headers-match-hash.html',
    `match    ${page}`,
    '    Matched by:  @match *://*/headers-match-hash/headers-match-hash.html',
    '',
    rel('include-hash.user.js'),
    `match    ${page}#part`,
    '    Matched by:  @include *://*/headers-match-hash/headers-match-hash.html#part',
    `no match ${page}`,
    '    No @match or @include covers this URL',
    '',
  ].join('\n'));
  // A script or URL given twice is checked once.
  const twice = spawnSync(process.execPath, [CLI, 'match', path.join(dir, 'match-exact.user.js'), page, path.join(dir, 'match-exact.user.js'), page], { encoding: 'utf8' });
  assert.equal(twice.stdout, `match    ${page}\n    Matched by:  @match *://*/headers-match-hash/headers-match-hash.html\n`);
  // With no .user.js argument, and no run to take the script from.
  const none = spawnSync(process.execPath, [CLI, 'match', page], { encoding: 'utf8', env: { ...process.env, SM_DEV_RUNS_DIR: RUNS_DIR } });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /^ERROR: The match command needs a script \(a \.user\.js file\) and at least one URL, or a run to take them from$/m);
});

test('match gives a script that can never match its per-URL answer, and a broken one only its status', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-match-'));
  try {
    const broken = path.join(dir, 'broken.user.js');
    writeFileSync(broken, '// ==UserScript==\n// @name B\n// @match https://x/*\n// ==/UserScript==\nfunction (\n');
    const hash = fileURLToPath(new URL('../examples/headers-match-hash/match-hash.user.js', import.meta.url));
    const page = 'http://127.0.0.1/headers-match-hash/headers-match-hash.html#part';
    const r = spawnSync(process.execPath, [CLI, 'match', hash, broken, page], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, [
      path.relative(process.cwd(), hash),
      `no match ${page}`,
      '    No @match or @include covers this URL',
      '',
      path.relative(process.cwd(), broken),
      'INVALID script',
      '',
    ].join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validate and match fetch a script given as a URL, and run refuses one', async () => {
  // Async, not spawnSync: the server answers from this same process.
  const { createServer } = await import('node:http');
  const { readFileSync } = await import('node:fs');
  const { execFile } = await import('node:child_process');
  const script = fileURLToPath(new URL('../examples/headers-match-hash/match-exact.user.js', import.meta.url));
  const withRequire = '// ==UserScript==\n// @name R\n// @match https://x.test/*\n// @require lib.js\n// ==/UserScript==\nhelper();\n';
  const server = createServer((req, res) => {
    if (req.url === '/match-exact.user.js') res.end(readFileSync(script));
    // A redirect, as Greasy Fork's and GitHub's links do: the @require
    // is relative to where it lands.
    else if (req.url === '/redirect.user.js') { res.writeHead(302, { location: '/real/r.user.js' }); res.end(); }
    else if (req.url === '/real/r.user.js') res.end(withRequire);
    else if (req.url === '/real/lib.js') res.end('function helper() {}\n');
    // A page about the file, not the file.
    else if (req.url === '/page.user.js') { res.setHeader('content-type', 'text/html'); res.end('<html>Sign in</html>'); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cli = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  try {
    const url = `${base}/match-exact.user.js`;
    const validated = await cli('validate', url);
    assert.equal(validated.code, 0);
    assert.equal(validated.stdout, `ok       ${url}\n\n1 ok, 0 invalid\n`);
    const page = 'http://x.test/headers-match-hash/headers-match-hash.html';
    assert.equal((await cli('match', url, page)).stdout,
      `match    ${page}\n    Matched by:  @match *://*/headers-match-hash/headers-match-hash.html\n`);
    const missing = await cli('validate', `${base}/nope.user.js`);
    assert.equal(missing.code, 1);
    assert.equal(missing.stderr, `Could not fetch ${base}/nope.user.js: The server answered 404 Not Found\n`);
    assert.equal((await cli('validate', `${base}/redirect.user.js`)).stdout, `ok       ${base}/redirect.user.js\n\n1 ok, 0 invalid\n`);
    const html = await cli('validate', `${base}/page.user.js`);
    assert.equal(html.code, 1);
    assert.match(html.stderr, /^Could not fetch \S+: The server returned an HTML page, not JavaScript \(Content-Type "text\/html"\); the link may be dead or behind a login\n$/);
    const run = await cli('start', url);
    assert.equal(run.code, 2);
    assert.equal(run.stderr.split('\n')[0], `ERROR: The start command loads scripts from files, and ${url} is a URL. Save it to a file first.`);
  } finally {
    server.close();
  }
});

test('--noscript refuses scripts, and a run needs one without it', () => {
  assert.deepEqual(run('--noscript', SCRIPT), {
    code: 2, out: 'ERROR: The --noscript flag runs no scripts, so the start command takes none with it',
  });
  assert.deepEqual(run(), { code: 2, out: 'ERROR: The start command needs at least one script (a .user.js file), or --noscript' });
});

test('--noscript refuses the flags that act on scripts', () => {
  assert.deepEqual(run('--noscript', '--watch'), { code: 2, out: 'ERROR: The --noscript flag can\'t be used with --watch' });
  assert.deepEqual(run('--noscript', '--all', '--values', '{}'), {
    code: 2, out: 'ERROR: The --noscript flag can\'t be used with --all or --values',
  });
  assert.deepEqual(run('--noscript', '--extension'), { code: 2, out: 'ERROR: The --noscript flag can\'t be used with --extension' });
});

test('--notab refuses the flags that need a tab', () => {
  assert.deepEqual(run(SCRIPT, 'x.com', '--all'), { code: 2, out: 'ERROR: The --all flag opens each script\'s own page, so it can\'t be used with a URL' });
  assert.deepEqual(run(SCRIPT, '--notab', 'x.com'), { code: 2, out: 'ERROR: The --notab flag can\'t be used with a URL' });
  assert.deepEqual(run(SCRIPT, '--notab', '--all'), { code: 2, out: 'ERROR: The --notab flag can\'t be used with --all' });
});

// An empty runs directory of its own, so runs active on this machine
// don't change the answers.
const RUNS_DIR = mkdtempSync(path.join(os.tmpdir(), 'sm-dev-runs-test-'));
after(() => rmSync(RUNS_DIR, { recursive: true, force: true }));

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SM_DEV_RUNS_DIR: RUNS_DIR } });
  return { code: r.status, out: (r.stdout + r.stderr).trim().split('\n')[0] };
}

// The CLI with `input` piped to its stdin, and all it printed.
function piped(input, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { ...process.env, SM_DEV_RUNS_DIR: RUNS_DIR } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const NO_COMMANDS = 'No commands given on either the command line or stdin';

test('piped stdin is commands with none on the line, or with --stdin, checked in full before any is sent', () => {
  // Nothing to run says so, rather than exiting without a word.
  assert.deepEqual(piped(''), { code: 2, stdout: '', stderr: `ERROR: ${NO_COMMANDS}\n` });
  assert.deepEqual(piped('# a comment\n\n', '--stdin'), { code: 2, stdout: '', stderr: `ERROR: ${NO_COMMANDS}\n` });
  // Commands on the line too: stdin having none is fine.
  assert.deepEqual(piped('', '--stdin', 'list'), { code: 0, stdout: 'No sm-dev runs are active\n', stderr: '' });
  // Every mistake said, and none run, so no run is looked for.
  assert.deepEqual(piped('status\nevel 1\ntabs {{\n}}\neval {{\n1\n'), {
    code: 2,
    stdout: '',
    stderr: [
      'stdin > evel 1',
      'ERROR: evel is not a command a run takes. Type sm-dev help to list them.',
      'ERROR: Line 3: Only the eval command takes a {{ block, so its lines up to }} are skipped',
      'ERROR: The eval block on line 5 has no }} line to end it',
      'None of the commands were run.',
      '',
    ].join('\n'),
  });
  // Checked, then sent: here to no run.
  assert.deepEqual(piped('status\n', '--stdin'), { code: 1, stdout: '', stderr: 'No sm-dev runs are active. Start one with sm-dev start.\n' });
  // Not read without --stdin once the line has a command.
  assert.deepEqual(piped('evel\n', 'list'), { code: 0, stdout: 'No sm-dev runs are active\n', stderr: '' });
  // A line of only --run names the run stdin's commands go to.
  const noD9 = { code: 1, stdout: '', stderr: 'There is no run D9. Type sm-dev list to see the runs.\n' };
  assert.deepEqual(piped('status\n', '--run', 'D9'), noD9);
  assert.deepEqual(piped('status\n', '--run=D9', '--stdin'), noD9);
  assert.deepEqual(piped('status\n', '--run', '9'), { code: 2, stdout: '', stderr: 'ERROR: Runs are named D1, D2 and so on. Did you mean --run D9?\n' });
  // A line-wide flag goes first.
  assert.deepEqual(piped('', 'list', '--stdin'), {
    code: 2, stdout: '', stderr: 'ERROR: The --stdin flag is for the whole command line, so it goes first, before any command: sm-dev --stdin <command>\n',
  });
});

test('stdin from a file is checked in full; lines a pipe sends later run as read, up to a mistake', async () => {
  // A file: every mistake in it said, none run.
  const file = path.join(RUNS_DIR, 'steps.txt');
  writeFileSync(file, 'status\nevel 1\n');
  const fd = openSync(file, 'r');
  const r = spawnSync(process.execPath, [CLI], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, SM_DEV_RUNS_DIR: RUNS_DIR } });
  closeSync(fd);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'stdin > evel 1\nERROR: evel is not a command a run takes. Type sm-dev help to list them.\nNone of the commands were run.\n');
  // A pipe: a comment first, then after a pause a mistake, said as it
  // comes, which stops the rest, as a failed command does.
  const child = spawn(process.execPath, [CLI], { env: { ...process.env, SM_DEV_RUNS_DIR: RUNS_DIR } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write('# first\n');
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.write('evel 1\ntabs {{\n}}\n');
  child.stdin.end();
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.equal(stderr, [
    'stdin > evel 1',
    'ERROR: evel is not a command a run takes. Type sm-dev help to list them.',
    'That command failed, so the commands after it were not run',
    '',
  ].join('\n'));
});

test('commands sent to a run, and stop, refuse what they can\'t act on', () => {
  // A list of only comments sends nothing.
  assert.deepEqual(cli('# a comment\n\n'), { code: 2, out: `ERROR: ${NO_COMMANDS}` });
  assert.deepEqual(cli('tabs {{\n}}'), {
    code: 2, out: 'ERROR: Line 1: Only the eval command takes a {{ block, so its lines up to }} are skipped. None of the commands were run.',
  });
  const none = { code: 1, out: 'No sm-dev runs are active. Start one with sm-dev start.' };
  assert.deepEqual(cli('status'), none);
  const noD9 = { code: 1, out: 'There is no run D9. Type sm-dev list to see the runs.' };
  assert.deepEqual(cli('--run', 'D9', 'status'), noD9);
  assert.deepEqual(cli('--run=d9', 'status'), noD9);
  assert.deepEqual(cli('--run', '9', 'status'), { code: 2, out: 'ERROR: Runs are named D1, D2 and so on. Did you mean --run D9?' });
  assert.deepEqual(cli('--run', 'x', 'status'), { code: 2, out: 'ERROR: The run ID x is not valid. Run IDs are D and then letters, digits, _ or -.' });
  assert.deepEqual(cli('--run'), { code: 2, out: 'ERROR: The --run flag needs a run ID, e.g. --run D2' });
  assert.deepEqual(cli('--run=', 'status'), { code: 2, out: 'ERROR: The --run flag needs a run ID, e.g. --run D2' });
  // Line-wide flags go first, before any command.
  assert.deepEqual(cli('status', '--run', 'D9'), {
    code: 2, out: 'ERROR: The --run flag is for the whole command line, so it goes first, before any command: sm-dev --run ... <command>',
  });
  assert.deepEqual(cli('validate', 'x', '--root', '.'), {
    code: 2, out: 'ERROR: The --root flag is for the whole command line, so it goes first, before any command: sm-dev --root ... <command>',
  });
  // stop and attach take a run by its ID.
  assert.deepEqual(cli('stop', 'D9'), noD9);
  assert.deepEqual(cli('stop', '9'), { code: 2, out: 'ERROR: Runs are named D1, D2 and so on. Did you mean stop D9?' });
  assert.deepEqual(cli('stop', 'x'), { code: 2, out: 'ERROR: The run ID x is not valid. Run IDs are D and then letters, digits, _ or -.' });
  assert.deepEqual(cli('stop', 'D1', 'D2'), { code: 2, out: 'ERROR: The stop command takes at most one run ID, e.g. stop D2' });
  assert.deepEqual(cli('stop', '--all', 'D1'), { code: 2, out: 'ERROR: The --all flag stops every run, so the stop command can\'t take a run ID too' });
  assert.deepEqual(cli('attach', 'D9'), noD9);
  assert.deepEqual(cli('attach'), none);
  assert.deepEqual(cli('list', 'x'), { code: 2, out: 'ERROR: The list command takes no arguments' });
  assert.deepEqual(cli('exit', 'x'), { code: 2, out: 'ERROR: The exit command takes no arguments' });
  assert.deepEqual(cli('D1', 'status'), { code: 2, out: 'ERROR: Name the run with --run, before the command: sm-dev --run D1 status' });
  // wait has nothing to watch without a run.
  assert.deepEqual(cli('wait', '1s'), { code: 2, out: 'ERROR: The wait command needs a run to watch. Start or attach one first.' });
  // Only line-wide flags: stdin is read for commands, and has none.
  assert.deepEqual(cli('--root', '.'), { code: 2, out: `ERROR: ${NO_COMMANDS}` });
  // A run's command with a flag it doesn't take, refused before any run is looked for.
  assert.deepEqual(cli('status', '--bad'), { code: 2, out: 'ERROR: The status command has no --bad flag' });
  for (const name of ['open', 'reload', 'newtab']) assert.deepEqual(cli(name, '--bogus'), { code: 2, out: `ERROR: The ${name} command has no --bogus flag` });
  assert.deepEqual(cli('snapshot --out f --bad'), { code: 2, out: 'ERROR: The snapshot command has no --bad flag' });
  // In free text, -- is content: eval's JavaScript here.
  assert.deepEqual(cli('eval', 'T2', '--x'), { code: 2, out: 'ERROR: The eval command has no --x flag' });
  assert.deepEqual(cli('eval', 'x', '--y'), { code: 1, out: 'No sm-dev runs are active. Start one with sm-dev start.' });
  // -h anywhere is help, even among a run's command's words.
  assert.deepEqual(cli('type', 'input', '-h'), { code: 0, out: 'Usage: sm-dev type [tab] <selector> <text> [options]' });
});

test('several commands on a line are checked before any runs, then run in order, stopping at the first that fails', () => {
  const line = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SM_DEV_RUNS_DIR: RUNS_DIR } });
  // Nothing runs when any is wrong, and each wrong one is named.
  const bad = line('list', '--', 'evel', '1', '--', 'status\nbogus', '--', 'stop', 'x');
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, [
    'arg > evel 1',
    'ERROR: Unknown command: evel. Type sm-dev --help to list the commands.',
    'arg > \'status',
    'bogus\'',
    'ERROR: bogus is not a command a run takes. Type sm-dev help to list them.',
    'arg > stop x',
    'ERROR: The run ID x is not valid. Run IDs are D and then letters, digits, _ or -.',
    'None of the commands were run.',
    '',
  ].join('\n'));
  // Checked, then run: status finds no run, so the list after it is not run.
  const r = line('--', 'list', '--', 'status', '--', 'list');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'arg > list\nNo sm-dev runs are active\narg > status\n');
  assert.equal(r.stderr, 'No sm-dev runs are active. Start one with sm-dev start.\nThat command failed, so the commands after it were not run\n');
});

test('start needs something to keep it going, and -i a terminal', () => {
  const line = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SM_DEV_RUNS_DIR: RUNS_DIR } });
  // Alone, it would start the run and stop it again straight away.
  const alone = line('start', SCRIPT);
  assert.equal(alone.status, 2);
  assert.match(alone.stderr, /^ERROR: The start command with nothing after it would stop the run as soon as it started\. Add -i for a prompt, --detach/);
  // The prompt reads the terminal, which a pipe isn't.
  assert.equal(line('-i').stderr, 'ERROR: The --interactive flag needs a terminal. To read commands from a pipe or file, use --stdin.\n');
  assert.equal(line('-i', '--stdin', 'list').stderr, 'ERROR: The --interactive flag reads the terminal, so it can\'t be used with --stdin\n');
});

test('timers longer than Node can wait are refused', () => {
  assert.deepEqual(run(SCRIPT, '--detach', '--idle-seconds', '3000000'), { code: 2, out: 'ERROR: The --idle-seconds flag can be at most 2147483' });
  assert.deepEqual(run(SCRIPT, '--seconds', '3000000'), { code: 2, out: 'ERROR: The --seconds flag can be at most 2147483' });
});

test('--idle-seconds and --new need --detach', () => {
  assert.deepEqual(run(SCRIPT, '--new'), { code: 2, out: 'ERROR: The --new flag only applies with --detach' });
  assert.deepEqual(run(SCRIPT, '--detach', '--idle-seconds', 'soon'), { code: 2, out: 'ERROR: The --idle-seconds flag needs a number of seconds' });
});

test('--devtools refuses the runs it can\'t serve', () => {
  assert.deepEqual(run(SCRIPT, '--devtools', '--launch'), { code: 2, out: 'ERROR: The --devtools flag can\'t be used with --launch' });
  assert.deepEqual(run(SCRIPT, '--devtools', '--extension'), { code: 2, out: 'ERROR: The --devtools flag can\'t be used with --extension' });
});

test('--help lists every command, in sections, and how to name things', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Global options:$/m);
  assert.match(r.stdout, /^Concurrent runs:$/m);
  assert.match(r.stdout, /^ {2}Checking scripts:$/m);
  assert.match(r.stdout, /^ {2}click \[tab\] <selector>\n {20}Click an element\.$/m);
  assert.match(r.stdout, /^ {4}menu \[what\] /m);
  // Unindented, beside the commands.
  assert.match(r.stdout, /^Specifying objects:$/m);
  assert.match(r.stdout, /^ {4}Dname {11}A user-chosen/m);
  // Every line fits a terminal.
  for (const line of r.stdout.split('\n')) assert.ok(line.length <= 79, line);
});

function help(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('help for one command shows its entry and only its flags', () => {
  const match = help('help', 'match');
  assert.equal(match.code, 0);
  assert.match(match.out, /^Usage: sm-dev match \[script\]\.\.\. \[url\]\.\.\.$/m);
  assert.match(match.out, /^Arguments:\n {2}all-scripts +In a run/m);
  // Its section's note comes along.
  assert.match(match.out, /^Without a run, these check script files and URLs\./m);
  assert.doesNotMatch(match.out, /--cdp|--watch|^ {2}start /m);
  // A section's options, only for the commands that take them.
  assert.match(help('help', 'click').out, /^Common options:\n {2}--nowait /m);
  assert.doesNotMatch(help('help', 'eval').out, /--nowait/);
  // start's own groups, then the ones it shares.
  const start = help('help', 'start').out;
  assert.ok(start.indexOf('Lifetime:') < start.indexOf('Browser selection'));
  assert.match(start, /^ {2}--solo /m);
  // --help before or after the command asks the same.
  assert.equal(help('match', '--help').out, match.out);
  assert.equal(help('--help', 'match').out, match.out);
  // Even with a flag it would refuse.
  assert.equal(help('start', '--bogus', '--help').code, 0);
});

test('--help anywhere on a line shows each command\'s help once, and runs nothing', () => {
  const r = help('list', '--', 'status', '--bad', '--', 'eval', 'x', '--help', '--', 'status');
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: sm-dev list$/m);
  assert.equal(r.out.match(/^Usage: sm-dev status$/gm).length, 1);
  // Once each, in the full help's order.
  const all = help('stop', '--', 'eval', '1', '--', 'list', '--', 'status', '--', 'newtab', '--', 'status', '--help').out;
  assert.ok(all.indexOf('Usage: sm-dev list') < all.indexOf('Usage: sm-dev stop'));
  assert.ok(all.indexOf('Usage: sm-dev status') < all.indexOf('Usage: sm-dev newtab'));
  assert.ok(all.indexOf('Usage: sm-dev newtab') < all.indexOf('Usage: sm-dev eval'));
  assert.match(r.out, /^Usage: sm-dev eval \[tab\] <js> \[options\]$/m);
  assert.doesNotMatch(r.out, /No sm-dev runs|has no --bad flag/);
  assert.deepEqual(help('list', '--', 'frob', '-h'), { code: 2, out: 'ERROR: frob is not a command. Type sm-dev --help to list them.\n' });
});

test('each run command takes the flags its help lists, and no others', async () => {
  const { commandFlags } = await import('../../lib/harness/command-list.js');
  const loads = ['--noscript', '--script', '--nowait'];
  const expected = {
    newtab: loads, open: loads, reload: loads,
    click: ['--nowait'], hover: ['--nowait'], type: ['--nowait'], key: ['--nowait'],
    eval: ['--script'], snapshot: ['--visible', '--out'], screenshot: ['--full'], probe: ['--css', '--html'],
    wait: ['--timeout-seconds'], status: [], values: [], menu: [], tabs: [], focus: [],
  };
  for (const [name, flags] of Object.entries(expected)) assert.deepEqual(commandFlags(name).sort(), [...flags].sort(), name);
});

test('help covers a run\'s commands and aliases, and refuses unknown names', () => {
  const typed = help('help', 'status', 'script', 'get');
  assert.equal(typed.code, 0);
  assert.match(typed.out, /^Usage: sm-dev status$/m);
  assert.match(typed.out, /^Usage: sm-dev script <script>$/m);
  assert.match(typed.out, /^Usage: sm-dev get <key>$/m);
  assert.doesNotMatch(typed.out, /menu \[what\]/);
  // Every form of a command of several.
  assert.equal(help('help', 'wait').out.match(/^ {2}wait /gm).length, 5);
  // ? is help, and keys is key.
  assert.equal(help('?', 'keys').out, help('help', 'key').out);
  assert.deepEqual(help('help', 'nope'), { code: 2, out: 'ERROR: nope is not a command. Type sm-dev --help to list them.\n' });
});
