// The typed commands that act on a tab's page directly: drive it
// (click, hover, type, key, eval), look at it (snapshot, screenshot,
// savehtml, probe, logs), and send it raw CDP calls (cdp). console-commands.ts picks the tab and hands
// the rest of the line here.
//
// Built on the run's own Playwright connection to its tabs: real input
// events (scrolled into view, the page sees them as a person's), key
// names as Playwright spells them (`Shift+ArrowRight`), and the
// accessibility tree as text. Actions wait for the page to settle (wait.ts)
// before returning, so the next command sees what the last one did.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Locator, Page, Request } from '@playwright/test';

import type { ParsedArgs } from './command-args.js';
import { PROBE_MAX } from './command-list.js';
import type { ControlledTab } from './console-commands.js';
import { ScriptThrew } from './inject.js';
import { readInputFile } from './input-file.js';
import { notSettledMessage, SETTLE_TIMEOUT_MS, settleTab } from './wait.js';
import { savePageHtml } from './save-html.js';
import { shownPath } from './prepare.js';
import { documentOf, framesAround, locate, named, noteRefs, onScreen, probeMatches, refOf, refProblem, tidy, withoutDocument } from './snapshot.js';

export const PAGE_COMMANDS = new Set(['click', 'hover', 'type', 'key', 'eval', 'snapshot', 'screenshot', 'savehtml', 'probe', 'logs', 'cdp']);

// How long an action waits for its element. Settling after it has its
// own limit (wait.ts).
const ACTION_TIMEOUT_MS = 5000;
// How long a whole-page screenshot waits for the browser to capture it.
const SCREENSHOT_TIMEOUT_MS = 5000;
// How long a quick look into the page waits for an answer.
const CHECK_TIMEOUT_MS = 1000;
// How long each `cdp` call waits for its reply.
const CDP_TIMEOUT_MS = 10_000;
// A CDP method name, `Domain.method`, which starts each `cdp` call.
const CDP_METHOD = /^[A-Za-z]+\.[A-Za-z]+$/;

/**
 * A quick yes/no from the page, false when it doesn't answer in time:
 * a page stopped by a dialog or busy in a long script never does.
 */
export function pageSays(page: Page, check: () => boolean): Promise<boolean> {
  const answer = page.evaluate(check).catch(() => false);
  const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), CHECK_TIMEOUT_MS).unref());
  return Promise.race([answer, timeout]);
}

// The console lines and errors each page has had, for `logs`: all of
// them, not only the ones the run's stream shows. The newest are kept,
// each cut short past a length.
const LOG_LIMIT = 1000;
const LOG_LINE_LIMIT = 2000;
const logs = new WeakMap<Page, string[]>();

/** Records a console line or error of the page's, or a page it loaded, for `logs`. */
export function recordLog(page: Page, line: string): void {
  let lines = logs.get(page);
  if (!lines) {
    lines = [];
    logs.set(page, lines);
  }
  lines.push(line.length > LOG_LINE_LIMIT ? `${line.slice(0, LOG_LINE_LIMIT)}…` : line);
  if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
}

// The keys `click --modifiers` can hold, as Playwright names them.
const MODIFIERS = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] as const;

/**
 * A page command's arguments, read by its syntax (command-args.ts), the
 * tab already taken from them. `userscripts`: the ones running in the
 * tab's page now, as a saved file's header names them
 * (`userscriptLabel`).
 */
export interface PageInput extends ParsedArgs {
  userscripts: string[];
}

// Image types `screenshot` can write, by the file's extension.
const IMAGE_FILE = /\.(png|jpe?g)$/i;

/**
 * Runs one of `PAGE_COMMANDS` on `tab`. Reports through `out`, and
 * resolves once the command and what it set off are done, or once a
 * dialog it opened is waiting for an answer: the page stops until then,
 * and `accept` or `dismiss` can't run while this does. False when it
 * failed (no element, a timeout, an expression that threw), so a line
 * of several commands stops there. A mistake in how it was typed is an
 * `ERROR:` line, which stops the line too.
 */
