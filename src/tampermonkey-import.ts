// Parser for Tampermonkey's backup file — the `.txt` its Utilities
// page writes under "File → Export".
//
// Pure: text in, a list of scripts out. No storage, no chrome.*, so
// the shape rules are unit-testable on their own. Turning the result
// into collection + script rows is `importCollection` in
// `script-store.ts`.
//
// The format itself is documented in
// docs/import-export-tampermonkey.md; this file only implements it.
// Two properties of that format drive most of the code here:
//
//   - `source` is base64 of the script's UTF-8 bytes, not plain text.
//   - The per-script fields are FLAT (`uuid` / `name` / `enabled` on
//     the script object), where the zip export nests them under
//     `meta` / `settings`. We read the flat form.
//
// Everything is defensive: a backup is a file the user picked, it can
// be truncated, from a much older Tampermonkey, or not a backup at
// all. One unreadable script must not lose the other forty, so
// per-script problems become warnings and the rest still imports.

import { getValue, parseHeader } from './userscript-header.js';

// One script recovered from a backup, in the shape the store wants.
export interface ImportedScript {
  // The script's `@name` as Tampermonkey recorded it. The filename the
  // row is stored under is derived from this by the store, which owns
  // the dedup rules.
  name: string;
  // Full userscript text, metadata block included.
  source: string;
  // Tampermonkey's own id for the script. Kept as provenance so a
  // later re-import can recognise the same script.
  uuid: string;
  enabled: boolean;
  // Tampermonkey's ordering within its dashboard. Used to order the
  // imported collection; absent entries sort last.
  position?: number;
  // Where the script can be refetched, when the backup names somewhere
  // and the user hasn't edited the body locally. Absent means the row
  // is pinned — see `userModified` below.
  location?: string;
  // True when Tampermonkey recorded a local edit to the body
  // (`options.user_modified`). Such a row is pinned even when a URL is
  // available: the upstream copy is not what the user is running, so
  // refetching it would silently discard their edit.
  userModified: boolean;
  // `GM_setValue` data, as stored. Values are already-decoded JSON, so
  // they carry across verbatim.
  storage: Record<string, unknown>;
}

export interface ImportResult {
  scripts: ImportedScript[];
  // Per-script problems that didn't stop the import. Surfaced to the
  // user so a backup that half-imported doesn't look like it fully
  // worked.
  warnings: string[];
}

// Thrown when the file isn't a backup we can read at all. The message
// is user-facing — see the wording rules in CLAUDE.md / docs/diagnostics.md.
export class ImportFormatError extends Error {}

// A single userscript handed to the import dialog. Add already installs
// these, and routing one through import too would give the same file
// two different install paths with two different results.
export const IMPORT_IS_USERSCRIPT =
  'This is a userscript, not a backup file. Add it with the Add field instead.';

export const IMPORT_NOT_A_BACKUP =
  'This is not a Tampermonkey backup file. Export one with File → Export on Tampermonkey\'s Utilities page.';

export const IMPORT_NO_SCRIPTS = 'This backup contains no userscripts';

// Tampermonkey's Utilities page, where the user clicks Export.
//
// The extension ID is a hash of Tampermonkey's publisher key, so it is
// the same in every Chrome profile and stable across its releases. The
// `#nav=` fragment is the only part of that page a link can control —
// nothing there accepts a URL parameter that would prefill or trigger
// the export, so this is as far as we can carry the user.
export const TAMPERMONKEY_UTILITIES_URL =
  'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utils';

// Heading for the collection one import creates. Dated because
// repeating an import makes a second collection, and the date is what
// tells the two apart in the list.
export function importCollectionName(when: Date): string {
  return `Imported from Tampermonkey — ${when.toLocaleDateString()}`;
}

// Tampermonkey writes the backup as one JSON object. Parse it, then
// pull the scripts out.
export function parseTampermonkeyBackup(text: string): ImportResult {
  const root = parseBackupJson(text);
  const rawScripts = (root as { scripts?: unknown }).scripts;
  if (!Array.isArray(rawScripts)) throw new ImportFormatError(IMPORT_NOT_A_BACKUP);

  const scripts: ImportedScript[] = [];
  const warnings: string[] = [];
  rawScripts.forEach((entry, i) => {
    try {
      scripts.push(readScript(entry, i));
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  });

  if (scripts.length === 0) {
    // A backup whose every entry failed is not "an empty backup" — say
    // which it was, so the user knows whether to look at the file or at
    // the scripts inside it.
    if (warnings.length > 0) {
      throw new ImportFormatError(
        `No userscript in this backup could be read: ${warnings[0]}`,
      );
    }
    throw new ImportFormatError(IMPORT_NO_SCRIPTS);
  }

  scripts.sort(byPosition);
  return { scripts, warnings };
}

function parseBackupJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new ImportFormatError('The file is empty');
  // The most likely wrong file is a userscript, since that's the other
  // thing on the Utilities page and the thing the user has been
  // handling. Name it rather than letting it fall through to the
  // generic "not a backup".
  if (looksLikeUserscript(trimmed)) throw new ImportFormatError(IMPORT_IS_USERSCRIPT);

  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    throw new ImportFormatError(IMPORT_NOT_A_BACKUP);
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new ImportFormatError(IMPORT_NOT_A_BACKUP);
  }
  return root as Record<string, unknown>;
}

