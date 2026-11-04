# Bad userscript examples

Deliberately broken userscripts (bad headers, syntax errors, failing
`@require`s), plus a few that only warn.

- SourceMonkey's tests check the outcome reported for each:
  `tests/e2e/bad-scripts.spec.ts` in the browser, and
  `tests/unit/harness/validate.test.mjs` for `sm-dev validate`. The
  expected outcomes are in `tests/fixtures/bad-script-cases.mjs`.
- A line marked `>>> the error` in a file is where its error should be
  reported.
- They're kept outside `examples/` so loading the examples doesn't load
  them. Add this directory as its own SourceMonkey collection to try
  them.
- Scripts whose header can't be read have no description, and one with
  no `@name` shows as its filename.

## Scripts

Generated from this directory's `script_manifest.json` (see
[Updating the tables](../README.md#updating-the-tables)).

<!-- update_readme.py category=default -->
| Script | Description |
| --- | --- |
| [Blank Lines](blank-lines.user.js) | Blank lines and bare // lines inside the metadata block, which are ignored |
| [empty-header.user.js](empty-header.user.js) |  |
| [empty.user.js](empty.user.js) |  |
| [Invalid Header Fields](invalid-header-fields.user.js) | Unknown and oddly named @tags, which don't make the script invalid |
| [Invalid Match](invalid-match.user.js) | A @match Chrome refuses, which is dropped while the script runs on its other @match |
| [Leading Text](leading-text.user.js) | Code and comments above the metadata block, which is still found |
| [Malformed Field](malformed-field.user.js) | A @match written with = instead of a space, so the script has no @match and is invalid |
| [Missing Require](missing-require.user.js) | A @require of a file that doesn't exist, so the script is invalid |
| [no-header.user.js](no-header.user.js) |  |
| [Require Collision](require-collision.user.js) | Two @require libraries that each parse alone but declare the same const, so the joined script is invalid |
| [Stray Closing Brace](stray-brace.user.js) | A stray closing brace with code after it, located by the syntax check |
| [Stray Closing Brace At End](stray-brace-at-end.user.js) | A stray closing brace as the last thing in the file, located by the syntax check |
| [Syntax Error In Body](syntax-error-body.user.js) | A syntax error in the script body, reported at the line an editor shows |
| [Syntax Error In Require](syntax-error-require.user.js) | A syntax error in a @require library, reported in the library rather than the script |
| [Throwing Require](throwing-require.user.js) | A @require library that throws when it runs; the script installs fine and fails at run time |
| [Two Headers (first)](two-headers.user.js) | Two metadata blocks; the first is used and the second is treated as code |
| [Unclosed Header](unclosed-header.user.js) |  |
| [Unknown Grant](unknown-grant.user.js) | @grant of APIs that don't exist, which are dropped with a warning |
| [Unparsable Require](unparsable-require.user.js) | A @require library with an unterminated comment, so the script is invalid |
| [Unusable Match](unusable-match.user.js) | Its only @match is one Chrome refuses, so it could never run and is invalid |

