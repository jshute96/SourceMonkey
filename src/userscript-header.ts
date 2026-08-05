// Parser for the Tampermonkey-style metadata block at the top of a
// userscript:
//
//   // ==UserScript==
//   // @name        Hello
//   // @match       https://example.com/*
//   // @grant       none
//   // ==/UserScript==
//
// We return a flat list of `{tag, locale?, value}` entries in source
// order so callers can decide which tags are single-valued (@name,
// @version) and which can repeat (@match, @grant, @require, …) without
// the parser baking that policy in. Tag names are lowercased so lookups
// are case-insensitive; locales like `@name:de` are kept on the side.

export interface HeaderTag {
  tag: string;       // canonical lowercase, no locale suffix (e.g. "name")
  locale?: string;   // present for i18n forms like "@name:de" → "de"
  value: string;     // text after the tag, trimmed; "" for flag tags
  // 1-based line in the WHOLE source (not within the block), so a
  // diagnostic about this tag can point at the line the viewer shows.
  //
  // Optional because `header` is persisted: rows stored before this
  // field existed come back without it, and a refresh re-parses them.
  // Consumers must treat a missing line as "no location", never as 0.
  line?: number;
}

export interface ParsedHeader {
  tags: HeaderTag[];
  // 1-based line of the `// ==UserScript==` marker. Where diagnostics
  // about a tag that ISN'T there point — `missing @name` has no line of
  // its own, and the top of the block is where the reader would add it.
  // Optional for the same persisted-row reason as `HeaderTag.line`.
  startLine?: number;
}

// Every line-terminator shape the metadata-block scanner recognizes.
// One definition so "which line is this tag on?" is counted by exactly
// the rule the block is split by — count and split disagreeing is how
// every header diagnostic in a DOS or classic-Mac file ends up one line
// off.
//
// Deliberately NOT the same set as `countLines` in composed-source.ts,
// which adds U+2028/U+2029 because V8 treats them as terminators. Those
// can't appear in a metadata line anyway (`TAG_LINE`'s `.` doesn't
// match them), and widening the split here would change what this
// long-standing parser considers a line.
const LINE_BREAK = /\r\n|\r|\n/;
const LINE_BREAK_G = /\r\n|\r|\n/g;

function countLineBreaks(text: string): number {
  return text.match(LINE_BREAK_G)?.length ?? 0;
}

const BLOCK_START = /^[ \t]*\/\/[ \t]*==UserScript==[ \t]*$/m;
const BLOCK_END = /^[ \t]*\/\/[ \t]*==\/UserScript==[ \t]*$/m;

// Strip a single leading UTF-8 BOM. Most fetch paths (`response.text()`,
// `TextDecoder`) drop it for us, but the page-context `file://` XHR path
// (`directories.ts`) hands back `xhr.responseText` with the BOM intact.
// Our `^//` boundary regexes won't match past a U+FEFF, so a BOM-prefixed
// script would be misread as having no metadata block. The BOM only ever
// appears at file position 0.
function stripLeadingBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

export type SplitError = 'no metadata block' | 'unterminated metadata block';

export interface SplitResult {
  leadingText: string; // anything before the `==UserScript==` line; '' when block starts at file top
  headerText: string;  // raw block including both markers; '' on error
  bodyText: string;    // everything after the closing marker; full source on error
  error?: SplitError;
  // 1-based line of the `// ==UserScript==` marker, when there is one.
  // Set even for `unterminated metadata block`, which is precisely the
  // error whose one useful place to point is the line that opened the
  // block that never closed. Absent for `no metadata block`.
  headerStartLine?: number;
}

// Split a userscript source into the (rare) text above the metadata
// block, the raw metadata block itself, and the body text.
//
// Failure modes:
//   - no `==UserScript==` line          → error: 'no metadata block'
//   - open marker but no matching close → error: 'unterminated metadata block'
// In both cases we return leadingText = '', headerText = '', and
// bodyText = the whole source so callers always have something to
// display.
export function splitHeaderBody(source: string): SplitResult {
  source = stripLeadingBom(source);
  const startMatch = BLOCK_START.exec(source);
  if (!startMatch) {
    return { leadingText: '', headerText: '', bodyText: source, error: 'no metadata block' };
  }
  const headerStartLine = countLineBreaks(source.slice(0, startMatch.index)) + 1;
  const afterStart = source.slice(startMatch.index + startMatch[0].length);
  const endMatch = BLOCK_END.exec(afterStart);
  if (!endMatch) {
    return {
      leadingText: '',
      headerText: '',
      bodyText: source,
      error: 'unterminated metadata block',
      headerStartLine,
    };
  }
  const blockEnd =
    startMatch.index + startMatch[0].length + endMatch.index + endMatch[0].length;
  // Skip a single trailing newline after the closing marker so bodyText
  // doesn't start with a stray blank line.
  let bodyStart = blockEnd;
  if (source[bodyStart] === '\r') bodyStart++;
  if (source[bodyStart] === '\n') bodyStart++;
  return {
    leadingText: source.slice(0, startMatch.index),
    headerText: source.slice(startMatch.index, blockEnd),
    bodyText: source.slice(bodyStart),
    headerStartLine,
  };
}

