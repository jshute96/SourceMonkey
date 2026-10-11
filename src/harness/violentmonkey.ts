// Violentmonkey (VM), driven by the messages its own pages send its
// background: `{cmd, data}` through `chrome.runtime.sendMessage`, from
// a hidden page of VM's own (its options page), since VM answers no
// other sender. Not a published API: what each call takes and gives is
// listed in docs/sm-dev-violentmonkey.md, which the version check
// (tests/vm-api/vm-api.spec.ts) tries against a fetched VM.

import { installedManagers, openHiddenPage, type HiddenPage } from './browser-extensions.js';
import type { ExternalManager, ExternalScript, InstallOptions } from './external-manager.js';
import { MANAGERS } from './managers.js';
import { quoted } from './output-style.js';

// A script as `GetData` lists it: only the fields sm-dev reads.
interface VmScript {
  props: { id: number; lastModified?: number; lastUpdated?: number };
  meta: {
    name?: string;
    namespace?: string;
    version?: string;
    description?: string;
    author?: string;
    match?: string[];
    include?: string[];
    exclude?: string[];
    excludeMatch?: string[];
    require?: string[];
    resources?: Record<string, string>;
    grant?: string[];
    runAt?: string;
  };
  config: { enabled?: number | boolean; removed?: number | boolean };
  custom: { lastInstallURL?: string };
}

// The page the calls are sent from, as VM's manifest names it.
const OPTIONS_PAGE = 'options/index.html';

// Chrome's words when nothing answered a message: VM has no such call.
const NO_ANSWER = /message port closed|Receiving end does not exist/i;

/** Violentmonkey in one browser, over a hidden page of its own until `close`. */
export class Violentmonkey implements ExternalManager {
  readonly name = 'violentmonkey' as const;
  readonly label = MANAGERS.violentmonkey.label;

  private constructor(private readonly page: HiddenPage, readonly extensionId: string, readonly version: string) {}

  /**
   * Connects to VM in the browser at `endpoint`. Throws saying why when
   * it isn't installed and enabled there. `browserArg`: ` --browser
   * <address>` for the advice, when the browser isn't the default.
   */
  static async open(endpoint: string, browserArg = ''): Promise<Violentmonkey> {
    const label = MANAGERS.violentmonkey.label;
    const copies = (await installedManagers(endpoint)).filter((m) => m.manager === 'violentmonkey');
    const copy = copies.find((m) => m.enabled);
    if (!copy) {
      throw new Error(`${label} is ${copies.length > 0 ? 'turned off' : 'not installed'} in this browser. Use ${quoted(`sm-dev${browserArg} --manager vm manager ${copies.length > 0 ? 'enable' : 'install'}`)}.`);
    }
    let page: HiddenPage;
    try {
      // Once loaded: a call made while the page's own scripts start can
      // get its answer wrapped (`[result]`), as VM's pages get theirs.
      page = await openHiddenPage(endpoint, `chrome-extension://${copy.id}/${OPTIONS_PAGE}`, 'document.readyState === "complete" && typeof chrome?.runtime?.sendMessage === "function"');
    } catch (err) {
      throw new Error(`${label} ${copy.version}'s options page could not be opened: ${(err as Error).message}`, { cause: err });
    }
    return new Violentmonkey(page, copy.id, copy.version);
  }

  /** Makes one call. Its failure names the call and VM's version. */
  async call<R>(cmd: string, data?: unknown): Promise<R> {
    try {
      return await this.page.evaluate<R>(`chrome.runtime.sendMessage(${JSON.stringify({ cmd, data })})`);
    } catch (err) {
      const why = (err as Error).message.replace(/^Error: /, '');
      if (NO_ANSWER.test(why)) {
        throw new Error(`${this.label} ${this.version} doesn't answer its ${cmd} call, which sm-dev uses. This version may have changed it.`, { cause: err });
      }
      // A refusal, or the browser not answering: VM's own error says which.
      throw new Error(`${this.label} ${this.version}'s ${cmd} call failed: ${why}`, { cause: err });
    }
  }

  async scripts(): Promise<ExternalScript[]> {
    const data = await this.call<{ scripts?: VmScript[] }>('GetData', {});
    if (!Array.isArray(data?.scripts)) throw new Error(`${this.label} ${this.version}'s GetData call gave no script list, which sm-dev reads. This version may have changed it.`);
    return data.scripts.filter((s) => !s.config.removed).map((s) => scriptOf(s));
  }

