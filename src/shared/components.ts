import type { CaptureNode, ElementNode } from './schema';
import type { PlanMap } from './layout';

// Decides which captured elements become Figma components, and which become variants of one set.
//
// 1. Framework components (React/Vue names found in dev builds, or data-component attributes) are
//    grouped by name. Props that take a few distinct values become variant properties
//    (e.g. Button variant=primary|secondary). Every framework component is a component, even if
//    used once.
// 2. Elsewhere, repeated identical structures (same tags, classes and layout) used 2+ times become
//    components, unless they only ever appear as one fixed part of a bigger repeated component.
// 3. Small SVGs become icon components, deduplicated by markup, so instances can swap icons.

export interface ComponentVariant {
  props: Record<string, string>;
  nodeIds: string[];
}

export interface ComponentSetPlan {
  name: string;
  source: 'framework' | 'structure';
  /** Variant property names; empty for a plain component. */
  axes: string[];
  variants: ComponentVariant[];
  /** Max subtree height of members. Convert smaller (inner) components first. */
  height: number;
}

export const ICON_MAX_SIZE = 64;

const TEXTY_PROPS = new Set([
  'id', 'href', 'src', 'alt', 'title', 'label', 'placeholder', 'name', 'value', 'defaultValue', 'key', 'to',
  'children', 'className', 'class', 'style', 'text', 'description', 'content', 'heading', 'subtitle', 'caption',
  'icon', 'image', 'url', 'email', 'date', 'price', 'count', 'index', 'testId',
]);

export function isIcon(node: CaptureNode): boolean {
  return node.kind === 'svg' && node.rect.width <= ICON_MAX_SIZE && node.rect.height <= ICON_MAX_SIZE;
}

/** Structural signature: identical signatures can share one main component. Text and images are slots. */
export function signature(node: CaptureNode, plans: PlanMap, withClass: boolean): string {
  switch (node.kind) {
    case 'text':
      return 'T';
    case 'image':
      return 'I';
    case 'svg':
      return isIcon(node) ? 'S' : `S#${hash(node.svg)}`;
    case 'element': {
      const p = plans.get(node.id);
      const layout = p ? `${p.mode}${p.wrap ? 'w' : ''}:${p.padding.map(Math.round).join(',')}:${Math.round(p.itemSpacing)}` : '';
      const cls = withClass ? `.${node.className ?? ''}` : '';
      const kids = node.children.map((c) => signature(c, plans, withClass)).join(',');
      return `${node.tag}${cls}|${layout}[${kids}]`;
    }
  }
}

