/* VibeMonkey injected wrapper — matcher fragment. Inserted into the
   head at registration time for any script that uses /regex/ @include
   or @exclude patterns (which the User Scripts API can't express).

   Implements the same algorithm as urlMatchesScript() in url-match.ts.
   Keep them in sync — a unit test eval's this snippet to verify.

   Placeholder: "__VM_MATCHING__" — JSON-encoded {matches, includes,
   excludes} object. After substitution the literal becomes a JS object
   expression.

   This fragment is concatenated INSIDE the IIFE from wrapper-head.js,
   so the `return` statement bails out of the wrapper (not the page). */
var __vmEscRx = function (s) { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); };
var __vmGlobRx = function (g) { return new RegExp("^" + __vmEscRx(g).replace(/\*/g, ".*") + "$"); };
var __vmIncludeMatch = function (pat, url) {
  if (pat.length >= 2 && pat.charAt(0) === "/" && pat.charAt(pat.length - 1) === "/") {
    try { return new RegExp(pat.slice(1, -1)).test(url); } catch (_e) { return false; }
  }
  try { return __vmGlobRx(pat).test(url); } catch (_e) { return false; }
};
var __vmMatchPattern = function (pat, url) {
  if (pat === "<all_urls>") return /^(https?|file|ftp):/i.test(url);
  var parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/i.exec(pat);
  if (!parts) return false;
  var scheme = parts[1], host = parts[2], path = parts[3];
  var u; try { u = new URL(url); } catch (_e) { return false; }
  if (scheme === "*") {
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  } else if (u.protocol !== scheme.toLowerCase() + ":") return false;
  if (host === "*") {
    /* any host */
  } else if (host.indexOf("*.") === 0) {
    var suffix = host.slice(2).toLowerCase();
    var h = u.hostname.toLowerCase();
    if (h !== suffix && h.slice(-(suffix.length + 1)) !== "." + suffix) return false;
  } else if (host === "") {
    if (u.hostname !== "") return false;
  } else if (u.hostname.toLowerCase() !== host.toLowerCase()) return false;
  var tail = u.pathname + u.search + u.hash;
  try { return __vmGlobRx(path).test(tail); } catch (_e) { return false; }
};
var __vmMatchScript = function (url, m) {
  for (var i = 0; i < m.excludes.length; i++) if (__vmIncludeMatch(m.excludes[i], url)) return false;
  for (var j = 0; j < m.matches.length; j++) if (__vmMatchPattern(m.matches[j], url)) return true;
  for (var k = 0; k < m.includes.length; k++) if (__vmIncludeMatch(m.includes[k], url)) return true;
  return false;
};
var __vmMatching = "__VM_MATCHING__";
if (!__vmMatchScript(location.href, __vmMatching)) return;
