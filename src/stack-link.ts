// Pure helpers used by the userscript viewer to turn stack-trace
// references like
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
