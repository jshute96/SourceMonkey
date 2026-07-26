// Display helpers shared by the sources page, the userscript viewer,
// the install prompt, and the service worker.
//
// Two groups live here: the script-status row formatting (size +
// status label) both pages render, and the name/path formatting that
// turns a stored URL into something a human wants to read. Pure
// functions — no DOM, no chrome.* calls.

import type { StoredScript } from './script-store.js';
import { getValue } from './userscript-header.js';

// ---------- Names and paths ----------

// Anything of the form `<scheme>://…`. Used to decide whether
// percent-decoding is safe: URL path segments are encoded, on-disk
// names are literal.
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// Percent-decode for display. Never throws: a lone `%` (a literal
// percent in a filename) would make decodeURIComponent raise URIError,
// and losing the whole string is far worse than leaving one escape
// undecoded.
export function decodeForDisplay(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// Last `/`-separated segment of a path. No decoding — callers that
// want a display form pass the result through decodeForDisplay.
export function leafName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

// Readable form of a stored location — the string a heading, tooltip,
// or title shows. Scripts installed from the web (GreasyFork above
// all) carry their human name inside the URL path, so the stored URL
// is a wall of `%20` / `%F0%9F…`; Chrome's own omnibox shows those
// decoded and so do we.
//
// Only absolute URLs are decoded. A relativePath from a local
// directory source is a literal on-disk name, where a `%20` really is
// a percent followed by two digits.
//
// Display only: hrefs, clipboard copies, fetches, and stored values
// all keep the encoded form.
export function displayLocation(urlOrPath: string): string {
  return ABSOLUTE_URL_RE.test(urlOrPath) ? decodeForDisplay(urlOrPath) : urlOrPath;
}

// Short display name for a script's location: the URL's filename (no
// query string, decoded), or the last path segment for an on-disk
// relativePath. Falls back to the whole input when a URL-shaped string
// won't parse or has an empty path, so the caller always has something
// to render.
//
// The second `leafName` is not redundant: an escaped `%2F` decodes to
// a real slash, and this feeds log IDs — a "basename" carrying a path
// separator would read as a directory in every log line.
export function scriptBasename(urlOrPath: string): string {
  if (!ABSOLUTE_URL_RE.test(urlOrPath)) return leafName(urlOrPath);
  try {
    return leafName(decodeForDisplay(leafName(new URL(urlOrPath).pathname))) || urlOrPath;
  } catch {
    return leafName(urlOrPath);
  }
}

// The trailing `#N` a log ID carries when several scripts share a
// basename, or '' when it's unique. Anchored to the `#<digits>` shape
// rather than the first `#` in the string: log IDs are decoded
// filenames, so a script whose URL carries a `%23` has a literal `#`
// mid-name and would otherwise render half its own name as a suffix.
export function logIdDupeSuffix(logId: string): string {
  return /#\d+$/.exec(logId)?.[0] ?? '';
}

// The name to show for a script in badges, menus, and match listings:
// its `@name` when it declares one, else its location in readable
// form. Shared so every surface labels the same script the same way.
export function scriptDisplayName(
  script: Pick<StoredScript, 'header' | 'relativePath'>,
): string {
  return (script.header && getValue(script.header, 'name')) || displayLocation(script.relativePath);
}

// Format a byte count for the size column. Returns "1.2 KB", "950 B",
// etc. — short enough to fit comfortably alongside filename + status.
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// Text shown in the "Size" cell. Size is independent of status:
// `missing` rows still carry the size of their cached content,
// `invalid` rows that retain prior content still show its byte count,
// and a 0-byte file shows "0 B" (distinct from missing). Only rows
// that have never successfully loaded — `size == null` — render as
// "—" to signal "unknown".
export function formatScriptSize(script: Pick<StoredScript, 'status' | 'size'>): string {
  if (script.size == null) return '—';
  return formatBytes(script.size);
}

// Effective status shown to the user. Combines the persisted load
// status (`ok` / `invalid` / `missing`) and the `refreshError`
// annotation with the highest log level observed in the per-script Log
// so far. Priority order:
//
//   invalid        — the script can't run (parse / fetch / dep failure)
//   missing        — the source file vanished from its listing
//   refresh-failed — running fine on its cached copy, but the latest
//                    refresh failed (unreachable source, or a fetched
//                    copy that wasn't a valid script)
//   error          — script loaded fine but its Log has an error entry
//   warning        — script loaded fine but its Log has a warning entry
//   ok             — no logs, or only info-level logs
//
// `invalid` / `missing` always win because "can't run" is the most
// actionable surface. `refresh-failed` ranks above the Log-derived
// levels: a stale script is a distinct, specific signal the user should
// see, and the running script's own runtime errors still show up in the
// Log tab regardless. The Log tab carries the per-event detail (errors
// emitted at parse / refresh time land there too).
export type DisplayStatus =
  | 'ok' | 'invalid' | 'missing' | 'refresh-failed' | 'warning' | 'error';

export type LogLevelForStatus = 'info' | 'warning' | 'error';

export function effectiveScriptStatus(
  script: Pick<StoredScript, 'status' | 'refreshError'>,
  maxLogLevel: LogLevelForStatus | undefined,
): DisplayStatus {
  if (script.status === 'invalid') return 'invalid';
  if (script.status === 'missing') return 'missing';
  if (script.refreshError) return 'refresh-failed';
  if (maxLogLevel === 'error') return 'error';
  if (maxLogLevel === 'warning') return 'warning';
  return 'ok';
}

// Text shown in the "Status" cell. Distinguishes 'missing' from
// 'invalid' so the label matches the size cell — previously a missing
// script showed "MISSING" for size but "ERROR" for status. REFRESH
// FAILED means the script still runs from its cached copy but the last
// update attempt failed. WARNING / ERROR mean the script loaded fine
// but its Log carries entries at that level (see `effectiveScriptStatus`).
export function formatScriptStatusLabel(status: DisplayStatus): string {
  switch (status) {
    case 'ok': return 'OK';
    case 'missing': return 'MISSING';
    case 'invalid': return 'INVALID';
    case 'refresh-failed': return 'REFRESH FAILED';
    case 'warning': return 'WARNING';
    case 'error': return 'ERROR';
  }
}
