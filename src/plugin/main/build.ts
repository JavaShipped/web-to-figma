import type { ChildPlan, LayoutPlan, PlanMap, Sizing } from '../../shared/layout';
import type { CaptureNode, ElementNode, ImageNode, SvgNode, TextNode as CText } from '../../shared/schema';
import type { FontResolver } from './fonts';
import { applyBox, effects, solidPaint, toPaints, type PaintContext } from './paints';
import type { StyleRegistry } from './styles';

// Builds Figma layers from the capture tree, following the layout plan: frames get auto layout
// (or grid), children get fixed / hug / fill sizing, and out-of-flow children are absolutely positioned.

export interface BuildContext extends PaintContext {
  plans: PlanMap;
  fonts: FontResolver;
  styles: StyleRegistry;
  /** Capture node id → built Figma node, used by component conversion. */
  nodes: Map<string, SceneNode>;
  onProgress: (built: number) => void;
  built: number;
}

const ALIGN_TEXT: Record<CText['align'], TextNode['textAlignHorizontal']> = {
  left: 'LEFT',
  center: 'CENTER',
  right: 'RIGHT',
  justify: 'JUSTIFIED',
};

export async function buildNode(n: CaptureNode, ctx: BuildContext): Promise<SceneNode> {
  let node: SceneNode;
  switch (n.kind) {
    case 'element':
      node = await buildFrame(n, ctx);
      break;
    case 'text':
      node = await buildText(n, ctx);
      break;
    case 'image':
      node = buildImage(n, ctx);
      break;
    case 'svg':
      node = buildSvg(n, ctx);
      break;
  }
  ctx.nodes.set(n.id, node);
  if (++ctx.built % 150 === 0) {
    ctx.onProgress(ctx.built);
    await new Promise((r) => setTimeout(r, 0)); // let the UI repaint
  }
  return node;
}

async function buildFrame(el: ElementNode, ctx: BuildContext): Promise<FrameNode> {
  const f = figma.createFrame();
  f.name = el.name;
  applyBoxSafe(f, el, ctx);
  f.resize(Math.max(0.01, el.rect.width), Math.max(0.01, el.rect.height));

  const plan = ctx.plans.get(el.id)!;
  const grid = plan.mode !== 'NONE' && plan.grid ? applyGrid(f, plan) : false;
  if (plan.mode !== 'NONE' && !grid) applyAutoLayout(f, plan);
  const autoLayout = plan.mode !== 'NONE';

  for (const idx of plan.order) {
    const child = el.children[idx];
    const cp = plan.children[idx];
    const built = await buildNode(child, ctx);
    const inFlow = autoLayout && !cp.absolute;

    if (grid && inFlow) {
      placeInGrid(f, built, plan, idx);
      applySizing(built, cp.sizingH, cp.sizingV, true);
      continue;
    }
    // Grid that fell back to wrap: cells can't be filled, keep their measured width.
    const sizingH = plan.grid && !grid && cp.sizingH === 'FILL' ? 'FIXED' : cp.sizingH;

    if (inFlow && cp.wrapper) {
      const w = wrap(built, child, cp, plan, el);
      f.appendChild(w);
      w.appendChild(built);
      applySizing(w, cp.wrapper.sizingH, cp.wrapper.sizingV, true);
      applySizing(built, sizingH, cp.sizingV, true);
      continue;
    }

    f.appendChild(built);
    if (!inFlow) {
      if (autoLayout && 'layoutPositioning' in built) built.layoutPositioning = 'ABSOLUTE';
      built.x = child.rect.x - el.rect.x;
      built.y = child.rect.y - el.rect.y;
    }
    applySizing(built, sizingH, cp.sizingV, inFlow);
  }
  return f;
}

