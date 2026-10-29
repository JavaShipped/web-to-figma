// One-off: renders the raster fixture images (a product screenshot PNG) with Playwright's Chromium.
// Usage: node scripts/make-fixture-images.mjs
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.setContent(`<body style="margin:0;font:600 48px system-ui;background:linear-gradient(135deg,#eef2ff,#fdf2f8)">
  <div style="position:absolute;inset:60px;border-radius:24px;background:#fff;box-shadow:0 30px 80px rgba(79,70,229,.25);display:grid;grid-template-columns:280px 1fr">
    <div style="background:#1e1b4b;border-radius:24px 0 0 24px"></div>
    <div style="padding:56px;display:flex;flex-direction:column;gap:28px;color:#1e1b4b">Tokens
      <div style="display:flex;gap:20px">${['#4f46e5', '#ec4899', '#14b8a6', '#f59e0b'].map((c) => `<div style="width:120px;height:120px;border-radius:20px;background:${c}"></div>`).join('')}</div>
      <div style="height:24px;width:70%;border-radius:12px;background:#e0e7ff"></div>
      <div style="height:24px;width:50%;border-radius:12px;background:#e0e7ff"></div>
    </div>
  </div></body>`);
await page.screenshot({ path: 'fixtures/shot.png' });
await browser.close();
console.log('wrote fixtures/shot.png');
