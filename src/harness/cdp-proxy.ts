// A CDP endpoint (Chrome DevTools Protocol) that shows a client only
// some of the browser's tabs: the run's own. `sm-dev start --devtools`
// points the DevTools server at it rather than at the browser.
//
// Why: DevTools' Puppeteer attaches to every tab in the browser, and
// waits for each to report the page inside it before its connection is
// ready. One tab of the person's that never answers (a frozen
// background tab, one on a dialog) holds up every DevTools call. It
// also turns on focus emulation in every tab it attaches to.
//
// How:
// - Each client gets a connection of its own to the browser, and the
//   traffic passes through, except what is about other tabs: their
//   discovery and attach events are dropped, and `Target.getTargets`
//   lists only the allowed ones.
// - The browser still attaches the other tabs to that connection (the
//   client asked for every tab). The proxy lets any it paused run, and
//   detaches them.
// - A tab is shown when the page inside it is one `allow` named. Chrome
//   lists tabs and pages with unrelated ids, and a tab's own URL isn't
//   kept up to date, so the page inside a tab is found on a side
//   connection: attach to the tab, have it report its page, detach. The
//   tabs are asked when a page is allowed whose tab isn't known yet,
//   each once; one that doesn't answer is asked again only while an
//   allowed page's tab is still unknown.
// - A tab not allowed yet is held, not dropped, for a while: a tab the
//   run's page opens is only claimed once it has started loading. One
//   claimed after it was let go is attached again.
//
// The client side speaks WebSocket through a small server here (the
// handshake and text frames), since the harness has no WebSocket
// library; the browser side uses Node's own WebSocket client.

import { createHash } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  [key: string]: unknown;
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
  sessionId?: string;
}

export interface CdpProxyOptions {
  /** How long a tab not claimed yet is held before it's let go. */
  holdMs?: number;
}

const HOLD_MS = 30_000;
// How long a tab gets to report its page, and how soon one that didn't
// is asked again.
const PROBE_TIMEOUT_MS = 3000;
const REPROBE_MS = 5000;
// Tabs asked at once.
const PROBE_BATCH = 6;

// Commands the proxy sends on a client's connection itself, numbered
// well clear of the client's own.
const OWN_ID_BASE = 2_000_000_000;

export class CdpProxy {
  private readonly allowedPages = new Set<string>();
  // The page inside each tab asked, and the tab of each such page.
  private readonly pageOfTab = new Map<string, string>();
  private readonly tabOfPage = new Map<string, string>();
  // When a tab last failed to report its page.
  private readonly unanswered = new Map<string, number>();
  private readonly probing = new Map<string, Promise<void>>();
  // Every tab open, from the side connection's discovery.
  private readonly tabs = new Set<string>();
  private readonly clients = new Set<ClientLink>();
  private finding: Promise<void> | null = null;
  private closed = false;

  private constructor(
    private readonly browserWs: string,
    private readonly server: http.Server,
    private readonly side: Upstream,
    readonly url: string,
    readonly holdMs: number,
  ) {}

