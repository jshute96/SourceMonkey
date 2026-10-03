// Pure helpers for the userscript viewer's URL-fragment navigation.
//
// The viewer keeps the current tab + highlight reflected in
// `location.hash` so a URL can be copied / shared / reopened and
// land in the same place. Empty hash → main script, no highlight.
//
// Fragment grammar:
//   <empty>                    main script tab, no highlight
//   Log                        the Log tab
//   <filename>                 tab whose `label` matches `filename`
//   <filename>:<line>          tab + highlighted line
//   <filename>:<line>:<col>    tab + highlighted line + column accent

export type ParsedHash =
  | { kind: 'empty' }
  | { kind: 'log' }
  | { kind: 'code'; filename: string; line?: number; col?: number };

export function parseHash(rawHash: string): ParsedHash {
  let hash = rawHash;
  if (hash.startsWith('#')) hash = hash.slice(1);
  if (!hash) return { kind: 'empty' };
  if (hash === 'Log') return { kind: 'log' };
  const parts = hash.split(':');
  let filename: string;
  try {
    filename = decodeURIComponent(parts[0]);
  } catch {
    // Malformed %-escape — keep the raw form rather than throwing.
    filename = parts[0];
  }
  const out: ParsedHash = { kind: 'code', filename };
  if (parts.length > 1) {
    const n = parseInt(parts[1], 10);
    if (Number.isFinite(n) && n > 0) out.line = n;
  }
  if (parts.length > 2 && out.line !== undefined) {
    const n = parseInt(parts[2], 10);
    if (Number.isFinite(n) && n > 0) out.col = n;
  }
  return out;
}

// Build a hash fragment from the current viewer state. Returns the
// string WITHOUT a leading "#" — empty string means "no fragment"
// (main-script-no-highlight is the default landing).
export function buildHash(args: {
  tab: 'log' | 'main' | 'require';
  filename?: string;
  line?: number;
  col?: number;
}): string {
  if (args.tab === 'log') return 'Log';
  // Default landing: main tab, no highlight, no fragment.
  if (args.tab === 'main' && args.line === undefined) return '';
  if (!args.filename) return '';
  let h = encodeURIComponent(args.filename);
  if (args.line !== undefined) {
    h += ':' + args.line;
    if (args.col !== undefined) h += ':' + args.col;
  }
  return h;
}
