// The eval hook: one statement sm-dev's scripts get at the top of their
// user program, so `sm-dev eval --script` can run code inside a
// script's own scope and see what it sees: its `GM_*` bindings, its
// `@require`s' top-level declarations, and its own.
//
//   ;(globalThis[<key>] || <new map>)[<script id>] = (code) => eval(code);
//
// - A direct `eval` runs in the scope it's written in, so the arrow is a
//   handle on the user program's scope that outlives the script's run.
// - Only scripts in an sm-dev run's test collection get it, never the
//   person's installed scripts: the handle reaches everything the
//   script can, `GM_*` included, and a MAIN-world script's is on the
//   page's `window`.
// - The key names the run and the map isn't enumerable, so it stays out
//   of a page's casual view. A page that looks for it can still find it.
// - It needs the script not to shadow `globalThis`, `Object` or `eval`
//   where it sits.
// - A script whose code opens with an IIFE (immediately invoked
//   function expression), the usual `(function () { ... })()` wrapper,
//   gets a second copy just inside it. That one replaces the first in
//   the map as the IIFE starts, and sees the IIFE's locals as well:
//   an inner scope sees everything the outer one does.
//
// Each copy goes after its scope's directive prologue (`"use strict"`):
// a statement ahead of a directive turns it into a plain string, and
// the code would run sloppy. On the same line, so no line moves.

// The arrow's parameter, which the evaluated code sees too: named so no
// script's own would be shadowed by it.
const CODE_PARAM = '__smDevEvalCode';

/** The global key a run's eval hooks are kept under. */
export function evalHookKey(run: string): string {
  return `__smDevEval:${run}`;
}

/**
 * `program` (requires + body, as composed) with the hook in it: at its
 * top, and inside the script's IIFE when its own source, from
 * `mainStart`, opens with one.
 */
export function withEvalHook(program: string, key: string, scriptId: string, mainStart = 0): string {
  const k = JSON.stringify(key);
  const hook = `;(globalThis[${k}]||Object.defineProperty(globalThis,${k},{value:{}})[${k}])[${JSON.stringify(scriptId)}]=(${CODE_PARAM})=>eval(${CODE_PARAM});`;
  const outer = directivePrologueEnd(program);
  const body = leadingFunctionBody(program, directivePrologueEnd(program, mainStart));
  if (body < 0) return program.slice(0, outer) + hook + program.slice(outer);
  const inner = directivePrologueEnd(program, body);
  return program.slice(0, outer) + hook + program.slice(outer, inner) + hook + program.slice(inner);
}

/**
 * Where the body of the function expression the code at `from` opens
 * with starts, just past its `{`: the IIFE in `(function () {`,
 * `(() => {`, `(async function () {`, `!function () {` and the like.
 * -1 when it opens with anything else, an arrow with an expression
 * body included.
 *
 * Whether the function is called isn't checked: a copy of the hook in
 * one that never runs is never registered, and the outer one stays.
 * Nor is whether it's the only statement: a first IIFE's scope sees
 * what follows it at the top level too.
 */
export function leadingFunctionBody(program: string, from: number): number {
  let i = skipSpace(program, from).at;
  while (program[i] === ';') i = skipSpace(program, i + 1).at;
  if (/[!+\-~]/.test(program[i] ?? '')) return functionBodyAt(program, skipSpace(program, i + 1).at, 0);
  if (wordAt(program, i) === 'void') return functionBodyAt(program, skipSpace(program, i + 4).at, 0);
  // Without a prefix, only a parenthesis makes it an expression: a bare
  // `function f() {` or `async function` is a declaration, a helper
  // whose scope would shadow the script's names.
  return program[i] === '(' ? functionBodyAt(program, i, 0) : -1;
}

// The body start of a function expression at `i`, through grouping
// parentheses, or -1.
function functionBodyAt(program: string, at: number, depth: number): number {
  let i = skipSpace(program, at).at;
  if (wordAt(program, i) === 'async') i = skipSpace(program, i + 5).at;
  const word = wordAt(program, i);
  if (word === 'function') {
    i = skipSpace(program, i + 8).at;
    if (program[i] === '*') i = skipSpace(program, i + 1).at;
    const name = wordAt(program, i);
    if (name) i = skipSpace(program, i + name.length).at;
    if (program[i] !== '(') return -1;
    const close = matchingClose(program, i);
    if (close < 0) return -1;
    i = skipSpace(program, close + 1).at;
    return program[i] === '{' ? i + 1 : -1;
  }
  if (word) return arrowBody(program, i + word.length);
  if (program[i] !== '(') return -1;
  // A grouping parenthesis, looked into first, or an arrow's parameters.
  if (depth < 4) {
    const inner = functionBodyAt(program, i + 1, depth + 1);
    if (inner >= 0) return inner;
  }
  const close = matchingClose(program, i);
  return close < 0 ? -1 : arrowBody(program, close + 1);
}

