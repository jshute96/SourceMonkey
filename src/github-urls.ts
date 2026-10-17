// A GitHub raw URL's page on github.com. Its own module so code that
// only shows links (match-targets.ts) needn't load the GitHub provider.

// Reverse of `githubFileUrlToRaw` (github-provider.ts): take a
// raw-content GitHub URL and return its
// `github.com/<o>/<r>/blob/<ref>/<path>` counterpart — the
// page a human would open in a browser. Used wherever the UI surfaces
// a github URL for clicking (collections-page bubble, viewer Location
// row): the raw URL is what we fetch from, but the blob URL is what
// the user wants to see.
//
// "Raw" here covers both hosts GitHub serves raw bytes from:
//   - `raw.githubusercontent.com/<o>/<r>/[refs/<type>/]<ref>/<path>`
//   - `github.com/<o>/<r>/raw/[refs/<type>/]<ref>/<path>` (the form
//     produced by github.com's own "Raw" button — it 302s to the
//     `raw.githubusercontent.com` host but we may store the URL in
//     this form when the user pastes it directly, or when a manifest
//     entry resolves to a URL in this shape).
//
// The optional `/refs/<type>/` segment is the new-style raw URL.
// `<type>` is typically `heads` (branch) but can also be `tags` or
// `pull` — we accept any single segment there so tag URLs map
// correctly to `blob/<tag>/<path>`. Both stripped shapes resolve to
// the same content.
//
// Limitation shared with github-provider.ts: branch names
// containing `/` (e.g. `feature/foo`) are not supported — the
// first ref segment is taken and the rest folded into the path.
//
// Returns null for any URL that isn't a recognised raw URL — callers
// fall back to the original URL.
//
// Query strings + fragments get stripped — they don't carry over to
// the github.com page (a `?token=…` is raw-only; an `#L42` fragment
// would point at the wrong viewer anchor).
export function githubRawToBlobUrl(rawUrl: string): string | null {
  // Two regexes (rather than one with alternation) because owner/repo
  // sit at different positions in the two shapes.
  let m = /^https?:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/(?:refs\/[^\/]+\/)?([^\/]+)\/([^?#]+)/i.exec(rawUrl);
  if (!m) {
    m = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/raw\/(?:refs\/[^\/]+\/)?([^\/]+)\/([^?#]+)/i.exec(rawUrl);
  }
  if (!m) return null;
  const [, owner, repo, ref, path] = m;
  return `https://github.com/${owner}/${repo}/blob/${ref}/${path}`;
}
