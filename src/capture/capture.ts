import { parseColor } from '../shared/color';
import { parseBackgroundImage, parseFontFamily, parseShadows, px, splitTopLevel } from '../shared/css-parse';
import {
  CAPTURE_FORMAT,
  CAPTURE_VERSION,
  compactDocument,
  DEFAULT_LAYOUT,
  type BorderSide,
  type BoxStyle,
  type CaptureDocument,
  type CaptureNode,
  type ComponentRef,
  type ElementNode,
  type ImageAsset,
  type ImageNode,
  type LayoutStyle,
  type Paint,
  type Rect,
  type SvgNode,
  type TextNode,
  type TextStyle,
} from '../shared/schema';
import { normalizeRuns, type RawRun } from '../shared/text';
import { elementName, textName } from './names';
import { materializePseudos } from './pseudo';
import { serializeSvg } from './svg';
import { readColorTokens } from './tokens';

// Walks the live DOM and records what the browser rendered: boxes, computed styles, text runs,
// images and SVGs. Runs inside the page (content script or dev harness).

export type LoadedImage = { kind: 'raster'; asset: ImageAsset } | { kind: 'svg'; svg: string };

/** Fetches an image. `allowSvg` false means the caller needs a raster (e.g. a CSS background). */
export type ImageLoader = (url: string, maxWidth: number, maxHeight: number, allowSvg: boolean) => Promise<LoadedImage | null>;

export interface CaptureOptions {
  /** Element to capture; the whole page when omitted. */
  root?: Element | null;
  loadImage: ImageLoader;
  /** Scroll through the page first so lazy-loaded images and content appear. */
  scrollFirst?: boolean;
  onProgress?: (message: string) => void;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE']);
const INLINE_BLOCKERS = new Set([
  'IMG', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'VIDEO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'PICTURE',
]);
const PROBE_ATTRS = ['data-w2f-component', 'data-w2f-chain', 'data-w2f-props', 'data-w2f-source'];

type Deco = TextStyle['decoration'];
type ApplyImage = (assetId: string | null, svg?: string) => void;

class Session {
  private next = 0;
  readonly images = new Map<string, { url: string; allowSvg: boolean; maxW: number; maxH: number; apply: ApplyImage[] }>();

  id(): string {
    return `n${(this.next++).toString(36)}`;
  }

  requestImage(url: string, width: number, height: number, allowSvg: boolean, apply: ApplyImage) {
    if (!url || url.startsWith('about:')) return apply(null);
    const key = `${allowSvg ? 'v' : 'r'}|${url}`;
    const req = this.images.get(key) ?? { url, allowSvg, maxW: 0, maxH: 0, apply: [] };
    // Keep 2x the largest rendered size for retina sharpness without shipping huge originals.
    req.maxW = Math.max(req.maxW, Math.ceil(width * 2), 32);
    req.maxH = Math.max(req.maxH, Math.ceil(height * 2), 32);
    req.apply.push(apply);
    this.images.set(key, req);
  }

