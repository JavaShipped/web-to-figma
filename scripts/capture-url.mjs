// Captures any URL with the real extension (dist/extension) in Playwright's Chromium and saves the
// result to dist/dev/captures/<name>.w2f.json, so live sites can be tried without clicking through
// the popup. Usage: node scripts/capture-url.mjs <url> <name> [--width=1440] [--dismiss="Essential only"]
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const [url, name = 'capture'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
if (!url) {
  console.error('usage: node scripts/capture-url.mjs <url> <name> [--width=1440] [--dismiss="button text"]');
  process.exit(1);
}
const width = Number(flag('width', 1440));
const ext = resolve('dist/extension');
const out = resolve('dist/dev/captures');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'w2f-capture-'));

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width, height: 900 },
  acceptDownloads: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  // Dismiss a consent banner so it isn't captured; --dismiss="Essential only" picks the button.
  const dismiss = flag('dismiss', '');
  if (dismiss) await page.getByRole('button', { name: dismiss }).first().click({ timeout: 5000 }).catch(() => console.log(`no "${dismiss}" button`));
  await page.waitForTimeout(1500); // entrance animations
  await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.startsWith(target)) ?? tabs[tabs.length - 1];
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['probe.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'w2f:capture', mode: 'page', scrollFirst: true });
  }, page.url());
  const download = page.locator('w2f-ui button', { hasText: 'Download' });
  await download.waitFor({ timeout: 120_000 });
  console.log(`toast: ${await page.locator('w2f-ui .msg').textContent()}`);
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const path = join(out, `${name}.w2f.json`);
  await file.saveAs(path);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  console.log(`${(statSync(path).size / 1024).toFixed(0)} KB → ${path}`);
  if (errors.length) console.log(`page errors: ${errors.join(' | ')}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
