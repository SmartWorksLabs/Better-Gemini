chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set({
      corner: 'top-left',
      usageCorner: 'top-right',
      hiddenOpacity: 0,
      revealMode: 'hover',
      typeToChat: true,
      avoidOverlap: true,
      hideDelayEnabled: false,
      hideDelayMs: 500,
      hideDelayUnit: 'ms',
      pillStyle: 'label',
      showUsage: true,
      showContext: true,
      firstInstalledDate: Date.now()
    });
  }
  // Older versions stored a theme flag and an unused reveal counter.
  chrome.storage.local.remove(['darkTheme', 'interactionsCount']);
});
