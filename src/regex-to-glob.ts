// Globs for a regex `@include`, so Chrome can skip pages the regex
// can't match instead of injecting the script everywhere.
//
// Chrome has no regex rules, so a regex `@include` used to register
// `<all_urls>`, and the wrapper's in-page matcher dropped the script on
// every page but its own. Here the regex is read for what any URL it
// matches must contain, and that becomes `includeGlobs`. The wrapper
// still applies the regex itself, so the globs only have to be a
// superset: every URL the regex matches, some glob must match too.
//
// What Chrome's globs see (probed in tests/e2e/regex-include-globs.spec.ts):
//   - The whole URL, query and fragment included: what the wrapper
//     tests the regex against (`location.href`).
//   - With the scheme and host lowercased. Globs are case-sensitive,
//     and a regex `@include` ignores case (as in Tampermonkey and
//     Violentmonkey), so only there can a literal letter be kept, in
//     lowercase. Elsewhere a letter becomes `?` (exactly one character,
//     of any case).
//
// How a regex is read:
//   - As alternatives, each a sequence of literal characters and
//     variable pieces. A top-level `|`, and small optional or
//     alternative groups (`(www\.)?`, `(eu|com)`), are expanded into
//     separate alternatives, up to MAX_ALTERNATIVES.
//   - A variable piece that matches exactly one character (`.`, `\d`,
//     `[a-z]`) is `?`; anything else (a repeat, a group too big to
//     expand) is `*`.
//   - An anchored alternative that can't start a URL a script runs on
//     (those start `http` or `file`) is dropped.
//   - Anything not understood, or an alternative whose glob keeps no
//     letter of the host, gives up: null, and the script keeps the
//     `<all_urls>` registration.

type Token =
  | { kind: 'lit'; ch: string }
  // `one`: matches exactly one character. `slash`, `at`: can match a
  // `/`, an `@`.
  | { kind: 'wild'; one: boolean; slash: boolean; at: boolean };

// The ways a piece of the regex can be spelled out.
type Alternatives = Token[][];

// More alternatives than this, and a group collapses into one variable
// piece (or, at the top level, the script keeps `<all_urls>`).
const MAX_ALTERNATIVES = 16;
// A fixed repeat (`\d{4}`) is spelled out up to this many times.
const MAX_REPEAT = 16;

class Unsupported extends Error {}

/**
 * Globs whose union covers every URL `pattern` (a `/.../` regex
 * `@include`) can match, or null when none can be derived.
 */
export function regexIncludeGlobs(pattern: string): string[] | null {
  if (pattern.length < 2 || !pattern.startsWith('/') || !pattern.endsWith('/')) return null;
  const source = pattern.slice(1, -1);
  try {
    // The wrapper's reading (`includePattern` in url-match.ts). A regex
    // that doesn't compile matches nothing there; give up here too.
    new RegExp(source, 'i');
  } catch {
    return null;
  }
  try {
    const branches: { tokens: Token[]; start: boolean; end: boolean }[] = [];
    for (const top of splitTop(source)) {
      const { body, start, end } = anchors(top);
      for (const tokens of parseSeq(body)) branches.push({ tokens, start, end });
      if (branches.length > MAX_ALTERNATIVES) return null;
    }
    const globs: string[] = [];
    for (const b of branches) {
      if (b.start && !canStartUrl(b.tokens)) continue;
      const g = globsOf(b.tokens, b.start, b.end);
      if (!g) return null;
      globs.push(...g);
    }
    return globs.length > 0 ? [...new Set(globs)] : null;
  } catch (err) {
    if (err instanceof Unsupported) return null;
    throw err;
  }
}

// The top-level alternatives of a regex source.
function splitTop(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') i++;
    else if (c === '[') i = classEnd(source, i);
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) {
      out.push(source.slice(from, i));
      from = i + 1;
    }
  }
  out.push(source.slice(from));
  return out;
}

// A leading `^` and a trailing (unescaped) `$`. Anchors anywhere else
// are read as matching nothing: dropping one only lets the glob match
// more, which is safe.
function anchors(source: string): { body: string; start: boolean; end: boolean } {
  let body = source;
  const start = body.startsWith('^');
  if (start) body = body.slice(1);
  const end = body.endsWith('$') && body.slice(0, -1).match(/\\*$/)![0].length % 2 === 0;
  if (end) body = body.slice(0, -1);
  return { body, start, end };
}

