// Builds a script for the Figma MCP use_figma tool: the headless plugin bundle plus a saved capture,
// so the real builder can be exercised in a Figma file. Usage: node scripts/figma-test-script.mjs <capture-name>
import { readFileSync, writeFileSync } from 'node:fs';

const name = process.argv[2];
const bundle = readFileSync('dist/dev/headless.js', 'utf8').trim();
// use_figma takes at most 50k characters, so drop what this test doesn't need.
const parsed = JSON.parse(readFileSync(`dist/dev/captures/${name}.w2f.json`, 'utf8'));
if (process.argv.includes('--no-tokens')) parsed.colorTokens = [];
if (process.argv.includes('--slim')) {
  // Fields the builder doesn't read: text layer names (Figma names text by content) and component chains.
  const visit = (n) => {
    if (n.kind === 'text') delete n.name;
    if (n.component) delete n.component.chain;
    n.children?.forEach(visit);
  };
  visit(parsed.root);
}
const doc = JSON.stringify(parsed);
const script = `${bundle}
const doc = ${doc};
return await globalThis.__w2fImport(doc, { autoLayout: true, components: true, styles: true });
`;
writeFileSync(`dist/dev/captures/${name}.use-figma.js`, script);
console.log(`${script.length} chars`);
