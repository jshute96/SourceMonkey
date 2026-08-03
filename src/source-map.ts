// Minimal Source Map v3 generator for the concatenated injection entry.
//
// Why: in Mode A (see docs/injection-modes.md) a script's `@require`
// bodies and its own body are concatenated into ONE `js[]` entry so
// they share a lexical scope. That's what makes a library's top-level
// `const`/`class` visible to the main body, exactly as in TM/VM — but
// it also means the main body's line N no longer lands at physical
// line N, and every require loses the devtools file it used to have.
//
// A source map buys both back: devtools splits the single generated
// script into the original files and reports original line numbers.
//
// Scope of this generator:
//
//   - **Line-level only.** One mapping per generated line, always at
//     column 0. We never move code within a line, so column fidelity
//     would be busywork; line granularity is what stack traces and
//     breakpoints need.
//   - **`sourcesContent` is always embedded.** Our sources are
//     synthetic `sourcemonkey://…` URLs, which devtools cannot fetch,
//     so embedding the text is the only way the mapped files are
//     viewable. It is also the expensive part: the sources ship a
//     second time, base64'd, so the entry grows by ~1.6× their size.
//
//     There is deliberately no size cap on this. The only constraint
//     that actually binds is whether `chrome.userScripts.register()`
//     accepts the payload, and that failure is already visible:
//     `registerWithFallback` in src/injector.ts drops from batch to
//     per-script registration on rejection and records the reason in
//     `perScriptErrors`, so an oversized script fails loudly and by
//     name. A preemptive cap would trade that for silently degrading
//     the feature the map exists to provide. The map does NOT touch
//     our `chrome.storage.local` quota — it's generated at
//     registration time from sources already stored.
//
// What V8 does NOT do for us: map `Error.stack` *strings*. It maps
// source positions for the devtools UI, but `err.stack` keeps
// generated coordinates, and SourceMonkey parses those strings for the
// viewer's Log tab (src/stack-link.ts). `remapStackRef` below is the
// other half — the Log tab applies the same segment list itself, so a
// logged frame names the same file and line devtools shows. See
// docs/script-log.md#stack-refs.

// Base64 VLQ, per the Source Map v3 spec.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Domain: |value| < 2^30. Above that the `<< 1` wraps negative and the
// loop emits a single wrong digit. Every caller here passes a line or
// source index, so this is unreachable — noted so nobody reuses the
// function for byte offsets.
export function encodeVlq(value: number): string {
  // Sign goes in the low bit, magnitude above it.
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = vlq & 0b11111;
    vlq >>>= 5;
    // Continuation bit: more 5-bit groups follow.
    if (vlq > 0) digit |= 0b100000;
    out += B64[digit];
  } while (vlq > 0);
  return out;
}

// One original file's contribution to the generated entry.
export interface MappedSegment {
  // Source URL as devtools should show it (a synthetic
  // `sourcemonkey://…` URL — see src/script-source-url.ts).
  url: string;
  // Full text of that original file, embedded via `sourcesContent`.
  content: string;
  // 0-based generated line that this file's line 0 lands on.
  generatedLine: number;
  // How many of this file's lines are mapped.
  lineCount: number;
}

export interface SourceMapV3 {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: string[];
  names: never[];
  mappings: string;
}

// Build the map object. `totalLines` is the generated entry's line
// count; generated lines not covered by any segment (the wrap's head
// and tail, the `;` separators) get an empty group, which devtools
// reads as "no original position" and leaves attributed to the
// generated file.
//
// `file` is deliberately the same URL as the entry's own
// `//# sourceURL=`, which is also `sources[last]` (the script's own
// body). Bundlers avoid that collision — devtools keys files by URL,
// so a mapped source sharing its generated script's URL could in
// principle show up twice, or empty. Verified in Chrome's Sources
// panel that it doesn't: the mapped file shadows the generated one,
// and a script with one `@require` shows exactly two entries — the
// `.user.js` and the require nested under a `<host>/<path>` subtree —
// both with their original text. Keeping the URLs identical is what
// lets the Log tab's stack-ref linkification match on one string.
export function buildSourceMap(args: {
  file: string;
  segments: readonly MappedSegment[];
  totalLines: number;
}): SourceMapV3 {
  const sources = args.segments.map((s) => s.url);

  // generatedLine → {sourceIndex, originalLine}. Later segments win on
  // overlap, which can't happen for the layouts we generate but keeps
  // the function total.
  const perLine = new Map<number, { srcIdx: number; origLine: number }>();
  args.segments.forEach((seg, srcIdx) => {
    for (let k = 0; k < seg.lineCount; k++) {
      perLine.set(seg.generatedLine + k, { srcIdx, origLine: k });
    }
  });

  // VLQ fields after the first are deltas against the previous
  // segment, carried across line groups (only the generated column
  // resets per line — and ours is always 0, so it never contributes).
  let prevSrcIdx = 0;
  let prevOrigLine = 0;
  const groups: string[] = [];
  for (let gen = 0; gen < args.totalLines; gen++) {
    const hit = perLine.get(gen);
    if (!hit) {
      groups.push('');
      continue;
    }
    groups.push(
      encodeVlq(0) +
        encodeVlq(hit.srcIdx - prevSrcIdx) +
        encodeVlq(hit.origLine - prevOrigLine) +
        encodeVlq(0),
    );
    prevSrcIdx = hit.srcIdx;
    prevOrigLine = hit.origLine;
  }

  return {
    version: 3,
    file: args.file,
    sources,
    sourcesContent: args.segments.map((seg) => seg.content),
    names: [],
    mappings: groups.join(';'),
  };
}

