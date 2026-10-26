chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set({
      corner: 'top-left',
      hiddenOpacity: 0,
      revealMode: 'click',
      typeToChat: true,
      avoidOverlap: true,
      hideDelayEnabled: false,
      hideDelayMs: 500,
      hideDelayUnit: 'ms',
      pillStyle: 'icon',
      firstInstalledDate: Date.now()
    });
  }
  // Older versions stored a theme flag and an unused reveal counter.
  chrome.storage.local.remove(['darkTheme', 'interactionsCount']);
});
