// The typed commands that act on a tab's page directly: drive it
// (click, hover, type, key, eval), look at it (snapshot, screenshot,
// savehtml, probe), and send it raw CDP calls (cdp). console-commands.ts
// picks the tab and hands the rest of the line here.
//
// Built on the run's own Playwright connection to its tabs: real input
// events (scrolled into view, the page sees them as a person's), key
// names as Playwright spells them (`Shift+ArrowRight`), and the
// accessibility tree as text. Actions wait for the page to settle (wait.ts)
// before returning, so the next command sees what the last one did.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CDPSession, Frame, Locator, Page, Request } from '@playwright/test';

import type { ParsedArgs } from './command-args.js';
import { PART_LIMIT, PROBE_MAX } from './command-list.js';
import type { ControlledTab } from './console-commands.js';
import { NoDocument, NoEvalHook, ScriptThrew, type ScriptScope } from './page-watch.js';
import { jsonResult, type ProbeData } from './json-output.js';
import { readInputFile, writeProblem } from './input-file.js';
import { notSettledMessage, seconds, SETTLE_TIMEOUT_MS, settleTab, timeoutFlagMs } from './wait.js';
import { savePageHtml } from './save-html.js';
import { shownPath } from './prepare.js';
import { findFrame, frameNodes, parseFrameRef, type FrameIds } from './frames.js';
import { asError, cmd, code, ERROR_PREFIX, escapeMarkup, heading, id as idRole, MARKUP, message, name as nameRole, quoted, ui, url } from './output-style.js';
import { documentOf, locate, named, noteRefs, onScreen, probeMatches, refOf, refProblem, refsOf, tidy, treeParts, withoutDocument } from './snapshot.js';

export const PAGE_COMMANDS = new Set(['click', 'hover', 'type', 'key', 'eval', 'snapshot', 'screenshot', 'savehtml', 'probe', 'cdp']);

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
  /** Where `eval` runs, resolved from its flags (see `EvalIn`). */
  evalIn?: EvalIn;
  /** Print the result as JSON (`--json`), for the commands with a JSON form. */
  json?: boolean;
}

/**
 * Where `eval` runs: a script's own scope, with its name for messages,
 * whether it was named (`--script=<script>`) or is the selected one, and
 * the world it runs in instead when the selected one has no scope here;
 * or a world: the page's (`--page`, or no run script selected), or the
 * scripts' shared one (`--script` with none selected).
 */
export type EvalIn = { scope: ScriptScope | null; name: string; named: boolean; fallback: EvalWorld; manager?: string } | EvalWorld;
type EvalWorld = 'page' | 'scripts';

const WORLD_NAMES: Record<EvalWorld, string> = { page: 'the page', scripts: 'the isolated scripts\' shared world' };

// Image types `screenshot` can write, by the file's extension.
const IMAGE_FILE = /\.(png|jpe?g)$/i;

// Longer eval results are cut, so one huge value (a `data:` URL, a
// page's HTML) doesn't flood the output. `--out` writes it all.
const EVAL_SHOWN_CHARS = 10_000;

