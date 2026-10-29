import type { CaptureNode, ElementNode, Rect } from './schema';

// Decides how each captured element becomes a Figma frame: auto layout direction, spacing, padding,
// alignment, and how every child is sized (fixed / hug / fill). Pure: geometry + computed CSS in,
// a plan out, so it can be unit-tested without Figma.
//
// Pass 1 (bottom-up) works out each element's layout and whether it could hug its content.
// Pass 2 (top-down) assigns sizing, because a child may only FILL an axis its parent doesn't HUG.

export type Sizing = 'FIXED' | 'HUG' | 'FILL';
export type Align = 'MIN' | 'CENTER' | 'MAX';
export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL';

/**
 * A transparent frame around a child. Figma has no margins or per-child alignment, so uneven spacing
 * becomes leading padding on a wrapper, and an off-majority alignment becomes a wrapper that fills
 * the counter axis and aligns its one child.
 */
export interface Wrapper {
  /** Extra space before the child on the parent's main axis. */
  padStart: number;
  /** Counter-axis alignment of the child inside the wrapper (null: wrapper only adds spacing). */
  align: Align | null;
  /** Counter-axis offset from the start edge, for children pushed in by a margin. */
  offset: number;
  sizingH: Sizing;
  sizingV: Sizing;
}

export interface ChildPlan {
  absolute: boolean;
  sizingH: Sizing;
  sizingV: Sizing;
  wrapper: Wrapper | null;
}

export interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  /** Size of the cell area the child sits in. */
  width: number;
  height: number;
}

/** CSS grid mapped onto Figma's grid auto layout. Builders fall back to `wrap` if it can't be applied. */
export interface GridPlan {
  columns: number[];
  rows: number[];
  columnGap: number;
  rowGap: number;
  /** All columns equal: use flexible (fr) tracks instead of fixed widths. */
  uniformColumns: boolean;
  /** Keyed by child index. */
  cells: Record<number, GridCell>;
}

export interface LayoutPlan {
  mode: LayoutMode;
  grid: GridPlan | null;
  wrap: boolean;
  itemSpacing: number;
  counterAxisSpacing: number;
  /** top, right, bottom, left */
  padding: [number, number, number, number];
  primaryAlign: Align | 'SPACE_BETWEEN';
  counterAlign: Align | 'BASELINE';
  /** Child indices in append order: negative-z absolutes, flow children in visual order, other absolutes. */
  order: number[];
  /** Indexed like `node.children`. */
  children: ChildPlan[];
  canHugH: boolean;
  canHugV: boolean;
}

export type PlanMap = Map<string, LayoutPlan>;

const TOL = 1.5;
const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol;

type Axis = 'H' | 'V';
const start = (r: Rect, a: Axis) => (a === 'H' ? r.x : r.y);
const size = (r: Rect, a: Axis) => (a === 'H' ? r.width : r.height);
const end = (r: Rect, a: Axis) => start(r, a) + size(r, a);
const other = (a: Axis): Axis => (a === 'H' ? 'V' : 'H');

interface Draft {
  plan: LayoutPlan;
  /** Per child: geometric counter-axis fit, used in pass 2. */
  counterFit: ('FILL' | Align | 'OFFSET')[];
  flex: boolean;
}

export function isAbsolute(node: CaptureNode): boolean {
  return node.layout.position === 'absolute' || node.layout.position === 'fixed';
}

export function planLayouts(root: ElementNode, opts: { autoLayout?: boolean } = {}): PlanMap {
  const drafts = new Map<string, Draft>();
  const autoLayout = opts.autoLayout ?? true;

  const analyzeTree = (node: ElementNode) => {
    for (const c of node.children) if (c.kind === 'element') analyzeTree(c);
    drafts.set(node.id, analyze(node, autoLayout, (n, a) => canHug(n, a, drafts)));
  };
  analyzeTree(root);

  const plans: PlanMap = new Map();
  const rootPlan = drafts.get(root.id)!.plan;
  assign(root, 'FIXED', rootPlan.canHugV ? 'HUG' : 'FIXED', drafts, plans);
  return plans;
}