// ---------- Reverse direction: generated position → original ----------
//
// The same segment list that builds the map also answers "which file
// was generated line N?", which is what the viewer's Log tab needs.
// Both live here so the two directions can't disagree about the
// coordinate conventions:
//
//   - `MappedSegment.generatedLine` and the per-file offsets inside a
//     segment are 0-BASED (the source-map wire format's convention).
//   - Everything a *user* sees — stack-trace refs, the code view's
//     gutter — is 1-BASED. The conversion happens here, once.

// Which original file a generated line came from, 1-based.
export interface OriginalPosition {
  url: string;
  line: number;
}

// Look up the original file + line for a 1-based generated line.
// Returns null for lines no segment covers: the wrap head on line 0,
// the `;` ASI guards between requires, and the closing `});`. Those
// are ours, not the user's, so leaving them unmapped is correct —
// callers render them as-is rather than guessing at a neighbor.
export function lookupGeneratedLine(
  segments: readonly MappedSegment[],
  generatedLine: number,
): OriginalPosition | null {
  const gen0 = generatedLine - 1;
  for (const seg of segments) {
    if (gen0 >= seg.generatedLine && gen0 < seg.generatedLine + seg.lineCount) {
      return { url: seg.url, line: gen0 - seg.generatedLine + 1 };
    }
  }
  return null;
}

// One `<url>:<line>:<col>` stack reference, as `parseStackRefs`
// produces them. Declared structurally rather than imported from
// stack-link.ts so this module stays a leaf.
export interface StackRef {
  url: string;
  line: number;
  col: number;
}

// Rewrite a stack ref that points into the concatenated entry so it
// names the original `@require` (or the body) at its own line.
//
// Every frame from the combined entry carries `entryUrl` — the
// script's own `//# sourceURL=`, which V8 stamps on the whole entry
// regardless of which concatenated file the code came from. So the
// URL match is the test for "is this frame ours to remap"; refs to
// anything else (the page, another userscript, `__prelude.js`) pass
// through untouched.
//
// Columns pass through unchanged, and that is exact rather than
// approximate: composition only ever moves whole lines, never code
// within a line. The one exception is a script with NO requires, where
// the body's first line shares generated line 1 with the wrap head —
// but that case has no segments at all, so it returns early and never
// reaches the column question.
export function remapStackRef(
  ref: StackRef,
  entryUrl: string,
  segments: readonly MappedSegment[],
): StackRef | null {
  if (segments.length === 0) return null;
  if (ref.url !== entryUrl) return null;
  const orig = lookupGeneratedLine(segments, ref.line);
  if (!orig) return null;
  return { url: orig.url, line: orig.line, col: ref.col };
}

// UTF-8 → base64. `btoa` alone throws on any code point above U+00FF,
// and userscripts are full of them (the script that prompted Mode A is
// half Chinese). Encode to bytes first, then base64 the byte string.
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked so a large source doesn't blow the argument limit on
  // String.fromCharCode.apply.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// The `//# sourceMappingURL=` line to append to the generated entry.
// Inline data URI because a `sourcemonkey://` map URL would be no more
// fetchable than the sources themselves.
export function inlineSourceMapComment(map: SourceMapV3): string {
  return `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64Utf8(JSON.stringify(map))}`;
}