export function detectComponents(root: ElementNode, plans: PlanMap): ComponentSetPlan[] {
  const parent = new Map<string, ElementNode>();
  const heights = new Map<string, number>();
  const all: ElementNode[] = [];
  const visit = (n: CaptureNode): number => {
    if (n.kind !== 'element') return 0;
    all.push(n);
    let h = 0;
    for (const c of n.children) {
      if (c.kind === 'element') parent.set(c.id, n);
      h = Math.max(h, visit(c) + 1);
    }
    heights.set(n.id, h);
    return h;
  };
  visit(root);

  const sets: ComponentSetPlan[] = [];
  const claimed = new Set<string>();

  // 1. Framework components.
  const byName = new Map<string, ElementNode[]>();
  for (const n of all) {
    if (!n.component || n === root) continue;
    const list = byName.get(n.component.name) ?? [];
    list.push(n);
    byName.set(n.component.name, list);
  }
  for (const [name, members] of byName) {
    const axes = variantAxes(members);
    const buckets = new Map<string, { props: Record<string, string>; bySig: Map<string, ElementNode[]> }>();
    for (const m of members) {
      const props: Record<string, string> = {};
      for (const a of axes) props[a] = cleanValue(m.component!.props[a]);
      const key = JSON.stringify(props);
      const b = buckets.get(key) ?? { props, bySig: new Map() };
      const sig = signature(m, plans, false);
      b.bySig.set(sig, [...(b.bySig.get(sig) ?? []), m]);
      buckets.set(key, b);
    }
    const variants: ComponentVariant[] = [];
    let needsLayoutAxis = false;
    for (const b of buckets.values()) {
      const groups = [...b.bySig.values()].sort((x, y) => y.length - x.length);
      if (groups.length > 1) needsLayoutAxis = true;
      groups.forEach((g, k) => variants.push({ props: { ...b.props, ...(groups.length > 1 ? { Layout: String(k + 1) } : {}) }, nodeIds: g.map((n) => n.id) }));
    }
    const finalAxes = needsLayoutAxis ? [...axes, 'Layout'] : axes;
    if (needsLayoutAxis) for (const v of variants) v.props.Layout ??= '1';
    for (const n of members) claimed.add(n.id);
    sets.push({ name, source: 'framework', axes: finalAxes, variants, height: maxHeight(members, heights) });
  }

  // 2. Repeated structures.
  const bySig = new Map<string, ElementNode[]>();
  for (const n of all) {
    if (n === root || claimed.has(n.id) || n.children.length === 0) continue;
    if (descendantCount(n) < 2) continue;
    const sig = signature(n, plans, true);
    bySig.set(sig, [...(bySig.get(sig) ?? []), n]);
  }
  const groups = [...bySig.values()].filter((g) => g.length >= 2 && !overlapping(g, parent));
  const groupOf = new Map<string, number>();
  groups.forEach((g, gi) => g.forEach((n) => groupOf.set(n.id, gi)));
  const frameworkMember = (id: string) => claimed.has(id);

  const keep = groups.map((g, gi) => {
    // Drop a group whose members are each exactly one fixed part of another group's members.
    const owners = g.map((n) => nearestOwner(n, parent, (id) => (groupOf.has(id) && groupOf.get(id) !== gi) || frameworkMember(id)));
    if (owners.some((o) => !o)) return true;
    const ownerKeys = new Set(owners.map((o) => (frameworkMember(o!.id) ? `f:${o!.component?.name}` : `s:${groupOf.get(o!.id)}`)));
    if (ownerKeys.size !== 1) return true;
    return new Set(owners.map((o) => o!.id)).size !== g.length;
  });
  let counter = 0;
  groups.forEach((g, gi) => {
    if (!keep[gi]) return;
    const name = structuralName(g[0]) ?? `Component ${++counter}`;
    sets.push({ name, source: 'structure', axes: [], variants: [{ props: {}, nodeIds: g.map((n) => n.id) }], height: maxHeight(g, heights) });
  });

  // Unique names: Figma allows duplicates but they are confusing in the assets panel.
  const seen = new Map<string, number>();
  for (const s of sets) {
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    if (n > 1) s.name = `${s.name} ${n}`;
  }
  return sets.sort((a, b) => a.height - b.height);
}

function variantAxes(members: ElementNode[]): string[] {
  const values = new Map<string, Set<string>>();
  for (const m of members) {
    for (const [k, v] of Object.entries(m.component!.props)) {
      if (TEXTY_PROPS.has(k) || k.startsWith('on') || k.startsWith('aria') || k.startsWith('data')) continue;
      const set = values.get(k) ?? new Set();
      set.add(cleanValue(v));
      values.set(k, set);
    }
  }
  // A prop missing on some instances still varies ("unset").
  for (const [k, set] of values) if (members.some((m) => !(k in m.component!.props))) set.add('unset');
  const axes: string[] = [];
  for (const [k, set] of values) {
    const isBoolish = [...set].every((v) => v === 'true' || v === 'false' || v === 'unset');
    if (set.size >= 2 && (isBoolish || set.size <= 6)) axes.push(k);
  }
  return axes.sort();
}

function cleanValue(v: unknown): string {
  if (v === undefined) return 'unset';
  return String(v).replace(/[=,]/g, ' ').trim() || 'empty';
}

/** Members nested in each other can't share one main component. */
function overlapping(group: ElementNode[], parent: Map<string, ElementNode>): boolean {
  const ids = new Set(group.map((n) => n.id));
  return group.some((n) => {
    for (let p = parent.get(n.id); p; p = parent.get(p.id)) if (ids.has(p.id)) return true;
    return false;
  });
}

function nearestOwner(n: ElementNode, parent: Map<string, ElementNode>, isOwner: (id: string) => boolean): ElementNode | null {
  for (let p = parent.get(n.id); p; p = parent.get(p.id)) if (isOwner(p.id)) return p;
  return null;
}

function descendantCount(n: ElementNode): number {
  let c = 0;
  for (const k of n.children) c += 1 + (k.kind === 'element' ? descendantCount(k) : 0);
  return c;
}

function maxHeight(nodes: ElementNode[], heights: Map<string, number>): number {
  return Math.max(...nodes.map((n) => heights.get(n.id) ?? 0));
}

const GENERIC_NAMES = new Set(['frame', 'div', 'span', 'section', 'container', 'wrapper', 'group']);

function structuralName(n: ElementNode): string | null {
  return GENERIC_NAMES.has(n.name.toLowerCase()) ? null : n.name;
}

export function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
