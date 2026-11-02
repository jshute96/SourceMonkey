# User-configurable settings

Use this when the person wants a value in a userscript to be
**user-configurable at runtime** instead of a hardcoded constant.
The typical shape:

- One scalar value (string / number / JSON blob) per setting.
- Lives in GM storage so it survives reloads.
- Editable from the userscript "context menu" (the dropdown on the
  extension icon while on the script's pages).
- Optionally inferred from the current page's state instead of typed by
  hand.

Worked examples, simplest first:

- [`config-value.user.js`](https://github.com/jshute96/userscripts/blob/main/sites/example.com/config-value.user.js): minimal single-scalar
  case. One string setting with an unset sentinel, italic *unset*
  rendering, conditional Clear menu item, and a validation loop that
  re-prompts with the rejected input prepopulated. Read this first
  when adding a setting.
- [`classes-default-filters.user.js`](https://github.com/jshute96/userscripts/blob/main/sites/members.onepeloton.com/classes-default-filters.user.js):
  multi-key case. Stores a *map* of settings (per-class-type filters)
  and infers each entry from the page's current URL query string,
  rather than prompting. The single-setting case here is the simpler
  core of the same pattern.

## Questions to ask before writing

If any of the following isn't already obvious from the request or the
existing code, ask the person. Don't ask about ones you can already answer.

1. **Default value.** What value should the script use when nothing has
   been saved yet? "None / treat-as-unset" is a valid answer; in that
   case the script needs an explicit code path for the unset state.
2. **Validity constraints.** What counts as a valid value? (e.g.
   non-empty, must parse as a positive integer, must match a regex, must
   be one of an enum.) These are checked at *save* time, after the person
   types a value, not at read time.
   - Alternatively: Is the setting a mode (radio buttons), checkboxes,
     or something else other than a text box?
3. **First-run prompt.** On the first page load when no value is
   stored, should the script open the dialog immediately, or stay quiet
   until the person picks the menu item? Quiet-by-default is usually right
   unless the script genuinely can't do anything useful without the
   value.
4. **Menu label and dialog prompt text.** What should the menu item say,
   and what should the dialog ask? Defaults below.
5. **Dialog vs. infer-from-page.** Is the value something the person
   types, or something the script can read off the current page's state
   (URL query params, a form field, a toggle position, …)?
6. **Clear-value menu item.** Do you want a second menu item that
   deletes the saved value (reverting to the built-in default)?

## Default UI guidance

### Menu items

- **Set / change value**: `Set <option name>`
- **Clear value**: `Clear <option name>`
  Only register this one when a value is actually saved.
  (Don't show "Clear" when there's nothing to clear; it confuses people.)

### Dialog box

Use `window.prompt()` for typing-style input. It's synchronous, has a
text field with OK/Cancel, returns `null` on Cancel and the entered
string on OK. Limitations to design around:

- **No custom title.** Most browsers show the page URL or "The page at
  X says:"; you can't change it. Compensate by making the prompt
  message itself self-describing: include the script name and what the
  value means. Recommended message format:

      <Script name>: set <option name>
      <one-line explanation of what the value does, if not obvious>

  Example:

      Peloton filters: set default difficulty
      Comma-separated list, e.g. "intermediate,advanced"

- **Prepopulate with the existing value, or the built-in default.**
  `prompt(message, defaultText)`'s second argument is the initial text
  in the field. Pass the current saved value (stringified) if there is
  one, otherwise the built-in default. This makes "I just want to tweak
  it" a one-character edit instead of retyping the whole thing.

- **Validation and error reporting.** Run validation on the returned
  string. On failure, show a follow-up `alert()` describing what was
  wrong, then re-open the prompt with the person's (rejected) input as
  the prepopulated text so they can edit it instead of retyping. Loop
  until the person either enters a valid value or cancels. Don't save
  invalid values to storage.

- **Real dialog boxes.** If the option is something other than a text field,
  or there are multiple options to set, consider making a custom dialog
  box with HTML rather than just using a prompt.

## Headers

Scripts may require these options, and use these APIs.

```js
// ==UserScript==
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_deleteValue
// @grant GM_registerMenuCommand
// @grant GM_unregisterMenuCommand
// ==/UserScript==
```

## Documenting it

When the script has a doc, its implementation notes should call out:

- The storage key(s) used.
- The shape of the stored value (scalar / object / list).
- Built-in default(s).
- Validation rules.
- Which menu items exist and what they do.