function shortEvalResult(text: string): string {
  if (text.length <= EVAL_SHOWN_CHARS) return text;
  // Not ending on the first half of a surrogate pair, so an emoji isn't
  // cut in half. Sliced, not split into code points, since the text can
  // be megabytes.
  const end = /[\uD800-\uDBFF]/.test(text[EVAL_SHOWN_CHARS - 1]) ? EVAL_SHOWN_CHARS - 1 : EVAL_SHOWN_CHARS;
  return ui`${text.slice(0, end)}... (${text.length} chars; ${cmd('eval --out FILE')} writes it all)`;
}

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
  // A mistake in the command: `[sm-dev] ERROR: ...`, which ends it with exit code 2.
  const sayMistake = (text: string): void => say(`${ERROR_PREFIX}${text}`);
  const { page } = tab;
  // `--timeout-seconds`: each wait the command does, in place of that
  // wait's default.
  const given = timeoutFlagMs(input.flags, out);
  if (given === null) return false;
  const within = (defaultMs: number): number => given ?? defaultMs;
  // `--frame F2`: the iframe the selector or expression is for.
  const frame = await pickFrame(input.flags['--frame'], tab, say);
  if (frame === null) return false;
  // After a selector in what a command says it did, marked up.
  const frameShown = frame ? idRole(`F${tab.link.host.frameIds.number(frame)}`) : '';
  const inFrame = frame ? ui` in ${frameShown}` : '';
  const actionMs = within(ACTION_TIMEOUT_MS);
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
  // a dialog. `what` is markup. A page that doesn't settle in time says why, and the
  // action still counts as done.
  const act = async (work: Promise<unknown>, what: string): Promise<void> => {
    if (!await done(work)) {
      say(ui`${what}. It opened a dialog, which is waiting for an answer.`);
      return;
    }
    if (input.flags['--nowait']) {
      say(what);
      return;
    }
    const settled = await settleTab(tab, tab.link.host, within(SETTLE_TIMEOUT_MS));
    if (!settled.settled && 'dialog' in settled) {
      say(ui`${what}. The page opened a dialog, which is waiting for an answer.`);
      return;
    }
    say(what);
    if (!settled.settled && 'busy' in settled) say(notSettledMessage(tab, within(SETTLE_TIMEOUT_MS), settled.busy));
  };
  try {
    switch (command) {
      case 'eval': {
        // Its JavaScript: the rest of the line as typed, its quotes its
        // own, or a block's lines, or a file's.
        const evalIn = input.evalIn ?? 'page';
        const from = input.flags['--file'];
        let expression = [input.text, input.block].filter((part) => part).join('\n');
        if (typeof from === 'string') {
          if (expression) {
            sayMistake('The `eval` command takes JavaScript or `--file`, not both');
            return;
          }
          try {
            expression = readInputFile(file(from), shown(from));
          } catch (err) {
            sayMistake(`${(err as Error).message}`);
            return;
          }
        }
        if (!expression) {
          sayMistake('The `eval` command needs an expression, e.g. `eval document.title`');
          return;
        }
        let result = '';
        // Why a script has no scope to reach here: not in the extension
        // at all (it failed to install), or not run in this document.
        // Under another manager (`manager`, its label), which reports
        // nothing, sm-dev can't tell which.
        // Marked up.
        const noScope = typeof evalIn !== 'object' ? ''
          : evalIn.manager && evalIn.scope ? ui`sm-dev couldn't reach the scope of ${nameRole(evalIn.name)} under ${evalIn.manager}`
          : ui`${nameRole(evalIn.name)} ${evalIn.scope ? ui`hasn't run ${frame ? ui`in ${frameShown}` : 'on this page'}` : 'isn\'t installed in the extension'}`;
        // A selected script with no scope runs its code in its fallback
        // world, as said. A named one was asked for, so that's a
        // failure.
        const evaluate = (): Promise<string> => {
          // --timeout-seconds (`given`): how long to wait for a document,
          // on a page between them.
          if (typeof evalIn === 'string') return tab.link.evaluate(expression, evalIn, given, frame);
          const inScript = evalIn.scope ? tab.link.evaluate(expression, evalIn.scope, given, frame) : Promise.reject(new NoEvalHook());
          return inScript.catch((err: unknown) => {
            if (!(err instanceof NoEvalHook)) throw err;
            if (evalIn.named) throw err;
            say(ui`${noScope}, so this ran in ${WORLD_NAMES[evalIn.fallback]}`);
            return tab.link.evaluate(expression, evalIn.fallback, given, frame);
          });
        };
        const evaluated = evaluate().then((r) => { result = r; });
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
            if (err instanceof NoEvalHook && typeof evalIn === 'object') {
              // Under another manager, the cause isn't known, so no fix is offered.
              say(evalIn.manager && evalIn.scope ? noScope
                : evalIn.scope ? ui`${noScope}, so its scope can't be reached. Load a page it matches, or reload this one.`
                : ui`${noScope}, so its scope can't be reached`);
            } else if (err instanceof ScriptThrew) say(asError(`The expression threw: ${err.message}`));
            else if (err instanceof NoDocument) say(err.message);
            else say(`Internal error: ${(err as Error).message}`);
            return false;
          }
          return;
        }
        // Its console lines come through another session than its result.
        await done(tab.link.drain());
        const outFile = input.flags['--out'];
        if (typeof outFile === 'string') {
          await write(outFile, () => writeFile(file(outFile), result + '\n'));
          say(ui`Wrote ${url(shown(outFile))} (${result.length} chars)`);
          return;
        }
        out(shortEvalResult(result));
        return;
      }
      case 'click':
      case 'hover': {
        const options = clickOptions(input.flags, input.text ?? '');
        if (typeof options === 'string') {
          sayMistake(`${options}`);
          return;
        }
        const { selector } = options;
        if (!selector) {
          sayMistake(`The ${quoted(command)} command needs a selector, e.g. ${quoted(`${command} '#submit'`)}`);
          return;
        }
        const count = await matches(page, selector, say, frame, tab.link.host.frameIds);
        if (count === null) return false;
        const target = locate(page, selector, frame).first();
        const action = (command === 'click'
          ? target.click({ ...options.click, timeout: actionMs })
          : target.hover({ modifiers: options.click.modifiers, position: options.click.position, timeout: actionMs }))
          // A point it can't reach says so, rather than that the element
          // was covered (by whatever is at that point) or not ready.
          .catch(async (err: Error) => {
            if (!/Timeout \d+ms exceeded/.test(err.message)) throw err;
            const why = plain(err);
            // The call log's own reasons (hidden, disabled, moving) stand.
            if (why !== notReadyGeneral(actionMs / 1000) && !why.startsWith(COVERED)) throw err;
            throw new Error(await placeProblem(page, target, options.click.position) ?? err.message);
          });
        const how = options.how.length > 0 ? ` with ${options.how.join(', ')}` : '';
        await act(action, ui`${command === 'click' ? 'Clicked' : 'Hovered over'} ${namedMarked(page, selector)}${inFrame}${count > 1 ? ` (the first of ${count} matches)` : ''}${how}`);
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
            sayMistake('The `type` command takes text or `--file`, not both');
            return;
          }
          if (!selector) {
            sayMistake('The `type` command takes a selector and one file, e.g. `type \'#notes\' --file notes.txt`');
            return;
          }
          try {
            // The file's text as it is, a last line break included.
            // Windows line breaks as one Enter each, not two.
            text = readInputFile(file(from), shown(from), { blankOk: true }).replace(/\r\n?/g, '\n');
          } catch (err) {
            sayMistake(`${(err as Error).message}`);
            return;
          }
        } else if (input.block !== undefined) {
          if (input.text || !selector) {
            sayMistake('The `type` command takes one selector before `{{`. Quote a selector that has spaces.');
            return;
          }
          text = input.block;
        } else {
          text = input.text ?? '';
        }
        // `--clear`: emptied first, so the text is optional.
        const clear = input.flags['--clear'] === true;
        if (!selector || (!text && !clear)) {
          sayMistake('The `type` command needs a selector and the text (or `--clear`), e.g. `type \'input[name=q]\' \'hello world\'`');
          return;
        }
        const count = await matches(page, selector, say, frame, tab.link.host.frameIds);
        if (count === null) return false;
        const element = locate(page, selector, frame).first();
        const typing = (async () => {
          if (clear) await element.clear({ timeout: actionMs });
          if (text) await element.pressSequentially(text, { timeout: actionMs });
        })();
        const done = !text ? 'Cleared' : clear ? 'Cleared and typed into' : 'Typed into';
        await act(typing, ui`${done} ${namedMarked(page, selector)}${inFrame}${count > 1 ? ` (the first of ${count} matches)` : ''}`);
        return;
      }
      case 'key': {
        const keys = input.words;
        if (keys.length === 0) {
          sayMistake('The `key` command needs a key, e.g. `key j` or `key Shift+ArrowRight`');
          return;
        }
        const unjoined = keys.find((k) => keyParts(k).includes(''));
        if (unjoined) {
          sayMistake(`${quoted(unjoined)} has a ${quoted('+')} with no key on one side. Join keys with ${quoted('+')}, as in ${quoted('Shift+Tab')}.`);
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
        await act(pressing, ui`Pressed ${named.map((k) => code(k)).join(', ')}`);
        if (wasFullscreen && !tab.dialogs?.current && await pageSays(page, isFullscreen)) {
          say('The page is still fullscreen. Escape sent by sm-dev goes to the page rather than to Chrome. To exit, use `eval document.exitFullscreen()`.');
        }
        return;
      }
      case 'snapshot': {
        const selector = input.text;
        const visible = input.flags['--visible'] === true;
        const parts = partOptions(input.flags, !!selector);
        if (typeof parts === 'string') {
          sayMistake(`${parts}`);
          return;
        }
        const count = selector ? await matches(page, selector, say, frame, tab.link.host.frameIds) : 0;
        if (count === null) return false;
        let tree = '';
        const taking = (async () => {
          const doc = await documentOf(page);
          // The whole page is `:root`, not `body`: scripts often add their
          // panels to <html>, after <body>.
          const whole = (frame ?? page).locator(':root');
          tree = await whole.ariaSnapshot({ mode: 'ai', boxes: visible, timeout: actionMs });
          noteRefs(page, tree, doc, frame);
          if (visible) {
            // A frame's boxes are from its own corner, so by its window.
            const [width, height] = await (frame ?? page).evaluate(() => [window.innerWidth, window.innerHeight]);
            tree = onScreen(tree, width, height);
          }
          if (!parts) {
            tree = tidy(withoutDocument(tree));
            return;
          }
          // Each match is found in the whole tree by its refs (an element
          // keeps its ref across snapshots). Only enough for the limit:
          // each costs a snapshot of the match.
          const found = selector ? locate(page, selector, frame) : null;
          const tops: string[][] = [];
          let rest: { total?: number; unsearched?: number } = {};
          for (let i = 0; found && i < count; i++) {
            tops.push(await refsOf(found.nth(i), actionMs));
            if (parts.limit > 0 && i + 1 < count && treeParts(tree, { ...parts, matches: tops }).length >= parts.limit) {
              // The selector's count is the total, but --find's hits in
              // the matches not looked at are unknown.
              rest = parts.text === undefined ? { total: count } : { unsearched: count - i - 1 };
              break;
            }
          }
          // Refs resolve against the latest snapshot only, so the whole
          // is taken again, after the matches'. Failing, it costs only the
          // refs outside the last match.
          if (found) await whole.ariaSnapshot({ mode: 'ai', timeout: actionMs }).catch(() => null);
          // A part can be the whole, however named (`:root`, `html`).
          const shown = treeParts(tree, { ...parts, matches: found ? tops : undefined }).map((part) => tidy(withoutDocument(part)));
          tree = shown.length === 0 ? '' : partsText(shown, parts.limit, rest);
        })();
        if (!await done(taking)) {
          say('The page opened a dialog during the snapshot, which is waiting for an answer.');
          return;
        }
        if (parts && tree === '') {
          // Not the selector itself, which can be long.
          const where = selector ? ' in the selector\'s matches' : '';
          if (parts.text !== undefined) say(`No element${where} contains "${parts.text}"${visible ? ' on screen' : ''}`);
          else say(`No selector match is ${visible ? 'on screen' : 'in the accessibility tree, which leaves out hidden elements'}`);
          return;
        }
        const outFile = input.flags['--out'];
        if (typeof outFile === 'string') {
          await write(outFile, () => writeFile(file(outFile), tree + '\n'));
          say(ui`Wrote ${url(shown(outFile))} (${tree.split('\n').length} lines) from ${url(page.url())}`);
          return;
        }
        for (const line of tree.split('\n')) out(snapshotLine(line));
        return;
      }
      case 'screenshot': {
        const rest = [...input.words];
        const image = rest.pop();
        if (!image) {
          sayMistake('The `screenshot` command needs a file, and takes one selector before it, e.g. `screenshot \'#comments\' c.png`');
          return;
        }
        if (!IMAGE_FILE.test(image)) {
          sayMistake(`The ${quoted('screenshot')} command writes a .png or .jpg file, and ${quoted(image)} is neither. Name the file last.`);
          return;
        }
        const selector = rest[0];
        if (selector) {
          if (input.flags['--full']) {
            sayMistake('The `--full` flag is for the whole page, not an element');
            return;
          }
          if (await matches(page, selector, say, frame, tab.link.host.frameIds) === null) return false;
          await write(image, () => locate(page, selector, frame).first().screenshot({ path: file(image), timeout: actionMs }));
        } else if (frame) {
          // The frame as it shows on the page: its <iframe> element.
          if (input.flags['--full']) {
            sayMistake('The `--full` flag is for the whole page, not a frame');
            return;
          }
          await write(image, async () => (await frame.frameElement()).screenshot({ path: file(image), timeout: actionMs }));
        } else {
          try {
            await write(image, () => page.screenshot({ path: file(image), fullPage: input.flags['--full'] === true, timeout: within(SCREENSHOT_TIMEOUT_MS) }));
          } catch (err) {
            if ((err as Error).name !== 'TimeoutError' || page.isClosed()) throw err;
            say(`Screenshot failed: Browser did not capture the page within ${seconds(within(SCREENSHOT_TIMEOUT_MS))}`);
            return false;
          }
        }
        say(ui`Wrote ${url(shown(image))}${selector ? ui` (${namedMarked(page, selector)}${inFrame})` : frame ? ui` (in ${frameShown})` : ''} from ${url(page.url())}`);
        return;
      }
      case 'savehtml': {
        const words = input.words;
        if (words.length !== 1) {
          sayMistake('The `savehtml` command needs a file, e.g. `savehtml page.html`');
          return;
        }
        let html = '';
        await write(words[0], async () => { html = await savePageHtml(page, file(words[0]), input.userscripts); });
        say(ui`Wrote ${url(shown(words[0]))} (${html.length} chars) from ${url(page.url())}`);
        if (input.userscripts.length > 0) say('It has the scripts\' changes in it, and its header lists them. For a copy without them, save it from a tab without scripts (`newtab --noscript`).');
        return;
      }
      case 'probe': {
        if (input.words.length === 0) {
          sayMistake('The `probe` command needs a selector or more, e.g. `probe \'.titleline\' \'#hnmain\'`');
          return;
        }
        const css = input.flags['--css'] === true;
        const html = input.flags['--html'] === true;
        if (input.json) {
          const selectors: ProbeData['selectors'] = [];
          for (const selector of input.words) {
            const entry: ProbeData['selectors'][number] = { selector };
            const probing = (async () => {
              const count = await refProblem(page, selector) ?? await refFrameProblem(page, selector, frame, tab.link.host.frameIds) ?? await countOf(page, selector, frame);
              if (typeof count === 'string') {
                entry.error = count;
                return;
              }
              entry.count = count;
              if (count === 0 || (!css && !html)) return;
              const found = await probeMatches(page, selector, PROBE_MAX, actionMs, frame).catch((err: Error) => plain(err));
              if (typeof found === 'string') {
                say(`The matches of ${quoted(selector)} could not be read: ${found}`);
                return;
              }
              const inFrame = await matchesFrame(page, selector, found.framed, frame);
              if (inFrame) entry.frame = `F${tab.link.host.frameIds.number(inFrame)}`;
              entry.matches = found.matches.map((match) => ({
                // Not for a frame that can't be named, where it wouldn't work.
                ...(css && inFrame !== null && !match.shadow && match.css ? { css: match.css } : {}),
                ...(html ? { html: match.html } : {}),
              }));
            })();
            if (!await done(probing)) {
              say('The page opened a dialog during the probe, which is waiting for an answer.');
              return false;
            }
            selectors.push(entry);
          }
          out(jsonResult('probe', { tab: `T${tab.n}`, url: page.url(), selectors } satisfies ProbeData));
          return;
        }
        for (const selector of input.words) {
          const lines: string[] = [];
          const probing = (async () => {
            const count = await refProblem(page, selector) ?? await refFrameProblem(page, selector, frame, tab.link.host.frameIds) ?? await countOf(page, selector, frame);
            // Marked up, for output.
            if (typeof count === 'string') lines.push(ui`invalid  ${code(selector)}  (${message(count)})`);
            else if (count === 0) lines.push(ui`missing  ${code(selector)}`);
            else {
              lines.push(ui`found    ${code(selector)}  (${count})`);
              if (!css && !html) return;
              const found = await probeMatches(page, selector, PROBE_MAX, actionMs, frame).catch((err: Error) => plain(err));
              if (typeof found === 'string') {
                lines.push(`    The matches could not be read: ${found}`);
                return;
              }
              // A selector for one in a frame only works within it
              // (`--frame`), so the frame comes first: the selector is
              // free-form, and the end of the line is its own. One in a
              // frame that can't be named gets none.
              const inFrame = await matchesFrame(page, selector, found.framed, frame);
              const where = inFrame ? ui` (in ${idRole(`F${tab.link.host.frameIds.number(inFrame)}`)})` : '';
              for (const match of found.matches) {
                const none = inFrame === null ? 'in a frame' : match.shadow ? 'in a shadow root' : null;
                if (css) lines.push(ui`    selector${where}: ${none ? `(none: ${none})` : match.css != null ? code(match.css) : '(none found)'}`);
                if (html) lines.push(ui`    html${where}: ${code(match.html)}`);
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
            sayMistake('The `cdp` command takes calls or `--file <path>`, not both');
            return;
          }
          try {
            calls = cdpCallsTyped(readInputFile(file(name), shown(name)), { first: 1, name: (n) => `${shown(name)}, line ${n}` });
          } catch (err) {
            sayMistake(`${(err as Error).message}`);
            return;
          }
        } else if (input.block !== undefined) {
          // The command's own line is line 0, the block's first line 1.
          calls = cdpCallsTyped(`${input.text ?? ''}\n${input.block}`, { first: 0, name: (n) => `Line ${n} of the block` });
        } else {
          calls = cdpCallsTyped(input.text ?? '');
        }
        if (typeof calls === 'string') {
          sayMistake(`${calls}`);
          return;
        }
        // A session of its own, detached at the end, so what a call
        // sets for its session (Emulation.* overrides, enabled domains)
        // ends with the command, as it does for any CDP client. With
        // `--frame`, on the target the frame is in: its own, or for one
        // in its parent's process (which Playwright refuses a session
        // for) the nearest ancestor's that has one, the tab's at the top.
        // That target reaches all its frames, so the calls name the
        // frame themselves where they need to; said, with its id.
        let session: CDPSession | undefined;
        for (let at: Frame | null = frame ?? null; at && at !== page.mainFrame() && !session; at = at.parentFrame()) {
          session = await page.context().newCDPSession(at).catch(() => undefined);
          if (session && at !== frame) {
            const frameId = await tab.link.frameCdpId(frame!);
            say(ui`${frameShown} is part of ${idRole(`F${tab.link.host.frameIds.number(at)}`)}'s target, so the calls go there.${frameId ? ui` Name the frame in them by its frameId, ${code(frameId)}.` : ''}`);
          }
        }
        if (!session) {
          session = await page.context().newCDPSession(page);
          if (frame) {
            const frameId = await tab.link.frameCdpId(frame);
            say(ui`${frameShown} is part of ${idRole(`T${tab.n}`)}'s target, so the calls go there.${frameId ? ui` Name the frame in them by its frameId, ${code(frameId)}.` : ''}`);
          }
        }
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
            const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), within(CDP_TIMEOUT_MS)).unref());
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
              say(`${method} got no answer within ${seconds(within(CDP_TIMEOUT_MS))}. A paused page never answers.`);
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
    }
  } catch (err) {
    say(page.isClosed() ? `The tab closed before the ${command} command finished` : `The ${command} command failed: ${plain(err as Error)}`);
    return false;
  }
}

