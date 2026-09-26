// The CDP proxy `sm-dev start --devtools` puts between DevTools and the
// browser: a client sees only the tabs whose pages the proxy was told
// to allow, and works with those as it would with the browser itself.
// Driven here by a plain CDP client doing what DevTools' Puppeteer does
// on connecting.

import { test, expect } from '@playwright/test';

import { CdpProxy } from '../../lib/harness/cdp-proxy.js';
import { launchDebugBrowser, openTab, type DebugBrowser } from '../fixtures/debug-browser.js';

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: unknown;
  sessionId?: string;
}

// A CDP client that records every message it's sent.
class Client {
  readonly log: Message[] = [];
  private nextId = 1;
  private readonly waiters = new Set<() => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      this.log.push(JSON.parse(String(e.data)) as Message);
      for (const wake of this.waiters) wake();
    };
  }

  static async connect(proxy: CdpProxy): Promise<Client> {
    const { webSocketDebuggerUrl } = await (await fetch(`${proxy.url}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('Could not connect to the proxy'));
    });
    return new Client(ws);
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Message> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return this.waitFor((m) => m.id === id);
  }

  waitFor(match: (m: Message) => boolean, ms = 10_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const hit = this.log.find(match);
        if (!hit) return;
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve(hit);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`No matching message within ${ms}ms`));
      }, ms);
      this.waiters.add(check);
      check();
    });
  }

  /** The targets of every root `Target.attachedToTarget` so far. */
  attachedTabs(): string[] {
    return this.log.filter((m) => m.method === 'Target.attachedToTarget' && !m.sessionId && m.params!.targetInfo.type === 'tab')
      .map((m) => m.params!.targetInfo.targetId);
  }

  close(): void {
    this.ws.close();
  }
}

// What Puppeteer does on connecting: discover every target, and
// auto-attach the tabs, and each tab's page under it.
async function connectLikePuppeteer(proxy: CdpProxy): Promise<Client> {
  const client = await Client.connect(proxy);
  await client.send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
  await client.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: true }, {}],
  });
  return client;
}

// The page inside a tab the client was shown, attached under it.
async function pageUnder(client: Client, tabSession: string): Promise<Message> {
  void client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, tabSession);
  return client.waitFor((m) => m.method === 'Target.attachedToTarget' && m.sessionId === tabSession);
}

let browser: DebugBrowser;
let proxy: CdpProxy | null = null;
let client: Client | null = null;

test.beforeEach(async () => {
  browser = await launchDebugBrowser();
});

test.afterEach(async () => {
  client?.close();
  await proxy?.close();
  client = null;
  proxy = null;
  await browser.close();
});

const endpoint = (): string => `http://127.0.0.1:${browser.port}`;

test('shows the allowed tab, before its initial attach is done, and hides one already open', async () => {
  const ours = await openTab(browser.port);
  const theirs = await openTab(browser.port, 'about:blank#theirs');
  proxy = await CdpProxy.start(endpoint());
  proxy.allow(ours);
  // Let the proxy find the allowed page's tab, as the run's is by the
  // time DevTools connects.
  await new Promise((r) => setTimeout(r, 500));
  client = await Client.connect(proxy);
  await client.send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
  const attach = await client.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: true }, {}],
  });
  // Puppeteer waits only for the tabs attached before this reply.
  const tabAttach = client.log.findIndex((m) => m.method === 'Target.attachedToTarget');
  expect(tabAttach).toBeGreaterThanOrEqual(0);
  expect(tabAttach).toBeLessThan(client.log.indexOf(attach));
  expect(client.attachedTabs()).toHaveLength(1);

  const page = await pageUnder(client, client.log[tabAttach].params!.sessionId);
  expect(page.params!.targetInfo.targetId).toBe(ours);
  const targets = (await client.send('Target.getTargets')).result!.targetInfos as { targetId: string; type: string }[];
  expect(targets.filter((t) => t.type === 'page').map((t) => t.targetId)).toEqual([ours]);
  expect(JSON.stringify(client.log)).not.toContain(theirs);
});

test('a session the client attaches itself works', async () => {
  const ours = await openTab(browser.port);
  proxy = await CdpProxy.start(endpoint());
  proxy.allow(ours);
  client = await connectLikePuppeteer(proxy);
  const attached = await client.send('Target.attachToTarget', { targetId: ours, flatten: true });
  const session = attached.result!.sessionId as string;
  const answer = await client.send('Runtime.evaluate', { expression: '6 * 7', returnByValue: true }, session);
  expect(answer.result!.result.value).toBe(42);
});

test('a tab opened later is shown once it\'s allowed, and one let go is attached again', async () => {
  proxy = await CdpProxy.start(endpoint(), { holdMs: 1000 });
  client = await connectLikePuppeteer(proxy);

  const soon = await openTab(browser.port, 'about:blank#soon');
  await new Promise((r) => setTimeout(r, 300));
  expect(client.attachedTabs()).toEqual([]);
  proxy.allow(soon);
  const shown = await client.waitFor((m) => m.method === 'Target.attachedToTarget' && !m.sessionId);
  expect((await pageUnder(client, shown.params!.sessionId)).params!.targetInfo.targetId).toBe(soon);

  // Held past the hold, so let go; then allowed.
  const late = await openTab(browser.port, 'about:blank#late');
  await new Promise((r) => setTimeout(r, 1500));
  expect(client.attachedTabs()).toHaveLength(1);
  proxy.allow(late);
  await client.waitFor(() => client!.attachedTabs().length === 2);
});

test('a tab the client opens itself is shown', async () => {
  proxy = await CdpProxy.start(endpoint());
  client = await connectLikePuppeteer(proxy);
  const created = await client.send('Target.createTarget', { url: 'about:blank#mine' });
  const shown = await client.waitFor((m) => m.method === 'Target.attachedToTarget' && !m.sessionId);
  expect((await pageUnder(client, shown.params!.sessionId)).params!.targetInfo.targetId).toBe(created.result!.targetId);
});
