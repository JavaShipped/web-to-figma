// Builds the Chrome extension (dist/extension), the Figma plugin (dist/figma-plugin) and the
// dev capture harness (dist/dev). `--watch` rebuilds on change.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, logLevel: 'info', legalComments: 'none' };

mkdirSync('dist/extension', { recursive: true });
mkdirSync('dist/figma-plugin', { recursive: true });
cpSync('static/extension', 'dist/extension', { recursive: true });
cpSync('static/figma-plugin/manifest.json', 'dist/figma-plugin/manifest.json');

const builds = [
  {
    ...common,
    entryPoints: {
      capture: 'src/capture/entry.ts',
      probe: 'src/extension/probe.ts',
      background: 'src/extension/background.ts',
      popup: 'src/extension/popup.ts',
    },
    outdir: 'dist/extension',
    format: 'iife',
    target: 'chrome120',
  },
  {
    ...common,
    entryPoints: { 'capture-dev': 'src/capture/dev.ts' },
    outdir: 'dist/dev',
    format: 'iife',
    target: 'chrome120',
  },
  {
    ...common,
    entryPoints: { code: 'src/plugin/main/code.ts' },
    outdir: 'dist/figma-plugin',
    format: 'iife',
    // The plugin sandbox is conservative about newer syntax.
    target: 'es2019',
  },
  {
    ...common,
    entryPoints: { headless: 'src/plugin/main/headless.ts' },
    outdir: 'dist/dev',
    format: 'iife',
    target: 'es2019',
    minify: true,
  },
];

// The plugin UI must be a single HTML file, so its script is bundled and inlined.
const uiPlugin = {
  name: 'inline-ui',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
      const html = readFileSync('static/figma-plugin/ui.html', 'utf8').replace('/*__UI_SCRIPT__*/', () => js);
      writeFileSync('dist/figma-plugin/ui.html', html);
    });
  },
};
const uiBuild = {
  ...common,
  entryPoints: ['src/plugin/ui/ui.ts'],
  outfile: 'dist/figma-plugin/ui.js',
  format: 'iife',
  target: 'chrome120',
  write: false,
  plugins: [uiPlugin],
};

if (watch) {
  for (const b of [...builds, uiBuild]) await (await esbuild.context(b)).watch();
} else {
  await Promise.all([...builds, uiBuild].map((b) => esbuild.build(b)));
}