  async resolveImages(loader: ImageLoader, assets: Record<string, ImageAsset>, onProgress?: (m: string) => void) {
    const reqs = [...this.images.values()];
    let done = 0;
    let assetCount = 0;
    await pool(reqs, 6, async (req) => {
      let res: LoadedImage | null = null;
      try {
        res = await loader(req.url, req.maxW, req.maxH, req.allowSvg);
      } catch {
        res = null;
      }
      let id: string | null = null;
      if (res?.kind === 'raster') {
        id = `a${assetCount++}`;
        assets[id] = res.asset;
      }
      for (const apply of req.apply) apply(id, res?.kind === 'svg' ? res.svg : undefined);
      onProgress?.(`Loading images ${++done}/${reqs.length}`);
    });
  }
}

export async function capture(opts: CaptureOptions): Promise<CaptureDocument> {
  const scroll = [window.scrollX, window.scrollY];
  const target = opts.root ?? document.body;
  if (opts.scrollFirst) await scrollThrough(opts.onProgress);
  window.scrollTo(0, 0);
  await frames(2);

  const restorePseudos = materializePseudos(target);
  const s = new Session();
  let root: ElementNode;
  try {
    opts.onProgress?.('Reading layout…');
    const nodes = walk(target, s, 'none');
    root = asRoot(nodes, target, s);
    if (!opts.root) fitToDocument(root);
  } finally {
    restorePseudos();
    for (const el of Array.from(document.querySelectorAll('[data-w2f-component]'))) {
      for (const a of PROBE_ATTRS) el.removeAttribute(a);
    }
    window.scrollTo(scroll[0], scroll[1]);
  }

  const assets: Record<string, ImageAsset> = {};
  await s.resolveImages(opts.loadImage, assets, opts.onProgress);

  return compactDocument({
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    root,
    assets,
    colorTokens: readColorTokens(),
  });
}

function asRoot(nodes: CaptureNode[], el: Element, s: Session): ElementNode {
  if (nodes.length === 1 && nodes[0].kind === 'element') return nodes[0];
  const rect = docRect(el.getBoundingClientRect());
  return {
    kind: 'element',
    id: s.id(),
    name: elementName(el),
    tag: el.tagName.toLowerCase(),
    rect,
    layout: { ...DEFAULT_LAYOUT, display: 'block' },
    box: emptyBox(),
    children: nodes,
  };
}

/** The page frame covers the whole document and gets the canvas background. */
function fitToDocument(root: ElementNode) {
  const de = document.documentElement;
  root.rect = { x: 0, y: 0, width: de.scrollWidth, height: Math.max(de.scrollHeight, document.body.scrollHeight) };
  root.name = document.title || location.hostname || 'Page';
  root.layout = { ...root.layout, position: 'static' };
  if (!root.box.backgrounds.some((p) => p.type === 'solid' && p.color.a > 0)) {
    const htmlBg = parseColor(getComputedStyle(de).backgroundColor);
    const base = htmlBg && htmlBg.a > 0 ? htmlBg : { r: 1, g: 1, b: 1, a: 1 };
    root.box.backgrounds.unshift({ type: 'solid', color: base });
  }
}

function walk(el: Element, s: Session, deco: Deco): CaptureNode[] {
  if (SKIP_TAGS.has(el.tagName) || el.hasAttribute('data-w2f-ui')) return [];
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return [];
  const ownDeco = mergeDecoration(deco, cs);
  if (cs.display === 'contents') return childrenOf(el, cs, s, ownDeco);
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return [];

  const r = el.getBoundingClientRect();
  const rect = docRect(r);
  if (rect.width <= 1 && rect.height <= 1) return []; // sr-only text, tracking pixels
  if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return []; // off-canvas menus

  const tag = el.tagName.toLowerCase();
  const layout = layoutStyle(cs);
  const box = boxStyle(cs, rect, s);
  const component = readComponent(el);
  const name = elementName(el, component?.name);
  const base = { id: s.id(), name, rect, layout };

  if (el instanceof SVGSVGElement) {
    return [{ ...base, kind: 'svg', svg: serializeSvg(el, rect.width, rect.height), box } satisfies SvgNode];
  }
  if (el instanceof SVGElement) return [];
  if (tag === 'img') return [imageNode(el as HTMLImageElement, base, cs, box, s)];
  if (tag === 'video' || tag === 'canvas') return [mediaNode(el, base, box, s)];
  if (tag === 'iframe' || tag === 'object' || tag === 'embed') {
    box.backgrounds.push({ type: 'solid', color: { r: 0.9, g: 0.9, b: 0.92, a: 1 } });
    return [{ ...base, kind: 'element', tag, name: 'Embedded frame', box, children: [] }];
  }

  // Gradient text: the background paints the glyphs, not the box.
  let textFill: Paint | undefined;
  const clip = cs.getPropertyValue('background-clip') || cs.getPropertyValue('-webkit-background-clip');
  if (clip.includes('text')) {
    textFill = [...box.backgrounds].reverse().find((p) => p.type !== 'image');
    box.backgrounds = [];
  }

  const node: ElementNode = {
    ...base,
    kind: 'element',
    tag,
    className: typeof el.className === 'string' && el.className ? el.className : undefined,
    component,
    box,
    children: [],
  };

  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    node.children = formControlChildren(el as HTMLInputElement, cs, rect, s, node);
    return [node];
  }

