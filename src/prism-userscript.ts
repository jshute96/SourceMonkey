// Prism grammar extension for the `// ==UserScript== … //
// ==/UserScript==` metadata block.
//
// Importing this module is what installs the grammar — it runs the
// `insertBefore` at load. It lives next to the code that depends on it
// (`code-tabs.ts` calls `Prism.highlightElement`, `code-links.ts` keys
// its header linkification off the token classes below), so a page
// that reuses the tabbed code view can't end up with the extension
// silently missing.
//
// The outer token keeps the `comment` alias so any non-tag line inside
// the block still reads as comment-grey. Inner tokens use existing
// Prism theme classes via `alias`:
//   - markers (`==UserScript==`, `==/UserScript==`, sans `//`) → `bold`
//   - `@tag` names → `constant` (matches identifier color in the body)
//   - values after the tag → `string` (matches string-literal color)
// Order inside matters: `header-tag-value` must run before
// `header-tag-name`, because the value's lookbehind needs the `@tag`
// substring to still be present in the unconsumed text when it scans.

declare const Prism: {
  languages: {
    insertBefore(lang: string, before: string, grammar: Record<string, unknown>): void;
  };
};

Prism.languages.insertBefore('javascript', 'comment', {
  'userscript-header': {
    // Trailing `[ \t]*\r?\n?` swallows whitespace + the line-terminating
    // newline after `==/UserScript==` (CRLF and LF). We need the
    // newline inside the span because we render the span as
    // `display: block` for the tinted band, and a newline left in
    // the text node *after* the block would render as an extra blank
    // line on top of the block break the browser already inserts.
    pattern: /\/\/[ \t]*==UserScript==[\s\S]*?\/\/[ \t]*==\/UserScript==[ \t]*\r?\n?/,
    alias: 'comment',
    inside: {
      'header-marker': {
        pattern: /(\/\/[ \t]*)==\/?UserScript==/,
        lookbehind: true,
        alias: 'bold',
      },
      'header-tag-value': {
        // `[^\r\n]*` (not `[^\n]*`) so a CRLF file doesn't sweep the
        // line-terminating `\r` into the value span, which would
        // leak a trailing `\r` into anchor hrefs / `matchTargetInfo`
        // input downstream.
        pattern: /(\/\/[ \t]*@[A-Za-z][\w-]*(?::[\w-]+)?[ \t]+)\S[^\r\n]*/,
        lookbehind: true,
        alias: 'string',
      },
      'header-tag-name': {
        pattern: /(\/\/[ \t]*)@[A-Za-z][\w-]*(?::[\w-]+)?/,
        lookbehind: true,
        alias: 'constant',
      },
    },
  },
});
