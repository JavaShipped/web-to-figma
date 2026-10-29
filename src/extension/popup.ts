// Toolbar popup: injects the framework probe (page world) and the capture script (isolated world)
// into the active tab, then starts a capture.

const statusEl = document.getElementById('status')!;
const scrollFirst = document.getElementById('scroll-first') as HTMLInputElement;

try {
  scrollFirst.checked = localStorage.getItem('w2f:scrollFirst') === '1';
} catch {
  /* storage unavailable */
}
scrollFirst.addEventListener('change', () => {
  try {
    localStorage.setItem('w2f:scrollFirst', scrollFirst.checked ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
});

document.getElementById('capture-page')!.addEventListener('click', () => start('page'));
document.getElementById('capture-pick')!.addEventListener('click', () => start('pick'));

async function start(mode: 'page' | 'pick') {
  statusEl.textContent = 'Starting…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    if (!/^(https?|file):/.test(tab.url ?? '')) throw new Error('This page can’t be captured (browser pages and the Web Store are off limits).');
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: ['probe.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target, files: ['capture.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'w2f:capture', mode, scrollFirst: scrollFirst.checked });
    window.close();
  } catch (err) {
    statusEl.textContent = (err as Error).message;
  }
}
