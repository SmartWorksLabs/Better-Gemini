chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set({
      corner: 'top-left',
      autoHide: true,
      firstInstalledDate: Date.now()
    });
    chrome.storage.local.set({ interactionsCount: 0 });
  }
});
