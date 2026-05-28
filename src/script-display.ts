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
// status (`ok` / `invalid` / `missing`) with the highest log level
// observed in the per-script Log so far. Priority order:
//
//   invalid  — the script can't run (parse / fetch / dep failure)
//   missing  — the source file vanished from its listing
//   error    — script loaded fine but its Log has an error entry
//   warning  — script loaded fine but its Log has a warning entry
//   ok       — no logs, or only info-level logs
//
// `invalid` and `missing` always win over Log-derived levels because
// "can't run" is the more actionable surface; the Log tab itself
// carries the per-event detail (errors emitted at parse / refresh
// time land there too).
export type DisplayStatus = 'ok' | 'invalid' | 'missing' | 'warning' | 'error';

export type LogLevelForStatus = 'info' | 'warning' | 'error';

export function effectiveScriptStatus(
  script: Pick<StoredScript, 'status'>,
  maxLogLevel: LogLevelForStatus | undefined,
): DisplayStatus {
  if (script.status === 'invalid') return 'invalid';
  if (script.status === 'missing') return 'missing';
  if (maxLogLevel === 'error') return 'error';
  if (maxLogLevel === 'warning') return 'warning';
  return 'ok';
}

// Text shown in the "Status" cell. Distinguishes 'missing' from
// 'invalid' so the label matches the size cell — previously a missing
// script showed "MISSING" for size but "ERROR" for status. WARNING /
// ERROR mean the script loaded fine but its Log carries entries at
// that level (see `effectiveScriptStatus`).
export function formatScriptStatusLabel(status: DisplayStatus): string {
  switch (status) {
    case 'ok': return 'OK';
    case 'missing': return 'MISSING';
    case 'invalid': return 'INVALID';
    case 'warning': return 'WARNING';
    case 'error': return 'ERROR';
  }
}