  if (isTextLeaf(el)) {
    const text = textFromLeaf(el, cs, rect, ownDeco, s, textFill);
    if (!text) return [node];
    if (!component && isPlainBox(box, layout) && sameRect(text.rect, rect)) {
      // No box of its own: the element *is* the text layer.
      return [{ ...text, id: base.id, name: text.name, rect, layout }];
    }
    node.children = [text];
    return [node];
  }

  node.children = childrenOf(el, cs, s, ownDeco);
  return [node];
}

function childrenOf(el: Element, cs: CSSStyleDeclaration, s: Session, deco: Deco): CaptureNode[] {
  const out: CaptureNode[] = [];
  for (const n of childNodesOf(el)) {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = textFromDomNode(n as Text, cs, deco, s);
      if (t) out.push(t);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      out.push(...walk(n as Element, s, deco));
    }
  }
  return out;
}

/** Light DOM children, or the rendered shadow tree with slots resolved. */
function childNodesOf(el: Element): Node[] {
  if (el.tagName === 'SLOT') {
    const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
    return assigned.length ? assigned : Array.from(el.childNodes);
  }
  if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
  return Array.from(el.childNodes);
}

// ---------- text ----------


function isTextLeaf(el: Element): boolean {
  if (el.shadowRoot) return false;
  let hasText = false;
  const check = (parent: Element): boolean => {
    for (const n of childNodesOf(parent)) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (/\S/.test((n as Text).data)) hasText = true;
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const c = n as Element;
      if (c.tagName === 'BR' || SKIP_TAGS.has(c.tagName)) continue;
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none') continue;
      if (ccs.display !== 'inline' || INLINE_BLOCKERS.has(c.tagName) || c instanceof SVGElement) return false;
      if (ccs.position === 'absolute' || ccs.position === 'fixed') return false;
      if (hasVisualBox(ccs) && !isGradientText(ccs)) return false;
      if (readComponent(c)) return false; // keep component boundaries, e.g. <a data-slot="nav-link">
      if (!check(c)) return false;
    }
    return true;
  };
  return check(el) && hasText;
}

function textFromLeaf(el: Element, cs: CSSStyleDeclaration, rect: Rect, deco: Deco, s: Session, fill?: Paint): TextNode | null {
  const raw: RawRun[] = [];
  collectRuns(el, cs, deco, undefined, raw);
  const runs = normalizeRuns(raw);
  if (!runs.length) return null;
  const range = document.createRange();
  range.selectNodeContents(el);
  const lineCount = countLines(range.getClientRects());
  const glyphs = docRect(range.getBoundingClientRect());
  // In flex/grid containers the text is an anonymous item placed by the container, so use its line box.
  const flexish = cs.display.includes('flex') || cs.display.includes('grid');
  const textRect = flexish && lineCount <= 1 ? lineBox(glyphs, runs[0].style) : contentBox(rect, cs);
  return {
    kind: 'text',
    id: s.id(),
    name: textName(runs.map((r) => r.text).join('')),
    rect: textRect,
    layout: { ...DEFAULT_LAYOUT },
    runs,
    align: textAlign(cs.textAlign),
    lineCount,
    hugs: lineCount <= 1 && Math.abs(glyphs.width - textRect.width) <= 2,
    fill,
  };
}

