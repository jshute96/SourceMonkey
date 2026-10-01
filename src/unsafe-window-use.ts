// Does a script's own source reference `unsafeWindow` without granting
// it?
//
// `@grant unsafeWindow` is how a script is *supposed* to ask for the
// page's window, and it is what moves the script to MAIN world
// (`resolveWorld` in injector.ts). Plenty of real scripts never declare
// it: `unsafeWindow` is implicitly available under Tampermonkey and
// Violentmonkey — neither keys it off a grant line, measured under TM
// 5.5.0 and VM 2.49.0 by `tests/examples/unsafe-window/ungranted.user.js`
// — so an author who only ever tested there has no reason to add one.
//
// Measured over the GreasyFork top 2000: 112 scripts use `unsafeWindow`
// with no grant for it. 75 of them resolve to the isolated USER_SCRIPT
// world today, where the identifier is an outright `ReferenceError`;
// the other 37 (`@grant none` and friends) already run in MAIN but
// still get no binding, so they throw too. Honoring the reference is
// what makes those scripts run at all.
//
// This is a text scan, not a parse. We have no JS parser in the
// extension (the install-time check compiles with `new Function` in a
// sandboxed page and reports only a verdict — see docs/parse-check.md),
// and the answer is needed on the storage row. So:
//
//   - Comments and string / template literals are stripped first, so a
//     mention in a comment or a log message doesn't move a script's
//     world. That was 13 of the 126 ungranted mentions in the corpus.
//   - A property key, a `#private` member and a `foo.unsafeWindow`
//     access don't count. A false positive costs a script its
//     isolation, and in MAIN world the page can drive the GM runtime
//     the script's other grants need, so the bar here is higher than
//     for a miss.
//   - A regex literal is NOT recognized. `/['"]/` therefore opens a
//     string state that runs to the next quote, and a literal ending in
//     `\/\/` reads as a line comment — either can swallow real code.
//     Normally that costs a missed reference, which leaves the script
//     behaving as it does today. If it swallows a DECLARATION while
//     leaving a use visible, the script moves to MAIN world and gets a
//     binding it shadows anyway: it loses its isolation for nothing,
//     but still runs. No corpus script hits it.
//   - A script that DECLARES the name — `const unsafeWindow =
//     window.wrappedJSObject || window;`, a real cross-browser idiom —
//     answers false, including in a declarator list or a destructuring
//     pattern. Its references read its own binding, never ours, so
//     there is nothing to move worlds for. (Our binding would be
//     harmless beside it: the user program runs in a nested scope, so
//     the script's declaration shadows it. See wrapCombinedEntry in
//     injector.ts.) The check is scope-blind, so a declaration inside a
//     function suppresses the whole script: that direction only costs
//     the feature.
//
// Only the script's own body is scanned, not its `@require` bodies: the
// requires arrive on a later pipeline step (`attachFiles`). See
// TODO.md.

const IDENT = /[$\w]/;

// Strip comments and quoted text, leaving a space in their place so
// adjacent tokens can't merge into a new identifier.
//
// Written to jump between interesting positions rather than walk every
// character: this runs on every script body that mentions the name, at
// load time, beside the row's SHA-256. On the corpus's largest body
// (1.8 MB) the per-character form cost ~200 ms, more than 20x that hash.
function stripQuotedAndComments(src: string): string {
  // A fresh regex per call — `lastIndex` is state, and this function
  // recurses into template substitutions.
  const delim = /\/\/|\/\*|["'`]/g;
  const parts: string[] = [];
  const n = src.length;
  let kept = 0;
  for (let m = delim.exec(src); m !== null; m = delim.exec(src)) {
    const from = m.index;
    let after: number;
    let replacement = ' ';
    if (m[0] === '//') {
      const nl = src.indexOf('\n', from);
      after = nl === -1 ? n : nl;
    } else if (m[0] === '/*') {
      const close = src.indexOf('*/', from + 2);
      after = close === -1 ? n : close + 2;
    } else {
      const quote = m[0];
      // The code found inside this template's `${ ... }` substitutions.
      const inner: string[] = [];
      let i = from + 1;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        // A substitution holds real code, so scan it as code rather
        // than as text.
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          const innerStart = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') depth -= 1;
            i += 1;
          }
          inner.push(stripQuotedAndComments(src.slice(innerStart, i - 1)));
          continue;
        }
        i += 1;
      }
      after = i;
      if (inner.length > 0) replacement = ` ${inner.join(' ')} `;
    }
    if (from > kept) parts.push(src.slice(kept, from));
    parts.push(replacement);
    kept = after;
    delim.lastIndex = after;
  }
  if (n > kept) parts.push(src.slice(kept, n));
  return parts.join('');
}

