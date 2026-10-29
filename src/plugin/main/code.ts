import { detectComponents } from '../../shared/components';
import { planLayouts } from '../../shared/layout';
import { isCaptureDocument, type CaptureDocument } from '../../shared/schema';
import { applySizing, buildNode, type BuildContext } from './build';
import { convertComponents } from './components';
import { prepareFonts } from './fonts';
import { createStyles, NO_STYLES } from './styles';

// Plugin entry: receives a capture from the UI and rebuilds it on the current page.

export interface ImportOptions {
  autoLayout: boolean;
  components: boolean;
  styles: boolean;
}

type UiMessage = { type: 'import'; doc: unknown; options: ImportOptions } | { type: 'close' };

figma.showUI(__html__, { width: 340, height: 460, themeColors: true });

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === 'close') return figma.closePlugin();
  if (msg.type !== 'import') return;
  if (!isCaptureDocument(msg.doc)) {
    post({ type: 'error', message: 'That isn’t a Web to Figma capture. Capture a page with the browser extension first.' });
    return;
  }
  try {
    const summary = await importCapture(msg.doc, msg.options);
    post({ type: 'done', summary });
  } catch (err) {
    console.error(err);
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};

function post(msg: unknown) {
  figma.ui.postMessage(msg);
}

function progress(text: string) {
  post({ type: 'progress', text });
}

export async function importCapture(doc: CaptureDocument, options: ImportOptions) {
  const started = Date.now();
  progress('Planning layout…');
  const plans = planLayouts(doc.root, { autoLayout: options.autoLayout });

  progress('Loading fonts…');
  const fonts = await prepareFonts(doc.root);

  progress('Adding images…');
  const hashes = new Map<string, string>();
  for (const [id, asset] of Object.entries(doc.assets)) {
    try {
      hashes.set(id, figma.createImage(figma.base64Decode(asset.data)).hash);
    } catch {
      /* unsupported or corrupt image: left as a placeholder */
    }
  }

  const styles = options.styles ? await createStyles(doc, fonts) : NO_STYLES;

  const ctx: BuildContext = {
    plans,
    fonts,
    styles,
    nodes: new Map(),
    built: 0,
    onProgress: (n) => progress(`Building layers… ${n}`),
    imageHash: (id) => hashes.get(id) ?? null,
    colorVariable: (c) => styles.colorVariable(c),
  };

  progress('Building layers…');
  const page = (await buildNode(doc.root, ctx)) as FrameNode;
  page.name = doc.title || doc.url;
  figma.currentPage.appendChild(page);
  const rootPlan = plans.get(doc.root.id)!;
  applySizing(page, 'FIXED', rootPlan.canHugV ? 'HUG' : 'FIXED', false);
  placeBesideExisting(page);

  let componentSummary = { components: 0, instances: 0, icons: 0 };
  if (options.components) {
    progress('Creating components…');
    const sets = detectComponents(doc.root, plans);
    componentSummary = await convertComponents(sets, doc.root, ctx.nodes, page, progress);
  }

  figma.currentPage.selection = [page];
  figma.viewport.scrollAndZoomIntoView([page]);
  return {
    layers: ctx.built,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    missingFonts: [...fonts.missing],
    ...componentSummary,
    ...styles.summary,
  };
}

function placeBesideExisting(node: FrameNode) {
  let right = -Infinity;
  let top = 0;
  for (const n of figma.currentPage.children) {
    if (n === node) continue;
    if (n.x + n.width > right) {
      right = n.x + n.width;
      top = n.y;
    }
  }
  if (Number.isFinite(right)) {
    node.x = right + 200;
    node.y = top;
  } else {
    node.x = Math.round(figma.viewport.center.x - node.width / 2);
    node.y = Math.round(figma.viewport.center.y - Math.min(node.height, 800) / 2);
  }
}
