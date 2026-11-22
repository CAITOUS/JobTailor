// Opens the side panel (or a popup window where the browser lacks the side panel API),
// routes "Answer with my profile" selections to it, saves highlighted text as context,
// and shows the number of follow-ups due on the toolbar icon.

import { migrate, addNote, dueCount } from './lib/store.js';

const HAS_SIDE_PANEL = !!(chrome.sidePanel && chrome.sidePanel.open);

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'jt-answer', title: 'Answer with my profile', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'jt-save-context', title: 'Save to Job Tailor context', contexts: ['selection'] });
  });
  if (HAS_SIDE_PANEL) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  await migrate();
  chrome.alarms.create('jt-followups', { periodInMinutes: 60 });
  updateBadge();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(async () => {
  await migrate();
  chrome.alarms.create('jt-followups', { periodInMinutes: 60 });
  updateBadge();
});

// ---------- follow-up badge ----------
let flashing = false;
async function updateBadge() {
  if (flashing) return;
  const n = await dueCount().catch(() => 0);
  await chrome.action.setBadgeBackgroundColor({ color: '#a35200' });
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setTitle({ title: n ? `Job Tailor · ${n} follow-up${n === 1 ? '' : 's'} due` : 'Open Job Tailor' });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'jt-followups') updateBadge(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.log || changes.settings)) updateBadge();
});

function openFallbackWindow(tabId, tab) {
  chrome.windows.create({
    url: chrome.runtime.getURL(`panel.html?tabId=${tabId}`),
    type: 'popup',
    width: 460,
    height: 820,
    left: tab && tab.width ? Math.max(0, tab.width - 460) : undefined,
  });
}

if (!HAS_SIDE_PANEL) {
  chrome.action.onClicked.addListener((tab) => openFallbackWindow(tab.id, tab));
}

async function flashBadge(text) {
  flashing = true;
  await chrome.action.setBadgeBackgroundColor({ color: '#6a4cff' });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => { flashing = false; updateBadge(); }, 2500);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const text = (info.selectionText || '').trim();

  if (info.menuItemId === 'jt-save-context') {
    addNote(text, { title: tab.title || '', url: info.pageUrl || tab.url || '' })
      .then(() => flashBadge('+1'));
    return;
  }

  if (info.menuItemId !== 'jt-answer') return;
  // sidePanel.open must run inside the user gesture, before any await.
  if (HAS_SIDE_PANEL) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => openFallbackWindow(tab.id, tab));
  } else {
    openFallbackWindow(tab.id, tab);
  }
  chrome.storage.session.set({
    pendingQuestion: {
      text,
      tabId: tab.id,
      frameId: info.frameId || 0,
      pageUrl: info.pageUrl || tab.url,
      pageTitle: tab.title || '',
      at: Date.now(),
    },
  });
});