function analyze(node: ElementNode, autoLayout: boolean, childCanHug: (n: CaptureNode, a: Axis) => boolean): Draft {
  const L = node.layout;
  const kids = node.children;
  const css: [number, number, number, number] = [0, 1, 2, 3].map((i) => L.padding[i] + L.border[i]) as never;
  const flowIdx: number[] = [];
  const absIdx: number[] = [];
  kids.forEach((c, i) => (isAbsolute(c) ? absIdx : flowIdx).push(i));

  const plan: LayoutPlan = {
    mode: 'NONE',
    grid: null,
    wrap: false,
    itemSpacing: 0,
    counterAxisSpacing: 0,
    padding: [...css],
    primaryAlign: 'MIN',
    counterAlign: 'MIN',
    order: [],
    children: kids.map(() => ({ absolute: true, sizingH: 'FIXED', sizingV: 'FIXED', wrapper: null })),
    canHugH: false,
    canHugV: false,
  };
  const counterFit: Draft['counterFit'] = kids.map(() => 'MIN');
  const isFlex = L.display === 'flex' || L.display === 'inline-flex';
  const isGrid = L.display === 'grid' || L.display === 'inline-grid';

  const byZ = (i: number) => kids[i].layout.zIndex ?? 0;
  const absBelow = absIdx.filter((i) => byZ(i) < 0).sort((a, b) => byZ(a) - byZ(b));
  const absAbove = absIdx.filter((i) => byZ(i) >= 0).sort((a, b) => byZ(a) - byZ(b));
  const finish = (flowOrder: number[]): Draft => {
    plan.order = [...absBelow, ...flowOrder, ...absAbove];
    return { plan, counterFit, flex: isFlex };
  };

  if (!autoLayout || flowIdx.length === 0) return finish(flowIdx);

  const rects = kids.map((c) => c.rect);
  let mode: LayoutMode = 'NONE';
  let wrap = false;

  if (isFlex && L.flexDirection.startsWith('row')) {
    mode = 'HORIZONTAL';
    wrap = L.flexWrap && rowsOf(flowIdx, rects).length > 1;
  } else if (isFlex && !L.flexWrap) {
    mode = 'VERTICAL';
  } else if (isGrid && L.gridColumns.length > 1) {
    mode = 'HORIZONTAL';
    wrap = rowsOf(flowIdx, rects).length > 1;
  } else {
    mode = geometricMode(flowIdx, rects);
    if (mode === 'HORIZONTAL') wrap = rowsOf(flowIdx, rects).length > 1;
  }
  if (mode === 'NONE') return finish(flowIdx);

  const main: Axis = mode === 'HORIZONTAL' ? 'H' : 'V';
  const counter = other(main);
  const nr = node.rect;

  // Visual order along the main axis (also undoes row-reverse / column-reverse / `order`).
  let flow: number[];
  let rows: number[][] = [];
  if (wrap) {
    rows = rowsOf(flowIdx, rects).map((r) => r.sort((a, b) => rects[a].x - rects[b].x));
    flow = rows.flat();
  } else {
    flow = [...flowIdx].sort((a, b) => start(rects[a], main) - start(rects[b], main));
    if (!wrap && overlapsTooMuch(flow, rects, main)) return finish(flowIdx);
  }

  // Alignment on the main axis.
  const reversed = isFlex && L.flexDirection.endsWith('reverse');
  let primary: LayoutPlan['primaryAlign'] = 'MIN';
  if (isFlex) primary = justifyToAlign(L.justifyContent, reversed, flow.length);
  else if (mode === 'HORIZONTAL') primary = textAlignToAlign(L.textAlign);

  // Spacing between items.
  const extras = new Map<number, number>();
  if (wrap) {
    const hGaps = rows.flatMap((r) => r.slice(1).map((i, k) => rects[i].x - end(rects[r[k]], 'H')));
    plan.itemSpacing = hGaps.length ? round(Math.min(...hGaps)) : L.columnGap;
    const vGaps = rows.slice(1).map((r, k) => Math.min(...r.map((i) => rects[i].y)) - Math.max(...rows[k].map((i) => end(rects[i], 'V'))));
    plan.counterAxisSpacing = vGaps.length ? round(Math.max(0, Math.min(...vGaps))) : L.rowGap;
  } else if (primary !== 'SPACE_BETWEEN' && flow.length > 1) {
    const gaps = flow.slice(1).map((i, k) => start(rects[i], main) - end(rects[flow[k]], main));
    const min = Math.min(...gaps);
    const uniform = gaps.every((g) => near(g, gaps[0]));
    plan.itemSpacing = round(uniform ? median(gaps) : min);
    if (!uniform) {
      gaps.forEach((g, k) => {
        if (g - min > TOL) extras.set(flow[k + 1], round(g - min));
      });
    }
  }

  // Padding: CSS padding + border, except the leading main-axis edge, which is measured so that a
  // first child's margin is kept. SPACE_BETWEEN measures both ends (space-around/evenly).
  const pad = [...css] as [number, number, number, number];
  const startIdx = main === 'H' ? 3 : 0;
  const endIdx = main === 'H' ? 1 : 2;
  if (primary === 'MIN' || primary === 'SPACE_BETWEEN') {
    pad[startIdx] = Math.max(0, round(Math.min(...flow.map((i) => start(rects[i], main))) - start(nr, main)));
  }
  if (primary === 'SPACE_BETWEEN') {
    pad[endIdx] = Math.max(0, round(end(nr, main) - Math.max(...flow.map((i) => end(rects[i], main)))));
  }
  plan.padding = pad;
  if (isGrid && mode === 'HORIZONTAL') plan.grid = gridPlan(node, flow, rects, pad);

  // Counter-axis fit of each child against the content box.
  const cStartIdx = counter === 'H' ? 3 : 0;
  const cEndIdx = counter === 'H' ? 1 : 2;
  const cS = start(nr, counter) + pad[cStartIdx];
  const cE = end(nr, counter) - pad[cEndIdx];
  for (const i of flow) {
    const s = start(rects[i], counter);
    const e = end(rects[i], counter);
    if (near(s, cS) && near(e, cE)) counterFit[i] = 'FILL';
    else if (near(s, cS)) counterFit[i] = 'MIN';
    else if (near(e, cE)) counterFit[i] = 'MAX';
    else if (near((s + e) / 2, (cS + cE) / 2)) counterFit[i] = 'CENTER';
    else counterFit[i] = 'OFFSET';
  }

  let counterAlign: LayoutPlan['counterAlign'];
  if (isFlex) counterAlign = alignItemsToAlign(L.alignItems, mode);
  else counterAlign = majority(flow.map((i) => counterFit[i]));

  // Children whose counter alignment differs from the container's get an aligning wrapper.
  for (const i of flow) {
    const fit = counterFit[i];
    const extra = extras.get(i) ?? 0;
    let align: Align | null = null;
    let offset = 0;
    if (!wrap && counterAlign !== 'BASELINE' && fit !== 'FILL' && fit !== counterAlign) {
      const self = isFlex ? alignItemsToAlign(kids[i].layout.alignSelf, mode) : null;
      if (fit === 'OFFSET') {
        align = 'MIN';
        offset = Math.max(0, round(start(rects[i], counter) - cS));
      } else if (!(self && self === fit && counterAlign === fit)) {
        align = fit;
      }
    }
    if (align === counterAlign && offset === 0) align = null;
    plan.children[i] = {
      absolute: false,
      sizingH: 'FIXED',
      sizingV: 'FIXED',
      wrapper: extra > 0 || align !== null ? { padStart: extra, align, offset, sizingH: 'HUG', sizingV: 'HUG' } : null,
    };
  }

  plan.mode = mode;
  plan.wrap = wrap;
  plan.primaryAlign = primary;
  plan.counterAlign = counterAlign;

  // Could this frame hug its content on each axis?
  const childSize = (i: number, a: Axis) => {
    const w = plan.children[i].wrapper;
    const base = size(rects[i], a);
    if (!w) return base;
    return base + (a === main ? w.padStart : w.offset);
  };
  const p = plan.padding;
  const padH = p[1] + p[3];
  const padV = p[0] + p[2];
  let extentMain: number;
  let extentCounter: number;
  if (wrap) {
    extentMain = Math.max(...rows.map((r) => r.reduce((s, i) => s + childSize(i, main), 0) + plan.itemSpacing * (r.length - 1)));
    extentCounter =
      rows.reduce((s, r) => s + Math.max(...r.map((i) => childSize(i, counter))), 0) + plan.counterAxisSpacing * (rows.length - 1);
  } else {
    extentMain = flow.reduce((s, i) => s + childSize(i, main), 0) + plan.itemSpacing * (flow.length - 1);
    extentCounter = Math.max(...flow.map((i) => childSize(i, counter)));
  }
  const hugMain = primary !== 'SPACE_BETWEEN' && near(extentMain + (main === 'H' ? padH : padV), size(nr, main));
  // A child that spans the content box but can't size itself (wrapping text, a block) takes its
  // width from this frame, so the frame should be fixed and the child fill, not the reverse.
  const sizedByParent = !wrap && flow.some((i) => counterFit[i] === 'FILL' && !childCanHug(kids[i], counter));
  const hugCounter = !sizedByParent && near(extentCounter + (counter === 'H' ? padH : padV), size(nr, counter));
  // Flexible grid tracks need a container width to divide.
  plan.canHugH = plan.grid ? false : main === 'H' ? hugMain : hugCounter;
  plan.canHugV = main === 'V' ? hugMain : hugCounter;
  return finish(flow);
}

