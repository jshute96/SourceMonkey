# Industry Research

Survey of existing tools in the userscript / browser-automation space,
with an eye toward where VibeMonkey fits and what "AI-assisted
userscript authoring" looks like in the wild.

This doc is a living list. Add entries as we find them; trim or
correct claims as we verify them.

## Well-known userscript managers

These are the established managers a typical user is choosing between
today. They are *runtime* tools — they install, store, and execute
userscripts — and don't try to help you *write* the scripts.

### Tampermonkey

- <https://www.tampermonkey.net/>
- Closed-source (free for personal use); the de-facto default on
  Chrome, Edge, Opera, Safari, and Firefox.
- Rich `GM_*` API surface, cross-origin `GM_xmlhttpRequest`, cloud
  sync, `@resource` / `@require` caching, value storage UI.
- Built-in editor with syntax highlighting; no AI assistance.
- Reference behavior for most `@grant` / `@inject-into` semantics
  other managers (including VibeMonkey) try to match.

### Violentmonkey

- <https://violentmonkey.github.io/>
- Open source (MIT). Firefox, Edge (their site notes Violentmonkey
  is "no longer supported on Chrome" and recommends Brave).
- Similar feature set to Tampermonkey: full `GM_*` API, value
  storage, `@require` / `@resource`, editor with linting.
- Originated the `@inject-into` header (`page` / `content` / `auto`)
  that Tampermonkey and VibeMonkey both honor.

### Greasemonkey

- <https://www.greasespot.net/> (Greasespot — the project blog)
- The original (2004, Firefox). Open source. Latest release 4.13
  (August 2024).
- Modern versions (4.x+) dropped most synchronous `GM_*` APIs in favor
  of async `GM.*` equivalents, breaking compatibility with many older
  scripts — much of the community moved to Violentmonkey as a result.
- Firefox-only today.

### Userscripts (Safari)

- <https://github.com/quoid/userscripts>
- Open source (GPL-3.0) Safari extension by quoid. The standard
  option on macOS / iOS Safari, where Tampermonkey is paid.
- Stores scripts as files in a user-chosen folder — closest spiritual
  cousin to VibeMonkey's "load from a local directory" model.
- No AI features.

### ScriptCat

- <https://scriptcat.org/> · [GitHub org](https://github.com/scriptscat)
- Open source, Chinese-developed. Chrome / Edge / Firefox.
- "Based on Tampermonkey's design philosophy, fully compatible with
  Tampermonkey scripts." Adds *background script execution* and
  cron-style scheduled scripts that run independent of any page.
- No AI features.

### FireMonkey