// One metadata line: `// @tag[:locale][ value]`. The value group is
// `.*\S` so trailing whitespace is excluded; the whole value group is
// optional so flag tags like `@noframes` parse with value = "".
const TAG_LINE = /^[ \t]*\/\/[ \t]*@([A-Za-z][\w-]*)(?::([\w-]+))?(?:[ \t]+(.*\S))?[ \t]*$/;

// Reassemble the original on-disk source from the three parts
// produced by `splitHeaderBody`. The reassembly is line-for-line
// faithful so that an error reported on injected line N also points
// at line N of this reconstructed string (which is what the viewer
// shows in the main tab).
//
// The `'\n'` between `headerText` and `bodyText` restores the line
// break `splitHeaderBody` skipped past the closing marker; with no
// metadata block, both `leadingText` and `headerText` are empty so
// the body is returned verbatim.
export function joinFullSource(
  leadingText: string,
  headerText: string,
  bodyText: string,
): string {
  if (!headerText) return leadingText + bodyText;
  return leadingText + headerText + '\n' + bodyText;
}

// Parse the metadata block. Returns null if there is no
// `==UserScript==` / `==/UserScript==` pair.
export function parseHeader(source: string): ParsedHeader | null {
  source = stripLeadingBom(source);
  const startMatch = BLOCK_START.exec(source);
  if (!startMatch) return null;
  const afterStart = source.slice(startMatch.index + startMatch[0].length);
  const endMatch = BLOCK_END.exec(afterStart);
  if (!endMatch) return null;
  const block = afterStart.slice(0, endMatch.index);
  const startLine = countLineBreaks(source.slice(0, startMatch.index)) + 1;

  const tags: HeaderTag[] = [];
  // Split on every line-terminator shape — `\r\n` (DOS), `\n` (Unix),
  // and bare `\r` (classic Mac). `splitHeaderBody`'s boundary regex
  // already handles all three via the `/m` flag, so we keep parity here.
  //
  // `block` begins with the terminator that ended the `==UserScript==`
  // line, so element 0 is always the empty remainder of that line and
  // element i is `startLine + i` — no off-by-one correction needed.
  for (const [i, rawLine] of block.split(LINE_BREAK).entries()) {
    const m = TAG_LINE.exec(rawLine);
    if (!m) continue;
    const [, tag, locale, value] = m;
    const entry: HeaderTag = {
      tag: tag.toLowerCase(),
      value: value ?? '',
      line: startLine + i,
    };
    if (locale) entry.locale = locale;
    tags.push(entry);
  }
  return { tags, startLine };
}

// First non-localized value for `tag`, or undefined.
export function getValue(header: ParsedHeader, tag: string): string | undefined {
  const t = tag.toLowerCase();
  for (const e of header.tags) {
    if (e.tag === t && e.locale === undefined) return e.value;
  }
  return undefined;
}

// All non-localized values for `tag`, in source order.
export function getValues(header: ParsedHeader, tag: string): string[] {
  const t = tag.toLowerCase();
  const out: string[] = [];
  for (const e of header.tags) {
    if (e.tag === t && e.locale === undefined) out.push(e.value);
  }
  return out;
}

// Map of locale → value for tags like `@name:de`. Excludes the
// unlocalized form.
export function getLocalized(header: ParsedHeader, tag: string): Record<string, string> {
  const t = tag.toLowerCase();
  const out: Record<string, string> = {};
  for (const e of header.tags) {
    if (e.tag === t && e.locale !== undefined) out[e.locale] = e.value;
  }
  return out;
}

// True if the tag appears at all (useful for flag-style tags like
// `@noframes` or `@unwrap`).
export function hasTag(header: ParsedHeader, tag: string): boolean {
  const t = tag.toLowerCase();
  return header.tags.some((e) => e.tag === t);
}
