import { capture } from './capture';
import { detectComponents } from '../shared/components';
import { planLayouts } from '../shared/layout';
import { expandDocument, type CaptureDocument } from '../shared/schema';
import { blobToLoaded, rasterizeSvg } from '../extension/image-convert';

// Dev harness: the same capture without the extension, for fixture pages served locally.
// `await window.w2f.capture()` returns the CaptureDocument.

async function loadImage(url: string, maxWidth: number, maxHeight: number, allowSvg: boolean) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const loaded = await blobToLoaded(await res.blob(), maxWidth, maxHeight, true);
  if (loaded?.kind === 'svg' && !allowSvg) return rasterizeSvg(loaded.svg, maxWidth, maxHeight);
  return loaded;
}

(window as unknown as { w2f: unknown }).w2f = {
  capture: (selector?: string) =>
    capture({ root: selector ? document.querySelector(selector) : null, loadImage }),
  // Inspect what the plugin will do without opening Figma.
  plan: (doc: CaptureDocument) => {
    const full = expandDocument(structuredClone(doc));
    const plans = planLayouts(full.root);
    return { plans, components: detectComponents(full.root, plans) };
  },
};
