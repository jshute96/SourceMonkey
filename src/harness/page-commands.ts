// The typed commands that act on a tab's page directly: drive it (click,
// hover, type, key, eval) and look at it (snapshot, screenshot,
// savehtml, probe, logs). console-commands.ts picks the tab and hands
// the rest of the line here.
//
// Built on the run's own Playwright connection to its tabs: real input
// events (scrolled into view, the page sees them as a person's), key
// names as Playwright spells them (`Shift+ArrowRight`), and the
// accessibility tree as text. Actions wait for the page to settle (wait.ts)
// before returning, so the next command sees what the last one did.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { PROBE_MAX } from './command-list.js';
import type { ControlledTab } from './console-commands.js';
import { ScriptThrew } from './inject.js';
import { notSettledMessage, SETTLE_TIMEOUT_MS, settleTab } from './wait.js';
import { savePageHtml } from './save-html.js';
import { shownPath } from './prepare.js';
import { documentOf, framesAround, locate, named, noteRefs, onScreen, probeMatches, refOf, refProblem, tidy } from './snapshot.js';

export const PAGE_COMMANDS = new Set(['click', 'hover', 'type', 'key', 'eval', 'snapshot', 'screenshot', 'savehtml', 'probe', 'logs']);

// How long an action waits for its element. Settling after it has its
// own limit (wait.ts).
const ACTION_TIMEOUT_MS = 5000;
// How long a whole-page screenshot waits for the browser to capture it.
const SCREENSHOT_TIMEOUT_MS = 5000;
// How long a quick look into the page waits for an answer.
const CHECK_TIMEOUT_MS = 1000;

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

/** A word of a typed line, and where it starts and ends in the line. */
interface Word {
  text: string;
  start: number;
  end: number;
}

/**
 * Splits a typed line into words as a shell would: 'single' and
 * "double" quotes group words, a backslash in double quotes escapes the
 * next character. So a selector or text with spaces can be one word.
 * Unlike a shell, quotes that open inside a word stay in it (they still
 * keep its spaces together): they are the selector's own, as in
 * `a[href="x.html"]`, which means something else without them.
 */
export function splitWords(line: string): Word[] {
  const words: Word[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const start = i;
    let text = '';
    while (i < line.length && !/\s/.test(line[i])) {
      const c = line[i];
      const keep = i > start;
      if (c === '\'') {
        const close = line.indexOf(c, i + 1);
        const stop = close < 0 ? line.length : close;
        text += keep ? line.slice(i, stop + 1) : line.slice(i + 1, stop);
        i = stop + 1;
      } else if (c === '"') {
        // To the next unescaped quote, a backslash escaping what follows.
        const open = i;
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length) i++;
          text += keep ? '' : line[i];
          i++;
        }
        i++;
        if (keep) text += line.slice(open, Math.min(i, line.length));
      } else {
        text += c;
        i++;
      }
    }
    words.push({ text, start, end: i });
  }
  return words;
}

// A typed selector taken whole: as typed, spaces and all, unless it's
// one quoted span ('#a b' or "#a b"), which is unquoted.
export function wholeSelector(argument: string): string {
  const text = argument.trim();
  const quoted = /^'([^']*)'$/.exec(text) ?? /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  return quoted ? quoted[1].replace(/\\(.)/g, '$1') : text;
}

// The flags a command takes, split from its other words.
function takeFlags(
  command: string, words: string[], known: Record<string, 'bool' | 'value'>,
): { flags: Record<string, string | true>; rest: string[] } | string {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('--')) {
      rest.push(w);
      continue;
    }
    const kind = known[w];
    if (!kind) return `The ${command} command has no ${w} flag`;
    if (kind === 'bool') {
      flags[w] = true;
    } else {
      const value = words[++i];
      if (value === undefined) return `The ${w} flag needs a value`;
      flags[w] = value;
    }
  }
  return { flags, rest };
}

/** Flags that take a value, so the word after one isn't taken for a tab. */
export const VALUE_FLAGS = new Set(['--file', '--out', '--timeout-seconds', '--url']);

/**
 * A page command's arguments, after the tab if one was named: its
 * words, and the rest of the line as typed. Typed, the words come from
 * splitting the line (so quotes group words); sent from another shell,
 * they are the sender's own, and the line is them joined by spaces.
 * `userscripts`: the ones running in the tab's page now, as a saved
 * file's header names them (`userscriptLabel`).
 */
