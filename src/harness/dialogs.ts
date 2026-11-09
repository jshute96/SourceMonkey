// The dialogs a run's tabs wait on, and the `dialog` command's view of
// them. Design: docs/sm-dev-dialogs.md.
//
// - Each tab's DialogTracker keeps the dialogs waiting on it, of every
//   kind: the page's JavaScript dialogs, which it catches itself, and
//   SourceMonkey's connection prompts, which run.ts hands it.
// - Each dialog gets an id (`T1.2`): its tab and a number counting that
//   tab's dialogs over the run.
// - Each kind is described the same way (`DialogSpec`): what it asks,
//   its fields and buttons, and how to press one. So `dialog show`, the
//   stream's event and the commands that answer one work for all kinds.

import type { BrowserContext, CDPSession, Dialog, Page } from '@playwright/test';

import type { ConnectChoice, ConnectPromptRecord } from './host.js';
import type * as J from './json-output.js';
import { CONNECT_BUTTONS } from '../gm-connect.js';
import * as S from './output-style.js';
import { message, quoted, roleCell, tableLines, textCell, ui } from './output-style.js';

/** Who wrote a dialog's text: the page, Chrome for its own boxes, or SourceMonkey. */
export type DialogFrom = 'page' | 'Chrome' | 'SourceMonkey';

export interface DialogField {
  name: string;
  /** Set with `dialog set`, or by `dialog accept`'s values. */
  value?: string[];
  /** What pressing OK uses when nothing was set. */
  default?: string[];
  /** Takes more than one value. */
  multiple?: boolean;
  /** Its `dialog set` placeholder: `<value>`. */
  placeholder: string;
  /** Its values are files, resolved from where the command ran and checked. */
  files?: boolean;
}

export interface DialogButton {
  label: string;
  /** The button `dialog accept` or `dialog cancel` presses. */
  role?: 'accept' | 'cancel';
  /** What pressing it does, where the label doesn't say. */
  does?: string;
}

/** One kind of dialog, as the `dialog` command sees it. */
export interface DialogSpec {
  /** Its kind, as a heading: `Confirm`, `Connection permission`. */
  title: string;
  from: DialogFrom;
  /** The `From:` line: `The page (https://...)`. */
  fromText: string;
  message?: string;
  /** More named lines after the message: `Choose: One file`. */
  details?: [string, string][];
  fields: DialogField[];
  buttons: DialogButton[];
  /** It stops the page's JavaScript until it's answered. */
  stopsPage: boolean;
  /** The browser doesn't show it, as sm-dev answers it (a file chooser). */
  hidden?: boolean;
  /**
   * Answering it runs on its page (a file chooser's `change` or
   * `cancel` event), so it waits while a JavaScript dialog blocks the page.
   */
  needsPage?: boolean;
  /** The run script it's about (`PreparedScript.id`): a connection prompt's. */
  scriptId?: string;
  /** A connection prompt's request: its host, method and URL without the query. */
  connect?: { host: string; method: string; url: string };
  /**
   * Presses `button`, or closes the dialog some other way (`close`:
   * an Alert's `dialog cancel`), with each field's value. False when
   * the dialog was already gone.
   */
  press(button: DialogButton | 'close', values: Record<string, string[] | undefined>): Promise<boolean>;
}

/** A dialog waiting for an answer. */
export interface WaitingDialog extends DialogSpec {
  /** `T1.2`. */
  id: string;
  /** Its tab's number. */
  tab: number;
  openedAt: number;
  /** The command running when it opened, as given. */
  openedDuring?: string;
}

// ---------- The command running ----------

// The command line running now, for a dialog's `Opened:` line.
let runningCommand: string | undefined;

/** Sets the command running now, or undefined between commands. */
export function setRunningCommand(line: string | undefined): void {
  runningCommand = line?.split('\n')[0].trim() || undefined;
}

// ---------- Kinds ----------

