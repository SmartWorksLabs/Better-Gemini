(function () {
  'use strict';

  const BAR_SELECTORS = [
    '.input-area-container',
    '[class*="input-area"]',
    '.bottom-container',
    'footer'
  ].join(', ');

  let settings = {
    corner: 'top-left',
    autoHide: true,
    interactionsCount: 0,
    firstInstalledDate: Date.now()
  };

  let pillElement = null;
  let shadowRoot = null;
  let menuOpen = false;

  // Load settings from storage
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['corner', 'autoHide', 'firstInstalledDate'], (syncResult) => {
        chrome.storage.local.get(['interactionsCount'], (localResult) => {
          settings = { ...settings, ...syncResult, ...localResult };
          if (!syncResult.firstInstalledDate) {
            chrome.storage.sync.set({ firstInstalledDate: settings.firstInstalledDate });
          }
          resolve(settings);
        });
      });
    });
  }

  // Save settings to storage
  function saveSettings(newSettings) {
    settings = { ...settings, ...newSettings };
    chrome.storage.sync.set(newSettings);
  }

  // chrome.storage.sync allows only ~120 writes per minute, so the
  // frequently-updated counter lives in local storage instead.
  function incrementInteractions() {
    settings.interactionsCount++;
    chrome.storage.local.set({ interactionsCount: settings.interactionsCount });
  }

  // Check if 7 days have passed since install
  function shouldShowReviewPrompt() {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return Date.now() - settings.firstInstalledDate > sevenDays;
  }

  // Apply hide state based on settings
  function applyHideState() {
    document.body.classList.add('hide-chatbar-enabled');
    document.body.classList.toggle('hide-chatbar-active', settings.autoHide);
  }

  // Update pill position
  function updatePillPosition() {
    if (!pillElement) return;

    pillElement.classList.remove(
      'pos-top-left',
      'pos-top-right',
      'pos-bottom-left',
      'pos-bottom-right'
    );
    pillElement.classList.add(`pos-${settings.corner}`);
  }

  function setMenuOpen(open) {
    menuOpen = open;
    const menu = shadowRoot && shadowRoot.querySelector('.menu');
    if (menu) menu.classList.toggle('open', open);
  }

  // Create the pill styles
  function getPillStyles() {
    return `
      :host {
        all: initial;
        font-family: 'Google Sans', Roboto, Arial, sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      button {
        font-family: inherit;
      }

      .pill-container {
        position: fixed;
        z-index: 999999;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .pill-container.pos-top-left {
        top: 80px;
        left: 16px;
      }

      .pill-container.pos-top-right {
        top: 80px;
        right: 72px;
      }

      .pill-container.pos-bottom-left {
        bottom: 100px;
        left: 16px;
      }

      .pill-container.pos-bottom-right {
        bottom: 100px;
        right: 72px;
      }

      .pill-button {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border: none;
        border-radius: 9999px;
        background: var(--gm-sys-color-surface-container-highest, #e3e3e3);
        color: var(--gm-sys-color-on-surface, #1f1f1f);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        box-shadow: 
          0 1px 2px rgba(0, 0, 0, 0.1),
          0 4px 8px rgba(0, 0, 0, 0.08);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        user-select: none;
      }

      .pill-button:hover {
        background: var(--gm-sys-color-surface-container-high, #d9d9d9);
        box-shadow: 
          0 2px 4px rgba(0, 0, 0, 0.12),
          0 6px 12px rgba(0, 0, 0, 0.1);
        transform: scale(1.02);
      }

      .pill-button:active {
        transform: scale(0.98);
      }

      .pill-icon {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }

      .menu {
        position: absolute;
        min-width: 220px;
        padding: 8px 0;
        background: var(--gm-sys-color-surface-container-low, #f7f7f7);
        border-radius: 16px;
        box-shadow: 
          0 2px 6px rgba(0, 0, 0, 0.15),
          0 8px 24px rgba(0, 0, 0, 0.12);
        opacity: 0;
        visibility: hidden;
        transform: scale(0.95) translateY(-8px);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 1000000;
      }

      .menu.open {
        opacity: 1;
        visibility: visible;
        transform: scale(1) translateY(0);
      }

      .pos-top-left .menu,
      .pos-top-right .menu {
        top: calc(100% + 8px);
      }

      .pos-bottom-left .menu,
      .pos-bottom-right .menu {
        bottom: calc(100% + 8px);
      }

      .pos-top-left .menu,
      .pos-bottom-left .menu {
        left: 0;
      }

      .pos-top-right .menu,
      .pos-bottom-right .menu {
        right: 0;
      }

      .menu-header {
        padding: 12px 16px 8px;
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--gm-sys-color-on-surface-variant, #5f5f5f);
      }

      .menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .menu-item:hover {
        background: var(--gm-sys-color-surface-container, #ebebeb);
      }

      .menu-item-label {
        font-size: 14px;
        color: var(--gm-sys-color-on-surface, #1f1f1f);
      }

      .toggle {
        width: 36px;
        height: 20px;
        background: var(--gm-sys-color-outline, #79747e);
        border-radius: 9999px;
        position: relative;
        cursor: pointer;
        transition: background 0.2s ease;
      }

      .toggle.active {
        background: var(--gm-sys-color-primary, #0b57d0);
      }

      .toggle::after {
        content: '';
        position: absolute;
        width: 16px;
        height: 16px;
        background: white;
        border-radius: 50%;
        top: 2px;
        left: 2px;
        transition: transform 0.2s ease;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }

      .toggle.active::after {
        transform: translateX(16px);
      }

      .corner-selector {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        padding: 8px 16px 12px;
      }

      .corner-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 8px;
        border: 2px solid var(--gm-sys-color-outline, #79747e);
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        transition: all 0.15s ease;
        font-size: 11px;
        color: var(--gm-sys-color-on-surface-variant, #5f5f5f);
      }

      .corner-btn:hover {
        background: var(--gm-sys-color-surface-container, #ebebeb);
      }

      .corner-btn.active {
        border-color: var(--gm-sys-color-primary, #0b57d0);
        background: var(--gm-sys-color-primary-container, #d3e3fd);
        color: var(--gm-sys-color-on-primary-container, #041e49);
      }

      .divider {
        height: 1px;
        background: var(--gm-sys-color-outline-variant, #c4c7c5);
        margin: 8px 16px;
      }

      .review-link {
        display: block;
        padding: 12px 16px;
        font-size: 13px;
        color: var(--gm-sys-color-primary, #0b57d0);
        text-decoration: none;
        text-align: center;
        transition: background 0.15s ease;
      }

      .review-link:hover {
        background: var(--gm-sys-color-surface-container, #ebebeb);
      }
    `;
  }

  // Create the pill HTML
  function createPillHTML() {
    const reviewUrl = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
    return `
      <div class="pill-container pos-${settings.corner}">
        <button class="pill-button" aria-label="Hide Chat Bar Settings" aria-haspopup="true">
          <svg class="pill-icon" viewBox="0 0 24 24">
            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
          </svg>
          <span>Chat Bar</span>
        </button>
        <div class="menu">
          <div class="menu-header">Settings</div>
          <div class="menu-item" data-action="toggle-autohide" role="switch" tabindex="0" aria-checked="${settings.autoHide}">
            <span class="menu-item-label">Auto-Hide</span>
            <div class="toggle ${settings.autoHide ? 'active' : ''}" data-toggle="autohide"></div>
          </div>
          <div class="divider"></div>
          <div class="menu-header">Position</div>
          <div class="corner-selector">
            <button class="corner-btn ${settings.corner === 'top-left' ? 'active' : ''}" data-corner="top-left">↖ Top Left</button>
            <button class="corner-btn ${settings.corner === 'top-right' ? 'active' : ''}" data-corner="top-right">↗ Top Right</button>
            <button class="corner-btn ${settings.corner === 'bottom-left' ? 'active' : ''}" data-corner="bottom-left">↙ Bottom Left</button>
            <button class="corner-btn ${settings.corner === 'bottom-right' ? 'active' : ''}" data-corner="bottom-right">↘ Bottom Right</button>
          </div>
          <div class="review-prompt" style="display: none;">
            <div class="divider"></div>
            <a class="review-link" href="${reviewUrl}" target="_blank" rel="noopener noreferrer">
              ⭐ Enjoying this? Leave a Review
            </a>
          </div>
        </div>
      </div>
    `;
  }

  function syncToggleUI() {
    if (!shadowRoot) return;
    const toggleEl = shadowRoot.querySelector('[data-toggle="autohide"]');
    const toggleItem = shadowRoot.querySelector('[data-action="toggle-autohide"]');
    if (toggleEl) toggleEl.classList.toggle('active', settings.autoHide);
    if (toggleItem) toggleItem.setAttribute('aria-checked', String(settings.autoHide));
  }

  function syncCornerUI() {
    if (!shadowRoot) return;
    shadowRoot.querySelectorAll('.corner-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.corner === settings.corner);
    });
  }

  // Initialize the pill UI
  function createPill() {
    if (document.getElementById('hide-chatbar-pill-host')) return;

    const host = document.createElement('div');
    host.id = 'hide-chatbar-pill-host';

    shadowRoot = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = getPillStyles();
    shadowRoot.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = createPillHTML();
    shadowRoot.appendChild(wrapper);

    pillElement = shadowRoot.querySelector('.pill-container');
    const pillButton = shadowRoot.querySelector('.pill-button');
    const toggleItem = shadowRoot.querySelector('[data-action="toggle-autohide"]');
    const cornerBtns = shadowRoot.querySelectorAll('.corner-btn');
    const reviewPrompt = shadowRoot.querySelector('.review-prompt');

    if (shouldShowReviewPrompt()) {
      reviewPrompt.style.display = 'block';
    }

    pillButton.addEventListener('click', () => {
      setMenuOpen(!menuOpen);
    });

    // Clicks inside the shadow DOM still bubble to document, so only
    // close the menu when the click really happened outside the pill.
    document.addEventListener('click', (e) => {
      if (menuOpen && !e.composedPath().includes(host)) {
        setMenuOpen(false);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (menuOpen && e.key === 'Escape') {
        setMenuOpen(false);
      }
    });

    function toggleAutoHide() {
      saveSettings({ autoHide: !settings.autoHide });
      syncToggleUI();
      applyHideState();
    }

    toggleItem.addEventListener('click', toggleAutoHide);
    toggleItem.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleAutoHide();
      }
    });

    cornerBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        saveSettings({ corner: btn.dataset.corner });
        syncCornerUI();
        updatePillPosition();
      });
    });

    document.body.appendChild(host);
  }

  // Gemini streams responses into the DOM, which fires a large number of
  // mutations, so the content check is batched to once per animation frame.
  function watchInputContent() {
    let scheduled = false;

    function checkContent() {
      scheduled = false;
      const hasContent = Array.from(
        document.querySelectorAll('[contenteditable="true"]')
      ).some((el) => (el.textContent || '').trim().length > 0);

      document.body.classList.toggle('has-content', hasContent);
    }

    const observer = new MutationObserver(() => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(checkContent);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    checkContent();
  }

  // Gemini is a single-page app that re-renders the input bar, so listen at
  // the document level instead of binding to elements that may be replaced.
  function trackInteractions() {
    document.addEventListener('mouseover', (e) => {
      if (!settings.autoHide || !document.body.classList.contains('hide-chatbar-active')) return;

      const bar = e.target instanceof Element ? e.target.closest(BAR_SELECTORS) : null;
      if (!bar) return;

      const from = e.relatedTarget instanceof Element ? e.relatedTarget.closest(BAR_SELECTORS) : null;
      if (from !== bar) {
        incrementInteractions();
      }
    });
  }

  // Listen for storage changes (instant reactivity across tabs)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return;

    if (changes.corner) {
      settings.corner = changes.corner.newValue;
      updatePillPosition();
      syncCornerUI();
    }

    if (changes.autoHide) {
      settings.autoHide = changes.autoHide.newValue;
      applyHideState();
      syncToggleUI();
    }
  });

  async function init() {
    await loadSettings();
    applyHideState();
    createPill();
    watchInputContent();
    trackInteractions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
