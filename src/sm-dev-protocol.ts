// What the extension and sm-dev both use. Their own module so the
// harness can name them without loading the claim code in
// sm-dev-link.ts.

import type { PendingOnDisk } from './script-display.js';

/** The first argument of every event's console line. */
export const SM_DEV_EVENT = 'sm-dev-event';

/**
 * Refusals of the `managed` calls (managed-changes.ts), which sm-dev
 * also checks before asking for `--force`.
 */
export const RUN_COLLECTION_LOCKED = 'An sm-dev run\'s test collection is changed only by its run';
export const LISTED_BY_LOCATION =
  'This script is listed by a directory or manifest collection, so it stays there while its file does. Only a script in a container collection can be moved or uninstalled.';
export const CONTAINER_TARGET_ONLY = 'Scripts can only be installed or moved into a container collection';

/**
 * Why a manual script (`@run-at context-menu`) can't be run on a tab
 * now: `runManualScript`'s answers, which the popup logs and sm-dev
 * prints after the script's name. See docs/manual-scripts.md.
 */
export const MANUAL_RUN_NOT_INSTALLED = 'This script is not installed';
export const MANUAL_RUN_NOT_MANUAL =
  'This script runs when a page loads. Only a script with @run-at context-menu is run on request.';
export const MANUAL_RUN_SCRIPT_OFF = 'This script is turned off';
export const MANUAL_RUN_COLLECTION_OFF = 'This script\'s collection is turned off';
export const MANUAL_RUN_NOT_HERE = 'This script\'s @match and @include rules don\'t cover this page';
export const MANUAL_RUN_PAGE = 'SourceMonkey can\'t run scripts on this page';
export const MANUAL_RUN_TAB_GONE = 'The tab was closed';
export const MANUAL_RUN_PAGE_CHANGED = 'The page changed before the script could run. Try again.';
export const MANUAL_RUN_SM_DEV = 'The sm-dev run controlling this tab keeps this script out';

/** The reason a skipped wrapper reports for a tab an sm-dev run controls. */
export const SKIP_REASON_SM_DEV = 'tab controlled by sm-dev';

/**
 * The version of the calls and events between sm-dev and the extension,
 * which each side has its own copy of: sm-dev from a repo's install, the
 * extension from the person's browser. A run compares them as it
 * connects (extension-link.ts). See CLAUDE.md for when to bump which.
 *   - `major`: a change that needs both sides updated. A run refuses an
 *     extension whose major differs.
 *   - `minor`: an addition. An extension ahead is fine. An sm-dev ahead
 *     checks the extension's minor before using what came later
 *     (`ExtensionLink.requireMinor`).
 */
// 1.1: `scriptsOnTab` rows carry the script's number.
// 1.2: `managedCollections` and `managedScripts`; `writeRunScript`
//   takes the script's `source` file, which `managedScripts` gives back.
// 1.3: permission prompts: `connect-prompt` events, `answerConnectPrompt`.
// 1.4: a report event can carry `detail`: why a script had no decision.
// 1.5: `managed`, the calls that change collections and installed
//   scripts (`managed.setScriptEnabled` and the rest), and
//   `managed.scriptDetails` / `managed.scriptText` (managed-changes.ts).
// 1.6: manual scripts (`@run-at context-menu`): `runManualScript`, and
//   the `sm:manual` report for one waiting in a new document.
// 1.7: a script's badge status can be `UNTRACKED`: its page loaded
//   before the extension started.
export const SM_DEV_PROTOCOL = { major: 1, minor: 7 } as const;

export interface ProtocolVersion {
  major: number;
  minor: number;
}

/** A collection, as the extension's `managedCollections` lists it. */
export interface ManagedCollection {
  /** The extension's own id for it. */
  id: string;
  /** Its number (sm-dev's `C3`); absent for a run's test collection. */
  number?: number;
  name: string;
  kind: 'container' | 'directory' | 'manifest';
  /** A directory's or manifest's location; none for a container. */
  location?: string;
  /** A run's test collection: the run's id in the extension (`D1-ab12`). */
  run?: string;
  enabled: boolean;
  /** Why its last scan failed. */
  error?: string;
  scriptCount: number;
}

