// Waiting: the `wait` command, and the settling that it and the waits
// after `start`, loads and actions share.
//
// A tab has settled when nothing sm-dev can see is still
// happening in it. A browser has no signal for "the scripts are done":
// JavaScript runs on events, and a page can keep timers, intervals and
// sockets going for good. So settled is a set of signals all quiet
// together for a short window, counted from when the wait began:
//   - the document has loaded;
//   - each script the document runs whose rules cover the page has
//     reported (started, skipped or thrown);
//   - no `GM_xmlhttpRequest` of its scripts is in flight;
//   - no request of the page's is in flight;
//   - its DOM hasn't changed;
//   - and then its main thread has a moment with nothing to do.
// Requests open over a few seconds are taken for long-lived ones (a
// socket, a stream, a long poll), which would keep a page from ever
// settling. Timers are not waited for: they are set up to run later. A
// short one that matters changes the DOM when it fires, which the
// window catches, since it starts no earlier than the wait.

import type { Page } from '@playwright/test';

import type { ConsoleContext, ControlledTab } from './console-commands.js';
import type { HarnessHost } from './host.js';
import type { ParsedArgs } from './command-args.js';
import { countOf } from './page-commands.js';
import { explainMatch, preparedScriptName } from './prepare.js';
import { refProblem } from './snapshot.js';
import { currentTab, dialogWaitingMessage, NO_TABS, pickTab, TAB_ARG, tabName } from './tab-refs.js';

/** How long every signal must stay quiet. */
const QUIET_MS = 200;

/** How long a wait lasts before it says what is still busy. */
export const SETTLE_TIMEOUT_MS = 5000;

// A request open this long counts as long-lived.
const LONG_REQUEST_MS = 3000;

// The longest one look into the page may take: a page busy in a long
// script doesn't answer, which counts as busy.
const LOOK_MS = 1000;

const POLL_MS = 50;

// The longest a Node timer can wait, in seconds.
const MAX_WAIT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

// How often `wait selector` looks again, and the longest one look may
// take: a page busy in a long script, or stopped on a dialog, doesn't
// answer.
const SELECTOR_POLL_MS = 100;
const SELECTOR_LOOK_MS = 1000;

// How the replies of the waits with something to match start, so each
// says plainly whether it got it.
const WAIT_DONE = '[sm-dev] Wait done: ';
const TIMEOUT_NEEDS_SECONDS = `The --timeout-seconds flag needs a number of seconds, up to ${MAX_WAIT_SECONDS}`;
const WAIT_FAILED = '[sm-dev] Wait failed: ';
const LOG_MATCHED = '[sm-dev] Wait matched log line: ';

// ---------- Settling ----------

export type SettleOutcome =
  | { settled: true }
  /** Still busy at the deadline: what with, as the message lists it. */
  | { settled: false; busy: string[] }
  /** A dialog opened, which stops the page until it is answered. */
  | { settled: false; dialog: true }
  /** The tab closed. */
  | { settled: false; closed: true };

