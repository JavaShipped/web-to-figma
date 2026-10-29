import type { BoxStyle, Paint as CPaint, RGBA as CRGBA, Shadow } from '../../shared/schema';

// Converts captured CSS paint, borders, radii and shadows into Figma properties.

export interface PaintContext {
  imageHash(assetId: string): string | null;
  /** Colour variable for a solid colour, when styles are being created. */
  colorVariable(color: CRGBA): Variable | null;
}

export function solidPaint(color: CRGBA, ctx: PaintContext): SolidPaint {
  const paint: SolidPaint = { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a };
  const variable = ctx.colorVariable(color);
  if (!variable) return paint;
  // A bound paint takes its alpha from the variable (Figma resets paint opacity), so translucent
  // colours are bound to tint variables that carry the alpha themselves.
  return figma.variables.setBoundVariableForPaint({ ...paint, opacity: 1 }, 'color', variable);
}

export function toPaints(list: CPaint[], ctx: PaintContext): Paint[] {
  const out: Paint[] = [];
  for (const p of list) {
    if (p.type === 'solid') {
      if (p.color.a > 0) out.push(solidPaint(p.color, ctx));
    } else if (p.type === 'linear') {
      out.push({ type: 'GRADIENT_LINEAR', gradientTransform: linearTransform(p.angle), gradientStops: stops(p.stops) });
    } else if (p.type === 'radial') {
      out.push({ type: 'GRADIENT_RADIAL', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops(p.stops) });
    } else if (p.type === 'image') {
      const hash = p.assetId ? ctx.imageHash(p.assetId) : null;
      if (!hash) continue;
      const scaleMode = p.size === 'contain' ? 'FIT' : p.size === 'tile' ? 'TILE' : p.size === 'stretch' ? 'CROP' : 'FILL';
      out.push({ type: 'IMAGE', imageHash: hash, scaleMode });
    }
  }
  return out;
}

function stops(list: { color: CRGBA; position: number }[]): ColorStop[] {
  return list.map((s) => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } }));
}

/**
 * CSS angles run clockwise from "to top"; Figma's identity gradient runs left to right (CSS 90deg).
 * The transform maps layer space onto gradient space, rotating about the centre.
 */
export function linearTransform(cssAngle: number): Transform {
  const rad = ((cssAngle - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
    [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos],
  ];
}

type BoxNode = FrameNode | RectangleNode;

export function applyBox(node: BoxNode, box: BoxStyle, ctx: PaintContext) {
  node.fills = toPaints(box.backgrounds, ctx);
  applyBorder(node, box, ctx);
  const [tl, tr, br, bl] = box.radius;
  if (tl === tr && tr === br && br === bl) node.cornerRadius = tl;
  else {
    node.topLeftRadius = tl;
    node.topRightRadius = tr;
    node.bottomRightRadius = br;
    node.bottomLeftRadius = bl;
  }
  node.effects = effects(box);
  if (box.opacity < 1) node.opacity = box.opacity;
  if (node.type === 'FRAME') node.clipsContent = box.clip;
}

function applyBorder(node: BoxNode, box: BoxStyle, ctx: PaintContext) {
  const b = box.border;
  if (!b) {
    node.strokes = [];
    return;
  }
  const sides = [b.top, b.right, b.bottom, b.left];
  const visible = sides.find((s) => s.width > 0)!;
  node.strokes = [solidPaint(visible.color, ctx)];
  // CSS borders sit inside the border box; padding already includes their width.
  node.strokeAlign = 'INSIDE';
  if (sides.every((s) => s.width === sides[0].width)) node.strokeWeight = sides[0].width;
  else {
    node.strokeTopWeight = b.top.width;
    node.strokeRightWeight = b.right.width;
    node.strokeBottomWeight = b.bottom.width;
    node.strokeLeftWeight = b.left.width;
  }
  if (visible.style === 'dashed') node.dashPattern = [visible.width * 3, visible.width * 3];
  else if (visible.style === 'dotted') {
    node.dashPattern = [visible.width, visible.width];
    node.strokeCap = 'ROUND';
  }
}

export function effects(box: { shadows: Shadow[]; blur: number; backdropBlur: number }): Effect[] {
  const out: Effect[] = [];
  // CSS lists the top-most shadow first; Figma paints later effects on top.
  for (const s of [...box.shadows].reverse()) {
    out.push({
      type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
      offset: { x: s.x, y: s.y },
      radius: s.blur,
      spread: s.spread,
      visible: true,
      blendMode: 'NORMAL',
    } as DropShadowEffect | InnerShadowEffect);
  }
  if (box.blur > 0) out.push({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius: box.blur, visible: true });
  if (box.backdropBlur > 0) out.push({ type: 'BACKGROUND_BLUR', blurType: 'NORMAL', radius: box.backdropBlur, visible: true });
  return out;
}
