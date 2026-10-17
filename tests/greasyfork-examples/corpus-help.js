// What the corpus's test statuses, their details (n/a reasons and fail
// blames) and built-in tags mean, one sentence each: the tooltips in
// results.html and show-on-GreasyFork.user.js. Reasons and blames mirror
// REASONS and BLAMES in record-results.mjs. The built-in tags are the ones
// `record-results.mjs validate` derives; hand-added tags are defined in
// corpus.json instead (`record-results.mjs tag add`). A `prefix:*` tag entry
// describes all tags `prefix:<name>` (the validator's
// `unsupported-grant:GM_cookie`, say), with `{name}` replaced by the name.
//
// A script file rather than JSON so results.html can load it opened from
// disk too. Keep the object strict JSON (double quotes, no trailing comma,
// no comments inside it): the userscript reads it with JSON.parse.
var CORPUS_HELP = {
  "test": {
    "untested": "Not tried on its target site yet.",
    "pass": "Tried on its target site, and it did what it says.",
    "fail": "Tried on its target site, and it did not work.",
    "inconclusive": "Run on its target site, but what it acts on never showed up, so there was no verdict. The notes say why.",
    "n/a": "Not tried meaningfully, by choice or because it couldn't be."
  },
  "detail": {
    "requires-login": "Needs an account on the target site.",
    "paid": "Needs a paid subscription or purchase.",
    "geo-blocked": "The site refuses our region.",
    "bot-blocked": "A bot check (a captcha, Cloudflare or a firewall) stopped the test browser, visible ones too.",
    "unsafe": "Not run on purpose: from its description or code it harvests credentials or private data, spams, or drives accounts or money.",
    "site-gone": "The target site no longer exists or answers.",
    "needs-interaction": "Only does something after a manual flow we can't script.",
    "not-web": "Targets local files, browser pages, or no real site.",
    "other-browser": "Relies on a non-Chrome browser's features (Firefox-only APIs, old Opera).",
    "game": "A game cheat, bot or tool. It can't be judged without playing, and using it might get an account banned.",
    "other": "Another reason. The notes explain.",
    "sourcemonkey": "SourceMonkey's fault: a missing feature or a bug.",
    "script": "The script's fault: broken, or out of date against the current site.",
    "unknown": "Not yet known whose fault it is."
  },
  "tag": {
    "unsupported-grant:*": "Grants {name}, which SourceMonkey doesn't provide, so it is undefined at runtime. (Validation warning)",
    "ignored-header:*": "Uses {name}, which another manager acts on and SourceMonkey ignores. (Validation warning)",
    "malformed-grant": "A @grant line that isn't an API name (some scripts use them as comments). (Validation warning)",
    "ignored-match": "A @match Chrome would refuse, which SourceMonkey drops. (Validation warning)",
    "unsupported-run-at": "A @run-at value SourceMonkey doesn't support, so the script runs at document-idle instead. (Validation warning)",
    "icon-dead-link": "Its @icon didn't download (an HTTP error or no response, say), so @icon is ignored. (Validation warning)",
    "icon-too-large": "Its @icon is over SourceMonkey's icon size limit, so @icon is ignored. (Validation warning)",
    "invalid:require-dead-link": "Invalid: a @require that won't load (an HTTP error, no response, a timeout, an empty file, or an HTML page instead of JavaScript). (Validation error)",
    "invalid:resource-dead-link": "Invalid: a @resource that won't load (an HTTP error, no response, a timeout or an empty file). (Validation error)",
    "invalid:require-other": "Invalid: a @require rejected for another reason. The validation error says which. (Validation error)",
    "invalid:resource-other": "Invalid: a @resource rejected for another reason. The validation error says which. (Validation error)",
    "invalid:resource-data-url": "Invalid: a @resource given as a data: URL, which SourceMonkey doesn't support. (Validation error)",
    "invalid:other": "Invalid for a reason the validator doesn't classify. The validation error says which. (Validation error)",
    "invalid:require-too-large": "Invalid: a @require over SourceMonkey's per-file size limit. (Validation error)",
    "invalid:resource-too-large": "Invalid: a @resource over SourceMonkey's per-file size limit. (Validation error)",
    "invalid:require-data-url": "Invalid: a @require given as a data: URL, which SourceMonkey doesn't support. (Validation error)",
    "invalid:bad-match": "Invalid: no @match is usable, so it would never run. (Validation error)",
    "invalid:user-style": "Invalid: a user style (/* ==UserStyle== */ CSS), not a userscript. (Validation error)",
    "invalid:no-metadata-block": "Invalid: no // ==UserScript== metadata block. (Validation error)",
    "invalid:unterminated-metadata-block": "Invalid: the metadata block is never closed. (Validation error)",
    "invalid:no-name": "Invalid: no @name. (Validation error)",
    "invalid:no-match": "Invalid: no @match or @include. (Validation error)",
    "invalid:syntax-error": "Invalid: the script doesn't parse. (Validation error)"
  }
};
