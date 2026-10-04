// The connection prompt, worker side: what happens when a script's
// `GM_xmlhttpRequest` goes to a host its `@connect` rules don't cover
// and the user hasn't answered for yet (`connect-grants.ts`).
//
// - A small popup window (`connect-prompt.html`) asks: allow this host,
//   allow all sites, or deny. A window of the extension's own, rather
//   than something drawn in the page, so the page can neither fake nor
//   click it.
// - One window per (script, host). Requests that arrive while it is up
//   wait on the same answer, rather than each opening another.
// - Each request waits `CONNECT_PROMPT_WAIT_MS` at most, then fails.
//   The limit sits under the page's own 5-minute give-up
//   (`XHR_PAGE_SIDE_TTL_MS`), so the request fails with a message that
//   says why rather than as silence.
// - A prompt with no request left waiting on it (timed out, aborted, or
//   its tab closed) closes. Otherwise it would stay up asking about
//   nothing, and its pings would keep the worker running.
// - At most `MAX_PROMPTS_PER_SCRIPT` windows are open for one script; a
//   request for another site fails at once. A script looping over many
//   hosts would otherwise bury the user in windows.
// - Cancel, or closing the window, refuses just the requests waiting
//   on it and keeps nothing, so the next request asks again.
// - The answer travels with the script id and host, so it is saved even
//   when the worker restarted in between and lost track of the window.
//
// sm-dev sees each prompt (`connect-prompt` events) and can answer it
// (`answerConnectPrompt`), since an agent can't click the window.

import { allowConnectHost, connectAnswer, CONNECT_PROMPT_PAGE, denyConnectHost, type ConnectChoice } from './connect-grants.js';
import { appendScriptLog } from './script-log.js';
import { emitSmDevEvent } from './sm-dev-link.js';

export const CONNECT_PROMPT_WAIT_MS = 4 * 60 * 1000;

export interface ConnectRequestInfo {
  scriptId: string;
  scriptName: string;
  host: string;
  // The request's URL and method, shown in the prompt's tooltip.
  url: string;
  method: string;
  // The tab of the page that made the request, and its document: a
  // request a standing denial refuses is logged once per site for each
  // page the script runs on.
  tabId: number;
  documentId?: string;
  // The request's abort: the script's `abort()`, or its tab closing.
  signal?: AbortSignal;
}

interface Pending {
  promptId: string;
  scriptId: string;
  host: string;
  tabId: number;
  windowId: number | null;
  waiters: Set<(outcome: ConnectOutcome) => void>;
}

// `unanswered`: the prompt got no answer in time. `failed`: it couldn't
// be shown, with Chrome's reason.
// `cancelled`: the user cancelled the prompt (or closed it).
// `aborted`: the request was aborted while it waited.
// `too-many`: the script already has `MAX_PROMPTS_PER_SCRIPT` open.
export type ConnectOutcome = 'allow' | 'deny' | 'cancelled' | 'unanswered' | 'aborted' | 'too-many' | { failed: string };

export const MAX_PROMPTS_PER_SCRIPT = 3;

const pending = new Map<string, Pending>();
let nextPromptId = 1;

function pendingKey(scriptId: string, host: string): string {
  return `${scriptId}\n${host}`;
}

