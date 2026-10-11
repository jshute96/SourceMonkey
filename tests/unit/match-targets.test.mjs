// Tests for src/match-targets.ts (compiled to dist/match-targets.js).
//
// Covers the pure `@match` pattern → origin/linkUrl extraction
// helpers consumed by both the icon module and the
// userscript-viewer linkifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  originFromMatchPattern,
  representativeOrigin,
  representativeMatch,
  representativeMatches,
  MAX_SITE_ICONS,
  linkPathFromMatchPath,
  sameDirLinkUrl,
} from '../../dist/match-targets.js';

// ---------- originFromMatchPattern ----------

test('originFromMatchPattern: exact host with explicit scheme', () => {
  assert.equal(
    originFromMatchPattern('https://example.com/*'),
    'https://example.com',
  );
  assert.equal(
    originFromMatchPattern('http://example.com/*'),
    'http://example.com',
  );
});

test('originFromMatchPattern: scheme wildcard becomes https', () => {
  assert.equal(
    originFromMatchPattern('*://example.com/*'),
    'https://example.com',
  );
});

test('originFromMatchPattern: subdomain wildcard collapses to base host', () => {
  assert.equal(
    originFromMatchPattern('https://*.example.com/*'),
    'https://example.com',
  );
  assert.equal(
    originFromMatchPattern('*://*.example.co.uk/*'),
    'https://example.co.uk',
  );
});

test('originFromMatchPattern: rejects a wildcard port', () => {
  // Chrome's match-pattern grammar doesn't formally support ports
  // at all, and the de-facto support is digits only. A `:*` port is
  // not a usable target — treat it the same as any other host-side
  // wildcard we can't pin to one site.
  assert.equal(originFromMatchPattern('http://localhost:*/path'), null);
  assert.equal(originFromMatchPattern('https://*.example.com:*/path'), null);
  assert.equal(originFromMatchPattern('http://localhost:80*/path'), null);
});

test('originFromMatchPattern: preserves an explicit :port', () => {
  // An explicit port is intentional — the favicon almost certainly
  // lives at the same port as the page, and the cache key needs to
  // include the port to keep two different services on the same
  // host from clobbering each other's icons.
  assert.equal(
    originFromMatchPattern('http://localhost:8080/*'),
    'http://localhost:8080',
  );
  // Subdomain-wildcard host with an explicit port: the subdomain
  // dewildcards but the port stays attached to the apex host.
  assert.equal(
    originFromMatchPattern('https://*.example.com:3000/*'),
    'https://example.com:3000',
  );
});

test('representativeMatch: preserves an explicit :port', () => {
  // Same port appears in origin and linkUrl — the icon resolver and
  // the click-through both need to stay on the port the user
  // targeted, not back-fall to the default port.
  assert.deepEqual(
    representativeMatch({ matches: ['http://localhost:8080/app/*'] }),
    {
      origin: 'http://localhost:8080',
      linkUrl: 'http://localhost:8080/app/',
    },
  );
});

test('originFromMatchPattern: host of `*` is too broad', () => {
  assert.equal(originFromMatchPattern('*://*/*'), null);
  assert.equal(originFromMatchPattern('https://*/*'), null);
});

test('originFromMatchPattern: TLD wildcard rejected', () => {
  assert.equal(originFromMatchPattern('https://example.*/*'), null);
});

test('originFromMatchPattern: non-http schemes rejected', () => {
  assert.equal(originFromMatchPattern('file:///home/user/*'), null);
  assert.equal(originFromMatchPattern('ftp://example.com/*'), null);
});

test('originFromMatchPattern: <all_urls> has no representative site', () => {
  assert.equal(originFromMatchPattern('<all_urls>'), null);
});

test('originFromMatchPattern: malformed patterns return null', () => {
  assert.equal(originFromMatchPattern(''), null);
  assert.equal(originFromMatchPattern('not a pattern'), null);
});

