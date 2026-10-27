# SourceMonkey privacy policy

SourceMonkey is a userscript manager for Chrome. It doesn't collect,
sell or share any data about you. It has no analytics, no tracking and
no account, and doesn't connect to any server of its own.

## Data stored on your computer

SourceMonkey keeps everything it stores in Chrome's extension storage,
on your own computer:

- Your collections, installed userscripts, and their settings.
- The values scripts save with the `GM_setValue` family of APIs.
- Each script's log: errors and messages it produced.
- Your options, including a GitHub token if you add one.
- Cached site icons.

This data never leaves your computer, except as described below. Removing
the extension deletes it.

## Network requests

SourceMonkey makes these requests:

- **Scripts and their files.** It downloads userscripts, and the
  `@require` / `@resource` / `@icon` files they name, from the URLs you
  install them from, and checks those URLs again for updates.
- **Update URLs.** A script can name its own update address
  (`@updateURL` or `@downloadURL`). SourceMonkey reads it to check
  whether a newer version is available there, but still updates the
  script only from the URL you installed it from.
- **GitHub.** For collections on GitHub, it uses GitHub's API. If you
  add a GitHub token in Options, it's sent only to GitHub, to read
  private repos and get a higher rate limit.
- **Site icons.** To show a site's icon beside the scripts that run on
  it, it reads Chrome's icon cache, then the site itself. If
  neither has one, it asks Google's favicon service
  (`www.google.com/s2/favicons`), sending only the site's host name.

## What your userscripts do

Userscripts you install run on the pages they target and can read
those pages, like any userscript manager's scripts. A script can also
make network requests of its own (`GM_xmlhttpRequest`) to the page's
own site and to the hosts it declares with `@connect`. SourceMonkey
asks you before it reaches any other host.

A userscript runs inside a page and can access your data and act as you.
What it does is up to the userscript, not SourceMonkey.
**Install scripts only from sources you trust.**

## Developer tools

SourceMonkey's command-line testing tool, `sm-dev`, runs on your own
computer and controls a separate test browser that it launches. It
sends nothing to SourceMonkey's developer.

## Changes and contact

Changes to this policy are made in this file, and its history is in
the [GitHub repository](https://github.com/jshute96/SourceMonkey).
Questions can go to the repository's
[issues page](https://github.com/jshute96/SourceMonkey/issues).
