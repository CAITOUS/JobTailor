// Opens the side panel (or a popup window where the browser lacks the side panel API)
// and routes "Answer with my profile" selections to it.

const HAS_SIDE_PANEL = !!(chrome.sidePanel && chrome.sidePanel.open);

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({
    id: 'jt-answer',
    title: 'Answer with my profile',
    contexts: ['selection'],
  });
  if (HAS_SIDE_PANEL) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'jt-answer' || !tab) return;
  // sidePanel.open must run inside the user gesture, before any await.
  if (HAS_SIDE_PANEL) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => openFallbackWindow(tab.id, tab));
  } else {
    openFallbackWindow(tab.id, tab);
  }
  chrome.storage.session.set({
    pendingQuestion: {
      text: (info.selectionText || '').trim(),
      tabId: tab.id,
      frameId: info.frameId || 0,
      pageUrl: info.pageUrl || tab.url,
      pageTitle: tab.title || '',
      at: Date.now(),
    },
  });
});
