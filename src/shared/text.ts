import type { Paint, TextRun, TextStyle } from './schema';

/** A DOM text fragment before white-space processing. */
export interface RawRun {
  text: string;
  style: TextStyle;
  ws: 'collapse' | 'preserve' | 'preserve-breaks';
  href?: string;
  fill?: Paint;
  br?: boolean;
}

/** Applies CSS white-space collapsing across runs, then merges neighbours with identical style. */
export function normalizeRuns(raw: RawRun[]): TextRun[] {
  const out: TextRun[] = [];
  let prevSpace = true; // start of block: leading collapsible whitespace is dropped
  for (const r of raw) {
    let t = r.text;
    if (r.br) {
      prevSpace = true;
    } else if (r.ws === 'preserve') {
      if (t) prevSpace = /\s$/.test(t);
    } else {
      t = r.ws === 'preserve-breaks' ? t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n') : t.replace(/\s+/g, ' ');
      if (prevSpace && t.startsWith(' ')) t = t.slice(1);
      if (t) prevSpace = t.endsWith(' ') || t.endsWith('\n');
    }
    if (t) out.push({ text: t, style: r.style, href: r.href, ...(r.fill ? { fill: r.fill } : {}) });
  }
  // Trailing collapsible whitespace.
  while (out.length) {
    const last = out[out.length - 1];
    const trimmed = last.text.replace(/ +$/, '');
    if (trimmed) {
      last.text = trimmed;
      break;
    }
    out.pop();
  }
  const merged: TextRun[] = [];
  for (const r of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.href === r.href && JSON.stringify([prev.style, prev.fill]) === JSON.stringify([r.style, r.fill])) prev.text += r.text;
    else merged.push({ ...r });
  }
  return merged;
}
