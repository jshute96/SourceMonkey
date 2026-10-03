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
export const SM_DEV_PROTOCOL = { major: 1, minor: 1 } as const;

export interface ProtocolVersion {
  major: number;
  minor: number;
}
