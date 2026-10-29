// ::before / ::after can't be measured directly, so for the duration of a capture each one is
// replaced by a real element carrying the pseudo-element's computed style. The originals are hidden
// with an injected rule so layout doesn't change, and everything is undone afterwards.

const HIDE_CSS =
  '[data-w2f-hide-before]::before{content:none!important}[data-w2f-hide-after]::after{content:none!important}';

const NO_PSEUDO = new Set(['IMG', 'INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'CANVAS', 'IFRAME', 'BR', 'HR', 'svg']);

export function materializePseudos(root: Element): () => void {
  const style = document.createElement('style');
  style.textContent = HIDE_CSS;
  document.head.appendChild(style);
  const created: Element[] = [];
  const marked: [Element, string][] = [];

  const els = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of els) {
    if (NO_PSEUDO.has(el.tagName) || el instanceof SVGElement || el.closest('[data-w2f-ui]')) continue;
    for (const which of ['::before', '::after'] as const) {
      const cs = getComputedStyle(el, which);
      const content = cs.content;
      if (!content || content === 'none' || content === 'normal' || cs.display === 'none') continue;
      const text = contentText(content);
      // `content: ""` with no box is a clearfix or spacer hack: nothing to draw.
      if (text === '' && !hasBox(cs)) continue;

      const span = document.createElement('w2f-pseudo');
      for (let i = 0; i < cs.length; i++) {
        const prop = cs[i];
        if (prop === 'content') continue;
        span.style.setProperty(prop, cs.getPropertyValue(prop));
      }
      span.textContent = text;
      span.setAttribute('data-w2f-pseudo', which.slice(2));
      if (which === '::before') el.prepend(span);
      else el.append(span);
      const attr = which === '::before' ? 'data-w2f-hide-before' : 'data-w2f-hide-after';
      el.setAttribute(attr, '');
      created.push(span);
      marked.push([el, attr]);
    }
  }

  return () => {
    for (const el of created) el.remove();
    for (const [el, attr] of marked) el.removeAttribute(attr);
    style.remove();
  };
}

/** The literal text of a computed `content` value; counters, attr() and images give ''. */
function contentText(content: string): string {
  let out = '';
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const raw = m[1] ?? m[2] ?? '';
    out += raw.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, '$1');
  }
  return out;
}

function hasBox(cs: CSSStyleDeclaration): boolean {
  const transparent = cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent';
  return (
    !transparent ||
    cs.backgroundImage !== 'none' ||
    parseFloat(cs.borderTopWidth) > 0 ||
    parseFloat(cs.borderBottomWidth) > 0 ||
    parseFloat(cs.borderLeftWidth) > 0 ||
    parseFloat(cs.borderRightWidth) > 0 ||
    cs.boxShadow !== 'none'
  );
}
