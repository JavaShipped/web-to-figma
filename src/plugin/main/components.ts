import { hash, isIcon, type ComponentSetPlan } from '../../shared/components';
import type { CaptureNode, SvgNode } from '../../shared/schema';

// Converts detected component groups into real components. For each variant, a copy of the first
// occurrence becomes the main component (placed on a "Components" board beside the page), and every
// occurrence on the page — including the first — is replaced by an instance with its own text,
// fills and sizing carried over as overrides. Inner components are converted first, so outer
// components contain instances of them.

export interface ComponentSummary {
  components: number;
  instances: number;
  icons: number;
  /** Component sets that couldn't be converted; their layers stay as plain frames. */
  failed: string[];
}

const GENERIC = new Set(['frame', 'icon', 'image', 'svg']);

export async function convertComponents(
  sets: ComponentSetPlan[],
  capture: CaptureNode,
  nodes: Map<string, SceneNode>,
  page: FrameNode,
  onProgress: (message: string) => void,
): Promise<ComponentSummary> {
  const summary: ComponentSummary = { components: 0, instances: 0, icons: 0, failed: [] };
  const board = figma.createFrame();
  board.name = `${page.name} — Components`;
  board.layoutMode = 'HORIZONTAL';
  board.layoutWrap = 'WRAP';
  board.itemSpacing = 48;
  board.counterAxisSpacing = 48;
  board.paddingTop = board.paddingBottom = board.paddingLeft = board.paddingRight = 48;
  board.fills = [{ type: 'SOLID', color: { r: 0.96, g: 0.96, b: 0.97 } }];
  board.cornerRadius = 16;
  board.resize(Math.max(page.width, 1200), 100);
  board.primaryAxisSizingMode = 'FIXED';
  board.counterAxisSizingMode = 'AUTO';
  board.x = page.x + page.width + 200;
  board.y = page.y;

  // Icons: one component per distinct small SVG.
  const icons = new Map<string, SvgNode[]>();
  const visit = (n: CaptureNode) => {
    if (isIcon(n)) {
      const key = hash((n as SvgNode).svg);
      icons.set(key, [...(icons.get(key) ?? []), n as SvgNode]);
    } else if (n.kind === 'element') n.children.forEach(visit);
  };
  visit(capture);
  if (icons.size) {
    const iconBoard = figma.createFrame();
    iconBoard.name = 'Icons';
    iconBoard.layoutMode = 'HORIZONTAL';
    iconBoard.layoutWrap = 'WRAP';
    iconBoard.itemSpacing = 16;
    iconBoard.counterAxisSpacing = 16;
    iconBoard.fills = [];
    iconBoard.resize(480, 10);
    iconBoard.primaryAxisSizingMode = 'FIXED';
    iconBoard.counterAxisSizingMode = 'AUTO';
    board.appendChild(iconBoard);
    let n = 0;
    for (const group of icons.values()) {
      const members = group.map((g) => nodes.get(g.id)).filter(alive);
      if (!members.length || members[0].type !== 'FRAME') continue;
      const label = group.map((g) => g.name).find((name) => !GENERIC.has(name.toLowerCase()));
      const main = makeMain(members[0], `Icon/${label ?? `Icon ${++n}`}`, iconBoard);
      summary.icons++;
      for (const m of members) {
        await replaceWithInstance(m, main);
        summary.instances++;
      }
    }
  }

  let done = 0;
  for (const set of sets) {
    onProgress(`Components ${++done}/${sets.length}`);
    try {
      await convertSet(set, nodes, board, summary);
    } catch (err) {
      // One bad set shouldn't lose the whole import.
      console.error(`Component ${set.name}:`, err);
      summary.failed.push(set.name);
    }
  }
  if (board.children.length === 0) board.remove();
  return summary;
}

