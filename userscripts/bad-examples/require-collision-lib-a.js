// First half of the join-only collision, @require'd by
// require-collision.user.js. Nothing here is wrong on its own — this
// file parses, and would run fine if it were the only library.

const SHARED_CONFIG = { source: 'require-collision-lib-a' };

function fromLibA() {
  return SHARED_CONFIG.source;
}
