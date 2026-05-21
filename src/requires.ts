// `@require` resolution + fetch pipeline.
//
// Each userscript can declare any number of `@require <ref>` lines in
// its metadata block. SourceMonkey prefetches the bodies at load /
// refresh time so injection is purely a string-concat at registration
// time — Chrome's userScripts API can't fetch on its own. Resolution
// flows through file-loader, so a `@require` ref can be:
//   - an absolute `http(s)://` URL
//   - a relative path (resolved against the host script's URL)
// Absolute `file://` URLs and traversal-bearing relatives are rejected
// for the same reason `@icon` rejects them (see file-loader header).
//
// `.js` suffix is mandatory on the resolved URL's pathname (sans
// query). Required resources from other managers' worlds (CSS via
// `@require`, etc.) are not honored.
//
// Loaded files are NOT themselves parsed as userscripts — TM/VM/GM
// don't recurse into requires either. Transitive requires therefore
// don't exist: a require body is just JavaScript text that gets
// prepended verbatim before the main body inside the activation
// wrapper.

import {
  fetchResourceText,
  isJsResourceUrl,
  resolveScriptResource,
} from './file-loader.js';
import { getValues, type ParsedHeader } from './userscript-header.js';

// Per-require limit. Big enough for jQuery (≈90 KB) and most chunky
// userscript libraries; small enough to keep a runaway from draining
// the 10 MB chrome.storage.local quota in one row.
export const MAX_REQUIRE_BYTES = 1024 * 1024;

export interface StoredRequire {
  // Verbatim ref from the `@require` line (post-trim). Kept so we can
  // log "your @require '../foo' was rejected" against the source text.
  ref: string;
  // Canonical resolved URL. Stable key for dedup within a script and
  // across scripts in a single refresh.
  url: string;
  // Fetched JS source text.
  source: string;
  // UTF-8 byte length of `source`. `0` is impossible (the fetcher
  // rejects empty bodies) but the field is non-optional for parity
  // with StoredScript.
  size: number;
  contentHash: string;
  // Epoch ms of the last successful (re)fetch. Bumps only when the
  // bytes actually changed — preserved across refreshes that find the
  // require unchanged, mirroring StoredScript.loadedAt semantics.
  loadedAt: number;
  // HTTP validators (when the resolved URL is http(s)). Sent on the
  // next conditional GET so the server can answer 304.
  httpEtag?: string;
  httpLastModified?: string;
}

// Cross-script fetch cache. Two scripts requiring the same canonical
// URL during one refresh share one fetch — keyed by url, value is the
// in-flight promise for that fetch. Caller threads it through every
// `attachRequires` call in a single refresh pass.
export type RequireFetchCache = Map<string, Promise<StoredRequire | RequireFailure>>;

interface RequireFailure {
  failed: true;
  ref: string;
  url: string;
  errorMessage: string;
}

function isFailure(v: StoredRequire | RequireFailure): v is RequireFailure {
  return (v as RequireFailure).failed === true;
}