- [AMO listing](https://addons.mozilla.org/en-US/firefox/addon/firemonkey/) · [source](https://github.com/erosman/firemonkey)
- Firefox-only, open source (MPL-2.0). Manages both userscripts and
  userstyles in one extension. "Super Lightweight User Script and
  Style Manager." Smaller user base than Violentmonkey / Tampermonkey.

## AI-assisted / "vibe-coding" tools

Tools that try to help the user *write* page modifications (or other
browser-side code) rather than just run hand-written scripts. This is
the space VibeMonkey is trying to live in.

Organized roughly by how close the output sits to a userscript.

### AI userscript generators (closest analog to VibeMonkey)

These produce userscript-shaped output and run it persistently on
matching pages — same broad shape as VibeMonkey, differing mostly in
*where the AI runs* and *where the script lives*.

#### Tweeks

- <https://www.tweeks.io/> · [Chrome Web Store](https://chromewebstore.google.com/detail/Tweeks%20-%20Customize%20Any%20Website/fmkancpjcacjodknfjcpmgkccbhedkhc) (10k+ users, 5.0/20) · [Launch HN (YC W25)](https://news.ycombinator.com/item?id=45916525)
- **What it is:** Plain-English → "sandboxed userscript." 4,000+
  community library; per-site toggles; source visible/editable.
- **Distribution:** Extension for Chrome, Edge, Brave, Firefox, Opera,
  Vivaldi, Arc (in practice Chrome-only today; Firefox MV3 still WIP).
- **AI loop:** "the page structure is captured, an AI agent reviews
  the structure, plans changes, and returns deterministic
  transformations." Page screenshot + DOM sent to a cloud LLM on each
  generation; founders say local models "aren't there yet." Specific
  model not disclosed.
- **vs VibeMonkey:** Output shape is the same (sandboxed userscript).
  Tweeks is cloud-hosted end-user product; scripts live in extension
  storage / community library, not on the user's disk under their own
  editor.

#### Improv (`pirate/improv`)

- <https://github.com/pirate/improv> · also on Chrome Web Store
- **What it is:** "lets you 'vibemonkey' live-edit sites with AI and
  persist your changes, automatically fixing them if they break."
- **AI loop:** Side panel. AI sees screenshot + HTML + console logs;
  executes test JS, iterates on results, user approves, script is
  saved. Calls OpenAI's API with the user's own key.
- **Persistence:** Userscripts kept in `chrome.storage.local`
  (name + regex URL + JS + metadata), auto-run on match.
- **Stack:** TypeScript / React / Bun / Tailwind / MV3.
- **vs VibeMonkey:** Same userscript-output shape; AI loop is
  integrated into the extension instead of farmed out to an external
  editor. No local-disk story.

#### Browser Code (`chebykinn/browser-code`)

- <https://github.com/chebykinn/browser-code> · write-up: <https://dev.to/tumf/browser-code-teaching-ai-to-grow-userscripts-3npj>
- **What it is:** Extension that treats the DOM as a "virtual file
  system" and lets Claude write userscripts + CSS that auto-execute on
  matching URLs via `chrome.userScripts`.
- **AI loop:** Two-mode Plan/Execute workflow — "AI explores the page
  and writes change proposals in `plan.md`" with DOM edits disabled
  until user approval; Execute mode unlocks file/DOM/script writes.
  Context: live DOM, console output, screenshots, URL patterns.
- **vs VibeMonkey:** Same output channel (`chrome.userScripts`).
  Notable for the explicit plan-then-execute gating; VibeMonkey
  currently has no equivalent safety/preview step.

#### Shaper

- <https://getshaper.app> · [Chrome Web Store](https://chromewebstore.google.com/detail/Shaper:%20Vibe%20code%20website%20mods%20%26%20extensions/cfchhckkobkelfckakndahnlnnjmjngn) (205 users, 5.0/4)
- **What it is:** AI sidebar that produces three output kinds:
  in-place DOM patches, exportable standalone Chrome extensions
  ("one-click export"), or imported Tampermonkey/Greasemonkey
  userscripts.
- **AI loop:** Free tier offers ChatGPT-5 Mini/Nano and Qwen3 Coder
  (10/day, 310/month); BYO key for unlimited.
- **vs VibeMonkey:** Notable as a single tool spanning patch /
  extension / userscript. VibeMonkey is userscript-only.

#### dorser/vibemonkey

- <https://github.com/dorser/vibemonkey> (name collision with this
  project — predates ours)
- **What it is:** "Chrome extension that acts as your AI companion
  for generating userscripts on the fly." Output is a `.user.js`
  file the user copies/downloads into their existing userscript
  manager.
- **AI loop:** Gemini (user-selectable model). Describes visual
  changes via side panel.
- **vs VibeMonkey:** Generation-only; doesn't run scripts itself.
  Pairs naturally with a manager like ours.

#### Page Magic (`khaledh/pagemagic`)

- <https://github.com/khaledh/pagemagic>
- **What it is:** Chrome extension that uses Anthropic models (BYO
  key) to generate CSS-only modifications for the active page.
- **Edit shape:** Additive CSS patches; enable / disable / delete
  individual mods. Doesn't appear to produce JS or a userscript per
  se.
- **vs VibeMonkey:** Narrower scope (CSS-only) and per-page rather
  than per-pattern script registration.

#### Modify (AI-Powered Website Modifier)

