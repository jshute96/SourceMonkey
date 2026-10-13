// Tampermonkey (TM), driven by the messages its own dashboard sends its
// background: `{method, ...}` through `chrome.runtime.sendMessage`,
// from a hidden page of TM's own (`options.html`), since TM answers no
// other sender. Not a published API: what each call takes and gives is
// listed in docs/sm-dev-tampermonkey.md, which the version check
// (tests/tm-api/tm-api.spec.ts) tries against a fetched TM.

import { installedManagers, openHiddenPage, type HiddenPage } from './browser-extensions.js';
import { installUrlOf, type ExternalManager, type ExternalScript, type InstallOptions } from './external-manager.js';
import { MANAGERS } from './managers.js';
import { withoutMark } from './script-mark.js';
import { TmIds } from './tm-ids.js';
import { getValue, getValues, parseHeader } from '../userscript-header.js';
import { quoted } from './output-style.js';

// A script as the dashboard's list gives it: only the fields sm-dev reads.
interface TmScript {
  uuid: string;
  name?: string;
  namespace?: string | null;
  version?: string | null;
  description?: string | null;
  author?: string | null;
  enabled?: boolean;
  matches?: string[];
  includes?: string[];
  excludes?: string[];
  grant?: string[];
  fileURL?: string | null;
  downloadURL?: string | null;
  lastModified?: number;
  code?: string;
  options?: { run_at?: string | null; override?: { orig_run_at?: string } };
}

const OPTIONS_PAGE = 'options.html';

// How long one listing of every script, code included, answers again.
// A command asks for the list, then the texts, then the count, so this
// saves reading them all three times. Any call that changes something
// drops it.
const LIST_REUSE_MS = 1000;

// The calls that only read, so keep the listing.
const READS = new Set(['loadTree', 'determineScriptsToRun']);

// The comment keeping a header line sm-dev rewrote, as it was, by its
// line's index: `// sm-dev was: 5 // @require lib.js`. Written before
// sm-dev's mark (script-mark.ts), at the end, so no line moves.
// `[^\n]`, not `.`, so a line's `\r` (a CRLF file) stays with it.
const WAS = /^\/\/ sm-dev was: (\d+) ([^\n]*)$/;

/** Tampermonkey in one browser, over a hidden page of its own until `close`. */
export class Tampermonkey implements ExternalManager {
  readonly name = 'tampermonkey' as const;
  readonly label = MANAGERS.tampermonkey.label;
  private readonly ids = new TmIds();
  // How far each of the run's scripts' lines are moved, by uuid (see `noteRequires`).
  private readonly layouts = new Map<string, { offset: number; requires: { url: string; lines: number }[] }>();
  private listed?: { at: number; scripts: Promise<TmScript[]> };

  private constructor(private readonly page: HiddenPage, readonly extensionId: string, readonly version: string) {}

  /**
   * Connects to TM in the browser at `endpoint`. Throws saying why when
   * it isn't installed and enabled there. `browserArg`: the flags
   * that name the browser in the advice (see `browserArg` in run.ts).
   */
  static async open(endpoint: string, browserArg = ''): Promise<Tampermonkey> {
    const label = MANAGERS.tampermonkey.label;
    const copies = (await installedManagers(endpoint)).filter((m) => m.manager === 'tampermonkey');
    const copy = copies.find((m) => m.enabled);
    if (!copy) {
      throw new Error(`${label} is ${copies.length > 0 ? 'turned off' : 'not installed'} in this browser. Use ${quoted(`sm-dev${browserArg} --manager tm manager ${copies.length > 0 ? 'enable' : 'install'}`)}.`);
    }
    let page: HiddenPage;
    try {
      page = await openHiddenPage(endpoint, `chrome-extension://${copy.id}/${OPTIONS_PAGE}`, 'document.readyState === "complete" && typeof chrome?.runtime?.sendMessage === "function"');
    } catch (err) {
      throw new Error(`${label} ${copy.version}'s dashboard could not be opened: ${(err as Error).message}`, { cause: err });
    }
    return new Tampermonkey(page, copy.id, copy.version);
  }