// Extract unique `@require` refs from a parsed header, in declaration
// order. Localized variants (`@require:de`) are ignored. Duplicate
// refs are collapsed at this stage — TM does the same. Empty /
// whitespace-only values are dropped.
export function distillRequires(header: ParsedHeader | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of getValues(header, 'require')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// SHA-256 hex of a JS source string. Same shape as script-store's
// hashSource; duplicated here so requires.ts doesn't pull in the
// whole script-store dep just for one helper.
export async function hashRequireSource(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

export interface AttachRequiresArgs {
  // The script's own canonical URL. Used as the resolution base so
  // relative refs land in the script's directory tree.
  scriptFileUrl: string;
  // Parsed header of the script body (post-rebuild).
  header: ParsedHeader | null;
  // Prior requires from the last successful build of this script,
  // keyed by canonical URL. Used as the warm cache for
  // recheck: 'preserve' and as the prior-validator source for HTTP
  // conditional GETs when recheck: 'all'.
  prior: Map<string, StoredRequire>;
  // 'all' (explicit Refresh) refetches every declared require so the
  // user can detect remote changes. 'preserve' (opportunistic) reuses
  // every cached prior verbatim and only fetches refs that are newly
  // declared in this build of the script.
  recheck: 'all' | 'preserve';
  // Shared fetch dedup across all scripts in a single refresh pass.
  // Pass a fresh `new Map()` per top-level refresh entry point.
  fetchCache: RequireFetchCache;
  // Wall-clock for new `loadedAt` stamps. Refresh threads it in so
  // every freshly-loaded script in one batch agrees.
  now: number;
}

export interface AttachRequiresResult {
  // The resolved require list in declaration order, deduped by url.
  // Empty when the script declares no `@require`.
  requires: StoredRequire[];
  // Non-null when at least one require failed: resolve-time rejection
  // (traversal, non-`.js`, bad scheme) or fetch failure (404, oversize,
  // etc.). The caller flips the script to status: 'error' with this
  // message; the partial requires list isn't useful for injection.
  errorMessage?: string;
}

// Resolve + fetch every `@require` declared on a script. See the field
// docs above for the shape of `args`. The caller (rebuildSource) flips
// the script to status:'error' if a non-null `errorMessage` comes back.
export async function attachRequires(args: AttachRequiresArgs): Promise<AttachRequiresResult> {
  const refs = distillRequires(args.header);
  if (refs.length === 0) return { requires: [] };

  const requires: StoredRequire[] = [];
  const seenUrls = new Set<string>();

  for (const ref of refs) {
    const resolved = resolveScriptResource(ref, args.scriptFileUrl);
    if (!resolved) {
      return {
        requires: [],
        errorMessage: `@require ${ref}: blocked or invalid reference (must be http(s) or a relative path inside the script's directory)`,
      };
    }
    // file-loader allows data: but that doesn't make sense as a script
    // body — reject early.
    if (resolved.kind === 'data') {
      return {
        requires: [],
        errorMessage: `@require ${ref}: data: URLs are not supported`,
      };
    }
    if (!isJsResourceUrl(resolved.url)) {
      return {
        requires: [],
        errorMessage: `@require ${ref}: filename must end in .js`,
      };
    }
    if (seenUrls.has(resolved.url)) continue;
    seenUrls.add(resolved.url);

    const prior = args.prior.get(resolved.url);
    if (args.recheck === 'preserve' && prior) {
      // Opportunistic path: reuse the cached entry verbatim. The
      // explicit Refresh path is what rechecks remote content.
      requires.push(prior);
      continue;
    }

    let pending = args.fetchCache.get(resolved.url);
    if (!pending) {
      pending = fetchRequire({
        ref,
        url: resolved.url,
        prior,
        now: args.now,
      });
      args.fetchCache.set(resolved.url, pending);
    }
    const got = await pending;
    if (isFailure(got)) {
      // Use this script's `ref` (what the user wrote here) rather
      // than the failure's stored ref — when two scripts share a
      // require via the cross-script fetch cache, the failure's ref
      // came from whichever script's fetch ran first, which might
      // not be this script.
      return { requires: [], errorMessage: `@require ${ref}: ${got.errorMessage}` };
    }
    requires.push(got);
  }
  return { requires };
}

interface FetchRequireArgs {
  ref: string;
  url: string;
  prior?: StoredRequire;
  now: number;
}

// Fetch a single require, returning either the StoredRequire entry or
// a RequireFailure carrier (so attachRequires can route the error
// message into the script's errorMessage uniformly).
//
// Wrapped in try/catch so any unexpected throw (SubtleCrypto rejection,
// TextEncoder edge case, etc.) becomes a structured failure rather
// than rejecting the in-flight cache promise — a rejected entry shared
// across scripts via `RequireFetchCache` would take down every
// dependent script's refresh, not just this one's.
async function fetchRequire(args: FetchRequireArgs): Promise<StoredRequire | RequireFailure> {
  try {
    // For now we don't thread conditional-GET validators through
    // fetchResourceText (it's a thin wrapper over the byte fetcher,
    // which doesn't speak HTTP validators). A follow-up can extend
    // file-loader to support 304s on text fetches; until then every
    // explicit refresh of a require is a full re-download.
    const source = await fetchResourceText(args.url, {
      maxBytes: MAX_REQUIRE_BYTES,
      // Loose content-type filter: accept anything text-shaped or empty
      // (file:// XHR often reports no content-type). The `.js` suffix
      // is the user-facing gate; servers that mislabel JS as text/plain
      // are common enough to forgive.
      acceptContentType: (ct) =>
        ct.includes('javascript') ||
        ct.startsWith('text/') ||
        ct === 'application/octet-stream',
    });
    if (source == null) {
      return {
        failed: true,
        ref: args.ref,
        url: args.url,
        errorMessage: 'fetch failed (network error, 404, oversize, or content-type rejected)',
      };
    }
    const contentHash = await hashRequireSource(source);
    // Reuse the prior loadedAt when the bytes are unchanged so the
    // options-page row-highlight stays accurate.
    const unchanged = args.prior?.contentHash === contentHash;
    const loadedAt = unchanged && args.prior ? args.prior.loadedAt : args.now;
    const size = new TextEncoder().encode(source).length;
    return {
      ref: args.ref,
      url: args.url,
      source,
      size,
      contentHash,
      loadedAt,
    };
  } catch (err) {
    return {
      failed: true,
      ref: args.ref,
      url: args.url,
      errorMessage: `fetch threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
