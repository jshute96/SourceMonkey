// A page whose CSP `sandbox` turns off script in its own world, so
// Chrome skips MAIN-world scripts there. The Log warning
// (missing-scripts.ts) and sm-dev's warning share these words. Its own
// module so sm-dev can use them without the badge code.

// The fix for such a page.
export const INJECT_INTO_CONTENT_FIX =
  'Add @inject-into content to run a script in the isolated context instead, unless it needs the page\'s own variables';

// What a sandboxed page does to scripts in its own context.
export const SANDBOX_BLOCKS_PAGE_CONTEXT =
  'A sandboxed page stops scripts running in the page\'s own context';

// Whether a Content-Security-Policy header value sandboxes the page
// without `allow-scripts`. Several headers arrive comma-joined, one
// policy each, and any one of them can sandbox. For sm-dev, which sees
// the response; the extension only sees what its wrappers report.
export function cspBlocksPageScripts(header: string): boolean {
  for (const policy of header.split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...tokens] = directive.trim().toLowerCase().split(/\s+/);
      if (name === 'sandbox' && !tokens.includes('allow-scripts')) return true;
    }
  }
  return false;
}

// sm-dev's warning for such a page, naming the run's MAIN-world scripts
// that match it.
export function sandboxedPageWarning(scripts: readonly string[]): string {
  return 'This page\'s Content-Security-Policy header sandboxes it without allow-scripts. ' +
    `${SANDBOX_BLOCKS_PAGE_CONTEXT}, so these scripts can't run here: ` +
    `${scripts.join(', ')}. ${INJECT_INTO_CONTENT_FIX}.`;
}
