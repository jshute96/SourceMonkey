// The host of a run whose scripts the real extension runs
// (`--extension`). The run's commands, waits and output read a host's
// reports, values and menus; this one fills them from the extension's
// events (extension-link.ts) and answers from the extension, so they
// work the same as in a harness run.
//
// - Events are translated into the bridge messages a harness page
//   sends (`sm:start`, `sm:gm-menu-register`, ...), and handled by the
//   harness host's own code, so the records are the same.
// - The run knows its scripts by their prepared ids; the extension by
//   its own. `pushed` maps one to the other.
// - A tab is known by its `chrome.tabs` id once claimed (`addTab`);
//   events from other tabs are not the run's.

import { HarnessHost, valueCodec, type MenuCommandRecord, type PageLink } from './host.js';
import type { ExtensionEvent, ExtensionLink } from './extension-link.js';

export class ExtensionHost extends HarnessHost {
  // The extension's script id by the run's, and back.
  private readonly extensionIds = new Map<string, string>();
  private readonly runIds = new Map<string, string>();
  private readonly pagesByTab = new Map<number, PageLink>();
  private readonly tabsByPage = new Map<PageLink, number>();

  constructor(
    private readonly link: ExtensionLink,
    /** Prints a Log entry of one of the run's scripts. */
    private readonly printLog: (name: string, level: string, message: string) => void,
  ) {
    super();
    link.onEvent((event) => this.ingest(event));
  }

  /** The run's script `runId` is the extension's `extensionId`. */
  setPushed(runId: string, extensionId: string): void {
    const before = this.extensionIds.get(runId);
    if (before) this.runIds.delete(before);
    this.extensionIds.set(runId, extensionId);
    this.runIds.set(extensionId, runId);
  }

  /** The extension's ids for the run's scripts, which its tabs let run. */
  pushedIds(): string[] {
    return [...this.extensionIds.values()];
  }

  /** `page` is the run's tab `tabId`. */
  addTab(page: PageLink, tabId: number): void {
    this.pagesByTab.set(tabId, page);
    this.tabsByPage.set(page, tabId);
  }

  tabIdOf(page: PageLink): number | undefined {
    return this.tabsByPage.get(page);
  }

  override detachPage(page: PageLink): void {
    const tabId = this.tabsByPage.get(page);
    if (tabId !== undefined) this.pagesByTab.delete(tabId);
    this.tabsByPage.delete(page);
    super.detachPage(page);
  }

  override async valuesOf(scriptId: string): Promise<Record<string, unknown>> {
    const id = this.extensionIds.get(scriptId);
    if (!id) return {};
    const { decodeValue } = valueCodec();
    const wire = await this.link.values(id);
    return Object.fromEntries(Object.entries(wire).map(([k, v]) => [k, decodeValue(v)]));
  }

  override async setValues(scriptId: string, values: Record<string, unknown>): Promise<void> {
    const id = this.extensionIds.get(scriptId);
    if (!id) throw new Error('The extension has no copy of this script');
    const { encodeValue } = valueCodec();
    await this.link.writeValues(id, Object.entries(values).map(([key, v]) =>
      (v === undefined ? { key, deleted: true } : { key, value: encodeValue(v) })));
  }

  override async fireMenuEntry(entry: MenuCommandRecord): Promise<boolean> {
    const page = this.pageOf(entry);
    const tabId = page && this.tabsByPage.get(page);
    const id = this.extensionIds.get(entry.scriptId);
    if (tabId === undefined || !id) return false;
    return this.link.fireMenu(tabId, id, entry.commandId);
  }

  private ingest(event: ExtensionEvent): void {
    if (event.kind === 'log') {
      const runId = this.runIds.get(event.scriptId);
      // The wrapper's own entries (started, threw, skipped) arrive as
      // reports, and print as those.
      if (!runId || event.entry.source === 'script-wrapper') return;
      this.printLog(this.nameOf(runId), event.entry.level, event.entry.message);
      return;
    }
    if (event.kind === 'values') {
      const runId = this.runIds.get(event.scriptId);
      // Written where the run can see it: in one of its tabs, or by its own `set`.
      const page = event.tabId === undefined ? this.anyPage() : this.pagesByTab.get(event.tabId);
      if (runId && page) void this.handle({ type: 'sm:gm-batch-write', scriptId: runId, writes: event.writes }, page, 'isolated');
      return;
    }
    if (event.kind === 'tab-opened') return;
    const page = this.pagesByTab.get(event.tabId);
    const runId = this.runIds.get(event.scriptId);
    if (!page || !runId) return;
    if (event.kind === 'menu') {
      void this.handle(event.op === 'add'
        ? { type: 'sm:gm-menu-register', scriptId: runId, commandId: event.commandId, name: event.name ?? '' }
        : { type: 'sm:gm-menu-unregister', scriptId: runId, commandId: event.commandId }, page, 'isolated');
      return;
    }
    const type = { 'sm:start': 'sm:start', 'sm:swapped': 'sm:start', 'sm:error': 'sm:error', 'sm:abandoned': 'sm:abandoned' }[event.type];
    if (!type) return;
    void this.handle({
      type, id: runId, name: event.name, url: event.url,
      message: event.message, stack: event.stack, reason: event.reason,
    }, page, 'isolated');
  }

  // Some page of the run's, for a write its own `set` made: the record
  // needs one to print under.
  private anyPage(): PageLink | undefined {
    return this.pagesByTab.values().next().value;
  }
}