  /**
   * Makes one call. TM gives no answer to a call it doesn't know, so
   * one without an answer fails naming the call and TM's version.
   */
  async call<R>(method: string, fields: Record<string, unknown> = {}): Promise<R> {
    if (!READS.has(method)) this.listed = undefined;
    let answer: R | undefined;
    try {
      answer = await this.page.evaluate<R | undefined>(`chrome.runtime.sendMessage(${JSON.stringify({ method, ...fields })})`);
    } catch (err) {
      throw new Error(`${this.label} ${this.version}'s ${method} call failed: ${(err as Error).message.replace(/^Error: /, '')}`, { cause: err });
    }
    if (answer === undefined || answer === null) {
      throw new Error(`${this.label} ${this.version} doesn't answer its ${method} call, which sm-dev uses. This version may have changed it.`);
    }
    const error = (answer as { error?: unknown }).error;
    if (error) throw new Error(`${this.label} ${this.version}'s ${method} call failed: ${String(error)}`);
    return answer;
  }

  // Every installed script, with its text as TM keeps it.
  private list(): Promise<TmScript[]> {
    if (this.listed && Date.now() - this.listed.at < LIST_REUSE_MS) return this.listed.scripts;
    const scripts = this.listAnew();
    this.listed = { at: Date.now(), scripts };
    // A failed listing isn't kept for the next.
    scripts.catch(() => {
      if (this.listed?.scripts === scripts) this.listed = undefined;
    });
    return scripts;
  }

  private async listAnew(): Promise<TmScript[]> {
    const tree = await this.call<{ items?: unknown[] }>('loadTree', { referrer: 'options.scripts.userscripts', complete: true });
    if (!Array.isArray(tree.items)) throw this.changed('loadTree', 'no script list');
    // The rest are the dashboard's own entries.
    const scripts = tree.items.filter((i): i is TmScript => typeof (i as TmScript)?.uuid === 'string');
    this.ids.numbersOf(scripts.map((s) => s.uuid));
    return scripts;
  }

  private changed(method: string, what: string): Error {
    return new Error(`${this.label} ${this.version}'s ${method} call gave ${what}, which sm-dev reads. This version may have changed it.`);
  }

  private numberOf(uuid: string): number {
    return this.ids.numberOf(uuid) ?? this.ids.numbersOf([uuid]).get(uuid)!;
  }

  private uuidOf(id: number): string {
    const uuid = this.ids.uuidOf(id);
    if (!uuid) throw new Error(`There is no script E${id} in ${this.label}`);
    return uuid;
  }

  async scripts(): Promise<ExternalScript[]> {
    return (await this.list()).map((s) => this.scriptOf(s));
  }

  async texts(ids: number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const wanted = new Set(ids);
    return new Map((await this.list()).flatMap((s) => {
      const id = this.numberOf(s.uuid);
      return wanted.has(id) && typeof s.code === 'string' ? [[id, restoredText(s.code)] as [number, string]] : [];
    }));
  }

  async install(code: string, options: InstallOptions = {}): Promise<{ id: number; isNew: boolean }> {
    await this.mustSaveQuietly();
    const header = parseHeader(code);
    const name = header ? getValue(header, 'name') : undefined;
    // TM keeps any number of scripts of one name and namespace; sm-dev
    // replaces as Violentmonkey does, keeping to one.
    let uuid = options.id !== undefined ? this.uuidOf(options.id) : undefined;
    if (uuid === undefined && header && name !== undefined) {
      const namespace = getValue(header, 'namespace') ?? '';
      uuid = (await this.list()).find((s) => s.name === name && (s.namespace ?? '') === namespace)?.uuid;
    }
    const text = options.url ? rewrittenText(code, options.url) : code;
    const saved = await this.call<{ uuid?: string; installed?: boolean }>('saveScript', {
      ...(uuid !== undefined ? { uuid } : { uuid: 'new', new_script: true }),
      code: text,
      reload: false,
    });
    if (typeof saved.uuid !== 'string' || !saved.installed) throw this.changed('saveScript', 'no installed script');
    for (const [url, source] of Object.entries(options.files?.requires ?? {})) {
      await this.call('saveExternal', { uuid: saved.uuid, url, code: source, mimetype: 'text/javascript' });
    }
    // A resource is kept as a string of its bytes, one character each.
    for (const [url, { contentType, base64 }] of Object.entries(options.files?.resources ?? {})) {
      await this.call('saveExternal', { uuid: saved.uuid, url, code: Buffer.from(base64, 'base64').toString('latin1'), mimetype: contentType || 'application/octet-stream' });
    }
    return { id: this.numberOf(saved.uuid), isNew: uuid === undefined };
  }

