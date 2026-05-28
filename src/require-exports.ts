// Parse the `/* exported X, Y, Z */` JSHint directive out of a
// `@require`d JS source.
//
// Why: each `@require` is injected as its own `js[]` entry, which is
// its own V8 script with its own top-level scope. Top-level
// `const`/`let`/`class` declarations stay trapped inside that scope
// and aren't visible to the main body in a sibling entry. To bridge
// the two, the injector enumerates the names the require *intends*
// to expose, then emits explicit forwarding (`Object.assign` on the
// require side, destructuring on the main side). We trust the
// directive rather than running a full JS parser — most well-linted
// userscript libraries include it (utilsjs.js, mutations.js, etc.).
// Libraries that omit it stay broken for `let`/`const`/`class`, same
// as before this change — no regression for the unlit case.
//
// Recognized forms (the keyword match is case-insensitive — JSHint
// itself is tolerant):
//
//   /* exported X */
//   /* exported X, Y, Z */
//   /* exported X Y Z */
//   /* exported
//    * X
//    * Y, Z
//    */
//
// JSDoc-style leading `*` on continuation lines is stripped. Names
// must be valid JS identifiers (`[A-Za-z_$][\w$]*`); anything else
// in the directive is silently ignored — keeps the parser robust
// against odd whitespace, trailing commas, comment soup.
//
// Multiple `/* exported */` blocks in one file are unioned in
// first-seen order. Duplicates across blocks are dedup'd.
export function parseExportedNames(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\/\*\s*exported\s+([\s\S]*?)\*\//gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Strip JSDoc-style leading `*` decorations so multi-line
    // directives parse the same as single-line ones.
    const cleaned = m[1].replace(/^\s*\*+/gm, ' ');
    for (const tok of cleaned.split(/[\s,]+/)) {
      if (!tok) continue;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

// Names the wrap reserves; refused even if a require lists them in
// `/* exported */`. Each case below redeclares an identifier the
// main-body wrap already binds with `const`, so `var{X}=...` for the
// same X would be a hard SyntaxError at parse — killing the whole
// main body before it runs.
//
//   - `GM_*` — every granted GM binding (`const GM_setValue`, etc.)
//     and the implicit `const GM_info`.
//   - `GM` — the GM4 namespace object: `const GM = Object.freeze({…})`
//     (src/gm-bindings.ts).
//   - `unsafeWindow` — `const unsafeWindow = window` (src/gm-bindings.ts).
//   - `__sm*` — SourceMonkey's own internals (`__smE`, `__smDecision`,
//     `__smName`, `__smId`, `__smLoadedAt`, `__smSend`, `__smGmSnap`).
//
// JS reserved words / contextual keywords are also dropped. The
// destructure `var{null}=…` / `var{true}=…` is a hard parse error;
// `var{let}=…` / `var{eval}=…` etc. would slip past in sloppy mode
// but are clearly user error in a `/* exported */` directive. We bake
// in the deny-list rather than running each name through `new
// Function('var ' + name)` — the surface is small and stable, and a
// runtime parse-test per registration would be wasteful.
//
// In practice no real userscript library exports a name in any of
// these namespaces — the filter exists for safety, not for known cases.
const RESERVED_DESTRUCTURE_NAMES: ReadonlySet<string> = new Set([
  'GM', 'unsafeWindow',
  // Reserved words and contextual keywords that JS forbids as
  // identifier targets in a binding pattern (or in strict mode).
  // The full ES spec list is longer; this covers the names a
  // confused `/* exported */` line could plausibly include.
  'null', 'true', 'false', 'undefined',
  'this', 'super', 'new', 'delete', 'void', 'typeof', 'in', 'of',
  'instanceof', 'return', 'throw', 'try', 'catch', 'finally',
  'if', 'else', 'switch', 'case', 'default', 'break', 'continue',
  'do', 'while', 'for', 'function', 'class', 'extends', 'static',
  'var', 'let', 'const', 'import', 'export', 'from', 'as',
  'async', 'await', 'yield', 'eval', 'arguments',
  'public', 'private', 'protected', 'package', 'interface',
  'implements', 'enum', 'with',
]);
export function filterForwardableNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (n.startsWith('GM_')) continue;
    if (n.startsWith('__sm')) continue;
    if (RESERVED_DESTRUCTURE_NAMES.has(n)) continue;
    out.push(n);
  }
  return out;
}
