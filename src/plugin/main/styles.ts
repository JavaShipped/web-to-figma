import { toHex } from '../../shared/color';
import type { CaptureDocument, CaptureNode, ColorToken, Paint as CPaint, RGBA, TextStyle } from '../../shared/schema';
import type { FontResolver } from './fonts';

// Turns repeated colours into colour variables (named after the site's CSS tokens where possible)
// and repeated type settings into local text styles, so the import starts out systematised.

const MIN_UNNAMED_COLOR_USES = 3;
const MIN_TEXT_STYLE_USES = 2;

export interface StyleRegistry {
  colorVariable(color: RGBA): Variable | null;
  textStyleId(style: TextStyle): string | null;
  summary: { colorVariables: number; textStyles: number };
}

export const NO_STYLES: StyleRegistry = {
  colorVariable: () => null,
  textStyleId: () => null,
  summary: { colorVariables: 0, textStyles: 0 },
};

const rgbKey = (c: RGBA) => toHex({ ...c, a: 1 });

export async function createStyles(doc: CaptureDocument, fonts: FontResolver): Promise<StyleRegistry> {
  const colorUses = new Map<string, { color: RGBA; count: number }>();
  const textUses = new Map<string, { style: TextStyle; font: FontName; count: number }>();
  const addColor = (c: RGBA) => {
    if (c.a === 0) return;
    const key = rgbKey(c);
    const entry = colorUses.get(key) ?? { color: { ...c, a: 1 }, count: 0 };
    entry.count++;
    colorUses.set(key, entry);
  };
  const addPaints = (list: CPaint[]) => list.forEach((p) => p.type === 'solid' && addColor(p.color));
  const visit = (n: CaptureNode) => {
    if (n.kind === 'text') {
      for (const r of n.runs) {
        addColor(r.style.color);
        const font = fonts.resolve(r.style);
        const key = textKey(r.style, font);
        const entry = textUses.get(key) ?? { style: r.style, font, count: 0 };
        entry.count++;
        textUses.set(key, entry);
      }
      return;
    }
    addPaints(n.box.backgrounds);
    if (n.box.border) for (const s of Object.values(n.box.border)) if (s.width > 0) addColor(s.color);
    if (n.kind === 'element') n.children.forEach(visit);
  };
  visit(doc.root);

  // Colour variables.
  const tokenNames = tokenNameMap(doc.colorTokens);
  const host = safeHost(doc.url);
  // Re-importing the same site reuses its collection and variables instead of piling up copies.
  const collectionName = `${host} colors`;
  const existingCollection = (await figma.variables.getLocalVariableCollectionsAsync()).find((c) => c.name === collectionName);
  const collection = existingCollection ?? figma.variables.createVariableCollection(collectionName);
  const existingVars = new Map(
    (await figma.variables.getLocalVariablesAsync('COLOR')).filter((v) => v.variableCollectionId === collection.id).map((v) => [v.name, v]),
  );
  const modeId = collection.modes[0].modeId;
  const variables = new Map<string, Variable>();
  const tints = new Map<string, Variable>();
  const usedNames = new Set<string>();
  const sorted = [...colorUses.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [key, { color, count }] of sorted) {
    const token = tokenNames.get(key);
    if (!token && count < MIN_UNNAMED_COLOR_USES) continue;
    let name = token ?? `captured/${key.slice(1)}`;
    for (let i = 2; usedNames.has(name); i++) name = `${token ?? `captured/${key.slice(1)}`} ${i}`;
    usedNames.add(name);
    const v = existingVars.get(name) ?? figma.variables.createVariable(name, collection, 'COLOR');
    v.setValueForMode(modeId, { r: color.r, g: color.g, b: color.b, a: 1 });
    v.scopes = ['ALL_FILLS', 'STROKE_COLOR', 'EFFECT_COLOR'];
    variables.set(key, v);
  }
  if (variables.size === 0 && !existingCollection) collection.remove();

  // Text styles.
  const families = new Set([...textUses.values()].map((t) => t.font.family));
  const styleIds = new Map<string, string>();
  const styleNames = new Set<string>();
  const existing = await figma.getLocalTextStylesAsync();
  for (const [key, { style, font, count }] of textUses) {
    if (count < MIN_TEXT_STYLE_USES) continue;
    const size = round(style.fontSize);
    const lh = style.lineHeight ? ` · ${round(style.lineHeight)}` : '';
    let name = `${families.size > 1 ? `${font.family}/` : ''}Text/${size} · ${font.style}${lh}`;
    for (let i = 2; styleNames.has(name); i++) name = `${name.replace(/ \(\d+\)$/, '')} (${i})`;
    styleNames.add(name);
    const match = existing.find((s) => s.name === name && sameTextStyle(s, style, font));
    const ts = match ?? figma.createTextStyle();
    if (!match) {
      ts.name = name;
      ts.fontName = font;
      ts.fontSize = style.fontSize;
      ts.lineHeight = style.lineHeight ? { unit: 'PIXELS', value: style.lineHeight } : { unit: 'AUTO' };
      ts.letterSpacing = { unit: 'PIXELS', value: style.letterSpacing };
    }
    styleIds.set(key, ts.id);
  }

  return {
    colorVariable: (c) => {
      if (c.a === 0) return null;
      const base = variables.get(rgbKey(c));
      if (!base || c.a >= 1) return base ?? null;
      // Tints of a token (Tailwind's bg-primary/10) become their own variable, e.g. "primary · 10%".
      const pct = Math.round(c.a * 100);
      const name = `${base.name} · ${pct}%`;
      let tint = tints.get(name) ?? existingVars.get(name);
      if (!tint) {
        tint = figma.variables.createVariable(name, collection, 'COLOR');
        tint.scopes = ['ALL_FILLS', 'STROKE_COLOR', 'EFFECT_COLOR'];
      }
      tint.setValueForMode(modeId, { r: c.r, g: c.g, b: c.b, a: pct / 100 });
      tints.set(name, tint);
      return tint;
    },
    textStyleId: (s) => styleIds.get(textKey(s, fonts.resolve(s))) ?? null,
    get summary() {
      return { colorVariables: variables.size + tints.size, textStyles: styleIds.size };
    },
  };
}