/** The line box around single-line glyphs: what the browser lays out, not the font's ink box. */
function lineBox(glyphs: Rect, style: TextStyle): Rect {
  if (!style.lineHeight) return glyphs;
  const mid = glyphs.y + glyphs.height / 2;
  return { ...glyphs, y: mid - style.lineHeight / 2, height: style.lineHeight };
}

function textFromDomNode(t: Text, parentCs: CSSStyleDeclaration, deco: Deco, s: Session): TextNode | null {
  if (!/\S/.test(t.data)) return null;
  const range = document.createRange();
  range.selectNodeContents(t);
  const r = range.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const runs = normalizeRuns([{ text: t.data, style: textStyle(parentCs, deco), ws: wsMode(parentCs) }]);
  if (!runs.length) return null;
  const lines = countLines(range.getClientRects());
  return {
    kind: 'text',
    id: s.id(),
    name: textName(runs[0].text),
    rect: lines <= 1 ? lineBox(docRect(r), runs[0].style) : docRect(r),
    layout: { ...DEFAULT_LAYOUT },
    runs,
    align: 'left',
    lineCount: lines,
  };
}

function collectRuns(el: Element, cs: CSSStyleDeclaration, deco: Deco, href: string | undefined, out: RawRun[], fill?: Paint) {
  for (const n of childNodesOf(el)) {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push({ text: (n as Text).data, style: textStyle(cs, deco), ws: wsMode(cs), href, fill });
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const c = n as Element;
      if (SKIP_TAGS.has(c.tagName)) continue;
      if (c.tagName === 'BR') {
        out.push({ text: '\n', style: textStyle(cs, deco), ws: 'preserve', href, br: true });
        continue;
      }
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none') continue;
      const link = c.tagName === 'A' ? (c as HTMLAnchorElement).href : href;
      const r = c.getBoundingClientRect();
      const ownFill = isGradientText(ccs) ? gradientOf(ccs, r.width, r.height) : undefined;
      collectRuns(c, ccs, mergeDecoration(deco, ccs), link, out, ownFill ?? fill);
    }
  }
}

function textStyle(cs: CSSStyleDeclaration, deco: Deco): TextStyle {
  return {
    fontFamily: parseFontFamily(cs.fontFamily),
    fontWeight: parseInt(cs.fontWeight, 10) || 400,
    italic: cs.fontStyle !== 'normal',
    fontSize: px(cs.fontSize),
    lineHeight: cs.lineHeight === 'normal' ? null : px(cs.lineHeight),
    letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
    color: textColor(cs),
    decoration: deco,
    transform: (['uppercase', 'lowercase', 'capitalize'] as const).find((t) => t === cs.textTransform) ?? 'none',
  };
}

function textColor(cs: CSSStyleDeclaration) {
  const base = parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const fill = parseColor(cs.getPropertyValue('-webkit-text-fill-color'));
  return fill && fill.a > 0 ? fill : base;
}

function mergeDecoration(parent: Deco, cs: CSSStyleDeclaration): Deco {
  const line = cs.textDecorationLine || '';
  if (line.includes('line-through')) return 'line-through';
  if (line.includes('underline')) return 'underline';
  return parent;
}

function wsMode(cs: CSSStyleDeclaration): RawRun['ws'] {
  const collapse = cs.getPropertyValue('white-space-collapse');
  if (collapse) {
    if (collapse === 'preserve' || collapse === 'break-spaces') return 'preserve';
    if (collapse === 'preserve-breaks') return 'preserve-breaks';
    return 'collapse';
  }
  const ws = cs.whiteSpace;
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return 'preserve';
  if (ws === 'pre-line') return 'preserve-breaks';
  return 'collapse';
}

/**
 * Line boxes from a range's client rects. Glyph boxes overlap between lines when line-height is
 * tighter than the font, so a new line starts when a rect's top is more than half a rect below the
 * current line's top.
 */
