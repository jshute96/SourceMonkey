# SourceMonkey development friction log

This records problems hit while developing userscripts with SourceMonkey (SM)
tools (`sm-dev`, the Playwright harness, the `SourceMonkey-dev` skill, the
script manager (the SourceMonkey extension itself), used as input for
improving them. Add new entries at the end, with a `---` line before each.

Use the `SourceMonkey-friction` skill (shipped with SourceMonkey, in
`skills/SourceMonkey-friction/`) to update this log. It says when to
log, and what each entry should cover.

Tag each friction item with one or more of:

- `[tools]`: sm-dev, the harness, the skill, or the script manager.
- `[general]`: general issues making scripts work, which could come up on many sites.
- `[site-specific]`: this site or this script.
- `[unknown]`: not sure which.

Template:

```markdown
## YYYY-MM-DD: <short topic>

**Repo:** `<repo>`
**Scripts:** `<paths of scripts and libraries worked on>`

**Task:** <what we were trying to do>

### Friction
1. [tag] **<short summary>.** <what happened, and what it cost>.
   Ideas: <a concrete fix, if there is one>

### Missing tools that would have made this faster
- [tag] <tool or feature>

### What worked well
- <what helped, and whether the skill or --help already had the answer>

**Logs:**
- <what the run was>: `<sm-dev log path>`
```

A later finding about an entry goes at its end, under its own heading:

```markdown
### Update YYYY-MM-DD
- <what was learned>
```
