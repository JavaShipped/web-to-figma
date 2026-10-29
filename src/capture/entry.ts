import { capture, type ImageLoader, type LoadedImage } from './capture';
import { blobToLoaded, rasterizeSvg } from '../extension/image-convert';

// Content script. The popup injects it (plus the framework probe) and then sends a capture message.
// The result goes to the clipboard and can be downloaded as a .w2f.json file for the Figma plugin.

interface CaptureMessage {
  type: 'w2f:capture';
  mode: 'page' | 'pick';
  scrollFirst: boolean;
}

declare global {
  interface Window {
    __w2fContentLoaded?: boolean;
  }
}

if (!window.__w2fContentLoaded) {
  window.__w2fContentLoaded = true;
  chrome.runtime.onMessage.addListener((msg: CaptureMessage, _sender, sendResponse) => {
    if (msg?.type !== 'w2f:capture') return false;
    sendResponse({ ok: true });
    void run(msg);
    return false;
  });
}

const loadImage: ImageLoader = async (url, maxWidth, maxHeight, allowSvg) => {
  let result: LoadedImage | null;
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    const res = await fetch(url);
    result = await blobToLoaded(await res.blob(), maxWidth, maxHeight, true);
  } else {
    result = await chrome.runtime.sendMessage({ type: 'w2f:fetch-image', url, maxWidth, maxHeight, allowSvg: true });
  }
  if (result?.kind === 'svg' && !allowSvg) return rasterizeSvg(result.svg, maxWidth, maxHeight);
  return result;
};

async function run(msg: CaptureMessage) {
  const toast = new Toast();
  try {
    let root: Element | null = null;
    if (msg.mode === 'pick') {
      toast.show('Click an element to capture. ↑ selects the parent, Esc cancels.');
      root = await pickElement();
      if (!root) {
        toast.close();
        return;
      }
    }
    toast.show('Capturing…');
    const started = performance.now();
    const doc = await capture({ root, loadImage, scrollFirst: msg.scrollFirst, onProgress: (m) => toast.show(m) });
    const json = JSON.stringify(doc);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const sizeMb = (json.length / 1024 / 1024).toFixed(1);
    const fileName = `${slug(doc.title || location.hostname)}.w2f.json`;
    let copied = false;
    try {
      await navigator.clipboard.writeText(json);
      copied = true;
    } catch {
      copied = false;
    }
    toast.result(
      copied
        ? `Copied (${sizeMb} MB, ${seconds}s). Paste into the Web to Figma plugin.`
        : `Captured (${sizeMb} MB, ${seconds}s). Copy or download it for the Web to Figma plugin.`,
      json,
      fileName,
    );
  } catch (err) {
    toast.result(`Capture failed: ${(err as Error).message}`, null, '');
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'capture';
}

// ---------- element picker ----------

function pickElement(): Promise<Element | null> {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.setAttribute('data-w2f-ui', '');
    Object.assign(box.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483646',
      border: '2px solid #0d99ff',
      background: 'rgba(13,153,255,0.12)',
      borderRadius: '2px',
      transition: 'all 60ms ease-out',
    });
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute',
      top: '-22px',
      left: '-2px',
      font: '11px/18px system-ui, sans-serif',
      color: '#fff',
      background: '#0d99ff',
      padding: '0 6px',
      borderRadius: '2px',
      whiteSpace: 'nowrap',
    });
    box.appendChild(label);
    document.documentElement.appendChild(box);
    let current: Element | null = null;

    const show = (el: Element | null) => {
      current = el;
      if (!el) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/)[0]}` : '';
      label.textContent = `${el.tagName.toLowerCase()}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    };
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && !el.closest('[data-w2f-ui]')) show(el);
    };
    const finish = (el: Element | null) => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      resolve(el);
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      finish(current);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'ArrowUp' && current?.parentElement) {
        e.preventDefault();
        show(current.parentElement);
      } else if (e.key === 'Enter') finish(current);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
}

// ---------- toast ----------

class Toast {
  private host = document.createElement('w2f-ui');
  private root: ShadowRoot;
  private body: HTMLDivElement;

  constructor() {
    this.host.setAttribute('data-w2f-ui', '');
    Object.assign(this.host.style, { position: 'fixed', zIndex: '2147483647', right: '16px', bottom: '16px' });
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `
      <style>
        .t { font: 13px/1.4 system-ui, -apple-system, sans-serif; color: #fff; background: #1e1e1e; border-radius: 8px;
             padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.3); max-width: 340px; display: flex; flex-direction: column; gap: 10px; }
        .row { display: flex; gap: 8px; }
        button { font: inherit; border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; background: #0d99ff; color: #fff; }
        button.secondary { background: #383838; }
        .title { font-weight: 600; }
      </style>
      <div class="t"><div class="title">Web to Figma</div><div class="msg"></div></div>`;
    this.body = this.root.querySelector('.t')!;
  }

  show(message: string) {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    this.root.querySelector('.msg')!.textContent = message;
    this.body.querySelector('.row')?.remove();
  }

  result(message: string, json: string | null, fileName: string) {
    this.show(message);
    const row = document.createElement('div');
    row.className = 'row';
    if (json) {
      const copy = button('Copy', async () => {
        await navigator.clipboard.writeText(json);
        copy.textContent = 'Copied';
      });
      const download = button('Download', () => {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      });
      row.append(copy, download);
    }
    const close = button('Close', () => this.close());
    close.className = 'secondary';
    row.append(close);
    this.body.append(row);
  }

  close() {
    this.host.remove();
  }
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