function countLines(rects: DOMRectList): number {
  const list = Array.from(rects).filter((r) => r.width > 0 && r.height > 0).sort((a, b) => a.top - b.top);
  let lines = 0;
  let lineTop = -Infinity;
  let lineHeight = 0;
  for (const r of list) {
    if (r.top - lineTop > Math.min(r.height, lineHeight || r.height) / 2) {
      lines++;
      lineTop = r.top;
      lineHeight = r.height;
    }
  }
  return Math.max(1, lines);
}

function isGradientText(cs: CSSStyleDeclaration): boolean {
  const clip = cs.getPropertyValue('background-clip') || cs.getPropertyValue('-webkit-background-clip');
  return clip.includes('text') && cs.backgroundImage !== 'none';
}

function gradientOf(cs: CSSStyleDeclaration, width: number, height: number): Paint | undefined {
  const layer = parseBackgroundImage(cs.backgroundImage, width, height).find((l) => l.kind !== 'url');
  if (layer?.kind === 'linear') return { type: 'linear', angle: layer.angle, stops: layer.stops };
  if (layer?.kind === 'radial') return { type: 'radial', stops: layer.stops };
  return undefined;
}

function textAlign(v: string): TextNode['align'] {
  if (v === 'center' || v === '-webkit-center') return 'center';
  if (v === 'right' || v === 'end' || v === '-webkit-right') return 'right';
  if (v === 'justify') return 'justify';
  return 'left';
}

// ---------- boxes ----------

function hasVisualBox(cs: CSSStyleDeclaration): boolean {
  const bg = parseColor(cs.backgroundColor);
  return (
    (bg !== null && bg.a > 0) ||
    cs.backgroundImage !== 'none' ||
    ['top', 'right', 'bottom', 'left'].some(
      (s) => px(cs.getPropertyValue(`border-${s}-width`)) > 0 && cs.getPropertyValue(`border-${s}-style`) !== 'none',
    ) ||
    cs.boxShadow !== 'none' ||
    ['top', 'right', 'bottom', 'left'].some((s) => px(cs.getPropertyValue(`padding-${s}`)) > 0)
  );
}

function isPlainBox(box: BoxStyle, layout: LayoutStyle): boolean {
  return (
    box.backgrounds.length === 0 &&
    !box.border &&
    box.shadows.length === 0 &&
    box.blur === 0 &&
    box.backdropBlur === 0 &&
    box.opacity === 1 &&
    layout.padding.every((p) => p === 0)
  );
}

