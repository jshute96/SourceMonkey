// Which of the page's console lines and uncaught errors `sm-dev start`
// streams. A busy site logs plenty of its own errors (blocked
// trackers, failed ads) that would bury the script's lines, so by
// default only what can be tied to a script is shown.
// Also how a console line reads when it logs a DOM node.

import type { ConsoleMessage } from '@playwright/test';

import { ROOT } from '../script-source-url.js';
import { displayRefText, parseStackRefs } from '../stack-link.js';

// Every URL SourceMonkey runs code under: the scripts, and its own
// prelude, bridge and GM runtime, whose failures are ours to show too.
const OURS = `${ROOT}/`;

// A script's main body, `<ROOT>/<folder>/<name>.user.js`, as a stack
// frame (`:line:col` follows). The extension concatenates `@require`s
// into it, so their frames carry this URL too.
const SCRIPT_BODY_FRAME = new RegExp(`${ROOT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/[^/\\s]+/[^/\\s]+\\.user\\.js:`);

export interface ConsoleLine {
  type: string;
  text: string;
  /** Where the line was logged from, `''` when unknown. */
  url: string;
  /**
   * How many values were passed. Zero for the browser's own entries
   * (a blocked request, a policy violation), which are not console
   * calls at all.
   */
  argCount: number;
}

/**
 * A line the prelude logs, which repeats a report the host already
 * printed. Never shown, nor matched by `wait log`.
 */
export function isPreludeLine(text: string): boolean {
  return text.startsWith('[SourceMonkey]');
}

export function showConsoleLine(line: ConsoleLine, pageErrors: boolean): boolean {
  if (isPreludeLine(line.text)) return false;
  if (line.url.startsWith(OURS)) return true;
  if (pageErrors && line.type === 'error') return true;
  // A `[name]`-prefixed console call passes too, for a script that
  // logs through a page-world helper. Only a real call: Chrome's own
  // entries use brackets as well (`[Report Only]`, `[Violation]`).
  return line.argCount > 0 && /^\[[^\]]+\]/.test(line.text);
}

export interface PageErrorOptions {
  pageErrors: boolean;
  /**
   * Whether the host already reports errors a script body threw (as
   * `<name> threw:`, from the extension's events), so the page's copy
   * isn't shown again.
   */
  hostReports: boolean;
}

/** `stack` is Playwright's for the error: the message, then its frames. */
/** An error a script body threw, which the host printed already. */
export function hostReportedError(stack: string, hostReports: boolean): boolean {
  return hostReports && SCRIPT_BODY_FRAME.test(stack);
}

export function showPageError(stack: string, opts: PageErrorOptions): boolean {
  if (hostReportedError(stack, opts.hostReports)) return false;
  if (opts.pageErrors) return true;
  // A thrown or rejected non-Error value (`Promise.reject('nope')`)
  // has no frames, so there's no telling whose it was. Rare enough
  // that showing it beats losing a script's.
  if (!/\n\s+at /.test(stack)) return true;
  return stack.includes(OURS);
}

// How a node logged to the console reads: its opening tag, as in
// `<div id="x" class="a b">`, rather than Playwright's `JSHandle@node`.
// Cut at this length, attribute values first.
const NODE_TEXT_CHARS = 120;
const NODE_LOOKUP_MS = 1000;

/**
 * A console call's text, as `msg.text()` gives it but with each DOM
 * node described (see NODE_TEXT_CHARS) and `%` directives applied
 * (`formatConsoleArgs`). Every level goes through this,
 * so `debug` and `error` lines read alike. A node that can't be read
 * now keeps Playwright's text: its page gone, or not answering within
 * NODE_LOOKUP_MS (a dialog open, paused in the debugger), since the
 * page's later lines wait for this one.
 */
export async function consoleText(msg: ConsoleMessage): Promise<string> {
  const parts = await Promise.all(msg.args().map(async (arg) => {
    const node = arg.asElement();
    if (!node) return arg.toString();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(arg.toString()), NODE_LOOKUP_MS); });
    try {
      return await Promise.race([node.evaluate(describeNode, NODE_TEXT_CHARS), late]);
    } catch {
      return arg.toString();
    } finally {
      clearTimeout(timer);
    }
  }));
  return formatConsoleArgs(parts);
}

/**
 * A console call's values as one line, the first one's `%` directives
 * applied as the browser's console does: `%s`, `%d`, `%i`, `%f`, `%o`
 * and `%O` take the next value in its place, `%c` takes the next value
 * (its CSS) and shows nothing, and `%%` is a `%`. The values left over
 * follow, space-separated. A string the page logged with `%` and no
 * values to take reads as written.
 */
export function formatConsoleArgs(parts: string[]): string {
  if (parts.length < 2 || !parts[0].includes('%')) return parts.join(' ');
  let next = 1;
  const first = parts[0].replace(/%([sdifoOc%])/g, (whole, kind: string) => {
    if (kind === '%') return '%';
    if (next >= parts.length) return whole;
    const value = parts[next++];
    if (kind === 'c') return '';
    if (kind === 'd' || kind === 'i') return String(parseInt(value, 10));
    if (kind === 'f') return String(parseFloat(value));
    return value;
  });
  return [first, ...parts.slice(next)].join(' ');
}

// Longer console lines are cut in the stream, so one huge value (a
// fetched page, a cache) doesn't bury the rest. `logs` shows them whole.
const CONSOLE_SHOWN_CHARS = 1000;

/** A console line as the stream shows it: cut past CONSOLE_SHOWN_CHARS. */
export function shortConsoleText(text: string): string {
  if (text.length <= CONSOLE_SHOWN_CHARS) return text;
  // By code point, so an emoji isn't cut in half.
  return `${Array.from(text).slice(0, CONSOLE_SHOWN_CHARS).join('')}... (${text.length} chars; logs shows it all)`;
}

// Runs in the page.
function describeNode(node: Node, limit: number): string {
  const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s);
  if (node.nodeType === Node.TEXT_NODE) return `#text ${JSON.stringify(cut(node.textContent ?? '', 40))}`;
  if (!(node instanceof Element)) return node.nodeName;
  const attrs = Array.from(node.attributes, (a) => (a.value === '' ? a.name : `${a.name}="${cut(a.value, 40)}"`));
  const tag = node.tagName.toLowerCase();
  const open = `<${[tag, ...attrs].join(' ')}>`;
  return open.length > limit ? `${open.slice(0, limit - 4)}...>` : open;
}

/**
 * `text` with each stack ref to SourceMonkey's own `sourcemonkey://`
 * URLs decoded once, as the viewer's Log tab shows them: a file named
 * `Video%20Speed%20Buttons.user.js` is in the URL as
 * `Video%2520Speed%2520Buttons.user.js`. Other refs stay as they are.
 */
export function decodeOwnRefs(text: string): string {
  if (!text.includes(`${ROOT}/`)) return text;
  return parseStackRefs(text).map((run) => (run.kind === 'ref' ? displayRefText(run.text, run.url) : run.text)).join('');
}