test('originFromMatchPattern: reads the lenient shapes like the matcher', () => {
  // A pattern with the scheme left out still names a site, so it gets
  // an icon and a click-through target like any other. Same reading as
  // canonicalMatchPatterns (src/url-match.ts).
  assert.equal(originFromMatchPattern('*.example.com/*'), 'https://example.com');
  assert.equal(originFromMatchPattern('example.com/app/*'), 'https://example.com');
  assert.equal(originFromMatchPattern('//example.com/*'), 'https://example.com');
  assert.equal(originFromMatchPattern('://example.com/*'), 'https://example.com');
  assert.equal(originFromMatchPattern('http*://example.com/*'), 'https://example.com');
  assert.equal(originFromMatchPattern('*//example.com/*'), 'https://example.com');
});

test('originFromMatchPattern: a port-pinned `*` scheme still reads as https', () => {
  // `*://host:8443/*` canonicalizes to the http + https pair (Chrome
  // refuses `*` beside a numeric port), and the representative has to
  // stay the https member — an icon probe over http would fail on a
  // TLS-only port.
  assert.equal(originFromMatchPattern('*://example.com:8443/*'), 'https://example.com:8443');
  assert.deepEqual(representativeMatch({ matches: ['*://example.com:8443/app/*'] }), {
    origin: 'https://example.com:8443',
    linkUrl: 'https://example.com:8443/app/',
  });
});

test('originFromMatchPattern: lowercases the host', () => {
  assert.equal(
    originFromMatchPattern('HTTPS://Example.COM/*'),
    'https://example.com',
  );
});

// ---------- representativeOrigin ----------

test('representativeOrigin: returns first usable @match', () => {
  assert.equal(
    representativeOrigin({
      matches: ['file:///x/*', '*://example.com/*'],
    }),
    'https://example.com',
  );
});

test('representativeOrigin: null when no matches yield an origin', () => {
  assert.equal(
    representativeOrigin({
      matches: ['<all_urls>', 'file:///x/*'],
    }),
    null,
  );
  assert.equal(representativeOrigin({ matches: [] }), null);
});

// ---------- representativeMatch ----------

test('representativeMatch: keeps the literal path prefix', () => {
  assert.deepEqual(
    representativeMatch({ matches: ['https://connect.garmin.com/app/*'] }),
    {
      origin: 'https://connect.garmin.com',
      linkUrl: 'https://connect.garmin.com/app/',
    },
  );
  assert.deepEqual(
    representativeMatch({ matches: ['https://example.com/posts/*/edit'] }),
    {
      origin: 'https://example.com',
      linkUrl: 'https://example.com/posts/',
    },
  );
});

test('representativeMatch: all-glob path collapses to /', () => {
  assert.deepEqual(
    representativeMatch({ matches: ['https://example.com/*'] }),
    {
      origin: 'https://example.com',
      linkUrl: 'https://example.com/',
    },
  );
});

test('representativeMatch: subdomain-wildcard pattern keeps the literal-prefix path', () => {
  // `bar*` is a literal prefix with `*` at the end of the last
  // segment, so the link target preserves it.
  assert.deepEqual(
    representativeMatch({ matches: ['*://*.example.com/foo/bar*'] }),
    {
      origin: 'https://example.com',
      linkUrl: 'https://example.com/foo/bar',
    },
  );
});

test('representativeMatch: null for patterns without a usable origin', () => {
  assert.equal(representativeMatch({ matches: ['<all_urls>'] }), null);
  assert.equal(representativeMatch({ matches: ['file:///x/*'] }), null);
  assert.equal(representativeMatch({ matches: [] }), null);
});

// ---------- linkPathFromMatchPath ----------

test('linkPathFromMatchPath: full-glob path is just /', () => {
  assert.equal(linkPathFromMatchPath('/*'), '/');
});

