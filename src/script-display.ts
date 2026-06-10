// Display helpers shared by the sources page and the userscript viewer.
//
// Both pages render the same script-status row (size + status label) so
// the formatting logic lives here and is unit-tested. Pure functions —
// no DOM, no chrome.* calls.

import type { StoredScript } from './script-store.js';

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
