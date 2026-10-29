import { parseColor, toHex } from '../shared/color';

// Makes an inline <svg> self-contained: computed paint (CSS classes, currentColor, CSS variables)
// is written onto each element as attributes, <use> references are inlined, and the rendered size
// is fixed, so Figma's SVG importer sees what the browser drew.

const SVG_NS = 'http://www.w3.org/2000/svg';

const PAINT_PROPS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'opacity',
  'clip-rule',
  'stop-color',
  'stop-opacity',
  'font-family',
  'font-size',
  'font-weight',
];

const COLOR_PROPS = new Set(['fill', 'stroke', 'stop-color']);

export function serializeSvg(svg: SVGSVGElement, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const copies = [clone, ...Array.from(clone.querySelectorAll('*'))];

  originals.forEach((orig, i) => {
    const copy = copies[i];
    if (!copy) return;
    const cs = getComputedStyle(orig);
    const alphas: Record<string, number> = {};
    for (const prop of PAINT_PROPS) {
      let value = cs.getPropertyValue(prop).trim();
      if (!value) continue;
      if (COLOR_PROPS.has(prop)) {
        const { color, alpha } = toSvgColor(value);
        value = color;
        if (alpha < 1) alphas[prop === 'stop-color' ? 'stop-opacity' : `${prop}-opacity`] = alpha;
      } else if (/^-?[\d.]+px$/.test(value)) value = value.slice(0, -2);
      copy.setAttribute(prop, value);
    }
    // Figma's importer is safest with opaque colours plus *-opacity, so fold colour alpha in.
    for (const [prop, alpha] of Object.entries(alphas)) {
      const base = parseFloat(copy.getAttribute(prop) ?? '1');
      copy.setAttribute(prop, String(round((Number.isFinite(base) ? base : 1) * alpha)));
    }
    copy.removeAttribute('style');
    copy.removeAttribute('class');
  });

  for (const use of Array.from(clone.querySelectorAll('use'))) inlineUse(use);

  clone.setAttribute('xmlns', SVG_NS);
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.setAttribute('width', String(round(width)));
  clone.setAttribute('height', String(round(height)));
  return new XMLSerializer().serializeToString(clone);
}

function inlineUse(use: SVGUseElement) {
  const href = use.getAttribute('href') ?? use.getAttribute('xlink:href');
  if (!href?.startsWith('#')) return;
  const ref = document.getElementById(href.slice(1));
  if (!ref) return;
  const isSymbol = ref.tagName.toLowerCase() === 'symbol';
  const replacement = document.createElementNS(SVG_NS, isSymbol ? 'svg' : 'g');
  for (const attr of Array.from(use.attributes)) {
    if (attr.name === 'href' || attr.name === 'xlink:href') continue;
    replacement.setAttribute(attr.name, attr.value);
  }
  if (isSymbol && ref.getAttribute('viewBox')) replacement.setAttribute('viewBox', ref.getAttribute('viewBox')!);
  const x = use.getAttribute('x');
  const y = use.getAttribute('y');
  if (!isSymbol && (x || y)) replacement.setAttribute('transform', `translate(${x ?? 0} ${y ?? 0})`);
  for (const child of Array.from(ref.childNodes)) replacement.appendChild(child.cloneNode(true));
  use.replaceWith(replacement);
}

function toSvgColor(value: string): { color: string; alpha: number } {
  if (value === 'none' || value.startsWith('url(')) return { color: value, alpha: 1 };
  const c = parseColor(value);
  if (!c) return { color: value, alpha: 1 };
  if (c.a === 0) return { color: 'none', alpha: 1 };
  return { color: toHex({ ...c, a: 1 }), alpha: c.a };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