  // TM saves without asking only with its Easy save setting on, as it
  // is by default; otherwise each save waits on a page no one sees.
  private async mustSaveQuietly(): Promise<void> {
    if ((await this.settings()).editor_easySave === false) {
      throw new Error(`${this.label}'s Easy save setting is off, so it would ask before each save. Turn it on in ${this.label}'s settings (Editor, shown in the Advanced config mode), then try again.`);
    }
  }

  async setEnabled(id: number, enabled: boolean): Promise<void> {
    await this.call('modifyScriptOptions', { uuid: this.uuidOf(id), enabled, reload: false });
  }

  async uninstall(id: number): Promise<void> {
    await this.call('saveScript', { uuid: this.uuidOf(id), code: null, reload: false });
  }

  async remove(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.call('purgeScripts', { uuids: ids.map((id) => this.uuidOf(id)) });
  }

  async applied(): Promise<boolean> {
    return (await this.settings()).enabled !== false;
  }

  async setApplied(on: boolean): Promise<void> {
    await this.call('setOption', { name: 'enabled', value: on });
  }

  async allowFilePages(): Promise<boolean> {
    // Chrome's own file access setting decides, which sm-dev leaves.
    return false;
  }

  async matching(url: string): Promise<number[]> {
    const { scripts } = await this.call<{ scripts?: unknown }>('determineScriptsToRun', { url });
    if (!Array.isArray(scripts)) throw this.changed('determineScriptsToRun', 'no script list');
    return scripts.filter((s): s is string => typeof s === 'string').map((uuid) => this.numberOf(uuid));
  }

  scriptIdOf(url: string): number | undefined {
    // `chrome-extension://<id>/userscript.html?name=<name>.user.js&id=<uuid>`,
    // as a frame's URL or in a stack's text.
    const uuid = new RegExp(`chrome-extension://${this.extensionId}/userscript\\.html\\?\\S*?\\bid=([0-9a-f-]{36})`).exec(url)?.[1];
    return uuid === undefined ? undefined : this.ids.numberOf(uuid);
  }

  get scriptUrlPrefix(): string {
    return `chrome-extension://${this.extensionId}/`;
  }

  /**
   * Notes the `@require` files one of the run's scripts was installed
   * with, in order, as `remapStack` needs them: TM runs a script's code
   * after one line of its own and its `@require` files, joined by
   * newlines, with the script's first line on their last.
   */
  noteRequires(id: number, requires: { url: string; source: string }[]): void {
    const joined = requires.map((r) => r.source).join('\n');
    this.layouts.set(this.uuidOf(id), {
      offset: 1 + newlines(joined),
      requires: requires.map((r) => ({ url: r.url, lines: newlines(r.source) + 1 })),
    });
  }

  /** `text` with the run's scripts' stack lines pointed at the lines of their own files. */
  remapStack(text: string): string {
    if (this.layouts.size === 0) return text;
    const ref = new RegExp(`(chrome-extension://${this.extensionId}/userscript\\.html\\?\\S*?\\bid=([0-9a-f-]{36})):(\\d+):(\\d+)`, 'g');
    return text.replace(ref, (all, url: string, uuid: string, line: string, col: string) => {
      const layout = this.layouts.get(uuid);
      if (!layout) return all;
      const n = Number(line);
      if (n - layout.offset >= 1) return `${url}:${n - layout.offset}:${col}`;
      // In a `@require` file: its line, counted from the line after TM's own.
      let at = n - 1;
      for (const r of layout.requires) {
        if (at >= 1 && at <= r.lines) return `${r.url}:${at}:${col}`;
        at -= r.lines;
      }
      return all;
    });
  }

  close(): Promise<void> {
    return this.page.close();
  }

  private async settings(): Promise<{ enabled?: boolean; editor_easySave?: boolean }> {
    const tree = await this.call<{ options?: { enabled?: boolean; editor_easySave?: boolean } }>('loadTree', { referrer: 'options' });
    if (!tree.options) throw this.changed('loadTree', 'no settings');
    return tree.options;
  }

