// Update probes: "what `@version` does the script's upstream claim?"
//
// A probe is deliberately NOT a refresh. A refresh fetches the bytes we
// actually run, from the URL the user installed from, and can change a
// script's status. A probe fetches somebody else's copy, reads one
// header line out of it, and changes nothing but a display annotation.
// Keeping them apart is the whole design: a `@downloadURL` pointing at
// an origin the user never approved must never become an update
// channel, and an unreachable probe host must never disable a working
// script.
//
// What gets probed: only `@updateURL` / `@downloadURL` values that
// differ from the URL we load the script from. We already auto-update
// from our own source — local files via the scan's size+mtime check,
// http(s) via a conditional GET — so probing it would be a slower way
// to learn what the refresh that just ran already established.
//
// That leaves exactly the interesting case: a copy whose official home
// is somewhere we don't fetch from. We can't update it automatically,
// so all we can do is say so. See [docs/updates.md].

import { getValue, type ParsedHeader } from './userscript-header.js';
import { versionRelation } from './version-compare.js';

// Which header named a probe URL. Both, when `@updateURL` and
// `@downloadURL` point at the same place.
export type ProbeKind = 'update' | 'download';

export interface ProbeTarget {
  url: string;
  // In `update`-before-`download` order so the display label is stable.
  kinds: ProbeKind[];
}

export interface VersionProbe extends ProbeTarget {
  // The `@version` the probed copy last declared. Survives a later
  // failed attempt (see `error`), so an upstream that goes down for an
  // afternoon doesn't retract a verdict we already established.
  version?: string;
  // Why the most recent attempt produced nothing new: the fetch
  // failed, the response had no metadata block, or it had one with no
  // `@version` line. Can coexist with `version`, which then refers to
  // an earlier successful attempt.
  error?: string;
  // When the most recent attempt ran, successful or not. Drives the
  // staleness gate.
  checkedAt: number;
}

// How hard to try. `if-stale` respects `PROBE_MIN_INTERVAL_MS`;
// `force` ignores it. Deliberately NOT derived from the refresh's
// `manual` / `opportunistic` mode: `manual` also covers the reload
// fast path, which fires on every explicit tab reload, so keying off
// it would probe third-party hosts once per reload.
export type ProbePolicy = 'force' | 'if-stale';

// How long a recorded probe stays fresh. Probes hit third-party hosts
// on somebody else's page load, and an upstream release is a
// once-in-weeks event, so this is deliberately hours rather than the
// seconds the source-refresh gate uses.
export const PROBE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Canonical form for comparing a probe URL against the script's own
// location. Returns null for anything that isn't an absolute http(s)
// URL: a relative `@updateURL` has no meaning (updates come from a
// fixed home, not from wherever this copy happens to sit), and a
// `file://` one would turn a header line into a host-file read.
function canonicalProbeUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

// The distinct upstream URLs worth asking about, in `update`-first
// order. Deduped by canonical URL, so the common GreasyFork shape
// (`@downloadURL` = the `.user.js` we installed from, `@updateURL` =
// the sibling `.meta.js`) yields one target, not two.
export function probeTargets(
  header: ParsedHeader | null,
  fileUrl: string,
): ProbeTarget[] {
  if (!header) return [];
  // A `file://` script canonicalizes to null and simply never matches
  // an http(s) target, which is the right answer.
  const own = canonicalProbeUrl(fileUrl);
  const byUrl = new Map<string, ProbeTarget>();
  for (const kind of ['update', 'download'] as const) {
    const url = canonicalProbeUrl(getValue(header, `${kind}URL`));
    if (!url || url === own) continue;
    const existing = byUrl.get(url);
    if (existing) existing.kinds.push(kind);
    else byUrl.set(url, { url, kinds: [kind] });
  }
  return [...byUrl.values()];
}

// Whether the stored probes still stand in for a fresh check. Stale in
// either direction, because both mean the stored set no longer
// describes what the script declares:
//
//   - a target with no row, or a row aged past the interval — the
//     normal case, and what makes a newly-added `@updateURL` get
//     probed on the next check rather than in six hours;
//   - a row whose URL is no longer a target — the script dropped that
//     header, and leaving the row would keep reporting OUTDATED
//     against a URL it no longer names.
export function probesAreFresh(
  probes: readonly VersionProbe[] | undefined,
  targets: readonly ProbeTarget[],
  now: number,
): boolean {
  const stored = probes ?? [];
  if (targets.length === 0) return stored.length === 0;
  const targetUrls = new Set(targets.map((t) => t.url));
  if (stored.some((p) => !targetUrls.has(p.url))) return false;
  const byUrl = new Map(stored.map((p) => [p.url, p]));
  return targets.every((t) => {
    const probe = byUrl.get(t.url);
    return probe !== undefined && now - probe.checkedAt < PROBE_MIN_INTERVAL_MS;
  });
}

// The probe that says our copy is behind, or null when none does.
// Picks the highest version among those ahead of us, so a script whose
// update and download URLs disagree is judged against the further-ahead
// one — being told about the smaller gap would understate it.
export function outdatedProbe(
  loadedVersion: string | undefined,
  probes: readonly VersionProbe[] | undefined,
): VersionProbe | null {
  let furthestAhead: VersionProbe | null = null;
  for (const probe of probes ?? []) {
    if (versionRelation(loadedVersion, probe.version) !== 'newer') continue;
    if (!furthestAhead || versionRelation(furthestAhead.version, probe.version) === 'newer') {
      furthestAhead = probe;
    }
  }
  return furthestAhead;
}

// Row label for a probe: "update URL" or "download URL".
//
// When ONE url is named by both headers the label says "update URL"
// rather than spelling out both. `@updateURL` is the header that means
// "check here for a new version", so it is the accurate name for what
// we did; `@downloadURL` naming the same file is a detail of the
// script's headers, not of the check. Spelling out both made the
// longest label in the panel, for a distinction the reader can't act
// on — the row's tooltip carries the URL either way.
//
// No ambiguity with a plain update probe: the combined form only
// exists when the two headers resolve to the same URL, and two probes
// for one URL is exactly what it's collapsing.
export function probeLabel(kinds: readonly ProbeKind[]): string {
  return kinds.includes('update') ? 'update URL' : 'download URL';
}
