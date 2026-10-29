import type { CaptureNode, TextStyle } from '../../shared/schema';

// Maps CSS font stacks + weight/italic onto fonts available in Figma, then loads them.

const GENERIC: Record<string, string[]> = {
  'sans-serif': ['Inter'],
  'system-ui': ['Inter'],
  'ui-sans-serif': ['Inter'],
  '-apple-system': ['SF Pro Text', 'SF Pro', 'Inter'],
  blinkmacsystemfont: ['SF Pro Text', 'SF Pro', 'Inter'],
  'segoe ui': ['Segoe UI', 'Inter'],
  serif: ['Noto Serif', 'Georgia', 'Times New Roman'],
  'ui-serif': ['Noto Serif', 'Georgia'],
  monospace: ['Roboto Mono', 'JetBrains Mono', 'Menlo'],
  'ui-monospace': ['Roboto Mono', 'JetBrains Mono', 'Menlo'],
  'sfmono-regular': ['SF Mono', 'Roboto Mono'],
  // Icon fonts render through ligatures ("feedback" → glyph), so any variant beats a text fallback.
  'material symbols outlined': ['Material Symbols Rounded', 'Material Symbols Sharp', 'Material Icons'],
  'material symbols rounded': ['Material Symbols Sharp', 'Material Icons Round'],
  'material symbols sharp': ['Material Symbols Rounded', 'Material Icons Sharp'],
  'material icons outlined': ['Material Icons', 'Material Symbols Rounded'],
};

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/, 100],
  [/extra ?light|ultra ?light/, 200],
  [/light/, 300],
  [/medium/, 500],
  [/semi ?bold|demi ?bold/, 600],
  [/extra ?bold|ultra ?bold/, 800],
  [/black|heavy/, 900],
  [/bold/, 700],
];

export interface FontResolver {
  resolve(style: TextStyle): FontName;
  /** Requested families that weren't available and fell back. */
  missing: Set<string>;
}

export async function prepareFonts(root: CaptureNode): Promise<FontResolver> {
  const available = await figma.listAvailableFontsAsync();
  const families = new Map<string, { family: string; styles: string[] }>();
  for (const f of available) {
    const key = f.fontName.family.toLowerCase();
    const entry = families.get(key) ?? { family: f.fontName.family, styles: [] };
    entry.styles.push(f.fontName.style);
    families.set(key, entry);
  }

  const cache = new Map<string, FontName>();
  const missing = new Set<string>();
  const resolve = (style: TextStyle): FontName => {
    const key = `${style.fontFamily.join(',')}|${style.fontWeight}|${style.italic}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let font: FontName | null = null;
    for (const fam of style.fontFamily) {
      const candidates = [fam, ...(GENERIC[fam.toLowerCase()] ?? [])];
      for (const c of candidates) {
        const entry = families.get(c.toLowerCase());
        if (entry) {
          font = { family: entry.family, style: pickStyle(entry.styles, style.fontWeight, style.italic) };
          break;
        }
      }
      if (font) break;
    }
    if (!font) {
      if (style.fontFamily[0]) missing.add(style.fontFamily[0]);
      const inter = families.get('inter');
      font = { family: 'Inter', style: inter ? pickStyle(inter.styles, style.fontWeight, style.italic) : 'Regular' };
    } else if (style.fontFamily[0] && font.family.toLowerCase() !== style.fontFamily[0].toLowerCase() && !GENERIC[style.fontFamily[0].toLowerCase()]) {
      missing.add(style.fontFamily[0]);
    }
    cache.set(key, font);
    return font;
  };

  // Resolve and load every font the capture uses up front.
  const used = new Map<string, FontName>();
  const visit = (n: CaptureNode) => {
    if (n.kind === 'text') {
      for (const r of n.runs) {
        const f = resolve(r.style);
        used.set(`${f.family}|${f.style}`, f);
      }
    } else if (n.kind === 'element') n.children.forEach(visit);
  };
  visit(root);
  used.set('Inter|Regular', { family: 'Inter', style: 'Regular' });
  await Promise.all([...used.values()].map((f) => figma.loadFontAsync(f)));
  return { resolve, missing };
}

export function pickStyle(styles: string[], weight: number, italic: boolean): string {
  let best = styles[0] ?? 'Regular';
  let bestScore = Infinity;
  for (const s of styles) {
    const lower = s.toLowerCase();
    const w = WEIGHTS.find(([re]) => re.test(lower))?.[1] ?? 400;
    const isItalic = /italic|oblique/.test(lower);
    const odd = /condensed|narrow|expanded|wide|display|caption|text|compressed/.test(lower) ? 50 : 0;
    const score = Math.abs(w - weight) + (isItalic === italic ? 0 : 1000) + odd;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}
