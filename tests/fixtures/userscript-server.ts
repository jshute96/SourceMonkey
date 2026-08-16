// Tiny in-process HTTP server for e2e tests of the change-detection
// pipeline. Each test can register mutable routes — a userscript body,
// a manifest JSON — and toggle whether the server returns
// ETag / Last-Modified validators. Conditional GETs are honoured when
// validators are set, so the test can exercise the HTTP 304 path AND
// the no-validator fallback against the same server.
//
// Why this exists separately from `fixtureServer` in extension.ts:
// fixtureServer serves static HTML pages from a fixed directory and is
// worker-scoped. The change-detection tests need per-test mutable state
// (current body, current validators) and a different content-type, so
// each test spins up its own short-lived server.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Route {
  // String or Buffer — Buffer for binary payloads like PNG icons that
  // would otherwise be mangled by UTF-8 encoding of `res.end(string)`.
  body: string | Buffer;
  contentType: string;
  etag?: string;
  lastModified?: string;
  // When set, the route answers with a 302 to this Location instead of
  // serving `body`. Used to exercise the @connect redirect re-check.
  redirectTo?: string;
}

// Per-route record of how each incoming GET was answered. Tests use
// this to assert that they're actually exercising the path they claim
// to (e.g. that a conditional-GET test really saw a 304, not just an
// indistinguishable 200 + content-hash match).
export interface RequestLogEntry {
  path: string;
  status: number;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  // Raw `Cookie` request header, when the client sent one. Lets the
  // GM_xmlhttpRequest credentials tests assert whether the browser
  // attached the user's cookies to an extension-initiated fetch.
  cookie?: string;
}

export class UserscriptServer {
  private readonly server: http.Server;
  private readonly routes = new Map<string, Route>();
  private readonly log: RequestLogEntry[] = [];
  private _baseUrl = '';

  static async start(): Promise<UserscriptServer> {
    const s = new UserscriptServer();
    await s.listen();
    return s;
  }

  private constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  private listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as AddressInfo;
        this._baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  get baseUrl(): string { return this._baseUrl; }

  // Read-only view of every request the server has answered, in
  // arrival order. Tests use this to verify which response path each
  // request took.
  get requestLog(): readonly RequestLogEntry[] { return this.log; }

  // Convenience: how many requests for `path` ended in `status`. Lets
  // a conditional-GET test directly assert "the second refresh got a
  // 304" rather than just "loadedAt is preserved" (which the
  // content-hash fallback could also produce).
  countResponses(path: string, status: number): number {
    const normalized = this.normalize(path);
    return this.log.filter((e) => e.path === normalized && e.status === status).length;
  }

  // Register or replace a route's body. Pass validators only when the
  // test wants to exercise the conditional-GET path; leaving them
  // undefined exercises the no-validator fallback (so the SW has to
  // hash the body to decide whether anything changed).
  setRoute(
    path: string,
    body: string | Buffer,
    opts: { etag?: string; lastModified?: string; contentType?: string } = {},
  ): void {
    const route: Route = {
      body,
      contentType: opts.contentType ?? 'application/javascript; charset=utf-8',
    };
    if (opts.etag) route.etag = opts.etag;
    if (opts.lastModified) route.lastModified = opts.lastModified;
    this.routes.set(this.normalize(path), route);
  }

  // Helper for posting a JSON manifest — sets Content-Type to JSON and
  // serialises `entries` as the bare-array shape parseManifest accepts.
  setManifest(path: string, entries: string[]): void {
    this.setRoute(path, JSON.stringify(entries), {
      contentType: 'application/json; charset=utf-8',
    });
  }

  // Register a 302 redirect route. `location` is the absolute URL the
  // route redirects to. Used to test that GM_xmlhttpRequest's @connect
  // re-check rejects a redirect whose final host isn't allowlisted.
  setRedirect(path: string, location: string): void {
    this.routes.set(this.normalize(path), {
      body: '',
      contentType: 'text/plain',
      redirectTo: location,
    });
  }

  // Drop a route so its URL starts 404'ing. Used by tests that need to
  // model a vanished manifest entry.
  removeRoute(path: string): void {
    this.routes.delete(this.normalize(path));
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private normalize(p: string): string {
    return p.startsWith('/') ? p : `/${p}`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const entry: RequestLogEntry = { path: url.pathname, status: 0 };
    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string') entry.ifNoneMatch = ifNoneMatch;
    const ifModifiedSince = req.headers['if-modified-since'];
    if (typeof ifModifiedSince === 'string') entry.ifModifiedSince = ifModifiedSince;
    const cookie = req.headers['cookie'];
    if (typeof cookie === 'string') entry.cookie = cookie;
    try {
      const route = this.routes.get(url.pathname);
      if (!route) {
        entry.status = 404;
        res.statusCode = 404;
        res.end();
        return;
      }
      if (route.redirectTo) {
        entry.status = 302;
        res.statusCode = 302;
        res.setHeader('Location', route.redirectTo);
        res.end();
        return;
      }
      // Conditional GET: if the client replays our prior validator and
      // it still matches, return 304 with no body. We check ETag and
      // Last-Modified independently — both are sent by the SW when the
      // server set them earlier, and either one matching is enough to
      // satisfy "still fresh." Mirrors real HTTP server behavior
      // closely enough to exercise the SW's conditional-GET path.
      if (
        (route.etag && ifNoneMatch === route.etag) ||
        (route.lastModified && ifModifiedSince === route.lastModified)
      ) {
        entry.status = 304;
        res.statusCode = 304;
        if (route.etag) res.setHeader('ETag', route.etag);
        if (route.lastModified) res.setHeader('Last-Modified', route.lastModified);
        res.end();
        return;
      }
      entry.status = 200;
      res.statusCode = 200;
      res.setHeader('Content-Type', route.contentType);
      if (route.etag) res.setHeader('ETag', route.etag);
      if (route.lastModified) res.setHeader('Last-Modified', route.lastModified);
      res.end(route.body);
    } catch (err) {
      entry.status = 500;
      res.statusCode = 500;
      res.end(String(err));
    } finally {
      this.log.push(entry);
    }
  }
}

// Build a minimal valid userscript body — enough to pass validateHeader
// (`@name` + `@match`). Tests vary the body suffix to model "content
// changed" while keeping the metadata block stable.
export function userscriptText(name: string, bodySuffix = ''): string {
  return [
    '// ==UserScript==',
    `// @name        ${name}`,
    '// @match       https://example.com/*',
    '// ==/UserScript==',
    `console.log('${name}');${bodySuffix}`,
    '',
  ].join('\n');
}