function assign(node: ElementNode, selfH: Sizing, selfV: Sizing, drafts: Map<string, Draft>, plans: PlanMap) {
  const draft = drafts.get(node.id)!;
  const plan = draft.plan;
  plans.set(node.id, plan);

  node.children.forEach((child, i) => {
    const cp = plan.children[i];
    let h: Sizing;
    let v: Sizing;
    if (cp.absolute || plan.mode === 'NONE') {
      h = canHug(child, 'H', drafts) ? 'HUG' : 'FIXED';
      v = canHug(child, 'V', drafts) ? 'HUG' : 'FIXED';
    } else if (plan.grid?.cells[i]) {
      // Grid items stretch to their cell. In a row of equal-height (stretched) items the naturally
      // tallest one can hug; the rest fill the row.
      const cell = plan.grid.cells[i];
      h = near(child.rect.width, cell.width) && selfH !== 'HUG' ? 'FILL' : canHug(child, 'H', drafts) ? 'HUG' : 'FIXED';
      v = canHug(child, 'V', drafts) ? 'HUG' : near(child.rect.height, cell.height) ? 'FILL' : 'FIXED';
    } else {
      const main: Axis = plan.mode === 'HORIZONTAL' ? 'H' : 'V';
      const counter = other(main);
      const parentMain = main === 'H' ? selfH : selfV;
      const parentCounter = counter === 'H' ? selfH : selfV;
      const wantsFillMain = draft.flex && !plan.wrap && child.layout.flexGrow > 0;
      const mainS: Sizing =
        wantsFillMain && parentMain !== 'HUG' ? 'FILL' : canHug(child, main, drafts) ? 'HUG' : 'FIXED';
      const fillCounter = !plan.wrap && draft.counterFit[i] === 'FILL' && parentCounter !== 'HUG';
      const counterS: Sizing = fillCounter ? 'FILL' : canHug(child, counter, drafts) ? 'HUG' : 'FIXED';
      h = main === 'H' ? mainS : counterS;
      v = main === 'V' ? mainS : counterS;

      const w = cp.wrapper;
      if (w) {
        const wrapMain: Sizing = mainS === 'FILL' ? 'FILL' : 'HUG';
        let wrapCounter: Sizing = counterS === 'FILL' ? 'FILL' : 'HUG';
        if (w.align) wrapCounter = parentCounter === 'HUG' ? 'FIXED' : 'FILL';
        w.sizingH = main === 'H' ? wrapMain : wrapCounter;
        w.sizingV = main === 'V' ? wrapMain : wrapCounter;
      }
    }
    cp.sizingH = h;
    cp.sizingV = v;
    if (child.kind === 'element') assign(child, h, v, drafts, plans);
  });
}

