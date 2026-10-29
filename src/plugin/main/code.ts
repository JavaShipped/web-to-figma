import { isCaptureDocument } from '../../shared/schema';
import { importCapture, type ImportOptions } from './import';

// Plugin entry: receives a capture from the UI and rebuilds it on the current page.

type UiMessage = { type: 'import'; doc: unknown; options: ImportOptions } | { type: 'close' };

figma.showUI(__html__, { width: 340, height: 460, themeColors: true });

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === 'close') return figma.closePlugin();
  if (msg.type !== 'import') return;
  if (!isCaptureDocument(msg.doc)) {
    post({ type: 'error', message: 'That isn’t a Web to Figma capture. Capture a page with the browser extension first.' });
    return;
  }
  try {
    const summary = await importCapture(msg.doc, msg.options, (text) => post({ type: 'progress', text }));
    post({ type: 'done', summary });
  } catch (err) {
    console.error(err);
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};

function post(msg: unknown) {
  figma.ui.postMessage(msg);
}
