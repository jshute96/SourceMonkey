// The longest a command sent to a run may take before the run stops
// waiting on it, and freeing a page whose JavaScript never yields.
//
// Without a limit, one `eval` on a page stuck in a loop (or awaiting a
// promise that never settles) holds up every command queued after it,
// for good. Past the limit the run reports the command as failed and
// takes the next one. The command's own work can't be cancelled from
// Node, so it runs on, and the runner drops what it prints after that.
//
// A page busy in JavaScript that never yields answers nothing, so
// it is stopped over CDP (the Chrome DevTools Protocol) with
// `Runtime.terminateExecution` (`PageAttachment.stopScript`), which
// ends the script running in the page's main thread.

import type { Page } from '@playwright/test';

import { MAX_TIMER_SECONDS, TIMEOUT_FLAG, timeoutSecondsMs } from './command-list.js';
import type { PageAttachment } from './page-watch.js';
import { within } from './wait.js';

/** A command's limit when it isn't given `--timeout-seconds`. */
export const COMMAND_LIMIT_MS = 60_000;

// Past a given `--timeout-seconds`, how long the command's last wait
// has to say it gave up before the command counts as hung: a `click`
// that times out still looks for why. Its waits keep to the given time
// themselves (see `budgeted` in wait.ts); what isn't a wait (an
// `eval`'s expression) is cut off here.
const GRACE_MS = 3000;

// Commands with no limit: `wait` keeps its own, which may be long, and
// `stop` and `exit` end the run. `start` and `attach` connect to a
// browser, which has its own timeouts. Each of `cdp`'s calls has its
// own limit, and a block may hold many.
const UNLIMITED = new Set(['wait', 'stop', 'exit', 'start', 'attach', 'cdp']);

// Commands with a shorter backstop, since they wait on nothing that
// can be slow: answering a dialog is one CDP call or one message to the
// extension, and `dialog` doesn't wait for what the page does after.
const SHORT_LIMITS_MS: Record<string, number> = { dialog: 10_000 };

/**
 * The `--timeout-seconds` given in `line`, in ms, or undefined when
 * none is (or it isn't a number of seconds, which the command itself
 * says).
 */
export function givenTimeoutMs(line: string): number | undefined {
  const given = new RegExp(`(?:^|\\s)${TIMEOUT_FLAG}(?:=|\\s+)(\\S+)`).exec(line);
  return (given ? timeoutSecondsMs(given[1]) : null) ?? undefined;
}

/**
 * How long `command` (its name, aliases resolved) may run before it
 * counts as hung, or null for no limit: `givenMs`, its
 * `--timeout-seconds`, or else `defaultMs`.
 */
export function commandLimitMs(command: string, givenMs: number | undefined, defaultMs = COMMAND_LIMIT_MS): number | null {
  if (UNLIMITED.has(command)) return null;
  // Node's timers take at most 2^31 - 1 ms, and fire at once past it.
  return givenMs === undefined ? Math.min(defaultMs, SHORT_LIMITS_MS[command] ?? defaultMs) : Math.min(givenMs + GRACE_MS, MAX_TIMER_SECONDS * 1000);
}

// How long a page has to answer before it counts as stuck: well past a
// long task on a slow page, which the stop would otherwise cut short.
const ANSWER_MS = 3000;

// The longest stopping one page may take: a browser that doesn't
// answer at all can't be helped from here.
const STOP_MS = 3000;

/**
 * Whether `page` is stuck running JavaScript: it doesn't run a trivial
 * expression within `ANSWER_MS`. A failure (a closed page, one between
 * documents) isn't. Only the top frame's process is checked, so a
 * cross-site iframe stuck in its own process isn't found.
 */
export async function pageBusy(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  return await within(page.evaluate(() => 1).then(() => false, () => false), ANSWER_MS) === 'timeout';
}

/**
 * Ends the JavaScript running in the page `link` watches. False when
 * it couldn't be reached in time.
 */
export async function stopPageScript(link: PageAttachment): Promise<boolean> {
  return await within(link.stopScript().then(() => true, () => false), STOP_MS) === true;
}
