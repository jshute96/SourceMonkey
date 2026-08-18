# Importing and exporting with Tampermonkey

Everything SourceMonkey can and can't do to move userscripts between
itself and Tampermonkey — the userscript manager most users are
migrating from.

Findings below were read out of the installed Tampermonkey 5.5.0
(`background.js` / `extension.js`) unless noted. The **file formats**
are user-facing and reasonably stable; the internal method names are
not — see [Version fragility](#version-fragility).

## Why this has to be file-based

There is no channel between two Chrome extensions unless the target
opts in, and Tampermonkey doesn't.

- Its manifest declares **no `externally_connectable`** and **no
  `web_accessible_resources`**.
- Its external API (`window.external.Tampermonkey`) is gated on the
  *sender page's URL* against a hard-coded allowlist of script-hosting
  sites. An extension sender's `chrome-extension://` URL matches
  nothing.
- Even if it matched, the only methods are `getVersion`,
  `openOptions`, and `isInstalled` — nothing that reads or writes
  scripts.

So the options are: a link the user follows, and files they move.

### What Chrome blocks

Relevant because "just script their page" is the first idea everyone
has:

- **Content scripts / `chrome.userScripts`** — `matches` accepts only
  `http`, `https`, `file`, `ftp`, `urn`. `chrome-extension://` is a
  manifest validation error, and `<all_urls>` doesn't cover it.
- **`chrome.scripting.executeScript`** — fails on a tab sitting on
  another extension's page. Host permissions can't be granted for the
  scheme, so there's no permission to request.
- **`chrome.debugger`** — refuses to attach to another extension's
  targets.
- **Bookmarklets** — extension pages ship a `script-src 'self'` CSP,
  which kills `javascript:` URLs.

An extension *can* script its own `chrome-extension://<own-id>/…`
pages. That's the exception people misremember as general.

### What is left

- **A link.** Any page can navigate to
  `chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html`.
  That ID is Tampermonkey's, and it is a hash of the publisher key, so
  it is the same for every user.
- **Files.** Tampermonkey's own export/import, driven by the user.
- **External CDP** — for tests and dev tooling only; see
  [cross-manager-testing.md](cross-manager-testing.md).

## The Utilities page

`chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utils`

### Controls

Element ids are `input_<base64url(<name>_<id>)>_<suffix>` — deterministic,
identical for every user, and stable until Tampermonkey renames a
logical id.

| Control | Element id | Decoded |
|---|---|---|
| Import from file | `input_ZmlsZV91dGlscw_file` | `file_utils` |
| Zip export | `input_dXRpbHNfdXRpbHNfZV96aXA_bu` | `utils_utils_e_zip` |
| File export (`.txt`) | `input_dXRpbHNfdXRpbHNfZV9maWxl_bu` | `utils_utils_e_file` |
| TextArea export | `input_dXRpbHNfdXRpbHNfZV90YQ_bu` | `utils_utils_e_ta` |
| TextArea import | `input_dXRpbHNfdXRpbHNfaV90YQ_bu` | `utils_utils_i_ta` |
| The textarea | `textarea_dXRpbHNfdXRpbHM_ta` | `utils_utils` + `_ta` |
| URL field | `input_dXRpbHNfdXRpbHM_url` | `utils_utils` + `_url` |
| URL Install | `input_dXRpbHNfdXRpbHNfaV91cmw_bu` | `utils_utils_i_url` |
| Cloud export | `input_dXRpbHNfdXRpbHNfZV96aXA_bu` | `utils_utils_e_zip` ⚠ |
| Show backups | `input_dXRpbHNfdXRpbHNfaV9jbG91ZA_bu` | `utils_utils_i_cloud` |

⚠ The cloud and zip Export buttons **share an id** — Tampermonkey
passes `t.id + "_e_zip"` for both. Anything selecting by that id must
scope to the enclosing section (`div_dXRpbHNfdXRpbHM_sb` for zip).

The file input accepts `application/javascript`, `application/json`,
`application/zip`, `text/plain`.

### Nothing on it is link-driven

The options page parses query + hash into one bag, and reads only:

- `nav` — tab / subtab (`nav=utils`, `nav=dashboard`,
  `nav=new-user-script+editor`)
- `filter` — prefills the dashboard search box
- `tag` — filters the dashboard by tag
- `url` — base64; **only** seeds `<$URL$>` / `@match` in the new-script
  template
- `contribute`, `layout` — cosmetic

No parameter prefills the Import-from-URL field, and none triggers an
import or export. A link can land the user on the page; the click is
theirs.

### Drag-and-drop works page-wide

`extension.js` registers a **document-level** drop handler on the
options page:

```js
document.addEventListener("drop", async e => {
  const t = e.dataTransfer.files[0]; if (!t) return;
  const n = await new lr({blob: t}).toTransferableData();
  $("installFromUrl", {transferable: n});
}, true);
```

- Feeds the same importer as the file picker, with the same format
  sniffing.
- Bound to `document`, so it works on **any** Tampermonkey options
  tab, not just Utilities.
- "Drag the file onto the tab" is a better instruction than walking a
  user through a file dialog.

## Tampermonkey's import formats

### One entry point

A port method named **`importEx`**, declared `allow: {extpage: true}`
(callable from any Tampermonkey extension page). Payload:

```js
{ data, json, code, url, tfd, reload }
```

- **Import from file** → `data` (ArrayBuffer)
- **Import from textarea** → `json` / `code` (string)
- **Import from URL** → `url`; Tampermonkey fetches it itself
- **Drag-and-drop** → `tfd` (transferable blob)

The format is then inferred from content, never from how it arrived.
Each step is a `try`/`catch` around the previous:

**zip → JSON → raw userscript source**

### Zip

Roles are assigned purely by filename regex. `<base>` is the grouping
key, so `Foo.user.js` + `Foo.options.json` + `Foo.storage.json` merge
into one script.

| Filename | Role |
|---|---|
| `<base>.user.js` | Source. **Required** — a group without it is dropped as invalid |
| `<base>.options.json` | Metadata (shape below) |
| `<base>.storage.json` | `{ts, data:{…}}` — the `GM_setValue` store |
| `global.json` | Global Tampermonkey settings |
| `<base>.user.js-<hex>-<n>.requires.json` | `@require` metadata |
| `<base>.user.js-<hex>-<n>.resources.json` | `@resource` metadata |

Require / resource entries are **pairs**: the `.requires.json` file
holds only `{url, sri, ts, mimetype, modified}`, and the content lives
in a separate zip entry whose name is that filename minus the
`.requires.json` suffix. Requires are decoded UTF-8; resources stay
binary.

`options.json` is spread onto the script object at top level, so its
shape is:

```json
{ "meta":     { "name": "…", "uuid": "…", "file_url": null, "modified": 1777135224538 },
  "settings": { "enabled": true, "position": 1 },
  "options":  { "check_for_updates": true,
                "user_modified": null,
                "override": { "orig_matches": ["…"], "merge_matches": true } } }
```

### JSON blob

The `.txt` that **File → Export** produces, and what the textarea
holds.

```json
{
  "settings": { },
  "scripts": [{
    "uuid": "…", "name": "…", "file_url": null,
    "enabled": true, "position": 1,
    "options": { },
    "storage": { "ts": 0, "data": { } },
    "source": "<base64>",
    "requires":  [{ "meta": {"url": "…", "sri": null, "ts": 0,
                             "mimetype": "…", "modified": 0},
                    "source": "<base64>" }],
    "resources": [ ]
  }]
}
```

Two differences from the zip form, both easy to get wrong:

- **`source` is base64 here, plain text in the zip.** The decode is
  `decodeURIComponent(escape(atob(s)))` — base64 of the UTF-8 bytes.
  Same for require / resource sources.
- **The field layout is flat.** `uuid` / `name` / `file_url` /
  `enabled` / `position` sit on the script object, where
  `options.json` nests them under `meta` and `settings`. Tampermonkey
  normalizes both into one internal shape.

Quirk: if `JSON.parse` throws, Tampermonkey retries on the text
between the first `<body>` and last `</body>`, so a backup
accidentally saved as an HTML page still imports.

### Raw source

Anything that parses as neither goes to
`installFromSource(text, {force_url: url})` — a single-script install.

- Pasting a bare `.user.js` body into the textarea installs it.
- **Import from URL pointed at a plain `.user.js` installs that one
  script**, with no zip and no ask-page click.

## Tampermonkey's export

| Button | Produces |
|---|---|
| **Zip → Export** | `tampermonkey-backup-<id>-<iso>.zip` |
| **File → Export** | `tampermonkey-backup-<id>-<iso>.txt` (the JSON blob) |
| **TextArea → Export** | the same JSON, in the box, for copy-paste |
| **Cloud → Export** | pushes a zip to the configured Drive / Dropbox / OneDrive / WebDAV target |

Export content is governed by checkboxes whose state persists in
`localStorage`:

| Checkbox | Key | Default |
|---|---|---|
| Include script storage | `export_script_storage` | on |
| (externals — `@require` / `@resource` bodies) | `export_externals` | on |
| Include Tampermonkey settings | `export_tm_settings` | **off** |

The defaults suit a migration: script storage and externals come
along, Tampermonkey's own global config doesn't.

The dashboard's multi-select action dropdown also has an **Export**
action, for exporting a chosen subset rather than everything.

## Reading Tampermonkey's storage directly

Not a user-facing path — this is for dev tooling and cross-manager
tests. See [cross-manager-testing.md](cross-manager-testing.md).

- Tampermonkey stores scripts as **plaintext JSON in
  `chrome.storage.local`** — uncompressed, unencoded. Two entries per
  script: a metadata object (`uuid`, `header`, `matches`, `requires`,
  `resources`, `enabled`, `position`, `options.override.*`) and the raw
  source string.
- On disk that is
  `<profile>/Local Extension Settings/dhdgffkkebhmkfjojejmpbldmpobfkfo/`
  (LevelDB). Chrome holds `LOCK`, so copy the directory first, and note
  the log is uncompacted — it holds superseded generations of the same
  key. Read it with a LevelDB reader and take the last write per key;
  don't `strings`-scrape it.
- **Cleaner**: attach CDP to Tampermonkey's service worker and evaluate
  `chrome.storage.local.get(null)`. Exact data, no parsing, no lock.
- `GM_setValue` data is stored separately, keyed by script UUID. A
  migration that copies only sources is lossy for any script that
  persists state.

Two port methods, both `extpage`-allowed and therefore reachable from
a CDP session attached to Tampermonkey's options page:

- `importEx` — described above.
- `exportToJson` — `{ids, options}`; replies in `{partial}` chunks then
  `{done: true}`.

## Publishing from SourceMonkey to Tampermonkey

- **`@updateURL` / `@downloadURL` at a local server** is the only
  channel that keeps working unattended. After a one-time click-through
  install per script, Tampermonkey's periodic update check pulls every
  subsequent `@version` bump on its own. `scripts/serve-examples.mjs`
  already serves a suitable tree.
- **A `.user.js` URL** in Import-from-URL installs one script with no
  ask-page click.
- **The install prompt can't be auto-clicked** by anything in-browser —
  `ask.html` is a Tampermonkey extension page. Only external CDP can
  click it, which is what
  `tests/fixtures/tampermonkey-driver.mjs` does.

## Importing into SourceMonkey

The user-facing feature built on the formats above: an **Import** button
on the collections page, right of Add.

### The flow

- A dialog explains the two steps the user has to take in Tampermonkey,
  and links to `options.html#nav=utils` in a new tab. A link is all we
  can do — nothing on that page is parameter-driven.
- They click **File → Export** there, which saves the JSON blob as
  `tampermonkey-backup-<id>-<iso>.txt`.
- They hand that file to the dialog's file picker. Parse errors render
  inline, with the file still selected so they can retry. (The
  drag-and-drop described above is Tampermonkey's own handler, on
  Tampermonkey's page — our dialog has no drop target.)
- Success creates a collection and lands on it, same as Add.

v1 accepts the **JSON blob** only.

- A single `.user.js` is not an import — that is what the Add field
  does, and routing it here would give the same file two different
  install paths. Handing one to the dialog is an error that says to use
  Add instead.
- Zip is a follow-up: the project has no runtime dependencies, so it
  needs a hand-written reader, and the instructions steer users to
  File → Export anyway.

### One collection per import

Each run creates a collection with `path` = `import:<uuid>`.

- Not a `container:*` — those are singletons per kind, and each import
  is meant to stand alone.
- The unique path means re-importing never trips the duplicate-path
  check. It also means **repeat imports duplicate scripts**; merging on
  re-import is a follow-up, which is what `importedFrom` exists for.
- `displayName` is written explicitly (`Imported from Tampermonkey —
  <date>`) rather than inferred from the path.
- Classifies to its own `imported` bubble type.

### Pinned bytes: a collection with no scan

An import collection is the first whose content doesn't come from
anywhere fetchable.

- No scan step; `scriptIds` is the source of truth, as with containers.
- `refreshCollection` early-returns for `import:` paths, so Refresh All
  can't clobber the imported bodies.
- Per-script refresh still applies to the rows that have a location —
  see below.

### Per-script location

`fileUrl` is a non-null `string` throughout the store, and doubles as
the base for resolving `@require` / `@resource` / `@icon` refs. Imports
supply it in one of two ways:

- **Known** — TM's `file_url`, else the script's own `@downloadURL`.
  The row behaves like any other web-backed script: it refreshes, and
  the Location row links out.
  - `@updateURL` is deliberately **not** used. By convention it may
    point at a `.meta.js` — a metadata block with no body — so adopting
    it as the place to refetch from would replace the script with its
    own header on the first refresh.
- **Unknown** — a synthetic `sourcemonkey://imported/<scriptId>/<name>`.
  - Synthetic rather than empty so `new URL(ref, base)` in
    `file-loader.ts` fails a relative ref cleanly instead of throwing.
  - `isHttpUrl` / `isFileUrl` are both false for it, so local-file
    overrides skip it without needing to know about imports.
  - Update probes need their own gate, and have one. `probeTargets`
    compares a candidate against the row's own URL, so a synthetic one
    matches nothing and both `@updateURL` and `@downloadURL` would
    become live targets — leaving a pinned row wearing an OUTDATED
    badge with every control that could act on it correctly withheld.
    `probeOneScript` returns early for a pinned row instead.
  - The viewer's Location row renders "Imported from Tampermonkey — no
    external location" instead of the URL.
  - Refresh is refused rather than offered: `refreshScript` returns a
    pinned row untouched, so a button would spin and change nothing.
    The viewer's control is disabled with the reason in its tooltip;
    the "Other versions" panel omits its per-row refetch, which is what
    that panel already does for a row it can't meaningfully refetch.

**Tampermonkey-local edits stay pinned.** When TM's
`options.user_modified` is set, the user edited that body inside
Tampermonkey, and the upstream copy is not what they are running. Those
rows get the synthetic location even when a URL is available, so a
refresh can't silently overwrite the edit.

### Removing an import

An import collection has no scan, so nothing would bring a removed row
back — which makes its scripts individually removable, the same rule
containers already follow (`isSyntheticCollection`). Both the
collections page's per-row trash can and the "Other versions" panel's
allow it.

### What carries over

| From the export | Into SourceMonkey |
|---|---|
| `source` (base64) | Fed through `buildScriptFromText`, so header parse, validation, `contentHash`, matching, and parse diagnostics are judged by the same rules as a fetched script |
| `name` | Synthesized filename (`My Script.user.js`), deduped with `-2` suffixes — this is what the Filename column and log IDs render |
| `enabled` | Mirrored onto the row |
| `position` | Order within the collection |
| `storage.data` | Seeded into `gmval:<scriptId>:<key>` rows, so a script resumes with its settings rather than factory-reset |
| `uuid` | Kept in `importedFrom` for the future re-import merge |
| `requires` / `resources` bodies | **Not** used. TM stores absolute URLs, so the normal `external-files.ts` prefetch runs and the result matches every other collection |

## Version fragility

- **Stable enough to build on**: the zip layout, the JSON blob, the
  `#nav=` hash params, the extension ID, the drop handler.
- **Not stable**: `importEx` / `exportToJson`, the element ids, the
  storage key layout. These are internals of a specific build.
- Cross-manager tests pin a Tampermonkey version and should fail loudly
  on a shape change rather than silently importing nothing.