function textKey(s: TextStyle, font: FontName): string {
  return `${font.family}|${font.style}|${round(s.fontSize)}|${s.lineHeight === null ? 'auto' : round(s.lineHeight)}|${round(s.letterSpacing)}`;
}

function sameTextStyle(ts: TextStyle_, s: TextStyle, font: FontName): boolean {
  return ts.fontName.family === font.family && ts.fontName.style === font.style && ts.fontSize === s.fontSize;
}
type TextStyle_ = globalThis.TextStyle;

/** "--color-blue-500" → "blue/500", "--primary-foreground" → "primary-foreground". Semantic names win. */
export function tokenNameMap(tokens: ColorToken[]): Map<string, string> {
  const map = new Map<string, string>();
  const ranked = [...tokens].sort((a, b) => Number(/\d/.test(a.name)) - Number(/\d/.test(b.name)) || a.name.length - b.name.length);
  for (const t of ranked) {
    const key = rgbKey(t.color);
    if (map.has(key)) continue;
    const name = t.name
      .replace(/^--/, '')
      .replace(/^(tw-)?colou?r-/, '')
      .replace(/-(\d+)$/, '/$1')
      .replace(/[^a-zA-Z0-9/_ -]/g, '-');
    if (name) map.set(key, name);
  }
  return map;
}

/** The plugin sandbox has no URL global. */
function safeHost(url: string): string {
  return /^[a-z]+:\/\/([^/:?#]+)/i.exec(url)?.[1] ?? 'Web';
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
