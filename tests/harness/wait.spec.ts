// `wait` and the settling the actions and loads do on their own
// (wait.ts), driven directly as `sm-dev start` runs them: a page
// whose script keeps changing it for a while after a click.

import { test, expect } from '../fixtures/harness.js';
import { commandRunner, DialogTracker, type ConsoleContext } from '../../lib/harness/console-commands.js';
import { plainLine } from '../../lib/harness/output-style.js';
import { RunLog, streamText } from '../../lib/harness/run-logs.js';

test('wait and the actions settle the page, and say what kept it busy', async ({ page, fixtureServer, host, attachment, loadScript }) => {
  test.setTimeout(60_000);
  const script = await loadScript({
    relativePath: 'slow.user.js',
    meta: { name: 'Slow', match: ['*://*/target.html'] },
    body: `
      const button = document.createElement('button');
      button.id = 'go';
      button.textContent = 'Go';
      // Changes the page three times, 100ms apart: each inside the
      // quiet window, so settling waits for the last.
      button.addEventListener('click', () => {
        let step = 0;
        const next = () => {
          button.textContent = 'Step ' + (++step);
          if (step < 3) setTimeout(next, 100);
          else {
            document.body.insertAdjacentHTML('beforeend', '<p class="result">done</p>');
            console.log('[slow] saved');
          }
        };
        next();
      });
      // Changes the page 150ms after a click, on a page otherwise quiet.
      const later = document.createElement('button');
      later.id = 'later';
      later.addEventListener('click', () => setTimeout(() => { later.textContent = 'Changed'; }, 150));
      const ticker = document.createElement('span');
      ticker.id = 'ticker';
      document.body.append(button, later, ticker);
      setTimeout(() => console.log('[slow] ready'), 300);
    `,
  });
  const lines: string[] = [];
  const dialogs = await DialogTracker.attach(page, (t) => lines.push(plainLine(`[sm-dev] ${t}`)), { visible: false, commandsComing: true });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);

  // The run's log, as run.ts keeps it for `wait log`, with the script's
  // own lines, which the run streams.
  const logs = new RunLog();
  const say = (line: string): void => { lines.push(plainLine(line)); };
  page.on('console', (msg) => {
    if (!msg.text().startsWith('[slow]')) return;
    say(streamText(logs.add({ source: 'script', kind: msg.type(), tab: 1, text: msg.text() })));
  });

  const tabs = [{ n: 1, page, link: attachment, dialogs }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [script], out: say, stop: () => undefined, logs };
  // How `wait log` ends: where it found the line, or where it searched to.
  const foundAt = expect.stringMatching(/^\[sm-dev\] Found at \d+ \(\d\d:\d\d:\d\d\.\d{3}\)$/);
  const searchedTo = expect.stringMatching(/^\[sm-dev\] Searched up to \d+ \(\d\d:\d\d:\d\d\.\d{3}\)$/);
  // As the run takes commands, which also keeps where `wait log` looks from.
  const runner = commandRunner(ctx);
  const run = async (line: string): Promise<{ lines: string[]; ok: boolean }> => {
    lines.length = 0;
    const ok = await runner(line) === 0;
    return { lines: [...lines], ok };
  };
  const result = 'eval !!document.querySelector(".result")';

  // `wait log` finds a line printed since the previous command (here,
  // since the start), or one still to come.
  expect((await run('wait log /\\[slow\\] re+ady/')).lines.slice(-2)).toEqual(['[sm-dev] Wait matched log line: [script log] [slow] ready', foundAt]);

  // Settled: loaded, the script started, nothing changing.
  const settled = await run('wait');
  expect(settled.ok).toBe(true);
  expect(settled.lines).toContainEqual(expect.stringMatching(/^\[sm-dev\] T1 settled in \d+(\.\d)?s$/));

  const missed = await run('wait log never printed --timeout-seconds 0.3');
  expect(missed).toEqual({ ok: false, lines: ['[sm-dev] Wait failed: No log line matched "never printed" within 0.3s', searchedTo] });

  // An action waits for what it set off; --nowait doesn't.
  expect((await run('click --nowait #go')).lines).toEqual(['[sm-dev] Clicked #go']);
  expect((await run(result)).lines).toEqual(['false']);
  expect((await run('wait selector .result')).lines).toContain('[sm-dev] Wait done: The selector .result matches on T1');
  // Quotes inside a typed selector stay, as click keeps them.
  expect((await run('wait selector p[class="result"] --timeout-seconds 1')).lines).toEqual(['[sm-dev] Wait done: The selector p[class="result"] matches on T1']);
  expect((await run(`wait selector 'p[class="result"]'`)).lines).toEqual(['[sm-dev] Wait done: The selector p[class="result"] matches on T1']);
  await run('eval document.querySelector(".result").remove()');
  expect((await run('click #go')).lines).toEqual(['[script log] [slow] saved', '[sm-dev] Clicked #go']);
  // A line the click set off, printed while it settled, counts for the
  // next command's `wait log`.
  expect((await run('wait log saved')).lines).toEqual(['[sm-dev] Wait matched log line: [script log] [slow] saved', foundAt]);
  // Spaces in the text or a regex: typed, quoted or not, and as a
  // sender's words. Each after a fresh line, since one printed before
  // the previous command began no longer counts.
  const found = ['[sm-dev] Wait matched log line: [script log] [slow] saved', foundAt];
  const print = 'eval console.log("[slow] saved")';
  for (const typed of ['wait log [slow] saved', 'wait log "[slow] saved"', 'wait log /slow\\] +saved/']) {
    await run(print);
    expect((await run(typed)).lines).toEqual(found);
  }
  for (const words of [['wait', 'log', '[slow]', 'saved', '--timeout-seconds', '1'], ['wait', 'log', '/slow] saved/']]) {
    await run(print);
    lines.length = 0;
    expect(await runner(words.join(' '), { words })).toBe(0);
    expect(lines).toEqual(found);
  }
  expect((await run('wait log /never  printed/i --timeout-seconds 0.2')).lines)
    .toEqual(['[sm-dev] Wait failed: No log line matched /never  printed/i within 0.2s', searchedTo]);
  // A quiet page still gets the window after an action, so a change
  // it sets off a moment later is in by the time it returns.
  await run('wait');
  await run('click #later');
  expect((await run('eval document.getElementById("later").textContent')).lines).toEqual(['"Changed"']);

  // A `wait` between doesn't move where `wait log` looks from, and the
  // harness's own replies (`Clicked #go`) aren't output to match.
  await run('eval document.querySelector(".result")?.remove()');
  await run('click #go');
  await run('wait');
  expect((await run('wait log /saved/g')).ok).toBe(true);
  expect((await run('wait log Clicked --timeout-seconds 0.2')).ok).toBe(false);
  // `log` is the log form only in its place: here, part of a selector.
  expect((await run('wait selector body log --timeout-seconds 0.2')).lines)
    .toEqual(['[sm-dev] Wait failed: The selector body log matched nothing on T1 within 0.2s']);
  // A mistake anywhere fails the command.
  expect(await run('get')).toEqual({ ok: false, lines: ['[sm-dev] ERROR: The `get` command needs a key'] });

  // After a command that moves the window, the line from before it, and
  // the waits' own replies, don't count.
  await run('eval 1');
  expect((await run('wait log saved --timeout-seconds 0.3')).ok).toBe(false);
  expect((await run(result)).lines).toEqual(['true']);
  expect((await run('wait all')).lines).toEqual([expect.stringMatching(/^\[sm-dev\] T1 settled in \d+(\.\d)?s$/)]);

  expect((await run('wait selector-gone .result --timeout-seconds 0.3')).lines)
    .toEqual(['[sm-dev] Wait failed: The selector .result still matched on T1 after 0.3s']);
  const started = Date.now();
  expect((await run('wait 200ms')).ok).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(190);

  // A page that never stops changing: the wait gives up, says why, and
  // fails, so a line of several commands stops there.
  await run('eval setInterval(() => { document.getElementById("ticker").textContent = String(Date.now()); }, 50), 0');
  // Its first tick can take a moment to come.
  await expect.poll(() => page.evaluate(() => document.getElementById('ticker')!.textContent)).not.toBe('');
  const busy = await run('wait T1 --timeout-seconds 0.5');
  expect(busy.ok).toBe(false);
  expect(busy.lines).toEqual(['[sm-dev] T1 did not settle within 0.5s: The DOM is still changing (span#ticker)']);
  // An action on it still counts as done.
  expect((await run('click #go')).lines).toContainEqual(expect.stringMatching(/^\[sm-dev\] T1 did not settle within 5s: The DOM is still changing/));

  // Mistakes.
  expect(await run('wait sometime')).toEqual({ ok: false, lines: ['[sm-dev] ERROR: The `wait` command takes a tab, `all`, `selector`, `selector-gone`, `log`, or a delay such as 500ms or 2s, not `sometime`'] });
  expect((await run('wait selector')).lines).toEqual(['[sm-dev] ERROR: The `wait selector` command needs a selector, e.g. `wait selector \'#results\'`']);
  expect((await run('wait 2s --timeout-seconds 1')).lines).toEqual(['[sm-dev] ERROR: The delay 2s is longer than --timeout-seconds 1. Give a timeout at least as long, or none.']);
  // A tab before a delay, or a timeout at least as long, is allowed, and changes nothing.
  expect(await run('wait 10ms --timeout-seconds 1')).toEqual({ ok: true, lines: [] });
  expect(await run('wait T1 10ms')).toEqual({ ok: true, lines: [] });
  expect(await run('wait all 10ms')).toEqual({ ok: true, lines: [] });
  expect((await run('wait T9 10ms')).ok).toBe(false);
  expect((await run('wait --timeout-seconds 0')).lines).toEqual([expect.stringMatching(/^\[sm-dev\] ERROR: The --timeout-seconds flag needs a number of seconds/)]);
  expect((await run('wait --soon')).lines).toEqual(['[sm-dev] ERROR: The `wait` command has no --soon flag. It takes --timeout-seconds, --log-source, --find, --since, --frame.']);
  // A flag it doesn't take, after wait log's text, isn't taken as part of it.
  expect((await run('wait log ready --timeout 40')).lines).toEqual(['[sm-dev] ERROR: The `wait log` command has no --timeout flag. It takes --timeout-seconds, --log-source, --find, --since.']);
  expect((await run('wait selector T1 #go')).lines).toEqual(['[sm-dev] ERROR: The tab goes before the word selector: `wait T1 selector <css>`']);
  // Other --words ending the text are text, as is anything quoted.
  expect((await run('wait log \'Running --dry-run mode\' --timeout-seconds 0.2')).lines).toEqual(['[sm-dev] Wait failed: No log line matched "Running --dry-run mode" within 0.2s', searchedTo]);
  expect((await run('wait T1 log x')).lines).toEqual(['[sm-dev] ERROR: The `wait log` command takes no tab, since it watches all of the run\'s output']);
  expect((await run('wait 99999999s')).lines).toEqual([expect.stringMatching(/^\[sm-dev\] ERROR: A delay can be at most \d+s$/)]);
  // A mistyped flag fails too, so a line of several stops there.
  expect((await run('wait --soon')).ok).toBe(false);
});
