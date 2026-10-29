// Layer names for captured elements: component name > aria-label > meaningful class/id > semantic tag.

import { humanize, meaningfulClass, TAG_NAMES } from '../shared/names';

export function elementName(el: Element, componentName?: string): string {
  if (componentName) return componentName;
  const aria = el.getAttribute('aria-label');
  if (aria && aria.length <= 40) return aria;
  const cls = meaningfulClass(typeof el.className === 'string' ? el.className : undefined);
  if (cls) return cls;
  const id = el.id;
  if (id && id.length <= 30 && !/\d{3,}|^[:_]/.test(id)) return humanize(id);
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') return (el as HTMLImageElement).alt?.slice(0, 40) || 'Image';
  const role = el.getAttribute('role');
  if (role && role.length <= 20) return humanize(role);
  return TAG_NAMES[tag] ?? 'Frame';
}

export function textName(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 39)}…` : t || 'Text';
}
