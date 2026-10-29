// Finds the text node containing a string in a saved capture and prints its ancestors with their
// layout plans (the chain that decides how it is sized). Usage: node scripts/inspect-text.mjs <capture> "<text>" [occurrence]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [name, needle, nth = '0'] = process.argv.slice(2);
const { planLayouts, expandDocument } = await import(pathToFileURL('dist/dev/inspect-lib.mjs').href); // built by inspect.mjs
const doc = expandDocument(JSON.parse(readFileSync(`dist/dev/captures/${name}.w2f.json`, 'utf8')));
const plans = planLayouts(doc.root);
const hits = [];
const walk = (n, chain) => {
  if (n.kind === 'text' && n.runs.map((r) => r.text).join('').includes(needle)) hits.push([...chain, n]);
  n.children?.forEach((c) => walk(c, [...chain, n]));
};
walk(doc.root, []);
const chain = hits[Number(nth)];
if (!chain) throw new Error(`"${needle}" not found (${hits.length} hits)`);
for (let k = Math.max(0, chain.length - 6); k < chain.length; k++) {
  const n = chain[k];
  const parent = chain[k - 1];
  const cp = parent ? plans.get(parent.id).children[parent.children.indexOf(n)] : null;
  const p = n.kind === 'element' ? plans.get(n.id) : null;
  const L = n.layout;
  console.log(
    `${'  '.repeat(k - Math.max(0, chain.length - 6))}${n.kind} "${n.name.slice(0, 40)}" ${JSON.stringify(n.rect)} display=${L.display} pad=${L.padding} ` +
      (p ? `→ ${p.grid ? 'GRID' : p.mode}${p.wrap ? ' wrap' : ''} gap=${p.itemSpacing} align=${p.primaryAlign}/${p.counterAlign} hug=${p.canHugH}/${p.canHugV} ` : '') +
      (cp ? `sizing=${cp.sizingH}/${cp.sizingV}${cp.wrapper ? ` wrapper=${JSON.stringify(cp.wrapper)}` : ''}${cp.absolute ? ' abs' : ''}` : '') +
      (n.kind === 'text' ? ` lines=${n.lineCount} hugs=${n.hugs}` : ''),
  );
}
