# Supported Userscript Headers

Catalogue of every `// @tag value` line SourceMonkey is likely to
encounter, what it does, and how completely we honor it.

The parser in [`src/userscript-header.ts`](../src/userscript-header.ts)
is intentionally generic — it accepts any `@tag` line, lowercases the
tag, and stashes the value. Whether a tag actually changes behavior
depends on which downstream module asks for it. This page is the
inventory of which tags downstream modules consult today.

## Status legend

| Symbol | Meaning |
|:------:|---------|
| ✅ | **Honored** — SourceMonkey reads the value and changes behavior accordingly. |
| 👁 | **Displayed only** — parsed and surfaced in the script viewer or logs, but not acted on. |
| ⚪ | **Ignored** — parser accepts it; no module currently reads it. Safe to put in your script; will simply have no effect. |

## "Also in" columns

A ✓ in the **TM / VM / GM** columns means the tag is *documented*
on that manager's canonical reference page (URLs below). An empty
cell means the tag is not documented there — a manager may still
silently accept the line, but users can't rely on it as an official
feature.

- **TM** = Tampermonkey — [tampermonkey.net/documentation.php](https://www.tampermonkey.net/documentation.php)
- **VM** = Violentmonkey — [violentmonkey.github.io/api/metadata-block](https://violentmonkey.github.io/api/metadata-block/)
- **GM** = Greasemonkey 4+ — [wiki.greasespot.net/Metadata_Block](https://wiki.greasespot.net/Metadata_Block)

If you want to cross-check by hand, fetch those three pages.

An empty **VM** cell is about VM's *documentation*, not its parser:

- VM's `parseMeta` (`src/background/utils/script.js`) keeps every
  `@tag` it sees, so an undocumented tag still reaches the metadata a
  script reads back through `GM_info.script`.
- Some of those (`@antifeature`, `@updateURL`) are acted on by VM's
  own code. Where that's true the Notes column says so.

---

## Identity and display

| Tag | SourceMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@name` | ✅ | ✓ | ✓ | ✓ | Required (validation rejects scripts with no `@name`). Used as the display label and in injection logs. Locale suffixes like `@name:de` are parsed but the non-localized form always wins. |
| `@namespace` | ⚪ | ✓ | ✓ | ✓ | TM/VM/GM combine it with `@name` as a unique storage key. SourceMonkey keys scripts by their UUID, so this has no effect here. |
| `@version` | 👁 | ✓ | ✓ | ✓ | Shown in the viewer, and compared against whatever `@updateURL` / `@downloadURL` declare to flag an OUTDATED script — see [updates.md](updates.md). Not used to decide whether to *fetch*: that's driven by `size+mtime` / conditional GET against the install source. |
| `@description` | 👁 | ✓ | ✓ | ✓ | Shown in the userscript viewer summary. |
| `@author` | ⚪ | ✓ |   |   | Not part of VM's or GM4's documented tag set (GM explicitly notes it's "ignored but readable" — i.e. preserved in collection, not honored as metadata). |
| `@copyright` | ⚪ | ✓ |   |   | TM-only per docs. |
| `@homepage` / `@website` / `@source` | ⚪ | ✓ |   |   | TM treats these as aliases for `@homepageURL`. VM and GM4 don't document the aliases — only `@homepageURL` (VM) or nothing (GM4). |
| `@homepageURL` | ⚪ | ✓ | ✓ |   | The canonical form. Links the "home" icon in TM/VM's script list. |
| `@supportURL` | ⚪ | ✓ | ✓ |   | Links the "?" icon in TM/VM's script list. |
| `@icon` | ✅ | ✓ | ✓ | ✓ | Used as the favicon shown beside the script in the options/viewer UI. Overrides the origin-discovered favicon when set. Accepts absolute `http(s)://` and `data:` URLs, or a relative path resolved against the script's parent directory (works for both file:// and HTTP scripts). Absolute `file://` URLs and any reference that escapes the script's directory (literal `..`, `%2e%2e`, leading `/`, `\`) are rejected — the extension holds `file:///*` host permission, so allowing arbitrary file refs would let a malicious script read host files. |
| `@iconURL` / `@defaulticon` | ✅ | ✓ |   |   | TM-only aliases of `@icon`; consulted in that priority order. |
| `@icon64` / `@icon64URL` | ✅ | ✓ |   |   | 64×64 variant; TM-only per docs. Lower priority than the regular `@icon` variants since our display target is 16×16. |
| `@tag` (categorization) | ⚪ | ✓ (5.0+) | ✓ |   | Labels for organising scripts in the dashboard. Distinct from "the metadata tag concept" generally. |
| `@antifeature` | ⚪ | ✓ |   |   | Monetisation/tracking disclosure. TM documents it; VM and GM4 don't. VM parses it anyway and lists the declared antifeatures on its install-confirm page. Widely used by GreasyFork tooling regardless. |
| `@license` | ⚪ |   |   |   | Not documented by any of TM/VM/GM4. Used in practice by collection-sharing sites (OpenUserJS, GreasyFork) as plain metadata. |

---

## URL matching

See [matching.md](matching.md) for full semantics. All four patterns
below can repeat; order doesn't matter.

| Tag | SourceMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@match` | ✅ | ✓ | ✓ | ✓ | Chrome's match-pattern grammar (`<scheme>://<host><path>`), handed to `chrome.userScripts.register({ matches })`. A scheme-less (`*.example.com/*`) or globbed (`http*://…`) pattern is rewritten into the spelling Chrome takes — see [matching.md](matching.md#lenient-readings-canonicalmatchpatterns). |
| `@include` | ✅ | ✓ | ✓ | ✓ | Glob form (`*://example.com/*`) goes to `includeGlobs`, which Chrome ORs with `matches` — userscript semantics. Regex form (`/^https:\/\/…$/`) goes to a wrapper-side filter — see [injection.md](injection.md#regex-pattern-forms). At least one `@match` or `@include` (either form) is required; a script with no `@match` registers as `<all_urls>` and narrows at runtime in the wrapper. |
| `@exclude` | ✅ | ✓ | ✓ | ✓ | Glob form → `excludeGlobs`. Regex form → wrapper-side filter. |
| `@exclude-match` | ⚪ |   | ✓ |   | VM-specific: the match-pattern-grammar counterpart to `@exclude` (which in VM's model is the legacy glob/regex form). SourceMonkey treats every `@exclude` value as either a glob or a regex regardless of which tag introduced it, so a script written for VM that uses `@exclude-match` will currently be ignored. Easy to add when needed: route both tags into the same `excludes` list. |

---

## Execution control

| Tag | SourceMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@run-at` | ✅ | ✓ | ✓ | ✓ (partial) | Every userscript registers with Chrome at `document_start`; the wrapper itself awaits the matching lifecycle event before running the body (`document-end` → `DOMContentLoaded`, `document-idle` → `load`, `document-body` → `document.body` exists). This sidesteps Chrome's `chrome.userScripts` scheduler batching `document_end` and `document_idle` into a single post-`load` burst. See [docs/injection.md](injection.md#run-at-gating). **Not supported:** `context-menu` — falls through to `document-idle`. GM4 docs warn only `document-end` is reliable there. |
| `@inject-into` | ✅ |   | ✓ |   | VM-specific. `page` → MAIN world. `content` → USER_SCRIPT (isolated) world. `auto` / unset falls through to `@grant` (see [injection.md → Execution world](injection.md#execution-world)). TM uses `@sandbox` for the same purpose. |
| `@noframes` | ⚪ | ✓ | ✓ | ✓ | Should map to Chrome's `allFrames: false`. Currently every script runs in the top frame only because we don't set `allFrames` at all, so this happens to be the right behavior *by accident* — but a script that wants the opposite (also run in frames) can't get it. Running in frames also needs the menu-command registry re-keyed first — see the frame-control note in [injection.md](injection.md#limitations--future-work). |
| `@run-in` | ⚪ | ✓ (5.3+) |   |   | Normal vs incognito vs Firefox containers. TM-only. |
| `@sandbox` | ⚪ | ✓ (4.18+) |   |   | TM's world-selector. SourceMonkey uses `@inject-into` instead, mirroring VM. |
| `@unwrap` | ⚪ | ✓ | ✓ |   | Inject the body without our activation/error shim. We always wrap — see [injection.md](injection.md#the-activation--error-wrapper). |
| `@top-level-await` | ⚪ | ✓ | ✓ |   | Allows `await` at the top level of the body. Chrome's userScripts API doesn't accept module mode, so this can't be honored without a bridge. |

---

## GM_* API access

| Tag | SourceMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@grant none` | ✅ | ✓ | ✓ | ✓ | Drives `resolveWorld` → MAIN. Multiple `@grant none` lines are accepted. |
| `@grant <api>` | ✅ | ✓ | ✓ | ✓ | Drives `resolveWorld` → USER_SCRIPT and emits a compile-in binding for the named API. Both legacy `GM_x` and GM4 `GM.x` forms are accepted on the same line; both map to the same canonical name and both bindings are exposed in scope. Unknown / typoed names log a `console.info` and are silently dropped (the script gets a natural `ReferenceError` at call time). The non-`GM_*` grants (`unsafeWindow`, `window.onurlchange`, …) don't all emit a binding — see [supported-GM-APIs.md](supported-GM-APIs.md#non-gm-grants). For the inventory of which API names are implemented vs stubbed see [supported-GM-APIs.md](supported-GM-APIs.md). |
| `@connect` | ✅ | ✓ | ✓ |   | Allowlist for `GM_xmlhttpRequest` URLs **only** — it does not gate `GM_download` (see [supported-GM-APIs.md](supported-GM-APIs.md#connect-does-not-gate-downloads); TM doesn't gate downloads on it either). **Strict-by-default**: a script with no `@connect` lines is blocked from every cross-origin request. Stricter than either reference manager: TM prompts the user for an undeclared host, and VM doesn't enforce `@connect` at all — it only shows the declared hosts on its install-confirm page. So a VM script that never bothered with `@connect` needs the tag added to work here. Forms: `*` (wildcard), `self` (script's own `@match`/`@include` hosts), `example.com` (exact host), `*.example.com` (host + any subdomain). Scheme-prefixed URLs (`https://example.com`) normalize to host. See [GM-APIs.md](GM-APIs.md#connect-url-gating-phase-10). |
| `@webRequest` | ⚪ | ✓ |   |   | TM-only, experimental, MV2 only. |

---

## External resources

| Tag | SourceMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@require` | ✅ | ✓ | ✓ | ✓ | Prefetched at load/refresh time and concatenated (in declaration order, deduped by URL) ahead of the main body in a single injected entry, so requires and the body share one lexical scope exactly as in TM/VM. An inline source map keeps per-require devtools files and original line numbers — see [requires.md](requires.md#injection). Accepts absolute `http(s)://` URLs and **relative paths** resolved against the script's parent directory, sharing rules with `@icon` (no `..` / leading `/` / absolute `file://`). TM and GM4 want an absolute URL; VM resolves relative refs against the URL the script was installed from, so the same line points at a remote directory there and at your working directory here. Resolved URL must end in `.js` (pre-query). Strict UTF-8 decode catches binary smuggled past the suffix gate; an HTML/XHTML response is rejected as the login-page soft failure it usually is, but no other Content-Type is gated. Per-require body cap: 1 MB. `tampermonkey://vendor/*` is not supported. SRI hash fragments (`#sha256=…`) are parsed but not validated — see [TODO.md](../TODO.md). |
| `@resource` | ✅ | ✓ | ✓ | ✓ | `<name> <ref>` pairs prefetched at load/refresh time and exposed via `GM_getResourceText` (UTF-8 decode) / `GM_getResourceURL` (blob: URL). Same resolution rules as `@require` but no `.js` gate — any media type works. Duplicate names: first declaration wins. TM rejects the script; VM keeps the *last* declaration silently (its parser just overwrites the key), so a duplicated resource name resolves differently under every manager. 1 MB per-resource cap. See [resources.md](resources.md). |

---

## Updates

SourceMonkey updates every script from the URL it was installed from —
a `file://` path via size+mtime, an `http(s)` URL via conditional GET.
The remote-update tags are read as *claims about an upstream copy*, not
as fetch targets: we report what they say and never update from them.
See [updates.md](updates.md).

| Tag | SourceMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@updateURL` | ✅ | ✓ |   | ✓ | Probed for its `@version`, which the viewer shows beside our own and which flags the script OUTDATED when it's ahead. Never fetched as the script body. Absolute `http(s)` only. TM and GM4 use it to fetch the latest metadata block; VM's metadata-block page doesn't list it, but VM's updater does read it — it fetches `@updateURL` for the metadata block, compares `@version`, then downloads the body from `@downloadURL` (falling back to the install URL). |
| `@downloadURL` | ✅ | ✓ | ✓ | ✓ | Same treatment as `@updateURL` — probed, never followed. Honoring it as a fetch target would let a script move its own update channel to an origin the user never approved. |
| `@installURL` | ⚪ | ✓ |   |   | TM-specific. |

---

## i18n suffixes

Any tag may carry a locale suffix, e.g. `@name:de` or `@description:fr`.
The parser keeps these on the side; `getValue(header, tag)` returns the
non-localized form, and `getLocalized(header, tag)` returns the
locale → value map.

SourceMonkey does not currently surface localized values anywhere in the
UI — the canonical (un-suffixed) value is always used.

---

## SRI hash fragments on `@require` / `@resource`

The URL may carry a `#sha256=…` (or `md5`, `sha1`, `sha384`,
`sha512`) fragment. Both `@require` and `@resource` are honored, but
the SRI fragment is parsed-and-preserved only — not yet validated.
TM documents the full syntax; VM and GM4 don't document SRI in their
metadata pages.

It is stripped from what a human reads — the viewer's tab tooltips, the
details panel's `Local overrides` tooltips, and Log lines — since a
64-hex-digit tail is most of the width of those surfaces and nothing the
reader can act on. Fetching,
resolution, dedup, storage, and error messages all keep the verbatim
reference.

## Local files in place of a declared URL

For a script loaded from `file://`, an absolute `http(s)` `@require`,
`@resource`, or `@icon` can be served from a matching file on disk
beside the script. Lets a published script keep the portable absolute
URL that other managers require while still being developed locally.
See [local-file-overrides.md](local-file-overrides.md).

---

## Anything unrecognised

The parser doesn't reject unknown tags. Anything with the shape
`// @foo bar` lands in the parsed header and can be looked up by name
later. So new tags can be supported by writing the consumer code —
the parsing layer doesn't need to change first.
