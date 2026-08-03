// Shared library every script in this example pulls in: the two
// portable scripts by absolute raw.githubusercontent.com URL, the
// SourceMonkey-only script by relative `@require ./lib.js`.
//
// COMMENTS ONLY below this point may be edited freely; the executable
// declarations must not change without care. Foreign managers fetch
// this file from `main`, so a working-tree edit isn't visible to them
// until it merges.
//
// The declaration forms here are the point. Requires are concatenated
// ahead of the script body into a single injected entry, so all three
// land in the same lexical scope as the body:
//
//   - `class` and `const` are SCRIPT-scoped. If each require were
//     injected as its own separate script (as SourceMonkey did before
//     the concatenated arrangement — see docs/injection-modes.md),
//     these would be invisible to the body no matter what, and reading
//     them would throw ReferenceError.
//   - `var` and `function` are the easy case: at the top level of a
//     standalone script they'd become properties of `globalThis`, so
//     they used to leak across even when the scopes were separate.
//     Inside the shared wrap function they're ordinary locals.
//
// Keeping all three here means the example fails loudly if the
// arrangement ever regresses, and distinguishes "the bridge broke" from
// "everything broke".
//
// `requireScopeUpdateStatus` is here for a second reason: it gives the
// library a real job rather than only assertion targets, and every
// script needs it. They run in DIFFERENT worlds and can't share a JS
// counter, so the count has to come from the DOM — which they do
// share. Each script appends exactly one `#log` row, so counting rows
// is the source of truth.

class RequireScopeGreeter {
  constructor(world) {
    this.world = world;
  }

  greet() {
    return `class RequireScopeGreeter reached the ${this.world} world`;
  }
}

const REQUIRE_SCOPE_CONST = 'const from lib.js';

function requireScopeFn(world) {
  return `function from lib.js, called in the ${world} world`;
}

// Rewrite `#runStatus` to "<ran> of <expected> userscripts ran".
// `expected` comes from the status element's `data-expected` so the
// total lives in one place; whichever script runs last leaves the
// final count, and if none run the page's own initial text already
// reads 0.
function requireScopeUpdateStatus() {
  const log = document.getElementById('log');
  const status = document.getElementById('runStatus');
  if (!log || !status) return;
  const expected = Number(status.dataset.expected);
  const ran = log.querySelectorAll('li[data-script]').length;
  status.textContent =
    `${ran} of ${expected} userscripts ran. See log below.`;
  status.classList.toggle('ran', ran > 0);
}
