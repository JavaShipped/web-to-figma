import { isCaptureDocument, type CaptureDocument } from '../../shared/schema';

// Plugin window: accepts a capture by paste, drop or file picker, then sends it to the main thread.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $<HTMLDivElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const importBtn = $<HTMLButtonElement>('import');
const statusEl = $<HTMLDivElement>('status');
const loadedEl = $<HTMLDivElement>('loaded');

let doc: CaptureDocument | null = null;

function setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}

function load(text: string) {
  try {
    const parsed = JSON.parse(text);
    if (!isCaptureDocument(parsed)) throw new Error('not a capture');
    doc = parsed;
    const host = (() => {
      try {
        return new URL(parsed.url).hostname;
      } catch {
        return parsed.url;
      }
    })();
    loadedEl.textContent = `${parsed.title || host} · ${Math.round(parsed.root.rect.width)}×${Math.round(parsed.root.rect.height)} · ${Object.keys(parsed.assets).length} images`;
    drop.dataset.state = 'loaded';
    importBtn.disabled = false;
    setStatus('Ready to import.');
  } catch {
    setStatus('That doesn’t look like a Web to Figma capture.', 'error');
  }
}

document.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (text) load(text);
});
drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (f) load(await f.text());
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.dataset.drag = '1';
});
drop.addEventListener('dragleave', () => delete drop.dataset.drag);
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  delete drop.dataset.drag;
  const f = e.dataTransfer?.files[0];
  if (f) load(await f.text());
});

importBtn.addEventListener('click', () => {
  if (!doc) return;
  importBtn.disabled = true;
  setStatus('Starting…');
  const options = {
    autoLayout: $<HTMLInputElement>('opt-autolayout').checked,
    components: $<HTMLInputElement>('opt-components').checked,
    styles: $<HTMLInputElement>('opt-styles').checked,
  };
  parent.postMessage({ pluginMessage: { type: 'import', doc, options } }, '*');
});

interface Summary {
  layers: number;
  seconds: number;
  components: number;
  instances: number;
  icons: number;
  colorVariables: number;
  textStyles: number;
  missingFonts: string[];
  failed: string[];
}

window.onmessage = (e: MessageEvent) => {
  const msg = e.data?.pluginMessage;
  if (!msg) return;
  if (msg.type === 'progress') setStatus(msg.text);
  else if (msg.type === 'error') {
    setStatus(msg.message, 'error');
    importBtn.disabled = false;
  } else if (msg.type === 'done') {
    const s = msg.summary as Summary;
    const parts = [`${s.layers} layers in ${s.seconds}s`];
    if (s.components || s.icons) parts.push(`${s.components} components, ${s.icons} icons, ${s.instances} instances`);
    if (s.colorVariables || s.textStyles) parts.push(`${s.colorVariables} colour variables, ${s.textStyles} text styles`);
    if (s.missingFonts.length) parts.push(`Missing fonts (replaced): ${s.missingFonts.join(', ')}`);
    if (s.failed.length) parts.push(`Left as frames (component conversion failed): ${s.failed.join(', ')}`);
    setStatus(parts.join('\n'), 'ok');
    importBtn.disabled = false;
  }
};