/** Waits for `tab` to settle, up to `timeoutMs`. */
export async function settleTab(tab: ControlledTab, host: HarnessHost, timeoutMs = SETTLE_TIMEOUT_MS): Promise<SettleOutcome> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  // Each look bounded by the time left too, so a short timeout holds.
  const look = (): number => Math.max(POLL_MS, Math.min(LOOK_MS, deadline - Date.now()));
  for (;;) {
    if (tab.page.isClosed()) return { settled: false, closed: true };
    if (tab.dialogs?.current) return { settled: false, dialog: true };
    let busy = await busyWith(tab, host, look(), started);
    if (busy.length === 0) {
      // Last, once the rest is quiet: the main thread free, and nothing
      // changed while it got there. A document that went away meanwhile
      // just makes the next look busy.
      await within(tab.link.idle(look()).catch(() => undefined), look());
      busy = await busyWith(tab, host, look(), started);
      if (busy.length === 0) return { settled: true };
    }
    if (Date.now() >= deadline) {
      return tab.page.isClosed() ? { settled: false, closed: true } : { settled: false, busy };
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * What still keeps `tab` from counting as settled, each starting with
 * words of ours, lowercase, as the message lists them; empty when
 * nothing does. `started`: when the wait began, which the quiet window
 * can't start before, so what an action sets off a moment later is
 * waited for even on a page that was quiet.
 */
async function busyWith(tab: ControlledTab, host: HarnessHost, lookMs: number, started: number): Promise<string[]> {
  const busy: string[] = [];
  const { link } = tab;
  const activity = await within(link.activity().catch(() => null), lookMs);
  if (activity === 'timeout') return ['the page\'s JavaScript is busy'];
  if (activity === null) return tab.page.isClosed() ? [] : ['the page has no document yet'];
  if (activity.readyState !== 'complete') busy.push('the page is still loading');
  // The scripts the document runs report once there; one whose rules
  // don't cover the page may say nothing (as on about:blank), and has
  // nothing to wait for anyway. Reports from the document's first
  // span count, so one the back/forward cache restored, where the
  // scripts don't run again, isn't waited on.
  const url = tab.page.url();
  const scripts = link.scriptsInDocument().filter((s) => s.spec && explainMatch(s.matching, url).matches);
  const waiting = host.unreported(link, scripts.map((s) => s.spec!.id), link.documentFirstStart());
  if (waiting.length > 0) {
    busy.push(`scripts not started yet: ${scripts.filter((s) => waiting.includes(s.spec!.id)).map(preparedScriptName).join(', ')}`);
  }
  const now = Date.now();
  const xhrs = host.reports.requests.filter((r) => !r.outcome && host.pageOf(r) === link
    && r.at >= link.documentFirstStart() && now - r.at < LONG_REQUEST_MS);
  if (xhrs.length > 0) busy.push(`${count(xhrs.length, 'GM_xmlhttpRequest')} pending (${urls(xhrs.map((r) => r.url))})`);
  const network = link.network();
  const pending = network.pending.filter((r) => r.ms < LONG_REQUEST_MS);
  if (pending.length > 0) busy.push(`${count(pending.length, 'request')} pending (${urls(pending.map((r) => r.url))})`);
  else if (network.sinceLast < QUIET_MS) busy.push('a request just finished');
  if (activity.sinceDom < QUIET_MS) busy.push(`the DOM is still changing${activity.lastChanged ? ` (${activity.lastChanged})` : ''}`);
  // Nothing else to say, but the window hasn't passed since the wait
  // began (only a timeout shorter than the window shows it).
  if (busy.length === 0 && now - started < QUIET_MS) busy.push('the quiet moment it waits for hasn\'t passed yet');
  return busy;
}

/**
 * After a load, an action or `start`: each tab settling, all at once.
 * One that doesn't in time is said, without failing anything, since
 * what came before worked. A dialog or a closed tab says so elsewhere,
 * and a tab whose load already gave up (`stalled`) isn't waited on
 * again.
 */
export async function settleTabs(host: HarnessHost, tabs: ControlledTab[], out: (line: string) => void): Promise<void> {
  // Only real tabs: a caller's `newTab` (a test's) may return none.
  await Promise.all(tabs.filter((t) => t?.page && !t.stalled).map(async (t) => {
    const outcome = await settleTab(t, host);
    if (!outcome.settled && 'busy' in outcome) out(`[sm-dev] ${notSettledMessage(t, SETTLE_TIMEOUT_MS, outcome.busy)}`);
  }));
}

/** How long a load (`open`, `reload`, the tabs `start` opens) may take. */
export const LOAD_TIMEOUT_MS = 30_000;

// How often a load looks for a page that stopped itself.
const STOPPED_POLL_MS = 100;

/**
 * Runs a navigation (`page.goto`, `page.reload`) until the new page
 * has loaded. A page that stops its own load with `window.stop()`
 * counts as loaded: its readyState goes to complete, but it never
 * fires `load`, which a plain `goto` waits for until it times out.
 * Rejects with the navigation's own error, or when the page doesn't
 * load in time.
 */
export async function loadPage(
  page: Page, navigate: (opts: { waitUntil: 'commit'; timeout: number }) => Promise<unknown>, timeoutMs = LOAD_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await navigate({ waitUntil: 'commit', timeout: timeoutMs });
  let ended = false;
  const load = page.waitForLoadState('load', { timeout: Math.max(1, deadline - Date.now()) }).then(
    () => true,
    (err: Error) => {
      if (err.name === 'TimeoutError') return false;
      throw err;
    },
  ).finally(() => { ended = true; });
  // Reads readyState in a later task than the one that set it, so a
  // load that did fire has run its listeners by then too.
  const stopped = (async () => {
    while (!ended && Date.now() < deadline) {
      if (await page.evaluate(() => document.readyState).catch(() => null) === 'complete') return true;
      await sleep(STOPPED_POLL_MS);
    }
    return false;
  })();
  try {
    if (!await Promise.race([load, stopped])) throw new Error(`The page did not finish loading within ${seconds(timeoutMs)}`);
  } finally {
    ended = true;
    load.catch(() => undefined);
  }
}

/** The message when `tab` didn't settle in time, as every wait says it. */
export function notSettledMessage(tab: { n: number }, timeoutMs: number, busy: string[]): string {
  const list = busy.join('; ');
  return `T${tab.n} did not settle within ${seconds(timeoutMs)}: ${list.charAt(0).toUpperCase()}${list.slice(1)}`;
}

// ---------- The wait command ----------

/**
 * `wait`: until a tab settles, an element appears or goes, or an output
 * line shows up; or a plain delay. `parsed`: its words, as its syntax
 * reads them (command-args.ts). False when it gave up or was invalid,
 * so a line of several commands stops there.
 */
export async function waitFor(ctx: ConsoleContext, parsed: ParsedArgs): Promise<boolean> {
  const mistake = (text: string): false => {
    ctx.out(`[sm-dev] ERROR: ${text}`);
    return false;
  };
  let timeoutMs = SETTLE_TIMEOUT_MS;
  const timeout = parsed.flags['--timeout-seconds'];
  if (timeout !== undefined) {
    const value = Number(timeout);
    if (!(value > 0) || value > MAX_WAIT_SECONDS) return mistake(TIMEOUT_NEEDS_SECONDS);
    timeoutMs = value * 1000;
  }

  if (parsed.form === 'log') {
    if (parsed.tab !== undefined) return mistake('The wait log command takes no tab, since it watches all of the run\'s output');
    return waitForLog(ctx, parsed.text ?? '', timeoutMs);
  }

  const [word, ...more] = parsed.words;
  if (more.length > 0) {
    // `wait all selector .x`: `all` isn't a tab, so the form wasn't taken.
    if (word === 'all' && (more[0] === 'selector' || more[0] === 'selector-gone')) {
      return mistake(`The wait ${more[0]} command looks in one tab. Name it (T2), or leave it out for the current one.`);
    }
    const valid = word === 'all' || parseDelay(word) !== null;
    return mistake(`The wait command takes a tab, all, selector, selector-gone, log, or a delay such as 500ms or 2s, not ${valid ? more.join(' ') : word}`);
  }

  // A plain delay.
  const delay = word !== undefined && parsed.tab === undefined ? parseDelay(word) : null;
  if (delay !== null) {
    if (timeout !== undefined) return mistake('A delay takes no --timeout-seconds');
    if (delay > MAX_WAIT_SECONDS * 1000) return mistake(`A delay can be at most ${MAX_WAIT_SECONDS}s`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return true;
  }

  // The tab, or all of them.
  let tabs: ControlledTab[];
  if (parsed.tab !== undefined) {
    const picked = pickTab(ctx, parsed.tab);
    if (!picked) return false;
    tabs = [picked];
  } else if (word === 'all') {
    tabs = ctx.tabs();
  } else {
    const current = currentTab(ctx);
    tabs = current ? [current] : [];
  }
  if (tabs.length === 0) {
    ctx.out(NO_TABS);
    return false;
  }

  const kind = parsed.form;
  if (kind === 'selector' || kind === 'selector-gone') {
    const selector = parsed.text ?? '';
    if (!selector) return mistake(`The wait ${kind} command needs a selector, e.g. wait ${kind} '#results'`);
    const [first, ...more] = selector.split(/\s+/);
    const timed = timeout !== undefined ? ` --timeout-seconds ${timeout}` : '';
    if (more.length > 0 && TAB_ARG.test(first)) return mistake(`The tab goes before the word ${kind}: wait ${first} ${kind} ${more.join(' ')}${timed}`);
    return waitForSelector(ctx, tabs[0], selector, kind === 'selector', timeoutMs);
  }
  if (word === undefined || word === 'all') return waitToSettle(ctx, tabs, timeoutMs);
  return mistake(`The wait command takes a tab, all, selector, selector-gone, log, or a delay such as 500ms or 2s, not ${word}`);
}

// `wait [T<n>|all]`: each tab settling, all at once.
async function waitToSettle(ctx: ConsoleContext, tabs: ControlledTab[], timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  const outcomes = await Promise.all(tabs.map((t) => settleTab(t, ctx.host, timeoutMs)));
  let ok = true;
  outcomes.forEach((outcome, i) => {
    if (outcome.settled) return;
    ok = false;
    const t = tabs[i];
    ctx.out('dialog' in outcome ? `${WAIT_FAILED}${dialogWaitingMessage(t, currentTab(ctx))}`
      : 'closed' in outcome ? `${WAIT_FAILED}${tabName(t)} closed`
        : `[sm-dev] ${notSettledMessage(t, timeoutMs, outcome.busy)}`);
  });
  if (ok) {
    const took = seconds(Date.now() - started);
    ctx.out(`[sm-dev] ${tabs.length === 1 ? `${tabName(tabs[0])} settled` : 'All tabs settled'} in ${took}`);
  }
  return ok;
}

// `wait selector` / `wait selector-gone`: looks again until it holds.
// Each look is bounded, so the timeout holds, and a dialog that opens
// meanwhile ends the wait rather than stopping it for good.
async function waitForSelector(
  ctx: ConsoleContext, tab: ControlledTab, selector: string, present: boolean, timeoutMs: number,
): Promise<boolean> {
  const name = tabName(tab);
  // A ref from a snapshot of another page matches nothing, which would
  // pass for gone.
  const problem = await within(refProblem(tab.page, selector).catch(() => null), SELECTOR_LOOK_MS);
  if (typeof problem === 'string' && problem !== 'timeout') {
    ctx.out(`${WAIT_FAILED}${problem}`);
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tab.page.isClosed()) {
      ctx.out(`${WAIT_FAILED}${name} closed`);
      return false;
    }
    if (tab.dialogs?.current) {
      ctx.out(`${WAIT_FAILED}${dialogWaitingMessage(tab, currentTab(ctx))}`);
      return false;
    }
    const count = await within(countOf(tab.page, selector), Math.max(1, Math.min(SELECTOR_LOOK_MS, deadline - Date.now())));
    if (typeof count === 'string' && count !== 'timeout') {
      ctx.out(`${WAIT_FAILED}The selector ${selector} can't be used: ${count}`);
      return false;
    }
    if (typeof count === 'number' && (present ? count > 0 : count === 0)) {
      ctx.out(`${WAIT_DONE}The selector ${selector} ${present ? 'matches' : 'matches nothing'} on ${name}`);
      return true;
    }
    if (Date.now() >= deadline) {
      const limit = seconds(timeoutMs);
      ctx.out(`${WAIT_FAILED}The selector ${selector} ${present ? `matched nothing on ${name} within` : `still matched on ${name} after`} ${limit}`);
      return false;
    }
    await sleep(SELECTOR_POLL_MS);
  }
}

// `wait log`: a line the page or scripts printed (see OutputHistory),
// with the text or matching the /regex/, since the previous command
// began or from now on.
async function waitForLog(ctx: ConsoleContext, text: string, timeoutMs: number): Promise<boolean> {
  if (!text) {
    ctx.out('[sm-dev] ERROR: The wait log command needs the text to look for, e.g. wait log ready');
    return false;
  }
  const output = ctx.output;
  if (!output) {
    ctx.out(`${WAIT_FAILED}This run cannot watch its output`);
    return false;
  }
  const regex = /^\/(.+)\/([a-z]*)$/.exec(text);
  let matches: (line: string) => boolean;
  if (regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(regex[1], regex[2]);
    } catch (err) {
      ctx.out(`[sm-dev] ERROR: ${text} is not a valid regular expression: ${(err as Error).message}`);
      return false;
    }
    // Each line from its start: g and y otherwise carry on from where
    // the last match ended, which would skip matches. So y anchors the
    // match at the start of the line.
    matches = (line) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    };
  } else {
    matches = (line) => line.includes(text);
  }
  const earlier = output.since(ctx.previousStart ?? 0).find(matches);
  if (earlier !== undefined) {
    ctx.out(`${LOG_MATCHED}${earlier}`);
    return true;
  }
  const found = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(null);
    }, timeoutMs);
    const stop = output.watch((line) => {
      if (!matches(line)) return;
      clearTimeout(timer);
      stop();
      resolve(line);
    });
  });
  // Seen as it streamed; said again, so the reply says it was found.
  // Plain text quoted, so its spaces show; a regex shows as its /.../.
  const shown = regex ? text : JSON.stringify(text);
  ctx.out(found !== null ? `${LOG_MATCHED}${found}` : `${WAIT_FAILED}No output line matched ${shown} within ${seconds(timeoutMs)}`);
  return found !== null;
}

// ---------- Helpers ----------

/**
 * A plain delay as typed, `100ms` or `5s` (`1.5s` too), in milliseconds;
 * null for anything else.
 */
export function parseDelay(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(text);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
}

/** A duration as the messages say it: `5s`, `0.3s`. */
export function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// A few URLs, each shortened to its path, and a count of the rest.
function urls(list: string[]): string {
  const shown = list.slice(0, 3).map((url) => {
    try {
      const u = new URL(url);
      return u.protocol.startsWith('http') ? `${u.pathname}${u.search}`.slice(0, 80) : url.slice(0, 80);
    } catch {
      return url.slice(0, 80);
    }
  });
  return list.length > 3 ? `${shown.join(', ')}, and ${list.length - 3} more` : shown.join(', ');
}

/** `work`'s result, or `timeout` once `ms` has passed. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
