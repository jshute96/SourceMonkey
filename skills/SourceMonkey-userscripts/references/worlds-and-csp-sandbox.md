# Worlds, `@grant` and CSP-sandboxed pages

## Which world a script runs in

- **The page's world** (the default): the script shares the page's DOM
  and JavaScript globals. It can read React internals and the app's
  state objects.
- **The isolated world** (`@inject-into content`, or `@sandbox DOM`):
  the script shares only the DOM. The page's globals, its Trusted
  Types policy (which can block setting `innerHTML` from strings), its
  CSP and its changes to built-ins don't reach the script.

Use the isolated world for scripts that run on an open-ended set of
sites, unless they need page globals: no one tests every host such a
script lands on.

## `window` and `@grant`

Leave `@grant` out unless the script uses `GM_*` APIs, then list just
those. Don't add `@grant none` by default.

- Without `@grant none`, the script's `window` is its own sandbox, as in
  Tampermonkey and Violentmonkey: what it or a `@require`d library
  writes on `window` stays off the page.
- Read page globals by bare name (`Strava`, `pageView`) or as
  `unsafeWindow.x`. `window.x` is the sandbox's, and reads `undefined`.
- Use `@grant none` only when the script needs `window` itself to be
  the page's.
- An isolated-world script can't see page globals by any name. A
  global that reads `undefined` there means removing `@inject-into
  content`, not changing how it's read.

## Pages sent with a CSP `sandbox` header

`Content-Security-Policy: sandbox` (without `allow-scripts`) turns off
JavaScript in the page's own world, so Chrome never runs page-world
scripts there. Sites that serve user uploads or raw files send it to
block cross-site scripting, including on direct image URLs.

- **SourceMonkey and Violentmonkey** run page-world scripts in the
  isolated world on such a page instead. SourceMonkey's Log for the
  script says so, and `sm-dev start` notes it on each load. A script
  that needs page globals (React internals, say) runs but can't find
  them.
- **Tampermonkey** ignores `@inject-into` and doesn't run page-world
  scripts there at all: no init log. `sm-dev --manager tm` warns on each
  load of such a page, naming the scripts it blocks.
- **To confirm it:** in DevTools' Network tab, the document's response
  has `sandbox` in its `Content-Security-Policy` header. In the console,
  `self.origin` is `"null"` (sandboxed documents get an opaque origin).
