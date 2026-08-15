// Linkification of a Prism-highlighted code block, plus the anchor
// builder both it and the details panel use.
//
// Split out of `userscript.ts` so the same pass runs over installed
// scripts and over a not-yet-installed preview — the two share one
// tabbed code view (see `code-tabs.ts`).
//
// Pure DOM helpers: everything takes the elements it operates on. No
// chrome.* calls, no module state.

import { resolveScriptResource } from './file-loader.js';
import { matchTargetInfo, sameDirLinkUrl } from './match-targets.js';
import {
  MATCH_HEADER_TAGS,
  RESOLVABLE_HEADER_TAGS,
  connectLinkUrl,
  splitResourceValue,
  splitTextByUrls,
} from './script-links.js';
import { appendWithSlashBreaks } from './collection-display.js';

export function openInNewTabAnchor(
  href: string,
  text: string,
  // When true, insert `<wbr>` markers after each `/` so a long URL
  // wraps at slash boundaries — desired in the details panel (Match
  // patterns, Location row). The code box passes false: with
  // `white-space: pre`, Chrome still honors `<wbr>` as a break
  // opportunity, so a URL inside a single source line could wrap
  // mid-line and misalign the line-numbers gutter.
  slashBreaks = true,
): HTMLAnchorElement {
  const a = document.createElement('a') as HTMLAnchorElement;
  a.className = 'code-link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (slashBreaks) {
    appendWithSlashBreaks(a, text);
  } else {
    a.textContent = text;
  }
  return a;
}

// Post-Prism walk over the highlighted code: replace eligible text
// runs with anchors. Two passes:
//
//   1. Metadata blocks are recognised as `.token.userscript-header`
//      spans by the Prism grammar extension in `userscript.ts`; inside
//      each, the `@tag` is a `.header-tag-name` span and its value is a
//      `.header-tag-value` span. For tags we know how to linkify
//      (@match → wildcard-trimmed link, @icon/@require/@updateURL/…
//      → resolved against the script's fileUrl) the value span's
//      contents become an anchor; non-linkable tags fall through to
//      URL mode on the value text.
//   2. Every other text node has its absolute http(s) / file:// URLs
//      turned into anchors — covers comment URLs outside the header,
//      URLs inside strings, and `@require` source bodies (no header).
//
// Driving the header detection off the Prism token class (rather
// than line-shape matching) means a single-line string literal like
// `"// ==UserScript=="` can't trick the linkifier — Prism tokenises
// it as a string, not as our header block. A multi-line template
// literal that contains BOTH markers can still be picked up because
// our pattern is inserted before `string`/template tokens; in
// practice no userscript embeds a fake metadata block that way, but
// it's worth knowing.
export function linkifyCodeBlock(root: HTMLElement, fileUrl: string): void {
  for (const headerEl of Array.from(root.querySelectorAll('.userscript-header'))) {
    linkifyHeaderBlock(headerEl as HTMLElement, fileUrl);
  }

  // Walk text nodes AFTER the header pass so the tree mutations from
  // linkifyHeaderBlock are reflected. Skip nodes inside marker /
  // tag-name / tag-value spans — they were either handled by
  // linkifyHeaderBlock or are anchor labels we just inserted and
  // don't want to re-process.
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    const tn = n as Text;
    const parent = tn.parentElement;
    if (parent && parent.closest('.header-marker, .header-tag-name, .header-tag-value')) {
      continue;
    }
    nodes.push(tn);
  }
  for (const tn of nodes) linkifyTextNodeUrls(tn);
}

// Process one `.userscript-header` span: for each `.header-tag-value`
// inside it, look back for the matching `.header-tag-name` and turn
// the value into an anchor (or URL-linkified text for tags we don't
// know how to resolve).
function linkifyHeaderBlock(headerEl: HTMLElement, fileUrl: string): void {
  const valueEls = headerEl.querySelectorAll<HTMLElement>('.header-tag-value');
  for (const valueEl of Array.from(valueEls)) {
    const tag = findPrecedingTagName(valueEl);
    if (!tag) continue;
    const value = valueEl.textContent ?? '';
    const link = linkForHeaderTag(tag, value, fileUrl);
    if (link) {
      const doc = headerEl.ownerDocument;
      valueEl.replaceChildren(
        doc.createTextNode(link.prefix),
        openInNewTabAnchor(link.href, link.linkText, false),
        doc.createTextNode(link.suffix),
      );
    } else {
      // Fall back to URL-only linkification (e.g. an http URL inside
      // a `@description` value). Only touch the leaf text node so we
      // don't disturb any nested tokens (shouldn't exist today, but
      // safe if Prism's grammar evolves).
      const tn = valueEl.firstChild;
      if (tn && tn.nodeType === Node.TEXT_NODE) {
        linkifyTextNodeUrls(tn as Text);
      }
    }
  }
}