async function convertSet(set: ComponentSetPlan, nodes: Map<string, SceneNode>, board: FrameNode, summary: ComponentSummary) {
  const mains: ComponentNode[] = [];
  for (const variant of set.variants) {
    const members = variant.nodeIds.map((id) => nodes.get(id)).filter(alive);
    if (!members.length) continue;
    const name = set.axes.length ? set.axes.map((a) => `${a}=${variant.props[a] ?? 'unset'}`).join(', ') : set.name;
    const main = makeMain(members[0], name, board);
    mains.push(main);
    for (const m of members) {
      const inst = await replaceWithInstance(m, main);
      for (const id of variant.nodeIds) if (nodes.get(id) === m) nodes.set(id, inst);
      summary.instances++;
    }
  }
  if (!mains.length) return;
  summary.components += mains.length;
  if (set.axes.length && mains.length > 1) {
    try {
      const cs = figma.combineAsVariants(mains, board);
      cs.name = set.name;
      cs.layoutMode = 'VERTICAL';
      cs.itemSpacing = 24;
      cs.paddingTop = cs.paddingBottom = cs.paddingLeft = cs.paddingRight = 24;
      cs.primaryAxisSizingMode = 'AUTO';
      cs.counterAxisSizingMode = 'AUTO';
    } catch {
      mains.forEach((m) => (m.name = `${set.name} / ${m.name}`));
    }
  } else if (mains.length === 1 && set.axes.length) {
    mains[0].name = set.name;
  }
}

function alive(n: SceneNode | undefined): n is SceneNode {
  return !!n && !n.removed;
}

function makeMain(template: SceneNode, name: string, board: FrameNode): ComponentNode {
  const copy = template.clone();
  board.appendChild(copy);
  if ('layoutPositioning' in copy) copy.layoutPositioning = 'AUTO';
  const main = figma.createComponentFromNode(copy);
  main.name = name;
  // On the board a main component keeps its measured size; instances decide fill/hug in place.
  if (main.layoutSizingHorizontal === 'FILL') main.layoutSizingHorizontal = 'FIXED';
  if (main.layoutSizingVertical === 'FILL') main.layoutSizingVertical = 'FIXED';
  return main;
}

async function replaceWithInstance(m: SceneNode, main: ComponentNode): Promise<InstanceNode> {
  const parent = m.parent as (BaseNode & ChildrenMixin) | null;
  const inst = main.createInstance();
  if (!parent) return inst;
  const p = parent as FrameNode;
  const isGrid = 'layoutMode' in p && p.layoutMode === 'GRID';
  const sizingH = 'layoutSizingHorizontal' in m ? m.layoutSizingHorizontal : 'FIXED';
  const sizingV = 'layoutSizingVertical' in m ? m.layoutSizingVertical : 'FIXED';
  const absolute = 'layoutPositioning' in m && m.layoutPositioning === 'ABSOLUTE';
  // Read everything needed from the occurrence now: in a grid it is removed before the instance
  // can take its cell.
  const { name, width, height } = m;

  if (isGrid) {
    const g = m as SceneNode & GridChildrenMixin;
    const [row, col, rowSpan, colSpan] = [g.gridRowAnchorIndex, g.gridColumnAnchorIndex, g.gridRowSpan, g.gridColumnSpan];
    await syncOverrides(m, inst, true);
    m.remove();
    try {
      p.appendChildAt(inst, row, col);
      if (colSpan > 1) inst.gridColumnSpan = colSpan;
      if (rowSpan > 1) inst.gridRowSpan = rowSpan;
    } catch {
      p.appendChild(inst);
    }
  } else {
    parent.insertChild(parent.children.indexOf(m), inst);
    if (absolute) inst.layoutPositioning = 'ABSOLUTE';
    inst.x = m.x;
    inst.y = m.y;
    await syncOverrides(m, inst, true);
  }
  inst.name = name;
  try {
    inst.resize(Math.max(0.01, width), Math.max(0.01, height));
  } catch {
    /* hugging */
  }
  for (const [axis, value] of [['layoutSizingHorizontal', sizingH], ['layoutSizingVertical', sizingV]] as const) {
    try {
      inst[axis] = value;
    } catch {
      /* not allowed here */
    }
  }
  if (!m.removed) m.remove();
  return inst;
}