export async function runPageCommand(
  command: string, input: PageInput, tab: ControlledTab, out: (line: string) => void, cwd = process.cwd(),
): Promise<boolean | void> {
  const say = (line: string): void => out(`[sm-dev] ${line}`);
  const { page } = tab;
  // A file it names, from `cwd`, and as said back.
  const file = (name: string): string => path.resolve(cwd, name);
  const shown = (name: string): string => shownPath(file(name), cwd);
  // `work`, or false as soon as a dialog opens during it. A dialog stops
  // the page, so `work` would wait on it for good. The tracker says
  // what opened; the command just stops waiting.
  const done = async (work: Promise<unknown>): Promise<boolean> => {
    const finished = work.then(() => true);
    // What `work` still does after a dialog is its own affair.
    finished.catch(() => undefined);
    if (!tab.dialogs) return finished;
    return !await tab.dialogs.untilDialog(finished.then(() => false));
  };
  // An action, then the page settling (see wait.ts), each stopping at
  // a dialog. A page that doesn't settle in time says why, and the
  // action still counts as done.
  const act = async (work: Promise<unknown>, what: string): Promise<void> => {
    if (!await done(work)) {
      say(`${what}. It opened a dialog, which is waiting for an answer.`);
      return;
    }
    if (input.flags['--nowait']) {
      say(what);
      return;
    }
    const settled = await settleTab(tab, tab.link.host);
    if (!settled.settled && 'dialog' in settled) {
      say(`${what}. The page opened a dialog, which is waiting for an answer.`);
      return;
    }
    say(what);
    if (!settled.settled && 'busy' in settled) say(notSettledMessage(tab, SETTLE_TIMEOUT_MS, settled.busy));
  };
  try {
    switch (command) {
      case 'eval': {
        // Its JavaScript: the rest of the line as typed, its quotes its
        // own, or a block's lines, or a file's.
        const world = input.flags['--script'] ? 'scripts' : 'page';
        const from = input.flags['--file'];
        let expression = [input.text, input.block].filter((part) => part).join('\n');
        if (typeof from === 'string') {
          if (expression) {
            say('ERROR: The eval command takes JavaScript or --file, not both');
            return;
          }
          try {
            expression = readInputFile(file(from), shown(from));
          } catch (err) {
            say(`ERROR: ${(err as Error).message}`);
            return;
          }
        }
        if (!expression) {
          say('ERROR: The eval command needs an expression, e.g. eval document.title');
          return;
        }
        let result = '';
        const evaluated = tab.link.evaluate(expression, world).then((r) => { result = r; });
        try {
          if (!await done(evaluated)) {
            say('The expression opened a dialog, which is waiting for an answer.');
            return;
          }
        } catch (err) {
          // Navigating or closing may be what the expression was for, so
          // those aren't failures.
          if (page.isClosed()) say('The tab closed before the expression finished');
          else if (CUT_OFF_BY_NAVIGATION.test((err as Error).message)) say('The page navigated away before the expression finished');
          else {
            say(err instanceof ScriptThrew ? `The expression threw: ${err.message}` : `Internal error: ${(err as Error).message}`);
            return false;
          }
          return;
        }
        // Its console lines come through another session than its result.
        await done(tab.link.drain());
        out(result);
        return;
      }
      case 'click':
      case 'hover': {
        const options = clickOptions(input.flags, input.text ?? '');
        if (typeof options === 'string') {
          say(`ERROR: ${options}`);
          return;
        }
        const { selector } = options;
        if (!selector) {
          say(`ERROR: The ${command} command needs a selector, e.g. ${command} '#submit'`);
          return;
        }
        const count = await matches(page, selector, say);
        if (count === null) return false;
        const target = locate(page, selector).first();
        const action = (command === 'click'
          ? target.click({ ...options.click, timeout: ACTION_TIMEOUT_MS })
          : target.hover({ modifiers: options.click.modifiers, position: options.click.position, timeout: ACTION_TIMEOUT_MS }))
          // A point it can't reach says so, rather than that the element
          // was covered (by whatever is at that point) or not ready.
          .catch(async (err: Error) => {
            if (!/Timeout \d+ms exceeded/.test(err.message)) throw err;
            const why = plain(err);
            // The call log's own reasons (hidden, disabled, moving) stand.
            if (why !== notReadyGeneral(ACTION_TIMEOUT_MS / 1000) && !why.startsWith(COVERED)) throw err;
            throw new Error(await placeProblem(page, target, options.click.position) ?? err.message);
          });
        const how = options.how.length > 0 ? ` with ${options.how.join(', ')}` : '';
        await act(action, `${command === 'click' ? 'Clicked' : 'Hovered over'} ${named(page, selector)}${count > 1 ? ` (the first of ${count} matches)` : ''}${how}`);
        return;
      }
      case 'type': {
        // `type <selector> <text>`, or the text as a `{{` block's lines
        // (exactly, each line break an Enter), or `--file <path>` (the
        // flag first works too). Typed, the selector and flag are on
        // the command's own line.
        const [selector] = input.words;
        const from = input.flags['--file'];
        let text: string;
        if (typeof from === 'string') {
          if (input.text || input.block !== undefined) {
            say('ERROR: The type command takes text or --file, not both');
            return;
          }
          if (!selector) {
            say('ERROR: The type command takes a selector and one file, e.g. type \'#notes\' --file notes.txt');
            return;
          }
          try {
            // The file's text as it is, a last line break included.
            // Windows line breaks as one Enter each, not two.
            text = readInputFile(file(from), shown(from), { blankOk: true }).replace(/\r\n?/g, '\n');
          } catch (err) {
            say(`ERROR: ${(err as Error).message}`);
            return;
          }
        } else if (input.block !== undefined) {
          if (input.text || !selector) {
            say('ERROR: The type command takes one selector before {{. Quote a selector that has spaces.');
            return;
          }
          text = input.block;
        } else {
          text = input.text ?? '';
        }
        if (!selector || !text) {
          say('ERROR: The type command needs a selector and the text, e.g. type \'input[name=q]\' \'hello world\'');
          return;
        }
        const count = await matches(page, selector, say);
        if (count === null) return false;
        const typing = locate(page, selector).first().pressSequentially(text, { timeout: ACTION_TIMEOUT_MS });
        await act(typing, `Typed into ${named(page, selector)}${count > 1 ? ` (the first of ${count} matches)` : ''}`);
        return;
      }
      case 'key': {
        const keys = input.words;
        if (keys.length === 0) {
          say('ERROR: The key command needs a key, e.g. key j or key Shift+ArrowRight');
          return;
        }
        const unjoined = keys.find((k) => keyParts(k).includes(''));
        if (unjoined) {
          say(`ERROR: ${unjoined} has a + with no key on one side. Join keys with +, as in Shift+Tab.`);
          return;
        }
        const named = keys.map(keyName);
        // Escape leaves fullscreen as Chrome's own shortcut, which a key
        // sent over CDP never reaches. The page may still leave on its
        // own. Fullscreen before and after, so one the keys entered isn't
        // taken for one Escape failed to leave.
        const escape = named.some((k) => keyParts(k).at(-1) === 'Escape');
        const isFullscreen = () => document.fullscreenElement !== null;
        const wasFullscreen = escape && await pageSays(page, isFullscreen);
        const pressing = (async () => {
          for (const key of named) await page.keyboard.press(key);
        })();
        await act(pressing, `Pressed ${named.join(', ')}`);
        if (wasFullscreen && !tab.dialogs?.current && await pageSays(page, isFullscreen)) {
          say('The page is still fullscreen. Escape sent by sm-dev goes to the page rather than to Chrome. To exit, use eval document.exitFullscreen().');
        }
        return;
      }
      case 'snapshot': {
        // The whole page is `:root`, not `body`: scripts often add their
        // panels to <html>, after <body>.
        const selector = input.text || ':root';
        if (await matches(page, selector, say) === null) return false;
        const visible = input.flags['--visible'] === true;
        let tree = '';
        const taking = (async () => {
          const doc = await documentOf(page);
          tree = await locate(page, selector).first().ariaSnapshot({ mode: 'ai', boxes: visible, timeout: ACTION_TIMEOUT_MS });
          noteRefs(page, tree, doc, framesAround(page, selector));
          if (visible) {
            const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
            tree = onScreen(tree, width, height);
          }
          // Refs resolve against the latest snapshot only, so one of part
          // of the page is followed by one of the whole, quietly, to keep
          // the rest's refs working. An element keeps its ref across
          // snapshots. The whole is all of `:root`, or a part's elements
          // outside <body> would lose their refs to it. Failing, it costs
          // only those refs.
          if (input.text) {
            const whole = await page.locator(':root').ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS }).catch(() => null);
            if (whole !== null) noteRefs(page, whole, doc);
          }
          // The whole page's, however named (`:root`, `html`).
          tree = tidy(withoutDocument(tree));
        })();
        if (!await done(taking)) {
          say('The page opened a dialog during the snapshot, which is waiting for an answer.');
          return;
        }
        const outFile = input.flags['--out'];
        if (typeof outFile === 'string') {
          await write(outFile, () => writeFile(file(outFile), tree + '\n'));
          say(`Wrote ${shown(outFile)} (${tree.split('\n').length} lines) from ${page.url()}`);
          return;
        }
        for (const line of tree.split('\n')) out(line);
        return;
      }
      case 'screenshot': {
        const rest = [...input.words];
        const image = rest.pop();
        if (!image) {
          say('ERROR: The screenshot command needs a file, and takes one selector before it, e.g. screenshot \'#comments\' c.png');
          return;
        }
        if (!IMAGE_FILE.test(image)) {
          say(`ERROR: The screenshot command writes a .png or .jpg file, and ${image} is neither. Name the file last.`);
          return;
        }
        const selector = rest[0];
        if (selector) {
          if (input.flags['--full']) {
            say('ERROR: The --full flag is for the whole page, not an element');
            return;
          }
          if (await matches(page, selector, say) === null) return false;
          await write(image, () => locate(page, selector).first().screenshot({ path: file(image), timeout: ACTION_TIMEOUT_MS }));
        } else {
          try {
            await write(image, () => page.screenshot({ path: file(image), fullPage: input.flags['--full'] === true, timeout: SCREENSHOT_TIMEOUT_MS }));
          } catch (err) {
            if ((err as Error).name !== 'TimeoutError' || page.isClosed()) throw err;
            say(`Screenshot failed: Browser did not capture the page within ${SCREENSHOT_TIMEOUT_MS / 1000} seconds`);
            return false;
          }
        }
        say(`Wrote ${shown(image)}${selector ? ` (${named(page, selector)})` : ''} from ${page.url()}`);
        return;
      }
      case 'savehtml': {
        const words = input.words;
        if (words.length !== 1) {
          say('ERROR: The savehtml command needs a file, e.g. savehtml page.html');
          return;
        }
        let html = '';
        await write(words[0], async () => { html = await savePageHtml(page, file(words[0]), input.userscripts); });
        say(`Wrote ${shown(words[0])} (${html.length} chars) from ${page.url()}`);
        if (input.userscripts.length > 0) say('It has the scripts\' changes in it, and its header lists them. For a copy without them, save it from a tab without scripts (newtab --noscript).');
        return;
      }
      case 'probe': {
        if (input.words.length === 0) {
          say('ERROR: The probe command needs a selector or more, e.g. probe \'.titleline\' \'#hnmain\'');
          return;
        }
        const css = input.flags['--css'] === true;
        const html = input.flags['--html'] === true;
        for (const selector of input.words) {
          const lines: string[] = [];
          const probing = (async () => {
            const count = await refProblem(page, selector) ?? await countOf(page, selector);
            if (typeof count === 'string') lines.push(`invalid  ${selector}  (${count})`);
            else if (count === 0) lines.push(`missing  ${selector}`);
            else {
              lines.push(`found    ${selector}  (${count})`);
              if (!css && !html) return;
              const found = await probeMatches(page, selector, PROBE_MAX, ACTION_TIMEOUT_MS).catch((err: Error) => plain(err));
              if (typeof found === 'string') {
                lines.push(`    The matches could not be read: ${found}`);
                return;
              }
              for (const match of found.matches) {
                // One in a frame only works within it, so it isn't given.
                const none = found.framed ? 'in a frame' : match.shadow ? 'in a shadow root' : null;
                if (css) lines.push(`    selector: ${none ? `(none: ${none})` : match.css ?? '(none found)'}`);
                if (html) lines.push(`    html: ${match.html}`);
              }
              if (found.count > found.matches.length) lines.push(`    (${found.count - found.matches.length} more)`);
            }
          })();
          const finished = await done(probing);
          for (const line of lines) out(line);
          if (!finished) {
            say('The page opened a dialog during the probe, which is waiting for an answer.');
            return;
          }
        }
        return;
      }
      case 'cdp': {
        // `--file <path>`: the calls from a file, one per line, as a block
        // has them.
        let calls: CdpCall[] | string;
        const name = input.flags['--file'];
        if (typeof name === 'string') {
          if (input.text || input.block !== undefined) {
            say('ERROR: The cdp command takes calls or --file <path>, not both');
            return;
          }
          try {
            calls = cdpCallsTyped(readInputFile(file(name), shown(name)), { first: 1, name: (n) => `${shown(name)}, line ${n}` });
          } catch (err) {
            say(`ERROR: ${(err as Error).message}`);
            return;
          }
        } else if (input.block !== undefined) {
          // The command's own line is line 0, the block's first line 1.
          calls = cdpCallsTyped(`${input.text ?? ''}\n${input.block}`, { first: 0, name: (n) => `Line ${n} of the block` });
        } else {
          calls = cdpCallsTyped(input.text ?? '');
        }
        if (typeof calls === 'string') {
          say(`ERROR: ${calls}`);
          return;
        }
        // A session of its own, detached at the end, so what a call
        // sets for its session (Emulation.* overrides, enabled domains)
        // ends with the command, as it does for any CDP client.
        const session = await page.context().newCDPSession(page);
        // A call that navigates the page is cut off, or never answers,
        // which is no failure when navigating was its point.
        // - Cut off: its error says so.
        // - No answer: a new document loaded during the call (with a
        //   navigation request), not a hash or pushState change.
        // An error of another kind is the call's own, whatever the page
        // did meanwhile (a Page.reload before it lands during the next).
        let navigated = false;
        const onRequest = (request: Request): void => {
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigated = true;
        };
        page.on('request', onRequest);
        try {
          for (const { method, params } of calls) {
            navigated = false;
            let result: unknown;
            const sent = session.send(method as never, params as never).then((r) => { result = r; });
            // A reply may never come: a Runtime.evaluate that navigates
            // the page, a page paused in the debugger.
            const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), CDP_TIMEOUT_MS).unref());
            let outcome: boolean | 'timeout';
            try {
              outcome = await Promise.race([done(sent), timeout]);
            } catch (err) {
              // Playwright's wrapping, `Protocol error (Page.nope): `, repeats the method.
              const message = plain(err as Error).replace(/^Protocol error \([^)]*\): /, '');
              if (page.isClosed() || CUT_OFF_BY_NAVIGATION.test(message)) {
                say(page.isClosed() ? `The tab closed before ${method} finished` : `${method} got no answer, since the page navigated`);
                return;
              }
              say(`${method} failed: ${message.charAt(0).toUpperCase()}${message.slice(1)}`);
              return false;
            }
            if (outcome === 'timeout') {
              if (navigated) {
                say(`${method} got no answer, since the page navigated`);
                return;
              }
              say(`${method} got no answer within ${CDP_TIMEOUT_MS / 1000} seconds. A paused page never answers.`);
              return false;
            }
            if (!outcome) {
              say(`${method} opened a dialog, which is waiting for an answer.`);
              return;
            }
            out(JSON.stringify(result, null, 2));
          }
        } finally {
          // Not waited for: with a dialog open, detaching doesn't finish
          // until it's answered, and the command must return so that
          // accept or dismiss can run.
          session.detach().catch(() => undefined);
          page.off('request', onRequest);
        }
        return;
      }
      case 'logs': {
        const lines = logs.get(page) ?? [];
        if (lines.length === 0) say('No console lines or errors yet');
        for (const line of lines) out(line);
        return;
      }
    }
  } catch (err) {
    say(page.isClosed() ? `The tab closed before the ${command} command finished` : `The ${command} command failed: ${plain(err as Error)}`);
    return false;
  }
}

