// Audits the type settings a captured page actually uses: each distinct family / weight / size /
// line-height / letter-spacing combination, how often it appears, and how they cluster by size.
// Usage: node scripts/type-audit.mjs <capture-name>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const name = process.argv[2] ?? 'capture';
const { expandDocument } = await import(pathToFileURL('dist/dev/inspect-lib.mjs').href); // built by inspect.mjs
const doc = expandDocument(JSON.parse(readFileSync(`dist/dev/captures/${name}.w2f.json`, 'utf8')));
const r2 = (v) => Math.round(v * 100) / 100;
const combos = new Map();
const walk = (n) => {
  for (const run of n.runs ?? []) {
    const s = run.style;
    const key = [s.fontFamily[0], s.fontWeight, r2(s.fontSize), s.lineHeight === null ? 'normal' : r2(s.lineHeight), r2(s.letterSpacing), s.transform].join(' | ');
    const e = combos.get(key) ?? { count: 0, sample: run.text.trim().slice(0, 32) };
    e.count++;
    combos.set(key, e);
  }
  n.children?.forEach(walk);
};
walk(doc.root);
const rows = [...combos.entries()].sort((a, b) => parseFloat(b[0].split(' | ')[2]) - parseFloat(a[0].split(' | ')[2]));
console.log(`${combos.size} distinct type settings; ${rows.filter(([, e]) => e.count >= 2).length} used 2+ times (those become text styles)\n`);
console.log('family | weight | size | line-height | tracking | case  ×uses  "sample"');
for (const [k, e] of rows) console.log(`${k}  ×${e.count}  "${e.sample}"`);
const sizes = [...new Set(rows.map(([k]) => parseFloat(k.split(' | ')[2])))].sort((a, b) => b - a);
console.log(`\n${sizes.length} distinct font sizes: ${sizes.join(', ')}`);
const families = [...new Set(rows.map(([k]) => k.split(' | ')[0]))];
console.log(`families: ${families.join(', ')}`);
