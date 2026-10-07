chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set({
      corner: 'top-left',
      hiddenOpacity: 0,
      typeToChat: true,
      avoidOverlap: true,
      hideDelayEnabled: false,
      hideDelayMs: 500,
      hideDelayUnit: 'ms',
      pillStyle: 'label',
      firstInstalledDate: Date.now()
    });
    chrome.storage.local.set({ interactionsCount: 0 });
  }
  // Left over from older versions, which switched the toolbar icon by theme.
  chrome.storage.local.remove('darkTheme');
});
