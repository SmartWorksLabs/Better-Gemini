// Each switch is a chrome.storage.sync setting. Missing settings count as on.
document.querySelectorAll('[data-setting]').forEach((input) => {
  const key = input.dataset.setting;
  chrome.storage.sync.get([key], (result) => {
    input.checked = !result || result[key] !== false;
  });
  input.addEventListener('change', () => {
    chrome.storage.sync.set({ [key]: input.checked });
  });
});