// How CDP and Playwright say a call was cut off by the page leaving.
const CUT_OFF_BY_NAVIGATION = /context was destroyed|Cannot find context|navigated or closed/i;

const CDP_USAGE = 'e.g. `cdp Input.dispatchMouseEvent \'{"type": "mouseWheel", "x": 400, "y": 300, "deltaX": 0, "deltaY": 600}\'`';
const ONE_CALL = 'A `cdp` command makes one call. For several in one session, put one per line in a `cdp {{` block.';
const notAMethod = (word: string): string => `${quoted(word)} is not a CDP method. Methods are named Domain.method, as in ${quoted('Page.reload')}.`;

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
  if (calls.length === 0) return `The ${quoted('cdp')} command needs a method, ${CDP_USAGE}`;
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
  const singleQuoted = params.startsWith('\'{');
  let after = '';
  if (singleQuoted || params.startsWith('{')) {
    const stop = jsonObjectEnd(params, singleQuoted ? 1 : 0);
    if (stop < 0) return `The params for ${quoted(method)} have no closing ${quoted('}')}. A call and its params go on one line.`;
    if (singleQuoted && params[stop] !== '\'') return `The params for ${quoted(method)} open with a ${quoted("'")} that doesn't close after them`;
    after = params.slice(singleQuoted ? stop + 1 : stop).trim();
    params = params.slice(singleQuoted ? 1 : 0, stop);
  }
  if (after) return CDP_METHOD.test(after.split(/\s/, 1)[0]) ? ONE_CALL : `The params for ${quoted(method)} have more after them: ${quoted(after)}`;
  if (!params) return { method, params: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(params);
  } catch (err) {
    return `The params for ${quoted(method)} are not valid JSON (${(err as Error).message}): ${quoted(params)}`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return `The params for ${quoted(method)} must be a JSON object: ${quoted(params)}`;
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
    const problem = writeProblem(err);
    if (problem) throw new Error(`Could not write ${quoted(name)}: ${problem}`);
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
 * Which parts of the page `snapshot` shows, from its flags: the
 * `--find` text, and how much around each match (see `treeParts`).
 * Null for all of it (no selector or --find); what's wrong, if anything
 * is.
 */
export function partOptions(flags: Record<string, string | true>, selector: boolean): { text?: string; up: number; context: boolean; limit: number } | null | string {
  const count = (flag: string, fallback: number): number | string => {
    const value = flags[flag];
    if (value === undefined) return fallback;
    const n = Number(value);
    return typeof value === 'string' && Number.isInteger(n) && n >= 0 ? n : `The ${quoted(flag)} flag takes a whole number, not ${quoted(value)}`;
  };
  const find = flags['--find'];
  if (typeof find === 'string' && find.trim() === '') return 'The `--find` flag needs some text';
  const text = typeof find === 'string' ? find : undefined;
  if (text === undefined && !selector) {
    const other = ['--up', '--context', '--limit'].find((f) => flags[f] !== undefined);
    return other ? `The ${quoted(other)} flag goes with a selector or ${quoted('--find')}` : null;
  }
  const up = count('--up', 0);
  if (typeof up === 'string') return up;
  const limit = count('--limit', PART_LIMIT);
  if (typeof limit === 'string') return limit;
  return { text, up, context: flags['--context'] === true, limit };
}

/**
 * `snapshot`'s parts as shown: one bare; more numbered, a blank line
 * apart, the first `limit` of them (0: all), and what wasn't shown.
 * When only some of a selector's matches were looked at: `total`, all
 * the matches; or for --find, `unsearched`, how many weren't searched.
 */
export function partsText(parts: string[], limit: number, { total = parts.length, unsearched = 0 }: { total?: number; unsearched?: number } = {}): string {
  if (total === 1 && unsearched === 0) return parts[0];
  const shown = limit === 0 ? parts : parts.slice(0, limit);
  let text = shown.map((part, i) => `# Match ${i + 1}\n${part}`).join('\n\n');
  if (unsearched > 0) {
    const more = unsearched === 1 ? '1 more selector match was' : `${unsearched} more selector matches were`;
    text += `\n\n# Showed ${shown.length} matches. ${more} not searched for find matches. --limit 0 shows all.`;
  } else if (shown.length < total) {
    text += `\n\n# Showed ${shown.length} of ${total} matches. --limit 0 shows all.`;
  }
  return text;
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
    if (button !== 'left' && button !== 'right' && button !== 'middle') return `${quoted(flags['--button'])} is not a mouse button. Use ${quoted('left')}, ${quoted('right')} or ${quoted('middle')}.`;
    click.button = button;
    if (button !== 'left') how.push(`the ${button} button`);
  }
  if (flags['--modifiers'] !== undefined) {
    const keys = flags['--modifiers'].split(/[+,]/).filter(Boolean).map(keyName);
    const bad = keys.find((key) => !(MODIFIERS as readonly string[]).includes(key));
    if (bad !== undefined || keys.length === 0) return `${quoted(bad ?? flags['--modifiers'])} is not a modifier key. Use ${MODIFIERS.map((m) => quoted(m)).join(', ')}, joined by ${quoted('+')}.`;
    click.modifiers = keys as (typeof MODIFIERS)[number][];
    how.push(`${keys.join('+')} held`);
  }
  if (flags['--count'] !== undefined) {
    const count = Number(flags['--count']);
    if (!Number.isInteger(count) || count < 1 || count > 10) return `The ${quoted('--count')} flag takes a number of clicks from 1 to 10, not ${quoted(flags['--count'])}`;
    click.clickCount = count;
    if (count > 1) how.push(`${count} clicks`);
  }
  if (flags['--at'] !== undefined) {
    const at = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(flags['--at'].replace(/\s/g, ''));
    if (!at) return `The ${quoted('--at')} flag takes x,y in pixels from the element's top left corner, e.g. ${quoted('--at 10,5')}, not ${quoted(flags['--at'])}`;
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
  if (key) return `${quoted(key[1])} is not a key name. Keys are named as in ${quoted('Enter')}, ${quoted('ArrowLeft')}, ${quoted('Shift+Tab')} (case-insensitive), or a single character.`;
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
    return `The point ${position.x},${position.y} is outside the element, which is ${size} (${quoted('--at')} counts from its top left corner)`;
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
export async function countOf(page: Page, selector: string, within?: Frame): Promise<number | string> {
  try {
    return await locate(page, selector, within).count();
  } catch (err) {
    if (page.isClosed()) return 'The tab closed';
    const message = (err as Error).message;
    if (/SyntaxError|not a valid selector|Unexpected token|Unknown engine|Unexpected end/i.test(message)) return 'It isn\'t a valid selector';
    return plain(err as Error);
  }
}

// The iframe a probe's matches are in: the `--frame` one, or else a
// ref's own (a selector without `--frame` looks in the top frame only).
// Undefined in the top frame; null when in one that can't be found.
async function matchesFrame(page: Page, selector: string, framed: boolean, within: Frame | undefined): Promise<Frame | null | undefined> {
  if (!framed) return undefined;
  return within ?? await refOwner(page, selector);
}

// The frame a ref's element is in, or null when it can't be found.
function refOwner(page: Page, selector: string): Promise<Frame | null> {
  return locate(page, selector).first().elementHandle({ timeout: 1000 })
    .then((el) => el.ownerFrame()).catch(() => null);
}

/**
 * With `--frame` (`within`), why a ref doesn't do there: it names an
 * element in another frame. Null when it's in that frame, or isn't a
 * ref, or can't be found (which the count says).
 */
export async function refFrameProblem(page: Page, selector: string, within: Frame | undefined, ids: FrameIds): Promise<string | null> {
  const ref = refOf(selector);
  if (!within || !ref) return null;
  const owner = await refOwner(page, selector);
  if (!owner || owner === within) return null;
  const where = owner === page.mainFrame() ? 'the top frame' : `F${ids.number(owner)}`;
  return `The ref ${quoted(ref)} is in ${where}, not F${ids.number(within)}. A ref names its own frame, so ${quoted('--frame')} can be left out.`;
}

/**
 * The iframe a `--frame` flag names in `tab`: undefined for none given,
 * or the tab's own (its top frame); null, having said why, for one that
 * isn't there. It takes `F2`, `T1.F2`, the tab's own `T1`, or a CDP id
 * as the output shows it (`frameId=...` or `targetId=...`, or the start
 * of one).
 */
export async function pickFrame(word: string | true | undefined, tab: ControlledTab, say: (line: string) => void): Promise<Frame | undefined | null> {
  if (word === undefined) return undefined;
  const sayMistake = (line: string): void => say(`${ERROR_PREFIX}${line}`);
  const text = word === true ? '' : word;
  // A tab's own ID is its top frame: the default, for this tab.
  const tabWord = /^[Tt](\d+)$/.exec(text);
  if (tabWord && Number(tabWord[1]) === tab.n) return undefined;
  if (tabWord) {
    sayMistake(`The ${quoted('--frame')} flag names ${quoted(`T${tabWord[1]}`)}, but the command acts on T${tab.n}`);
    return null;
  }
  const cdpId = CDP_FRAME_ARG.exec(text)?.[1];
  if (cdpId) return frameByCdpId(cdpId, tab, say);
  const ref = parseFrameRef(text);
  if (!ref) {
    sayMistake(`The ${quoted('--frame')} flag takes a frame ID, such as ${quoted('F2')} or ${quoted(`T${tab.n}.F2`)}, or a ${quoted('frameId=...')}, not ${quoted(text)}. Use ${quoted('frames')} to list them.`);
    return null;
  }
  if (ref.tab !== undefined && ref.tab !== tab.n) {
    sayMistake(`The ${quoted('--frame')} flag names a frame in ${quoted(`T${ref.tab}`)}, but the command acts on T${tab.n}`);
    return null;
  }
  const frame = findFrame(tab.page, tab.link.host.frameIds, ref.frame);
  if (!frame) say(`T${tab.n} has no frame ${quoted(`F${ref.frame}`)} now. Use ${quoted('frames')} to list its frames.`);
  return frame ?? null;
}

/**
 * A frame's CDP id as given, copied from the output or typed: `frameId=`
 * or `targetId=`, with its brackets or not, or the start of one long
 * enough not to be a slip.
 */
export const CDP_FRAME_ARG = /^\[?(?:frameId|targetId)=([0-9a-f]{6,})\]?$/i;

// The frame of `tab` whose CDP frame id starts with `id`: the top frame
// (undefined) for the tab's own target id, which is its frame id too.
async function frameByCdpId(id: string, tab: ControlledTab, say: (line: string) => void): Promise<Frame | undefined | null> {
  const upper = id.toUpperCase();
  if (tab.targetId?.toUpperCase().startsWith(upper)) return undefined;
  const hits: Frame[] = [];
  for (const node of frameNodes(tab.page, tab.link.host.frameIds)) {
    if ((await tab.link.frameCdpId(node.frame))?.toUpperCase().startsWith(upper)) hits.push(node.frame);
  }
  if (hits.length === 1) return hits[0];
  const ids = tab.link.host.frameIds;
  say(hits.length > 1
    ? `Several of T${tab.n}'s frames' ids start with ${quoted(id)} (${hits.map((f) => `F${ids.number(f)}`).join(', ')}). Give more of it.`
    : `No frame of T${tab.n} has an id starting with ${quoted(id)}. Use ${quoted('frames')} to list them.`);
  return null;
}

// A selector as `named` gives it, marked up: a ref as an ID, any other
// selector as code, and the ref's label after it plain.
function namedMarked(page: Page, selector: string): string {
  const label = named(page, selector).slice(selector.length);
  const ref = refOf(selector);
  if (!ref) return ui`${code(selector)}${label}`;
  // Only the ref itself in `[ref=e4]` or `ref=e4`.
  const at = selector.indexOf(ref);
  return ui`${selector.slice(0, at)}${idRole(ref)}${selector.slice(at + ref.length)}${label}`;
}

// A line of a snapshot as printed: each `[ref=e4]`'s ref marked as an
// ID, and a part's `# Match 1` heading. The rest is the page's text, so
// escaped; a snapshot written to a file stays plain.
function snapshotLine(line: string): string {
  if (/^# Match \d+$/.test(line)) return heading(line);
  if (!line.includes('[ref=')) return line;
  return MARKUP + line.split(/\[ref=([^\]\s]+)\]/).map((part, i) => (i % 2 === 1 ? `[ref=${idRole(part)}]` : escapeMarkup(part))).join('');
}

// How many elements a selector matches, or null (said why) when none
// does or it can't be counted.
async function matches(page: Page, selector: string, say: (line: string) => void, within?: Frame, ids?: FrameIds): Promise<number | null> {
  const problem = await refProblem(page, selector) ?? (ids ? await refFrameProblem(page, selector, within, ids) : null);
  if (problem) {
    say(problem);
    return null;
  }
  const count = await countOf(page, selector, within);
  if (typeof count === 'string') say(`The selector ${quoted(selector)} can't be used: ${count}`);
  else if (count === 0) {
    const ref = refOf(selector);
    const inFrame = within && ids ? `F${ids.number(within)}` : undefined;
    // Quoted as a typed word, for the probe hint.
    const word = !/[\s'"]/.test(selector) ? selector : selector.includes("'") ? `"${selector}"` : `'${selector}'`;
    say(ref ? `No element has the ref ${quoted(ref)}. Take a new snapshot for the page's refs.`
      : `No element matches ${quoted(selector)}${inFrame ? ` in ${inFrame}` : ''}. Use ${quoted(`probe${inFrame ? ` --frame ${inFrame}` : ''} ${word}`)} to look for it.`);
  }
  return typeof count === 'number' && count > 0 ? count : null;
}

