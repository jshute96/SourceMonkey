// A command that runs past its limit (command-limit.ts): the runner
// stops waiting for it and takes the next command, and a page stuck
// running JavaScript is stopped so it answers again.

import { test, expect } from '../fixtures/harness.js';
import { commandRunner, DialogTracker, type ConsoleContext } from '../../lib/harness/console-commands.js';
import { plainLine } from '../../lib/harness/output-style.js';

test('a command past its limit is given up on, and a page stuck in JavaScript is stopped', async ({ page, fixtureServer, host, attachment }) => {
  test.setTimeout(60_000);
  const lines: string[] = [];
  const dialogs = await DialogTracker.attach(page, (t) => lines.push(plainLine(`[sm-dev] ${t}`)), { visible: false, commandsComing: true });
  await page.goto(`${fixtureServer.baseUrl}/target.html`);
  const tabs = [{ n: 1, page, link: attachment, dialogs }];
  const ctx: ConsoleContext = { host, tabs: () => tabs, scripts: [], out: (l) => lines.push(plainLine(l)), stop: () => undefined };
  const runner = commandRunner(ctx, { limitMs: 2000 });
  const run = async (line: string): Promise<{ lines: string[]; code: number }> => {
    lines.length = 0;
    const code = await runner(line);
    return { lines: [...lines], code };
  };
  const overLimit = '[sm-dev] The `eval` command did not finish within 2s. The run stopped waiting for it.';
  const longer = '[sm-dev] Use --timeout-seconds to give it longer';

  // A loop that never yields: the page is stopped, and answers again.
  expect(await run('eval while (true) {}')).toEqual({
    code: 1,
    lines: [overLimit, '[sm-dev] T1\'s page didn\'t answer for 3 seconds. sm-dev stopped the JavaScript running there.', longer],
  });
  expect(await run('eval 1 + 1')).toEqual({ code: 0, lines: ['2'] });

  // A promise that never settles: nothing to stop, and the next command runs.
  expect(await run('eval new Promise(() => {})')).toEqual({
    code: 1,
    lines: [overLimit, '[sm-dev] No page is busy running JavaScript. The command is waiting for something else that hasn\'t finished, such as a promise or a request.', longer],
  });
  expect(await run('eval document.title.length > 0')).toEqual({ code: 0, lines: ['true'] });

  // A result that arrives after the limit is dropped, not printed into
  // the next command's output.
  // The next command is still running when the late result arrives.
  expect((await run('eval new Promise((r) => setTimeout(() => r("late"), 2600))')).code).toBe(1);
  expect(await run('eval new Promise((r) => setTimeout(() => r("next"), 1500))')).toEqual({ code: 0, lines: ['"next"'] });

  // --timeout-seconds is the limit on the whole command.
  expect(await run('eval new Promise((r) => setTimeout(r, 6000)) --timeout-seconds 0.5')).toEqual({
    code: 1,
    lines: [
      '[sm-dev] The `eval` command did not finish within 0.5s. The run stopped waiting for it.',
      '[sm-dev] No page is busy running JavaScript. The command is waiting for something else that hasn\'t finished, such as a promise or a request.',
      longer,
    ],
  });

  // A delay as long as --timeout-seconds is allowed.
  expect(await run('wait 1s --timeout-seconds 1')).toEqual({ code: 0, lines: [] });

  // The page's own timers still run: stopping it left nothing pending
  // to end its next script.
  await run('eval setTimeout(() => { window.ran = true; }, 50)');
  await page.waitForTimeout(200);
  expect(await run('eval window.ran')).toEqual({ code: 0, lines: ['true'] });
});