// Whether the request may go: the user's standing answer, or the one
// they give the prompt this opens (or one already open for this host).
export async function askConnect(info: ConnectRequestInfo): Promise<ConnectOutcome> {
  const standing = await connectAnswer(info.scriptId, info.host);
  if (standing === 'deny') logStandingDenial(info);
  if (standing) return standing;
  if (info.signal?.aborted) return 'aborted';
  const key = pendingKey(info.scriptId, info.host);
  let entry = pending.get(key);
  if (!entry) {
    const open = [...pending.values()].filter((p) => p.scriptId === info.scriptId).length;
    if (open >= MAX_PROMPTS_PER_SCRIPT) return 'too-many';
    entry = {
      promptId: `cp${nextPromptId++}-${Math.random().toString(36).slice(2, 8)}`,
      scriptId: info.scriptId,
      host: info.host,
      tabId: info.tabId,
      windowId: null,
      waiters: new Set(),
    };
    pending.set(key, entry);
    const opened = entry;
    void openPromptWindow(opened, info).then((windowId) => {
      // Answered (by sm-dev) before the window was even up.
      if (pending.get(key) !== opened) {
        if (windowId !== null) void chrome.windows.remove(windowId).catch(() => undefined);
        return;
      }
      opened.windowId = windowId;
    });
    emitSmDevEvent({
      kind: 'connect-prompt', op: 'shown', promptId: entry.promptId, scriptId: info.scriptId,
      tabId: info.tabId, host: info.host, url: info.url, method: info.method,
    });
    void appendScriptLog(info.scriptId, {
      level: 'info',
      source: 'gm-xhr',
      tabId: info.tabId,
      message: `Opened permission request window for connection to ${info.host} (${info.method} ${withoutQuery(info.url)})`,
      // sm-dev prints its own line for the prompt, which also says how
      // to answer it.
      fromReport: true,
    }).catch(() => undefined);
  }
  const waiting = entry;
  return new Promise((resolve) => {
    const done = (outcome: ConnectOutcome): void => {
      clearTimeout(timer);
      info.signal?.removeEventListener('abort', onAbort);
      waiting.waiters.delete(done);
      resolve(outcome);
      // Given up on rather than answered: the last one out closes it.
      if ((outcome === 'unanswered' || outcome === 'aborted') && waiting.waiters.size === 0) dropPrompt(waiting);
    };
    const onAbort = (): void => done('aborted');
    info.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => done('unanswered'), CONNECT_PROMPT_WAIT_MS);
    waiting.waiters.add(done);
  });
}

// Script, document and host of each request a standing denial has
// refused and logged, so a script that retries logs once per site for
// each page it runs on. Kept for the worker's lifetime, and cleared when
// it grows past `LOGGED_DENIALS_MAX`, which at worst logs a repeat.
const loggedDenials = new Set<string>();
const LOGGED_DENIALS_MAX = 1000;

function logStandingDenial(info: ConnectRequestInfo): void {
  const key = `${info.scriptId}\n${info.documentId ?? `tab ${info.tabId}`}\n${info.host}`;
  if (loggedDenials.has(key)) return;
  if (loggedDenials.size >= LOGGED_DENIALS_MAX) loggedDenials.clear();
  loggedDenials.add(key);
  void appendScriptLog(info.scriptId, {
    level: 'warning',
    source: 'gm-xhr',
    tabId: info.tabId,
    message: `Blocked a request to ${info.host}, which was denied for this script. `
      + "Manage permissions on the script's page. Later requests to it from the same page are blocked without a log entry.",
  }).catch(() => undefined);
}

// A URL without its query string or fragment, for the log: those often
// hold keys or session tokens.
function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// Close a prompt nobody is waiting on any more, without an answer.
function dropPrompt(entry: Pending): void {
  const key = pendingKey(entry.scriptId, entry.host);
  if (pending.get(key) !== entry) return;
  pending.delete(key);
  if (entry.windowId !== null) void chrome.windows.remove(entry.windowId).catch(() => undefined);
  emitSmDevEvent({
    kind: 'connect-prompt', op: 'closed', promptId: entry.promptId, scriptId: entry.scriptId,
    tabId: entry.tabId, host: entry.host,
  });
}

// For tests: close all prompts, and forget which denials were logged.
export function resetConnectPromptsForTests(): void {
  for (const entry of [...pending.values()]) dropPrompt(entry);
  loggedDenials.clear();
}

async function openPromptWindow(entry: Pending, info: ConnectRequestInfo): Promise<number | null> {
  const params = new URLSearchParams({
    prompt: entry.promptId,
    script: info.scriptId,
    name: info.scriptName,
    host: info.host,
    url: info.url,
    method: info.method,
  });
  const width = 520;
  const height = 350;
  // Over the window the request came from, when there is one to place
  // it by.
  let place: { left?: number; top?: number } = {};
  try {
    const tab = await chrome.tabs.get(info.tabId);
    const win = await chrome.windows.get(tab.windowId);
    if (win.left !== undefined && win.top !== undefined && win.width !== undefined) {
      // Not clamped at 0: a screen left of the primary one has negative
      // coordinates.
      place = { left: win.left + Math.round((win.width - width) / 2), top: win.top + 80 };
    }
  } catch {
    // Placed where Chrome likes.
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`${CONNECT_PROMPT_PAGE}?${params}`),
      type: 'popup',
      width,
      height,
      focused: true,
      ...place,
    });
    return win?.id ?? null;
  } catch (err) {
    // No window means no answer can come: fail the requests waiting,
    // and leave nothing behind for the next one to join.
    dropPrompt(entry);
    const failed = err instanceof Error ? err.message : String(err);
    for (const waiter of [...entry.waiters]) waiter({ failed });
    return null;
  }
}