test('linkPathFromMatchPath: keeps complete segments up to the first wildcard', () => {
  assert.equal(linkPathFromMatchPath('/app/*'), '/app/');
  assert.equal(linkPathFromMatchPath('/posts/*/edit'), '/posts/');
  assert.equal(linkPathFromMatchPath('/a/b/c/*'), '/a/b/c/');
});

test('linkPathFromMatchPath: keeps the literal prefix when `*` is at the end of the last segment', () => {
  // `bar*` and `ol.php?type=precip*` both have a non-empty literal
  // prefix ending in `*`, so the link target is the full literal —
  // typically a real page parametrised on the tail.
  assert.equal(linkPathFromMatchPath('/foo/bar*'), '/foo/bar');
  assert.equal(linkPathFromMatchPath('/ol.php?type=precip*'), '/ol.php?type=precip');
});

test('linkPathFromMatchPath: trims mid-path or mid-segment wildcards back to the parent', () => {
  // `bar*` followed by more path segments: the partial-segment prefix
  // isn't likely to be navigable, so back off to the parent directory.
  assert.equal(linkPathFromMatchPath('/foo/bar*/baz'), '/foo/');
  // Mid-segment wildcard (`*` is not at the end of the last segment):
  // same deal, partial-segment prefix isn't navigable, back to the
  // parent.
  assert.equal(linkPathFromMatchPath('/foo/b*r'), '/foo/');
  assert.equal(linkPathFromMatchPath('/a/b*c'), '/a/');
});

test('representativeMatch: mid-segment wildcard backs the linkUrl off to the parent', () => {
  // `/a/b*c` has `*` mid-segment in the last segment — partial-segment
  // prefix isn't likely to be a real URL, so linkUrl backs off to
  // `/a/` instead of returning `/a/b`.
  assert.deepEqual(
    representativeMatch({ matches: ['https://example.com/a/b*c'] }),
    {
      origin: 'https://example.com',
      linkUrl: 'https://example.com/a/',
    },
  );
});

test('linkPathFromMatchPath: pure-literal paths pass through unchanged', () => {
  assert.equal(linkPathFromMatchPath('/'), '/');
  assert.equal(linkPathFromMatchPath('/foo'), '/foo');
  assert.equal(linkPathFromMatchPath('/foo/bar'), '/foo/bar');
  assert.equal(linkPathFromMatchPath('/foo/bar/'), '/foo/bar/');
});

// ---------- sameDirLinkUrl ----------

// Scripts in the bundled examples' layout, naming with site-less
// patterns a page that ships in the script's own directory.
const FILE_SCRIPT = 'file:///home/u/dev/tests/examples/gm-menu/gm-menu.user.js';
const HTTP_SCRIPT = 'https://example.com/tests/examples/gm-menu/gm-menu.user.js';

test('sameDirLinkUrl: host wildcard resolves against the script directory', () => {
  assert.equal(
    sameDirLinkUrl('*://*/gm-menu/gm-menu.html', FILE_SCRIPT),
    'file:///home/u/dev/tests/examples/gm-menu/gm-menu.html',
  );
  assert.equal(
    sameDirLinkUrl('file:///*/gm-menu/gm-menu.html', FILE_SCRIPT),
    'file:///home/u/dev/tests/examples/gm-menu/gm-menu.html',
  );
});

test('sameDirLinkUrl: an http-hosted script keeps its own origin', () => {
  // The scheme and origin come from the script, not the pattern —
  // it is the only reading that can be right, and it is why the
  // `*://` and `file://` patterns for the same page give one URL.
  assert.equal(
    sameDirLinkUrl('file:///*/gm-menu/gm-menu.html', HTTP_SCRIPT),
    'https://example.com/tests/examples/gm-menu/gm-menu.html',
  );
});

