// Where a diagnostic came from, and the one way to say it.
//
// SourceMonkey judges a script from its content in several places — the
// metadata-block split, header validation, `@require` / `@resource`
// resolution, the install-time parse check — and every one of those
// verdicts is *about* a specific line of a specific file. This module
// is the shared vocabulary for that: a location shape the producers
// attach, and a label the surfaces render.
//
// Deliberately tiny and dependency-free. It is imported by the service
// worker, by extension pages, and by the wire protocol module, so it
// must stay cheap enough that none of them think twice about it.

// A place in one of the files that make up a script: the script's own
// source, or one of its `@require` bodies.
//
// `file` is the same identity the source map uses (`MappedSegment.url`)
// — the script's `relativePath` for its own body, the resolved URL for
// a `@require`. It is what the viewer matches against its tabs, so it
// must not be swapped for a prettier display string.
//
// `line` and `column` are 1-based and independently optional, because
// the producers genuinely differ in how much they know:
//   - the parse check has both (V8 reports them)
//   - a header diagnostic has a line and no meaningful column
//   - a missing metadata block has neither — the whole file is the answer
export interface DiagnosticLocation {
  file: string;
  line?: number;
  column?: number;
}

// The human-readable "where", without the surrounding phrasing —
// e.g. `my.user.js, line 12, column 5`.
//
// Split out from `describeDiagnostic` on purpose: it is the part a UI
// turns into a link, so having it as its own function keeps the linked
// text and the plain-text rendering from drifting into two spellings of
// the same place.
export function locationLabel(location: DiagnosticLocation): string {
  let label = location.file;
  // Column without line is meaningless, so it is only ever appended
  // inside the line branch.
  if (location.line !== undefined) {
    label += `, line ${location.line}`;
    if (location.column !== undefined) label += `, column ${location.column}`;
  }
  return label;
}

// `<message> (in <where>)`, or just the message when there's nowhere to
// point. The single phrasing shared by the store's `invalid` message,
// the install preview's warning, the sources page's hover text and the
// Log — so the same verdict can never read two different ways.
export function describeDiagnostic(
  message: string,
  location: DiagnosticLocation | undefined,
): string {
  if (!location) return message;
  return `${message} (in ${locationLabel(location)})`;
}

// A location is only useful if it names a file, and a line of 0 or less
// is not a line. Producers build these from parsed source and from data
// that crossed a `postMessage` boundary, and consumers turn them into
// clickable jumps, so the shape is checked once here rather than at
// each of those.
export function validLocation(
  location: DiagnosticLocation | undefined,
): DiagnosticLocation | undefined {
  if (!location || typeof location.file !== 'string' || !location.file) return undefined;
  const line = positiveInt(location.line);
  if (location.line !== undefined && line === undefined) return undefined;
  const column = positiveInt(location.column);
  const out: DiagnosticLocation = { file: location.file };
  if (line !== undefined) out.line = line;
  // A bad column is dropped rather than failing the whole location: the
  // line is the part that gets the reader to the right place, and the
  // column is an accent on top of it.
  if (line !== undefined && column !== undefined) out.column = column;
  return out;
}

function positiveInt(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}
