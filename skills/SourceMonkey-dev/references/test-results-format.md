# Test results format

The JSON that [testing-scripts.md](testing-scripts.md) produces, for a caller to
read or import.

```json
{
  "results": [
    {
      "name": "Wide YouTube",
      "version": "1.2.0",
      "manager": "sourcemonkey",
      "file": "/tmp/sm-test-scripts-x/001-wide-youtube/wide-youtube.user.js",
      "origin": "https://example.com/wide-youtube.user.js",
      "testedUrls": ["https://www.youtube.com/watch?v=abc"],
      "safety": {
        "verdict": "ok",
        "findings": ["Only touches the player's size; makes no requests"]
      },
      "status": "pass",
      "summary": "Player fills the window, and `w` toggles it",
      "note": "On a watch page the player fills the window (1393x983 at 0,0); `w` toggles it off and back. A `--noscript` tab stayed at 853x480.",
      "tags": []
    }
  ],
  "newTags": {},
  "managerGaps": []
}
```

## A result

| Field | Contents |
|-------|----------|
| `id` | The caller's ID for the script, when the brief gives one |
| `name` | From the script's header; `null` if it has none |
| `version` | From the script's header; `null` if it has none |
| `manager` | `sourcemonkey`, `tampermonkey` or `violentmonkey`. A script tested under multiple managers has one result for each |
| `file` | The copy tested |
| `origin` | Where the copy came from |
| `testedUrls` | The pages it was run on; empty if it wasn't run |
| `safety` | The safety check, or `null` for a [trusted](testing-scripts.md#whose-script-it-is) script |
| `safety.verdict` | `ok`, `questionable` or `unsafe`; see [safety](testing-scripts.md#2-read-it-and-assess-safety-if-untrusted) |
| `safety.findings` | See below |
| `status` | `pass`, `fail`, `inconclusive` or `n/a` |
| `blame` | Only with `fail`: the manager under test (`sourcemonkey`, `tampermonkey` or `violentmonkey`), `script`, `site-gone` or `unknown` |
| `reason` | Only with `n/a`: why, as one of the words below |
| `summary` | See below |
| `note` | See below. Needed unless the status is `pass` |
| `tags` | Tags for a reason that recurs across scripts; `[]` if the brief gives none to use |

The three text fields answer different questions:

- `safety.findings`: what the code does that's worth knowing, from reading it
  before any run, and what the read didn't cover. Nothing about how the test went.
- `summary`: the outcome, in one line, for the table of results.
- `note`: the evidence for the status: what was run, on which page, and what was
  observed. This is the text a caller records.

## `n/a` reasons

- `requires-login`: needs an account on the target site.
- `paid`: needs a paid subscription or purchase.
- `geo-blocked`: the site refuses our region.
- `bot-blocked`: a bot check stopped the test browser, visible ones too.
- `unsafe`: not run, because the safety verdict was `unsafe`.
- `game`: a game cheat, bot or tool, which can't be judged without playing and
  might get an account banned.
- `needs-interaction`: only does something after a manual flow you can't script.
- `not-web`: targets local files, browser pages, or no real site.
- `other-browser`: relies on another browser's features.
- `other`: anything else; the note explains.

## Notes

Markdown, short, factual. Say the page, the action, and what was observed, with
numbers where there are any. No em-dashes.

- Use bullets for separate facts, prefixed "SourceMonkey:", "Script:" or
  "sm-dev:" where it helps.
- When the script wasn't run, start with "Not run:" and say why.
- `inconclusive`: say what was missing.
- A script you ran that turned out to send private data keeps its result. Say
  what it sends.

## The rest of the file

- `newTags`: `{ "name": "One-sentence description" }` for tags you made up, in
  short kebab-case, when the brief lets you.
- `managerGaps`: an array of strings, one per problem found in the manager under
  test. Each is Markdown like a note, naming the manager and giving the evidence.
