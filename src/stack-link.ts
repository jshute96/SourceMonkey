// Pure helpers used by the userscript viewer to turn stack-trace
// references like
//   sourcemonkey://<scriptId>/<file>:<line>:<col>
// inside the Log tab's entries into clickable links that jump to
// the matching code tab.
//
// We don't try to be clever — we trust the URL the engine reported.
// The viewer picks a tab by matching the URL to each tab's
// expected `//# sourceURL=` form (`buildSourceUrl`); the line/col
// pair is used as-is. Stack frames with non-matching URLs (or
// URLs from a different script id) render as plain text.

export type RefRun =
  | { kind: 'text'; text: string }
  | {
      kind: 'ref';
      text: string;
      // The `sourcemonkey://<scriptId>/<file>` portion of the ref,
      // without the trailing `:line:col`. Used to look up the
      // target tab by matching against `Tab.sourceUrl`.
      url: string;
      line: number;
      col: number;
    };

// Find every `sourcemonkey://<scriptId>/<file>:<line>:<col>` ref in
// `text` and return runs the caller can paint as text or anchors.
// Filtering by `scriptId` (the UUID portion) means a stack frame
// that somehow names a sibling script's id can't be linkified here.
export function parseStackRefs(text: string, scriptId: string): RefRun[] {
  if (!scriptId) return text ? [{ kind: 'text', text }] : [];
  const prefix = `sourcemonkey://${scriptId}/`;
  // URL portion: prefix + non-whitespace/non-colon/non-paren
  // filename. Parens are excluded because V8's named-frame shape is
  // `at fn (URL:L:C)` — without that the trailing `)` greedily
  // attaches to the URL. `buildSourceUrl` sanitizes the filename so
  // it never legitimately contains `(` or `)`.
  const re = new RegExp(
    '(' + escapeRegex(prefix) + '[^\\s:()]+):(\\d+):(\\d+)',
    'g',
  );
  const runs: RefRun[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      runs.push({ kind: 'text', text: text.slice(lastIndex, m.index) });
    }
    runs.push({
      kind: 'ref',
      text: m[0],
      url: m[1],
      line: parseInt(m[2], 10),
      col: parseInt(m[3], 10),
    });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return runs;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
