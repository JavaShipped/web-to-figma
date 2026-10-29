// Diagnostics for a live site: framework internals and where its CSS custom properties live.
// Usage: node scripts/probe-site.mjs <url>
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(process.argv[2], { waitUntil: 'networkidle' });
const report = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('body *'));
  const fiberKey = Object.keys(els.find((e) => Object.keys(e).some((k) => k.startsWith('__reactFiber$'))) ?? {}).find((k) =>
    k.startsWith('__reactFiber$'),
  );
  const types = new Map();
  if (fiberKey) {
    for (const el of els) {
      for (let f = el[fiberKey]?.return; f && f.tag !== 5 && f.tag !== 3; f = f.return) {
        if (typeof f.type === 'function' || (f.type && typeof f.type === 'object')) {
          const t = f.type.render ?? f.type.type ?? f.type;
          const n = t.displayName ?? t.name ?? '?';
          types.set(t, { name: n, count: (types.get(t)?.count ?? 0) + 1 });
        }
      }
    }
  }
  const declared = new Map();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const walk = (list) => {
      for (const r of Array.from(list)) {
        if (r.style) for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith('--')) declared.set(r.selectorText, (declared.get(r.selectorText) ?? 0) + 1);
        if (r.cssRules) walk(r.cssRules);
      }
    };
    walk(rules);
  }
  return {
    react: !!fiberKey,
    vue: !!els.find((e) => e.__vueParentComponent),
    componentTypes: types.size,
    topTypes: [...types.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    customPropSelectors: [...declared.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    dataSlot: document.querySelectorAll('[data-slot]').length,
  };
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