// How CDP and Playwright say a call was cut off by the page leaving.
const CUT_OFF_BY_NAVIGATION = /context was destroyed|Cannot find context|navigated or closed/i;

const CDP_USAGE = 'e.g. cdp Input.dispatchMouseEvent \'{"type": "mouseWheel", "x": 400, "y": 300, "deltaX": 0, "deltaY": 600}\'';
const ONE_CALL = 'A cdp command makes one call. For several in one session, put one per line in a cdp {{ block.';
const notAMethod = (word: string): string => `${word} is not a CDP method. Methods are named Domain.method, as in Page.reload.`;

type CdpCall = { method: string; params: object };

/**
 * `cdp`'s calls (on its line, in a `{{` block, or in a `--file`): one
 * per line, all in one session. Not split into words first, which would
 * take the quotes out of JSON strings. Blank lines and `#` comments are
 * skipped.
 * - `lines`: for a block or file, how to name a line in a message, from
 *   its number. A block's first line is the command's own, line 0.
 */
export function cdpCallsTyped(raw: string, lines?: { first: number; name: (n: number) => string }): CdpCall[] | string {
  const calls: CdpCall[] = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const call = cdpCallLine(text);
    if (typeof call === 'string') return lines ? `${lines.name(lines.first + i)}: ${call}` : call;
    calls.push(call);
  }
  if (calls.length === 0) return `The cdp command needs a method, ${CDP_USAGE}`;
  return calls;
}

