// ---------- Concatenated user source (requires + body) ----------
//
// Every prefetched `@require` body, in declaration order, in front of
// the **full on-disk script source** (leadingText + headerText +
// bodyText). This is the single arrangement every run path uses:
//
//   - the default registration (`wrapCombinedEntry` → one js[] entry);
//   - the reload-fast-path swap eval (`buildSwapEvalBody`), where
//     `handleCheckPending` in background.ts sends the same text as the
//     run-new body.
//
// Concatenation IS the feature, not an implementation detail: one
// script means one lexical scope, so a library's top-level
// `const`/`let`/`class` is simply visible to the main body — the same
// thing TM/VM get by concatenating into one IIFE. See
// docs/injection-modes.md for what the separate-entries arrangement
// cost us instead.
//
// A `;\n` separator between segments guards the seam against ASI
// (Automatic Semicolon Insertion). ASI won't fire when the next line
// could continue the previous statement, so a library ending in an
// expression followed by a body opening with `(`, `[`, `` ` ``, `+`,
// `-` or `/` would parse as a single statement. Each file was fine on
// its own; concatenation is what creates the hazard.
//
// The leading `// @require <url>` per require makes the concatenated
// code easier to scan when no source map is applied. Line comment (not
// block) so URLs with `*/` in their path don't prematurely close it.
//
// ---------- Why this lives in its own module ----------
//
// Several callers need to agree on the layout, and they live in
// different extension contexts:
//
//   - `src/injector.ts` (service worker) emits the registered entry
//     and its source map.
//   - `background.ts`'s swap path emits the same text for `(0,eval)`.
//   - `src/userscript.ts` (the viewer page) re-derives the SAME
//     segment list to map `Error.stack` line numbers in the Log tab
//     back to the original file — V8 leaves `err.stack` in generated
//     coordinates even when it has the map. See docs/script-log.md.
//
// The viewer recomputes rather than reading a persisted map because
// the inputs are already on the `StoredScript` row it has loaded, and
// a persisted copy would be one more thing to invalidate. Sharing this
// one function is what keeps "where line N came from" a single answer
// instead of two that can drift.

import { joinFullSource } from './userscript-header.js';
import type { StoredScript } from './script-store.js';
import type { MappedSegment } from './source-map.js';
import { buildRequireSourceUrl, buildSourceUrl } from './script-source-url.js';

// Where each original file's text lands in the concatenated output.
// `opts.requireUrls[i]` is the synthetic devtools URL for
// `requires[i]` and `opts.mainUrl` the one for the body; callers that
// only want the text (the swap-eval path) omit both.
export interface ComposedSource {
  text: string;
  // Line-level provenance, ready for src/source-map.ts. Empty when
  // there are no requires, and also whenever the caller omitted the
  // URLs (nothing to attribute lines to).
  segments: MappedSegment[];
  lineCount: number;
}

export interface ComposeOptions {
  requireUrls?: readonly string[];
  mainUrl?: string;
  startLine?: number;
}

// ---------- The two layouts, and why the viewer can tell them apart ----------
//
// **With `@require`s.** The preamble (GM bindings, prelude, wrap head)
// occupies generated line 0 on its own and the concatenated user
// source starts at `USER_SOURCE_START_LINE`. Line numbers shift, so
// the entry carries a source map and the viewer remaps stack refs
// through the segment list.
//
// **Without `@require`s.** Nothing is concatenated, so nothing may
// shift: the body's first line SHARES generated line 0 with the
// preamble, making generated line N equal original line N. No map is
// emitted and the viewer passes refs through untouched.
//
// The viewer distinguishes the two by whether there are segments at
// all — `composeSource` returns none for a script without requires —
// so it never has to know which run path produced the code. That only
// holds while `wrapCombinedEntry` and `buildSwapEvalBody` agree on
// BOTH layouts. They are the only two producers; keep them in step.
//
// The no-require layout costs one thing, deliberately: the body's
// first line shares a physical line with the preamble, so a frame
// reported at line 1 carries a column offset by the preamble's length.
// Line 1 of a userscript is its `// ==UserScript==` marker, so this
// has never been observed; the code view suppresses the column accent
// there rather than showing a wrong one.
export const USER_SOURCE_START_LINE = 1;

export function composeSource(
  script: StoredScript,
  opts: ComposeOptions = {},
): ComposedSource {
  const mainSource = joinFullSource(
    script.leadingText ?? '',
    script.headerText ?? '',
    script.bodyText,
  );
  const requires = script.requires ?? [];
  const startLine = opts.startLine ?? 0;
  if (requires.length === 0) {
    return {
      text: mainSource,
      segments: [],
      lineCount: countLines(mainSource),
    };
  }

  // Build the text incrementally and derive every line number from
  // what has ACTUALLY been emitted, rather than adding up expected
  // line counts alongside a `join()`. The two drift: a require whose
  // source ends in a lone `\r` fuses with a joining `\n` into a single
  // CRLF, so one terminator appears where the arithmetic assumed two
  // and every mapping from that seam onward — including the whole user
  // body — shifts by a line. CR-only line endings are exactly the
  // population `\r` is in `LINE_TERMINATORS` for, and nothing
  // normalizes newlines on the way in (file-loader stores the decoded
  // bytes verbatim).
  const segments: MappedSegment[] = [];
  let text = '';
  // 0-based generated line that the NEXT character appended will land
  // on. `countLines('')` is 1, so an empty buffer is line 0.
  const nextLine = (): number => startLine + countLines(text) - 1;

  for (const [i, r] of requires.entries()) {
    text += `// @require ${r.url}\n`;
    const url = opts.requireUrls?.[i];
    if (url) {
      segments.push({
        url,
        content: r.source,
        generatedLine: nextLine(),
        lineCount: countLines(r.source),
      });
    }
    // The trailing-`\r` guard: append the extra `\n` here so the
    // source's own last line stays a line of its own, instead of being
    // swallowed by the separator that follows.
    text += r.source.endsWith('\r') ? `${r.source}\n` : r.source;
    // Terminate the source's last line, then the `;` seam guard on a
    // line of its own.
    text += '\n;\n';
  }
  if (opts.mainUrl) {
    segments.push({
      url: opts.mainUrl,
      content: mainSource,
      generatedLine: nextLine(),
      lineCount: countLines(mainSource),
    });
  }
  text += mainSource;

  return { text, segments, lineCount: countLines(text) };
}

