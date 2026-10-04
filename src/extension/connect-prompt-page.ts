// The connection prompt window (`connect-prompt.html`): asks whether a
// script may reach a host its `@connect` rules don't cover. The worker
// opens it with everything it shows in the query string
// (`connect-prompt.ts`), and the answer goes back by message. Closing
// the window instead cancels, which the worker sees for itself.

import {
  CONNECT_ANSWER_MESSAGE,
  CONNECT_PROMPT_ALIVE_MESSAGE,
  type ConnectAnswerMessage,
  type ConnectChoice,
} from './connect-grants.js';

// Under the worker's 30-second idle limit.
const ALIVE_INTERVAL_MS = 20_000;

const params = new URLSearchParams(location.search);
const promptId = params.get('prompt') ?? '';
const scriptId = params.get('script') ?? '';
const host = params.get('host') ?? '';

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// What the request was, without its query string or fragment: those
// often hold keys or session tokens, and the host and path are what the
// question is about.
function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

const link = byId<HTMLAnchorElement>('script');
link.textContent = params.get('name') || 'This script';
link.href = chrome.runtime.getURL(`userscript.html?script=${encodeURIComponent(scriptId)}`);
// The site, linked at its root. The request itself is in the tooltip.
const site = byId<HTMLAnchorElement>('site');
const url = params.get('url') ?? '';
site.textContent = host;
try {
  site.href = `${new URL(url).origin}/`;
} catch {
  site.removeAttribute('href');
}
site.title = `${params.get('method') ?? 'GET'} ${withoutQuery(url)}`;

// Each button's id is the choice it sends.
const BUTTONS: ConnectChoice[] = ['once', 'cancel', 'allow', 'deny', 'allow-all'];

async function answer(choice: ConnectChoice): Promise<void> {
  for (const id of BUTTONS) byId<HTMLButtonElement>(id).disabled = true;
  const message: ConnectAnswerMessage = { type: CONNECT_ANSWER_MESSAGE, promptId, scriptId, host, choice };
  let ok = false;
  try {
    ok = await chrome.runtime.sendMessage(message) === true;
  } catch {
    // Reported below.
  }
  if (ok) {
    // The worker closes the window; this is for when it can't.
    window.close();
    return;
  }
  const error = byId('error');
  error.textContent = 'SourceMonkey could not save this answer. Close this window and try the request again.';
  error.hidden = false;
}

for (const id of BUTTONS) byId(id).addEventListener('click', () => void answer(id));

// No button starts focused: the window takes focus as it opens, and a
// key pressed for the page underneath mustn't answer it.

setInterval(() => {
  chrome.runtime.sendMessage({ type: CONNECT_PROMPT_ALIVE_MESSAGE }).catch(() => undefined);
}, ALIVE_INTERVAL_MS);