// The page's `alert`, `confirm`, `prompt`, or a `beforeunload` "Leave site?".
function javascriptSpec(dialog: Dialog, url: string, answered: () => void): DialogSpec {
  const type = dialog.type();
  const pageFrom = `The page (${url})`;
  const answer = async (accept: boolean, text?: string): Promise<boolean> => {
    answered();
    try {
      // A bare OK keeps the prompt's own default, as pressing it would.
      await (accept ? dialog.accept(text ?? dialog.defaultValue()) : dialog.dismiss());
      return true;
    } catch {
      return false;
    }
  };
  const ok: DialogButton = { label: 'OK', role: 'accept' };
  const cancel: DialogButton = { label: 'Cancel', role: 'cancel' };
  const press = (button: DialogButton | 'close', values: Record<string, string[] | undefined>): Promise<boolean> =>
    answer(button !== 'close' && button.role === 'accept', values.text?.[0]);
  switch (type) {
    case 'alert':
      return { title: 'Alert', from: 'page', fromText: pageFrom, message: dialog.message(), fields: [], buttons: [ok], stopsPage: true, press };
    case 'confirm':
      return { title: 'Confirm', from: 'page', fromText: pageFrom, message: dialog.message(), fields: [], buttons: [ok, cancel], stopsPage: true, press };
    case 'prompt':
      return {
        title: 'Prompt', from: 'page', fromText: pageFrom, message: dialog.message(),
        fields: [{ name: 'text', default: [dialog.defaultValue()], placeholder: '<text>' }],
        buttons: [ok, cancel], stopsPage: true, press,
      };
    default:
      // Chrome shows its own words, not the page's.
      return {
        title: 'Leave site', from: 'Chrome', fromText: `Chrome, for ${url}`,
        message: 'Leave site? Changes you made may not be saved.', fields: [],
        buttons: [{ label: 'Leave', role: 'accept', does: 'Leaves the page' }, { label: 'Cancel', role: 'cancel', does: 'Stays on the page' }],
        stopsPage: true, press,
      };
  }
}

/** What `Page.fileChooserOpened` says, and what its input's attributes add. */
interface ChooserEvent {
  frameId: string;
  mode: 'selectSingle' | 'selectMultiple';
  /** Absent for a File System Access picker, which `chooserOpened` doesn't list. */
  backendNodeId?: number;
}

/** Shown when the page asked for a File System Access picker while file choosers are caught. */
export const PICKER_REFUSED = 'Chrome refused the page\'s File System Access picker (`showOpenFilePicker`, `showSaveFilePicker` or `showDirectoryPicker`) with an AbortError. Chrome refuses these pickers while sm-dev catches file choosers, which it does while the run takes commands.';

// An `<input type=file>`'s chooser, caught before Chrome shows it.
async function chooserSpec(cdp: CDPSession, event: ChooserEvent & { backendNodeId: number }, url: string): Promise<DialogSpec> {
  const multiple = event.mode === 'selectMultiple';
  let accepts = '';
  let directory = false;
  {
    try {
      const { node } = await cdp.send('DOM.describeNode', { backendNodeId: event.backendNodeId });
      const attrs = node.attributes ?? [];
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i] === 'accept') accepts = attrs[i + 1];
        if (attrs[i] === 'webkitdirectory') directory = true;
      }
    } catch {
      // Then its accept list isn't shown.
    }
  }
  const field: DialogField = {
    name: multiple ? 'files' : 'file', placeholder: '<file>', files: true, ...(multiple ? { multiple: true } : {}),
  };
  const details: [string, string][] = [['Choose', directory ? 'A directory' : multiple ? 'One or more files' : 'One file']];
  if (accepts) details.push(['Accepts', accepts]);
  // A page waiting on the chooser hears of a cancel through the input's
  // `cancel` event, as Chrome's own chooser sends it.
  const cancel = async (): Promise<boolean> => {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: event.backendNodeId });
    if (!object.objectId) return false;
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function () { this.dispatchEvent(new Event("cancel", { bubbles: true })); }',
    });
    return true;
  };
  return {
    title: 'File chooser', from: 'Chrome', fromText: `Chrome, for an <input type=file> on ${url}`, details,
    fields: [field],
    buttons: [{ label: 'Open', role: 'accept' }, { label: 'Cancel', role: 'cancel' }],
    stopsPage: false, hidden: true, needsPage: true,
    press: async (button, values) => {
      const cancelling = button === 'close' || button.role === 'cancel';
      const files = values[field.name];
      if (!cancelling && (!files || files.length === 0)) {
        throw new Error(`Choose a file first: ${quoted(`dialog set ${field.name} <file>`)}, or give it to ${quoted('dialog accept')}`);
      }
      try {
        if (cancelling) return await cancel();
        await cdp.send('DOM.setFileInputFiles', { files: files!, backendNodeId: event.backendNodeId });
        return true;
      } catch {
        // The input or its page is gone.
        return false;
      }
    },
  };
}

