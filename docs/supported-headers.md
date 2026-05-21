# Supported Userscript Headers

Catalogue of every `// @tag value` line VibeMonkey is likely to
encounter, what it does, and how completely we honor it.

The parser in [`src/userscript-header.ts`](../src/userscript-header.ts)
is intentionally generic — it accepts any `@tag` line, lowercases the
tag, and stashes the value. Whether a tag actually changes behavior
depends on which downstream module asks for it. This page is the
inventory of which tags downstream modules consult today.

## Status legend

| Symbol | Meaning |
|:------:|---------|
| ✅ | **Honored** — VibeMonkey reads the value and changes behavior accordingly. |
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

---

## Identity and display

| Tag | VibeMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@name` | ✅ | ✓ | ✓ | ✓ | Required (validation rejects scripts with no `@name`). Used as the display label and in injection logs. Locale suffixes like `@name:de` are parsed but the non-localized form always wins. |
| `@namespace` | ⚪ | ✓ | ✓ | ✓ | TM/VM/GM combine it with `@name` as a unique storage key. VibeMonkey keys scripts by their UUID, so this has no effect here. |
| `@version` | ⚪ | ✓ | ✓ | ✓ | Other managers use this for update comparison. VibeMonkey reloads from disk by `size+mtime` and has no separate version check. |
| `@description` | 👁 | ✓ | ✓ | ✓ | Shown in the userscript viewer summary. |
| `@author` | ⚪ | ✓ |   |   | Not part of VM's or GM4's documented tag set (GM explicitly notes it's "ignored but readable" — i.e. preserved in source, not honored as metadata). |
| `@copyright` | ⚪ | ✓ |   |   | TM-only per docs. |
| `@homepage` / `@website` / `@source` | ⚪ | ✓ |   |   | TM treats these as aliases for `@homepageURL`. VM and GM4 don't document the aliases — only `@homepageURL` (VM) or nothing (GM4). |
| `@homepageURL` | ⚪ | ✓ | ✓ |   | The canonical form. Links the "home" icon in TM/VM's script list. |
| `@supportURL` | ⚪ | ✓ | ✓ |   | Links the "?" icon in TM/VM's script list. |
| `@icon` | ✅ | ✓ | ✓ | ✓ | Used as the favicon shown beside the script in the options/viewer UI. Overrides the origin-discovered favicon when set. Only absolute http(s) and `data:` URLs are accepted — relative hrefs are rejected (no consistent base to resolve them against). |
| `@iconURL` / `@defaulticon` | ✅ | ✓ |   |   | TM-only aliases of `@icon`; consulted in that priority order. |
| `@icon64` / `@icon64URL` | ✅ | ✓ |   |   | 64×64 variant; TM-only per docs. Lower priority than the regular `@icon` variants since our display target is 16×16. |
| `@tag` (categorization) | ⚪ | ✓ (5.0+) | ✓ |   | Labels for organising scripts in the dashboard. Distinct from "the metadata tag concept" generally. |
| `@antifeature` | ⚪ | ✓ |   |   | Monetisation/tracking disclosure. TM documents it; VM and GM4 don't. Widely used by GreasyFork tooling regardless. |
| `@license` | ⚪ |   |   |   | Not documented by any of TM/VM/GM4. Used in practice by source-sharing sites (OpenUserJS, GreasyFork) as plain metadata. |

---

## URL matching

See [matching.md](matching.md) for full semantics. All four patterns
below can repeat; order doesn't matter.

| Tag | VibeMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@match` | ✅ | ✓ | ✓ | ✓ | Passed verbatim to `chrome.userScripts.register({ matches })`. Uses Chrome's match-pattern grammar (`<scheme>://<host><path>`). |
| `@include` | ✅ | ✓ | ✓ | ✓ | Glob form (`*://example.com/*`) goes to `includeGlobs`. Regex form (`/^https:\/\/…$/`) goes to a wrapper-side filter — see [injection.md](injection.md#regex-pattern-forms). At least one `@match` or glob `@include` is required (a script with only regex `@include`s registers as `<all_urls>` and filters at runtime). |
| `@exclude` | ✅ | ✓ | ✓ | ✓ | Glob form → `excludeGlobs`. Regex form → wrapper-side filter. |
| `@exclude-match` | ⚪ |   | ✓ |   | VM-specific: the match-pattern-grammar counterpart to `@exclude` (which in VM's model is the legacy glob/regex form). VibeMonkey treats every `@exclude` value as either a glob or a regex regardless of which tag introduced it, so a script written for VM that uses `@exclude-match` will currently be ignored. Easy to add when needed: route both tags into the same `excludes` list. |

---

## Execution control

| Tag | VibeMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@run-at` | ✅ | ✓ | ✓ | ✓ (partial) | Mapped to Chrome's `runAt`. `document-start` and `document-body` both become `document_start` (Chrome has no body-only stage). `document-end` → `document_end`. `document-idle` (default) → `document_idle`. **Not supported:** `context-menu` — falls through to `document_idle`. GM4 docs warn only `document-end` is reliable there. |
| `@inject-into` | ✅ |   | ✓ |   | VM-specific. `page` → MAIN world. `content` → USER_SCRIPT (isolated) world. `auto` / unset falls through to `@grant` (see [injection.md → Execution world](injection.md#execution-world)). TM uses `@sandbox` for the same purpose. |
| `@noframes` | ⚪ | ✓ | ✓ | ✓ | Should map to Chrome's `allFrames: false`. Currently every script runs in the top frame only because we don't set `allFrames` at all, so this happens to be the right behavior *by accident* — but a script that wants the opposite (also run in frames) can't get it. |
| `@run-in` | ⚪ | ✓ (5.3+) |   |   | Normal vs incognito vs Firefox containers. TM-only. |
| `@sandbox` | ⚪ | ✓ (4.18+) |   |   | TM's world-selector. VibeMonkey uses `@inject-into` instead, mirroring VM. |
| `@unwrap` | ⚪ | ✓ | ✓ |   | Inject the body without our activation/error shim. We always wrap — see [injection.md](injection.md#the-activation--error-wrapper). |
| `@top-level-await` | ⚪ | ✓ | ✓ |   | Allows `await` at the top level of the body. Chrome's userScripts API doesn't accept module mode, so this can't be honored without a bridge. |

---

## GM_* API access

| Tag | VibeMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@grant none` | ✅ | ✓ | ✓ | ✓ | Drives `resolveWorld` → MAIN. Multiple `@grant none` lines are accepted. |
| `@grant <anything else>` | ⚪ | ✓ | ✓ | ✓ | Drives `resolveWorld` → USER_SCRIPT, but **no `GM_*` shim is actually installed**, so the script will throw `GM_setValue is not defined` (or similar) on first call. Implementing the bridge is in [TODO.md](../TODO.md). Common values: `GM_setValue`, `GM_getValue`, `GM_deleteValue`, `GM_listValues`, `GM_xmlhttpRequest`, `GM_addStyle`, `GM_setClipboard`, `GM_notification`, `GM_openInTab`, `GM_registerMenuCommand`, `GM.info` / `GM_info`, `unsafeWindow`, `window.close`, `window.focus`, `window.onurlchange`, and the `GM.*` promise-style equivalents. GM4 only ships the `GM.*` promise forms. |
| `@connect` | ⚪ | ✓ |   |   | Whitelist for `GM_xmlhttpRequest`. TM documents it; VM's metadata page doesn't (VM may still accept it). GM4 has no equivalent. Moot for VibeMonkey until `GM_xmlhttpRequest` exists. |
| `@webRequest` | ⚪ | ✓ |   |   | TM-only, experimental, MV2 only. |

---

## External resources

| Tag | VibeMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@require` | ⚪ | ✓ | ✓ | ✓ | Should fetch the URL and prepend (or add as a separate `js:` entry). Not implemented — see [TODO.md](../TODO.md). TM additionally accepts SRI hash syntax (`#sha256=…`) and `tampermonkey://vendor/*` shortcuts. |
| `@resource` | ⚪ | ✓ | ✓ | ✓ | Companion to `GM_getResourceText` / `GM_getResourceURL`. Moot until those exist. |

---

## Updates

VibeMonkey reloads scripts from a local `file://` directory, so the
classic remote-update tags don't apply directly. They're harmless if
present.

| Tag | VibeMonkey | TM | VM | GM | Notes |
|-----|:----------:|:--:|:--:|:--:|-------|
| `@updateURL` | ⚪ | ✓ |   | ✓ | TM and GM4 use this to fetch the latest metadata block. VM doesn't document a separate update URL — it uses `@downloadURL` for both download and update checks. |
| `@downloadURL` | ⚪ | ✓ | ✓ | ✓ | URL to fetch the full script. |
| `@installURL` | ⚪ | ✓ |   |   | TM-specific. |

---

## i18n suffixes

Any tag may carry a locale suffix, e.g. `@name:de` or `@description:fr`.
The parser keeps these on the side; `getValue(header, tag)` returns the
non-localized form, and `getLocalized(header, tag)` returns the
locale → value map.

VibeMonkey does not currently surface localized values anywhere in the
UI — the canonical (un-suffixed) value is always used.

---

## SRI hash fragments on `@require` / `@resource`

The URL may carry a `#sha256=…` (or `md5`, `sha1`, `sha384`, `sha512`)
fragment. Since `@require` / `@resource` are not yet honored, the
fragment is also ignored. TM documents the full syntax; VM and GM4
don't document SRI in their metadata pages.

---

## Anything unrecognised

The parser doesn't reject unknown tags. Anything with the shape
`// @foo bar` lands in the parsed header and can be looked up by name
later. So new tags can be supported by writing the consumer code —
the parsing layer doesn't need to change first.
