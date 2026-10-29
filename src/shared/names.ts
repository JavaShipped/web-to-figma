// Naming helpers shared by the capture (DOM) and the plugin: readable names from class lists and tags.

export const UTILITY =
  /^(-?(m|p)[xytrbl]?-|[wh]-|min-|max-|size-|text-|bg-|from-|via-|to-|border|rounded|shadow|gap-|space-|items-|justify-|content-|self-|place-|font-|leading-|tracking-|z-|top-|left-|right-|bottom-|inset|col-|row-|order-|ring|outline|cursor-|select-|pointer-|opacity-|transition|duration-|ease-|delay-|animate-|backdrop-|blur|filter|divide-|fill-|stroke-|object-|aspect-|translate-|rotate-|scale-|skew-|origin-|overflow|whitespace-|break-|line-clamp|truncate|basis-|grow|shrink|flex|grid|inline|block|hidden|contents|table|absolute|relative|fixed|sticky|static|container|mx-auto|sr-only|not-sr-only|uppercase|lowercase|capitalize|normal-case|italic|underline|antialiased|subpixel|list-|decoration-|align-|visible|invisible|isolate|peer|group|prose|dark|light)/;

export const TAG_NAMES: Record<string, string> = {
  nav: 'Nav',
  header: 'Header',
  footer: 'Footer',
  main: 'Main',
  aside: 'Aside',
  section: 'Section',
  article: 'Article',
  form: 'Form',
  button: 'Button',
  a: 'Link',
  ul: 'List',
  ol: 'List',
  li: 'List item',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
  p: 'Paragraph',
  label: 'Label',
  input: 'Input',
  textarea: 'Textarea',
  select: 'Select',
  table: 'Table',
  thead: 'Table head',
  tbody: 'Table body',
  tr: 'Table row',
  td: 'Table cell',
  th: 'Table header cell',
  img: 'Image',
  figure: 'Figure',
  blockquote: 'Quote',
  hr: 'Divider',
  dialog: 'Dialog',
  body: 'Page',
};

/** First class that looks authored rather than a utility. CSS-module hashes are stripped. */
export function meaningfulClass(className: string | undefined): string | null {
  const classes = className ? className.split(/\s+/) : [];
  for (const c of classes) {
    if (!c || c.includes(':') || c.includes('[') || UTILITY.test(c)) continue;
    const moduleMatch = /^([A-Za-z][A-Za-z0-9]*)_([A-Za-z][A-Za-z0-9-]*)__[A-Za-z0-9_-]{4,}$/.exec(c);
    if (moduleMatch) return `${moduleMatch[1]} ${moduleMatch[2]}`;
    if (/^[a-z]{1,3}\d|^css-|^sc-|^jsx-|^_|^[A-Za-z0-9]{6,8}$/.test(c) && /\d/.test(c)) continue; // generated
    if (c.length < 3) continue;
    return humanize(c);
  }
  return null;
}

export function humanize(s: string): string {
  const spaced = s.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

