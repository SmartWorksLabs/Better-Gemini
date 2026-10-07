(function () {
  'use strict';

  const BAR_SELECTORS = [
    'input-container',
    '.input-area-container',
    '[class*="input-area"]'
  ].join(', ');

  // Distance from the screen edge, and the gap left beside other items.
  const EDGE_PADDING = 12;
  const OBSTACLE_GAP = 8;
  const MAX_PLACEMENT_STEPS = 60;

  const SYNC_KEYS = ['corner', 'autoHide', 'hiddenOpacity', 'typeToChat', 'avoidOverlap', 'firstInstalledDate'];
  const TOGGLE_KEYS = ['autoHide', 'typeToChat', 'avoidOverlap'];

  let settings = {
    corner: 'top-left',
    autoHide: true,
    hiddenOpacity: 0,
    typeToChat: true,
    avoidOverlap: true,
    interactionsCount: 0,
    firstInstalledDate: Date.now()
  };

  let hostElement = null;
  let pillElement = null;
  let shadowRoot = null;
  let menuOpen = false;
  let placementScheduled = false;

  // Load settings from storage
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(SYNC_KEYS, (syncResult) => {
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
    applyHiddenOpacity(settings.hiddenOpacity);
  }

  function applyHiddenOpacity(percent) {
    document.documentElement.style.setProperty('--hide-chatbar-hidden-opacity', String(percent / 100));
  }

  // ---------------------------------------------------------------------------
  // Pill placement
  // ---------------------------------------------------------------------------

  function viewportSize() {
    return {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight
    };
  }

  // Content inside a scrolling area (chat messages, the chat list) moves
  // around, so it should not push the pill away.
  function isInsideScrollingArea(el) {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
        return true;
      }
    }
    return false;
  }

  // Decides whether the element hit at (px, py) is something the pill should
  // not cover: buttons, logos, other extensions' widgets. Big layout pieces
  // (side rails, top bars, the page itself) are not obstacles; the items
  // inside them are. Returns { rect } for obstacles, or null.
  function asObstacle(el, px, py, viewport) {
    if (el === document.documentElement || el === document.body) return null;
    if (el === hostElement) return null;
    if (el.closest(BAR_SELECTORS)) return null;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') return null;
    if (isInsideScrollingArea(el)) return null;

    // A hit outside the element's own box means it is drawing content that
    // lives elsewhere, such as another extension's widget inside a shadow
    // root. Its real size can't be measured, so the caller steps past it.
    const rect = el.getBoundingClientRect();
    const containsPoint = px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
    if (!containsPoint || rect.width === 0 || rect.height === 0) return { rect: null };

    if (rect.width > viewport.width * 0.5 || rect.height > viewport.height * 0.5) return null;
    return { rect };
  }

  // Points at most SAMPLE_SPACING apart, including both ends, so small items
  // like icon buttons can't slip between them.
  const SAMPLE_SPACING = 12;
  function samplePoints(start, length) {
    const count = Math.max(2, Math.ceil(length / SAMPLE_SPACING) + 1);
    const points = [];
    for (let i = 0; i < count; i++) {
      points.push(start + 1 + ((length - 2) * i) / (count - 1));
    }
    return points;
  }

  // Checks a grid of points across the given box and returns the first
  // obstacle found.
  function findObstacle(x, y, width, height, viewport) {
    const xs = samplePoints(x, width);
    const ys = samplePoints(y, height);

    for (const py of ys) {
      for (const px of xs) {
        if (px < 0 || py < 0 || px >= viewport.width || py >= viewport.height) continue;

        const topElement = document.elementsFromPoint(px, py).find((el) => el !== hostElement);
        const obstacle = topElement && asObstacle(topElement, px, py, viewport);
        if (obstacle) return obstacle;
      }
    }
    return null;
  }

  // Slides the pill away from the corner along one axis until it finds a free
  // spot, without going past the middle of the screen.
  function scanForFreeSpot(start, size, viewport, axis, towardsStart) {
    const limit = axis === 'x' ? viewport.width : viewport.height;
    let pos = axis === 'x' ? start.x : start.y;

    for (let step = 0; step < MAX_PLACEMENT_STEPS; step++) {
      const x = axis === 'x' ? pos : start.x;
      const y = axis === 'y' ? pos : start.y;
      // Pad along the scan direction so the pill keeps a gap from neighbours
      // even when their size can't be measured.
      const padX = axis === 'x' ? OBSTACLE_GAP - 1 : 0;
      const padY = axis === 'y' ? OBSTACLE_GAP - 1 : 0;
      const hit = findObstacle(x - padX, y - padY, size.width + padX * 2, size.height + padY * 2, viewport);
      if (!hit) return { x, y };

      let next;
      if (hit.rect) {
        const farEdge = axis === 'x'
          ? (towardsStart ? hit.rect.left : hit.rect.right)
          : (towardsStart ? hit.rect.top : hit.rect.bottom);
        const extent = axis === 'x' ? size.width : size.height;
        next = towardsStart ? farEdge - OBSTACLE_GAP - extent : farEdge + OBSTACLE_GAP;
      }
      if (next === undefined || (towardsStart ? next >= pos : next <= pos)) {
        next = towardsStart ? pos - OBSTACLE_GAP : pos + OBSTACLE_GAP;
      }
      pos = next;

      const extent = axis === 'x' ? size.width : size.height;
      const pastMiddle = towardsStart ? pos < limit / 2 : pos + extent > limit / 2;
      if (pastMiddle || pos < EDGE_PADDING || pos + extent > limit - EDGE_PADDING) break;
    }
    return null;
  }

  function computePillPosition() {
    const viewport = viewportSize();
    const size = { width: pillElement.offsetWidth, height: pillElement.offsetHeight };
    const right = settings.corner.endsWith('right');
    const bottom = settings.corner.startsWith('bottom');

    const corner = {
      x: right ? viewport.width - EDGE_PADDING - size.width : EDGE_PADDING,
      y: bottom ? viewport.height - EDGE_PADDING - size.height : EDGE_PADDING
    };
    corner.x = Math.max(0, corner.x);
    corner.y = Math.max(0, corner.y);

    if (!settings.avoidOverlap) return corner;

    return (
      scanForFreeSpot(corner, size, viewport, 'x', right) ||
      scanForFreeSpot(corner, size, viewport, 'y', bottom) ||
      corner
    );
  }

  function placePill() {
    placementScheduled = false;
    if (!pillElement || menuOpen) return;

    pillElement.classList.remove('pos-top-left', 'pos-top-right', 'pos-bottom-left', 'pos-bottom-right');
    pillElement.classList.add(`pos-${settings.corner}`);

    const { x, y } = computePillPosition();
    pillElement.style.left = `${Math.round(x)}px`;
    pillElement.style.top = `${Math.round(y)}px`;

    // Keep the menu inside the screen, however small the window is.
    const viewport = viewportSize();
    const menu = shadowRoot.querySelector('.menu');
    const opensDown = settings.corner.startsWith('top');
    const room = opensDown
      ? viewport.height - (y + pillElement.offsetHeight) - OBSTACLE_GAP - EDGE_PADDING
      : y - OBSTACLE_GAP - EDGE_PADDING;
    menu.style.maxHeight = `${Math.max(160, Math.floor(room))}px`;

    if (!pillElement.classList.contains('placed')) {
      // Skip the slide animation on the very first placement.
      pillElement.classList.add('placed');
      requestAnimationFrame(() => pillElement.classList.add('animate'));
    }
  }

  function schedulePlacement() {
    if (placementScheduled) return;
    placementScheduled = true;
    requestAnimationFrame(placePill);
  }

  function setMenuOpen(open) {
    menuOpen = open;
    const menu = shadowRoot && shadowRoot.querySelector('.menu');
    if (menu) menu.classList.toggle('open', open);
    if (!open) schedulePlacement();
  }

  // ---------------------------------------------------------------------------
  // Pill UI
  // ---------------------------------------------------------------------------

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

      button, input {
        font-family: inherit;
      }

      .pill-container {
        position: fixed;
        z-index: 999999;
        visibility: hidden;
      }

      .pill-container.placed {
        visibility: visible;
      }

      .pill-container.animate {
        transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1),
                    top 0.25s cubic-bezier(0.4, 0, 0.2, 1);
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
        white-space: nowrap;
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
        width: 260px;
        max-width: calc(100vw - 24px);
        overflow-y: auto;
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
        gap: 12px;
        padding: 12px 16px;
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .menu-item:hover {
        background: var(--gm-sys-color-surface-container, #ebebeb);
      }

      .menu-item-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .menu-item-label {
        font-size: 14px;
        color: var(--gm-sys-color-on-surface, #1f1f1f);
      }

      .menu-item-hint {
        font-size: 11px;
        color: var(--gm-sys-color-on-surface-variant, #5f5f5f);
      }

      .toggle {
        flex-shrink: 0;
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

      .slider-row {
        padding: 8px 16px 12px;
      }

      .slider-heading {
        display: flex;
        justify-content: space-between;
        margin-bottom: 8px;
      }

      .slider-value {
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        color: var(--gm-sys-color-on-surface-variant, #5f5f5f);
      }

      .slider {
        width: 100%;
        margin: 0;
        cursor: pointer;
        accent-color: var(--gm-sys-color-primary, #0b57d0);
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

  function toggleRowHTML(key, label, hint) {
    const on = Boolean(settings[key]);
    return `
      <div class="menu-item" data-setting="${key}" role="switch" tabindex="0" aria-checked="${on}">
        <span class="menu-item-text">
          <span class="menu-item-label">${label}</span>
          ${hint ? `<span class="menu-item-hint">${hint}</span>` : ''}
        </span>
        <div class="toggle ${on ? 'active' : ''}"></div>
      </div>
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
          ${toggleRowHTML('autoHide', 'Auto-Hide')}
          ${toggleRowHTML('typeToChat', 'Type anywhere to chat', 'Start typing to open the chat bar')}
          <div class="slider-row">
            <div class="slider-heading">
              <label class="menu-item-label" for="hidden-opacity">Hidden bar visibility</label>
              <span class="slider-value">${settings.hiddenOpacity}%</span>
            </div>
            <input id="hidden-opacity" class="slider" type="range" min="0" max="100" step="5"
              value="${settings.hiddenOpacity}" aria-label="Hidden bar visibility">
          </div>
          <div class="divider"></div>
          <div class="menu-header">Position</div>
          <div class="corner-selector">
            <button class="corner-btn ${settings.corner === 'top-left' ? 'active' : ''}" data-corner="top-left">↖ Top Left</button>
            <button class="corner-btn ${settings.corner === 'top-right' ? 'active' : ''}" data-corner="top-right">↗ Top Right</button>
            <button class="corner-btn ${settings.corner === 'bottom-left' ? 'active' : ''}" data-corner="bottom-left">↙ Bottom Left</button>
            <button class="corner-btn ${settings.corner === 'bottom-right' ? 'active' : ''}" data-corner="bottom-right">↘ Bottom Right</button>
          </div>
          ${toggleRowHTML('avoidOverlap', 'Make room for other items', 'Turn off to always sit in the exact corner')}
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
    shadowRoot.querySelectorAll('[data-setting]').forEach((row) => {
      const on = Boolean(settings[row.dataset.setting]);
      row.setAttribute('aria-checked', String(on));
      row.querySelector('.toggle').classList.toggle('active', on);
    });
  }

  function syncCornerUI() {
    if (!shadowRoot) return;
    shadowRoot.querySelectorAll('.corner-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.corner === settings.corner);
    });
  }

  function syncSliderUI() {
    if (!shadowRoot) return;
    shadowRoot.querySelector('.slider').value = String(settings.hiddenOpacity);
    shadowRoot.querySelector('.slider-value').textContent = `${settings.hiddenOpacity}%`;
  }

  // Applies a setting change on this page (from the menu or another tab).
  function applySetting(key) {
    if (key === 'autoHide') applyHideState();
    if (key === 'hiddenOpacity') {
      applyHiddenOpacity(settings.hiddenOpacity);
      syncSliderUI();
    }
    if (key === 'corner') {
      syncCornerUI();
      pillElement.classList.remove('animate');
      placePillNow();
      requestAnimationFrame(() => pillElement.classList.add('animate'));
    }
    if (key === 'avoidOverlap') placePillNow();
    if (TOGGLE_KEYS.includes(key)) syncToggleUI();
  }

  // Repositions even while the menu is open, for changes made from the menu.
  function placePillNow() {
    const wasOpen = menuOpen;
    menuOpen = false;
    placePill();
    menuOpen = wasOpen;
  }

  // Initialize the pill UI
  function createPill() {
    if (document.getElementById('hide-chatbar-pill-host')) return;

    hostElement = document.createElement('div');
    hostElement.id = 'hide-chatbar-pill-host';

    shadowRoot = hostElement.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = getPillStyles();
    shadowRoot.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = createPillHTML();
    shadowRoot.appendChild(wrapper);

    pillElement = shadowRoot.querySelector('.pill-container');
    const pillButton = shadowRoot.querySelector('.pill-button');
    const slider = shadowRoot.querySelector('.slider');
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
      if (menuOpen && !e.composedPath().includes(hostElement)) {
        setMenuOpen(false);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (menuOpen && e.key === 'Escape') {
        setMenuOpen(false);
      }
    });

    shadowRoot.querySelectorAll('[data-setting]').forEach((row) => {
      const key = row.dataset.setting;
      const flip = () => {
        saveSettings({ [key]: !settings[key] });
        applySetting(key);
      };
      row.addEventListener('click', flip);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          flip();
        }
      });
    });

    // Preview while dragging, but only save when the slider is released,
    // to stay within chrome.storage.sync's write limits.
    slider.addEventListener('input', () => {
      settings.hiddenOpacity = Number(slider.value);
      applyHiddenOpacity(settings.hiddenOpacity);
      shadowRoot.querySelector('.slider-value').textContent = `${settings.hiddenOpacity}%`;
    });
    slider.addEventListener('change', () => {
      saveSettings({ hiddenOpacity: Number(slider.value) });
    });

    shadowRoot.querySelectorAll('.corner-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveSettings({ corner: btn.dataset.corner });
        applySetting('corner');
      });
    });

    document.body.appendChild(hostElement);
    placePill();

    // Re-check the spot when the window changes size and every couple of
    // seconds, since Gemini and other extensions add and move items.
    window.addEventListener('resize', schedulePlacement);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', schedulePlacement);
    setInterval(() => {
      if (!document.hidden) schedulePlacement();
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Type anywhere to chat
  // ---------------------------------------------------------------------------

  function isEditable(el) {
    return el instanceof Element &&
      (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  }

  function isVisible(el) {
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0;
  }

  // Leave keys alone while a dialog or popup menu is open.
  function hasOpenOverlay() {
    const overlays = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], .cdk-overlay-pane'
    );
    return Array.from(overlays).some((el) => el.childElementCount > 0 && isVisible(el));
  }

  function findChatEditor() {
    const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'));
    return (
      editors.find((el) => el.closest('input-container')) ||
      editors.find((el) => el.closest(BAR_SELECTORS)) ||
      editors[0] ||
      null
    );
  }

  function moveCaretToEnd(el) {
    if (el.tagName === 'TEXTAREA') {
      el.selectionStart = el.selectionEnd = el.value.length;
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function watchTyping() {
    // Bubble phase on window, so Gemini's own shortcuts get the key first.
    window.addEventListener('keydown', (e) => {
      if (!settings.typeToChat || e.defaultPrevented || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Only single printable characters. Space is skipped so it can still scroll the page.
      if (e.key.length !== 1 || e.key === ' ') return;

      const path = e.composedPath();
      if (hostElement && path.includes(hostElement)) return;
      if (path.some(isEditable) || isEditable(document.activeElement)) return;
      if (hasOpenOverlay()) return;

      const editor = findChatEditor();
      if (!editor) return;

      e.preventDefault();
      editor.focus();
      moveCaretToEnd(editor);
      // insertText fires the same input events as real typing, so Gemini
      // enables its send button and keeps its draft in sync.
      document.execCommand('insertText', false, e.key);
    });
  }

  // ---------------------------------------------------------------------------
  // Content and interaction tracking
  // ---------------------------------------------------------------------------

  let barElement = null;

  const barResizeObserver = new ResizeObserver(() => {
    if (barElement) {
      document.documentElement.style.setProperty('--hide-chatbar-bar-height', `${barElement.offsetHeight}px`);
    }
  });

  // The chat bar is Gemini's .input-area-container. If Gemini renames it,
  // fall back to the outermost "input-area" wrapper around the text box.
  function findBar() {
    const editor = findChatEditor();
    if (!editor) return null;

    const known = editor.closest('.input-area-container');
    if (known) return known;

    let outermost = null;
    for (let node = editor.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.tagName === 'INPUT-CONTAINER') break;
      if ((node.getAttribute('class') || '').includes('input-area')) outermost = node;
    }
    return outermost;
  }

  // Gemini re-renders the bar when switching chats, so this runs on every
  // DOM change to keep the tag on the current bar.
  function trackBar() {
    const bar = findBar();
    if (bar === barElement) {
      if (bar && !bar.classList.contains('hide-chatbar-bar')) bar.classList.add('hide-chatbar-bar');
      return;
    }

    if (barElement) {
      barElement.classList.remove('hide-chatbar-bar');
      barResizeObserver.unobserve(barElement);
    }
    barElement = bar;
    if (bar) {
      bar.classList.add('hide-chatbar-bar');
      barResizeObserver.observe(bar);
    }
  }

  // Gemini streams responses into the DOM, which fires a large number of
  // mutations, so the content check is batched to once per animation frame.
  function watchInputContent() {
    let scheduled = false;

    function checkContent() {
      scheduled = false;
      trackBar();
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
    if (namespace !== 'sync' || !pillElement) return;

    Object.keys(changes).forEach((key) => {
      if (!SYNC_KEYS.includes(key) || changes[key].newValue === undefined) return;
      if (settings[key] === changes[key].newValue) return;
      settings[key] = changes[key].newValue;
      applySetting(key);
    });
  });

  // prefers-color-scheme follows Chrome's light/dark mode (and the system
  // setting when Chrome is set to "Device"), which is what the toolbar uses.
  function watchColorScheme() {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const report = () => {
      try {
        chrome.runtime.sendMessage({ type: 'theme', dark: query.matches }).catch(() => {});
      } catch (error) {
        // The extension was reloaded or removed while this tab stayed open.
      }
    };
    report();
    query.addEventListener('change', report);
  }

  async function init() {
    await loadSettings();
    applyHideState();
    createPill();
    watchInputContent();
    trackInteractions();
    watchTyping();
    watchColorScheme();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
