# Working across userscript managers

Scripts should work in SourceMonkey, Tampermonkey (TM) and
Violentmonkey (VM) when that's easy to achieve. Check with
`sm-dev --manager tm` / `--manager vm` (see the `SourceMonkey-dev`
skill). Differences that bite:

- **`window.onurlchange`: VM doesn't support it.** `@grant
  window.onurlchange` defines `window.onurlchange` as `null` in
  SourceMonkey and TM; in VM it stays `undefined` and `urlchange` never
  fires. Test `window.onurlchange === null`, and otherwise listen for the
  Navigation API's `currententrychange`, which fires on the same history
  changes, including in an isolated-world script. Snippet in
  [spa-navigation.md](spa-navigation.md).
- **Start time differs.** TM and VM can start a `document-idle` script
  earlier than an `sm-dev` SourceMonkey run does (a run delays every
  script until the extension's check). Anything the page does
  after load can undo early work (see "When React takes over the page"
  in [react-sites.md](react-sites.md)). Re-create DOM state that must
  persist when it's removed.
- **`@inject-into` is ignored by TM**, which matters on CSP-sandboxed
  pages: see [worlds-and-csp-sandbox.md](worlds-and-csp-sandbox.md).
- **Other browsers are untested** by these tools, which only drive
  Chromium. Where a script leans on a newer web API (like the
  Navigation API), feature-check it and log when it's missing, rather
  than failing silently.