function canHug(node: CaptureNode, axis: Axis, drafts: Map<string, Draft>): boolean {
  if (node.kind === 'text') return axis === 'V' || node.lineCount <= 1;
  if (node.kind !== 'element') return false;
  const plan = drafts.get(node.id)?.plan;
  if (!plan || plan.mode === 'NONE') return false;
  return axis === 'H' ? plan.canHugH : plan.canHugV;
}

function gridPlan(node: ElementNode, flow: number[], rects: Rect[], pad: number[]): GridPlan | null {
  const L = node.layout;
  const cols = L.gridColumns;
  const rows = L.gridRows.length ? L.gridRows : [node.rect.height - pad[0] - pad[2]];
  const starts = (sizes: number[], gap: number, origin: number) => {
    const out: number[] = [];
    let at = origin;
    for (const s of sizes) {
      out.push(at);
      at += s + gap;
    }
    return out;
  };
  const colStarts = starts(cols, L.columnGap, node.rect.x + pad[3]);
  const rowStarts = starts(rows, L.rowGap, node.rect.y + pad[0]);
  const colEnds = colStarts.map((s, i) => s + cols[i]);
  const rowEnds = rowStarts.map((s, i) => s + rows[i]);
  // The track an item starts in, and the one it ends in (items may be smaller than their area).
  const span = (startsAt: number[], endsAt: number[], s: number, e: number) => {
    let a = -1;
    for (let k = 0; k < startsAt.length; k++) if (startsAt[k] <= s + TOL) a = k;
    if (a < 0) return null;
    for (let b = a; b < endsAt.length; b++) if (endsAt[b] >= e - TOL) return [a, b] as const;
    return null;
  };
  const cells: Record<number, GridCell> = {};
  const used = new Set<string>();
  for (const i of flow) {
    const r = rects[i];
    const c = span(colStarts, colEnds, r.x, r.x + r.width);
    const w = span(rowStarts, rowEnds, r.y, r.y + r.height);
    if (!c || !w) return null;
    for (let y = w[0]; y <= w[1]; y++) {
      for (let x = c[0]; x <= c[1]; x++) {
        const key = `${y}:${x}`;
        if (used.has(key)) return null;
        used.add(key);
      }
    }
    cells[i] = {
      row: w[0],
      col: c[0],
      rowSpan: w[1] - w[0] + 1,
      colSpan: c[1] - c[0] + 1,
      width: colEnds[c[1]] - colStarts[c[0]],
      height: rowEnds[w[1]] - rowStarts[w[0]],
    };
  }
  return {
    columns: cols.map(round),
    rows: rows.map(round),
    columnGap: L.columnGap,
    rowGap: L.rowGap,
    uniformColumns: cols.every((c) => near(c, cols[0], 0.5)),
    cells,
  };
}

