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
}

export interface ParsedHeader {
  tags: HeaderTag[];
}

const BLOCK_START = /^[ \t]*\/\/[ \t]*==UserScript==[ \t]*$/m;
const BLOCK_END = /^[ \t]*\/\/[ \t]*==\/UserScript==[ \t]*$/m;

export type SplitError = 'no metadata block' | 'unterminated metadata block';

export interface SplitResult {
  leadingText: string; // anything before the `==UserScript==` line; '' when block starts at file top
  headerText: string;  // raw block including both markers; '' on error
  bodyText: string;    // everything after the closing marker; full source on error
  error?: SplitError;
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
  const startMatch = BLOCK_START.exec(source);
  if (!startMatch) {
    return { leadingText: '', headerText: '', bodyText: source, error: 'no metadata block' };
  }
  const afterStart = source.slice(startMatch.index + startMatch[0].length);
  const endMatch = BLOCK_END.exec(afterStart);
  if (!endMatch) {
    return {
      leadingText: '',
      headerText: '',
      bodyText: source,
      error: 'unterminated metadata block',
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
  };
}

// One metadata line: `// @tag[:locale][ value]`. The value group is
// `.*\S` so trailing whitespace is excluded; the whole value group is
// optional so flag tags like `@noframes` parse with value = "".
const TAG_LINE = /^[ \t]*\/\/[ \t]*@([A-Za-z][\w-]*)(?::([\w-]+))?(?:[ \t]+(.*\S))?[ \t]*$/;

// Parse the metadata block. Returns null if there is no
// `==UserScript==` / `==/UserScript==` pair.
export function parseHeader(source: string): ParsedHeader | null {
  const startMatch = BLOCK_START.exec(source);
  if (!startMatch) return null;
  const afterStart = source.slice(startMatch.index + startMatch[0].length);
  const endMatch = BLOCK_END.exec(afterStart);
  if (!endMatch) return null;
  const block = afterStart.slice(0, endMatch.index);

  const tags: HeaderTag[] = [];
  // Split on every line-terminator shape — `\r\n` (DOS), `\n` (Unix),
  // and bare `\r` (classic Mac). `splitHeaderBody`'s boundary regex
  // already handles all three via the `/m` flag, so we keep parity here.
  for (const rawLine of block.split(/\r\n|\r|\n/)) {
    const m = TAG_LINE.exec(rawLine);
    if (!m) continue;
    const [, tag, locale, value] = m;
    const entry: HeaderTag = { tag: tag.toLowerCase(), value: value ?? '' };
    if (locale) entry.locale = locale;
    tags.push(entry);
  }
  return { tags };
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