export interface PageInput {
  words: string[];
  raw: string;
  typed: boolean;
  userscripts: string[];
  /** `--nowait`: an action doesn't wait for the page to settle after. */
  noWait?: boolean;
}

/** The commands that act on the page, and so settle after, unless `--nowait`. */
export const ACTIONS = new Set(['click', 'hover', 'type', 'key']);

// Image types `screenshot` can write, by the file's extension.
const IMAGE_FILE = /\.(png|jpe?g)$/i;

/**
 * Runs one of `PAGE_COMMANDS` on `tab`. Reports through `out`, and
 * resolves once the command and what it set off are done, or once a
 * dialog it opened is waiting for an answer: the page stops until then,
 * and `accept` or `dismiss` can't run while this does.
 */
export async function runPageCommand(
  command: string, input: PageInput, tab: ControlledTab, out: (line: string) => void, cwd = process.cwd(),
): Promise<void> {
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
    if (input.noWait) {
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
        // Its flags lead (`--script`, `--file <path>`, either order),
        // on the command's own line: an eval block's code is not looked
        // through for them. Then JavaScript: typed, the rest of the line
        // as it is, its quotes its own.
        const words = input.typed ? splitWords(input.raw) : input.words.map((text) => ({ text, start: -1, end: -1 }));
        const headEnd = input.typed ? input.raw.indexOf('\n') : -1;
        const flagAt = (i: number): string | undefined => (headEnd < 0 || (words[i]?.start ?? headEnd) < headEnd ? words[i]?.text : undefined);
        let world: 'page' | 'scripts' = 'page';
        let from: string | undefined;
        let at = 0;
        for (; flagAt(at) === '--script' || flagAt(at) === '--file'; at++) {
          if (flagAt(at) === '--script') {
            world = 'scripts';
            continue;
          }
          if (from !== undefined) {
            say('ERROR: The eval command takes one --file');
            return;
          }
          from = flagAt(++at);
          if (from === undefined || from.startsWith('--')) {
            say('ERROR: The --file flag needs a JavaScript file, e.g. eval --file probe.js');
            return;
          }
        }
        let expression = input.typed ? input.raw.slice(at ? words[at - 1].end : 0).trim() : input.words.slice(at).join(' ');
        if (from !== undefined) {
          if (expression) {
            say('ERROR: The eval command takes JavaScript or --file, not both');
            return;
          }
          try {
            expression = await readFile(file(from), 'utf8');
          } catch (err) {
            say(`ERROR: Couldn't read ${shown(from)}: ${readProblem(err as NodeJS.ErrnoException)}`);
            return;
          }
          if (!expression.trim()) {
            say(`ERROR: The file ${shown(from)} is empty`);
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
          if (err instanceof ScriptThrew) say(`The expression threw: ${err.message}`);
          else if (page.isClosed()) say('The tab closed before the expression finished');
          else if (/context was destroyed|Cannot find context|navigated or closed/i.test((err as Error).message)) say('The page navigated away before the expression finished');
          else say(`Internal error: ${(err as Error).message}`);
          return;
        }
        // Its console lines come through another session than its result.
        await done(tab.link.drain());
        out(result);
        return;
      }
      case 'click':
      case 'hover': {
        const selector = input.typed ? wholeSelector(input.raw) : input.words.join(' ');
        if (!selector) {
          say(`ERROR: The ${command} command needs a selector, e.g. ${command} '#submit'`);
          return;
        }
        const count = await matches(page, selector, say);
        if (count === null) return;
        const target = locate(page, selector).first();
        const action = command === 'click' ? target.click({ timeout: ACTION_TIMEOUT_MS }) : target.hover({ timeout: ACTION_TIMEOUT_MS });
        await act(action, `${command === 'click' ? 'Clicked' : 'Hovered over'} ${named(page, selector)}${count > 1 ? ` (the first of ${count} matches)` : ''}`);
        return;
      }
      case 'type': {
        const words = input.words;
        if (words.length < 2) {
          say('ERROR: The type command needs a selector and the text, e.g. type \'input[name=q]\' \'hello world\'');
          return;
        }
        const [selector, ...text] = words;
        const count = await matches(page, selector, say);
        if (count === null) return;
        const typing = locate(page, selector).first().pressSequentially(text.join(' '), { timeout: ACTION_TIMEOUT_MS });
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
          say(`${unjoined} has a + with no key on one side. Join keys with +, as in Shift+Tab.`);
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
        const parsed = takeFlags(command, input.words, { '--out': 'value', '--visible': 'bool' });
        if (typeof parsed === 'string') {
          say(`ERROR: ${parsed}`);
          return;
        }
        if (parsed.rest.length > 1) {
          say('ERROR: The snapshot command takes one selector; quote one with spaces');
          return;
        }
        const selector = parsed.rest[0] ?? 'body';
        if (await matches(page, selector, say) === null) return;
        const visible = parsed.flags['--visible'] === true;
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
          // snapshots. Failing, it costs only those refs.
          if (selector !== 'body') {
            const whole = await page.locator('body').ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS }).catch(() => null);
            if (whole !== null) noteRefs(page, whole, doc);
          }
          tree = tidy(tree);
        })();
        if (!await done(taking)) {
          say('The page opened a dialog during the snapshot, which is waiting for an answer.');
          return;
        }
        const outFile = parsed.flags['--out'];
        if (typeof outFile === 'string') {
          await write(outFile, () => writeFile(file(outFile), tree + '\n'));
          say(`Wrote ${shown(outFile)} (${tree.split('\n').length} lines) from ${page.url()}`);
          return;
        }
        for (const line of tree.split('\n')) out(line);
        return;
      }
      case 'screenshot': {
        const parsed = takeFlags(command, input.words, { '--full': 'bool' });
        if (typeof parsed === 'string') {
          say(`ERROR: ${parsed}`);
          return;
        }
        const image = parsed.rest.pop();
        if (!image || parsed.rest.length > 1) {
          say('ERROR: The screenshot command needs a file, and takes one selector before it, e.g. screenshot \'#comments\' c.png');
          return;
        }
        if (!IMAGE_FILE.test(image)) {
          say(`The screenshot command writes a .png or .jpg file, and ${image} is neither. Name the file last.`);
          return;
        }
        const selector = parsed.rest[0];
        if (selector) {
          if (parsed.flags['--full']) {
            say('The --full flag is for the whole page, not an element');
            return;
          }
          if (await matches(page, selector, say) === null) return;
          await write(image, () => locate(page, selector).first().screenshot({ path: file(image), timeout: ACTION_TIMEOUT_MS }));
        } else {
          try {
            await write(image, () => page.screenshot({ path: file(image), fullPage: parsed.flags['--full'] === true, timeout: SCREENSHOT_TIMEOUT_MS }));
          } catch (err) {
            if ((err as Error).name !== 'TimeoutError' || page.isClosed()) throw err;
            say(`Screenshot failed: Browser did not capture the page within ${SCREENSHOT_TIMEOUT_MS / 1000} seconds`);
            return;
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
        const parsed = takeFlags(command, input.words, { '--html': 'bool', '--css': 'bool' });
        if (typeof parsed === 'string') {
          say(`ERROR: ${parsed}`);
          return;
        }
        if (parsed.rest.length === 0) {
          say('ERROR: The probe command needs a selector or more, e.g. probe \'.titleline\' \'#hnmain\'');
          return;
        }
        const css = parsed.flags['--css'] === true;
        const html = parsed.flags['--html'] === true;
        for (const selector of parsed.rest) {
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
      case 'logs': {
        if (input.words.length > 0) {
          say('The logs command takes nothing besides a tab');
          return;
        }
        const lines = logs.get(page) ?? [];
        if (lines.length === 0) say('No console lines or errors yet');
        for (const line of lines) out(line);
        return;
      }
    }
  } catch (err) {
    say(page.isClosed() ? `The tab closed before the ${command} command finished` : `The ${command} command failed: ${plain(err as Error)}`);
  }
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

// Playwright's message as a person should see it: its first line,
// without the method it came from (`locator.click: `), capitalized, and
// with plain words for the common cases.
// Why a file couldn't be read, in plain words.
function readProblem(err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') return 'The file does not exist';
  if (err.code === 'EISDIR') return 'It\'s a folder';
  if (err.code === 'EACCES') return 'Permission was refused';
  return plain(err);
}

function plain(err: Error): string {
  const first = err.message.split('\n')[0].replace(/^(\w+(\.\w+)+: )+/, '').replace(/\.$/, '');
  const key = /Unknown key: "(.+)"/.exec(first);
  if (key) return `${key[1]} is not a key name. Keys are named as in Enter, ArrowLeft, Shift+Tab (case-insensitive), or a single character.`;
  const timeout = /Timeout (\d+)ms exceeded/.exec(first);
  if (timeout) return `The element wasn't ready (visible, stable, and not covered) within ${Number(timeout[1]) / 1000} seconds`;
  return first.charAt(0).toUpperCase() + first.slice(1);
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

