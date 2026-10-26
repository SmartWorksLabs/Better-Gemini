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
  if (details.reason === 'update') {
    // Usage limits, the context window, and message versions moved to their
    // own extensions (Usage Tracker for Gemini, Message Versions for Gemini).
    chrome.storage.sync.remove(['showUsage', 'showContext', 'showTimelines']);
    chrome.storage.local.remove([
      'betterGeminiUsage', 'betterGeminiPlan', 'betterGeminiContext',
      'betterGeminiTimelines', 'betterGeminiTimelinesVersion'
    ]);
  }
  // Older versions stored a theme flag and an unused reveal counter.
  chrome.storage.local.remove(['darkTheme', 'interactionsCount']);
});