// The body start of an arrow whose parameters end at `at`, or -1.
function arrowBody(program: string, at: number): number {
  const arrow = skipSpace(program, at);
  if (arrow.newline || !program.startsWith('=>', arrow.at)) return -1;
  const brace = skipSpace(program, arrow.at + 2).at;
  return program[brace] === '{' ? brace + 1 : -1;
}

// The identifier or keyword starting at `i`, or ''.
function wordAt(text: string, i: number): string {
  return /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 64))?.[0] ?? '';
}

// The closer matching the bracket at `open`, past strings, template
// literals, comments and regular expressions, or -1 when the text runs
// out or reads as something unexpected.
function matchingClose(text: string, open: number): number {
  const closers: string[] = [];
  // Whether a `/` here starts a regular expression rather than divides.
  let regexAllowed = true;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') {
      closers.push(c === '(' ? ')' : c === '[' ? ']' : '}');
      regexAllowed = true;
    } else if (c === ')' || c === ']' || c === '}') {
      if (closers.pop() !== c) return -1;
      if (closers.length === 0) return i;
      regexAllowed = false;
    } else if (c === '"' || c === '\'') {
      i = stringEnd(text, i);
      if (i < 0) return -1;
      regexAllowed = false;
    } else if (c === '`') {
      i = templateEnd(text, i);
      if (i < 0) return -1;
      regexAllowed = false;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipSpace(text, i).at - 1;
    } else if (c === '/' && regexAllowed) {
      i = regexEnd(text, i);
      if (i < 0) return -1;
      regexAllowed = false;
    } else if (/[\w$]/.test(c)) {
      const word = wordAt(text, i) || c;
      // After a keyword like `return`, an expression starts.
      regexAllowed = /^(return|typeof|case|do|else|in|instanceof|new|delete|void|throw|yield|await)$/.test(word);
      i += word.length - 1;
    } else if (!/\s/.test(c)) {
      regexAllowed = true;
    }
  }
  return -1;
}

// The index of the quote closing the string at `i`, or -1.
function stringEnd(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === quote) return j;
    else if (text[j] === '\n') return -1;
  }
  return -1;
}

// The index of the backtick closing the template literal at `i`, its
// `${...}` parts skipped, or -1.
function templateEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '`') return j;
    else if (text[j] === '$' && text[j + 1] === '{') {
      j = matchingClose(text, j + 1);
      if (j < 0) return -1;
    }
  }
  return -1;
}

// The index of the `/` closing the regular expression at `i`, or -1.
function regexEnd(text: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === '\n' || c === '\r') return -1;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j;
  }
  return -1;
}

/**
 * Where the directive prologue of the code at `from` ends (a program,
 * or a function body): just past its last directive (a string literal
 * statement at the start, `"use strict"` the one that matters), or
 * `from` when it has none. Comments and whitespace before and between
 * directives are skipped.
 *
 * A string that may be the start of a longer expression isn't counted
 * as a directive: then the hook goes before it, which is right unless
 * the guess was wrong, in code no one writes (`'use strict'` followed
 * on the next line by `in x`).
 */
export function directivePrologueEnd(program: string, from = 0): number {
  let end = from;
  let i = skipSpace(program, from).at;
  for (;;) {
    const quote = program[i];
    if (quote !== '"' && quote !== '\'') return end;
    // The literal's end. Unclosed, or broken by a line break: not ours
    // to judge, so no further.
    let j = i + 1;
    while (j < program.length && program[j] !== quote) {
      if (program[j] === '\n' || program[j] === '\r') return end;
      j += program[j] === '\\' ? 2 : 1;
    }
    if (j >= program.length) return end;
    const literalEnd = j + 1;
    const after = skipSpace(program, literalEnd);
    const next = program[after.at];
    if (next === ';') {
      end = after.at + 1;
    } else if (next === undefined || next === '}' || (after.newline && !continuesExpression(program, after.at))) {
      // Ended by the line break (automatic semicolon insertion), by the
      // end of the program, or by the end of a function body.
      end = literalEnd;
    } else {
      return end;
    }
    i = skipSpace(program, end).at;
  }
}

// Past whitespace and comments from `at`, and whether a line break was
// among them (a `/* */` comment's included).
function skipSpace(text: string, at: number): { at: number; newline: boolean } {
  let newline = false;
  let i = at;
  for (;;) {
    const c = text[i];
    if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') {
      newline = true;
      i++;
    } else if (c !== undefined && /\s/.test(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close < 0 ? text.length : close + 2;
      if (/[\n\r\u2028\u2029]/.test(text.slice(i, stop))) newline = true;
      i = stop;
    } else {
      return { at: i, newline };
    }
  }
}

// Whether the token at `at` could carry on an expression from the line
// before, so no semicolon is inserted between them.
function continuesExpression(text: string, at: number): boolean {
  return /[[(.,?+\-*/%=<>&|^`]/.test(text[at]) || /^(in|instanceof)\b/.test(text.slice(at, at + 11));
}