/**
 * One call: a `Domain.method`, then its params as a JSON object (`{}`
 * when none), bare or in single quotes. Quotes of either kind may be in
 * the JSON's strings.
 */
function cdpCallLine(text: string): CdpCall | string {
  const [method] = text.split(/\s/, 1);
  if (!CDP_METHOD.test(method)) return notAMethod(method);
  let params = text.slice(method.length).trim();
  if (CDP_METHOD.test(params.split(/\s/, 1)[0])) return ONE_CALL;
  const quoted = params.startsWith('\'{');
  let after = '';
  if (quoted || params.startsWith('{')) {
    const stop = jsonObjectEnd(params, quoted ? 1 : 0);
    if (stop < 0) return `The params for ${method} have no closing }. A call and its params go on one line.`;
    if (quoted && params[stop] !== '\'') return `The params for ${method} open with a ' that doesn't close after them`;
    after = params.slice(quoted ? stop + 1 : stop).trim();
    params = params.slice(quoted ? 1 : 0, stop);
  }
  if (after) return CDP_METHOD.test(after.split(/\s/, 1)[0]) ? ONE_CALL : `The params for ${method} have more after them: ${after}`;
  if (!params) return { method, params: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(params);
  } catch (err) {
    return `The params for ${method} are not valid JSON (${(err as Error).message}): ${params}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return `The params for ${method} must be a JSON object: ${params}`;
  return { method, params: parsed };
}

// Where the JSON object starting at `from` ends: past its closing brace,
// braces in strings not counted. -1 if it never closes.
function jsonObjectEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return -1;
}

// Writes a file, saying which and why when it can't be.
async function write(name: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? /\b(ENOENT|EACCES|EISDIR)\b/.exec((err as Error).message)?.[1];
    if (code === 'ENOENT') throw new Error(`Could not write ${name}: Its folder doesn't exist`);
    if (code === 'EACCES') throw new Error(`Could not write ${name}: Permission was refused`);
    if (code === 'EISDIR') throw new Error(`Could not write ${name}: It's a folder`);
    throw err;
  }
}

