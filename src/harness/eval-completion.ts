// `eval` in a script's scope runs code with a top-level `await` as an
// async function's body (page-watch.ts, `evaluateInScript`). A body
// gives a value only through `return`, so `await f(); x` would print
// undefined where the console prints x. This puts a `return` on the
// last statement when that statement is an expression.
//
// sm-dev has no JavaScript parser, so it asks V8 instead: Node's
// `AsyncFunction` constructor syntax-checks a body without running it.
// Each place a statement can end (after a `;` or a line break) is
// tried, earliest first, and the first where the rest parses as one
// expression after `return (` wins. Earliest, so an expression that
// spans lines (`a\n+ b`) is returned whole rather than its last line.

const AsyncFunction = (async () => {}).constructor as new (body: string) => unknown;

function parses(body: string): boolean {
  try {
    new AsyncFunction(body);
    return true;
  } catch {
    return false;
  }
}

// Past this many places to cut, the code runs as written: each try
// parses the whole body, so the cost grows with the square of the
// length, and console input is rarely this long.
const MAX_CUTS = 500;

// Lines at the end that are blank or only a `//` comment.
const TRAILING_COMMENTS = /(?:\n[ \t]*(?:\/\/[^\n]*)?)+$/;

/**
 * `code`, an async function body, with its last statement made a
 * `return` when that statement is an expression; null when it isn't
 * (a declaration, a block, a `return` already), or no split parses.
 */
export function returningLastExpression(code: string): string | null {
  const text = ('\n' + code).replace(TRAILING_COMMENTS, '').slice(1);
  const cuts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ';' || text[i] === '\n') cuts.push(i + 1);
  }
  if (cuts.length > MAX_CUTS) return null;
  for (const cut of cuts) {
    const last = text.slice(cut).trim().replace(/;+$/, '').trim();
    if (!last) continue;
    const before = text.slice(0, cut);
    // A line that starts like this continues the line before it when
    // nothing ends that one (`f\n(1)` is a call), so a split there
    // would change what the code does.
    if (cut > 0 && text[cut - 1] === '\n' && /^[([`+\-/]/.test(last) && !/;\s*$/.test(before)) continue;
    // A declaration is hoisted; as an expression it wouldn't be.
    if (/^(?:async\s+)?function\b|^class\b/.test(last)) return null;
    const body = `${before}\nreturn (\n${last}\n);`;
    if (!parses(body)) continue;
    // What's before the cut must be whole statements on its own: not a
    // loop or `if` waiting for its body (`for (x of xs)\n  f(x)`), and
    // not ending inside a `//` comment, where a `;` is no cut (a `)`
    // added there would parse, being part of the comment).
    if (cut > 0 && (!parses(before) || parses(before + ')'))) continue;
    return body;
  }
  return null;
}
