import { blobToLoaded } from './image-convert';

// Service worker. Fetches images for the content script: with host permissions it isn't blocked by
// CORS, and it sends the user's cookies so images behind a login (internal tools) still load.

interface FetchImageMessage {
  type: 'w2f:fetch-image';
  url: string;
  maxWidth: number;
  maxHeight: number;
  allowSvg: boolean;
}

chrome.runtime.onMessage.addListener((msg: FetchImageMessage, _sender, sendResponse) => {
  if (msg?.type !== 'w2f:fetch-image') return false;
  fetchImage(msg)
    .then(sendResponse)
    .catch(() => sendResponse(null));
  return true; // async response
});

async function fetchImage(msg: FetchImageMessage) {
  const res = await fetch(msg.url, { credentials: 'include' });
  if (!res.ok) return null;
  return blobToLoaded(await res.blob(), msg.maxWidth, msg.maxHeight, msg.allowSvg);
}
