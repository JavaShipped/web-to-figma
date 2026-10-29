import { DEFAULT_LAYOUT, type BoxStyle, type ElementNode, type LayoutStyle, type Rect, type TextNode } from '../src/shared/schema';

// Tiny builders for capture trees in tests.

let next = 0;
const id = () => `t${next++}`;

export const box = (): BoxStyle => ({
  backgrounds: [],
  border: null,
  radius: [0, 0, 0, 0],
  shadows: [],
  opacity: 1,
  clip: false,
  blur: 0,
  backdropBlur: 0,
});

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function el(r: Rect, layout: Partial<LayoutStyle> = {}, children: ElementNode['children'] = [], extra: Partial<ElementNode> = {}): ElementNode {
  return {
    kind: 'element',
    id: id(),
    name: 'Frame',
    tag: 'div',
    rect: r,
    layout: { ...DEFAULT_LAYOUT, display: 'block', ...layout },
    box: box(),
    children,
    ...extra,
  };
}

export function text(r: Rect, lineCount = 1, content = 'Text'): TextNode {
  return {
    kind: 'text',
    id: id(),
    name: content,
    rect: r,
    layout: { ...DEFAULT_LAYOUT },
    runs: [
      {
        text: content,
        style: {
          fontFamily: ['Inter'],
          fontWeight: 400,
          italic: false,
          fontSize: 16,
          lineHeight: 24,
          letterSpacing: 0,
          color: { r: 0, g: 0, b: 0, a: 1 },
          decoration: 'none',
          transform: 'none',
        },
      },
    ],
    align: 'left',
    lineCount,
  };
}
