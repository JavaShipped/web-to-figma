// The capture format: what the browser extension produces and the Figma plugin consumes.
// All rects are in CSS pixels, in document coordinates (page scrolled to the top).

export const CAPTURE_FORMAT = 'web-to-figma';
export const CAPTURE_VERSION = 1;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Colour with channels in 0..1 (sRGB). */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface CaptureDocument {
  format: typeof CAPTURE_FORMAT;
  version: typeof CAPTURE_VERSION;
  url: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  root: ElementNode;
  /** Raster images, deduplicated. Referenced by `assetId`. */
  assets: Record<string, ImageAsset>;
  /** CSS custom properties on :root that resolve to colours, used to name colour variables. */
  colorTokens: ColorToken[];
}

export interface ImageAsset {
  mime: 'image/png' | 'image/jpeg' | 'image/gif';
  /** Base64, no data: prefix. */
  data: string;
  width: number;
  height: number;
}

export interface ColorToken {
  name: string;
  color: RGBA;
}

export type CaptureNode = ElementNode | TextNode | ImageNode | SvgNode;

interface NodeBase {
  id: string;
  name: string;
  rect: Rect;
  layout: LayoutStyle;
}

/** Where a component boundary came from. */
export interface ComponentRef {
  name: string;
  /** Inner-to-outer chain of component names that share this root element. */
  chain: string[];
  /** Primitive props of the outermost component, used for variant detection. */
  props: Record<string, string | number | boolean>;
  source: 'react' | 'vue' | 'attr';
}

export interface ElementNode extends NodeBase {
  kind: 'element';
  tag: string;
  className?: string;
  component?: ComponentRef;
  box: BoxStyle;
  children: CaptureNode[];
}

export interface TextNode extends NodeBase {
  kind: 'text';
  runs: TextRun[];
  align: 'left' | 'center' | 'right' | 'justify';
  lineCount: number;
  /** Gradient text (background-clip: text). Overrides run colours. */
  fill?: Paint;
}

export interface TextRun {
  text: string;
  style: TextStyle;
  href?: string;
}

export interface TextStyle {
  /** The font-family stack, most preferred first, quotes removed. */
  fontFamily: string[];
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  /** px, or null for `normal`. */
  lineHeight: number | null;
  letterSpacing: number;
  color: RGBA;
  decoration: 'none' | 'underline' | 'line-through';
  transform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
}

export interface ImageNode extends NodeBase {
  kind: 'image';
  assetId: string | null;
  fit: 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';
  box: BoxStyle;
}

export interface SvgNode extends NodeBase {
  kind: 'svg';
  /** Self-contained SVG markup with computed fills/strokes inlined. */
  svg: string;
  box: BoxStyle;
}

export interface BoxStyle {
  /** Bottom-most first (Figma order), unlike CSS. */
  backgrounds: Paint[];
  border: Border | null;
  /** top-left, top-right, bottom-right, bottom-left, in px. */
  radius: [number, number, number, number];
  shadows: Shadow[];
  opacity: number;
  clip: boolean;
  blur: number;
  backdropBlur: number;
}

export interface Border {
  top: BorderSide;
  right: BorderSide;
  bottom: BorderSide;
  left: BorderSide;
}

export interface BorderSide {
  width: number;
  color: RGBA;
  style: 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
}

export interface GradientStop {
  color: RGBA;
  /** 0..1 */
  position: number;
}

export type Paint =
  | { type: 'solid'; color: RGBA }
  | { type: 'linear'; angle: number; stops: GradientStop[] }
  | { type: 'radial'; stops: GradientStop[] }
  | { type: 'image'; assetId: string; size: 'cover' | 'contain' | 'stretch' | 'tile' };

export interface Shadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: RGBA;
}

export interface LayoutStyle {
  display: string;
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  flexDirection: 'row' | 'row-reverse' | 'column' | 'column-reverse';
  flexWrap: boolean;
  justifyContent: string;
  alignItems: string;
  alignSelf: string;
  rowGap: number;
  columnGap: number;
  flexGrow: number;
  /** Used sizes (px) of grid column / row tracks; empty when not a grid. */
  gridColumns: number[];
  gridRows: number[];
  /** top, right, bottom, left */
  padding: [number, number, number, number];
  border: [number, number, number, number];
  textAlign: 'left' | 'center' | 'right' | 'justify';
  zIndex: number | null;
}

export const DEFAULT_LAYOUT: LayoutStyle = {
  display: 'inline',
  position: 'static',
  flexDirection: 'row',
  flexWrap: false,
  justifyContent: 'normal',
  alignItems: 'normal',
  alignSelf: 'auto',
  rowGap: 0,
  columnGap: 0,
  flexGrow: 0,
  gridColumns: [],
  gridRows: [],
  padding: [0, 0, 0, 0],
  border: [0, 0, 0, 0],
  textAlign: 'left',
  zIndex: null,
};

export function isCaptureDocument(value: unknown): value is CaptureDocument {
  const v = value as CaptureDocument | null;
  return !!v && v.format === CAPTURE_FORMAT && typeof v.version === 'number' && !!v.root;
}