// The alternatives of a sequence with no top-level `|`.
function parseSeq(src: string): Alternatives {
  let out: Alternatives = [[]];
  let i = 0;
  while (i < src.length) {
    let atom: Alternatives;
    const c = src[i];
    if (c === '\\') {
      atom = [escapeAtom(src, i)];
      i += escapeLength(src, i);
    } else if (c === '[') {
      const close = classEnd(src, i);
      atom = [[singleChar(src.slice(i, close + 1))]];
      i = close + 1;
    } else if (c === '(') {
      const close = groupEnd(src, i);
      atom = groupAtom(src.slice(i + 1, close));
      i = close + 1;
    } else if (c === '.') {
      atom = [[{ kind: 'wild', one: true, slash: true, at: true }]];
      i++;
    } else if (c === '^' || c === '$') {
      atom = [[]];
      i++;
    } else if (c === ')' || c === '|') {
      throw new Unsupported();
    } else {
      atom = [[{ kind: 'lit', ch: c }]];
      i++;
    }
    const q = quantifier(src, i);
    if (q) {
      atom = repeat(atom, q.min, q.max);
      i = q.next;
    }
    // A choice of at most one character right before `://`, as in
    // `https?://` or `http(|s)://`: one `*` (`http*://`) rather than a
    // copy per choice. No scheme a script runs on starts with `http`
    // but `http` and `https`, so it narrows just as well, with half the
    // globs.
    if (atom.length > 1 && atom.every((t) => t.length <= 1 && t.every((x) => x.kind === 'lit'))
        && /^(:\/\/|:\\\/\\\/)/.test(src.slice(i))) {
      atom = [[{ kind: 'wild', one: false, slash: false, at: false }]];
    }
    out = concat(out, atom);
  }
  return out;
}

// Each way of spelling `a` followed by each of `b`; when that's too
// many, `b` collapses into one variable piece.
function concat(a: Alternatives, b: Alternatives): Alternatives {
  if (a.length * b.length > MAX_ALTERNATIVES) b = [collapse(b)];
  if (a.length * b.length > MAX_ALTERNATIVES) throw new Unsupported();
  return a.flatMap((x) => b.map((y) => [...x, ...y]));
}

// Several alternatives as one variable piece.
function collapse(alts: Alternatives): Token[] {
  if (alts.every((t) => t.length === 0)) return [];
  return [{ kind: 'wild', one: false, slash: alts.some(canMatchSlash), at: alts.some(canMatchAt) }];
}

// What a `\` escape stands for.
function escapeAtom(src: string, i: number): Token[] {
  const n = src[i + 1];
  if (n === undefined) throw new Unsupported();
  if (n === 'b' || n === 'B') return [];
  if ('dDwWsS'.includes(n)) return [singleChar(`\\${n}`)];
  // A digit escape (a backreference or a legacy octal escape;
  // `escapeLength` takes all its digits), `\k<name>`, and `\p`: a
  // variable piece that may be any length.
  if (/[0-9k]/.test(n) || n === 'p' || n === 'P') return [{ kind: 'wild', one: false, slash: true, at: true }];
  // `\c` not followed by a letter is two literal characters, `\` and
  // `c` (legacy syntax, as a regex without the `u` flag reads it).
  if (n === 'c' && !/^[A-Za-z]$/.test(src[i + 2] ?? '')) return [{ kind: 'lit', ch: '\\' }, { kind: 'lit', ch: 'c' }];
  if (n === 'x' || n === 'u' || n === 'c') return [singleChar(src.slice(i, i + escapeLength(src, i)))];
  // `\n`, `\t` and the like never occur in a URL; as one-character
  // pieces they stay correct either way.
  if ('nrtfv'.includes(n)) return [{ kind: 'wild', one: true, slash: false, at: false }];
  // An identity escape (`\.`, `\/`, `\-`): the character itself.
  return [{ kind: 'lit', ch: n }];
}