/** Copies what differs between an occurrence and its instance onto the instance as overrides. */
/** `root`: the occurrence (a frame) against its new instance, so their types differ by design. */
async function syncOverrides(src: SceneNode, dst: SceneNode, root = false): Promise<void> {
  if (!root && src.type !== dst.type) return;
  try {
    if (src.visible !== dst.visible) dst.visible = src.visible;
    if (src.type === 'INSTANCE' && dst.type === 'INSTANCE') {
      const [a, b] = await Promise.all([src.getMainComponentAsync(), dst.getMainComponentAsync()]);
      if (a && b && a.id !== b.id) dst.swapComponent(a);
    }
    if (src.type === 'TEXT' && dst.type === 'TEXT') {
      await syncText(src, dst);
    } else {
      copyIfDifferent(src, dst, 'fills');
      copyIfDifferent(src, dst, 'strokes');
    }
    copyIfDifferent(src, dst, 'effects');
    if ('opacity' in src && 'opacity' in dst && src.opacity !== dst.opacity) dst.opacity = src.opacity;
  } catch {
    /* overrides are best effort */
  }
  if ('children' in src && 'children' in dst && src.children.length === dst.children.length) {
    for (let i = 0; i < src.children.length; i++) await syncOverrides(src.children[i], dst.children[i]);
  }
  // The instance's own size and sizing are set by replaceWithInstance.
  if (!root && 'layoutSizingHorizontal' in src && 'layoutSizingHorizontal' in dst) {
    try {
      if (src.layoutSizingHorizontal === 'FIXED' || src.layoutSizingVertical === 'FIXED') {
        if (Math.abs(src.width - dst.width) > 0.5 || Math.abs(src.height - dst.height) > 0.5) dst.resize(src.width, src.height);
      }
      if (dst.layoutSizingHorizontal !== src.layoutSizingHorizontal) dst.layoutSizingHorizontal = src.layoutSizingHorizontal;
      if (dst.layoutSizingVertical !== src.layoutSizingVertical) dst.layoutSizingVertical = src.layoutSizingVertical;
    } catch {
      /* size overrides are best effort */
    }
  }
}

function copyIfDifferent(src: SceneNode, dst: SceneNode, prop: 'fills' | 'strokes' | 'effects') {
  if (!(prop in src) || !(prop in dst)) return;
  const a = (src as unknown as Record<string, unknown>)[prop];
  const b = (dst as unknown as Record<string, unknown>)[prop];
  if (a === figma.mixed || JSON.stringify(a) === JSON.stringify(b)) return;
  (dst as unknown as Record<string, unknown>)[prop] = a;
}

const SEGMENT_FIELDS = ['fontName', 'fontSize', 'fills', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase', 'hyperlink', 'textStyleId'] as const;

async function syncText(src: TextNode, dst: TextNode) {
  const segs = src.getStyledTextSegments([...SEGMENT_FIELDS]);
  const same = src.characters === dst.characters && JSON.stringify(segs) === JSON.stringify(dst.getStyledTextSegments([...SEGMENT_FIELDS]));
  if (!same) {
    dst.characters = src.characters;
    for (const s of segs) {
      if (s.textStyleId) await dst.setRangeTextStyleIdAsync(s.start, s.end, s.textStyleId);
      else {
        dst.setRangeFontName(s.start, s.end, s.fontName);
        dst.setRangeFontSize(s.start, s.end, s.fontSize);
        dst.setRangeLineHeight(s.start, s.end, s.lineHeight);
        dst.setRangeLetterSpacing(s.start, s.end, s.letterSpacing);
      }
      dst.setRangeFills(s.start, s.end, s.fills);
      dst.setRangeTextDecoration(s.start, s.end, s.textDecoration);
      dst.setRangeTextCase(s.start, s.end, s.textCase);
      dst.setRangeHyperlink(s.start, s.end, s.hyperlink);
    }
  }
  if (src.textAlignHorizontal !== dst.textAlignHorizontal) dst.textAlignHorizontal = src.textAlignHorizontal;
  if (src.textAutoResize !== dst.textAutoResize) dst.textAutoResize = src.textAutoResize;
}
