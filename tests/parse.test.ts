import { describe, expect, it } from 'vitest';
import { parseColor, toHex } from '../src/shared/color';
import { parseBackgroundImage, parseShadows, splitTopLevel } from '../src/shared/css-parse';
import { normalizeRuns, type RawRun } from '../src/shared/text';
import { text } from './helpers';

describe('parseColor', () => {
  it('reads legacy and modern rgb()', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgb(255 255 255 / 0.8)')).toEqual({ r: 1, g: 1, b: 1, a: 0.8 });
    expect(parseColor('transparent')?.a).toBe(0);
  });

  it('converts oklch (Tailwind v4) to sRGB', () => {
    // Tailwind's red-500: oklch(63.7% 0.237 25.331) ≈ #FB2C36
    const c = parseColor('oklch(63.7% 0.237 25.331)')!;
    expect(toHex(c)).toMatch(/^#F[A-C]2[A-F]3[5-7]$/);
    expect(parseColor('oklch(0.55 0.22 275 / 0.1)')!.a).toBeCloseTo(0.1);
    expect(toHex(parseColor('oklch(1 0 0)')!)).toBe('#FFFFFF');
  });

  it('reads hex, color() and hsl()', () => {
    expect(parseColor('#0d99ff')).toEqual({ r: 13 / 255, g: 153 / 255, b: 1, a: 1 });
    expect(parseColor('#f008')!.a).toBeCloseTo(0x88 / 255);
    expect(toHex(parseColor('color(srgb 1 0.5 0)')!)).toBe('#FF8000');
    expect(toHex(parseColor('color(display-p3 1 0 0)')!)).toBe('#FF0000'); // clipped to sRGB
    expect(toHex(parseColor('hsl(120 100% 50%)')!)).toBe('#00FF00');
  });

  it('returns null for things that are not colours', () => {
    expect(parseColor('10px')).toBeNull();
    expect(parseColor('var(--x)')).toBeNull();
  });
});

describe('css parsing', () => {
  it('splits only at the top level', () => {
    expect(splitTopLevel('rgb(1, 2, 3) 0px, url("a,b") 1px')).toEqual(['rgb(1, 2, 3) 0px', 'url("a,b") 1px']);
  });

  it('parses linear gradients with angles, keywords and interpolation spaces', () => {
    const [g] = parseBackgroundImage('linear-gradient(to right in oklab, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)', 100, 50);
    expect(g).toMatchObject({ kind: 'linear', angle: 90 });
    if (g.kind !== 'linear') throw new Error();
    expect(g.stops.map((s) => s.position)).toEqual([0, 1]);

    const [d] = parseBackgroundImage('linear-gradient(rgb(0, 0, 0), rgb(10, 10, 10), rgb(255, 255, 255))', 10, 10);
    if (d.kind !== 'linear') throw new Error();
    expect(d.angle).toBe(180);
    expect(d.stops.map((s) => s.position)).toEqual([0, 0.5, 1]);
  });

  it('keeps background layers in CSS order and finds urls', () => {
    const layers = parseBackgroundImage('url("a.png"), linear-gradient(45deg, rgb(255, 0, 0), rgb(0, 0, 255))', 10, 10);
    expect(layers.map((l) => l.kind)).toEqual(['url', 'linear']);
  });

  it('parses computed box-shadow lists', () => {
    const s = parseShadows('rgba(0, 0, 0, 0.08) 0px 1px 2px 0px, rgb(255, 0, 0) 0px 4px 12px -2px inset');
    expect(s).toHaveLength(2);
    expect(s[1]).toMatchObject({ inset: true, y: 4, blur: 12, spread: -2 });
  });
});

describe('normalizeRuns', () => {
  const style = text({ x: 0, y: 0, width: 1, height: 1 }).runs[0].style;
  const run = (t: string, extra: Partial<RawRun> = {}): RawRun => ({ text: t, style, ws: 'collapse', ...extra });

  it('collapses whitespace across runs and trims the ends', () => {
    const out = normalizeRuns([run('\n   Hello  '), run('  world ', { style: { ...style, fontWeight: 700 } }), run(' !\n')]);
    expect(out.map((r) => r.text).join('')).toBe('Hello world !');
    expect(out).toHaveLength(3);
  });

  it('keeps <br> and preserved whitespace', () => {
    const out = normalizeRuns([run('a'), run('\n', { ws: 'preserve', br: true }), run(' b'), run('  c', { ws: 'preserve' })]);
    expect(out.map((r) => r.text).join('')).toBe('a\nb  c');
  });

  it('merges neighbours with the same style', () => {
    expect(normalizeRuns([run('a '), run('b')])).toHaveLength(1);
  });
});