function applyAutoLayout(f: FrameNode, plan: LayoutPlan) {
  const { width, height } = f;
  f.layoutMode = plan.mode as 'HORIZONTAL' | 'VERTICAL';
  f.primaryAxisSizingMode = 'FIXED';
  f.counterAxisSizingMode = 'FIXED';
  if (plan.mode === 'HORIZONTAL') f.layoutWrap = plan.wrap ? 'WRAP' : 'NO_WRAP';
  [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = plan.padding;
  f.itemSpacing = plan.itemSpacing;
  if (plan.wrap) f.counterAxisSpacing = plan.counterAxisSpacing;
  f.primaryAxisAlignItems = plan.primaryAlign;
  f.counterAxisAlignItems = plan.counterAlign === 'BASELINE' && plan.mode !== 'HORIZONTAL' ? 'MIN' : plan.counterAlign;
  f.resize(width, height);
}

/** Figma grid auto layout; returns false (and leaves the frame unchanged) if unsupported. */
function applyGrid(f: FrameNode, plan: LayoutPlan): boolean {
  const g = plan.grid!;
  const { width, height } = f;
  try {
    f.layoutMode = 'GRID';
    f.gridColumnCount = g.columns.length;
    f.gridRowCount = g.rows.length;
    f.gridColumnGap = g.columnGap;
    f.gridRowGap = g.rowGap;
    g.columns.forEach((col, i) => {
      const track = f.gridColumnSizes[i];
      track.type = col.type;
      if (col.type === 'FLEX') track.value = col.value;
    });
    f.gridRowSizes.forEach((track) => {
      track.type = 'HUG';
    });
    [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft] = plan.padding;
    f.resize(width, height);
    return true;
  } catch {
    try {
      f.layoutMode = 'NONE';
    } catch {
      /* already none */
    }
    return false;
  }
}

function placeInGrid(f: FrameNode, built: SceneNode, plan: LayoutPlan, idx: number) {
  const cell = plan.grid!.cells[idx];
  try {
    f.appendChildAt(built, cell.row, cell.col);
    const g = built as SceneNode & GridChildrenMixin;
    if (cell.colSpan > 1) g.gridColumnSpan = cell.colSpan;
    if (cell.rowSpan > 1) g.gridRowSpan = cell.rowSpan;
    g.gridChildHorizontalAlign = cell.alignH;
    g.gridChildVerticalAlign = cell.alignV;
  } catch {
    if (built.parent !== f) f.appendChild(built);
  }
}

/** A transparent frame giving one child extra leading space or its own counter-axis alignment. */
function wrap(built: SceneNode, child: CaptureNode, cp: ChildPlan, plan: LayoutPlan, parent: ElementNode): FrameNode {
  const w = cp.wrapper!;
  const frame = figma.createFrame();
  frame.name = `${built.name} wrapper`;
  frame.fills = [];
  frame.clipsContent = false;
  const horizontal = plan.mode === 'HORIZONTAL';
  frame.layoutMode = horizontal ? 'HORIZONTAL' : 'VERTICAL';
  frame.primaryAxisSizingMode = 'FIXED';
  frame.counterAxisSizingMode = 'FIXED';
  if (horizontal) {
    frame.paddingLeft = w.padStart;
    frame.paddingTop = w.offset;
  } else {
    frame.paddingTop = w.padStart;
    frame.paddingLeft = w.offset;
  }
  frame.counterAxisAlignItems = w.align ?? 'MIN';
  if (w.push) frame.primaryAxisAlignItems = 'MAX';
  const contentW = parent.rect.width - plan.padding[1] - plan.padding[3];
  const contentH = parent.rect.height - plan.padding[0] - plan.padding[2];
  const width = horizontal ? child.rect.width + w.padStart : w.align ? contentW : child.rect.width + w.offset;
  const height = horizontal ? (w.align ? contentH : child.rect.height + w.offset) : child.rect.height + w.padStart;
  frame.resize(Math.max(0.01, width), Math.max(0.01, height));
  return frame;
}

export function applySizing(node: SceneNode, h: Sizing, v: Sizing, inAutoLayout: boolean) {
  if (node.type === 'TEXT') {
    if (inAutoLayout) {
      node.layoutSizingHorizontal = h;
      node.layoutSizingVertical = v;
    } else {
      node.textAutoResize = h === 'HUG' ? 'WIDTH_AND_HEIGHT' : v === 'HUG' ? 'HEIGHT' : 'NONE';
    }
    return;
  }
  if (!('layoutSizingHorizontal' in node)) return;
  const hasAutoLayout = 'layoutMode' in node && node.layoutMode !== 'NONE';
  const fix = (s: Sizing): Sizing => (s === 'HUG' && !hasAutoLayout) || (s === 'FILL' && !inAutoLayout) ? 'FIXED' : s;
  try {
    node.layoutSizingHorizontal = fix(h);
  } catch {
    /* e.g. FILL under a hugging parent */
  }
  try {
    node.layoutSizingVertical = fix(v);
  } catch {
    /* ignore */
  }
}

async function buildText(t: CText, ctx: BuildContext): Promise<TextNode> {
  const n = figma.createText();
  n.fontName = ctx.fonts.resolve(t.runs[0].style);
  n.characters = t.runs.map((r) => r.text).join('');
  let at = 0;
  for (const r of t.runs) {
    const s = at;
    const e = at + r.text.length;
    at = e;
    if (e <= s) continue;
    const styleId = ctx.styles.textStyleId(r.style);
    if (styleId) {
      await n.setRangeTextStyleIdAsync(s, e, styleId);
    } else {
      n.setRangeFontName(s, e, ctx.fonts.resolve(r.style));
      n.setRangeFontSize(s, e, Math.max(1, r.style.fontSize));
      n.setRangeLineHeight(s, e, r.style.lineHeight ? { unit: 'PIXELS', value: r.style.lineHeight } : { unit: 'AUTO' });
      n.setRangeLetterSpacing(s, e, { unit: 'PIXELS', value: r.style.letterSpacing });
    }
    n.setRangeFills(s, e, r.fill ? toPaints([r.fill], ctx) : [solidPaint(r.style.color, ctx)]);
    if (r.style.decoration !== 'none') n.setRangeTextDecoration(s, e, r.style.decoration === 'underline' ? 'UNDERLINE' : 'STRIKETHROUGH');
    if (r.style.transform !== 'none') {
      n.setRangeTextCase(s, e, r.style.transform === 'uppercase' ? 'UPPER' : r.style.transform === 'lowercase' ? 'LOWER' : 'TITLE');
    }
    if (r.href && /^https?:\/\//.test(r.href)) n.setRangeHyperlink(s, e, { type: 'URL', value: r.href });
  }
  if (t.fill) n.fills = toPaints([t.fill], ctx);
  n.textAlignHorizontal = ALIGN_TEXT[t.align];
  n.textAutoResize = 'NONE';
  n.resize(Math.max(1, t.rect.width), Math.max(1, t.rect.height));
  return n;
}

function buildImage(img: ImageNode, ctx: BuildContext): RectangleNode {
  const r = figma.createRectangle();
  r.name = img.name;
  applyBox(r, img.box, ctx);
  const hash = img.assetId ? ctx.imageHash(img.assetId) : null;
  const fills = [...(r.fills as Paint[])];
  if (hash) {
    const scaleMode = img.fit === 'cover' ? 'FILL' : img.fit === 'fill' ? 'CROP' : 'FIT';
    fills.push({ type: 'IMAGE', imageHash: hash, scaleMode, ...(scaleMode === 'CROP' ? { imageTransform: [[1, 0, 0], [0, 1, 0]] } : {}) });
  } else {
    fills.push({ type: 'SOLID', color: { r: 0.88, g: 0.88, b: 0.9 } });
  }
  r.fills = fills;
  r.resize(Math.max(0.01, img.rect.width), Math.max(0.01, img.rect.height));
  return r;
}

function buildSvg(svg: SvgNode, ctx: BuildContext): SceneNode {
  try {
    const node = figma.createNodeFromSvg(svg.svg);
    node.name = svg.name === 'Frame' ? 'Icon' : svg.name;
    node.fills = toPaints(svg.box.backgrounds, ctx);
    node.clipsContent = false;
    if (svg.box.opacity < 1) node.opacity = svg.box.opacity;
    const fx = effects(svg.box);
    if (fx.length) node.effects = fx;
    if (Math.abs(node.width - svg.rect.width) > 0.5 || Math.abs(node.height - svg.rect.height) > 0.5) {
      node.resize(Math.max(0.01, svg.rect.width), Math.max(0.01, svg.rect.height));
    }
    return node;
  } catch {
    const r = figma.createRectangle();
    r.name = `${svg.name} (SVG failed to import)`;
    r.fills = [{ type: 'SOLID', color: { r: 0.88, g: 0.88, b: 0.9 } }];
    r.resize(Math.max(0.01, svg.rect.width), Math.max(0.01, svg.rect.height));
    return r;
  }
}

/** Shadow spread is only accepted on some nodes; retry without it instead of failing. */
function applyBoxSafe(f: FrameNode, el: ElementNode, ctx: BuildContext) {
  try {
    applyBox(f, el.box, ctx);
  } catch {
    applyBox(f, { ...el.box, shadows: el.box.shadows.map((s) => ({ ...s, spread: 0 })) }, ctx);
  }
}
