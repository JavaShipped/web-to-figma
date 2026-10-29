import type { LoadedImage } from '../capture/capture';

// Turns a fetched image into something Figma accepts: PNG/JPEG/GIF bytes (others are re-encoded via
// OffscreenCanvas), downscaled to the size it is shown at, or raw SVG markup. Works in the service
// worker and in content scripts.

const PASSTHROUGH = new Set(['image/png', 'image/jpeg', 'image/gif']);

export async function blobToLoaded(blob: Blob, maxWidth: number, maxHeight: number, allowSvg: boolean): Promise<LoadedImage | null> {
  const type = blob.type.toLowerCase();
  if (type.includes('svg') || (await looksLikeSvg(blob))) {
    const svg = await blob.text();
    if (allowSvg) return { kind: 'svg', svg };
    return rasterizeSvg(svg, maxWidth, maxHeight);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  if (scale >= 0.95 && PASSTHROUGH.has(type)) {
    bitmap.close();
    return { kind: 'raster', asset: { mime: type as 'image/png', data: await toBase64(blob), width, height } };
  }
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const mime = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const out = await canvas.convertToBlob({ type: mime, quality: 0.9 });
  return { kind: 'raster', asset: { mime, data: await toBase64(out), width: w, height: h } };
}

/** Needs a DOM (content script): workers can't decode SVG. */
export async function rasterizeSvg(svg: string, maxWidth: number, maxHeight: number): Promise<LoadedImage | null> {
  if (typeof Image === 'undefined') return null;
  try {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const w = Math.max(1, Math.min(maxWidth, img.naturalWidth || maxWidth));
    const h = Math.max(1, Math.min(maxHeight, img.naturalHeight || maxHeight));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { kind: 'raster', asset: { mime: 'image/png', data: await toBase64(blob), width: w, height: h } };
  } catch {
    return null;
  }
}

async function looksLikeSvg(blob: Blob): Promise<boolean> {
  if (blob.type && blob.type !== 'application/octet-stream' && blob.type !== 'text/plain' && blob.type !== 'text/xml') return false;
  const head = await blob.slice(0, 256).text();
  return /<svg[\s>]/i.test(head);
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