  /**
   * Listens on a free local port, in front of the browser whose CDP
   * endpoint is `endpoint` (an `http://` one, or its `ws://` browser
   * URL).
   */
  static async start(endpoint: string, options: CdpProxyOptions = {}): Promise<CdpProxy> {
    let browserWs = endpoint;
    if (!/^wss?:\/\//i.test(endpoint)) {
      const version = `${endpoint.replace(/\/+$/, '')}/json/version`;
      try {
        browserWs = ((await (await fetch(version)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
      } catch {
        throw new Error(`The browser's endpoint ${version} didn't answer`);
      }
    }
    const side = await Upstream.open(browserWs);
    const server = http.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    } catch (err) {
      side.close();
      throw err;
    }
    const { port } = server.address() as net.AddressInfo;
    const proxy = new CdpProxy(browserWs, server, side, `http://127.0.0.1:${port}`, options.holdMs ?? HOLD_MS);
    server.on('request', (req, res) => proxy.serveHttp(req, res));
    server.on('upgrade', (req, socket) => proxy.upgrade(req, socket as net.Socket));
    try {
      await proxy.watchTabs();
    } catch (err) {
      await proxy.close();
      throw err;
    }
    return proxy;
  }

  /** Lets clients see the tab this page is in. */
  allow(pageTargetId: string): void {
    if (this.closed || this.allowedPages.has(pageTargetId)) return;
    this.allowedPages.add(pageTargetId);
    if (this.tabOfPage.has(pageTargetId)) this.changed();
    else this.findTabs();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) client.close();
    this.side.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // For ClientLink.

  /** Whether a tab is shown: true or false once its page is known, else unknown. */
  tabAllowed(tabId: string): boolean | 'unknown' {
    const page = this.pageOfTab.get(tabId);
    return page === undefined ? 'unknown' : this.allowedPages.has(page);
  }

  pageAllowed(pageTargetId: string): boolean {
    return this.allowedPages.has(pageTargetId);
  }

  /** The targets a `Target.getTargets` reply may list: shown tabs and their pages. */
  visible(info: TargetInfo): boolean {
    if (info.type === 'page') return this.allowedPages.has(info.targetId);
    if (info.type === 'tab') return this.tabAllowed(info.targetId) === true;
    return false;
  }

  /** Asks the tabs not known yet, when an allowed page's tab is unknown. */
  findTabs(): void {
    if (this.closed || this.finding) return;
    const missing = (): boolean => [...this.allowedPages].some((page) => !this.tabOfPage.has(page));
    if (!missing()) return;
    this.finding = (async () => {
      const now = Date.now();
      const ask = [...this.tabs].filter((tab) => !this.pageOfTab.has(tab) && now - (this.unanswered.get(tab) ?? 0) >= REPROBE_MS);
      for (let i = 0; i < ask.length && missing() && !this.closed; i += PROBE_BATCH) {
        await Promise.all(ask.slice(i, i + PROBE_BATCH).map((tab) => this.probe(tab)));
      }
    })().finally(() => {
      this.finding = null;
      // Still one missing, with tabs that didn't answer: again later.
      if (missing() && !this.closed) setTimeout(() => this.findTabs(), REPROBE_MS).unref();
    });
  }

  // Tab discovery on the side connection, so every tab open is known.
  private async watchTabs(): Promise<void> {
    this.side.onEvent = (msg) => {
      const info = msg.params?.targetInfo as TargetInfo | undefined;
      if (msg.method === 'Target.targetCreated' && info?.type === 'tab') {
        this.tabs.add(info.targetId);
        this.findTabs();
      } else if (msg.method === 'Target.targetDestroyed') {
        const id = msg.params!.targetId as string;
        this.tabs.delete(id);
        this.unanswered.delete(id);
        const page = this.pageOfTab.get(id);
        if (page !== undefined) this.tabOfPage.delete(page);
        this.pageOfTab.delete(id);
      }
    };
    this.side.onClose = () => void this.close();
    // Tabs only; by default discovery leaves them out.
    await this.side.send('Target.setDiscoverTargets', { discover: true, filter: [{ type: 'tab' }] });
  }

  // The page inside a tab: attach to it, have it report its page, and
  // detach. One that doesn't answer in time is noted, to be asked again
  // later.
  private probe(tabId: string): Promise<void> {
    const pending = this.probing.get(tabId);
    if (pending) return pending;
    const side = this.side;
    const work = (async () => {
      let session: string | undefined;
      try {
        const attached = await side.send('Target.attachToTarget', { targetId: tabId, flatten: true });
        session = attached.sessionId as string;
        const child = side.waitForEvent((m) => m.method === 'Target.attachedToTarget' && m.sessionId === session
          && (m.params?.targetInfo as TargetInfo)?.type === 'page', PROBE_TIMEOUT_MS);
        await side.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session);
        const page = ((await child).params!.targetInfo as TargetInfo).targetId;
        this.pageOfTab.set(tabId, page);
        this.tabOfPage.set(page, tabId);
        this.unanswered.delete(tabId);
        if (this.allowedPages.has(page)) this.changed();
      } catch {
        this.unanswered.set(tabId, Date.now());
      } finally {
        if (session) void side.send('Target.detachFromTarget', { sessionId: session }).catch(() => undefined);
      }
    })().finally(() => this.probing.delete(tabId));
    this.probing.set(tabId, work);
    return work;
  }

  // An allowed page's tab became known: clients may show it now.
  private changed(): void {
    for (const client of this.clients) client.reconsider();
  }

  // `/json/version` for a client connecting by URL, with the proxy's
  // own WebSocket address. Nothing else: the other `/json` routes point
  // at the pages' own endpoints, which the proxy doesn't serve.
  private serveHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host ?? this.url.slice('http://'.length);
    if ((req.url ?? '').replace(/\/+$/, '') === '/json/version') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Browser: 'sm-dev CDP proxy', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://${host}/devtools/browser/sm-dev` }));
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  private upgrade(req: http.IncomingMessage, socket: net.Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (this.closed || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = new ClientLink(this, new WsServerSocket(socket));
    this.clients.add(client);
    client.onClose = () => this.clients.delete(client);
    void client.connect(this.browserWs);
  }
}

// One client's connection, and its own connection to the browser.
class ClientLink {
  onClose: () => void = () => undefined;
  private upstream: Upstream | null = null;
  // Sessions the client knows of, and so may use.
  private readonly sessions = new Set<string>();
  // Tabs attached to this connection but not shown yet: the events
  // about them held back, in order, and the timer that decides them
  // again.
  private readonly held = new Map<string, { events: Message[]; since: number; session?: string; timer?: NodeJS.Timeout }>();
  // Tabs shown, and the session each was shown with.
  private readonly shown = new Map<string, string | undefined>();
  // Tabs let go, which may be claimed later.
  private readonly dropped = new Set<string>();
  // Targets the client asked to attach to itself, by id.
  private readonly attaching = new Set<string>();
  // What each of the client's commands was, to filter its reply.
  private readonly methods = new Map<string, { method: string; params?: Record<string, unknown> }>();
  private readonly queue: string[] = [];
  private ownId = OWN_ID_BASE;
  private closed = false;

  constructor(
    private readonly proxy: CdpProxy,
    private readonly ws: WsServerSocket,
  ) {
    ws.onMessage = (text) => this.fromClient(text);
    ws.onClose = () => this.close();
  }

  async connect(browserWs: string): Promise<void> {
    let upstream: Upstream;
    try {
      upstream = await Upstream.open(browserWs);
    } catch {
      this.close();
      return;
    }
    // Closed while connecting: this connection is no one's.
    if (this.closed) {
      upstream.close();
      return;
    }
    this.upstream = upstream;
    upstream.onEvent = (msg) => this.fromBrowser(msg);
    upstream.onReply = (msg) => this.replyToClient(msg);
    upstream.onClose = () => this.close();
    for (const text of this.queue.splice(0)) this.fromClient(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.held.values()) clearTimeout(entry.timer);
    this.upstream?.close();
    this.ws.close();
    this.onClose();
  }

  /** An allowed page's tab became known: held tabs may be shown, dropped ones attached again. */
  reconsider(): void {
    for (const tabId of [...this.held.keys()]) this.decide(tabId);
    for (const tabId of [...this.dropped]) {
      if (this.proxy.tabAllowed(tabId) !== true) continue;
      this.dropped.delete(tabId);
      // Its attach event comes as for any tab, and shows it.
      void this.own('Target.attachToTarget', { targetId: tabId, flatten: true });
    }
  }

  private fromClient(text: string): void {
    if (this.closed) return;
    if (!this.upstream) {
      this.queue.push(text);
      return;
    }
    let msg: Message;
    try {
      msg = JSON.parse(text) as Message;
    } catch {
      // Not CDP: nothing more from this client makes sense.
      this.close();
      return;
    }
    if (msg.id !== undefined && msg.method) {
      this.methods.set(`${msg.sessionId ?? ''}:${msg.id}`, { method: msg.method, params: msg.params });
      if (msg.method === 'Target.attachToTarget' && typeof msg.params?.targetId === 'string') this.attaching.add(msg.params.targetId);
    }
    this.upstream.sendRaw(text);
  }

  private replyToClient(msg: Message): void {
    const key = `${msg.sessionId ?? ''}:${msg.id}`;
    const sent = this.methods.get(key);
    this.methods.delete(key);
    if (sent?.method === 'Target.getTargets' && msg.result) {
      msg.result.targetInfos = (msg.result.targetInfos as TargetInfo[]).filter((info) => this.proxy.visible(info));
    } else if (sent?.method === 'Target.createTarget' && msg.result?.targetId) {
      // A tab the client opened itself is its to see.
      this.proxy.allow(msg.result.targetId as string);
    } else if (sent?.method === 'Target.attachToTarget') {
      this.attaching.delete(sent.params?.targetId as string);
      if (msg.result?.sessionId) this.sessions.add(msg.result.sessionId as string);
    }
    this.send(msg);
  }

  private fromBrowser(msg: Message): void {
    // Inside a session the client knows: all of it, and any target
    // attached under it (its page, frames, workers) joins the known ones.
    if (msg.sessionId) {
      if (!this.sessions.has(msg.sessionId)) return;
      if (msg.method === 'Target.attachedToTarget') this.sessions.add(msg.params!.sessionId as string);
      if (msg.method === 'Target.detachedFromTarget') this.sessions.delete(msg.params!.sessionId as string);
      this.send(msg);
      return;
    }
    const info = msg.params?.targetInfo as TargetInfo | undefined;
    switch (msg.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        if (info?.type === 'tab') this.tabEvent(info.targetId, msg);
        else if (info?.type === 'page' && this.proxy.pageAllowed(info.targetId)) this.send(msg);
        return;
      case 'Target.targetDestroyed': {
        const id = msg.params!.targetId as string;
        const entry = this.held.get(id);
        if (entry) clearTimeout(entry.timer);
        this.held.delete(id);
        this.dropped.delete(id);
        if (this.shown.has(id) || this.proxy.pageAllowed(id)) this.send(msg);
        this.shown.delete(id);
        return;
      }
      case 'Target.attachedToTarget':
        this.attached(msg, info!);
        return;
      case 'Target.detachedFromTarget': {
        const session = msg.params!.sessionId as string;
        if (!this.sessions.delete(session)) return;
        for (const [tab, s] of this.shown) if (s === session) this.shown.set(tab, undefined);
        this.send(msg);
        return;
      }
      default:
        this.send(msg);
    }
  }

  private attached(msg: Message, info: TargetInfo): void {
    const session = msg.params!.sessionId as string;
    // One the client asked for itself (Puppeteer's extra session on a
    // page, for DevTools' own use), of a target it may see: its own.
    if (this.attaching.has(info.targetId) && (this.proxy.visible(info) || info.type !== 'tab')) {
      this.sessions.add(session);
      this.send(msg);
      return;
    }
    if (info.type === 'tab') {
      this.tabEvent(info.targetId, msg, session);
      return;
    }
    // Workers and service workers the browser attached for the client:
    // none are the run's. Let run if paused, and let go.
    if (msg.params!.waitingForDebugger) void this.own('Runtime.runIfWaitingForDebugger', {}, session);
    void this.own('Target.detachFromTarget', { sessionId: session });
  }

  // An event about a tab: passed on if it's shown, else held until
  // decided.
  private tabEvent(tabId: string, msg: Message, session?: string): void {
    if (this.shown.has(tabId)) {
      if (session) {
        this.sessions.add(session);
        this.shown.set(tabId, session);
      }
      this.send(msg);
      return;
    }
    if (this.dropped.has(tabId)) {
      if (session) this.letGo(session, msg);
      return;
    }
    let entry = this.held.get(tabId);
    if (!entry) {
      entry = { events: [], since: Date.now() };
      this.held.set(tabId, entry);
    }
    entry.events.push(msg);
    if (session) {
      entry.session = session;
      // A tab not decided yet runs meanwhile: a person's new tab can't
      // wait paused for a claim that may never come. The cost: a tab
      // the run claims later loses its pause-on-start, so the client
      // may miss the start of its first load.
      if (this.proxy.tabAllowed(tabId) !== true && msg.params!.waitingForDebugger) {
        void this.own('Runtime.runIfWaitingForDebugger', {}, session);
        msg.params!.waitingForDebugger = false;
      }
    }
    this.decide(tabId);
  }

  private decide(tabId: string): void {
    const entry = this.held.get(tabId);
    if (!entry) return;
    clearTimeout(entry.timer);
    const allowed = this.proxy.tabAllowed(tabId);
    if (allowed === true) {
      this.held.delete(tabId);
      this.shown.set(tabId, entry.session);
      if (entry.session) this.sessions.add(entry.session);
      for (const event of entry.events) this.send(event);
      return;
    }
    // Not the run's page now may still be claimed later: the run only
    // claims a tab once it's loading. So a tab is let go only when its
    // hold is up.
    const left = this.proxy.holdMs - (Date.now() - entry.since);
    if (left <= 0) {
      this.held.delete(tabId);
      this.dropped.add(tabId);
      if (entry.session) this.letGo(entry.session, entry.events[entry.events.length - 1]);
      return;
    }
    if (allowed === 'unknown') this.proxy.findTabs();
    entry.timer = setTimeout(() => this.decide(tabId), Math.min(left + 10, REPROBE_MS));
    entry.timer.unref();
  }

  // Detaches a tab that isn't shown, running it first if it's paused.
  private letGo(session: string, attach: Message | undefined): void {
    if (attach?.params?.waitingForDebugger) void this.own('Runtime.runIfWaitingForDebugger', {}, session);
    void this.own('Target.detachFromTarget', { sessionId: session });
  }

  private send(msg: Message): void {
    if (!this.closed) this.ws.send(JSON.stringify(msg));
  }

  private own(method: string, params: Record<string, unknown>, sessionId?: string): Promise<void> {
    if (!this.upstream) return Promise.resolve();
    return this.upstream.send(method, params, sessionId, ++this.ownId).then(() => undefined, () => undefined);
  }
}

// A connection to the browser, with replies matched to requests.
class Upstream {
  onEvent: (msg: Message) => void = () => undefined;
  // Replies to requests made with `sendRaw`, which are the client's.
  onReply: (msg: Message) => void = () => undefined;
  onClose: () => void = () => undefined;
  private readonly waiting = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly watchers = new Set<(msg: Message) => boolean>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as Message;
      if (msg.id !== undefined) {
        const wait = this.waiting.get(msg.id);
        if (!wait) {
          this.onReply(msg);
          return;
        }
        this.waiting.delete(msg.id);
        if (msg.error) wait.reject(new Error(JSON.stringify(msg.error)));
        else wait.resolve(msg.result ?? {});
        return;
      }
      for (const watch of this.watchers) if (watch(msg)) this.watchers.delete(watch);
      this.onEvent(msg);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const wait of this.waiting.values()) wait.reject(new Error('The browser connection closed'));
      this.waiting.clear();
      this.onClose();
    };
  }

  static open(url: string): Promise<Upstream> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Upstream(ws));
      ws.onerror = () => reject(new Error(`Could not connect to the browser at ${url}`));
    });
  }

  sendRaw(text: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  send(method: string, params: Record<string, unknown>, sessionId?: string, id = this.nextId++): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('The browser connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, PROBE_TIMEOUT_MS);
      timer.unref();
      this.waiting.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sendRaw(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitForEvent(match: (msg: Message) => boolean, timeout: number): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.watchers.delete(watch);
        reject(new Error('Timed out'));
      }, timeout);
      timer.unref();
      const watch = (msg: Message): boolean => {
        if (!match(msg)) return false;
        clearTimeout(timer);
        resolve(msg);
        return true;
      };
      this.watchers.add(watch);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Closed already.
    }
  }
}

// The server end of a WebSocket, as much as a CDP client needs: text
// messages (fragmented or not), ping, and close.
class WsServerSocket {
  onMessage: (text: string) => void = () => undefined;
  onClose: () => void = () => undefined;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  send(text: string): void {
    if (!this.closed) this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  /** Sends a close frame, and ends the connection once it's flushed. */
  close(): void {
    if (this.closed) return;
    this.frame(0x8, Buffer.alloc(0));
    this.socket.end();
    // In case the other end never closes its side.
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed || this.socket.writableEnded) return;
    const n = payload.length;
    const header = n < 126 ? Buffer.from([0x80 | opcode, n])
      : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(n)]);
    this.socket.write(Buffer.concat([header, payload]));
  }

  private parse(): void {
    while (!this.closed) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= this.buffer[maskAt + (i % 4)];
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onMessage(text);
        }
      }
    }
  }
}

function bigLength(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}
