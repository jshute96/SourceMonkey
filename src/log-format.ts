// Formatting for the per-script event log.
//
// Two consumers, one set of strings:
//   - the viewer's Log pane table (Time / Level / Source / Message)
//   - the CSV the pane's Save and Copy buttons hand out
//
// Keeping both here is what makes an exported row read the same as the
// row on screen: the timestamp spelling and the `tab 17 ·
// script-wrapper` source label are written once.
//
// The Message column is the exception, and deliberately so. A message
// carrying a stack trace only becomes readable after its refs are
// mapped back through the injected entry's source map — which needs
// the viewer's tabs and the script's current layout, neither of which
// belongs in a pure module. So `formatLogCsv` takes the renderer as an
// argument: the viewer passes the one behind its own table, and the
// default here is the honest fallback for a caller that has no source
// map to consult.
//
// Pure and dependency-light so unit tests can drive it directly.

import { describeDiagnostic } from './diagnostic-location.js';
import { logIdDupeSuffix } from './script-display.js';
import type { LogEntry } from './script-log.js';

// Local wall-clock time, sortable spelling: `2026-08-05 14:03:22.017`.
// Not ISO/UTC — the reader is looking at their own machine's log and
// correlating it with what they just saw happen in a tab.
export function formatLogTimestamp(ms: number): string {
  const d = new Date(ms);
  const yyyy = String(d.getFullYear());
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}.${mmm}`;
}

// The Source cell: `tab 17 · script-wrapper` for anything that came
// from injected code in a specific tab, the bare label otherwise.
export function formatLogSource(entry: LogEntry): string {
  return entry.tabId !== undefined ? `tab ${entry.tabId} · ${entry.source}` : entry.source;
}

// The Message cell as plain text, with a derived location flattened
// into the same sentence the pane renders as a link.
//
// Correct for every entry SourceMonkey wrote about a script, and wrong
// only for the stack refs inside an entry the script itself produced —
// see the note at the top of the file, and `logMessageText` in
// `userscript.ts` for the renderer that handles those.
export function formatLogMessage(entry: LogEntry): string {
  return describeDiagnostic(entry.message, entry.location);
}

// Column headings, in order — the pane's `<th>` row and the CSV's
// header row are the same four.
export const LOG_COLUMNS: readonly string[] = ['Time', 'Level', 'Source', 'Message'];

// ---------- CSV ----------

// Quote when the value would otherwise be ambiguous or awkward to read
// back: the separator, the quote character itself, and any whitespace —
// the last of which covers leading/trailing spaces a parser would
// otherwise be free to trim.
const NEEDS_QUOTING = /[",\s]/;

export function csvField(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

// Fold a value onto one physical line: `\n`, `\r` as their two-
// character escapes.
//
// CSV would allow the newline inside quotes, and a spreadsheet would
// read it back — but this file is called `.log`, and one record per
// line is what makes it work with the tools a log is actually reached
// for. A stack trace spanning eight physical lines means `grep` finds
// a fragment with no timestamp on it, `wc -l` counts frames instead of
// events, and `tail -n` cuts an entry in half.
//
// Backslash is escaped first, and only for that reason: log messages
// carry Windows paths and regex sources, so without it a literal `\n`
// in the text and a real newline would decode to the same thing, and
// the escape wouldn't be reversible.
export function foldToOneLine(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// One record, one line — by construction, not by the caller
// remembering to flatten first.
export function csvRow(fields: readonly string[]): string {
  return fields.map((f) => csvField(foldToOneLine(f))).join(',');
}

// The whole log as CSV text, header row first, one entry per line.
//
// Rows are newest-first, matching the pane's table rather than the
// append order in storage: this is an export of what the reader is
// looking at, and a log whose top line is the event they just saw is
// the point of the ordering in both places.
//
// `renderMessage` is how the caller supplies its own Message column;
// see the note at the top of the file.
export function formatLogCsv(
  entries: LogEntry[],
  renderMessage: (entry: LogEntry) => string = formatLogMessage,
): string {
  const lines = [csvRow(LOG_COLUMNS)];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    lines.push(csvRow([
      formatLogTimestamp(e.timestamp),
      e.level,
      formatLogSource(e),
      renderMessage(e),
    ]));
  }
  return `${lines.join('\n')}\n`;
}

// Suggested filename for a saved log: the script's log ID with its
// `.user.js` / `.js` extension swapped for `.log`, keeping any `#N`
// dedup suffix so two scripts sharing a basename don't suggest the
// same file. `bold-on-hover.user.js#2` → `bold-on-hover#2.log`.
//
// `.log` rather than `.csv` even though the contents are CSV: this is
// a log first, and a double-click should open a text editor rather
// than a spreadsheet.
export function logFileName(logId: string): string {
  // Dedup suffix first, extension second — `logIdDupeSuffix` explains
  // why the `#N` match is anchored, and `script-source-url.ts` explains
  // why the order matters (`Chapter #2.user.js`).
  const trimmed = sanitizeFilename(logId).trim();
  const dupe = logIdDupeSuffix(trimmed);
  // One alternation rather than two `.replace`s: chaining them strips
  // twice for a name like `bar.js.user.js`, eating a `.js` that is part
  // of the name.
  const base = (dupe ? trimmed.slice(0, -dupe.length) : trimmed)
    .replace(/\.(user\.)?js$/i, '');
  // Fallback for a script we have no label for at all — the viewer
  // asks for a filename whether or not the log ID map has landed.
  return `${base || 'script'}${dupe}.log`;
}

// A log ID is a decoded on-disk filename, which is attacker-controlled
// for an untrusted script bundle. Path separators are already gone
// (`scriptBasename` takes the leaf twice), so what is left is control
// characters, which have no business in a filename the browser is
// about to write. Same substitution as `sanitizeLabel` in
// `script-source-url.ts`, for the same reason.
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '_');
}
