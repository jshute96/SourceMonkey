// Tabs whose page doesn't answer, found before `sm-dev start` connects.
//
// Playwright's connection isn't ready until it has set up every tab in
// the browser, and a tab showing a dialog (alert, confirm, prompt, or a
// "leave site?" prompt) answers nothing until the dialog is closed: not
// even the call that would report the dialog. So one such tab of the
// person's holds up the run until Playwright gives up.
//
// No call reports a dialog that opened before the connection asking,
// or answers one (Page.handleJavaScriptDialog says none is showing), so
// each tab is asked for something trivial, on a connection of its own,
// and one that stays quiet is named. That can also be a page busy in a
// long script. (A page paused in the debugger still answers.)

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

interface Message {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** A tab whose page didn't answer. */
export interface StuckTab {
  targetId: string;
  title: string;
  url: string;
}

// How long a page gets to answer, and the browser to take the side
// connection.
const ANSWER_MS = 2000;
const CONNECT_MS = 5000;
// How often the tabs that didn't are asked again.
const RECHECK_MS = 1000;

/**
 * The browser's tabs whose pages don't answer, of `only` when given.
 * Throws when the browser itself can't be reached: the caller's own
 * connect then says so.
 */
export async function stuckTabs(endpoint: string, only?: Set<string>): Promise<StuckTab[]> {
  // A `ws://` endpoint is the browser's own connection already.
  const url = /^wss?:/i.test(endpoint) ? endpoint
    : (await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(CONNECT_MS) })).json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The browser\'s debugging connection did not open')), CONNECT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('The browser\'s debugging connection could not be opened'));
    };
  }).catch((err: unknown) => {
    ws.close();
    throw err;
  });
  let nextId = 1;
  const pending = new Map<number, (msg: Message) => void>();
  // Dropped, the connection answers nothing more, which would look like
  // every tab not responding: the check fails instead.
  let dropped = false;
  ws.onclose = () => { dropped = true; };
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as Message;
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  };
  // A command's reply, or null when none came within `ms`.
  const call = (method: string, params: Record<string, unknown>, sessionId?: string, ms = ANSWER_MS): Promise<Message | null> =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, ms);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  try {
    const listed = await call('Target.getTargets', {});
    const targets = (listed?.result?.targetInfos ?? []) as TargetInfo[];
    const pages = targets.filter((t) => t.type === 'page' && (!only || only.has(t.targetId)));
    const stuck = await Promise.all(pages.map(async (t): Promise<StuckTab | null> => {
      const attached = await call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const sessionId = attached?.result?.sessionId as string | undefined;
      // Closed meanwhile, or not attachable: Playwright won't wait on it.
      if (!sessionId) return null;
      const answer = await call('Runtime.evaluate', { expression: '1' }, sessionId);
      void call('Target.detachFromTarget', { sessionId }, undefined, 500);
      return answer ? null : { targetId: t.targetId, title: t.title, url: t.url };
    }));
    if (dropped) throw new Error('The browser\'s debugging connection closed');
    return stuck.filter((t): t is StuckTab => t !== null);
  } finally {
    ws.close();
  }
}

/**
 * Waits until every tab's page answers, saying which don't and why they
 * might not. True at once when they all do, and when the browser can't
 * be reached (the connect that follows says so). False when `until`
 * resolves first (--stop-after-seconds, or the run's output closing).
 */
export async function waitForStuckTabs(endpoint: string, out: (line: string) => void, until?: Promise<void>): Promise<boolean> {
  let stuck: StuckTab[];
  try {
    stuck = await stuckTabs(endpoint);
  } catch {
    return true;
  }
  if (stuck.length === 0) return true;
  let stopped = false;
  void until?.then(() => { stopped = true; });
  out(stuck.length === 1
    ? 'A tab is not responding, so sm-dev can\'t connect to the browser over CDP:'
    : 'Some tabs are not responding, so sm-dev can\'t connect to the browser over CDP:');
  // Chrome titles a page without one by its address.
  for (const t of stuck) out(`  ${t.title && !t.url.endsWith(t.title) ? `${t.title}  ` : ''}${t.url}`);
  out(stuck.length === 1
    ? 'It may have a dialog open, or a busy page. Answer the dialog or close the tab to continue (Ctrl-C to abort).'
    : 'They may have a dialog open, or a busy page. Answer the dialogs or close the tabs to continue (Ctrl-C to abort).');
  while (stuck.length > 0) {
    await Promise.race([new Promise((r) => setTimeout(r, RECHECK_MS)), until]);
    if (stopped) return false;
    try {
      stuck = await stuckTabs(endpoint, new Set(stuck.map((t) => t.targetId)));
    } catch {
      return true;
    }
  }
  out('Every tab is responding now. Connecting.');
  return true;
}
