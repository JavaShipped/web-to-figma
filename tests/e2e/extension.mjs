// End-to-end check of the real Chrome extension: loads dist/extension into Playwright's Chromium,
// captures the fixture page exactly as the popup does (probe in the page world, capture script,
// capture message), downloads the result from the in-page toast and checks it.
// Usage: node tests/e2e/extension.mjs   (after npm run build)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('.');
const ext = join(root, 'dist/extension');
const port = 5179;
const out = join(root, 'dist/dev/captures');
mkdirSync(out, { recursive: true });

const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'w2f-e2e-'));
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

let context;
try {
  await waitForServer(`http://localhost:${port}/fixtures/`);
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  check(!!extensionId, `extension loaded (${extensionId})`);

  // The popup page itself should load without script errors.
  const popup = await context.newPage();
  const popupErrors = [];
  popup.on('pageerror', (e) => popupErrors.push(e.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  check((await popup.locator('#capture-page').count()) === 1 && popupErrors.length === 0, 'popup renders without errors');
  await popup.close();

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://localhost:${port}/fixtures/`);
  await page.waitForLoadState('networkidle');

  // Same calls popup.ts makes for "Capture full page".
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: ['probe.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target, files: ['capture.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'w2f:capture', mode: 'page', scrollFirst: true });
  }, `http://localhost:${port}/fixtures/`);

  const download = page.locator('w2f-ui button', { hasText: 'Download' });
  await download.waitFor({ timeout: 30_000 });
  const toast = await page.locator('w2f-ui .msg').textContent();
  console.log(`     toast: ${toast}`);
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const path = join(out, 'extension-page.w2f.json');
  await file.saveAs(path);
  const doc = JSON.parse(readFileSync(path, 'utf8'));

  // What a correct capture of the fixture contains.
  const nodes = [];
  const walk = (n) => {
    nodes.push(n);
    n.children?.forEach(walk);
  };
  walk(doc.root);
  const components = new Set(nodes.filter((n) => n.component).map((n) => n.component.name));
  const images = nodes.filter((n) => n.kind === 'image');
  const tiles = nodes.flatMap((n) => n.box?.backgrounds ?? []).filter((p) => p.type === 'image');
  const gradientRuns = nodes.flatMap((n) => n.runs ?? []).filter((r) => r.fill);

  check(doc.format === 'web-to-figma' && doc.version === 1, 'capture document format');
  check(nodes.length > 100, `captured ${nodes.length} nodes`);
  check(['Button', 'Card', 'NavLink', 'Badge'].every((c) => components.has(c)), `components: ${[...components].join(', ')}`);
  check(images.length === 1 && !!images[0].assetId && !!doc.assets[images[0].assetId], 'product screenshot fetched by the service worker');
  const asset = images[0] && doc.assets[images[0].assetId];
  check(!!asset && asset.mime === 'image/png' && asset.width <= 1440, `screenshot asset ${asset?.width}×${asset?.height} ${asset?.mime}`);
  check(tiles.length === 1 && tiles[0].size === 'tile' && !!doc.assets[tiles[0].assetId], 'dot pattern rasterised and tiled');
  check(gradientRuns.length === 1, 'gradient headline run');
  check(doc.colorTokens.some((t) => t.name === '--color-primary'), 'colour tokens read');
  check(!document_has_probe_attrs(await page.content()), 'probe attributes cleaned up');
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
  check(/Copied/.test(toast ?? ''), 'copied to clipboard');
  console.log(`     ${(readFileSync(path).length / 1024).toFixed(0)} KB → ${path}`);
} catch (err) {
  failures.push(String(err));
  console.error(err);
} finally {
  await context?.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} extension check(s) failed`);
  process.exit(1);
}
console.log('\nextension e2e passed');

function document_has_probe_attrs(html) {
  return /data-w2f-(component|hide-before|hide-after)/.test(html);
}

async function waitForServer(url) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`fixture server did not start on ${url}`);
}
