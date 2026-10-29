import type { RGBA } from './schema';

// Parses the colour strings getComputedStyle returns. Modern Chrome keeps oklch()/oklab()/color()
// in computed values (Tailwind v4 emits oklch), so those are converted to sRGB here.

const NAMED: Record<string, RGBA> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 1, g: 1, b: 1, a: 1 },
  currentcolor: { r: 0, g: 0, b: 0, a: 1 },
};

export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s in NAMED) return { ...NAMED[s] };
  if (s.startsWith('#')) return parseHex(s);
  const m = /^([a-z-]+)\((.*)\)$/.exec(s);
  if (!m) return null;
  const [, fn, body] = m;
  const { values, alpha } = splitArgs(body);
  switch (fn) {
    case 'rgb':
    case 'rgba': {
      if (values.length < 3) return null;
      const ch = values.slice(0, 3).map((v) => num(v, 255) / 255);
      return clampColor({ r: ch[0], g: ch[1], b: ch[2], a: alphaOf(alpha) });
    }
    case 'hsl':
    case 'hsla': {
      if (values.length < 3) return null;
      const [r, g, b] = hslToRgb(hue(values[0]), num(values[1], 1), num(values[2], 1));
      return clampColor({ r, g, b, a: alphaOf(alpha) });
    }
    case 'oklab': {
      if (values.length < 3) return null;
      const [r, g, b] = oklabToSrgb(num(values[0], 1), num(values[1], 0.4), num(values[2], 0.4));
      return clampColor({ r, g, b, a: alphaOf(alpha) });
    }
    case 'oklch': {
      if (values.length < 3) return null;
      const l = num(values[0], 1);
      const c = num(values[1], 0.4);
      const h = (hue(values[2]) * Math.PI) / 180;
      const [r, g, b] = oklabToSrgb(l, c * Math.cos(h), c * Math.sin(h));
      return clampColor({ r, g, b, a: alphaOf(alpha) });
    }
    case 'color': {
      const [space, ...rest] = values;
      if (rest.length < 3) return null;
      const ch = rest.slice(0, 3).map((v) => num(v, 1));
      let rgb: [number, number, number];
      if (space === 'srgb') rgb = [ch[0], ch[1], ch[2]];
      else if (space === 'srgb-linear') rgb = [encode(ch[0]), encode(ch[1]), encode(ch[2])];
      else if (space === 'display-p3') rgb = p3ToSrgb(ch[0], ch[1], ch[2]);
      else return null;
      return clampColor({ r: rgb[0], g: rgb[1], b: rgb[2], a: alphaOf(alpha) });
    }
    default:
      return null;
  }
}

export function toHex(c: RGBA): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a) : ''}`.toUpperCase();
}

export function sameColor(a: RGBA, b: RGBA, tolerance = 1 / 255): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance &&
    Math.abs(a.a - b.a) <= 0.01
  );
}

function parseHex(s: string): RGBA | null {
  let hex = s.slice(1);
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) return null;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 };
}

function splitArgs(body: string): { values: string[]; alpha: string | null } {
  const [main, alpha] = body.split('/');
  const values = main.split(/[\s,]+/).filter(Boolean);
  // Legacy rgba(r, g, b, a) puts alpha in the 4th comma-separated slot.
  if (alpha === undefined && values.length === 4 && body.includes(',')) {
    return { values: values.slice(0, 3), alpha: values[3] };
  }
  return { values, alpha: alpha?.trim() ?? null };
}

/** A number, a percentage of `percentOf`, or `none`. */
function num(token: string, percentOf: number): number {
  if (token === 'none') return 0;
  if (token.endsWith('%')) return (parseFloat(token) / 100) * percentOf;
  return parseFloat(token);
}

function hue(token: string): number {
  if (token === 'none') return 0;
  if (token.endsWith('turn')) return parseFloat(token) * 360;
  if (token.endsWith('rad')) return (parseFloat(token) * 180) / Math.PI;
  if (token.endsWith('grad')) return parseFloat(token) * 0.9;
  return parseFloat(token);
}

function alphaOf(token: string | null): number {
  if (token === null) return 1;
  return num(token, 1);
}

function clampColor(c: RGBA): RGBA | null {
  const vals = [c.r, c.g, c.b, c.a];
  if (vals.some((v) => Number.isNaN(v))) return null;
  const k = (v: number) => Math.min(1, Math.max(0, v));
  return { r: k(c.r), g: k(c.g), b: k(c.b), a: k(c.a) };
}

function encode(c: number): number {
  const a = Math.abs(c);
  const v = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return Math.sign(c) * v;
}

function decode(c: number): number {
  const a = Math.abs(c);
  const v = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
  return Math.sign(c) * v;
}

function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function p3ToSrgb(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [decode(r), decode(g), decode(b)];
  return [
    encode(1.2249401 * lr - 0.2249404 * lg),
    encode(-0.0420569 * lr + 1.0420571 * lg),
    encode(-0.0196376 * lr - 0.0786361 * lg + 1.0982735 * lb),
  ];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}