function escapeLength(src: string, i: number): number {
  const n = src[i + 1];
  if (n === 'x') return /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4)) ? 4 : 2;
  if (n === 'u') return /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6)) ? 6 : 2;
  if (n === 'c') return /^[A-Za-z]$/.test(src[i + 2] ?? '') ? 3 : 2;
  if (/[0-9]/.test(n)) return 1 + src.slice(i + 1).match(/^[0-9]+/)![0].length;
  if (n === 'k' && src[i + 2] === '<') {
    const close = src.indexOf('>', i + 3);
    if (close < 0) throw new Unsupported();
    return close - i + 1;
  }
  return 2;
}

// A piece that matches exactly one character (a class, `\d`, `\x41`).
// Whether it can match `/` or `@` is asked of the regex engine itself,
// with the wrapper's flags.
function singleChar(atomSource: string): Token {
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${atomSource})$`, 'i');
  } catch {
    throw new Unsupported();
  }
  return { kind: 'wild', one: true, slash: re.test('/'), at: re.test('@') };
}

// A group's contents: a lookaround matches nothing; otherwise its
// alternatives.
function groupAtom(inner: string): Alternatives {
  if (/^\?<?[=!]/.test(inner)) return [[]];
  let body = inner;
  if (body.startsWith('?:')) body = body.slice(2);
  else if (body.startsWith('?<')) {
    const close = body.indexOf('>');
    if (close < 0) throw new Unsupported();
    body = body.slice(close + 1);
  } else if (body.startsWith('?')) throw new Unsupported();
  const alts = splitTop(body).flatMap(parseSeq);
  return alts.length > MAX_ALTERNATIVES ? [collapse(alts)] : alts;
}

function canMatchSlash(tokens: Token[]): boolean {
  return tokens.some((t) => (t.kind === 'lit' ? t.ch === '/' : t.slash));
}

function canMatchAt(tokens: Token[]): boolean {
  return tokens.some((t) => (t.kind === 'lit' ? t.ch === '@' : t.at));
}

// `?`, `*`, `+`, `{n}`, `{n,}`, `{n,m}`, each optionally lazy (`?`).
function quantifier(src: string, i: number): { min: number; max: number; next: number } | null {
  const c = src[i];
  let q: { min: number; max: number; next: number } | null = null;
  if (c === '?') q = { min: 0, max: 1, next: i + 1 };
  else if (c === '*') q = { min: 0, max: Infinity, next: i + 1 };
  else if (c === '+') q = { min: 1, max: Infinity, next: i + 1 };
  else if (c === '{') {
    // Not a quantifier unless it's well formed: then a literal `{`.
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
    if (m) {
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      q = { min, max, next: i + m[0].length };
    }
  }
  if (q && src[q.next] === '?') q.next++;
  return q;
}

function repeat(atom: Alternatives, min: number, max: number): Alternatives {
  if (min === 0 && max === 1) {
    // Optional: with it and without it, kept apart when that's few
    // enough.
    const alts = [...atom, []];
    return alts.length > MAX_ALTERNATIVES ? [collapse(atom)] : alts;
  }
  if (min === 1 && max === 1) return atom;
  // Several copies: spelled out only for a single literal sequence.
  const one = atom.length === 1 ? atom[0] : collapse(atom);
  if (min === max && min <= MAX_REPEAT) return [Array.from({ length: min }, () => one).flat()];
  const required = min >= 1 && min <= MAX_REPEAT ? Array.from({ length: min }, () => one).flat() : [];
  return [[...required, ...collapse([one])]];
}

// The index of the `]` closing the class that opens at `i`.
function classEnd(src: string, i: number): number {
  let j = i + 1;
  if (src[j] === '^') j++;
  for (; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === ']') return j;
  }
  throw new Unsupported();
}

// The index of the `)` closing the group that opens at `i`.
function groupEnd(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === '[') j = classEnd(src, j);
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  throw new Unsupported();
}

// Could an anchored alternative match the start of a URL a script runs
// on? Those start with a lowercase `http` or `file` scheme.
function canStartUrl(tokens: Token[]): boolean {
  const first = tokens[0];
  return !first || first.kind === 'wild' || /^[hf]$/i.test(first.ch);
}

// A cased letter: one a case-insensitive regex matches in either case.
function isCased(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

// The globs for one alternative, or null when they'd match nearly every
// page anyway: they keep no letter of the host, and the scheme isn't
// `file` (a `file://` URL has no host, but `file:///…` alone already
// leaves out every web page).
//
// Literal letters survive only in the scheme and host, which Chrome
// lowercases: the URL's first `://` and what follows it up to the next
// `/`. So the alternative's own first `://` is placed in two ways:
//   - As the URL's scheme separator. Its scheme and host literals keep
//     their letters (lowercased); this is the glob that narrows.
//   - As a later `://` (an embedded URL, say in a query string), where
//     nothing is lowercased. That needs a second `://` in the URL, so
//     this glob still excludes most pages. It's left out when it can't
//     happen: an anchored alternative whose `://` comes before any
//     piece that could match a `/`.
//     - Unanchored, the glob starts at the alternative's own `://`: what
//       comes before it may overlap the URL's first `://` (a regex
//       starting `\/\/host`), so it can't be placed after it.
// (The alternative's `://` can't fall before the URL's first one: a
// scheme has no `:` or `/`.)
//
// And one more for a URL with a username (`https://user@host/`), when
// the alternative's host part could reach into it: Chrome lowercases the
// host but not the username. That glob just asks for an `@` after the
// scheme, which still leaves out most pages. It isn't needed when the
// host part can't match an `@` and is followed by a literal `/` (or the
// end, with `$`): then a username would sit where the host literals
// must match, and the regex couldn't match that URL either.
// (`^https://x\.com/` can't match `https://user@x.com/`;
// `^https://[^/]*xyz` matches `https://XYZ@site.com/`.)
function globsOf(tokens: Token[], start: boolean, end: boolean): string[] | null {
  const sep = schemeSeparator(tokens);
  if (sep < 0) return null;
  let hostEnd = sep + 3;
  while (hostEnd < tokens.length && !canMatchSlash([tokens[hostEnd]])) hostEnd++;
  const ownScheme = render(tokens, start, end, (i) => i < hostEnd);
  const hostLetter = /[a-z]/.test(ownScheme.slice(ownScheme.indexOf('://')));
  if (!hostLetter && !isFileScheme(tokens.slice(0, sep), start)) return null;
  const out = [ownScheme];
  const hostClosed = hostEnd < tokens.length ? isLit(tokens[hostEnd], '/') : end;
  if (!hostClosed || canMatchAt(tokens.slice(sep + 3, hostEnd))) {
    out.push(render(tokens.slice(0, sep), start, true, () => true) + '://*@*');
  }
  if (!start || canMatchSlash(tokens.slice(0, sep))) {
    out.push(start ? render(tokens, true, end, () => false) : '*://*' + render(tokens.slice(sep), true, end, () => false));
  }
  return out.map((g) => g.replace(/\*+/g, '*'));
}