- [Chrome Web Store](https://chromewebstore.google.com/detail/modify-ai-powered-website/lcibepmpgbipfdmccaeoihgbfkcinelm) (32 users, 5.0/2) · homepage referenced in privacy policy: <https://www.modifybrowser.com/>
- **What it is:** "Customize any website with AI. Remove ads, change
  colors, transform elements — just describe it." Generated JS is
  saved per-modification and viewable/editable.
- **AI loop:** BYO OpenRouter key; specific model not named (any
  OpenRouter-supported model presumably).
- **Persistence:** Edits scoped via "Current website only, Entire
  domain, All websites, Custom URL patterns, Website groups" and
  auto-reapply on revisit; toggle on/off.
- **vs VibeMonkey:** Similar shape to Improv — saved JS reapplies on
  matching URLs. OpenRouter routing is a nice middle ground between
  hard-coded provider (Improv = OpenAI, Page Magic = Anthropic) and
  multi-model sidebar (Shaper).

#### ScriptGenie AI

- <https://scriptgenieai.github.io/> · GitHub: `scriptgenieai/scriptgenie`
- **What it is:** Chrome extension that generates Tampermonkey-
  compatible scripts from natural-language descriptions; ships with
  an embedded Monaco editor.
- **AI loop:** BYO key. Supports OpenAI, Claude, DeepSeek.
- **Output:** "Fully compatible with Tampermonkey URL matching rules,
  automatically executes related scripts." Docs are primarily in
  Chinese.
- **vs VibeMonkey:** Same shape — generate + auto-run on URL match.
  Includes the Monaco editor inside the extension; VibeMonkey punts
  editing to the user's external editor.

#### Robomonkey

- <https://robomonkey.io/>
- **What it is:** "Build Browser Extensions by chatting with AI."
  Pitch: "a single prompt to a working Chrome extension … in under
  two minutes." Has a community extensions registry (WhatsApp
  Message Scheduler Pro, Price Tracker Pro, …).
- **Output:** Full Chrome extensions rather than userscripts —
  closer to Shaper's "export as extension" mode than to a userscript
  manager. Model and exact distribution (hosted vs side-loaded vs
  Web Store) not disclosed on the landing page.
- **vs VibeMonkey:** Different artifact (extension, not userscript);
  heavier per-mod overhead but more capable surface.

### AI agentic browsers and tab-app generators

Adjacent: AI that generates *page-replacing* artifacts rather than
patching existing sites.

#### Nebula (`kanpuriyanawab/nebula`)

- <https://github.com/kanpuriyanawab/nebula>
- "Modern, open source, agentic browser built with Electron." `/agent
  <prompt>` generates a self-contained HTML mini-app that loads as a
  tab. OpenAI-backed (key in `.env`). Early-stage (17 stars).
- **vs VibeMonkey:** Different surface — generates whole apps, not
  patches over real sites.

#### Disco (Google Labs)

- <https://labs.google/disco> — experimental; waitlisted.
- **GenTabs:** "turn the tabs you have open into custom, interactive
  apps." AI-Enabled Pointer for select-and-ask interactions.
- **vs VibeMonkey:** Not userscript-shaped; closer to a Reader/Arc
  Max-style overlay layer.

### Dev-targeted visual-to-code editors

These edit *your own* app's source code, not arbitrary third-party
sites — included here because they're often pitched in the same
"vibe-coding the web" sentence.

#### Cursor browser visual editor

- <https://cursor.com/blog/browser-visual-editor>
- Visual editor inside the Cursor Browser: drag/drop DOM, inspect
  React props, point-and-prompt. Multiple agents run in parallel and
  write *back into source*. Audience is product builders editing
  their own codebase.
- **vs VibeMonkey:** Inverted audience — you own the source, so the
  agent edits the repo. VibeMonkey targets third-party sites where
  source isn't yours, so a userscript is the only place edits can
  land.

#### Layrr (`narnia-sh/layrr`)

- <https://github.com/thetronjohnson/layrr> (redirects to
  narnia-sh/layrr)
- npm-installable CLI that injects an overlay; user clicks an element
  and prompts in plain English; instructions plus element-to-source
  mapping go to Claude Code / Codex CLI / Gemini-via-Pi. Edits land
  in source files; git is the undo mechanism (auto-commits with a
  `[layrr]` prefix).
- **vs VibeMonkey:** Same "edits flow back to the user's own repo"
  pattern as Cursor's editor — not a userscript story.

### Manual / non-AI visual editors (baseline)

For comparison — these set the UX bar for "click and tweak the page"
without involving an LLM.

#### Arc Boosts

- <https://resources.arc.net/hc/en-us/articles/19212718608151-Boosts-Customize-Any-Website>
  (link returned 403 to our fetch; summary from prior knowledge)
- Per-site CSS/JS overrides shippable as shareable "Boosts." Browser
  Company has shipped AI-generated Boost experiments separately;
  baseline Boosts are hand-authored.
- **vs VibeMonkey:** Closest browser-native analog to a userscript
  manager, but tied to the Arc browser specifically.

#### Edit (`goedit.me`)

