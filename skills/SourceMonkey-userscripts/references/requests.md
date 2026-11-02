# Requests to other sites

## Where a request comes from matters

A `GM_xmlhttpRequest` goes from the extension, not the page. It carries
different cookies, no `Origin`, and `Sec-Fetch-Site: none`, a value no
page can produce and that some firewalls reject. `sm-dev` and the
harness send it from the real extension, as an installed script does,
but a page-context `fetch` (from `sm-dev eval --page`) doesn't.

**When a design depends on a request from a new place, send one real
request from there first.** One script was rewritten at length around
"the page can fetch from the other site now", checked with a
page-context `fetch`, and then every API call from the script returned
403.

- A 403 the page can't reproduce is probably the site's edge network
  (CDN or firewall), not its server. With Cloudflare, the failing
  response lacks the `cf-cache-status` header the working one has.
- A site behind a Cloudflare challenge ("Just a moment...") answers a
  cross-site `GM_xmlhttpRequest` with the challenge page. Prefer a JSON
  API over scraping such a site.

## `@connect`

List each host the script requests from with `@connect`. A request to
an unlisted host waits on the manager's permission prompt (see
"Permission prompts" in `SourceMonkey-dev`), and a person may deny it.
Handle the denial: log it, and say on the page what didn't load.
