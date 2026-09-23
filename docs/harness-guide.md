# Testing userscripts with the SourceMonkey harness

See [harness-design.md](harness-design.md) for how it works and why.

For a repo of userscripts that wants to probe sites, run a script under
development, and write regression tests, using SourceMonkey's own code
for the manager's half of the picture.

## What you get

- **The manager's semantics without the extension.** Your script runs
  behind SourceMonkey's real injected code: the header is validated,
  `@match` / `@include` / `@exclude` decide whether it runs, `@run-at`
  is honored, `@require` files load (with local copies overriding
  GitHub URLs the way the extension does), `@grant` decides which
  `GM_*` names exist, and the script lands in the same world (page or
  isolated) it would in Chrome.
- **Real `GM_*` behavior.** Storage with the real value codec and
  cross-page broadcast, `GM_xmlhttpRequest` gated by `@connect`, menu
  commands you can fire from a test, tab opens and notifications you
  can inspect.
- **The script's own reports.** Whether it started, was skipped for a
  URL miss, or threw, attributed the same way the extension's Log tab
  does.
- **A command-line loop** for interactive development, and a
  Playwright fixture for specs.
- **A switch to the real extension** for the cases only Chrome can
  answer.

## What you need

- Node 22+ and pnpm.
- A Chromium that Playwright can reach. Either let Playwright launch
  one, or start one yourself with a remote-debugging port and connect
  to it (the `userscripts` repo does the latter so Google sign-in
  works).
- For the extension backend only: that browser started with
  `--load-extension=<path to SourceMonkey's dist>`.

## Install

```sh
pnpm add -D github:jshute96/SourceMonkey#v0.x
```

Two things pnpm needs to be told, in your repo:

```yaml
# pnpm-workspace.yaml — SourceMonkey builds itself on install, and pnpm
# runs a dependency's build only for packages the project allows. The
# key is the dependency spec as the lockfile records it; pnpm prints
# the one it wants if this is wrong.
allowBuilds:
  "sourcemonkey@git+https://github.com/jshute96/SourceMonkey.git#<sha>": true
```

```json
{ "dependenciesMeta": { "sourcemonkey": { "injected": true } } }
```

The second matters when you install from a checkout on disk
(`file:../SourceMonkey`, while working on both). A plain symlink
would leave the package resolving its own Playwright instead of yours,
and Playwright refuses to run with two copies loaded. `injected` copies
it into your project's store instead, where the peer resolves to your
copy. Re-run `pnpm install` after rebuilding SourceMonkey, since the
copy is taken at install time.

The package is written as ES modules (ESM: files that use `import` /
`export`, the standard module system, rather than CommonJS's
`require()` / `module.exports`). A CommonJS spec can't `require()` it
reliably, so write specs and fixtures as ESM: name them `.mjs`, or set
`"type": "module"` in `package.json` so plain `.js` files count.
Playwright runs either kind. Type declarations ship with the package,
so a TypeScript spec gets types without extra setup; keep
`skipLibCheck` on, since some declarations mention Chrome's extension
types.

## The interactive loop: `sm-dev`

`sm-dev` is the harness's command-line tool. Installing the package
puts it on your project's path (it is the package's `bin`, so pnpm
links it into `node_modules/.bin`), which means `pnpm sm-dev …` in a
project that depends on SourceMonkey, or `pnpm exec sm-dev …`. In a
SourceMonkey checkout it is `scripts/sm-dev`.

It connects to a running browser over CDP (`--cdp
http://127.0.0.1:9233`, or the `SM_DEV_CDP` environment variable) and
drives it. Everything it prints is plain text meant to be read by a
person or an agent.

