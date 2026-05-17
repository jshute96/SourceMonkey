// Display helpers shared by the options page and the userscript viewer.
//
// Both pages render the same script-status row (size + status label) so
// the formatting logic lives here and is unit-tested. Pure functions —
// no DOM, no chrome.* calls.

import type { ScriptStatus, StoredScript } from './script-store.js';

// Format a byte count for the size column. Returns "1.2 KB", "950 B",
// etc. — short enough to fit comfortably alongside filename + status.
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// Text shown in the "Size" cell. `missing` scripts (or any row with no
// known size) display "MISSING" so the user sees at-a-glance that the
// underlying file is gone, regardless of whether the cached content is
// still around.
export function formatScriptSize(script: Pick<StoredScript, 'status' | 'size'>): string {
  if (script.status === 'missing' || script.size == null) return 'MISSING';
  return formatBytes(script.size);
}

// Text shown in the "Status" cell. Distinguishes 'missing' from 'error'
// so the label matches the size cell — previously a missing script
// showed "MISSING" for size but "ERROR" for status.
export function formatScriptStatusLabel(status: ScriptStatus): string {
  switch (status) {
    case 'ok': return 'OK';
    case 'missing': return 'MISSING';
    case 'error': return 'ERROR';
  }
}
