# Userscript export formats

The backup and export formats userscript managers write, field by
field: what SourceMonkey's import reads ([import.md](import.md)) and
what its export will write.

- Covers Tampermonkey (TM) 5.5.0 and Violentmonkey (VM) 2.49.0.
- Neither publishes its format. TM's FAQ names the export methods only
  (Q106); VM's site documents none. What follows is each manager's
  observed behavior; VM's links point into its open source.
- Other managers (ScriptCat, Greasemonkey) are not covered yet.

## Tampermonkey

TM's Utilities page has export and import for each method:

| Method | Writes |
|---|---|
| File | `tampermonkey-backup-chrome-<iso>.txt`, the JSON format |
| TextArea | The same JSON, in a box for copy and paste |
| Zip | `tampermonkey-backup-chrome-<iso>.zip`, the zip format |
| Cloud | The zip format, to Drive, Dropbox, OneDrive or WebDAV |

- `<iso>` is `toISOString()` with `.` and `:` turned into `-`.
- The dashboard's multi-select **Export** action writes
  `tampermonkey_scripts.zip` for the chosen scripts, never with global
  settings.
- Scripts in TM's trash are left out.

Export checkboxes, remembered between exports:

| Checkbox | Default |
|---|---|
| Include script storage (GM values) | On |
| Include externals (`@require` / `@resource` bodies) | On |
| Include Tampermonkey settings | Off |

### JSON format

```json
{
  "created_by": "Tampermonkey",
  "version": "1",
  "scripts": [{
    "name": "My Script",
    "options": { "…": "see Per-script options" },
    "storage": { "ts": 1760000000000,
                 "data": { "theme": "sdark", "count": "n3", "cfg": "o{\"a\":1}" } },
    "enabled": true,
    "position": 1,
    "file_url": "https://greasyfork.org/scripts/1/code/My%20Script.user.js",
    "uuid": "0f8e2a4c-3b1d-4e5f-9a6b-7c8d9e0f1a2b",
    "source": "Ly8gPT1Vc2VyU2NyaXB0PT0K…",
    "requires": [{
      "meta": { "name": "jquery.min.js", "url": "https://code.jquery.com/jquery.min.js",
                "ts": 1760000000000, "mimetype": "text/javascript", "modified": null },
      "source": "LyohIGpRdWVyeS…"
    }],
    "resources": [ ]
  }],
  "settings": { "configMode": 100 }
}
```

Top level:

- `created_by` and `version` (`"1"`) identify the format.
- `settings` (global settings) is present only when included.

Per script, flat on the script object:

| Field | Holds |
|---|---|
| `name` | The script's name |
| `uuid` | TM's id for the script |
| `enabled`, `position` | On/off, and the dashboard order |
| `file_url` | The script's `@downloadURL` if it has one, else the URL it was installed from. Absent when neither |
| `source` | The script text, base64 of its UTF-8 bytes |
| `options` | Per-script options and overrides ([below](#per-script-options)) |
| `storage` | `{ts, data}`: GM values ([below](#gm-value-encoding)). `{ts: 0, data: {}}` when excluded |
| `requires`, `resources` | Dependency bodies: `[{meta, source}]` |

- `requires` / `resources`:
  - Absent when the script declares none; `[]` when it declares some but
    externals were excluded.
  - `meta`: `name` (the URL's last path segment, not the `@resource`
    name), `url` (absolute), `sri` (when set: the
    Subresource Integrity hash from the URL's `#sha256=…` fragment, which
    the body must match), `ts` (fetch time),
    `mimetype`, `modified` (when the user edited the body in TM).
  - A require's `source` is base64 of UTF-8 text.
  - A resource's `source` is **double-encoded**: each byte is taken as a
    character, that string is UTF-8 encoded, then base64. Decode with
    `atob`, UTF-8 decode, then each character code is a byte.
- The JSON has no last-modified time; the zip does.
- The `@icon` file is not exported, in either format; TM refetches it
  from the header's URL.

### Zip format

The same data, one file per piece. Text entries are plain, not base64.

```
My Script.user.js
My Script.options.json
My Script.storage.json
My Script.user.js-<md5>-jquery.min.js
My Script.user.js-<md5>-jquery.min.js.requires.json
Tampermonkey.global.json
```

| Entry | Holds |
|---|---|
| `<name>.user.js` | The script text. The entry's date is its last-modified time |
| `<name>.options.json` | `{options, settings: {enabled, position}, meta: {name, uuid, modified, file_url}}` |
| `<name>.storage.json` | `{ts, data}`, always written |
| `<name>.user.js-<md5>-<basename>` | A dependency's body: UTF-8 text for a require, raw bytes for a resource |
| `…requires.json` / `…resources.json` | That dependency's `meta`, beside its body |
| `Tampermonkey.global.json` | Global settings, when included |

- `<name>` is the script's name with `\ / $ * ? |` turned into `-`;
  duplicates get ` (1)`, ` (2)`.
- `<md5>` is the MD5 of `"requires"` or `"resources"` followed by the
  dependency's URL.
- `meta.modified` is the script's last-modified time, in ms.

### Per-script options

`options` carries TM's per-script settings. `null` means "use the
header's value".

| Key | Holds |
|---|---|
| `check_for_updates` | Whether TM checks for updates |
| `user_modified` | When the body was edited in TM (ms), or `null` |
| `comment` | The user's note |
| `run_at`, `run_in`, `noframes` | User overrides of `@run-at`, the tab types it runs in, `@noframes` |
| `sandbox`, `unwrap` | From `@sandbox` / `@unwrap` |
| `tags` | The user's tags |
| `compat_*`, `compatopts_for_requires` | Compatibility switches |
| `override` | Match overrides, below |

`override` holds, for each of `includes`, `matches`, `excludes` and
`connects`:

- `orig_<kind>`: the header's values when installed.
- `use_<kind>`: the user's additions.
- `merge_<kind>`: whether the header's values still apply.

Plus `use_blockers` (denied `@connect` hosts), `orig_run_at`,
`orig_run_in`, `orig_noframes` and `orig_tags`.

### Import

TM's import reads any of its formats, or a bare `.user.js`, whichever
way it arrives. It tries zip, then JSON, then a single userscript.

- JSON that fails to parse is retried on the text between `<body>` and
  `</body>`, so a backup saved as a web page still imports.
- Zip entries are recognized by suffix; any `*.global.json` is global
  settings.
- **Matching:** by `uuid`. A uuid TM doesn't have installs a new script
  with it, even when one with the same name and namespace exists.
  Name + namespace is used only when the uuid is missing.
- One confirmation page lists every script as Install, Update,
  Reinstall, Downgrade or Overwrite. Checkboxes per script: import, its
  storage, its externals. All on by default.
- Applied as given: on/off, position, options (overriding what the
  header says), last-modified time.
- Storage **replaces** the script's existing values, unless the file's
  is empty.
- Externals are cached by URL; `sri` and `ts` are dropped.
- Global settings, when present and checked, replace TM's whole config.

## Violentmonkey

VM exports one format: a zip, written by **Export to zip** on its
Settings tab ([vm-export.vue](https://github.com/violentmonkey/violentmonkey/blob/master/src/options/views/tab-settings/vm-export.vue)).

- Named `[violentmonkey]_YYYY-MM-DD_HH.mm.ss.zip` by default; the name
  is a setting.
- One option: **Export script data** (GM values), on by default.
  Settings are always included.
- Scripts in VM's trash are left out.
- `@require` / `@resource` bodies and icons are never included.

```
[violentmonkey]_2026-10-17_14.03.22.zip
├── violentmonkey
└── My Script.user.js
```

- `<name>.user.js`: the script text, at the zip root.
  - `<name>` is the user's name for the script, else its `@name`
    localized to VM's UI language.
  - `\ / : * ? " < > |` become `-`; duplicates get `_2`, `_3`.
  - The entry's date is the script's last update time.
- `violentmonkey` (no extension): the metadata, as JSON.

### The `violentmonkey` entry

```json
{
  "scripts": {
    "My Script": {
      "custom": {
        "match": ["https://example.org/*"], "origMatch": true,
        "tag": ["work"], "runAt": "document-idle",
        "lastInstallURL": "https://greasyfork.org/scripts/123/code/My%20Script.user.js"
      },
      "config": { "enabled": 1, "shouldUpdate": 1, "removed": 0, "notifyUpdates": null },
      "position": 1,
      "lastModified": 1760700000000,
      "lastUpdated": 1760600000000
    }
  },
  "settings": { "version": "2.49.0", "exportValues": true },
  "values": {
    "https-3a-2f-2fexample.com-0aMy-20Script-0a": { "count": "n42", "name": "sBob" }
  }
}
```

- `scripts` is keyed by the zip entry's name without `.user.js`.
- `settings` is all of VM's options except sync credentials.
- `values` is present when **Export script data** is on.
- There is no format version. Older exports used flat `enabled` /
  `update` keys per script, which VM still reads.
- No script id is exported. Scripts are identified only by `@namespace`
  + `@name`.

Per script:

| Field | Holds |
|---|---|
| `custom` | The user's overrides, below |
| `config.enabled` | 0 or 1 |
| `config.shouldUpdate` | 0, 1, or 2 (update and keep local edits) |
| `config.notifyUpdates` | 0, 1, or `null` (use the global setting) |
| `config.httpOnly`, `config.noCmdNames` | Cookie access and a menu display flag |
| `position` | The dashboard order |
| `lastModified`, `lastUpdated` | Last edit and last update, in ms |

`custom` keys:

- `name`: the user's name for the script.
- `downloadURL`, `updateURL`, `homepageURL`: user overrides.
- `lastInstallURL`: where it was installed from.
- `include`, `match`, `exclude`, `excludeMatch`: the user's lists.
- `origInclude`, `origMatch`, `origExclude`, `origExcludeMatch`,
  `origTag`: whether the header's values still apply (default true).
- `runAt`, `noframes`, `injectInto`: overrides of the header's values.
- `tag`, `comment`, `icon`.
- `pathMap`: relative dependency URLs resolved to absolute ones.

### Values keys

`values` is keyed by a script's `@namespace` + `@name`, encoded as a
filename:

- The key is `"<namespace>\n<name>\n"` with each of
  `` -\/:*?"<>|% `` and whitespace turned into `-` plus its two-digit hex
  code.
- So namespace `https://example.com` and name `My Script` give
  `https-3a-2f-2fexample.com-0aMy-20Script-0a`.

### Import

**Import from zip** on VM's Settings tab, or a zip dropped on that tab.

- Reads any zip of `.user.js` files, with or without a `violentmonkey`
  entry, at any folder depth.
- Also reads TM's zip (`.options.json`, `.storage.json`) but not TM's
  JSON format, and ignores TM's global settings and dependency bodies.
- Checkboxes: **Import script data** and **Import settings**, both on by
  default.
- **Undo:** VM snapshots all its storage first and can restore it.
- **Matching:** by `@namespace` + `@name`. A match is updated in place,
  never duplicated.
- Dependencies are refetched from the network.
- Values **replace** the matching script's whole store, including a
  script already installed whose code wasn't in the zip.
- From TM's options VM maps on/off, update checking, `file_url` (as
  `downloadURL`), tags, comment, `noframes`, `run_at`, and the
  include / match / exclude overrides.
- TM's values are passed through as written. TM's encoding is close to
  VM's but not the same (below).

## GM value encoding

Both managers store each value as a string: a type letter, then the
value.

| Letter | Type | Example | TM | VM |
|---|---|---|---|---|
| `s` | String | `sdark` | Yes | Yes |
| `n` | Number | `n42` | Yes | Yes |
| `b` | Boolean | `btrue` | Yes | Yes |
| `o` | Object, array or `null`, as JSON | `o{"a":1}` | Yes | Yes |
| `u` | `undefined` | `uundefined` | Yes | No (deletes the key) |
| `x` | Legacy: base64 of UTF-8 JSON | | Read only | No |

- TM writes the same letters as VM, plus `u`, and reads a legacy `x`.
- An importer has to decode these; storing `sdark` as the value would
  hand the script the string `sdark` instead of `dark`.

## SourceMonkey

SourceMonkey's export is TM's zip layout, which TM and VM can both
import. SourceMonkey adds a `script_manifest.json`, which only it reads.

- The manifest carries what only SourceMonkey uses: collections, each
  script's location, and the script's own on/off flag.
- It is also an ordinary SourceMonkey manifest
  ([http-collections.md](http-collections.md)). Unzipped, the folder
  can be added as a manifest collection, which loads every script in it.
- Named `sourcemonkey-backup-<iso>.zip`, like TM's.
- Written for all collections, or for one.
- sm-dev's test collections are never exported.

```
sourcemonkey-backup-2026-10-17T12-34-56-789Z.zip
├── script_manifest.json
├── My Script.user.js
├── My Script.options.json
├── My Script.storage.json
└── code.jquery.com/
    └── jquery.min.js
```

| Entry | Holds | Read by |
|---|---|---|
| `script_manifest.json` | The format marker, the exported collections, and one entry per script | SourceMonkey |
| `<name>.user.js` | The script text, plain UTF-8 | All three |
| `<name>.options.json` | TM's per-script metadata | All three |
| `<name>.storage.json` | GM values, as `{ts, data}` | All three |
| `<host>/<path>` | A dependency or icon file, when included | SourceMonkey |

- `<name>` is the script's `@name` with each character TM or VM would
  replace (`\ / : * ? " < > | $`) turned into `-`. Duplicates get
  ` (2)`, ` (3)`.
- A script with no stored values gets no `.storage.json`.
- Why it is safe for the other managers:
  - TM sets aside zip entries it doesn't recognize, and ignores keys it
    doesn't read.
  - VM reads only `.user.js`, `.options.json`, `.storage.json` and its
    own `violentmonkey` entry.
  - None of the extra entries end in `.global.json`, which TM would
    take as its settings.

### `script_manifest.json`

```json
{
  "created_by": "SourceMonkey",
  "format": "sourcemonkey-export",
  "version": 1,
  "exported_at": 1760700000000,
  "collections": [
    {
      "uuid": "5d1c2b9e-8f3a-4c6d-9e2b-1a7f0c4d8e6b",
      "name": "My scripts",
      "kind": "directory",
      "location": "/home/me/userscripts",
      "enabled": true,
      "local_files": true
    },
    {
      "uuid": "b2e4f6a8-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
      "name": "Scripts from web",
      "kind": "scripts",
      "builtin": "http",
      "location": null,
      "enabled": true,
      "local_files": false
    }
  ],
  "scripts": [
    {
      "path": "My Script.user.js",
      "uuid": "0f8e2a4c-3b1d-4e5f-9a6b-7c8d9e0f1a2b",
      "collection": "b2e4f6a8-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
      "location": "https://greasyfork.org/scripts/1/code/My%20Script.user.js",
      "enabled": true
    }
  ]
}
```

- `version` changes only when an older importer would misread the file.
  New optional fields don't change it.
- `exported_at` is in ms.
- A manifest collection reads only `scripts[].path` and ignores the
  rest.

Per collection, in the collections page's order:

| Field | Holds |
|---|---|
| `uuid` | The collection's id |
| `name` | The name it shows |
| `kind` | `directory`, `manifest` or `scripts` |
| `location` | The folder, manifest URL or path, or GitHub URL it loads from. `null` for a scripts collection |
| `builtin` | For a built-in scripts collection: `file`, `http` or `github`. Absent otherwise |
| `enabled` | The collection's on/off |
| `local_files` | Whether local files stand in for its `@require` / `@resource` URLs |

Per script, in each collection's order:

| Field | Holds |
|---|---|
| `path` | Its `.user.js` entry, relative to the manifest. Its other entries share the name |
| `uuid` | Its SourceMonkey id; the same as `meta.uuid` in its `.options.json` |
| `collection` | The `uuid` of its collection |
| `location` | Where it loads from: a URL, or an absolute file path. `null` for an imported script with no location |
| `enabled` | Its own flag, whatever its collection's |

### `.options.json`

TM's structure, filled in so TM and VM run the script as SourceMonkey
does.

```json
{
  "meta": {
    "name": "My Script",
    "uuid": "0f8e2a4c-3b1d-4e5f-9a6b-7c8d9e0f1a2b",
    "modified": 1760600000000,
    "file_url": "https://greasyfork.org/scripts/1/code/My%20Script.user.js"
  },
  "settings": { "enabled": true, "position": 1 },
  "options": { "check_for_updates": true }
}
```

| Field | Holds |
|---|---|
| `meta.name` | The script's `@name` |
| `meta.uuid` | The script's SourceMonkey id, a version 4 UUID. Stable across exports, so a re-import into TM updates the same script |
| `meta.modified` | When its current content was loaded, in ms |
| `meta.file_url` | Its location when that is an http(s) URL, so TM and VM update from it. Absent for a local file or a script with no location |
| `settings.enabled` | Whether it is active: its own flag and its collection's both on. TM and VM have no collections, so this decides whether it runs there |
| `settings.position` | Its place in the export: collections in page order, scripts in each collection's order |
| `options.check_for_updates` | True when `file_url` is set |

- `options` is required: VM skips a script without it.
- No `options.override`: TM would take empty `orig_*` lists as the
  script's real match rules and run it nowhere. Without it, both TM and
  VM use the header's rules.

### `.storage.json`

```json
{ "ts": 1760700000000, "data": { "theme": "sdark", "count": "n3", "cfg": "o{\"a\":1}" } }
```

- `ts` is the export time.
- Values use the letters both managers read: `s`, `n`, `b`, `o`
  ([GM value encoding](#gm-value-encoding)).

### Dependency bodies

An export option: the `@require`, `@resource` and `@icon` files each
script holds, so an import works offline and survives a dead URL.

- Each body is written to `<host>/<path>` of its declared URL, beside
  the scripts: the layout local copies use
  ([local-copy.md](local-copy.md#layout-mirror-the-url-beside-the-script)).
  - That is the first place the local-file overrides look
    ([local-file-overrides.md](local-file-overrides.md#the-rule)), so
    the unzipped folder, added as a manifest collection with local
    files on, runs every script on the bundled bodies.
  - Scripts sharing a library share one file.
  - A name that can't be written (a `host:port` folder) falls back to
    the next-shorter suffix, as local copies do.
- `file://` dependencies are written too, since the export may be
  opened on a machine that doesn't have them.
  - Written at their path (`/home/me/lib/util.js` as
    `home/me/lib/util.js`). A `file://` URL has no host, so its path is
    the longest suffix the overrides try.
- A `data:` icon is left out: it is in the header itself.
- The local-file overrides treat all three alike
  ([local-file-overrides.md](local-file-overrides.md#every-file-a-script-declares-is-treated-alike)),
  so a bundled icon stands in for its URL too. (Local copies leave
  `@icon` out; the export doesn't.)
- No `@require` line is rewritten, so the scripts keep their published
  URLs.

TM's own layout (`<name>.user.js-<md5>-<basename>` plus a
`.requires.json` beside it) is not written:

- TM finds a body only by that exact name, beside its meta file, so it
  can't share the `<host>/<path>` files.
- Without them TM refetches each dependency, as VM always does.
- Writing both would store each body twice. See
  [Possible enhancements](#possible-enhancements).

## Comparison

| | TM JSON | TM zip | VM zip | SM zip |
|---|---|---|---|---|
| Format marker | `created_by`, `version` | Zip comment, filenames | The `violentmonkey` entry | `script_manifest.json` |
| Script text | base64 | Plain | Plain | Plain |
| Script id | `uuid` | `uuid` | None | `uuid` |
| On/off, order | Yes | Yes | Yes | Yes, plus the script's own flag |
| Install / update URL | `file_url` | `file_url` | `lastInstallURL`, `downloadURL`, `updateURL` | `file_url`, plus any location |
| Last modified | No | Yes | Yes | Yes |
| User match overrides | `options.override` | Same | `custom` | No |
| Run-at, noframes overrides | Yes | Yes | Yes | No |
| Tags, comment | Yes | Yes | Yes | No |
| Collections | No | No | No | Yes |
| GM values | Per script, prefixed | Per script, prefixed | Keyed by namespace + name, prefixed | Per script, prefixed |
| Dependency bodies | Optional | Optional | Never | Optional, as local-override files |
| Icon file | No | No | No | Optional, with the dependencies |
| Global settings | Optional | Optional | Always | No |
| Import matches by | uuid, else namespace + name | Same | namespace + name | See [import.md](import.md) |
| Import on a match | Replaces | Replaces | Replaces in place | The user chooses in the preview |
| Read by | TM | TM, VM | VM | TM, VM, SM |

## Possible enhancements

- **A zip file as a collection,** the way a directory is one.
  - A backup from SourceMonkey or another manager could then be loaded
    as it is, without unzipping.
  - With a `script_manifest.json` at the top, the zip loads as that
    manifest; otherwise it is scanned for `.user.js` files, as a
    directory is.
- **Dependencies in TM's layout,** so TM imports them too
  (`<name>.user.js-<md5>-<basename>` plus `.requires.json` /
  `.resources.json`). To avoid storing each body twice, SourceMonkey
  would read that layout as well, by either:
  - teaching the local-file overrides to find files named that way, or
  - having the manifest say which layout its dependency files use.