function boxStyle(cs: CSSStyleDeclaration, rect: Rect, s: Session): BoxStyle {
  const backgrounds: Paint[] = [];
  const bg = parseColor(cs.backgroundColor);
  if (bg && bg.a > 0) backgrounds.push({ type: 'solid', color: bg });
  const layers = parseBackgroundImage(cs.backgroundImage, rect.width, rect.height);
  for (const layer of [...layers].reverse()) {
    if (layer.kind === 'linear') backgrounds.push({ type: 'linear', angle: layer.angle, stops: layer.stops });
    else if (layer.kind === 'radial') backgrounds.push({ type: 'radial', stops: layer.stops });
    else {
      const paint: Paint = { type: 'image', assetId: '', size: backgroundSize(cs) };
      backgrounds.push(paint);
      s.requestImage(layer.url, rect.width, rect.height, false, (id) => {
        paint.assetId = id ?? '';
      });
    }
  }

  const side = (pos: string): BorderSide => {
    const style = cs.getPropertyValue(`border-${pos}-style`);
    const color = parseColor(cs.getPropertyValue(`border-${pos}-color`));
    const visible = style !== 'none' && style !== 'hidden' && color !== null && color.a > 0;
    return {
      width: visible ? px(cs.getPropertyValue(`border-${pos}-width`)) : 0,
      color: color ?? { r: 0, g: 0, b: 0, a: 1 },
      style: (['dashed', 'dotted', 'double'] as const).find((v) => v === style) ?? 'solid',
    };
  };
  const border = { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
  const hasBorder = Object.values(border).some((b) => b.width > 0);

  const corner = (v: string) => {
    const first = splitTopLevel(v, ' ')[0] ?? '0';
    const max = Math.min(rect.width, rect.height) / 2;
    const value = first.endsWith('%') ? (parseFloat(first) / 100) * Math.min(rect.width, rect.height) : px(first);
    return Math.max(0, Math.min(max, value));
  };

  const blurOf = (v: string) => {
    const m = /blur\(([\d.]+)px\)/.exec(v || '');
    return m ? parseFloat(m[1]) : 0;
  };
  const overflow = [cs.overflowX, cs.overflowY];

  return {
    backgrounds,
    border: hasBorder ? border : null,
    radius: [
      corner(cs.borderTopLeftRadius),
      corner(cs.borderTopRightRadius),
      corner(cs.borderBottomRightRadius),
      corner(cs.borderBottomLeftRadius),
    ],
    shadows: parseShadows(cs.boxShadow),
    opacity: parseFloat(cs.opacity),
    clip: overflow.some((o) => o === 'hidden' || o === 'clip' || o === 'auto' || o === 'scroll'),
    blur: blurOf(cs.filter),
    backdropBlur: blurOf(cs.getPropertyValue('backdrop-filter') || cs.getPropertyValue('-webkit-backdrop-filter')),
  };
}

function emptyBox(): BoxStyle {
  return { backgrounds: [], border: null, radius: [0, 0, 0, 0], shadows: [], opacity: 1, clip: false, blur: 0, backdropBlur: 0 };
}

function backgroundSize(cs: CSSStyleDeclaration): 'cover' | 'contain' | 'stretch' | 'tile' {
  const size = cs.backgroundSize;
  if (size.includes('cover')) return 'cover';
  if (size.includes('contain')) return 'contain';
  if (size === '100% 100%') return 'stretch';
  // A repeating background (the default) is a pattern; only no-repeat images fill the box.
  if (!cs.backgroundRepeat.includes('no-repeat')) return 'tile';
  return 'cover';
}

function layoutStyle(cs: CSSStyleDeclaration): LayoutStyle {
  const widths = (['top', 'right', 'bottom', 'left'] as const).map((s) =>
    cs.getPropertyValue(`border-${s}-style`) === 'none' ? 0 : px(cs.getPropertyValue(`border-${s}-width`)),
  );
  const z = parseInt(cs.zIndex, 10);
  return {
    display: cs.display,
    position: cs.position as LayoutStyle['position'],
    flexDirection: cs.flexDirection as LayoutStyle['flexDirection'],
    flexWrap: cs.flexWrap !== 'nowrap',
    justifyContent: cs.justifyContent,
    alignItems: cs.alignItems,
    alignSelf: cs.alignSelf,
    rowGap: px(cs.rowGap),
    columnGap: px(cs.columnGap),
    flexGrow: parseFloat(cs.flexGrow) || 0,
    gridColumns: cs.display.includes('grid') ? trackSizes(cs.gridTemplateColumns) : [],
    gridRows: cs.display.includes('grid') ? trackSizes(cs.gridTemplateRows) : [],
    padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
    border: widths as [number, number, number, number],
    textAlign: textAlign(cs.textAlign),
    zIndex: Number.isFinite(z) ? z : null,
  };
}

/** Computed grid-template-* lists the used size of every track in px. */
function trackSizes(value: string): number[] {
  if (!value || value === 'none') return [];
  return splitTopLevel(value, ' ')
    .filter((t) => !t.startsWith('['))
    .map((t) => px(t));
}

function contentBox(rect: Rect, cs: CSSStyleDeclaration): Rect {
  const l = px(cs.paddingLeft) + px(cs.borderLeftWidth);
  const t = px(cs.paddingTop) + px(cs.borderTopWidth);
  const r = px(cs.paddingRight) + px(cs.borderRightWidth);
  const b = px(cs.paddingBottom) + px(cs.borderBottomWidth);
  return { x: rect.x + l, y: rect.y + t, width: Math.max(0, rect.width - l - r), height: Math.max(0, rect.height - t - b) };
}

// ---------- replaced elements ----------

function imageNode(img: HTMLImageElement, base: Omit<ImageNode, 'kind' | 'assetId' | 'fit' | 'box'>, cs: CSSStyleDeclaration, box: BoxStyle, s: Session): CaptureNode {
  const node: ImageNode = {
    ...base,
    kind: 'image',
    assetId: null,
    fit: (['contain', 'cover', 'none', 'scale-down'] as const).find((f) => f === cs.objectFit) ?? 'fill',
    box,
  };
  const src = img.currentSrc || img.src;
  s.requestImage(src, base.rect.width, base.rect.height, true, (id, svg) => {
    if (svg) {
      // Vector logos and icons stay vectors.
      const asSvg = node as unknown as SvgNode;
      asSvg.kind = 'svg';
      asSvg.svg = sizeSvg(svg, base.rect.width, base.rect.height);
      delete (node as Partial<ImageNode>).assetId;
      delete (node as Partial<ImageNode>).fit;
    } else {
      node.assetId = id;
    }
  });
  return node;
}

function mediaNode(el: Element, base: Omit<ImageNode, 'kind' | 'assetId' | 'fit' | 'box'>, box: BoxStyle, s: Session): CaptureNode {
  const node: ImageNode = { ...base, kind: 'image', assetId: null, fit: 'cover', box };
  let src = '';
  if (el instanceof HTMLVideoElement) src = el.poster || frameOf(el);
  else if (el instanceof HTMLCanvasElement) src = safeDataUrl(el);
  s.requestImage(src, base.rect.width, base.rect.height, false, (id) => {
    node.assetId = id;
  });
  return node;
}

function frameOf(video: HTMLVideoElement): string {
  try {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d')?.drawImage(video, 0, 0);
    return c.toDataURL('image/jpeg', 0.85);
  } catch {
    return '';
  }
}

function safeDataUrl(canvas: HTMLCanvasElement): string {
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return ''; // tainted by cross-origin content
  }
}

