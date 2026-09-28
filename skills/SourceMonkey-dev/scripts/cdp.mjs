#!/usr/bin/env node
// Sends raw CDP (Chrome DevTools Protocol) calls to one tab, or to the
// browser, over one connection, and prints each result as JSON.
//
//   node cdp.mjs [--cdp PORT|URL] <target> <Method> [params-json] [<Method> [params-json]]...
//
// <target> is a tab's targetId as sm-dev prints it (whole, a prefix of
// 6+ characters, or pasted as `targetId=...`), or `browser` for the
// Browser.* and Target.* domains. The port defaults to $SM_DEV_CDP,
// then 9233, as sm-dev's does; a --temp-browser run's port is on
// `sm-dev status`'s Run: line. Needs Node 22+ (built-in WebSocket).
//
// Results go to stdout; usage and errors to stderr, with exit code 1
// (2 for usage). Per-session state (Emulation.* overrides, enabled
// domains, event subscriptions) ends when this exits.

const CALL_TIMEOUT_MS = 10_000;
const USAGE = 'Usage: node cdp.mjs [--cdp PORT|URL] <targetId|browser> <Method> [params-json] ...';

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
let cdp = (process.env.SM_DEV_CDP || '').trim() || '9233';
if (args[0] === '--cdp') { cdp = args[1] ?? fail(USAGE, 2); args.splice(0, 2); }
else if (args[0]?.startsWith('--cdp=')) { cdp = args[0].slice('--cdp='.length); args.shift(); }
const [targetArg, ...calls] = args;
if (!targetArg || calls.length === 0) fail(USAGE, 2);

// The HTTP endpoint: a port, host:port, or URL (ws:// read as http://).
const base = /^:?\d+$/.test(cdp) ? `http://127.0.0.1:${cdp.replace(':', '')}`
  : /^\w+:\/\//.test(cdp) ? new URL(cdp.replace(/^ws/, 'http')).origin
  : `http://${cdp}`;

// Pairs of method and params; a word starting with `{` is the params of
// the method before it.
const steps = [];
for (const word of calls) {
  if (!word.trimStart().startsWith('{')) { steps.push({ method: word, params: {} }); continue; }
  if (steps.length === 0) fail(`The params ${word} come before any method. ${USAGE}`, 2);
  try {
    steps.at(-1).params = JSON.parse(word);
  } catch (err) {
    fail(`The params for ${steps.at(-1).method} aren't valid JSON (${err.message}): ${word}`, 2);
  }
}

async function getJson(path) {
  try {
    return await (await fetch(`${base}${path}`)).json();
  } catch {
    return fail(`No browser answers CDP at ${base}. Pass --cdp with the run's port (sm-dev status shows it).`);
  }
}

async function socketUrl() {
  if (targetArg === 'browser') return (await getJson('/json/version')).webSocketDebuggerUrl;
  const id = targetArg.replace(/^\[?targetId=/, '').replace(/\]$/, '').toUpperCase();
  if (id.length < 6) fail(`The targetId ${targetArg} is too short: give 6 or more characters`, 2);
  const tabs = (await getJson('/json/list')).filter((t) => t.type === 'page' && t.id.toUpperCase().startsWith(id));
  if (tabs.length !== 1) fail(`${tabs.length === 0 ? 'No tab' : 'More than one tab'} at ${base} has a targetId starting ${id}`);
  return tabs[0].webSocketDebuggerUrl;
}

const ws = new WebSocket(await socketUrl());
await new Promise((resolve) => {
  ws.onopen = resolve;
  ws.onerror = () => fail(`Could not open a CDP connection at ${base}`);
});
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
};
// A tab closing (or crashing) ends the connection: the call waiting on
// it gets no reply.
ws.onclose = () => { for (const resolve of pending.values()) resolve({ closed: true }); };

let failed = false;
for (const [i, step] of steps.entries()) {
  const reply = await new Promise((resolve) => {
    pending.set(i + 1, resolve);
    // A reply may never come: a Runtime.evaluate that navigates the
    // page, a page stopped on a dialog or in the debugger.
    setTimeout(() => resolve({ timedOut: true }), CALL_TIMEOUT_MS).unref();
    ws.send(JSON.stringify({ id: i + 1, ...step }));
  });
  pending.delete(i + 1);
  const problem = reply.closed ? 'The connection closed before it answered'
    : reply.timedOut ? `No answer within ${CALL_TIMEOUT_MS / 1000}s (a navigation, a dialog, or a paused page?)`
    : reply.error?.message;
  if (problem) { failed = true; process.stderr.write(`${step.method}: ${problem}\n`); break; }
  console.log(JSON.stringify(reply.result, null, 2));
}
ws.onclose = null;
ws.close();
process.exit(failed ? 1 : 0);
