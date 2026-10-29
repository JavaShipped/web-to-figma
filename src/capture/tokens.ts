import { parseColor } from '../shared/color';
import type { ColorToken } from '../shared/schema';

// Colour custom properties defined on :root (e.g. Tailwind v4's --color-blue-500, shadcn's --primary).
// The plugin uses them to name colour variables after the site's own tokens.

const MAX_TOKENS = 600;

export function readColorTokens(): ColorToken[] {
  const names = new Set<string>();
  const rootStyle = getComputedStyle(document.documentElement);
  for (let i = 0; i < rootStyle.length; i++) {
    if (rootStyle[i].startsWith('--')) names.add(rootStyle[i]);
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules; // throws for cross-origin sheets
    } catch {
      continue;
    }
    collectRootProps(rules, names);
  }

  const tokens: ColorToken[] = [];
  for (const name of names) {
    if (tokens.length >= MAX_TOKENS) break;
    const value = rootStyle.getPropertyValue(name).trim();
    if (!value || value.includes('var(')) continue;
    const color = parseColor(value);
    if (color && color.a > 0) tokens.push({ name, color });
  }
  return tokens;
}

function collectRootProps(rules: CSSRuleList, names: Set<string>) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule && /(:root|^html\b|:host)/.test(rule.selectorText)) {
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style[i];
        if (prop.startsWith('--')) names.add(prop);
      }
    }
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested) collectRootProps(nested, names);
  }
}
