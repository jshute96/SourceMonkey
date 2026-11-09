// The time limit on a run's commands (command-limit.ts), and the
// `--timeout-seconds` budget its waits share (wait.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { commandLimitMs, givenTimeoutMs, COMMAND_LIMIT_MS } = await import('../../lib/harness/command-limit.js');
const { MAX_TIMER_SECONDS } = await import('../../lib/harness/command-list.js');
const { budgeted, deadlineIn, inBudget } = await import('../../lib/harness/wait.js');

test('givenTimeoutMs: --timeout-seconds in either spelling, or none', () => {
  assert.equal(givenTimeoutMs('open x --timeout-seconds 50'), 50_000);
  assert.equal(givenTimeoutMs('open x --timeout-seconds=2.5'), 2500);
  assert.equal(givenTimeoutMs('open x'), undefined);
  // Not a number of seconds: none (the command says so itself).
  assert.equal(givenTimeoutMs('open x --timeout-seconds soon'), undefined);
});

test('commandLimitMs: the default, none for the commands with their own, and the given time plus grace', () => {
  assert.equal(commandLimitMs('eval', undefined), COMMAND_LIMIT_MS);
  assert.equal(commandLimitMs('eval', undefined, 2000), 2000);
  for (const command of ['wait', 'stop', 'exit', 'start', 'attach', 'cdp']) assert.equal(commandLimitMs(command, 5000), null);
  assert.equal(commandLimitMs('open', 50_000), 53_000);
  assert.equal(commandLimitMs('open', 2000), 5000);
  // Never past what Node's timers take.
  assert.equal(commandLimitMs('eval', MAX_TIMER_SECONDS * 1000), MAX_TIMER_SECONDS * 1000);
});

test('budgeted: a wait keeps its own limit outside a budget, and what is left inside one', async () => {
  assert.equal(budgeted(5000), 5000);
  await inBudget(deadlineIn(1000), async () => {
    assert.ok(budgeted(5000) <= 1000);
    assert.equal(budgeted(200), 200);
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(budgeted(5000) <= 400);
  });
  // No budget given: as outside one.
  assert.equal(inBudget(undefined, () => budgeted(5000)), 5000);
});