function render(tokens: Token[], start: boolean, end: boolean, lowercase: (i: number) => boolean): string {
  let glob = start ? '' : '*';
  tokens.forEach((t, i) => {
    if (t.kind === 'wild') glob += t.one ? '?' : '*';
    else if (isCased(t.ch)) {
      // Lowercase only ASCII: Chrome's URL host is ASCII (punycode).
      glob += lowercase(i) && /^[A-Za-z]$/.test(t.ch) ? t.ch.toLowerCase() : '?';
    } else if (t.ch === '*' || t.ch === '?' || t.ch === '\\') {
      // Characters a glob treats specially (`\` escapes the next one in
      // Chrome's matcher). Any one character covers each.
      glob += '?';
    } else glob += t.ch;
  });
  return end ? glob : glob + '*';
}

// Whether the pieces before the `://` can only be the `file` scheme:
// exactly `file` when anchored, or ending in `file` when not (no scheme
// a script runs on ends in `file` but `file` itself).
function isFileScheme(prefix: Token[], start: boolean): boolean {
  if (!prefix.every((t) => t.kind === 'lit')) return false;
  const text = prefix.map((t) => (t as { ch: string }).ch).join('').toLowerCase();
  return start ? text === 'file' : text.endsWith('file');
}

// Where the alternative's first `://` starts, or -1.
function schemeSeparator(tokens: Token[]): number {
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (isLit(tokens[i], ':') && isLit(tokens[i + 1], '/') && isLit(tokens[i + 2], '/')) return i;
  }
  return -1;
}

function isLit(t: Token, ch: string): boolean {
  return t.kind === 'lit' && t.ch === ch;
}