test('sameDirLinkUrl: literal text after a wildcard anchors like a directory', () => {
  // The examples' http form: `*gm-menu` lets any path prefix stand
  // before the directory, so the page matches under any server root.
  assert.equal(
    sameDirLinkUrl('*://*/*gm-menu/gm-menu.html', FILE_SCRIPT),
    'file:///home/u/dev/tests/examples/gm-menu/gm-menu.html',
  );
  // The suffix has to end the script's directory name...
  assert.equal(sameDirLinkUrl('*://*/*other/gm-menu.html', FILE_SCRIPT), null);
  // ...and the one in the right position when literal dirs follow.
  assert.equal(
    sameDirLinkUrl('*://*/*amples/gm-menu/gm-menu.html', FILE_SCRIPT),
    'file:///home/u/dev/tests/examples/gm-menu/gm-menu.html',
  );
  assert.equal(sameDirLinkUrl('*://*/*menu/gm-menu/gm-menu.html', FILE_SCRIPT), null);
});

test('sameDirLinkUrl: needs a literal directory or directory suffix to anchor on', () => {
  // "a file with this name, somewhere" is not a hint that the file
  // sits beside the script.
  assert.equal(sameDirLinkUrl('*://*/gm-menu.html', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('file:///*/gm-menu.html', FILE_SCRIPT), null);
  // A suffix in the filename segment doesn't name a directory.
  assert.equal(sameDirLinkUrl('*://*/*gm-menu.html', FILE_SCRIPT), null);
});

test('sameDirLinkUrl: literal directories must match the script dir tail', () => {
  assert.equal(sameDirLinkUrl('*://*/other/gm-menu.html', FILE_SCRIPT), null);
  // Deeper overlap is fine as long as the whole literal run matches.
  assert.equal(
    sameDirLinkUrl('*://*/examples/gm-menu/gm-menu.html', FILE_SCRIPT),
    'file:///home/u/dev/tests/examples/gm-menu/gm-menu.html',
  );
  // ...and a run longer than the script's own path can't match.
  assert.equal(sameDirLinkUrl('*://*/nope/examples/gm-menu/x.html', FILE_SCRIPT), null);
});

test('sameDirLinkUrl: the last segment must be a concrete filename', () => {
  assert.equal(sameDirLinkUrl('*://*/gm-menu/*', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('*://*/gm-menu/page*', FILE_SCRIPT), null);
  // No extension — not a file we can name.
  assert.equal(sameDirLinkUrl('*://*/gm-menu/page', FILE_SCRIPT), null);
});

test('sameDirLinkUrl: a concrete host is left to matchTargetInfo', () => {
  assert.equal(sameDirLinkUrl('https://example.com/gm-menu/gm-menu.html', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('*://*.example.com/gm-menu/gm-menu.html', FILE_SCRIPT), null);
});

test('sameDirLinkUrl: rejects non-pattern shapes and missing script URLs', () => {
  assert.equal(sameDirLinkUrl('<all_urls>', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('/^https?:\\/\\/x\\/gm-menu\\/a\\.html$/', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('*://*/gm-menu/gm-menu.html', undefined), null);
});

test('sameDirLinkUrl: percent-encoded script directories still match', () => {
  assert.equal(
    sameDirLinkUrl('*://*/gm menu/page.html', 'file:///home/u/gm%20menu/x.user.js'),
    'file:///home/u/gm%20menu/page.html',
  );
});

test('sameDirLinkUrl: a query or fragment on the filename is not a plain neighbour', () => {
  // `?` is legal in a `@match` path glob, so these reach the filename
  // check; a parametrised page is not the file-next-door case.
  assert.equal(sameDirLinkUrl('*://*/gm-menu/page.html?a=b', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('*://*/gm-menu/page.html?v=1.2', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('*://*/gm-menu/page.html#v1.2', FILE_SCRIPT), null);
});

test('sameDirLinkUrl: accepts the `http*://` include shorthand', () => {
  assert.equal(
    sameDirLinkUrl('http*://*/gm-menu/gm-menu.html', FILE_SCRIPT),
    'file:///home/u/dev/tests/examples/gm-menu/gm-menu.html',
  );
});

test('sameDirLinkUrl: rejects schemes a site-less pattern is never written with', () => {
  // The scheme is discarded (the href takes the script's own), so
  // these must be filtered rather than silently accepted.
  assert.equal(sameDirLinkUrl('ftp://*/gm-menu/page.html', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('javascript://*/gm-menu/page.html', FILE_SCRIPT), null);
  assert.equal(sameDirLinkUrl('data://*/gm-menu/page.html', FILE_SCRIPT), null);
});

test('sameDirLinkUrl: rejects an empty literal segment', () => {
  assert.equal(sameDirLinkUrl('*://*/gm-menu//page.html', FILE_SCRIPT), null);
});

test('sameDirLinkUrl: a script URL we cannot navigate from yields nothing', () => {
  assert.equal(
    sameDirLinkUrl('*://*/gm-menu/gm-menu.html', 'chrome-extension://abc/gm-menu/x.user.js'),
    null,
  );
  assert.equal(sameDirLinkUrl('*://*/gm-menu/gm-menu.html', 'not a url'), null);
  // Preview mode's script URL is '' before a file is loaded.
  assert.equal(sameDirLinkUrl('*://*/gm-menu/gm-menu.html', ''), null);
});

test('sameDirLinkUrl: a github script points at the page, not the raw bytes', () => {
  // raw.githubusercontent serves HTML as text/plain, so the raw
  // neighbour is a plaintext dump — link the github.com page instead,
  // the same URL the Location row shows.
  assert.equal(
    sameDirLinkUrl(
      '*://*/gm-menu/gm-menu.html',
      'https://raw.githubusercontent.com/o/r/main/examples/gm-menu/gm-menu.user.js',
    ),
    'https://github.com/o/r/blob/main/examples/gm-menu/gm-menu.html',
  );
});

test('sameDirLinkUrl: a filename needing escapes is resolved, not concatenated', () => {
  assert.equal(
    sameDirLinkUrl('*://*/gm-menu/my page.html', FILE_SCRIPT),
    'file:///home/u/dev/tests/examples/gm-menu/my%20page.html',
  );
});

// ---------- representativeMatches ----------

test('representativeMatches: one entry per distinct site, header order', () => {
  assert.deepEqual(
    representativeMatches({
      matches: [
        'https://connect.garmin.com/app/*',
        'https://www.strava.com/*',
        'https://connect.garmin.com/other/*',
      ],
    }).map((t) => t.origin),
    ['https://connect.garmin.com', 'https://www.strava.com'],
  );
});

test('representativeMatches: www. and scheme do not make a new site', () => {
  assert.deepEqual(
    representativeMatches({
      matches: [
        'http://www.example.com/*',
        'https://example.com/*',
        'https://WWW.example.com/x/*',
      ],
    }).map((t) => t.linkUrl),
    ['http://www.example.com/'],
  );
});

test('representativeMatches: ports are distinct sites; cap at MAX_SITE_ICONS', () => {
  const got = representativeMatches({
    matches: [
      'http://localhost:3000/*',
      'http://localhost:8080/*',
      '<all_urls>',
      'https://a.example/*',
      'https://b.example/*',
    ],
  });
  assert.equal(got.length, MAX_SITE_ICONS);
  assert.deepEqual(got.map((t) => t.origin), [
    'http://localhost:3000',
    'http://localhost:8080',
    'https://a.example',
  ]);
});

test('representativeMatches: empty when nothing names a site', () => {
  assert.deepEqual(representativeMatches({ matches: ['<all_urls>', 'file:///x/*'] }), []);
});

test('representativeMatch: a .tld host links to its .com site', () => {
  assert.deepEqual(representativeMatch({ matches: ['*://www.google.tld/*'] }), {
    origin: 'https://www.google.com',
    linkUrl: 'https://www.google.com/',
  });
});
