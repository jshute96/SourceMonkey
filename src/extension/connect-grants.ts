// What the user has told SourceMonkey about the hosts a script's
// `GM_xmlhttpRequest` may reach beyond its `@connect` rules: the
// answers to the connection prompt (`connect-prompt.ts`), read by the
// worker before it asks and by the script's page, which lists them
// under Network access and can take them back.
//
// - Allowed and denied hosts persist in one row per script
//   (`chrome.storage.local`), across refreshes and updates of the
//   script, until reset on the script's page. The row goes when the
//   script is removed.
//
// Hosts are `URL.hostname`s, lowercased: one host each, no subdomains,
// any port (as `@connect` matches hosts).

// The prompt window's page, and what it sends the worker: the answer,
// and while it waits, a message every so often so the worker isn't
// stopped for being idle (pending work alone doesn't count) and lose
// the requests waiting on it. Here rather than in `connect-prompt.ts`
// so the page needn't load the worker's side.
export const CONNECT_PROMPT_PAGE = 'connect-prompt.html';
export const CONNECT_ANSWER_MESSAGE = 'sm:connect-answer';
export const CONNECT_PROMPT_ALIVE_MESSAGE = 'sm:connect-prompt-alive';

// `once` lets the requests waiting now go, and `cancel` refuses them;
// neither keeps anything, so the next request asks again.
export type ConnectChoice = 'once' | 'cancel' | 'allow' | 'allow-all' | 'deny';

export interface ConnectAnswerMessage {
  type: typeof CONNECT_ANSWER_MESSAGE;
  promptId: string;
  scriptId: string;
  host: string;
  choice: ConnectChoice;
}

export interface ConnectGrants {
  // Hosts allowed, in the order they were.
  hosts: string[];
  // "Allow all sites": every host, now and later.
  allHosts?: boolean;
  // Hosts denied, in the order they were.
  denied?: string[];
}

// Each change reads the row and writes it back, so two at once (two
// prompts answered together) would lose one. Within one context they
// take turns; the worker and a script's page changing the same script
// in the same moment is left to chance.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const GRANTS_PREFIX = 'connectGrants:';

export function connectGrantsKey(scriptId: string): string {
  return GRANTS_PREFIX + scriptId;
}

export async function getConnectGrants(scriptId: string): Promise<ConnectGrants> {
  const key = connectGrantsKey(scriptId);
  const row = (await chrome.storage.local.get(key))[key] as ConnectGrants | undefined;
  return {
    hosts: Array.isArray(row?.hosts) ? row.hosts : [],
    ...(row?.allHosts ? { allHosts: true } : {}),
    ...(Array.isArray(row?.denied) && row.denied.length > 0 ? { denied: row.denied } : {}),
  };
}

// The user's standing answer about `host` for this script, if any. A
// host is never both allowed and denied (each answer clears the other),
// and "all sites" clears all denials.
export async function connectAnswer(scriptId: string, host: string): Promise<'allow' | 'deny' | null> {
  const grants = await getConnectGrants(scriptId);
  if (grants.denied?.includes(host)) return 'deny';
  if (grants.allHosts || grants.hosts.includes(host)) return 'allow';
  return null;
}

// Allow `host`, or with `host` null, all hosts. Clears a denial of it
// (of all of them, for all hosts).
export async function allowConnectHost(scriptId: string, host: string | null): Promise<void> {
  return change(scriptId, (grants) => {
    if (host === null) {
      grants.allHosts = true;
      delete grants.denied;
      return;
    }
    if (!grants.hosts.includes(host)) grants.hosts.push(host);
    grants.denied = grants.denied?.filter((h) => h !== host);
  });
}

// Deny `host`. Clears an allowance of it.
export async function denyConnectHost(scriptId: string, host: string): Promise<void> {
  return change(scriptId, (grants) => {
    grants.hosts = grants.hosts.filter((h) => h !== host);
    if (!grants.denied?.includes(host)) grants.denied = [...grants.denied ?? [], host];
  });
}

// Take back an allowance: one host, or with `host` null, "all sites".
export async function revokeConnectHost(scriptId: string, host: string | null): Promise<void> {
  return change(scriptId, (grants) => {
    if (host === null) delete grants.allHosts;
    else grants.hosts = grants.hosts.filter((h) => h !== host);
  });
}

// Forget a denial, so the next request asks again.
export async function forgetDeniedHost(scriptId: string, host: string): Promise<void> {
  return change(scriptId, (grants) => {
    grants.denied = grants.denied?.filter((h) => h !== host);
  });
}

// Read the row, apply `edit`, and write it back (or remove it once
// nothing is left in it).
function change(scriptId: string, edit: (grants: ConnectGrants) => void): Promise<void> {
  return serialized(async () => {
    const grants = await getConnectGrants(scriptId);
    edit(grants);
    if (grants.denied?.length === 0) delete grants.denied;
    const key = connectGrantsKey(scriptId);
    if (grants.hosts.length === 0 && !grants.allHosts && !grants.denied) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: grants });
  });
}