function geometricMode(flow: number[], rects: Rect[]): LayoutMode {
  if (flow.length === 1) return 'VERTICAL';
  const byY = [...flow].sort((a, b) => rects[a].y - rects[b].y);
  const stacked = byY.slice(1).every((i, k) => rects[i].y >= end(rects[byY[k]], 'V') - TOL);
  if (stacked) return 'VERTICAL';
  const rows = rowsOf(flow, rects);
  const rowsClean = rows.every((r) => {
    const s = [...r].sort((a, b) => rects[a].x - rects[b].x);
    return s.slice(1).every((i, k) => rects[i].x >= end(rects[s[k]], 'H') - TOL);
  });
  return rowsClean ? 'HORIZONTAL' : 'NONE';
}

/** Groups children into visual rows: a child starts a new row when it is entirely below the current one. */
function rowsOf(flow: number[], rects: Rect[]): number[][] {
  const byY = [...flow].sort((a, b) => rects[a].y - rects[b].y || rects[a].x - rects[b].x);
  const rows: number[][] = [];
  let rowBottom = -Infinity;
  for (const i of byY) {
    if (rows.length === 0 || rects[i].y >= rowBottom - TOL) {
      rows.push([i]);
      rowBottom = end(rects[i], 'V');
    } else {
      rows[rows.length - 1].push(i);
      rowBottom = Math.max(rowBottom, end(rects[i], 'V'));
    }
  }
  return rows;
}

/** True when neighbours overlap by more than half of the smaller one (stacked/overlaid, not a list). */
function overlapsTooMuch(flow: number[], rects: Rect[], main: Axis): boolean {
  return flow.slice(1).some((i, k) => {
    const prev = rects[flow[k]];
    const overlap = end(prev, main) - start(rects[i], main);
    return overlap > Math.min(size(prev, main), size(rects[i], main)) / 2 + TOL;
  });
}

function justifyToAlign(v: string, reversed: boolean, count: number): LayoutPlan['primaryAlign'] {
  if (v.includes('space')) return count > 1 ? 'SPACE_BETWEEN' : 'CENTER';
  if (v === 'center') return 'CENTER';
  const isEnd = v === 'flex-end' || v === 'end' || v === 'right';
  return isEnd !== reversed ? 'MAX' : 'MIN';
}

function alignItemsToAlign(v: string, mode: LayoutMode): LayoutPlan['counterAlign'] {
  if (v === 'center') return 'CENTER';
  if (v === 'flex-end' || v === 'end' || v === 'self-end') return 'MAX';
  if (v.includes('baseline')) return mode === 'HORIZONTAL' ? 'BASELINE' : 'MIN';
  return 'MIN';
}

function textAlignToAlign(v: string): Align {
  if (v === 'center') return 'CENTER';
  if (v === 'right') return 'MAX';
  return 'MIN';
}

function majority(fits: Draft['counterFit']): Align {
  const counts: Record<Align, number> = { MIN: 0, CENTER: 0, MAX: 0 };
  for (const f of fits) if (f === 'MIN' || f === 'CENTER' || f === 'MAX') counts[f]++;
  if (counts.CENTER > counts.MIN && counts.CENTER >= counts.MAX) return 'CENTER';
  if (counts.MAX > counts.MIN && counts.MAX > counts.CENTER) return 'MAX';
  return 'MIN';
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