function sizeSvg(markup: string, width: number, height: number): string {
  try {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.tagName.toLowerCase() !== 'svg') return markup;
    if (!svg.getAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width') ?? '') || width;
      const h = parseFloat(svg.getAttribute('height') ?? '') || height;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return markup;
  }
}

function formControlChildren(el: HTMLInputElement, cs: CSSStyleDeclaration, rect: Rect, s: Session, node: ElementNode): CaptureNode[] {
  const type = (el.type || '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    const accent = parseColor(cs.accentColor) ?? { r: 0, g: 0.46, b: 1, a: 1 };
    const grey = { r: 0.46, g: 0.46, b: 0.46, a: 1 };
    node.box.backgrounds = [{ type: 'solid', color: el.checked ? accent : { r: 1, g: 1, b: 1, a: 1 } }];
    const side: BorderSide = { width: 1, color: el.checked ? accent : grey, style: 'solid' };
    node.box.border = { top: side, right: side, bottom: side, left: side };
    const r = type === 'radio' ? Math.min(rect.width, rect.height) / 2 : 2;
    node.box.radius = [r, r, r, r];
    node.name = type === 'radio' ? 'Radio' : 'Checkbox';
    return [];
  }
  if (['range', 'color', 'file', 'image', 'submit', 'reset', 'button'].includes(type) && el.tagName === 'INPUT') {
    if (type === 'submit' || type === 'reset' || type === 'button') return [inputText(el.value || type, cs, rect, s, cs, 1)];
    return [];
  }
  let value = '';
  if (el.tagName === 'SELECT') value = (el as unknown as HTMLSelectElement).selectedOptions[0]?.text ?? '';
  else value = el.value;
  if (type === 'password') value = '•'.repeat(value.length);
  let styleSource = cs;
  if (!value) {
    value = el.placeholder ?? '';
    styleSource = getComputedStyle(el, '::placeholder');
  }
  if (!value) return [];
  const lines = el.tagName === 'TEXTAREA' ? Math.max(1, Math.round(contentBox(rect, cs).height / (px(cs.lineHeight) || px(cs.fontSize) * 1.2))) : 1;
  return [inputText(value, cs, rect, s, styleSource, lines)];
}

