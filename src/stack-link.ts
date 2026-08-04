// Pure helpers used by the userscript viewer to turn stack-trace
// references into clickable, readable links: `parseStackRefs` finds
// them, `displayRefText` decides how they read.
//
// References look like
//   sourcemonkey://<scriptId>/<file>:<line>:<col>
//   https://cdn.example.com/jquery.js?v=3:97:11
// inside the Log tab's entries into clickable links that jump to
// the matching code tab.
//
// We extract any URL with a recognized scheme followed by `:L:C`.
// The caller filters by matching the URL against tabs it has open;
// refs whose URL doesn't match render as plain text. That keeps the
// parser ignorant of script identity — the same code linkifies both
// main-body refs (`sourcemonkey://<id>/<name>.user.js`) and
// `@require` refs (their real CDN URLs, query string and all).

import { decodeForDisplay } from './script-display.js';
import { ROOT } from './script-source-url.js';

export type RefRun =
  | { kind: 'text'; text: string }
  | {
      kind: 'ref';
      text: string;
      // The URL portion of the ref, without the trailing `:line:col`.
      // Used to look up the target tab by matching against
      // `Tab.sourceUrl` / `Tab.fileUrl`.
      url: string;
      line: number;
      col: number;
    };

// Find every `<scheme>://…:<line>:<col>` ref in `text` and return
// runs the caller can paint as text or anchors. Recognized schemes:
// `sourcemonkey`, `http`, `https`, `file`. The URL portion may
// contain anything except whitespace and parens (V8's named-frame
// shape is `at fn (URL:L:C)` — without excluding parens the trailing
// `)` would greedily attach to the URL).
//
// Query strings and fragments work fine — they live in the URL part
// and only the final `:digits:digits` is split off. Port numbers in
// the authority are also fine for the same reason: the path comes
// after the port, so the final `:L:C` is always the line:col.
//
// IPv6 hosts in `[…]` brackets would parse OK because the brackets
// don't contain `:digits:digits` at the end — not currently exercised
// but worth noting if it ever comes up.
export function parseStackRefs(text: string): RefRun[] {
  if (!text) return [];
  // Greedy `[^\s()]+` plus `:(\d+):(\d+)` at the end — the engine
  // backtracks so the FINAL `:digits:digits` becomes line:col even
  // when the URL contains its own `:digit` runs (port numbers in the
  // authority, etc.).
  const re = /(?:sourcemonkey|https?|file):\/\/[^\s()]+:(\d+):(\d+)/g;
  const runs: RefRun[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      runs.push({ kind: 'text', text: text.slice(lastIndex, m.index) });
    }
    // Split off the trailing `:line:col` to recover the bare URL.
    const full = m[0];
    const line = parseInt(m[1], 10);
    const col = parseInt(m[2], 10);
    const url = full.slice(0, full.length - (m[1].length + m[2].length + 2));
    runs.push({ kind: 'ref', text: full, url, line, col });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return runs;
}

// Text to paint for a ref, as opposed to the URL used to find its tab.
//
// `script-source-url.ts` percent-encodes the script's log label into
// `//# sourceURL=` — a bare `#` would start a fragment and a space or
// paren would end the run `parseStackRefs` matches — so a second
// `foo.user.js` arrives as `foo%232`. Right on the wire, unreadable in
// the log. Decoding here is the viewer's usual display-decodes /
// functional-stays-encoded split (docs/names-and-paths.md).
//
// **Only our own URLs decode**, and the reason is not that decoding
// them is unsafe elsewhere — `displayLocation` decodes any absolute
// URL and accepts the same `%2F`-reads-as-`/` ambiguity. It is that a
// stack ref is a *coordinate*, not a name: the user compares it
// against devtools, pastes it into a Sources-panel search, or matches
// it to a `@require` line, and all of those want the bytes that were
// actually in the URL. Our own synthetic URLs are the exception
// because their encoding is an artifact we introduced, not part of any
// address the user could go look up.
//
// Matched against the full `sourcemonkey://SourceMonkey` prefix rather
// than the scheme: the scheme is unregistered and a hostile script can
// put `sourcemonkey://elsewhere/…` in its own log message.
export function displayRefText(text: string, url: string): string {
  return url.startsWith(`${ROOT}/`) ? decodeForDisplay(text) : text;
}
