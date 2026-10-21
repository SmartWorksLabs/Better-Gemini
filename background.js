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
      showUsage: true,
      showContext: true,
      showTimelines: true,
      firstInstalledDate: Date.now()
    });
  }
  if (details.reason === 'update') {
    // Product defaults moved to click-to-reveal and icon-only settings button.
    chrome.storage.sync.set({ revealMode: 'click', pillStyle: 'icon' });
    chrome.storage.sync.get(['showTimelines'], (result) => {
      if (result.showTimelines === undefined) {
        chrome.storage.sync.set({ showTimelines: true });
      }
    });
    // v1.2.7: nested branch history — wipe older timeline schemas once.
    chrome.storage.local.get(['betterGeminiTimelinesVersion'], (result) => {
      const ver = result && result.betterGeminiTimelinesVersion;
      if (ver !== 7) {
        chrome.storage.local.remove(['betterGeminiTimelines']);
        chrome.storage.local.set({ betterGeminiTimelinesVersion: 7 });
      }
    });
  }
  // Older versions stored a theme flag and an unused reveal counter.
  chrome.storage.local.remove(['darkTheme', 'interactionsCount']);
});
