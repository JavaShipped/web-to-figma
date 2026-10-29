// Prints what the plugin will make of a saved capture, without Figma: how many frames get auto
// layout, grid or none, how many wrappers are needed, and the component sets.
// Usage: node scripts/inspect.mjs <capture-name>
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const name = process.argv[2] ?? 'capture';
const bundle = 'dist/dev/inspect-lib.mjs';
await esbuild.build({
  stdin: {
    contents: `export { planLayouts } from './src/shared/layout';
      export { detectComponents } from './src/shared/components';
      export { expandDocument } from './src/shared/schema';`,
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent',
});
const { planLayouts, detectComponents, expandDocument } = await import(pathToFileURL(bundle).href);

const doc = expandDocument(JSON.parse(readFileSync(`dist/dev/captures/${name}.w2f.json`, 'utf8')));
const plans = planLayouts(doc.root);
const sets = detectComponents(doc.root, plans);

const modes = {};
let wrappers = 0;
let absolute = 0;
const noLayout = [];
const visit = (n, path) => {
  if (n.kind !== 'element') return;
  const p = plans.get(n.id);
  const mode = p.grid ? 'GRID' : p.mode + (p.wrap ? ' wrap' : '');
  modes[mode] = (modes[mode] ?? 0) + 1;
  const flow = p.children.filter((c) => !c.absolute).length;
  if (p.mode === 'NONE' && flow > 1) noLayout.push(`${path} > ${n.name} (${n.children.length} children, display ${n.layout.display})`);
  wrappers += p.children.filter((c) => c.wrapper).length;
  absolute += n.children.filter((c, i) => p.children[i].absolute).length;
  n.children.forEach((c) => visit(c, `${path} > ${n.name}`));
};
visit(doc.root, '');

const count = (n) => 1 + (n.children ?? []).reduce((s, c) => s + count(c), 0);
console.log(`${doc.title} — ${count(doc.root)} nodes, ${Object.keys(doc.assets).length} images, ${doc.colorTokens.length} colour tokens`);
console.log('frames by layout:', modes);
console.log(`wrappers: ${wrappers}, absolutely positioned: ${absolute}`);
if (noLayout.length) console.log(`\nframes without auto layout despite several flow children (${noLayout.length}):\n  ${noLayout.slice(0, 15).join('\n  ')}`);
console.log(`\ncomponent sets (${sets.length}):`);
for (const s of sets) {
  const uses = s.variants.reduce((t, v) => t + v.nodeIds.length, 0);
  console.log(`  ${s.name} [${s.source}] ${s.axes.length ? `axes=${s.axes.join('/')} ` : ''}variants=${s.variants.length} uses=${uses}`);
}

// --node="Name": dump the plan for elements with that name.
const nodeName = process.argv.find((a) => a.startsWith('--node='))?.slice(7);
if (nodeName) {
  const find = (n) => (n.kind === 'element' ? [...(n.name === nodeName ? [n] : []), ...n.children.flatMap(find)] : []);
  for (const n of find(doc.root)) {
    const p = plans.get(n.id);
    console.log(`\n${n.name} ${JSON.stringify(n.rect)} display=${n.layout.display} cols=${JSON.stringify(n.layout.gridColumns)} rows=${JSON.stringify(n.layout.gridRows)} gaps=${n.layout.columnGap}/${n.layout.rowGap}`);
    console.log(`  plan: mode=${p.mode} wrap=${p.wrap} grid=${!!p.grid} spacing=${p.itemSpacing} pad=${p.padding} hug=${p.canHugH}/${p.canHugV}`);
    n.children.forEach((c, i) => console.log(`  - ${c.kind} ${c.name.slice(0, 30)} ${JSON.stringify(c.rect)} → ${p.children[i].sizingH}/${p.children[i].sizingV}${p.children[i].absolute ? ' abs' : ''}${p.grid?.cells[i] ? ` cell=${JSON.stringify(p.grid.cells[i])}` : ''}`));
  }
}