  async texts(ids: number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const codes = await this.call<Record<string, string>>('GetScriptCode', ids);
    return new Map(ids.flatMap((id) => (typeof codes?.[id] === 'string' ? [[id, codes[id]] as [number, string]] : [])));
  }

  async install(code: string, options: InstallOptions = {}): Promise<{ id: number; isNew: boolean }> {
    const result = await this.call<{ isNew?: boolean; where?: { id?: number } }>('ParseScript', {
      code,
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.url !== undefined ? { url: options.url } : {}),
      // VM would check its install URL for updates.
      ...(options.local ? { config: { shouldUpdate: 0 } } : {}),
      // Present, even empty, so VM waits for what it fetches itself
      // before answering, rather than leaving it in flight.
      require: options.files?.requires ?? {},
      cache: Object.fromEntries(Object.entries(options.files?.resources ?? {}).map(([url, f]) => [url, `${f.contentType},${f.base64}`])),
      bumpDate: true,
    });
    const id = result?.where?.id;
    if (typeof id !== 'number') throw new Error(`${this.label} ${this.version}'s ParseScript call gave no script id. This version may have changed it.`);
    return { id, isNew: result.isNew === true };
  }

  async setEnabled(id: number, enabled: boolean): Promise<void> {
    await this.call('UpdateScriptInfo', { id, config: { enabled: enabled ? 1 : 0 } });
  }

  async uninstall(id: number): Promise<void> {
    await this.call('MarkRemoved', { id, removed: true });
  }

  async remove(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    // VM removes for good only what's in its recycle bin.
    for (const id of ids) await this.call('MarkRemoved', { id, removed: true });
    await this.call('RemoveScripts', ids);
  }

  async applied(): Promise<boolean> {
    return (await this.options()).isApplied !== false;
  }

  async setApplied(on: boolean): Promise<void> {
    await this.call('SetOptions', { isApplied: on });
  }

  async allowFilePages(): Promise<boolean> {
    const { blacklist } = await this.options();
    if (typeof blacklist !== 'string') return false;
    // Its default holds only this rule, one rule a line.
    const lines = blacklist.split('\n');
    const kept = lines.filter((line) => line.trim() !== 'file://*/*');
    if (kept.length === lines.length) return false;
    await this.call('SetOptions', { blacklist: kept.join('\n') });
    return true;
  }

  scriptIdOf(url: string): number | undefined {
    // `chrome-extension://<id>/<name>.user.js#<script id>`, as a frame's
    // URL or in a stack's text.
    const id = new RegExp(`chrome-extension://${this.extensionId}/[^\\s#]*\\.user\\.js#(\\d+)(?!\\d)`).exec(url);
    return id ? Number(id[1]) : undefined;
  }

  get scriptUrlPrefix(): string {
    return `chrome-extension://${this.extensionId}/`;
  }

  close(): Promise<void> {
    return this.page.close();
  }

  private async options(): Promise<{ isApplied?: boolean; blacklist?: string }> {
    return await this.call<{ isApplied?: boolean; blacklist?: string }>('GetAllOptions') ?? {};
  }
}

function scriptOf(s: VmScript): ExternalScript {
  const { meta } = s;
  return {
    id: s.props.id,
    name: meta.name ?? `#${s.props.id}`,
    ...(meta.namespace ? { namespace: meta.namespace } : {}),
    ...(meta.version ? { version: meta.version } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    enabled: Boolean(s.config.enabled),
    match: meta.match ?? [],
    include: meta.include ?? [],
    exclude: meta.exclude ?? [],
    excludeMatch: meta.excludeMatch ?? [],
    ...(meta.runAt ? { runAt: meta.runAt } : {}),
    grants: meta.grant ?? [],
    requires: meta.require ?? [],
    resources: Object.entries(meta.resources ?? {}).map(([name, url]) => ({ name, url })),
    ...(s.custom.lastInstallURL ? { installUrl: s.custom.lastInstallURL } : {}),
    ...(s.props.lastUpdated ?? s.props.lastModified ? { updatedAt: s.props.lastUpdated ?? s.props.lastModified } : {}),
  };
}
