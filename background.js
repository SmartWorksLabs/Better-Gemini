// Service workers have no window, so they can't check prefers-color-scheme.
// The content script reports the theme instead, and the last one reported is
// kept so the right icon comes back after Chrome restarts.
function applyThemeIcon(dark) {
  const suffix = dark ? '-dark' : '';
  chrome.action.setIcon({
    path: {
      16: `icons/icon16${suffix}.png`,
      32: `icons/icon32${suffix}.png`
    }
  });
}

function restoreThemeIcon() {
  chrome.storage.local.get(['darkTheme'], ({ darkTheme }) => {
    if (darkTheme !== undefined) applyThemeIcon(darkTheme);
  });
}

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
  restoreThemeIcon();
});

chrome.runtime.onStartup.addListener(restoreThemeIcon);

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'theme' && typeof message.dark === 'boolean') {
    applyThemeIcon(message.dark);
    chrome.storage.local.set({ darkTheme: message.dark });
  }
});