function looksLikeUserscript(text: string): boolean {
  return /^\s*\/\/\s*==UserScript==/m.test(text.slice(0, 4096));
}

function readScript(entry: unknown, index: number): ImportedScript {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Script ${index + 1} in the backup is not readable`);
  }
  const e = entry as Record<string, unknown>;

  const rawName = typeof e.name === 'string' ? e.name.trim() : '';
  // Position in the file is the only handle left when there's no name;
  // it's what the user sees in the warning, so make it 1-based.
  const label = rawName || `script ${index + 1}`;

  const source = decodeSource(e.source);
  if (source === null) throw new Error(`The source of ${label} could not be read`);
  if (!source.trim()) throw new Error(`The source of ${label} is empty`);

  const options = isObject(e.options) ? e.options : {};

  return {
    name: rawName,
    source,
    uuid: typeof e.uuid === 'string' ? e.uuid : '',
    // A backup written before the field existed, or with it dropped,
    // should leave the script running — that is what it was doing in
    // Tampermonkey unless it said otherwise.
    enabled: e.enabled !== false,
    position: readPosition(e.position),
    location: readLocation(e, source),
    userModified: options.user_modified != null && options.user_modified !== false,
    storage: readStorage(e.storage),
  };
}

// Dashboard order. A hand-edited or much older backup can carry this
// as a string; taking it only when it is already a number would send
// those scripts to the back of the collection for no reason.
function readPosition(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// Tampermonkey's `source` is base64 of the script's UTF-8 bytes; its
// own reader is `decodeURIComponent(escape(atob(s)))`. We use
// TextDecoder for the same result without the deprecated `escape`.
// Returns null rather than throwing so the caller words the failure
// with the script's name attached.
function decodeSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

// Where the script came from, best effort.
//
// - `file_url` is what Tampermonkey recorded at install time, and is
//   the most direct answer. The backup's flat script object carries it;
//   the top-level `downloadURL` / `updateURL` fields of Tampermonkey's
//   internal record do NOT survive into the export, so the header is
//   the only other place to look.
// - `@downloadURL` from the script's own metadata block is the
//   fallback, and is what a hand-installed-from-a-site script tends to
//   be all that carries.
// - `@updateURL` is deliberately NOT used. By convention it may point
//   at a `.meta.js` — a metadata block with no body — so adopting it as
//   the place to refetch from would replace the script with its own
//   header on the first refresh.
//
// Only http(s) counts. A `file://` URL from someone else's machine (or
// the same machine before a move) points at a path we may not be able
// to read, and treating it as live would turn a working import into a
// collection of refresh failures.
function readLocation(e: Record<string, unknown>, source: string): string | undefined {
  const fromBackup = httpUrlOrUndefined(e.file_url);
  if (fromBackup) return fromBackup;

  // `parseHeader` finds the metadata block in a full source itself, so
  // there is no need to split first. Returns null when the block is
  // absent or unterminated — which is a real possibility here, and the
  // store will flag it as `invalid` on its own.
  const header = parseHeader(source);
  if (!header) return undefined;
  return httpUrlOrUndefined(getValue(header, 'downloadURL'));
}

function httpUrlOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

// `storage` is `{ts, data:{…}}`. Only `data` matters — `ts` is
// Tampermonkey's own write clock.
function readStorage(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {};
  const data = value.data;
  if (!isObject(data)) return {};
  return { ...data };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Tampermonkey's dashboard order. Entries with no position keep the
// order they appeared in the file, behind everything that has one.
function byPosition(a: ImportedScript, b: ImportedScript): number {
  const ap = a.position ?? Number.MAX_SAFE_INTEGER;
  const bp = b.position ?? Number.MAX_SAFE_INTEGER;
  return ap - bp;
}

// Filename an imported script is stored under. Tampermonkey has no
// filenames — it keys on `@name` — but every SourceMonkey surface
// (the Filename column, log IDs, the viewer's tab strip) is built
// around one, so we synthesize it the same way Tampermonkey's own zip
// export does.
//
// `seen` accumulates across a whole import so two scripts that share a
// name (which Tampermonkey allows, since it disambiguates by
// `@namespace`) don't collide: the second becomes `Name-2.user.js`.
export function importedScriptFilename(name: string, seen: Set<string>): string {
  const base = slugForFilename(name) || 'userscript';
  let candidate = `${base}.user.js`;
  let n = 2;
  while (seen.has(candidate.toLowerCase())) {
    candidate = `${base}-${n}.user.js`;
    n++;
  }
  seen.add(candidate.toLowerCase());
  return candidate;
}

// Names come from the wild — GreasyFork titles carry slashes, emoji,
// and punctuation. Strip what would read as path structure or break a
// URL segment, and collapse the rest so the result is still
// recognisable as the script the user knows.
function slugForFilename(name: string): string {
  return name
    .trim()
    // A trailing `.user.js` in the name itself would double up. Done
    // before the character scrub so the literal dots are still there.
    .replace(/\.user\.js$/i, '')
    // Path separators and the Windows-reserved set. A `/` here would
    // make the filename look like a nested path in every surface that
    // splits on it.
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots would make a hidden file; trailing dots are dropped
    // by some filesystems.
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, 100)
    .trim();
}
