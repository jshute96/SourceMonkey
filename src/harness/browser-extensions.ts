// The userscript managers in a browser, and turning them on, off and
// in: what `status`, a run's first lines and the `manager` commands
// read and do.
//
// - Over a CDP WebSocket of sm-dev's own, since Playwright's browser
//   session can't reach the hidden target used here.
// - Listing, enabling and "Allow User Scripts" go through a hidden
//   `chrome://extensions` target (no tab in the tab strip), calling
//   the `chrome.developerPrivate` and `chrome.management` functions
//   behind that page's own toggles. CDP has no calls of its own for
//   them. No user gesture is needed.
// - Loading an unpacked extension is CDP's `Extensions.loadUnpacked`,
//   which works over a debugging port in Chrome and Chromium alike.

import { quoted, WARNING_PREFIX } from './output-style.js';
import { MANAGERS, MANAGER_NAMES, managerFlag, type ManagerName } from './managers.js';
import { sourceMonkeyExtensionId } from './extension-backend.js';

/** One manager extension in the browser. */
export interface InstalledManager {
  manager: ManagerName;
  /** Its extension id. */
  id: string;
  /** As the extension names itself (`Tampermonkey BETA`). */
  name: string;
  version: string;
  enabled: boolean;
  /** "Allow User Scripts" is on, which a manager needs to run scripts. */
  userScripts: boolean;
  /** The folder it was loaded from, when loaded unpacked, as Chrome says. */
  path?: string;
  /** Installed from the Chrome Web Store, as Chrome says. */
  fromStore?: boolean;
}

type CdpReply = { result?: Record<string, unknown>; error?: { message: string } };
type Send = (method: string, params?: object, sessionId?: string) => Promise<Record<string, unknown>>;

// The browser's own WebSocket. Every send fails once `signal` aborts or
// the socket closes, so nothing waits on a browser that's gone.
async function openBrowserSocket(endpoint: string, signal: AbortSignal): Promise<{ send: Send; close(): void }> {
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error('The browser took too long to answer'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail);
  });
  aborted.catch(() => undefined);
  const waiting = new Map<number, (reply: CdpReply) => void>();
  const url = /^wss?:/.test(endpoint) ? endpoint
    : ((await Promise.race([fetch(`${endpoint}/json/version`, { signal }).then((r) => r.json()), aborted])) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  const open = new WebSocket(url);
  let closed = false;
  const settleAll = (): void => {
    closed = true;
    for (const answer of waiting.values()) answer({ error: { message: 'The connection to the browser closed' } });
    waiting.clear();
  };
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        open.onopen = resolve;
        open.onerror = () => reject(new Error('The browser\'s CDP socket could not be opened'));
      }),
      aborted,
    ]);
  } catch (err) {
    open.close();
    throw err;
  }
  open.onclose = settleAll;
  let last = 0;
  open.onmessage = (event) => {
    const reply = JSON.parse(String(event.data));
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  };
  const send: Send = async (method, params = {}, sessionId) => {
    if (closed) throw new Error(`${method} failed: The connection to the browser closed`);
    const id = ++last;
    const reply = await Promise.race([
      new Promise<CdpReply>((resolve) => {
        waiting.set(id, resolve);
        open.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      aborted,
    ]);
    if (reply.error) throw new Error(`${method} failed: ${reply.error.message}`);
    return reply.result ?? {};
  };
  return {
    send,
    close: () => {
      open.close();
      settleAll();
    },
  };
}

// The browser's own WebSocket, open for `fn`, closed after. Throws when
// it can't be reached, or `fn` takes longer than `timeoutMs`.
async function withBrowserSocket<T>(endpoint: string, timeoutMs: number, fn: (send: Send, signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('The browser took too long to answer')));
  });
  aborted.catch(() => undefined);
  const socket = await openBrowserSocket(endpoint, signal);
  try {
    return await Promise.race([fn(socket.send, signal), aborted]);
  } finally {
    socket.close();
  }
}

/** Runs JavaScript in a page, and gives back its value. */
export type Evaluate = <R>(expression: string) => Promise<R>;

