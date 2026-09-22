# Testing userscripts with the SourceMonkey harness

> **Status: proposal.** This describes the intended interface. See
> [harness-design.md](harness-design.md) for what gets built and why.

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

SourceMonkey builds itself on install, and pnpm refuses to run a
dependency's build unless the project allows it. Add this to
`pnpm-workspace.yaml` in your repo (create the file if there isn't
one). The key has to cover the git URL, so it is a glob rather than
the bare name:

```yaml
allowBuilds:
  "sourcemonkey@git+https*": true
```

While hacking on SourceMonkey itself, point at the checkout instead:

```json
{ "devDependencies": { "sourcemonkey": "link:../SourceMonkey2" } }
```

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

`sm-dev` connects to a running browser over CDP (`--cdp
http://127.0.0.1:9233`, or the `SM_DEV_CDP` env var) and drives it.
Every command prints plain text meant to be read by a person or an
agent.

| Command | What it does |
| --- | --- |
| `sm-dev run <script.user.js> [--url U]` | Opens or reuses a tab at `U` (default: the first URL the script's `@match` implies), injects the script as it is on disk, reloads, and streams the script's console lines, page errors, and start / skipped / error reports until interrupted. |
| `sm-dev run ... --watch` | Same, and re-injects plus reloads on every save of the script or a `@require`d file. |
| `sm-dev run a.user.js b.user.js` | Injects several scripts into the same page, for interaction tests. |
| `sm-dev probe <url> --selectors 'a, b, c'` | Reports which selectors resolve on the page, so a broken script's assumptions can be checked in one call. `--html` dumps the current DOM of a match. |
| `sm-dev match <script> <url>...` | Says whether the script would run on each URL, and which rule decided. |
| `sm-dev validate <path>...` | The install-time checks (header, `@require`, syntax) over files or directories, with the message the extension would show. |
| `sm-dev snapshot <url> --out file.html` | Saves the live DOM so a spec can run against it without a login. |

Options for `validate` and `match`:

- `--root DIR` names the repo root, searched for local copies of
  `@require` URLs the way the extension searches a collection's
  directory. Defaults to the current directory.
- `--local DIR` adds another directory to that search; repeatable.

Other `run` flags:

- `--values '{"key": 1}'` seeds `GM_*` storage before the script runs.
- `--fire-menu "Label"` invokes a registered menu command.
- `--extension` uses the real extension in that browser instead of the
  built-in stand-in (see below).

### What the output looks like

```
[sm-dev] prepared sites/example.com/add-button.user.js: ok, world USER_SCRIPT, run-at document-idle
[sm-dev] https://example.com/items/42: match on @match https://example.com/items/*
[sm-dev] start
[add-button] init
[add-button] toolbar found, button inserted
[sm-dev] GM_setValue lastItem = "42"
```

A URL miss prints the pattern that failed and stops, instead of running
the script anyway. A header problem prints the same wording the
extension's viewer would.

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
| `loadUserscript(path, options?)` | Prepares the file with the real pipeline and attaches it to `page` (before the navigation that should see it). Options: `values` to seed storage, `world` to override the computed world, `url` to check the match early. Throws with the extension's own message if the script is invalid. Call it twice for two scripts on one page. |
| `gm` | `get(key)`, `set(key, value)`, `list()`, `menuCommands()`, `fireMenu(label)`, `openedTabs()`, `notifications()`, `requests()`. Values are per script; pass the script's name when more than one is loaded. |
| `reports` | `started()`, `skipped()` (with the rule that missed), `errors()` (message, file, line). `await reports.waitForStart()` is the usual gate before interacting. |
| `serveSnapshot(file, url)` | Routes a saved HTML file at `url`, so `@match` and relative URLs behave as on the live site. Pair with Playwright's `routeFromHAR` for pages that fetch data. |

The fixture leaves `browser` and `context` to you. A repo that attaches
to a manually launched browser keeps that logic in its own fixture file
and re-exports the harness `test` extended with it.

## The extension backend

For what only Chrome can answer: content security policy, Chrome's own
match gating, cross-tab broadcast between real tabs, and the real
identity of a `GM_xmlhttpRequest` (the extension's cookies, no
`Origin` header, `Sec-Fetch-Site: none`). A request that works from a
page can still be refused when it comes from the extension, so send one
real request per endpoint here before building on it.

- Start the browser with `--load-extension=<SourceMonkey dist>` and
  turn on "Allow User Scripts" for it once.
- `sm-dev run --extension` pushes the script text into the extension as
  an **ephemeral** script: it lands in a "Pushed scripts" collection,
  is registered before the command returns, and is replaced in place on
  the next push. Nothing on disk is scanned.
- `--solo` disables every other collection for the run and restores
  them after, so the pushed script runs without noise from the rest.
- `sm-dev clear --extension` drops all pushed scripts and their stored
  values.
- The same operations are available to specs through
  `test.use({ backend: 'extension' })`; the fixture then reads the
  script's real Log entries into `reports`.

## What is and isn't faithful

Faithful under the push backend:

- Header validation, URL matching, `@run-at`, `@noframes`, `@require`
  scope and local overrides, `@grant` gating, world choice.
- `GM_*` storage semantics, including the write batching and
  broadcast to other pages in the same context.
- `@connect` gating of `GM_xmlhttpRequest`.
- Error attribution to file and line.

Not faithful, use the extension backend:

- The request identity of `GM_xmlhttpRequest` (cookies, headers).
- Real downloads and notification clicks.
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
