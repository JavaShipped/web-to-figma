import { parseColor } from './color';
import type { GradientStop, Shadow } from './schema';

/** Splits on `sep` only outside parentheses and quotes. */
export function splitTopLevel(input: string, sep: ',' | ' ' = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    const isSep = sep === ' ' ? /\s/.test(ch) : ch === sep;
    if (isSep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseFontFamily(value: string): string[] {
  return splitTopLevel(value, ',').map((f) => f.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

export type BackgroundLayer =
  | { kind: 'linear'; angle: number; stops: GradientStop[] }
  | { kind: 'radial'; stops: GradientStop[] }
  | { kind: 'url'; url: string };

/** Parses a computed `background-image`, returning layers top-most first (CSS order). */
export function parseBackgroundImage(value: string, width: number, height: number): BackgroundLayer[] {
  if (!value || value === 'none') return [];
  const layers: BackgroundLayer[] = [];
  for (const layer of splitTopLevel(value, ',')) {
    const fn = /^([a-z-]+)\((.*)\)$/s.exec(layer.trim());
    if (!fn) continue;
    const [, name, body] = fn;
    if (name === 'url') {
      layers.push({ kind: 'url', url: body.trim().replace(/^["']|["']$/g, '') });
    } else if (name === 'linear-gradient' || name === 'repeating-linear-gradient') {
      const parsed = parseLinear(body, width, height);
      if (parsed) layers.push(parsed);
    } else if (name === 'radial-gradient' || name === 'repeating-radial-gradient') {
      const args = splitTopLevel(body, ',');
      const first = args[0] ?? '';
      const hasShape = !looksLikeStop(first);
      const stops = parseStops(hasShape ? args.slice(1) : args, Math.max(width, height) / 2);
      if (stops) layers.push({ kind: 'radial', stops });
    }
  }
  return layers;
}

function parseLinear(body: string, width: number, height: number): BackgroundLayer | null {
  const args = splitTopLevel(body, ',');
  let angle = 180;
  if (args.length && !looksLikeStop(args[0])) {
    // e.g. "90deg", "to right", "to right in oklab", "in oklch 45deg"
    const dir = args.shift()!.replace(/\bin\s+[a-z0-9-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?/g, '').trim();
    if (dir) angle = parseAngle(dir, width, height);
  }
  const rad = (angle * Math.PI) / 180;
  const length = Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad)) || 1;
  const stops = parseStops(args, length);
  return stops ? { kind: 'linear', angle, stops } : null;
}

function parseAngle(dir: string, w: number, h: number): number {
  const m = /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(dir);
  if (m) {
    const v = parseFloat(m[1]);
    if (m[2] === 'turn') return v * 360;
    if (m[2] === 'rad') return (v * 180) / Math.PI;
    if (m[2] === 'grad') return v * 0.9;
    return v;
  }
  const corner = (Math.atan2(h, w) * 180) / Math.PI;
  const map: Record<string, number> = {
    'to top': 0,
    'to right': 90,
    'to bottom': 180,
    'to left': 270,
    'to top right': corner,
    'to right top': corner,
    'to bottom right': 180 - corner,
    'to right bottom': 180 - corner,
    'to bottom left': 180 + corner,
    'to left bottom': 180 + corner,
    'to top left': 360 - corner,
    'to left top': 360 - corner,
  };
  return map[dir.replace(/\s+/g, ' ')] ?? 180;
}

function looksLikeStop(arg: string): boolean {
  const first = splitTopLevel(arg, ' ')[0] ?? '';
  return parseColor(first) !== null;
}

/** Parses colour stops; positions in px are divided by `lengthPx`. Missing positions are interpolated. */
function parseStops(args: string[], lengthPx: number): GradientStop[] | null {
  const raw: { color: GradientStop['color']; position: number | null }[] = [];
  for (const arg of args) {
    const parts = splitTopLevel(arg, ' ');
    const color = parseColor(parts[0] ?? '');
    if (!color) continue; // colour hints and unsupported syntax
    const positions = parts.slice(1).map((p) => toFraction(p, lengthPx));
    if (positions.length === 0) raw.push({ color, position: null });
    for (const position of positions) raw.push({ color, position });
  }
  if (raw.length < 2) return null;
  if (raw[0].position === null) raw[0].position = 0;
  if (raw[raw.length - 1].position === null) raw[raw.length - 1].position = 1;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].position !== null) continue;
    let j = i;
    while (raw[j].position === null) j++;
    const start = raw[i - 1].position!;
    const end = raw[j].position!;
    for (let k = i; k < j; k++) raw[k].position = start + ((end - start) * (k - i + 1)) / (j - i + 1);
  }
  let last = 0;
  return raw.map((s) => {
    last = Math.max(last, Math.min(1, Math.max(0, s.position!)));
    return { color: s.color, position: last };
  });
}

function toFraction(token: string, lengthPx: number): number {
  if (token.endsWith('%')) return parseFloat(token) / 100;
  if (token.endsWith('px')) return parseFloat(token) / lengthPx;
  return parseFloat(token) || 0;
}

/** Parses a computed `box-shadow` list. Computed values put the colour first. */
export function parseShadows(value: string): Shadow[] {
  if (!value || value === 'none') return [];
  const out: Shadow[] = [];
  for (const item of splitTopLevel(value, ',')) {
    let inset = false;
    let color = null;
    const lengths: number[] = [];
    for (const tok of splitTopLevel(item, ' ')) {
      if (tok === 'inset') inset = true;
      else if (/^-?[\d.]+(px)?$/.test(tok)) lengths.push(parseFloat(tok));
      else color = parseColor(tok) ?? color;
    }
    if (lengths.length < 2) continue;
    const c = color ?? { r: 0, g: 0, b: 0, a: 1 };
    if (c.a === 0) continue;
    out.push({ inset, x: lengths[0], y: lengths[1], blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, color: c });
  }
  return out;
}

export function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