// A free `unsafeWindow` — not `foo.unsafeWindow`, not `unsafeWindows`,
// not a member the source happens to have named that.
function hasFreeReference(code: string): boolean {
  let from = 0;
  for (;;) {
    const at = code.indexOf('unsafeWindow', from);
    if (at === -1) return false;
    from = at + 'unsafeWindow'.length;
    if (IDENT.test(code[from] ?? '')) continue;
    // Immediately preceded by an identifier character → the tail of a
    // longer name (`myunsafeWindow`). Whitespace in between means a
    // separate token, which `typeof unsafeWindow` needs to pass.
    if (IDENT.test(code[at - 1] ?? '')) continue;
    // Walk back over whitespace: `foo\n  .unsafeWindow` is a property,
    // and `#unsafeWindow` is a private class member.
    let before = at - 1;
    while (before >= 0 && /\s/.test(code[before])) before -= 1;
    if (code[before] === '.' || code[before] === '#') continue;
    // Followed by `:` → a property key (`{ unsafeWindow: window }`) or a
    // label, which declares a name rather than reading the page's. This
    // also skips `cond ? unsafeWindow : other`, and that is the trade we
    // want: a script using the name in a ternary almost always uses it
    // somewhere else too, while a key is the whole mention.
    let next = from;
    while (next < code.length && /\s/.test(code[next])) next += 1;
    if (code[next] === ':') continue;
    return true;
  }
}

// `function unsafeWindow(` / `class unsafeWindow`.
const DECLARES_AS_CALLABLE = /(?:^|[^$\w.])(?:function|class)\s+unsafeWindow(?![$\w])/;

const KEYWORD = /(?:^|[^$\w.])(?:var|let|const)(?![$\w])/g;

// How far past a `var` / `let` / `const` to keep looking for the end of
// its declarator list. A statement without a `;` (ASI) would otherwise
// run the scan into the rest of the file; over-running only ever
// over-suppresses, but there is no reason to pay for it.
const DECLARATOR_SPAN = 2000;

// Is `unsafeWindow` a NAME BEING BOUND anywhere in this source, rather
// than a value being read? A script that binds the name reads its own
// value, so it gets neither our binding nor the move to MAIN world.
//
// Walks each `var` / `let` / `const` declarator list, tracking bracket
// depth and whether the current declarator has passed its `=`:
//
//   const unsafeWindow = window      → bound (before any `=`)
//   let uw = window, unsafeWindow=uw → bound (the `,` starts a declarator)
//   const { unsafeWindow } = window  → bound (pattern, before the `=`)
//   const app = unsafeWindow.thing   → read (after the `=`) — by far the
//                                      commonest real use, and the one
//                                      thing this must not claim
//   const xs = [1, unsafeWindow]     → read (bracketed, after the `=`)
//
// Scope-blind on purpose: a declaration inside a function suppresses the
// whole script. That direction only costs the feature.
function declaresBinding(code: string): boolean {
  if (DECLARES_AS_CALLABLE.test(code)) return true;
  KEYWORD.lastIndex = 0;
  for (let m = KEYWORD.exec(code); m !== null; m = KEYWORD.exec(code)) {
    const limit = Math.min(code.length, m.index + DECLARATOR_SPAN);
    let depth = 0;
    let afterEquals = false;
    let i = KEYWORD.lastIndex;
    while (i < limit) {
      const c = code[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ';' && depth === 0) break;
      else if (c === ',' && depth === 0) afterEquals = false;
      else if (c === '=' && code[i + 1] !== '=' && !'=!<>'.includes(code[i - 1] ?? '')) {
        afterEquals = true;
      } else if (c === 'u' && code.startsWith('unsafeWindow', i)) {
        const after = code[i + 'unsafeWindow'.length] ?? '';
        const prev = code[i - 1] ?? '';
        if (!IDENT.test(after) && !IDENT.test(prev) && prev !== '.') {
          if (!afterEquals) return true;
          i += 'unsafeWindow'.length;
          continue;
        }
      }
      i += 1;
    }
  }
  return false;
}

export function sourceUsesUnsafeWindow(bodyText: string | null | undefined): boolean {
  // The overwhelmingly common answer, without paying for the scan.
  if (!bodyText || bodyText.indexOf('unsafeWindow') === -1) return false;
  const code = stripQuotedAndComments(bodyText);
  if (declaresBinding(code)) return false;
  return hasFreeReference(code);
}
