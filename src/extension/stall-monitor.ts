// Logs, under debug logging, each time the service worker's thread was
// blocked: a timer that should fire every `TICK_MS` and fired late.
//
// Answers a question the phase timings can't. A phase whose await took
// seconds was either waiting on Chrome (the thread idle meanwhile) or
// stuck behind our own code hogging the thread (every await late,
// events included). A stall line names the second case, and where it
// lands among the other lines shows what was running.
//
// Runs only while debug logging is on: a timer firing 10 times a
// second has a cost nobody should pay for a log they don't read.

import { DEBUG_LOGGING_KEY, debugLoggingSettled } from '../debug-log.js';

const TICK_MS = 100;

// A tick this late counts as a stall. Well above the timer's ordinary
// jitter and short tasks, so a line means something held the thread.
const STALL_MS = 200;

let timer: ReturnType<typeof setInterval> | undefined;

function start(): void {
  if (timer !== undefined) return;
  let last = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - TICK_MS;
    if (late > STALL_MS) {
      console.log(`[SourceMonkey] timing: worker thread blocked for ${Math.round(late)}ms`);
    }
    last = now;
  }, TICK_MS);
}

function stop(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

export function installStallMonitor(): void {
  void debugLoggingSettled().then((on) => { if (on) start(); });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const change = areaName === 'local' ? changes[DEBUG_LOGGING_KEY] : undefined;
    if (!change) return;
    if (change.newValue === true) start();
    else stop();
  });
}