// Record the user's answer and let the waiting requests go (or fail).
// `promptId` names the prompt answered; the answer is saved by script
// and host whether or not the worker still knows that prompt.
export async function answerConnect(
  scriptId: string,
  host: string,
  choice: ConnectChoice,
  how: 'prompt' | 'closed' | 'sm-dev',
): Promise<void> {
  if (choice === 'deny') await denyConnectHost(scriptId, host);
  else if (choice === 'allow' || choice === 'allow-all') await allowConnectHost(scriptId, choice === 'allow-all' ? null : host);
  const key = pendingKey(scriptId, host);
  const entry = pending.get(key);
  const others = choice === 'allow-all'
    ? [...pending.values()].filter((p) => p.scriptId === scriptId && p !== entry)
    : [];
  for (const settled of entry ? [entry, ...others] : others) {
    pending.delete(pendingKey(settled.scriptId, settled.host));
    const outcome: ConnectOutcome = choice === 'deny' ? 'deny' : choice === 'cancel' ? 'cancelled' : 'allow';
    // "All sites" settles this script's other prompts too; "once" only this one.
    for (const waiter of [...settled.waiters]) waiter(outcome);
    if (how !== 'closed' && settled.windowId !== null) {
      void chrome.windows.remove(settled.windowId).catch(() => undefined);
    }
    emitSmDevEvent({
      kind: 'connect-prompt', op: 'answered', promptId: settled.promptId, scriptId,
      tabId: settled.tabId, host: settled.host, answer: choice,
    });
  }
  const where = how === 'sm-dev' ? ' from sm-dev' : '';
  const message = choice === 'allow-all' ? `Allowed this script to connect to all sites${where}`
    : choice === 'allow' ? `Allowed this script to connect to ${host}${where}`
      : choice === 'once' ? `Allowed this script to connect to ${host} once${where}. The requests waiting on the permission prompt were sent, and the next one asks again.`
        : choice === 'deny' ? `Denied this script connecting to ${host}${where}. Manage permissions on the script's page.`
          : how === 'closed' ? `The permission prompt about connecting to ${host} was closed, which cancels it. The requests waiting on it were blocked, and the next one asks again.`
            : `Cancelled the permission prompt about connecting to ${host}${where}. The requests waiting on it were blocked, and the next one asks again.`;
  await appendScriptLog(scriptId, {
    level: choice === 'deny' || choice === 'cancel' ? 'warning' : 'info',
    source: 'gm-xhr',
    ...(entry ? { tabId: entry.tabId } : {}),
    message,
  }).catch(() => undefined);
}

// A prompt window closed. Without an answer first, that cancels it.
export function onConnectPromptWindowRemoved(windowId: number): void {
  for (const entry of pending.values()) {
    if (entry.windowId === windowId) {
      void answerConnect(entry.scriptId, entry.host, 'cancel', 'closed');
      return;
    }
  }
}

// sm-dev's answer to a prompt it was told about. False when no such
// prompt is waiting.
export async function answerConnectPrompt(promptId: string, choice: ConnectChoice): Promise<boolean> {
  for (const entry of pending.values()) {
    if (entry.promptId === promptId) {
      await answerConnect(entry.scriptId, entry.host, choice, 'sm-dev');
      return true;
    }
  }
  return false;
}

// The prompts waiting, for sm-dev to list.
export function pendingConnectPrompts(): { promptId: string; scriptId: string; tabId: number; host: string }[] {
  return [...pending.values()].map(({ promptId, scriptId, tabId, host }) => ({ promptId, scriptId, tabId, host }));
}