// A hidden target (no tab in the tab strip) at `url`, attached, once
// `ready` (an expression) is true there. Not past `signal`, when every
// call fails at once. Returns its evaluate and its target id.
async function hiddenTarget(send: Send, url: string, ready: string, signal: AbortSignal): Promise<{ evaluate: Evaluate; targetId: string }> {
  const { targetId } = await send('Target.createTarget', { url, hidden: true }) as { targetId: string };
  try {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const evaluate: Evaluate = async <R>(expression: string): Promise<R> => {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId) as {
        result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string };
      };
      if (reply.exceptionDetails) {
        const { exception, text } = reply.exceptionDetails;
        // A thrown string (as Violentmonkey's calls throw) has no description.
        const why = exception?.description ?? (typeof exception?.value === 'string' ? exception.value : undefined) ?? text ?? 'It threw';
        throw new Error(why.split('\n')[0]);
      }
      return reply.result?.value as R;
    };
    // The page's functions are there once it has loaded.
    while (!await evaluate<boolean>(ready).catch(() => false)) {
      signal.throwIfAborted();
      await new Promise((r) => setTimeout(r, 50));
    }
    return { evaluate, targetId };
  } catch (err) {
    await send('Target.closeTarget', { targetId }).catch(() => undefined);
    throw err;
  }
}

// A hidden `chrome://extensions` target for `fn`'s calls, closed after.
async function withExtensionsPage<T>(endpoint: string, timeoutMs: number, fn: (evaluate: Evaluate) => Promise<T>): Promise<T> {
  return withBrowserSocket(endpoint, timeoutMs, async (send, signal) => {
    const { evaluate, targetId } = await hiddenTarget(send, 'chrome://extensions', 'typeof chrome?.developerPrivate?.getExtensionsInfo === "function"', signal);
    try {
      return await fn(evaluate);
    } finally {
      await send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  });
}

/** A hidden page kept open over its own connection, until `close`. */
export interface HiddenPage {
  /** Fails when the page doesn't answer within `timeoutMs`. */
  evaluate<R>(expression: string, timeoutMs?: number): Promise<R>;
  close(): Promise<void>;
}

/**
 * Opens a hidden page at `url` in the browser at `endpoint`, once
 * `ready` (an expression) is true there, for several calls. Throws when
 * it isn't ready within `timeoutMs`.
 */
export async function openHiddenPage(endpoint: string, url: string, ready: string, timeoutMs = 10_000): Promise<HiddenPage> {
  const life = new AbortController();
  const opening = AbortSignal.any([life.signal, AbortSignal.timeout(timeoutMs)]);
  const socket = await openBrowserSocket(endpoint, life.signal);
  let target: { evaluate: Evaluate; targetId: string };
  try {
    target = await Promise.race([
      hiddenTarget(socket.send, url, ready, opening),
      new Promise<never>((_, reject) => opening.addEventListener('abort', () => reject(new Error('The page took too long to open')))),
    ]);
  } catch (err) {
    socket.close();
    throw err;
  }
  return {
    evaluate: async <R>(expression: string, callMs = 30_000): Promise<R> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          target.evaluate<R>(expression),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('The browser took too long to answer')), callMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    close: async () => {
      await socket.send('Target.closeTarget', { targetId: target.targetId }).catch(() => undefined);
      socket.close();
      life.abort();
    },
  };
}

interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  state: string;
  location: string;
  path?: string;
  userScriptsAccess?: { isActive?: boolean };
}

// Which manager an extension is: by its id (SourceMonkey's fixed one,
// or a Web Store id, which a fetched copy keeps), else by its name.
function managerOf(info: ExtensionInfo, sourceMonkeyId: string): ManagerName | null {
  if (info.id === sourceMonkeyId) return 'sourcemonkey';
  const byId = MANAGER_NAMES.find((name) => MANAGERS[name].storeId === info.id);
  if (byId) return byId;
  return MANAGER_NAMES.find((name) => info.name.toLowerCase().startsWith(MANAGERS[name].label.toLowerCase())) ?? null;
}

/**
 * The managers installed in the browser at `endpoint`, enabled or not:
 * SourceMonkey first, then Tampermonkey, then Violentmonkey. Throws when
 * it can't tell.
 */
export async function installedManagers(endpoint: string, timeoutMs = 5000): Promise<InstalledManager[]> {
  const sourceMonkeyId = await sourceMonkeyExtensionId();
  const infos = await withExtensionsPage(endpoint, timeoutMs, (evaluate) => evaluate<ExtensionInfo[]>(
    'chrome.developerPrivate.getExtensionsInfo().then((all) => all.map((i) => ({ id: i.id, name: i.name, version: i.version, state: i.state, location: i.location, path: i.path, userScriptsAccess: i.userScriptsAccess })))',
  ));
  const found: InstalledManager[] = [];
  for (const info of infos) {
    const manager = managerOf(info, sourceMonkeyId);
    if (!manager) continue;
    found.push({
      manager,
      id: info.id,
      name: info.name,
      version: info.version,
      enabled: info.state === 'ENABLED',
      userScripts: info.userScriptsAccess?.isActive === true,
      ...(info.location === 'UNPACKED' && info.path ? { path: info.path } : {}),
      ...(info.location === 'FROM_STORE' ? { fromStore: true } : {}),
    });
  }
  // In a fixed order, rather than Chrome's.
  return found.sort((a, b) => MANAGER_NAMES.indexOf(a.manager) - MANAGER_NAMES.indexOf(b.manager));
}