// The key names Playwright's `keyboard.press` takes, matched without
// regard to case: its US layout's `code` names (KeyA, Digit1, Home),
// which mostly match the standard `key` names, and the modifiers. It
// mirrors playwright-core's USKeyboardLayout, so a Playwright upgrade
// may add names.
const KEY_NAMES = [
  'Shift', 'Control', 'Alt', 'Meta', 'ControlOrMeta', 'AltGraph',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'CapsLock', 'NumLock', 'ScrollLock', 'PrintScreen', 'Pause', 'ContextMenu',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote',
  'Comma', 'Period', 'Slash',
];

// Other names people reach for, lowercase. None may be a name above
// too (`minus` would shadow the Minus key, which Shift makes `_`).
const KEY_ALIASES: Record<string, string> = {
  ctrl: 'Control', ctl: 'Control', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', windows: 'Meta',
  opt: 'Alt', option: 'Alt', mod: 'ControlOrMeta', cmdorctrl: 'ControlOrMeta', ctrlorcmd: 'ControlOrMeta',
  esc: 'Escape', return: 'Enter', del: 'Delete', ins: 'Insert', bksp: 'Backspace', bs: 'Backspace',
  spacebar: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  pgup: 'PageUp', pgdn: 'PageDown', pgdown: 'PageDown', menu: 'ContextMenu', apps: 'ContextMenu',
  prtsc: 'PrintScreen', prtscn: 'PrintScreen', break: 'Pause', caps: 'CapsLock', plus: '+',
};