/** An installed script, as the extension's `managedScripts` lists it. */
export interface ManagedScript {
  /** The extension's own id for it. */
  id: string;
  /**
   * Its number (sm-dev's `E12`); absent in a run's test collection, and
   * until the worker gives it one.
   */
  number?: number;
  name: string;
  namespace?: string;
  version?: string;
  /** Where it is loaded from: for a run's script, its `scratch:` URL. */
  location: string;
  /** A run's script: the file it was read from, as a `file://` URL. */
  sourceFile?: string;
  /** A run's script: its path as the run was given it, often relative. */
  loadedAs?: string;
  collectionId: string;
  enabled: boolean;
  status: 'ok' | 'invalid';
  /** Why it is invalid. */
  error?: string;
  /** Why its last refresh failed, while its last good copy still runs. */
  refreshError?: string;
  /**
   * Set by sm-dev, under another manager (external-manager.ts): a
   * run's script, whose run is live (`D1`).
   */
  run?: string;
  /** Set by sm-dev, under another manager: a run's script, left by that run when it ended (`D1`). */
  leftBy?: string;
}

/** A `@require` or `@resource`, as `managed.scriptDetails` gives it. */
export interface ManagedFile {
  /** As the header gives it. */
  url: string;
  /** `@resource`'s name. */
  name?: string;
  /** Loaded, or not: a script that failed to load has none. Absent when the manager doesn't say. */
  loaded?: boolean;
  /** The local file read in its place. */
  local?: string;
}

/** An installed script in full, for `script show` (`managed.scriptDetails`). */
export interface ManagedScriptDetails extends ManagedScript {
  description?: string;
  author?: string;
  /** When its current text was loaded, in epoch ms; absent if never. */
  updatedAt?: number;
  match: string[];
  include: string[];
  exclude: string[];
  excludeMatch: string[];
  /** As the header gives it; absent for none (`document-idle`). */
  runAt?: string;
  grants: string[];
  requires: ManagedFile[];
  resources: ManagedFile[];
  /** Absent when the manager doesn't say. */
  valueCount?: number;
}

/** What `managed.refreshScript` did. */
export interface ScriptRefresh {
  script: ManagedScript;
  /** It loaded different text. */
  updated: boolean;
}

/**
 * What the disk says of the local scripts and collections, as the
 * collections page's chips show it: `managed.onDisk`. Only those that
 * differ are listed.
 */
export interface ManagedOnDisk {
  /** By script id: its file changed, or is gone, since it was loaded. */
  scripts: Record<string, 'modified' | 'deleted'>;
  /** By collection id: what a refresh would load (script-display.ts). */
  collections: Record<string, PendingOnDisk>;
}

/** What `managed.refreshCollection` did. */
export interface CollectionRefresh {
  collection: ManagedCollection;
  /** Its scripts after: added or with different text (`updated`), unchanged, and removed (as they were). */
  updated: ManagedScript[];
  unchanged: number;
  removed: ManagedScript[];
  /**
   * Its scripts that couldn't be refreshed, each with `refreshError`.
   * Set by sm-dev under another manager, never sent by the extension.
   */
  failed?: ManagedScript[];
}

/**
 * What turning a script on did: `managed.setScriptEnabled`,
 * `moveScript` and `installScript`.
 */
export interface ScriptEnable {
  script: ManagedScript;
  /** Its other copies that were running, turned off as the viewer does. */
  turnedOff: ManagedScript[];
}

/** What `managed.installScript` did. */
export interface ScriptInstall extends ScriptEnable {
  /** It was already installed in that collection, so nothing changed. */
  already?: true;
  /** Set by sm-dev, under another manager: it replaced the script with the same name and namespace. */
  replaced?: true;
}