/** SourceMonkey's prompt for a request to a host the script's `@connect` lines don't cover. */
export function connectSpec(record: ConnectPromptRecord, answer: (choice: ConnectChoice) => Promise<boolean>): DialogSpec {
  const buttons: (DialogButton & { choice: ConnectChoice })[] = CONNECT_BUTTONS.map((b) => ({
    label: b.label, choice: b.choice, does: b.does,
    ...(b.choice === 'once' ? { role: 'accept' as const } : b.choice === 'cancel' ? { role: 'cancel' as const } : {}),
  }));
  return {
    title: 'Connection permission', from: 'SourceMonkey', fromText: `SourceMonkey, for the script "${record.name}"`,
    message: `${record.name} requests permission to connect to ${record.host} (${record.method} ${withoutQuery(record.url)}).`,
    fields: [], buttons, stopsPage: false, scriptId: record.scriptId,
    connect: { host: record.host, method: record.method, url: withoutQuery(record.url) },
    press: (button) => answer(button === 'close' ? 'cancel' : (button as DialogButton & { choice: ConnectChoice }).choice),
  };
}

/**
 * A request URL without its query string or fragment: those can be
 * long (signed CDN links) and hold keys, and the host and path are what
 * the question is about.
 */
export function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// ---------- Showing one ----------

/** `Confirm dialog T1.1: "Delete 3 items?"`, for one-line mentions. */
export function dialogSummary(d: WaitingDialog): string {
  const text = d.message ? `: ${JSON.stringify(d.message.length > 80 ? `${d.message.slice(0, 77)}...` : d.message)}` : '';
  // As markup, so the page's backticks are only text.
  return ui`${dialogName(d)}${text}`;
}

/** `Confirm dialog T1.1`, with none of the page's text: for an Error's message. */
export function dialogName(d: WaitingDialog): string {
  return `${d.title} dialog ${d.id}`;
}

/** Whether `line` names dialog `id` (`T1.1`, not `T1.12`). */
export function namesDialog(line: string, id: string): boolean {
  return new RegExp(`(?<![\\w.])${id.replace('.', '\\.')}(?!\\d)`).test(line);
}

// A command for `d`, with `--dialog` when it isn't the one `dialog`
// commands apply to by default.
function commandFor(d: WaitingDialog, words: string, isDefault: boolean): string {
  return isDefault ? words : `${words} --dialog ${d.id}`;
}

// The command that presses `button`.
function buttonCommand(d: WaitingDialog, button: DialogButton, isDefault: boolean): string {
  if (button.role === 'cancel') return commandFor(d, 'dialog cancel', isDefault);
  if (button.role === 'accept') {
    const only = d.fields.length === 1 ? d.fields[0] : undefined;
    const value = only ? ` [${only.placeholder.slice(1, -1)}${only.multiple ? '...' : ''}]` : '';
    return commandFor(d, `dialog accept${value}`, isDefault);
  }
  return commandFor(d, `dialog click ${/\s/.test(button.label) ? JSON.stringify(button.label) : button.label}`, isDefault);
}