function inputText(value: string, cs: CSSStyleDeclaration, rect: Rect, s: Session, styleSource: CSSStyleDeclaration, lines: number): TextNode {
  const box = contentBox(rect, cs);
  const style = textStyle(styleSource, 'none');
  const lh = style.lineHeight ?? style.fontSize * 1.2;
  // Single-line inputs centre their text vertically in the content box.
  const height = lines === 1 ? Math.min(box.height, lh) : box.height;
  return {
    kind: 'text',
    id: s.id(),
    name: textName(value),
    rect: { ...box, y: box.y + (box.height - height) / 2, height },
    layout: { ...DEFAULT_LAYOUT },
    runs: [{ text: value, style }],
    align: textAlign(cs.textAlign),
    lineCount: lines,
    hugs: false, // the field, not its text, sets the width
  };
}

// ---------- components ----------

function readComponent(el: Element): ComponentRef | undefined {
  const probed = el.getAttribute('data-w2f-component');
  if (probed) {
    return {
      name: probed,
      chain: (el.getAttribute('data-w2f-chain') ?? probed).split('>'),
      props: safeJson(el.getAttribute('data-w2f-props')),
      source: el.getAttribute('data-w2f-source') === 'vue' ? 'vue' : 'react',
    };
  }
  const explicit = el.getAttribute('data-component');
  if (explicit) {
    const props = el.hasAttribute('data-component-props') ? safeJson(el.getAttribute('data-component-props')) : dataProps(el);
    return { name: explicit, chain: [explicit], props, source: 'attr' };
  }
  // shadcn/ui marks component roots with data-slot (plus data-variant / data-size on some).
  const slot = el.getAttribute('data-slot');
  if (slot) {
    const name = slot.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
    return { name, chain: [name], props: dataProps(el), source: 'attr' };
  }
  return undefined;
}

function dataProps(el: Element): Record<string, string> {
  const props: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith('data-') || /^data-(slot|component|w2f|testid|test-id|radix|reactroot)/.test(attr.name)) continue;
    if (attr.value.length > 30) continue;
    const key = attr.name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    props[key] = attr.value === '' ? 'true' : attr.value;
  }
  return props;
}

function safeJson(v: string | null): Record<string, string | number | boolean> {
  if (!v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---------- helpers ----------

function docRect(r: DOMRect): Rect {
  const round = (v: number) => Math.round(v * 100) / 100;
  return { x: round(r.left + window.scrollX), y: round(r.top + window.scrollY), width: round(r.width), height: round(r.height) };
}

function sameRect(a: Rect, b: Rect): boolean {
  const n = (x: number, y: number) => Math.abs(x - y) <= 1.5;
  return n(a.x, b.x) && n(a.y, b.y) && n(a.width, b.width) && n(a.height, b.height);
}

/** Waits for n frames to paint; background tabs don't run rAF, so a timeout stands in. */
function frames(n: number): Promise<void> {
  const nextFrame = () => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(t);
      resolve();
    });
  });
  return Array.from({ length: n }).reduce<Promise<void>>((p) => p.then(nextFrame), Promise.resolve());
}

async function scrollThrough(onProgress?: (m: string) => void) {
  for (const img of Array.from(document.images)) if (img.loading === 'lazy') img.loading = 'eager';
  const step = Math.max(200, window.innerHeight * 0.8);
  for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
    window.scrollTo(0, y);
    onProgress?.('Scrolling to load lazy content…');
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300));
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}