const KEYS_BY_LOWER = new Map([
  ...KEY_NAMES.map((name) => [name.toLowerCase(), name] as const),
  ...Object.entries(KEY_ALIASES),
]);

/**
 * A typed key, or combination (`ctrl+home`), as Playwright names it.
 * A single character stays as typed, since its case is the key (`A` is
 * Shift+a). A name it doesn't know is passed on, for Playwright's error.
 */
export function keyName(typed: string): string {
  return keyParts(typed).map((part) => (part.length <= 1 ? part : KEYS_BY_LOWER.get(part.toLowerCase()) ?? part)).join('+');
}

// `+` joins the parts, and is a key itself last (`Control++`). An
// empty part is a `+` with no key on one side (`Shift+`).
function keyParts(typed: string): string[] {
  return typed === '+' ? ['+'] : typed.endsWith('++') ? [...typed.slice(0, -2).split('+'), '+'] : typed.split('+');
}

// Playwright's click (and hover) options that `click`'s flags set.
interface ClickFlags {
  button?: 'left' | 'right' | 'middle';
  modifiers?: (typeof MODIFIERS)[number][];
  clickCount?: number;
  position?: { x: number; y: number };
}

/**
 * `click`'s or `hover`'s flags as Playwright's options for them, with
 * its selector, and how the action differs from a plain one, as said
 * after it (`the right button`). Or what's wrong with them. Which flags
 * each takes is its syntax's (command-list.ts).
 */