/** `installedManagers`, or null when it can't tell, for what only reports. */
export function managersIn(endpoint: string): Promise<InstalledManager[] | null> {
  return installedManagers(endpoint).catch(() => null);
}

/** Turns an extension on or off, as its toggle in `chrome://extensions` does. */
export async function setExtensionEnabled(endpoint: string, id: string, enabled: boolean): Promise<void> {
  await withExtensionsPage(endpoint, 10_000, (evaluate) => evaluate(`chrome.management.setEnabled(${JSON.stringify(id)}, ${enabled})`));
}

/** Turns on an extension's "Allow User Scripts", as its details page does. */
export async function allowUserScripts(endpoint: string, id: string): Promise<void> {
  await withExtensionsPage(endpoint, 10_000, (evaluate) => evaluate(
    `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(id)}, userScriptsAccess: true })`,
  ));
}

/**
 * Loads the unpacked extension in `dir` into the browser, or reloads it
 * from there when it's loaded already. Returns its id.
 */
export async function loadUnpacked(endpoint: string, dir: string): Promise<string> {
  const { id } = await withBrowserSocket(endpoint, 30_000, (send) => send('Extensions.loadUnpacked', { path: dir })) as { id: string };
  return id;
}

/**
 * Warns of each manager enabled beside `chosen`, whose scripts run in
 * the run's tabs too, with how to turn it off. For a run's first lines,
 * `status`, and the commands that connect without a run. `browserArg`:
 * the flags that name the browser in the advice (see `browserArg` in
 * run.ts).
 */
export function otherManagersWarning(managers: InstalledManager[], chosen: ManagerName, browserArg = ''): string[] {
  const others = [...new Set(managers.filter((m) => m.enabled && m.manager !== chosen).map((m) => m.manager))];
  return others.map((manager) =>
    `${WARNING_PREFIX}${MANAGERS[manager].label} is also enabled in this browser, so its scripts run too. To turn it off, use ${quoted(`sm-dev${browserArg} ${managerFlag(manager)} manager disable`)}.`);
}

/**
 * The managers in the browser, for `status`: `SourceMonkey 0.0.1 (in
 * use), Tampermonkey 5.5.1 (disabled)`. Each copy is listed, with what
 * keeps it from running scripts. `None` when there are none. `mark`:
 * what the chosen one is, when enabled.
 */
export function managersText(managers: InstalledManager[], chosen: ManagerName, mark = 'in use'): string {
  if (managers.length === 0) return 'None';
  return managers.map((m) => {
    const notes = [
      ...(m.manager === chosen && m.enabled ? [mark] : []),
      ...(!m.enabled ? ['disabled'] : []),
      ...(!m.userScripts ? ['Allow User Scripts is off'] : []),
    ];
    return `${m.name} ${m.version}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
  }).join(', ');
}

/** Whether a manager is in a browser: enabled, there but turned off, or not there. */
export type ManagerState = 'installed' | 'disabled' | 'absent';

export function managerState(managers: InstalledManager[], name: ManagerName): ManagerState {
  const copies = managers.filter((m) => m.manager === name);
  return copies.some((m) => m.enabled) ? 'installed' : copies.length > 0 ? 'disabled' : 'absent';
}

/** How a run's first line says the chosen manager's state: `has Tampermonkey`. */
export function stateLabel(state: ManagerState, name: ManagerName): string {
  const { label } = MANAGERS[name];
  return { installed: `has ${label}`, disabled: `${label} disabled`, absent: `no ${label}` }[state];
}

/** The browser at `endpoint`: Chrome's version, and whether it's headless. Null when nothing answers. */
export async function browserVersion(endpoint: string): Promise<{ version: string; headless: boolean } | null> {
  try {
    const info = await withBrowserSocket(endpoint, 2000, (send) => send('Browser.getVersion')) as { product?: string; userAgent?: string };
    return { version: (info.product ?? '').replace(/^\w+\//, ''), headless: /\bHeadlessChrome\//.test(info.userAgent ?? '') };
  } catch {
    return null;
  }
}
