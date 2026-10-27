// Renders promo-tile.html to promo-tile.png, the Chrome Web Store's
// 440x280 small promo tile. Run from the repo:
//   node docs/chrome-web-store/render-promo-tile.mjs
//
// The store wants no transparency. The tile is opaque, so the
// screenshot comes out as a PNG with no alpha channel.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const html = new URL('promo-tile.html', import.meta.url);
const png = fileURLToPath(new URL('promo-tile.png', import.meta.url));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await page.goto(html.href);
  await page.locator('.tile').screenshot({ path: png });
} finally {
  await browser.close();
}
console.log(`Wrote ${png}`);