// Walk back from a tag-value span past whitespace text nodes to find
// the immediately-preceding tag-name span; returns the lowercased
// canonical tag (no `@`, no locale suffix), or null if the structure
// doesn't match (defensive — Prism should always pair them).
function findPrecedingTagName(valueEl: Element): string | null {
  let prev: Node | null = valueEl.previousSibling;
  while (prev) {
    if (prev.nodeType === Node.ELEMENT_NODE) {
      const el = prev as Element;
      if (!el.classList.contains('header-tag-name')) return null;
      const text = el.textContent ?? '';
      const m = /^@([A-Za-z][\w-]*)(?::[\w-]+)?$/.exec(text);
      return m ? m[1].toLowerCase() : null;
    }
    prev = prev.previousSibling;
  }
  return null;
}

function linkifyTextNodeUrls(tn: Text): void {
  const runs = splitTextByUrls(tn.data);
  if (runs.length === 1 && runs[0].kind === 'text') return;
  const doc = tn.ownerDocument;
  const replacement: Node[] = runs.map((r) =>
    r.kind === 'url'
      ? openInNewTabAnchor(r.value, r.value, false)
      : doc.createTextNode(r.value),
  );
  tn.replaceWith(...replacement);
}

// One header-tag link spec. `prefix` + `linkText` + `suffix` together
// reconstruct the parsed.value verbatim, so the line round-trips
// without losing any characters. Most tags use the whole value as
// the link text (prefix=suffix=''); `@resource` is the carve-out
// where prefix is the `<name>` token + gap and only the URL portion
// is wrapped.
interface HeaderTagLink {
  prefix: string;
  linkText: string;
  href: string;
  suffix: string;
}

function linkForHeaderTag(
  tag: string,
  value: string,
  fileUrl: string,
): HeaderTagLink | null {
  if (MATCH_HEADER_TAGS.has(tag)) {
    // Site-less patterns (`*://*/…`, `file:///*/…`) fall through to the
    // same-directory guess against the script's own location.
    const linkUrl = matchTargetInfo(value)?.linkUrl ?? sameDirLinkUrl(value, fileUrl);
    if (!linkUrl) return null;
    return { prefix: '', linkText: value, href: linkUrl, suffix: '' };
  }
  if (RESOLVABLE_HEADER_TAGS.has(tag)) {
    const resolved = resolveScriptResource(value, fileUrl);
    if (!resolved) return null;
    // A `data:` URL is technically navigable but its href would be
    // many KB long inside the anchor, drowning the code box. Inline
    // data URLs are already rendered via the favicon path; in the
    // body we just show the value as plain text.
    if (resolved.kind === 'data') return null;
    return { prefix: '', linkText: value, href: resolved.url, suffix: '' };
  }
  if (tag === 'resource') {
    // `@resource <name> <url>`: keep the name + gap as plain text;
    // linkify only the URL portion. The pure splitter in
    // script-links.ts owns the round-trip — see `splitResourceValue`.
    const parts = splitResourceValue(value);
    if (!parts) return null;
    const resolved = resolveScriptResource(parts.url, fileUrl);
    if (!resolved || resolved.kind === 'data') return null;
    return {
      prefix: parts.prefix,
      linkText: parts.url,
      href: resolved.url,
      suffix: parts.suffix,
    };
  }
  if (tag === 'connect') {
    // `@connect` values are hosts (`example.com`, `*.example.com`)
    // or full URLs, not match patterns. `connectLinkUrl` picks the
    // click target; `*` and `self` return null and fall through to
    // plain text since neither names a single site.
    const href = connectLinkUrl(value);
    if (!href) return null;
    return { prefix: '', linkText: value, href, suffix: '' };
  }
  return null;
}