  private scriptOf(s: TmScript): ExternalScript {
    const id = this.numberOf(s.uuid);
    // The dependencies as the script's own header gives them, before
    // sm-dev's rewrite.
    const header = typeof s.code === 'string' ? parseHeader(restoredText(s.code)) : null;
    const runAt = s.options?.run_at ?? s.options?.override?.orig_run_at;
    return {
      id,
      name: s.name ?? s.uuid,
      ...(s.namespace ? { namespace: s.namespace } : {}),
      ...(s.version ? { version: s.version } : {}),
      ...(s.description ? { description: s.description } : {}),
      ...(s.author ? { author: s.author } : {}),
      enabled: s.enabled !== false,
      match: s.matches ?? [],
      include: s.includes ?? [],
      exclude: s.excludes ?? [],
      excludeMatch: [],
      ...(runAt ? { runAt } : {}),
      grants: s.grant ?? [],
      requires: header ? getValues(header, 'require') : [],
      resources: header ? getValues(header, 'resource').flatMap((v) => {
        const [name, url] = v.split(/\s+/, 2);
        return name && url ? [{ name, url }] : [];
      }) : [],
      ...(s.fileURL || s.downloadURL ? { installUrl: (s.fileURL || s.downloadURL)! } : {}),
      ...(s.lastModified ? { updatedAt: s.lastModified } : {}),
    };
  }
}

function newlines(text: string): number {
  return text.split('\n').length - 1;
}

/**
 * `code` as TM is given it. A script saved from TM's dashboard has no
 * URL of its own, so TM can't resolve a relative `@require` or
 * `@resource`; each one is rewritten to the URL it resolves to from
 * `url`, a local file's under `sm-dev.invalid`. Each line rewritten is
 * kept as it was in a comment at the end, before sm-dev's mark, which
 * `restoredText` puts back.
 */
export function rewrittenText(code: string, url: string): string {
  const body = withoutMark(code);
  const markLine = code.slice(body.length);
  const lines = body.split('\n');
  const was: string[] = [];
  let inHeader = false;
  for (let i = 0; i < lines.length; i++) {
    // Without a CRLF file's `\r`, which goes back after.
    const cr = lines[i]!.endsWith('\r') ? '\r' : '';
    const line = lines[i]!.slice(0, lines[i]!.length - cr.length);
    if (/^\s*\/\/\s*==UserScript==/.test(line)) inHeader = true;
    else if (/^\s*\/\/\s*==\/UserScript==/.test(line)) break;
    if (!inHeader) continue;
    const tag = /^(\s*\/\/\s*@(require|resource)\s+)(\S+\s+)?(\S+)(.*)$/.exec(line);
    if (!tag) continue;
    const [, lead, kind, name = '', value, rest] = tag;
    // `@require` takes no name: a second word there is the URL's own.
    if (kind === 'require' && name) continue;
    const resolved = resolvedUrl(value!, url);
    if (resolved === value) continue;
    lines[i] = `${lead}${name}${resolved}${rest}${cr}`;
    was.push(`// sm-dev was: ${i} ${line}${cr}`);
  }
  if (was.length === 0) return code;
  const rewritten = lines.join('\n');
  return `${rewritten}${rewritten.endsWith('\n') ? '' : '\n'}${was.join('\n')}\n${markLine}`;
}

// Where a dependency's URL resolves to from the script's, a local
// file's under sm-dev.invalid. The same as given when it can't be
// resolved, which TM then reports itself.
function resolvedUrl(value: string, base: string): string {
  let href: string;
  try {
    href = new URL(value, base).href;
  } catch {
    return value;
  }
  return installUrlOf(href);
}

/** `text` with the header lines `rewrittenText` changed as they were, and without its comments. */
export function restoredText(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  const was = new Map<number, string>();
  for (const line of lines) {
    const m = WAS.exec(line);
    if (m) was.set(Number(m[1]), m[2]!);
    else kept.push(line);
  }
  if (was.size === 0) return text;
  // The comments come after every line they name, so dropping them
  // moves none of those.
  for (const [i, line] of was) if (i < kept.length) kept[i] = line;
  return kept.join('\n');
}