// ---------- The layout stack traces need ----------
//
// What it takes to map an `Error.stack` frame from the injected entry
// back to its file: the sourceURL V8 stamps on every frame of that
// entry, and the segment list for it. Built from the stored script and
// its log label alone, so every reader of stacks derives the same
// answer as the injector without seeing the injected code: the
// viewer's Log tab, sm-dev's output, and the service worker's test
// surface (which sm-dev's runs read it through).
//
// No segments when the script has no `@require`s: then nothing moved,
// and frames already name the right line. See
// `remapStackRef` / `remapStackText`.
//
// `lineCount` is the user program's lines (requires + body): a frame
// past it is on our wrap's closing line, not the user's.
export interface StackLayout {
  entryUrl: string;
  segments: readonly MappedSegment[];
  lineCount: number;
}

export function stackLayout(script: StoredScript, logLabel: string): StackLayout {
  const entryUrl = buildSourceUrl(logLabel);
  const { segments, lineCount } = composeSource(script, {
    requireUrls: (script.requires ?? []).map((r) => buildRequireSourceUrl(logLabel, r.url)),
    mainUrl: entryUrl,
    startLine: USER_SOURCE_START_LINE,
  });
  return { entryUrl, segments, lineCount };
}

// Count lines the way V8 does, which is what the source map has to
// agree with. Counting only `\n` silently shifts every mapping after
// the offending character:
//
//   - a lone `\r` is a line terminator (files with mangled endings);
//   - so are U+2028 / U+2029, and V8 counts a RAW U+2028 as a break
//     even inside a string literal (legal since ES2019, and minified
//     CDN bundles do embed them).
//
// `\r\n` must count as one, hence the alternation order.
const LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/g;

// `buildParseCheckSource` below measures its own preamble with it: a
// parse-check line offset that counted terminators differently from the
// segment list it is compared against would misattribute every error in
// the file.
function countLines(text: string): number {
  if (text === '') return 1;
  const matches = text.match(LINE_TERMINATORS);
  return matches ? matches.length + 1 : 1;
}

// Public entry point for the swap-eval path, which needs the text only.
export function composeRequiredBody(script: StoredScript): string {
  return composeSource(script).text;
}

// The user program exactly as the registered entry compiles it: every
// `@require` body then the script's own source, as one function body —
// i.e. everything a syntax error in user-supplied code could come from,
// in the kind of scope it actually lands in. This is what
// `src/parse-check.ts` hands to `new Function`.
//
// Our own declarations (the wrap head, its `var` preamble, the GM
// bindings and prelude) are NOT included, and need not be: the user
// program runs in a nested scope of its own (`USER_SCOPE_OPEN` in
// injector.ts), so nothing it declares can clash with them. That nested
// scope is a function body, as `new Function`'s is, so a top-level
// `return` is judged as it will run, and a leading `"use strict"`
// applies to the whole program, as there.
//
// Returns provenance alongside the text. A syntax error is reported as
// a line in the COMPOSED program, which is not a line of any file the
// user has open — `segments` is what maps it back, using the same
// machinery the source map and the Log tab's stack refs already share.
// See src/parse-location.ts.
export interface ParseCheckSource {
  text: string;
  // Which original file each generated line came from. `url` here is
  // the require's real URL (or the script's path) rather than a
  // synthetic `sourcemonkey://` one: this list is read by us, to name
  // a file in a sentence, not by devtools.
  segments: MappedSegment[];
  // Lines in `text`. A reported position outside it isn't the user's
  // code — see the sentinel note in parse-sandbox.ts.
  lineCount: number;
}

export function buildParseCheckSource(script: StoredScript): ParseCheckSource {
  // A blank first line of our own, so the user's first line is never at
  // offset 0: a `#!` hashbang is legal only there, so it stays the
  // syntax error it also is in the real injected entry (which wraps the
  // source), and the location probes can't be handed a source that
  // parses as a shebang script. Blank, not a statement, so a leading
  // `"use strict"` still applies, as in the injected entry (see
  // USER_SCOPE_OPEN in injector.ts). The offset below is derived from it rather than
  // assumed to be 1 — the same discipline `composeSource` applies
  // internally, and for the same reason: assumed line counts drift
  // from emitted ones.
  const preamble = '\n';
  const startLine = countLines(preamble) - 1;
  const requires = script.requires ?? [];
  const composed = composeSource(script, {
    requireUrls: requires.map((r) => r.url),
    mainUrl: script.relativePath,
    startLine,
  });
  return {
    text: preamble + composed.text,
    // `composeSource` emits no segments for a script with no
    // `@require`s — the viewer keys "pass stack refs through unmapped"
    // off exactly that, so it stays as it is. Here the opposite is
    // wanted: one segment for the body means every reported line
    // resolves through the same lookup, with no second code path for
    // the majority of scripts.
    segments: composed.segments.length > 0
      ? composed.segments
      : [{
          url: script.relativePath,
          content: composed.text,
          generatedLine: startLine,
          lineCount: composed.lineCount,
        }],
    lineCount: startLine + composed.lineCount,
  };
}
