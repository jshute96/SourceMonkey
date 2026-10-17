// `start --lang`: the languages the run's tabs say they prefer, as
// `navigator.language(s)`, the `Accept-Language` header, and the
// default locale of `Intl` (dates, numbers).
//
// Set per tab over CDP (the Chrome DevTools Protocol), held for the
// tab's life by a session of its own, so it works in a shared browser
// without touching its other tabs. That reaches the tab's own frames
// only: cross-site iframes and workers have targets of their own, and
// keep the browser's languages. A headless temp browser is also
// launched with Chrome's own language flags, which reach those too,
// and a popup's first load.
//
// The extension's own requests (`GM_xmlhttpRequest`, `GM_download`)
// carry the browser's languages, not a tab's: a launched browser's
// flags, or a connected one's own.

import type { Page } from '@playwright/test';

/** What `--lang` takes, for its messages. */
export const LANG_NEEDS = 'The --lang flag needs a language tag like zh-CN, or a list like zh-CN,en';

// A language first, then subtags: Intl alone also takes private-use
// tags (`x-foo`), which no browser sends.
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** Whether `value` looks like a language tag (`en`, `zh-CN`). */
export function isLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && LANGUAGE_TAG.test(value);
}

function notATag(tag: string): Error {
  return new Error(`The --lang flag got ${tag}, which is not a language tag. It needs one like zh-CN, or a list like zh-CN,en.`);
}

/**
 * A `--lang` value as language tags, in the canonical case
 * (`zh-cn` is `zh-CN`). Throws an Error with the message to show when
 * a tag isn't one.
 */
export function parseLang(text: string): string[] {
  const tags = text.split(',').map((t) => t.trim());
  if (tags.some((t) => t === '')) throw new Error(LANG_NEEDS);
  for (const tag of tags) {
    if (!isLanguageTag(tag)) throw notATag(tag);
    try {
      Intl.getCanonicalLocales(tag);
    } catch {
      throw notATag(tag);
    }
  }
  return [...new Set(Intl.getCanonicalLocales(tags))];
}

/** Chrome's own flags for the languages, for a browser the run launches. */
export function langLaunchArgs(langs: string[] | undefined): string[] {
  return langs?.length ? [`--lang=${langs[0]}`, `--accept-lang=${langs.join(',')}`] : [];
}

/**
 * Has `page` prefer `langs` from now on, through a CDP session left
 * open, since an override lasts only while the session that set it
 * does. Applies from the tab's next document on. A failure is said
 * on `out`, naming the step, and the tab goes on without.
 */
export async function applyLang(page: Page, langs: string[] | undefined, out: (line: string) => void): Promise<void> {
  if (!langs?.length) return;
  let step = 'Connecting to the tab failed';
  try {
    const session = await page.context().newCDPSession(page);
    // An empty userAgent keeps the browser's own, and its client hints
    // (navigator.userAgentData); only the languages change.
    step = 'Setting navigator.languages and Accept-Language failed';
    await session.send('Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: langs.join(',') });
    // Intl's. Last, as only one connection to the browser can hold it.
    step = 'Setting Intl\'s locale failed';
    await session.send('Emulation.setLocaleOverride', { locale: langs[0] });
  } catch (err) {
    if (page.isClosed()) return;
    const message = (err as Error).message;
    out(/already in effect/.test(message)
      ? `[sm-dev] Could not set the tab's locale for Intl to ${langs[0]}: Another connection to the browser already overrides the tab's locale`
      : `[sm-dev] Could not set the tab's languages to ${langs.join(',')}: ${step} (${cdpDetail(message)})`);
  }
}

// What a CDP call's error says, without Playwright's and the
// protocol's prefixes: `Protocol error (X.y): Not allowed` is `Not allowed`.
function cdpDetail(message: string): string {
  return message.replace(/^cdpSession\.send: /, '').replace(/^Protocol error \([^)]*\): /, '').split('\n')[0];
}
