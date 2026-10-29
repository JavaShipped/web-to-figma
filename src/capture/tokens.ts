import { parseColor } from '../shared/color';
import type { ColorToken } from '../shared/schema';

// Colour custom properties (Tailwind v4's --color-blue-500, shadcn's --primary, or a site's own
// scoped tokens like `.lp { --lp-moss: … }`). The plugin uses them to name colour variables after
// the site's own tokens. Each property is resolved on an element its declaring rule applies to.

const MAX_TOKENS = 600;

export function readColorTokens(scope: Element = document.body): ColorToken[] {
  // property name → selectors that declare it
  const declared = new Map<string, Set<string>>();
  const rootStyle = getComputedStyle(document.documentElement);
  for (let i = 0; i < rootStyle.length; i++) {
    if (rootStyle[i].startsWith('--')) add(declared, rootStyle[i], ':root');
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules; // throws for cross-origin sheets
    } catch {
      continue;
    }
    collect(rules, declared);
  }

  const tokens: ColorToken[] = [];
  const styleOf = new Map<Element, CSSStyleDeclaration>();
  const computed = (el: Element) => {
    let cs = styleOf.get(el);
    if (!cs) styleOf.set(el, (cs = getComputedStyle(el)));
    return cs;
  };
  for (const [name, selectors] of declared) {
    if (tokens.length >= MAX_TOKENS) break;
    for (const el of targets(selectors, scope)) {
      const value = computed(el).getPropertyValue(name).trim();
      if (!value || value.includes('var(')) continue;
      const color = parseColor(value);
      if (color && color.a > 0) tokens.push({ name, color });
      break;
    }
  }
  return tokens;
}

function add(map: Map<string, Set<string>>, name: string, selector: string) {
  const set = map.get(name) ?? new Set();
  set.add(selector);
  map.set(name, set);
}

function collect(rules: CSSRuleList, declared: Map<string, Set<string>>) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style[i];
        if (prop.startsWith('--')) add(declared, prop, rule.selectorText);
      }
    }
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested) collect(nested, declared);
  }
}

/** Elements to resolve a property on: the first match of each declaring selector, then the page. */
function* targets(selectors: Set<string>, scope: Element): Generator<Element> {
  for (const sel of selectors) {
    if (/(^|,)\s*(:root|html|:host)\b/.test(sel)) {
      yield document.documentElement;
      continue;
    }
    try {
      const el = scope.matches(sel) ? scope : (scope.querySelector(sel) ?? document.querySelector(sel));
      if (el) yield el;
    } catch {
      /* selector the DOM API can't parse (e.g. nested & syntax) */
    }
  }
  yield document.documentElement;
}
