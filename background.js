// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.create({
    id: 'dgth-lookup',
    title: 'Look up "%s" in DGTH',
    contexts: ['selection']
  });
});

// Right-click selected text on any page -> look it up in the side panel.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'dgth-lookup' || !tab) return;
  chrome.sidePanel.open({ tabId: tab.id });
  chrome.storage.session.set({ pendingQuery: { text: info.selectionText, t: Date.now() } });
});
