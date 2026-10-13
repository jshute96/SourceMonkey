# Match rules

What SourceMonkey's `@match`, `@include` and `@exclude` rules mean,
and how Chrome, Tampermonkey (TM) and Violentmonkey (VM) read the same
rules. How SourceMonkey (SM) implements them: [matching.md](matching.md).

## SourceMonkey's rules

### `@match`

Chrome's match-pattern grammar, `<scheme>://<host>/<path>`, plus the
literal `<all_urls>`.

- **Scheme**: `*` (http or https only), `http`, `https`, `file`, `ftp`.
- **Host**: `*` (any host), `*.example.com` (the domain and any
  subdomain), an exact name, or empty (for `file://`).
  - Case is ignored.
  - May end in a `:port`. Chrome's docs disallow ports, but its
    matcher accepts them, and SM follows the matcher, since Chrome
    decides where scripts are injected. A pattern with no port, or
    with `:*`, matches any port.
- **Path**: a glob, where `*` matches any text, `/` included.
  - It's matched against the path and `?query`, so `?id=*` works.
  - Not the `#fragment`, as in Chrome: a URL's fragment never stops a
    match, and a `@match` naming one is ignored (see
    [Patterns SM ignores](#patterns-sm-ignores)).
  - `@include` / `@exclude` do see the fragment (below). See
    `tests/examples/headers-match-hash/`.

### Lenient readings

Some shapes Chrome's parser refuses have one obvious reading, and real
scripts are full of them. SM reads them this way:

| Written | Read as | Why |
|---------|---------|-----|
| `*.example.com/*` | `*://*.example.com/*` | Scheme omitted |
| `http*://example.com/*` | `*://example.com/*` | Scheme glob |
| `*s://example.com/*` | `https://example.com/*` | Scheme glob |
| `https://example.com` | `https://example.com/` | No path |
| `*://*example.com/*` | `*://*.example.com/*` | `*` stuck to a host label |

- **A scheme containing `*`** stands for exactly the supported schemes
  it matches, never more: `http*://` is http and https, the same as
  `*://`; `*s://` is https alone; `*t*://` is http, https and ftp.
  - A glob naming no supported scheme (`chrome-*://…`) stays an
    unsupported scheme, and the pattern is ignored.
- **A rewritten pattern is honored as written**, host wildcard and
  all: `http*://*/forum.php` runs on every site with that path. It ran
  nowhere before, so this is a widening, but to the scope its author
  asked for. 45 corpus patterns are of that shape.
- **No path** reads as the root page, as TM reads it. VM never runs
  such a pattern, so nothing is lost there.
  - So `*` and `*://*` read as every site's root page, not every
    page.
  - A single word (`@match intranet`) reads as the root page of a host
    by that name. Only a local network has such hosts (`localhost`,
    `http://intranet/`), so elsewhere it matches nothing.
- **A `*` stuck to the front of a host** (`*example.com`) reads as
  `*.example.com`: the name and its subdomains.
  - TM runs it on `example.com` alone, and VM as a glob that also
    takes `fooexample.com`. This covers the first and the part of the
    second its authors mean.
  - Only a lone leading `*`. Any other `*` inside a host is ignored
    (below): only VM runs those.

Why read them at all:

- Over the Greasy Fork corpus (`tests/greasyfork-examples/`), the
  scheme shapes alone are nearly every `@match` Chrome refuses: 710
  scheme-less and 202 globbed, out of 1,035. Reading them makes 877
  usable; the rest fail for a second reason as well.
- Those are the site's most-installed scripts, so they work under
  whatever manager their authors and users run. Only Chrome's parser
  can't spell what they wrote.
- Every pattern read this way is one Chrome refused outright, so a
  lenient reading can only add pages a script runs on, never take one
  away.

### Patterns SM ignores

When a `@match` is one SM can't use:

- **The pattern is ignored**: left out, while the script still runs
  everywhere its other patterns say.
- **A warning** goes in the script's Log, on the header line that
  declared it: one row per pattern, since each has its own reason and
  line.
- **The script is INVALID** only when that leaves it with no `@match`
  and no `@include`, with that pattern's own reason.

The patterns it ignores (after the readings above):

- **An unsupported scheme**: any scheme other than `*`, `http`,
  `https`, `file` and `ftp`, or a scheme glob that names none of
  those (`chrome-*://`).
- **No host**, for a scheme that needs one (`https:///*`).
- **Characters no host name can have**
  (`https?:\/\/weibo.com/p/*`, a regex pasted into an `@match`).
- **A `*` inside the host** (`www.*.com`, `example.*`, `exam*.com`).
  The host may only be `*` alone, start with `*.` (`*.example.com`),
  or start with a `*` stuck to the name (`*example.com`, read as
  above).
- **Slashes or a colon with no scheme** (`//example.com/*`,
  `*//example.com/*`, `://example.com/*`). Too odd to guess at, and
  `*//example.com/*` would otherwise read as any host, with a path
  starting `//example.com/`.
- **A `#fragment` in the path** (`https://app.example/#/settings*`).
  - Chrome accepts this one, unlike the others, but it never matches:
    Chrome matches without the URL's fragment.
  - VM does match it, so a script written there would otherwise never
    run, with no word why. The warning points to `@include`.

How common, over the Greasy Fork corpus (1,991 scripts, 9,003 `@match`
patterns):

- **73 patterns** are ignored, and **5 scripts** are left with nothing
  usable.
- Before the lenient readings it was 1,035 and 81.
- The ignored patterns are mostly a `*` inside a host (57), which only
  VM runs. The rest is a fragment (7), a scheme nothing supports (3), a
  regex pasted into an `@match` (3) and slashes with no scheme (3).
- None of these can run under Chrome either way, but they exist
  because other managers match with their own engines rather than
  Chrome's.

### `@include` and `@exclude`

- **A glob**: `*` matches any text, and the pattern covers the whole
  URL, `#fragment` included.
- **A regex**: a pattern wrapped in `/.../` is a JavaScript regex,
  tested against the whole URL without anchoring.
  - Slashes inside it need no escaping.
  - A flag after the closing slash (`/.../i`) makes the pattern a
    glob, which matches nothing.
  - See `tests/examples/headers-include-regex/`.
- **Case** is ignored by both, as in TM and VM.
- **`@exclude`** takes the same patterns, and always wins: if any
  `@exclude` matches a URL, the script doesn't run there.

### `.tld` hosts

A host suffix for "this name under any public suffix":
`*://www.google.tld/*` runs on www.google.com, www.google.de and
www.google.co.uk. Read the same way in `@match`, `@include` and
`@exclude`.

- **Where it counts**: only as a host's last label (`www.google.tld`,
  `*.imdb.tld`, with or without a `:port`). `.tld` anywhere else, or
  inside a `/regex/`, is literal text.
  - An `@include` glob may run the host straight into a `*` with no
    `/` (`http://www.google.tld*`); the `.tld` still ends the host.
  - `*.tld` with no name in front stays literal.
- **What it matches**: any suffix in the ICANN section of the Public
  Suffix List (PSL, publicsuffix.org), the suffixes under which
  domain registries hand out names. That includes multi-level ones a
  registry keeps (`co.uk`, `com.au`), and not ordinary names
  (`com.de`, `evil.com`).
  - The PSL's private section (`blogspot.com`, `github.io`) is left
    out: a name under one belongs to whoever registered it there, and
    `www.google.blogspot.com` isn't Google's.
  - Names no registry hands out (`.local`, `.lan`) don't match: the
    PSL's implicit "any unknown label" rule isn't applied.
  - So `.tld` only ever stands for the host's real suffix.
- **Site icons and links** for a `.tld` `@match` use `.com`.
- How other managers read it: [below](#tld).

### Combining rules

A script runs on a page when:

1. no `@exclude` matches, and
2. at least one `@match` or `@include` matches.

A script with no `@match` and no `@include` is INVALID, so it never
runs.

## Compared with other managers

- **Chrome** is what `chrome.userScripts` does with a registration's
  `matches` (Chrome's match-pattern grammar) and `includeGlobs`.
  - SM, TM and VM all register with it, or inject from a content
    script, and then filter in the page with matchers of their own.
  - So for TM and VM, the tables give what finally runs.
- **"Refused"** means Chrome rejects the whole registration over that
  one pattern.
- Measured against TM 5.5.1 and VM 2.49.0, by installing probe scripts
  and loading pages. Other versions may differ.

### `@match` in each manager

#### Scheme

| Written | Chrome | SM | TM | VM |
|---|---|---|---|---|
| `*://` | http, https | http, https | http, https | http, https |
| `http://`, `https://`, `file://` | yes | yes | yes | yes |
| `http*://` | refused | read as `*://` | http, https | http, https |
| Other scheme globs (`*s://`) | refused | the schemes the glob names (`https://`) | glob over schemes | bad pattern |
| No scheme (`example.com/*`) | refused | read as `*://` | read as `*://` | bad pattern |
| Slashes with no scheme (`//example.com/*`, `*//example.com/*`, `://example.com/*`) | refused | pattern ignored, with a warning | not measured | bad pattern |
| Unknown scheme (`foo://`) | refused | pattern ignored, with a warning | read as `*://` | bad pattern |

#### Host

| Written | Chrome | SM | TM | VM |
|---|---|---|---|---|
| `*` | any host | any host | any host | any host |
| `*.example.com` | example.com and all its subdomains | same | same | same |
| `*example.com` (`*` stuck to a label) | refused | read as `*.example.com` | `example.com` only: the `*` is dropped | glob: `example.com`, `www.example.com`, `fooexample.com` |
| `exam*.com`, `www.*.com` | refused | pattern ignored, with a warning | matches nothing: the host is cut off at the `*` | glob; `*` crosses dots (`www.a.b.com`) |
| `example.*` | refused | pattern ignored, with a warning | matches nothing | starts with `example.`, port included; VM warns but still matches |
| Case | ignored | ignored | ignored | ignored |

#### `.tld`

| | Chrome | SM | TM | VM |
|---|---|---|---|---|
| `example.tld`, `*.example.tld` | literal host: matches nothing | any public suffix | matches nothing | any public suffix |
| Suffix list | | ICANN section of the PSL | | full PSL, private section included |
| `example.blogspot.com`, `example.github.io` | | no | | yes |
| Unknown TLD (`example.notarealtld`) | | no | | yes |
| URL with a port | | matches | | no |

- PSL is the Public Suffix List (publicsuffix.org). Its private
  section holds names like `blogspot.com` and `github.io`, under which
  anyone can get a name.

#### Port

| | Chrome | SM | TM | VM |
|---|---|---|---|---|
| No port in the pattern | any port | any port | any port | default port only |
| `host:8080` | that port | that port | any port: the port is dropped | that port, compared as text |
| `host:*` | any port | any port | any port | literal text: matches nothing |

- Chrome refuses a `*` scheme beside a numeric port
  (`*://host:8080/*`), though it takes a named one. SM registers that
  pattern as the `http://` and `https://` pair, which means the same.
- VM compares the host and port as one string, so a host `*` that
  reaches the end also swallows a port: `example.*` matches
  `example.com:8080`.

#### Path, query and fragment

- The `?query` is the part of a URL from `?` up to any `#`
  (`/page?id=1`), and the `#fragment` the part from `#` on
  (`/page#section`).

| | Chrome | SM | TM | VM |
|---|---|---|---|---|
| No path (`https://example.com`) | refused | read as `/` | read as `/` | matches nothing |
| `https://example.com/` | the root page; not `/?q=1` | same | same | the root page, with any query |
| `https://example.com/foo` | exactly `/foo` | same | same | `/foo` with any query; not `/foobar` |
| `*` in the path | any text, `/` and `?` included | same | same | same |
| The URL's `?query` | part of what's matched | same | same | ignored when the pattern has no `?`; matched when it has one |
| URL has a `#fragment`, pattern names none (`/page` on `/page#section`) | fragment ignored: matches | same | same | same |
| Pattern names a `#fragment` (`/#/settings*`) | never matches | pattern ignored, with a warning | never matches | matches against the URL's fragment |
| Case | sensitive | sensitive | sensitive | sensitive |

### `@include` and `@exclude` in each manager

`@exclude` reads the same as `@include` in all four, and always wins.

#### Globs

| | Chrome (`includeGlobs`) | SM | TM | VM |
|---|---|---|---|---|
| Anchored to | the whole URL | the whole URL | the whole URL | the whole URL |
| `*` | any text | any text | any text (in the host, anything up to the path) | any text |
| `?` | any one character | literal | literal | literal |
| Case | sensitive | ignored | ignored | ignored |
| The URL's `#fragment` | part of the URL | part of the URL | removed before matching | part of the URL |
| `*` alone | every page | every page | http, https and file pages | every page |
| `http*://` | glob | glob | `http` then anything | glob |
| `example.tld/` | literal | ICANN suffixes, as in `@match` | a fixed list of TLDs and some second-level suffixes (`co.uk`); no private ones | full PSL, as in `@match` |
| `example.*/` (host ends in `.*`) | glob | glob | read as `example.tld/` | glob |
| URL with a port, host glob without one | glob sees the port | same | never matches | glob sees the port |

- TM reads `.tld`, and a host ending in `.*`, only when a `/` follows.
  `*://example.*` (no path) stays a glob.
- SM still gets Chrome to inject where its own reading says, ignoring
  case and taking `?` literally: see
  [matching.md](matching.md#registering-include-and-exclude).

#### `/regex/`

| | Chrome | SM | TM | VM |
|---|---|---|---|---|
| Supported | no | yes | yes | yes |
| Anchored | | no | no | no |
| Case | | ignored | ignored | ignored |
| Flags after the closing `/` (`/x/i`) | | a glob: matches nothing | still a regex, ending in the text `/i`: `/example\.com/i` matches `example.com/index` | a glob: matches nothing |

- With no regex support in Chrome, SM and TM both register a script
  with a regex `@include` for every page, and filter in the page.

### Bad patterns in each manager

- **Chrome**: one bad `@match` refuses the whole registration.
- **SM**: drops the bad pattern, with a warning in the script's Log on
  its header line. The script is INVALID only when no `@match` or
  `@include` is left.
- **TM**: rewrites a bad `@match` into something it can match, rather
  than rejecting it. That is where its odd host readings come from.
- **VM**: a bad pattern matches nothing, and is reported at install.

### Combining rules in each manager

- In all four, a page matching any `@match` or any `@include` runs the
  script, unless an `@exclude` matches.
- A script with no `@match` or `@include` is INVALID in SM, and runs
  on every page in VM.