- <https://goedit.me/>
- Click the icon, page becomes editable in place ("Shift⌘U"); drag-
  drop image replacement. **Changes are local-only and revert on
  refresh** — explicitly *not* persistent and explicitly not AI.
- **vs VibeMonkey:** Useful as a baseline for the manual-edit UX
  Tweeks/Shaper try to replace with prompts.

#### AI Website Editor (Krish Chauhan)

- [Chrome Web Store](https://chromewebstore.google.com/detail/ai-website-editor/ajlgmdlaokipinhkcbodapinmfmhomof) (30 users)
- Despite the name, the description is a manual visual styler
  (Alt-click an element, tweak fonts/colors/spacing). Edits are
  session-only. No AI flow described.
- Listed here because the name keeps surfacing in this search space.

### Manual vibe-coding baseline

The simplest "AI userscript" workflow is no tool at all: ask
ChatGPT/Claude/Gemini for a userscript, paste the output into
Tampermonkey/Violentmonkey, iterate by pasting screenshots and error
messages back. This is widely used in the wild — e.g. [this Threads
post](https://www.threads.com/@hasanahmad/post/DOABIWFESby) showing a
GPT-5-Thinking-authored Tampermonkey script that surfaces Steam
review scores anywhere a game is mentioned.

- **vs VibeMonkey:** This is the workflow VibeMonkey is *built for*.
  The local-directory model means the user's existing AI editor
  (Claude Code, Cursor, …) writes `*.user.js` files and VibeMonkey
  picks them up — no copy-paste round trip, no rebuild, no separate
  sidebar to integrate with the LLM.

### Userscript distribution / discovery (non-AI)

- **[Greasy Fork](https://greasyfork.org/)** — by Jason Barnabe; the
  dominant open-source userscript host. Not AI-related, but where
  most hand-written scripts (and many AI-generated ones) end up
  being shared.
- **[OpenUserJS](https://openuserjs.org/)** — smaller alternative,
  same idea.

## Where VibeMonkey sits

VibeMonkey is one piece of a multi-tool authoring loop, not a
self-contained "describe → done" product. The full loop:

1. **Author with Claude Code in a userscripts directory** (e.g.
   `~/dev/userscripts/sites/<domain>/foo.user.js` + sibling `foo.md`
   doc + `foo.spec.js` Playwright regression test). Claude has the
   full repo context, a `tampermonkey` reference skill, and
   project-specific conventions in `CLAUDE.md`.
2. **Capture page context with [SeeWhatISee](https://github.com/jshute96/SeeWhatISee)**
   (Chrome extension) to send screenshots / HTML snapshots / text
   selections / a prompt back to the Claude CLI session — the
   feedback channel from the live browser to the model.
3. **Regression-test with Playwright** over CDP against a
   long-running Chromium with a persistent profile (so test sessions
   stay logged in).
4. **Run with VibeMonkey** — the extension watches the directory and
   loads everything matching `*.user.js`, so the next browser reload
   picks up the latest edit. No cut-and-paste into a manager UI.

The runtime model is the same as Tampermonkey / Violentmonkey /
ScriptCat: `chrome.userScripts`, parsed `@grant` / `@match` /
`@inject-into` semantics, per-site enable. The differentiator is
*how scripts get into the manager*.

**Why not just stay on Tampermonkey?** The author flow already worked
with Tampermonkey via an "install pointer to local file" trick — but
every header change (`@match`, `@grant`, `@version`) still required a
reinstall through Tampermonkey's UI. VibeMonkey exists to smooth out
that last cut-and-paste / reinstall step so the iteration loop
becomes: *edit file → reload tab*.

### Closest analogs in this space

- **Userscripts (Safari)** — same on-disk file model. The Safari-
  only constraint pushed us to build a Chrome equivalent.
- **`dorser/vibemonkey`** — closest in *spirit* ("AI writes,
  separate manager runs") but the split is asymmetric: dorser's tool
  is a generation sidebar that hands you a `.user.js`, then you take
  it to your own manager. Ours is the inverse: your own editor is
  the generation surface, and the manager is the thing we ship.
- Vs **Tweeks / Improv / Browser Code / Shaper / Modify /
  ScriptGenie** — those bundle an AI sidebar *into* the manager.
  They're easier for a non-developer to pick up. VibeMonkey trades
  that ease for letting the user bring an arbitrarily good AI
  editor: full repo context, regression tests, version control,
  skill files, multi-step refactors across many scripts — none of
  which fit comfortably inside an extension sidebar.