export function clickOptions(given: Record<string, string | true>, selector: string): {
  selector: string;
  click: ClickFlags;
  how: string[];
} | string {
  const flags = Object.fromEntries(Object.entries(given).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const click: ClickFlags = {};
  const how: string[] = [];
  const button = flags['--button']?.toLowerCase();
  if (button !== undefined) {
    if (button !== 'left' && button !== 'right' && button !== 'middle') return `${flags['--button']} is not a mouse button. Use left, right or middle.`;
    click.button = button;
    if (button !== 'left') how.push(`the ${button} button`);
  }
  if (flags['--modifiers'] !== undefined) {
    const keys = flags['--modifiers'].split(/[+,]/).filter(Boolean).map(keyName);
    const bad = keys.find((key) => !(MODIFIERS as readonly string[]).includes(key));
    if (bad !== undefined || keys.length === 0) return `${bad ?? flags['--modifiers']} is not a modifier key. Use ${MODIFIERS.join(', ')}, joined by +.`;
    click.modifiers = keys as (typeof MODIFIERS)[number][];
    how.push(`${keys.join('+')} held`);
  }
  if (flags['--count'] !== undefined) {
    const count = Number(flags['--count']);
    if (!Number.isInteger(count) || count < 1 || count > 10) return `The --count flag takes a number of clicks from 1 to 10, not ${flags['--count']}`;
    click.clickCount = count;
    if (count > 1) how.push(`${count} clicks`);
  }
  if (flags['--at'] !== undefined) {
    const at = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(flags['--at'].replace(/\s/g, ''));
    if (!at) return `The --at flag takes x,y in pixels from the element's top left corner, e.g. --at 10,5, not ${flags['--at']}`;
    click.position = { x: Number(at[1]), y: Number(at[2]) };
    how.push(`the mouse at ${at[1]},${at[2]} in it`);
  }
  return { selector, click, how };
}

// Playwright's message as a person should see it: its first line,
// without the method it came from (`locator.click: `), capitalized, and
// with plain words for the common cases.
export function plain(err: Error): string {
  const first = err.message.split('\n')[0].replace(/^(\w+(\.\w+)+: )+/, '').replace(/\.$/, '');
  const key = /Unknown key: "(.+)"/.exec(first);
  if (key) return `${key[1]} is not a key name. Keys are named as in Enter, ArrowLeft, Shift+Tab (case-insensitive), or a single character.`;
  const timeout = /Timeout (\d+)ms exceeded/.exec(first);
  if (timeout) return notReady(err.message, Number(timeout[1]) / 1000);
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Longest a covering element's HTML is shown, in characters.
const COVER_HTML_MAX = 150;

/**
 * Why an action timed out waiting on its element, from the last check
 * Playwright's call log says failed (it retries them until the timeout).
 * A log that names none keeps the general wording.
 */
function notReady(message: string, seconds: number): string {
  // The call log's lines are dimmed with terminal color codes.
  const lines = message.replace(/\x1b\[\d+m/g, '').split('\n').map((line) => line.trim().replace(/^- /, ''));
  const within = `for ${seconds} seconds`;
  for (const line of lines.reverse()) {
    const covered = /^(.+) intercepts pointer events$/.exec(line);
    if (covered) {
      const html = covered[1].length > COVER_HTML_MAX ? `${covered[1].slice(0, COVER_HTML_MAX)}…` : covered[1];
      return `${COVERED}${within}, by ${html}`;
    }
    if (line === 'element is not visible') return `The element stayed hidden (or zero-size) ${within}`;
    if (line === 'element is not enabled') return `The element stayed disabled ${within}`;
    if (line === 'element is not stable') return `The element kept moving ${within}`;
    if (line === 'element is outside of the viewport') return `The element stayed outside the viewport ${within}, where it can't be scrolled to`;
  }
  return notReadyGeneral(seconds);
}

// How `notReady` starts when the element was covered.
const COVERED = 'The element stayed covered ';

// `notReady` when the call log names no reason.
function notReadyGeneral(seconds: number): string {
  return `The element wasn't ready (visible, stable, and not covered) within ${seconds} seconds`;
}

/**
 * Why the mouse can't reach the element, for a timeout Playwright gave
 * no specific reason for, or called covered: the `--at` point is
 * outside the element, or outside the window (where Playwright reports
 * whatever is under the point as covering it), or with no `--at`, the
 * whole element is off the window. (Playwright aims at the middle of
 * the element's visible part itself.) Null when none of those, or the
 * element can't be measured.
 */
async function placeProblem(page: Page, target: Locator, position: { x: number; y: number } | undefined): Promise<string | null> {
  const box = await target.boundingBox({ timeout: 1000 }).catch(() => null);
  if (!box) return null;
  const view = page.viewportSize() ?? await withTimeout(page.evaluate(() => ({ width: innerWidth, height: innerHeight })), 1000).catch(() => null);
  if (!view) return null;
  const r = Math.round;
  const size = `${r(box.width)}x${r(box.height)} pixels`;
  if (position && (position.x > box.width || position.y > box.height)) {
    return `The point ${position.x},${position.y} is outside the element, which is ${size} (--at counts from its top left corner)`;
  }
  // One sentence each: plain() drops a final period.
  const win = `the ${view.width}x${view.height} window`;
  if (position) {
    const x = box.x + position.x;
    const y = box.y + position.y;
    if (x >= 0 && y >= 0 && x < view.width && y < view.height) return null;
    return `The point ${position.x},${position.y} in the element is outside ${win}, at ${r(x)},${r(y)}, so pick a point in the element's visible part`;
  }
  const shows = box.x + box.width > 0 && box.y + box.height > 0 && box.x < view.width && box.y < view.height;
  return shows ? null : `The element (${size} at ${r(box.x)},${r(box.y)}) is entirely outside ${win}, where it can't be scrolled to`;
}

// `promise`, or a rejection after `ms`: a page held by a dialog never answers.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// How many elements a selector matches, or why it can't be counted.
export async function countOf(page: Page, selector: string): Promise<number | string> {
  try {
    return await locate(page, selector).count();
  } catch (err) {
    if (page.isClosed()) return 'The tab closed';
    const message = (err as Error).message;
    if (/SyntaxError|not a valid selector|Unexpected token|Unknown engine|Unexpected end/i.test(message)) return 'It isn\'t a valid selector';
    return plain(err as Error);
  }
}

// How many elements a selector matches, or null (said why) when none
// does or it can't be counted.
async function matches(page: Page, selector: string, say: (line: string) => void): Promise<number | null> {
  const problem = await refProblem(page, selector);
  if (problem) {
    say(problem);
    return null;
  }
  const count = await countOf(page, selector);
  if (typeof count === 'string') say(`The selector ${selector} can't be used: ${count}`);
  else if (count === 0) say(refOf(selector) ? `No element has the ref ${refOf(selector)}. Take a new snapshot for the page's refs.` : `No element matches ${selector}`);
  return typeof count === 'number' && count > 0 ? count : null;
}

