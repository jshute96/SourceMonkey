// Strings the extension and sm-dev both use. Their own module so the
// harness can name them without loading the claim code in
// sm-dev-link.ts.

/** The first argument of every event's console line. */
export const SM_DEV_EVENT = 'sm-dev-event';

/** The reason a skipped wrapper reports for a tab an sm-dev run controls. */
export const SKIP_REASON_SM_DEV = 'tab controlled by sm-dev';
