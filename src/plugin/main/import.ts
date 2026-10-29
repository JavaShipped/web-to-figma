import { detectComponents } from '../../shared/components';
import { planLayouts } from '../../shared/layout';
import { expandDocument, type CaptureDocument } from '../../shared/schema';
import { applySizing, buildNode, type BuildContext } from './build';
import { convertComponents } from './components';
import { prepareFonts } from './fonts';
import { createStyles, NO_STYLES } from './styles';

// The import pipeline: plan layout, load fonts and images, create styles, build layers, then
// convert components. Shared by the plugin UI and the headless test harness.

export interface ImportOptions {
  autoLayout: boolean;
  components: boolean;
  styles: boolean;
}

export async function importCapture(doc: CaptureDocument, options: ImportOptions, progress: (text: string) => void = () => {}) {
  const started = Date.now();
  expandDocument(doc);
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

  let componentSummary: Awaited<ReturnType<typeof convertComponents>> = { components: 0, instances: 0, icons: 0, failed: [] };
  if (options.components) {
    progress('Creating components…');
    const sets = detectComponents(doc.root, plans);
    componentSummary = await convertComponents(sets, doc.root, ctx.nodes, page, progress);
  }

  try {
    figma.currentPage.selection = [page];
    figma.viewport.scrollAndZoomIntoView([page]);
  } catch {
    /* no viewport when run headless */
  }
  return {
    pageId: page.id,
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
