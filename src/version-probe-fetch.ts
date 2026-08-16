// The fetching half of update probes. Split from `version-probe.ts` so
// the pure half — target selection, the outdated verdict, the staleness
// gate — can be imported by display code (`script-display.ts`,
// `collections.ts`, `script-details.ts`) without dragging the whole fetch
// stack into every extension page. Only `script-updater.ts` needs this
// module. See [docs/updates.md].

import { mapWithConcurrency, PROBE_URLS_PER_SCRIPT_CONCURRENCY } from './concurrency.js';
import { fetchResourceText } from './file-loader.js';
import { getValue, parseHeader } from './userscript-header.js';
import type { ProbeTarget, VersionProbe } from './version-probe.js';

// A `.meta.js` is a couple of KB; a `@downloadURL` is a whole
// userscript. 1 MB matches the `@require` body cap — past that we're
// not reading a userscript header, we're downloading something else.
const PROBE_MAX_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 5000;

// Fetch one target and read its `@version`. Never throws and never
// reports anything but a `VersionProbe` — a probe failure is a display
// annotation, not an error the refresh pipeline should react to.
//
// `prior` is this target's previous row, when there is one. A failed
// attempt carries its `version` forward: retracting a verdict we
// already established, because the host happened to 500 this
// afternoon, would flap the OUTDATED badge and re-log the transition
// every time the host recovered.
export async function runProbe(
  target: ProbeTarget,
  now: number,
  prior?: VersionProbe,
): Promise<VersionProbe> {
  const failed = (error: string): VersionProbe => ({
    kinds: target.kinds,
    url: target.url,
    checkedAt: now,
    error,
    ...(prior?.version ? { version: prior.version } : {}),
  });
  // The bytes fetcher does report which failure it was, but
  // `fetchResourceText` drops that on purpose: `probe.error` renders as
  // a value in a definition-list cell (`script-details.ts`) with no room
  // for a sentence, so this row's job is "we couldn't check", not
  // diagnosis. Tracked in TODO.md with the rest of the version-probe
  // wording exception.
  const text = await fetchResourceText(target.url, {
    maxBytes: PROBE_MAX_BYTES,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (text === null) return failed('could not fetch');
  // Both `.meta.js` (header only) and a full `.user.js` parse the same
  // way — parseHeader reads the metadata block wherever it sits and
  // ignores everything after it. Managers accept either shape at an
  // `@updateURL`, so we do too.
  const header = parseHeader(text);
  if (!header) return failed('no metadata block');
  const version = getValue(header, 'version');
  if (!version?.trim()) return failed('no @version');
  return { kinds: target.kinds, url: target.url, checkedAt: now, version: version.trim() };
}

// Probe every target of ONE script, at most
// PROBE_URLS_PER_SCRIPT_CONCURRENCY at a time — a guard that cannot bind
// at today's two-targets-per-script maximum. What actually caps a
// Refresh All burst is PROBE_SCRIPTS_CONCURRENCY, one level up in
// `runVersionProbes`.
//
// Takes the targets rather than re-deriving them from the header,
// because the caller already needed them for the staleness check and the
// two must agree. Result order matches `targets`.
export async function probeVersions(
  targets: readonly ProbeTarget[],
  now: number,
  prior?: readonly VersionProbe[],
): Promise<VersionProbe[]> {
  const priorByUrl = new Map((prior ?? []).map((p) => [p.url, p]));
  return await mapWithConcurrency(
    targets, PROBE_URLS_PER_SCRIPT_CONCURRENCY,
    (target) => runProbe(target, now, priorByUrl.get(target.url)),
  );
}
