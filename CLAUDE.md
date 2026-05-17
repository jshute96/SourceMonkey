# CLAUDE.md

This file provides guidance to agents when working with code in this
repository. See `README.md` for setup instructions and available commands.

## Workflow Rules

- **Documentation**:
  - Keep `docs/*.md` design documents in sync with behavioral changes.
  - Update `docs/file-index.md` when adding, renaming, or removing source files, or when their description should change. The index is a navigation aid meant to describe what the files are now.
  - **`docs/file-index.md` is a one-line-per-file index, NOT a place for design summaries.** Each row gets a single short sentence (≈ 80–120 chars). If you find yourself wanting to explain *how* a file works, that belongs in `architecture.md` or other docs, not the index.
  - **`docs/architecture.md`** is a high-level overview of the system and components, not details on all the parts. Make separate docs about specific components where there are details worth describing.
  - **No prose blobs in design docs.** Hard rule: any block of text longer than ~4 lines must be broken up into bullets, sub-sections, or smaller paragraphs. Reviewers should be able to scan the page without reading any single chunk top-to-bottom.
    - If a single concept needs multiple sentences, split it across bullets.
    - If a doc section grows past ~8 lines, give it sub-headings.
    - Prefer bullets to paragraphs; prefer short bullets to long bullets.
  - When adding a new feature, you can add new sections in the relevant design doc rather than appending to an existing one.
  - **Avoid stating counts of list elements in comments or docs.** If there are more than 2-3 items, don't say the count before listing them. That requires unnecessary edits when the list changes.
- **Commit Preparation**:
  - Ensure `README.md` is updated if setup, commands, or user-visible features change.
    - `README.md` is user-facing documentation. Keep it concise and focus on briefly listing what users can do, without a lot of technical details.
  - Always update `docs/file-index.md` when the file set changes or file descriptions become stale.
  - Include all significant changes in the commit message.

## Development Conventions

### Code Logic
- **Documentation**: Where code has subtle or surprising logic, add comments to explain the "why" and intended behavior.

## Planning vs Implementation
When the user asks you to implement something, start coding quickly. Do NOT
spend the entire session planning unless explicitly asked for a plan. If a plan
is needed, keep it concise (bullet points, not paragraphs) and confirm with the
user before elaborating further. Default to action over planning.

## Git & Commits
- Do not commit or push changes without getting user instructions to do so.
- When committing, include ALL relevant changed files — check `git status` before committing to avoid missing files like TODO.md, documentation, or new files.

## Reference material
- **Tampermonkey/userscript details**: the `tampermonkey` plugin skill
  ships a reference library covering header tags, URL matching, `GM_*`
  APIs, sandbox modes, browser quirks, and more. Invoke it via
  `/tampermonkey:tampermonkey` (or load the on-disk files under
  `~/.claude/plugins/cache/wookstar-claude-plugins/tampermonkey/<ver>/skills/tampermonkey/references/`)
  when implementing anything that touches userscript semantics.

## Code Changes
- Use the file index to help find relevant files.
- When changing behavior, read existing design docs to understand previous designs and intentions. Ask questions if unsure if we should change those requirements.
- When the user asks for a change, apply it consistently to ALL similar patterns.
- Do NOT drop or overwrite existing content in files like README.md — preserve what's there and add to it.
- When similar logic occurs on multiple parallel paths, use common helper methods when possible, to ensure the logic stays consistent.

## Running tests
- To run tests from a single file:
  - Unit: `node --test tests/unit/<file>.test.mjs`
  - E2E: `npx playwright test tests/e2e/<file>.spec.ts`
- When you do need a full run, start it with Bash `run_in_background: true` so it doesn't block the turn.