| Command | What it does |
| --- | --- |
| `sm-dev run <script.user.js> [--url U]` | Opens a tab at `U` (default: the first URL the script's `@match` implies), injects the script as it is on disk, and streams the script's console lines, page errors, and start / skipped / error reports until Ctrl-C, or for `--seconds N`. |
| `sm-dev run ... --watch` | Same, and re-injects plus reloads on every save of the script or a `@require`d file. |
| `sm-dev run a.user.js b.user.js` | Injects several scripts into the same page, for interaction tests. |
| `sm-dev probe <url> --selectors 'a, b, c'` | Reports which selectors resolve on the page, so a broken script's assumptions can be checked in one call. `--html` prints the first match's HTML. Exits 1 when any is missing. |
| `sm-dev match <script> <url>...` | Says whether the script would run on each URL, and which rule decided. |
| `sm-dev validate <path>...` | The install-time checks (header, `@require`, syntax) over files or directories, with the message the extension would show. |
| `sm-dev snapshot <url> --out file.html` | Saves the live DOM so a spec can run against it without a login. The site's own scripts are disabled in the file, so what a spec gets is the captured page, not a page that logs itself out again. |

Options for `validate` and `match`:

- `--root DIR` names the repo root, searched for local copies of
  `@require` URLs the way the extension searches a collection's
  directory. Defaults to the current directory.
- `--local DIR` adds another directory to that search; repeatable.

Options for the browser commands (`run`, `probe`, `snapshot`):

- `--cdp URL` names the browser to connect to. Defaults to the
  `SM_DEV_CDP` environment variable, then `http://127.0.0.1:9233`.
- `--launch` starts a Chromium instead of connecting to one, and
  `--headed` shows it. Useful when no browser is running and the page
  needs no login.

Other `run` flags:

- `--values '{"key": 1}'` seeds `GM_*` storage before the script runs.
- `--fire-menu "Label"` invokes a registered menu command once the
  page has loaded. For anything beyond one invocation, use the typed
  commands below.
- `--seconds N` stops after N seconds, for a bounded check from a
  script or an agent; without it the stream runs until Ctrl-C.
- `--extension` uses the real extension in that browser instead of
  the built-in stand-in (see below); `--solo` silences the other
  collections for the run.

### Driving the script while it runs

A script's interesting moments are not all at startup: a menu command
may need firing twice, or only once some state exists, and what the
script stored is worth reading between steps. So `run` also reads
commands from its own input while it streams.

| Typed command | What it does |
| --- | --- |
| `menu` | Lists the menu commands the script registered |
| `menu <label>` | Fires one, as picking it from the toolbar would. Waits a moment for a script that is still loading |
| `values` | Prints everything the script has stored |
| `get <key>` | Prints one stored value |
| `set <key> <json>` | Stores a value, as another tab's write would: a running script sees it and its change listeners fire |
| `reload` | Reloads the page |
| `open <url>` | Navigates to another page |
| `help`, `quit` | The list, and stop |

A read waits out the page's write batching first, so `menu Bump`
followed by `values` prints what the command just stored rather than
what was there before it.

Piping works as well as typing, which is how an agent drives a
sequence:

```sh
printf 'menu Bump\nvalues\nquit\n' | sm-dev run sites/x/y.user.js --seconds 30
```

### What the output looks like

```
[sm-dev] injected sites/example.com/add-button.user.js: world USER_SCRIPT, run-at document-idle
[sm-dev] opening https://example.com/items/42
[sm-dev] Add button started on https://example.com/items/42
[page log] [add-button] toolbar found, button inserted
[sm-dev] GM_setValue lastItem = "42"
```

A page the header does not cover prints the rule that kept the script
off it (`skipped on <url>: No @match or @include covers this URL`) and
nothing runs. A header problem prints the same wording the extension's
viewer would, and nothing is injected.

## Writing specs: the Playwright fixture

```js
import { test, expect } from 'sourcemonkey/harness';

test('adds the button to the toolbar', async ({ page, loadUserscript, gm, reports }) => {
  await loadUserscript('sites/example.com/add-button.user.js', {
    values: { units: 'metric' },
  });
  await page.goto('https://example.com/items/42');
  await expect(page.locator('#add-button')).toBeVisible();
  expect(reports.errors()).toEqual([]);
  expect(await gm.get('lastItem')).toBe('42');
});
```

What the fixture provides:

| Name | Purpose |
| --- | --- |
| `loadUserscript(path, options?)` | Prepares the file with the real pipeline and attaches it to `page` (before the navigation that should see it). A relative path is taken from the Playwright config's root. Options: `values` to seed storage, `url` to check the match now and throw if it misses, `copy` to load the same file again as a second installed copy (its own id and storage), `collectionRoot` and `localRoots` for `@require` lookups (default: the config's root). Throws with the extension's own message if the script is invalid. Call it twice for two scripts on one page. |
| `gm` | `get(key)`, `set(key, value)` (reaches a running script like another tab's write), `list()`, `menuCommands()`, `fireMenu(label)`, `openedTabs()`, `notifications()`, `clickNotification(requestId)`, `closeNotification(requestId)`, `downloads()`, `requests()`, `failHosts(...hosts)` (a synthetic 503 for those hosts, to force a fallback path), `interceptRequests(fn)` (answer any request from the test). Values and commands are per script; when several are loaded, name one by the path it was loaded from, its basename, or its `@name`. |
| `reports` | `started()`, `skipped()` (with the rule that missed), `errors()` (message and stack). `await reports.waitForStart()` is the usual gate before interacting; when nothing starts it says which script was skipped where, and why. |
| `serveSnapshot(file, url, { block? })` | Routes a saved HTML file at `url` (matched exactly, query string included), so `@match` and relative URLs behave as on the live site. Other requests fall through to the page's other routes and the network, unless `block` is set. Pair with Playwright's `routeFromHAR` for pages that fetch data. |
| `saveSnapshot(file)` | Writes the page's current DOM to `file`, for `serveSnapshot` to replay later. The same file `sm-dev snapshot` writes. |
| `host`, `attachment` | The underlying objects, for anything the two above don't cover. |

### The same actions from either side

What `sm-dev` does by hand, a spec does through the fixture:

| `sm-dev` | In a spec |
| --- | --- |
| `run <script>` | `loadUserscript(path)` |
| `--values '{…}'` | `loadUserscript(path, { values })` |
| `menu`, `menu <label>` | `gm.menuCommands()`, `gm.fireMenu(label)` |
| `values`, `get <key>` | `gm.list()`, `gm.get(key)` |
| `set <key> <json>` | `gm.set(key, value)` |
| `reload`, `open <url>` | `page.reload()`, `page.goto(url)` |
| `snapshot <url> --out f` | `saveSnapshot(file)` |
| (a saved snapshot) | `serveSnapshot(file, url)` |
| `match <script> <url>` | `loadUserscript(path, { url })`, which throws on a miss |
| `validate <path>` | `loadUserscript(path)`, which throws with the same message |
| the streamed reports | `reports.started()`, `skipped()`, `errors()` |
| the streamed `GM_*` lines | `gm.requests()`, `gm.openedTabs()`, `gm.downloads()`, `gm.notifications()` |

Two things exist only on one side. `probe` is a command-line
convenience: a spec uses locators. Answering a network request
(`gm.interceptRequests`, `gm.failHosts`) is a spec's, since it needs a
function.

The fixture leaves `browser` and `context` to you. A repo that attaches
to a manually launched browser keeps that logic in its own fixture file
and re-exports the harness `test` extended with it. `sourcemonkey/harness`
loads Playwright when imported; a Node-only tool that wants just
`prepareScript` can import `sourcemonkey/harness/prepare` instead.

## The extension backend

For what only Chrome can answer: content security policy, Chrome's own
match gating, cross-tab broadcast between real tabs, and the real
identity of a `GM_xmlhttpRequest` (the extension's cookies, no
`Origin` header, `Sec-Fetch-Site: none`). A request that works from a
page can still be refused when it comes from the extension, so send one
real request per endpoint here before building on it.

- Start the browser with `--load-extension=<SourceMonkey dist>` and
  turn on "Allow User Scripts" for it once. The user's ordinary browser
  with SourceMonkey installed works too, as long as it has a
  remote-debugging port.
- `sm-dev run --extension` pushes the script text into the extension as
  an **ephemeral** script: it lands in a "Pushed scripts" collection,
  is registered before the page opens, and is replaced in place on the
  next push of the same file name, keeping its stored values. Nothing
  on disk is scanned. What it prints are the entries the script adds to
  its own Log tab, plus the page's console lines.
- `--solo` disables every other collection for the run and restores
  them after, so the pushed script runs without noise from the rest.
- `sm-dev clear --extension` drops all pushed scripts and their stored
  values, and turns solo mode off. If a `--solo` run was killed rather
  than stopped, this is how to get the other collections back; they
  are restored to how they were.
- `--values` and `--fire-menu` have no effect here: the extension keeps
  its own storage, and its menu is the toolbar's.
- Specs stay on the push backend; for a check that needs the real
  extension, drive it from a spec with SourceMonkey's own test fixtures
  or by hand with `sm-dev run --extension`.

## What is and isn't faithful

Faithful under the push backend:

- Header validation, URL matching, `@run-at`, `@noframes`, `@require`
  scope and local overrides, `@grant` gating, world choice.
- `GM_*` storage semantics, including the write batching and
  broadcast to other pages in the same context.
- `@connect` gating of `GM_xmlhttpRequest`.
- Error attribution to file and line.

Close, but not the same:

- `GM_xmlhttpRequest` goes out from Node with the browser's cookies for
  the target copied onto it (unless the request is `anonymous` or sets
  its own `Cookie` header), and with any header the script asked for.
  A server sees a request from Node, not from the extension: no
  `Sec-Fetch-Site: none`, cookies are not re-attached after a
  cross-origin redirect, and a `Set-Cookie` in the response does not
  reach the browser.

- `GM_info.userAgentData` is read from the browser once a page has
  reached a secure origin (`https:`, `localhost`, `file:`); a script
  loaded before that sees `null` there.
- A tab `GM_openInTab` opens is a real page in the same context, born
  at its URL as Chrome's would be, but no scripts are injected into it;
  the extension would inject whatever matches the new page. It is
  closed when the attachment is disposed, where the extension would
  leave it open, so a test run leaves no tabs behind.
- `GM_download` fetches the file from Node into a directory of the
  host's choosing and reports the extension's events, numbering a
  taken name as Chrome does; there is no download bar or prompt, and
  no `onprogress`. `GM_notification` shows nothing; a `timeout` still
  fires `ondone`, and a test delivers the click.

Not faithful, use the extension backend:

- The request identity of `GM_xmlhttpRequest` as a site's edge sees it.
- Chrome's own download manager and notification UI.
- Chrome refusing a registration, and page CSP effects on
  `GM_addStyle` in the page world.
- Anything about the extension's UI: badge, collections page, Log tab.

## Troubleshooting

- **"skipped: no @match covers <url>"**: the script would not run
  there in the extension either. Broaden the pattern or change the
  URL; see `sm-dev match`.
- **`GM_getValue is not defined`**: the script uses an API it did not
  `@grant`. The extension behaves the same way.
- **The script sees `undefined` for a page global**: it is in the
  isolated world. Reading page globals needs `@grant none` or
  `unsafeWindow`.
- **A `@require` fails to load**: the harness resolves it the way the
  extension does, including local overrides. The message names the
  URL and the reason.
