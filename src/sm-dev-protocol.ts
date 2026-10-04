// What the extension and sm-dev both use. Their own module so the
// harness can name them without loading the claim code in
// sm-dev-link.ts.

/** The first argument of every event's console line. */
export const SM_DEV_EVENT = 'sm-dev-event';

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
export const SM_DEV_PROTOCOL = { major: 1, minor: 3 } as const;

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
}
