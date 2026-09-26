// Which of the page's console lines and uncaught errors `sm-dev start`
// streams. A busy site logs plenty of its own errors (blocked
// trackers, failed ads) that would bury the script's lines, so by
// default only what can be tied to a script is shown.

import { ROOT } from '../script-source-url.js';

// Every URL SourceMonkey injects code under: the scripts, and its own
// prelude, bridge and GM runtime, whose failures are ours to show too.
const OURS = `${ROOT}/`;

// A script's main body, `<ROOT>/<folder>/<name>.user.js`, as a stack
// frame (`:line:col` follows). The harness concatenates `@require`s
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

export function showConsoleLine(line: ConsoleLine, pageErrors: boolean): boolean {
  // The prelude's own lines duplicate the host's reports.
  if (line.text.startsWith('[SourceMonkey]')) return false;
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
   * Whether the harness host already reports errors a script body
   * threw (as `<name> threw:`). The extension's reports come from its
   * Log tab instead, later, so there the page's copy stays.
   */
  hostReports: boolean;
}

/** `stack` is Playwright's for the error: the message, then its frames. */
export function showPageError(stack: string, opts: PageErrorOptions): boolean {
  if (opts.hostReports && SCRIPT_BODY_FRAME.test(stack)) return false;
  if (opts.pageErrors) return true;
  // A thrown or rejected non-Error value (`Promise.reject('nope')`)
  // has no frames, so there's no telling whose it was. Rare enough
  // that showing it beats losing a script's.
  if (!/\n\s+at /.test(stack)) return true;
  return stack.includes(OURS);
}
