# Compile-only parse check

Answers one question at install / refresh time: **would V8 accept the
code we are about to register?**

## Why

Requires and the body are concatenated into one injected entry (Mode A
— see [injection-modes.md](injection-modes.md)). A syntax error
anywhere in that program makes the *whole* entry fail to parse.

Before this check, that was only discoverable at injection time:

- The seal entry noticed `__smRun` was never called and logged
  "script source failed to parse (a `@require` or the script body has a
  syntax error); nothing was run".
- It fired only on a page the script actually matched, so a broken
  script looked fine on the sources page until you happened to visit
  one.
- It named no file.

Now the script is marked `invalid` next to its row, at the moment it is
added or refreshed.

## How it works

`new Function(src)` compiles a function body and returns **without
running it**. That is exactly the check — and it is V8's own verdict on
the same text we inject, not another parser's opinion about a similar
text.

But `new Function` is `eval` as far as CSP is concerned, and MV3's
extension CSP forbids it in every context an extension normally uses.
A **sandboxed page** may declare `'unsafe-eval'`, and is the only place
that may. So the work is split three ways:

| Context | Has | Lacks |
|---------|-----|-------|
| Service worker (`parse-check.ts`) | `chrome.*` | DOM, `eval` |
| Offscreen document (`offscreen.ts`) | `chrome.*`, DOM | `eval` |
| Sandboxed iframe (`parse-sandbox.ts`) | `eval` | `chrome.*` |

The service worker messages the offscreen document, which relays over
`postMessage` to the sandboxed iframe and hands the verdict back.

## What is checked

The exact text `wrapCombinedEntry` compiles as a function body, built
by `buildParseCheckSource` in `injector.ts`:

- every `@require` body, in declaration order;
- the script's own full source;
- the emitted `GM_*` bindings.

The bindings are included on purpose. They are `const` declarations in
the same scope as the user program, so a library doing
`const unsafeWindow = window.wrappedJSObject || window;` — a real idiom
— is a duplicate declaration and a genuine parse failure.

Not included: the wrap head and its `var` preamble. The head is ours
and always valid, and on its own it leaves an unbalanced brace. `var`
redeclaration is legal, so the preamble cannot collide.

## Why the composed program, not each file

Some failures only exist once the files are joined. Two libraries that
each declare `const shared` are individually valid and a `SyntaxError`
together. Checking files separately would call that script healthy.

## Failing open

Every failure of the machinery itself resolves to "don't know", never
to "didn't parse":

- no `chrome.offscreen`;
- the offscreen document won't open;
- the sandbox doesn't answer inside the timeout;
- no checker installed for this context (see below).

A working script must never be disabled because our plumbing broke. The
seal entry stays in place as the run-time backstop, so anything missed
here is still reported exactly as it was before.

## Where the checker is installed

`script-store.ts` does **not** import the injector — a real (not
type-only) module cycle between them is something this codebase avoids.
Instead the dependency is inverted: `setParseChecker` takes the
implementation, and `background.ts` installs it at startup.

Consequences:

- Extension *pages* that call `addSource` directly (the viewer's
  Install button) install no checker, so they skip the check.
- A skipped row carries no `parseCheckedHash`, so the next
  service-worker refresh performs it.

## Caching

Re-checking every script on every refresh would cost a round trip each.
`parseCheckedHash` on the stored row fingerprints the body's
`contentHash` plus each `@require`'s, so a refresh whose content didn't
move reuses the prior verdict. An `invalid` row deliberately records
nothing, so a later refresh re-derives the verdict rather than
inheriting a stale pass.

## Interaction with refresh policy

The check sets `status: 'invalid'`, and `rebuildSource`'s existing
soft-failure rule then applies on top:

- **http(s) source with a prior `ok` copy** — keep the prior copy
  running and record `refreshError`. A 200 that doesn't parse is
  usually a login or error page served in place of the script.
- **`file://` source** — flag immediately. That is a real local edit,
  and a developer wants to see it now.

## Limits

- **No line or column.** V8 reports neither for a `new Function`
  `SyntaxError` — not in the message, not in the stack. The message
  alone is what we surface.
- **No file attribution yet.** "The script's source has a syntax error"
  does not say whether it was a `@require` or the body.
- **Parse errors only.** A library that parses and throws when it runs
  is unaffected; running it is exactly what this must not do.

## Testing

- `tests/e2e/parse-check.spec.ts` — the mechanism, including
  compile-without-execute and function-body-not-program.
- `tests/e2e/parse-check-install.spec.ts` — what a user sees.
- `sm.setParseCheckEnabled(false)` turns the check off so a test can
  drive an unparsable script all the way to injection and exercise the
  run-time backstop.