// How long ago, said roughly: `12 seconds ago`, `3 minutes ago`.
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const [n, unit] = s < 60 ? [s, 'second'] : s < 3600 ? [Math.round(s / 60), 'minute'] : [Math.round(s / 3600), 'hour'];
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * A dialog as `dialog show` gives it: its id and kind, named lines,
 * then tables of its fields and buttons, each with the command to use.
 * Markup lines. `now`: for how long ago it opened, left out without it
 * (the stream's event, as it opens).
 */
export function dialogBlock(d: WaitingDialog, { isDefault, now, heading = '' }: { isDefault: boolean; now?: number; heading?: string }): string[] {
  const lines: string[] = [];
  lines.push(ui`${heading}${S.id(d.id)}  ${S.heading(d.title)}${isDefault && now !== undefined ? ' (default for `dialog` commands)' : ''}`);
  const named: [string, string][] = [['From', d.fromText]];
  const during = d.openedDuring ? `During ${quoted(d.openedDuring)}` : '';
  const when = now !== undefined ? ago(now - d.openedAt) : '';
  if (during || when) named.push(['Opened', [during, when].filter(Boolean).join(', ')]);
  if (d.message !== undefined && d.message !== '') named.push(['Message', d.message]);
  named.push(...d.details ?? []);
  const width = Math.max(...named.map(([label]) => label.length)) + 3;
  for (const [label, value] of named) {
    const text = `${label}:`.padEnd(width);
    // Only the Opened line is ours, with a command in backticks. The
    // rest hold text a page or script wrote (a message, a script's
    // name), so they go in as text. A message's later lines line up
    // under its first.
    const shown = value.split('\n').map((l, i) => (i === 0 || l === '' ? l : `  ${' '.repeat(width)}${l}`)).join('\n');
    lines.push(label === 'Opened' ? ui`  ${text}${message(value)}` : ui`  ${text}${shown}`);
  }
  if (d.fields.length > 0) {
    lines.push(ui``, ui`  ${S.heading('Fields')}:`);
    const rows = [['Field', 'Value', 'Set with'].map((text) => roleCell(S.heading, text))];
    for (const field of d.fields) {
      const value = field.value ? field.value.map((v) => JSON.stringify(v)).join(' ')
        : field.default ? `${field.default.map((v) => JSON.stringify(v)).join(' ')} (default)` : '(none)';
      rows.push([textCell(field.name), textCell(value), roleCell(S.code, commandFor(d, `dialog set ${field.name} ${field.placeholder}${field.multiple ? '...' : ''}`, isDefault))]);
    }
    lines.push(...tableLines(rows).map((l) => ui`    ${l}`));
  }
  lines.push(ui``, ui`  ${S.heading('Buttons')}:`);
  const does = d.buttons.some((b) => b.does);
  const rows = [['Button', 'Command', ...(does ? ['Does'] : [])].map((text) => roleCell(S.heading, text))];
  for (const button of d.buttons) {
    rows.push([roleCell(S.name, button.label), roleCell(S.code, buttonCommand(d, button, isDefault)), ...(does ? [textCell(button.does ?? '')] : [])]);
  }
  lines.push(...tableLines(rows).map((l) => ui`    ${l}`));
  return lines;
}

/** A dialog as `dialog show --json` gives it. */
export function dialogJson(d: WaitingDialog, isDefault: boolean): J.WaitingDialog {
  return {
    id: d.id,
    tab: `T${d.tab}`,
    title: d.title,
    from: d.from,
    fromText: d.fromText,
    ...(d.message ? { message: d.message } : {}),
    ...(d.details?.length ? { details: Object.fromEntries(d.details) } : {}),
    openedAt: new Date(d.openedAt).toISOString(),
    ...(d.openedDuring ? { openedDuring: d.openedDuring } : {}),
    default: isDefault,
    fields: d.fields.map((f) => ({
      name: f.name,
      ...(f.value ? { value: f.value } : {}),
      ...(f.default ? { default: f.default } : {}),
      ...(f.multiple ? { multiple: true } : {}),
      command: commandFor(d, `dialog set ${f.name} ${f.placeholder}${f.multiple ? '...' : ''}`, isDefault),
    })),
    buttons: d.buttons.map((b) => ({
      label: b.label,
      ...(b.role ? { role: b.role } : {}),
      ...(b.does ? { does: b.does } : {}),
      command: buttonCommand(d, b, isDefault),
    })),
  };
}

// ---------- Trackers ----------

// Each tab's tracker, while its page is open, for telling whether a new
// dialog is the only one waiting in the run.
const live = new Set<DialogTracker>();

/** All dialogs waiting in the run's tabs (and those still being set up), oldest first. */
export function allWaiting(): WaitingDialog[] {
  return [...live].flatMap((t) => t.waiting).sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * Keeps Playwright from dismissing dialogs in `context`'s pages.
 *
 * - Playwright dismisses a dialog nobody listens for, on the page or its
 *   context, in every tab it's attached to: on a connected browser, the
 *   person's own tabs too.
 * - And when the dialog is gone before its dismiss lands, the error is
 *   unhandled, and ends the process.
 * - A listener that does nothing leaves each dialog to whoever does
 *   answer it: the person, or the run's DialogTracker in its own tabs.
 *   Also for a Playwright client that isn't the run's own.
 */
export function leaveDialogsOpen(context: BrowserContext): void {
  context.on('dialog', (dialog) => {
    const page = dialog.page();
    if (page && !trackedPages.has(page)) untracked.set(page, dialog);
  });
}

// A dialog open in a page no DialogTracker has yet, recorded by the
// listener above: a tab one of the run's tabs opens can show it before
// the run takes the tab over. The tab's tracker then reports and
// answers it as it does a dialog that opens later.
const untracked = new WeakMap<Page, Dialog>();
const trackedPages = new WeakSet<Page>();

// The trackers of tabs still being set up, by tab name (`T2`), so that
// `dialog accept --tab T2` can answer a dialog such a tab showed before
// the run took it over: the tab joins the run's list only once that
// dialog is closed.
const settingUp = new Map<string, DialogTracker>();

/** Lists `tracker` under `name` while its tab is set up; null takes it off. */
export function trackSettingUp(name: string, tracker: DialogTracker | null): void {
  if (tracker) settingUp.set(name, tracker);
  else settingUp.delete(name);
}

/** The tracker of a tab still being set up, by its name (`T2`). */
export function settingUpTracker(name: string): DialogTracker | undefined {
  return settingUp.get(name.toUpperCase());
}

/** The trackers of tabs still being set up. */
export function settingUpTrackers(): DialogTracker[] {
  return [...settingUp.values()];
}

/** Dismisses the dialogs of tabs still being set up, as a run ends. */
export async function dismissSettingUpDialogs(): Promise<void> {
  await Promise.all([...settingUp.values()].map((t) => t.take()?.dismiss().catch(() => undefined)));
}

/**
 * Whether `page` shows a dialog no DialogTracker has yet. Playwright
 * says nothing when the person answers one in the browser, so the
 * record is checked: a page that runs code has no dialog open, and its
 * record is dropped.
 */
export async function hasUntrackedDialog(page: Page): Promise<boolean> {
  if (!untracked.has(page)) return false;
  if (await pageAnswers(page)) {
    untracked.delete(page);
    return false;
  }
  return true;
}

// Whether each of the page's frames runs code within a moment: a frame
// showing a dialog doesn't. One that's busy, or slow to answer, counts
// as showing one, which keeps the dialog.
async function allFramesAnswer(page: Page): Promise<boolean> {
  const answers = await Promise.all(page.frames().map((frame) => Promise.race([
    // A frame whose document went away has no dialog either.
    frame.evaluate(() => 1).then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
  ])));
  return answers.every(Boolean);
}

// Whether the page runs code within a moment: a page showing a dialog doesn't.
function pageAnswers(page: Page): Promise<boolean> {
  return Promise.race([
    page.evaluate(() => 1).then(() => true, () => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
  ]);
}

/**
 * The dialogs waiting on one tab.
 *
 * - The page's `alert`, `confirm`, `prompt` and `beforeunload` dialogs
 *   it catches itself. Playwright dismisses a dialog nobody listens for,
 *   which would answer a script's `prompt` with Cancel before anyone saw
 *   it. So each one is reported and left open, for the person at the
 *   browser or a `dialog` command. Only when neither can answer (a
 *   headless browser, no command input) is it dismissed, since it would
 *   otherwise hang the page for good.
 * - Others are handed to it (`add`): SourceMonkey's connection prompts.
 */
export class DialogTracker {
  /** The page's JavaScript dialog open now, if any. It stops the page. */
  current: Dialog | null = null;
  /** The dialogs waiting, oldest first. */
  readonly waiting: WaitingDialog[] = [];
  // Whether commands are, or are about to be, read (`commandsListening`).
  private listeningNow: boolean;
  // The tab's own CDP session, once it's open.
  private cdp: CDPSession | null = null;
  // Whether Chrome hands file choosers to this session, as last set.
  private intercepting = false;
  // Each file chooser waiting, by its key, with its frame.
  private choosers = new Map<object, string>();
  private waiters = new Set<() => void>();
  // Dialogs open one at a time and close in order, so the nth close
  // on the protocol session is the nth dialog Playwright reported. The
  // two come over separate sessions, in no fixed order between them,
  // so a close is matched by count rather than applied to whatever is
  // current, which may be the next dialog already.
  private openedCount = 0;
  private closedCount = 0;
  private currentOrdinal = 0;
  // How many `leavingPage` calls are running.
  private leaving = 0;
  // The waiting entry for `current`.
  private currentEntry: WaitingDialog | null = null;
  // How many dialogs the tab has had, for their ids.
  private numbered = 0;
  // Who handed in each `add`ed dialog, so `drop` can find it.
  private keys = new Map<unknown, WaitingDialog>();

  private constructor(
    private readonly page: Page,
    private readonly say: (text: string, scriptId?: string) => void,
    private readonly visible: boolean,
    commandsComing: boolean,
    private readonly tabNumber: number,
  ) {
    this.listeningNow = commandsComing;
  }

  /**
   * Whether commands are, or are about to be, read, so `dialog accept`
   * can answer. Set before the page loads when they will be, or a
   * prompt the script opens on load would be dismissed first.
   * - While they are, file choosers are caught for `dialog` commands.
   *   Otherwise Chrome shows its own, for a person at the browser.
   */
  get commandsListening(): boolean {
    return this.listeningNow;
  }

  set commandsListening(listening: boolean) {
    this.listeningNow = listening;
    void this.syncIntercept();
    // Nothing will answer a chooser now, and Chrome won't show it again,
    // so the page hears it was cancelled.
    if (!listening) {
      for (const key of [...this.choosers.keys()]) {
        const entry = this.keys.get(key);
        void entry?.press('close', {});
      }
    }
  }

  // Asks Chrome to hand file choosers to this session while commands
  // are read, and to show its own otherwise.
  private async syncIntercept(): Promise<void> {
    if (!this.cdp || this.intercepting === this.listeningNow) return;
    this.intercepting = this.listeningNow;
    await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: this.listeningNow }).catch(() => undefined);
  }

  // A file chooser Chrome handed over instead of showing it.
  private async chooserOpened(cdp: CDPSession, event: ChooserEvent): Promise<void> {
    // No input: a File System Access picker. Chrome
    // has already failed the call with an AbortError, so nothing waits
    // to be answered.
    if (event.backendNodeId === undefined) {
      this.say(S.WARNING_PREFIX + PICKER_REFUSED);
      return;
    }
    const spec = await chooserSpec(cdp, { ...event, backendNodeId: event.backendNodeId }, this.page.url());
    const key = {};
    const press = spec.press;
    spec.press = async (button, values) => {
      const pressed = await press(button, values);
      this.choosers.delete(key);
      this.drop(key);
      return pressed;
    };
    this.choosers.set(key, event.frameId);
    this.add(key, spec);
  }

  // A frame that navigated or went away takes its file choosers with
  // it; the top frame, all of them. A chooser in a frame inside it goes
  // too, since its own frame went away with it.
  private async frameNavigated(frame: { id: string; parentId?: string }): Promise<void> {
    if (this.choosers.size === 0) return;
    let left: Set<string> | null = null;
    if (frame.parentId !== undefined && this.cdp) {
      try {
        const { frameTree } = await this.cdp.send('Page.getFrameTree');
        left = new Set();
        const walk = (tree: { frame: { id: string }; childFrames?: unknown[] }): void => {
          left!.add(tree.frame.id);
          for (const child of tree.childFrames ?? []) walk(child as typeof tree);
        };
        walk(frameTree);
      } catch {
        // Then only the frame itself is known to be gone.
      }
    }
    for (const [key, frameId] of this.choosers) {
      const gone = frame.parentId === undefined || frameId === frame.id || (left !== null && !left.has(frameId));
      if (!gone) continue;
      this.choosers.delete(key);
      this.drop(key);
    }
  }

  /**
   * `say`: where a dialog opening is told (a run logs it as an event).
   * `visible`: whether the browser is on screen, for a person to
   * answer. `commandsComing`: whether commands will be read.
   * `tab`: the tab's number, for its dialogs' ids.
   */
  static async attach(
    page: Page,
    say: (text: string, scriptId?: string) => void,
    { visible, commandsComing = false, tab = 1 }: { visible: boolean; commandsComing?: boolean; tab?: number },
  ): Promise<DialogTracker> {
    const tracker = new DialogTracker(page, say, visible, commandsComing, tab);
    trackedPages.add(page);
    live.add(tracker);
    page.on('close', () => live.delete(tracker));
    // One already open, from before the run had the tab: not one the
    // person has answered since.
    const waiting = await hasUntrackedDialog(page) ? untracked.get(page) : undefined;
    untracked.delete(page);
    page.on('dialog', (dialog) => tracker.opened(dialog));
    // Answered in the browser, a dialog closes without Playwright
    // saying so; the protocol's own event does.
    const listening = (async () => {
      try {
        const cdp = await page.context().newCDPSession(page);
        cdp.on('Page.javascriptDialogClosed', () => tracker.closed());
        cdp.on('Page.fileChooserOpened', (event) => void tracker.chooserOpened(cdp, event as ChooserEvent));
        cdp.on('Page.frameNavigated', (event) => void tracker.frameNavigated(event.frame));
        cdp.on('Page.frameDetached', (event) => void tracker.frameNavigated({ id: event.frameId, parentId: '' }));
        await cdp.send('Page.enable');
        tracker.cdp = cdp;
        await tracker.syncIntercept();
      } catch {
        // Then `dialog show` may name a dialog already answered, until
        // `verify` finds the page running again.
      }
    })();
    if (!waiting) {
      await listening;
      return tracker;
    }
    // Reported (or dismissed) before waiting on the session: while the
    // dialog is open, `Page.enable` doesn't return, so the session is
    // ready only once the dialog has closed, by whoever answered it.
    // The session missed that close, so it's counted here.
    tracker.opened(waiting);
    void listening.then(() => tracker.closed());
    return tracker;
  }

  /** The tab's number, as its dialogs' ids start (`T1.`). */
  get tab(): number {
    return this.tabNumber;
  }

  /**
   * `work`, or true as soon as a dialog opens while it runs. A menu
   * command that opens a dialog blocks the page, and the push that
   * fired it with it, until the dialog is answered.
   */
  async untilDialog(work: Promise<boolean>): Promise<boolean> {
    let wake!: () => void;
    const opened = new Promise<boolean>((resolve) => { wake = () => resolve(true); });
    this.waiters.add(wake);
    try {
      return await Promise.race([work, opened]);
    } finally {
      this.waiters.delete(wake);
    }
  }

  /**
   * `work`, which leaves the page (`reload --force`): a beforeunload
   * dialog that opens meanwhile is accepted at once, as leaving was
   * asked for.
   */
  async leavingPage<T>(work: () => Promise<T>): Promise<T> {
    this.leaving++;
    try {
      return await work();
    } finally {
      this.leaving--;
    }
  }

  /** The open JavaScript dialog, now claimed by whoever answers it. */
  take(): Dialog | null {
    const dialog = this.current;
    this.current = null;
    this.unlist(this.currentEntry);
    return dialog;
  }

  /** Puts back a dialog `take` claimed, when answering it failed. */
  putBack(dialog: Dialog): void {
    if (this.current) return;
    this.current = dialog;
    if (this.currentEntry && !this.waiting.includes(this.currentEntry)) this.list(this.currentEntry);
  }

  /** The waiting entry for the JavaScript dialog open now, if any. */
  get stopping(): WaitingDialog | undefined {
    return this.current && this.currentEntry ? this.currentEntry : undefined;
  }

  /** The newest dialog waiting, for a command that just opened one. */
  newest(): WaitingDialog | undefined {
    return this.waiting.at(-1);
  }

  /**
   * Checks that a JavaScript dialog the tracker holds is still open.
   * Its close can go unseen (the session that tells of it went away),
   * and a page that runs code has no dialog open.
   */
  async verify(): Promise<void> {
    if (!this.current || this.page.isClosed()) return;
    // Every frame: one from another site runs in a process of its own,
    // which its dialog stops while the rest of the page runs on.
    if (await allFramesAnswer(this.page)) {
      this.current = null;
      this.unlist(this.currentEntry);
      this.currentEntry = null;
    }
  }

  /**
   * Adds a dialog handed in by `key`'s owner (a connection prompt's
   * record), and tells of it. Once only for each key.
   */
  add(key: unknown, spec: DialogSpec): WaitingDialog {
    const known = this.keys.get(key);
    if (known) return known;
    const entry = this.entry(spec);
    this.keys.set(key, entry);
    this.list(entry);
    this.tell(entry);
    return entry;
  }

  /** Drops the dialog `key` added, once it's answered or gone. */
  drop(key: unknown): WaitingDialog | undefined {
    const entry = this.keys.get(key);
    if (!entry) return undefined;
    this.keys.delete(key);
    this.unlist(entry);
    return entry;
  }

  private entry(spec: DialogSpec): WaitingDialog {
    return { ...spec, id: `T${this.tabNumber}.${++this.numbered}`, tab: this.tabNumber, openedAt: Date.now(), ...(runningCommand ? { openedDuring: runningCommand } : {}) };
  }

  private list(entry: WaitingDialog): void {
    this.waiting.push(entry);
    this.waiting.sort((a, b) => a.openedAt - b.openedAt);
  }

  private unlist(entry: WaitingDialog | null): void {
    if (!entry) return;
    const at = this.waiting.indexOf(entry);
    if (at >= 0) this.waiting.splice(at, 1);
  }

  // Tells of a new dialog as the stream's event: its whole block, so
  // what can be done is right there. Its commands name it with
  // `--dialog` unless it's the only dialog waiting.
  private tell(entry: WaitingDialog): void {
    // With no commands read, only the browser can answer it.
    if (!this.commandsListening) {
      this.say(`*DIALOG* ${dialogSummary(entry)}. ${this.visible ? 'Answer it in its window' : 'Nothing can answer it in a headless run that takes no commands'}.`, entry.scriptId);
      return;
    }
    const alone = allWaiting().length === 1;
    const lines = dialogBlock(entry, { isDefault: alone, heading: '*DIALOG* ' });
    if (this.visible) {
      lines.push(ui``, entry.hidden
        ? ui`  The browser doesn't show it, since sm-dev answers it. Use the commands above.`
        : ui`  It can also be answered in the browser.`);
    }
    this.say(lines.join('\n'), entry.scriptId);
  }

  private closed(): void {
    this.closedCount++;
    if (this.currentOrdinal <= this.closedCount && this.current) {
      this.current = null;
      this.unlist(this.currentEntry);
      this.currentEntry = null;
    }
  }

  private opened(dialog: Dialog): void {
    const ordinal = ++this.openedCount;
    // Counted all the same: its close is counted too.
    if (this.leaving > 0 && dialog.type() === 'beforeunload') {
      void dialog.accept().catch(() => undefined);
      return;
    }
    for (const wake of this.waiters) wake();
    if (!this.visible && !this.commandsListening) {
      const text = dialog.message();
      this.say(ui`The page opened ${dialogKind(dialog)} dialog${text ? `: ${JSON.stringify(text)}` : ''}. Dismissed it, since nothing can answer it in a headless run that takes no commands.`);
      void dialog.dismiss().catch(() => undefined);
      return;
    }
    let entry: WaitingDialog | null = null;
    const spec = javascriptSpec(dialog, this.page.url(), () => {
      // Claimed by whoever presses a button, as `take` does.
      if (this.currentEntry === entry) this.take();
    });
    entry = this.entry(spec);
    this.current = dialog;
    this.currentOrdinal = ordinal;
    this.currentEntry = entry;
    this.list(entry);
    if (!this.commandsListening) {
      const text = dialog.message();
      this.say(ui`*DIALOG* ${S.id(entry.id)}: The page opened ${dialogKind(dialog)} dialog${text ? `: ${JSON.stringify(text)}` : ''}. Answer it in the browser.`);
      return;
    }
    this.tell(entry);
  }
}

/** `a confirm`, `an alert`: a JavaScript dialog's kind, after a verb. */
export function dialogKind(dialog: Dialog): string {
  const type = dialog.type();
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
}

/**
 * Whether dialogs wait for a `dialog` command, rather than being
 * dismissed in a headless run. On while commands are read.
 */
export function setTrackersListening(trackers: (DialogTracker | undefined)[], listening: boolean): void {
  for (const tracker of trackers) if (tracker) tracker.commandsListening = listening;
}

// ---------- Picking one ----------

/** Where a `dialog` command looks for its dialog. */
export interface DialogScope {
  /** The trackers of the run's tabs, T1 first. */
  trackers: DialogTracker[];
  /** The tab the commands act on now, by number. */
  currentTab?: number;
  /** The dialog `dialog select` picked. */
  selected?: string;
}

/**
 * The dialog `dialog` commands apply to by default:
 * - the one `dialog select` picked, while it is still waiting;
 * - else the oldest waiting on the current tab;
 * - else the oldest waiting in the run.
 */
export function defaultDialog(scope: DialogScope): WaitingDialog | undefined {
  const all = scope.trackers.flatMap((t) => t.waiting).sort((a, b) => a.openedAt - b.openedAt);
  return all.find((d) => d.id === scope.selected)
    ?? firstToAnswer(all.filter((d) => d.tab === scope.currentTab))
    ?? firstToAnswer(all);
}

/**
 * Of `dialogs` (oldest first), the one to answer first: one that blocks
 * its page, since the others on that page can't be answered until it
 * is, else the oldest.
 */
export function firstToAnswer(dialogs: WaitingDialog[]): WaitingDialog | undefined {
  return dialogs.find((d) => d.stopsPage) ?? dialogs[0];
}

/** A dialog's id as given (`t1.2` too), or null when it isn't shaped like one. */
export function parseDialogId(text: string): string | null {
  const m = /^T(\d+)\.(\d+)$/i.exec(text);
  return m ? `T${m[1]}.${m[2]}` : null;
}

/** The buttons' labels, for a refusal. */
export function buttonList(d: WaitingDialog): string {
  return d.buttons.map((b) => quoted(b.label)).join(', ');
}

export { CONNECT_BUTTONS };
