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

  const SYNC_KEYS = [
    'corner', 'hiddenOpacity', 'typeToChat', 'avoidOverlap',
    'hideDelayEnabled', 'hideDelayMs', 'hideDelayUnit', 'pillStyle', 'firstInstalledDate'
  ];
  const TOGGLE_KEYS = ['typeToChat', 'avoidOverlap', 'hideDelayEnabled'];

  const DELAY_UNITS = { ms: 1, s: 1000, min: 60000 };
  const DELAY_SLIDER_MAX_MS = 5000;
  const DELAY_MAX_MS = 60 * 60000;
  const PILL_STYLES = ['label', 'icon'];

  let settings = {
    corner: 'top-left',
    hiddenOpacity: 0,
    typeToChat: true,
    avoidOverlap: true,
    hideDelayEnabled: false,
    hideDelayMs: 500,
    hideDelayUnit: 'ms',
    pillStyle: 'label',
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
        if (chrome.runtime.lastError || !syncResult) {
          resolve(settings);
          return;
        }
        settings = { ...settings, ...syncResult };
        if (!syncResult.firstInstalledDate) {
          chrome.storage.sync.set({ firstInstalledDate: settings.firstInstalledDate });
        }
        resolve(settings);
      });
    });
  }

  // Save settings to storage
  function saveSettings(newSettings) {
    settings = { ...settings, ...newSettings };
    chrome.storage.sync.set(newSettings);
  }

  // Check if 7 days have passed since install
  function shouldShowReviewPrompt() {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return Date.now() - settings.firstInstalledDate > sevenDays;
  }

  // The bar is always auto-hidden on Gemini pages.
  function applyHideState() {
    document.body.classList.add('hide-chatbar-enabled');
    document.body.classList.add('hide-chatbar-active');
    applyHiddenOpacity(settings.hiddenOpacity);
    applyHideDelay();
  }

  function applyHiddenOpacity(percent) {
    document.documentElement.style.setProperty('--hide-chatbar-hidden-opacity', String(percent / 100));
  }

  function applyHideDelay(ms = settings.hideDelayMs) {
    const delay = settings.hideDelayEnabled ? ms : 0;
    document.documentElement.style.setProperty('--hide-chatbar-hide-delay', `${delay}ms`);
  }

  function clampDelayMs(ms) {
    return Number.isFinite(ms) ? Math.min(DELAY_MAX_MS, Math.max(0, Math.round(ms))) : 0;
  }

  // Shows a delay in the chosen unit without long decimal tails.
  function formatDelay(ms, unit) {
    return String(Math.round((ms / DELAY_UNITS[unit]) * 1000) / 1000);
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

    // The chat bar counts even while hidden, since it comes back on hover.
    const bar = el.closest('.hide-chatbar-bar');
    if (bar) return { rect: bar.getBoundingClientRect() };

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') return null;
    if (isInsideScrollingArea(el)) return null;

    // A hit outside the element's own box means it is drawing content that
    // lives elsewhere, such as another extension's widget inside a shadow
    // root. Its real size can't be measured, so the caller steps past it.
    const rect = el.getBoundingClientRect();
    const containsPoint = px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
    if (!containsPoint || rect.width === 0 || rect.height === 0) return { rect: null };

    if (rect.width > viewport.width * 0.5 || rect.height > viewport.height * 0.5) return textLineAt(el, px, py);
    return { rect };
  }

  // Wide elements can still hold text, like the "Gemini can make mistakes"
  // line under the chat bar. Returns the line of the element's own text under
  // (px, py), if any.
  function textLineAt(el, px, py) {
    const range = document.createRange();
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        if (px >= line.left && px <= line.right && py >= line.top && py <= line.bottom) return { rect: line };
      }
    }
    return null;
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

  // Open side panels, such as Gemini's chat list or its collapsed icon rail,
  // are tall boxes against the left or right edge of the window. The pill and
  // its menu stay in the area between them.
  // Size changes of side panels are reported after layout but before the
  // frame is drawn, so re-placing the pill here keeps it exactly in step
  // while a panel slides open or shut.
  const observedPanels = new WeakSet();
  const panelObserver = new ResizeObserver(() => {
    if (!menuOpen) placePill();
  });

  function observePanel(panel) {
    if (observedPanels.has(panel)) return;
    observedPanels.add(panel);
    panelObserver.observe(panel);
  }

  function findMainArea(viewport) {
    let left = 0;
    let right = viewport.width;

    for (const side of ['left', 'right']) {
      const x = side === 'left' ? 1 : viewport.width - 2;
      for (const fraction of [0.3, 0.5, 0.7]) {
        const hit = document.elementsFromPoint(x, viewport.height * fraction).find((el) => el !== hostElement);
        for (let node = hit; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          const rect = node.getBoundingClientRect();
          const againstEdge = side === 'left' ? rect.left <= 1 : rect.right >= viewport.width - 1;
          const isPanel = rect.height >= viewport.height * 0.6 && rect.width >= 40 && rect.width < viewport.width * 0.5;
          if (!againstEdge || !isPanel) continue;
          observePanel(node);
          if (side === 'left') left = Math.max(left, rect.right);
          else right = Math.min(right, rect.left);
        }
      }
    }

    // On very narrow windows a panel can take up most of the screen; then
    // there's no room beside it, so use the whole window.
    if (right - left < 200) return { left: 0, right: viewport.width };
    return { left, right };
  }

  // Moves the pill away from the corner, straight down (or up for the bottom
  // corners), past anything in the way, so it never spreads sideways into the
  // conversation. Stops at the middle of the screen.
  function stackBelowObstacles(start, size, viewport, upwards) {
    let y = start.y;
    // Pad vertically so the pill keeps a gap from neighbours even when their
    // size can't be measured.
    const pad = OBSTACLE_GAP - 1;

    for (let step = 0; step < MAX_PLACEMENT_STEPS; step++) {
      const hit = findObstacle(start.x, y - pad, size.width, size.height + pad * 2, viewport);
      if (!hit) return { x: start.x, y };

      let next;
      if (hit.rect) {
        next = upwards ? hit.rect.top - OBSTACLE_GAP - size.height : hit.rect.bottom + OBSTACLE_GAP;
      }
      if (next === undefined || (upwards ? next >= y : next <= y)) {
        next = upwards ? y - OBSTACLE_GAP : y + OBSTACLE_GAP;
      }
      y = next;

      const pastMiddle = upwards ? y < viewport.height / 2 : y + size.height > viewport.height / 2;
      if (pastMiddle || y < EDGE_PADDING || y + size.height > viewport.height - EDGE_PADDING) break;
    }
    return null;
  }

  function computePillPosition(viewport, area) {
    const size = { width: pillElement.offsetWidth, height: pillElement.offsetHeight };
    const right = settings.corner.endsWith('right');
    const bottom = settings.corner.startsWith('bottom');
    const y = Math.max(0, bottom ? viewport.height - EDGE_PADDING - size.height : EDGE_PADDING);

    if (!settings.avoidOverlap) {
      return { x: Math.max(0, right ? viewport.width - EDGE_PADDING - size.width : EDGE_PADDING), y };
    }

    const corner = {
      x: Math.max(area.left, right ? area.right - EDGE_PADDING - size.width : area.left + EDGE_PADDING),
      y
    };
    return stackBelowObstacles(corner, size, viewport, bottom) || corner;
  }

  // Keeps the settings menu on screen and out of side panels, opening it
  // towards the middle of the window.
  function fitMenu(x, y, viewport, area) {
    const menu = shadowRoot.querySelector('.menu');
    const pillWidth = pillElement.offsetWidth;
    const pillHeight = pillElement.offsetHeight;
    const menuWidth = menu.offsetWidth;
    const bounds = settings.avoidOverlap ? area : { left: 0, right: viewport.width };

    const preferred = settings.corner.endsWith('right') ? x + pillWidth - menuWidth : x;
    const min = bounds.left + EDGE_PADDING;
    const max = bounds.right - EDGE_PADDING - menuWidth;
    const menuLeft = max < min ? Math.max(EDGE_PADDING, Math.min(preferred, viewport.width - EDGE_PADDING - menuWidth)) : Math.min(max, Math.max(min, preferred));
    menu.style.left = `${Math.round(menuLeft - x)}px`;
    menu.style.right = 'auto';

    const opensDown = settings.corner.startsWith('top');
    const room = opensDown
      ? viewport.height - (y + pillHeight) - OBSTACLE_GAP - EDGE_PADDING
      : y - OBSTACLE_GAP - EDGE_PADDING;
    menu.style.maxHeight = `${Math.max(160, Math.floor(room))}px`;
  }

  function placePill() {
    placementScheduled = false;
    if (!pillElement || menuOpen) return;

    pillElement.classList.remove('pos-top-left', 'pos-top-right', 'pos-bottom-left', 'pos-bottom-right');
    pillElement.classList.add(`pos-${settings.corner}`);

    const viewport = viewportSize();
    const area = findMainArea(viewport);
    const { x, y } = computePillPosition(viewport, area);
    pillElement.style.left = `${Math.round(x)}px`;
    pillElement.style.top = `${Math.round(y)}px`;
    fitMenu(x, y, viewport, area);
    pillElement.classList.add('placed');
  }

  function schedulePlacement() {
    if (placementScheduled) return;
    placementScheduled = true;
    requestAnimationFrame(placePill);
  }

  // While a side panel slides open or shut, re-place the pill on every frame
  // so it moves along with the layout instead of catching up afterwards.
  let followUntil = 0;
  let following = false;

  function followLayout(duration = 700) {
    followUntil = Math.max(followUntil, performance.now() + duration);
    if (following) return;
    following = true;
    const step = () => {
      placePill();
      if (performance.now() < followUntil) {
        requestAnimationFrame(step);
      } else {
        following = false;
      }
    };
    requestAnimationFrame(step);
  }

  // Layout animations of big pieces of the page (side panels opening, the
  // window rearranging) mean the pill may need to move.
  function isLayoutAnimation(e) {
    const target = e.target;
    if (!(target instanceof Element) || target === hostElement || target.closest(BAR_SELECTORS)) return false;
    const rect = target.getBoundingClientRect();
    const viewport = viewportSize();
    return rect.height >= viewport.height * 0.3 || rect.width >= viewport.width * 0.3;
  }

  function watchLayoutChanges() {
    window.addEventListener('resize', () => followLayout(300));
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => followLayout(300));

    // Clicks open and close panels; follow for a moment afterwards.
    document.addEventListener('click', () => followLayout(), true);
    document.addEventListener('keyup', () => followLayout(), true);

    for (const type of ['transitionrun', 'transitionend', 'animationstart', 'animationend']) {
      document.addEventListener(type, (e) => {
        if (isLayoutAnimation(e)) followLayout(type.endsWith('end') ? 100 : 700);
      }, true);
    }

    // Catch anything else that moves items around (other extensions adding
    // widgets, Gemini re-rendering), at most a few times a second.
    let lastMutation = 0;
    new MutationObserver(() => {
      const now = performance.now();
      if (now - lastMutation < 150) return;
      lastMutation = now;
      schedulePlacement();
    }).observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
      if (!document.hidden) schedulePlacement();
    }, 1000);
  }

  function setMenuOpen(open) {
    menuOpen = open;
    const menu = shadowRoot && shadowRoot.querySelector('.menu');
    if (menu) menu.classList.toggle('open', open);
    if (pillElement) pillElement.classList.toggle('menu-open', open);
    const button = shadowRoot && shadowRoot.querySelector('.pill-button');
    if (button) button.setAttribute('aria-expanded', String(open));
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

      button, input, select {
        font-family: inherit;
      }

      /* Material 3 colours, matching Gemini's light and dark themes. */
      .pill-container {
        --pill-bg: #e9eef6;
        --pill-bg-hover: #dde3ea;
        --menu-bg: #ffffff;
        --on-surface: #1f1f1f;
        --on-surface-variant: #444746;
        --outline: #747775;
        --outline-variant: #c4c7c5;
        --hover: rgba(31, 31, 31, 0.08);
        --primary: #0b57d0;
        --on-primary: #ffffff;
        --primary-container: #d3e3fd;
        --on-primary-container: #041e49;
        --field-bg: #f0f4f9;
        --shadow-soft: rgba(0, 0, 0, 0.08);
        --shadow-strong: rgba(0, 0, 0, 0.16);

        position: fixed;
        z-index: 999999;
        visibility: hidden;
        color-scheme: light;
      }

      .pill-container.theme-dark {
        --pill-bg: #282a2c;
        --pill-bg-hover: #333537;
        --menu-bg: #1e1f20;
        --on-surface: #e3e3e3;
        --on-surface-variant: #c4c7c5;
        --outline: #8e918f;
        --outline-variant: #444746;
        --hover: rgba(227, 227, 227, 0.08);
        --primary: #a8c7fa;
        --on-primary: #062e6f;
        --primary-container: #0842a0;
        --on-primary-container: #d3e3fd;
        --field-bg: #282a2c;
        --shadow-soft: rgba(0, 0, 0, 0.3);
        --shadow-strong: rgba(0, 0, 0, 0.5);
        color-scheme: dark;
      }

      .pill-container.placed {
        visibility: visible;
      }

      .pill-button {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: none;
        border-radius: 9999px;
        background: var(--pill-bg);
        color: var(--on-surface);
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
        cursor: pointer;
        box-shadow: 0 1px 2px var(--shadow-soft), 0 2px 6px var(--shadow-soft);
        transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
        user-select: none;
      }

      .pill-button:hover {
        background: var(--pill-bg-hover);
        box-shadow: 0 1px 3px var(--shadow-soft), 0 4px 10px var(--shadow-strong);
      }

      .pill-button:active {
        transform: scale(0.96);
      }

      .pill-button:focus-visible {
        outline: 2px solid var(--primary);
        outline-offset: 2px;
      }

      .pill-icon {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }

      .pill-label {
        display: none;
      }

      /* Icon: a small round button. */
      .style-icon .pill-button {
        width: 36px;
        height: 36px;
        padding: 0;
      }

      /* Icon + text */
      .style-label .pill-button {
        height: 36px;
        padding: 0 14px 0 10px;
      }

      .style-label .pill-label {
        display: inline;
      }

      .menu {
        position: absolute;
        width: 272px;
        max-width: calc(100vw - 24px);
        overflow-y: auto;
        padding: 8px 0;
        background: var(--menu-bg);
        color: var(--on-surface);
        border-radius: 16px;
        box-shadow: 0 2px 6px var(--shadow-strong), 0 8px 24px var(--shadow-soft);
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
        color: var(--on-surface-variant);
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
        background: var(--hover);
      }

      .menu-item-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .menu-item-label {
        font-size: 14px;
        color: var(--on-surface);
      }

      .menu-item-hint {
        font-size: 11px;
        color: var(--on-surface-variant);
      }

      .toggle {
        flex-shrink: 0;
        width: 36px;
        height: 20px;
        background: var(--outline);
        border-radius: 9999px;
        position: relative;
        cursor: pointer;
        transition: background 0.2s ease;
      }

      .toggle.active {
        background: var(--primary);
      }

      .toggle::after {
        content: '';
        position: absolute;
        width: 16px;
        height: 16px;
        background: var(--menu-bg);
        border-radius: 50%;
        top: 2px;
        left: 2px;
        transition: transform 0.2s ease, background 0.2s ease;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }

      .toggle.active::after {
        background: var(--on-primary);
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
        color: var(--on-surface-variant);
      }

      .slider {
        width: 100%;
        margin: 0;
        cursor: pointer;
        accent-color: var(--primary);
      }

      .delay-controls {
        padding: 0 16px 12px;
      }

      .delay-controls[hidden] {
        display: none;
      }

      .delay-custom {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
      }

      .delay-custom label {
        font-size: 12px;
        color: var(--on-surface-variant);
        margin-right: auto;
      }

      .delay-number,
      .delay-unit {
        height: 30px;
        border: 1px solid var(--outline-variant);
        border-radius: 8px;
        background: var(--field-bg);
        color: var(--on-surface);
        font-size: 13px;
      }

      .delay-number {
        width: 72px;
        padding: 0 8px;
        font-variant-numeric: tabular-nums;
      }

      .delay-unit {
        padding: 0 4px;
        cursor: pointer;
      }

      .delay-number:focus,
      .delay-unit:focus {
        outline: 2px solid var(--primary);
        outline-offset: -1px;
      }

      .choice-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        padding: 8px 16px 12px;
      }

      .choice-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 8px 4px;
        border: 1px solid var(--outline-variant);
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
        font-size: 11px;
        color: var(--on-surface-variant);
      }

      .choice-btn:hover {
        background: var(--hover);
      }

      .choice-btn.active {
        border-color: var(--primary);
        background: var(--primary-container);
        color: var(--on-primary-container);
      }

      .divider {
        height: 1px;
        background: var(--outline-variant);
        margin: 8px 16px;
      }

      .review-link {
        display: block;
        padding: 12px 16px;
        font-size: 13px;
        color: var(--primary);
        text-decoration: none;
        text-align: center;
        transition: background 0.15s ease;
      }

      .review-link:hover {
        background: var(--hover);
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

  function choiceButtonHTML(group, value, label, current) {
    return `<button class="choice-btn ${value === current ? 'active' : ''}" data-${group}="${value}">${label}</button>`;
  }

  // Material Symbols "zoom_out_map" (Outlined, weight 400, fill 0, grade 0,
  // 24px), Apache License 2.0. Inlined rather than loaded from Google Fonts:
  // @font-face doesn't work inside a shadow root, and this avoids a network
  // request on every Gemini page.
  const PILL_ICON_SVG = `
    <svg class="pill-icon" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
      <path d="M120-120v-240h80v104l124-124 56 56-124 124h104v80H120Zm480 0v-80h104L580-324l56-56 124 124v-104h80v240H600ZM324-580 200-704v104h-80v-240h240v80H256l124 124-56 56Zm312 0-56-56 124-124H600v-80h240v240h-80v-104L636-580Z"/>
    </svg>
  `;

  // Create the pill HTML
  function createPillHTML() {
    const reviewUrl = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
    const delayUnit = DELAY_UNITS[settings.hideDelayUnit] ? settings.hideDelayUnit : 'ms';
    const pillStyle = PILL_STYLES.includes(settings.pillStyle) ? settings.pillStyle : 'label';
    return `
      <div class="pill-container pos-${settings.corner} style-${pillStyle}">
        <button class="pill-button" aria-label="Hide Chat Bar settings" title="Hide Chat Bar settings" aria-haspopup="true" aria-expanded="false" aria-controls="chatbar-settings">
          ${PILL_ICON_SVG}
          <span class="pill-label">Chat Bar</span>
        </button>
        <div class="menu" id="chatbar-settings">
          <div class="menu-header">Settings</div>
          ${toggleRowHTML('typeToChat', 'Type anywhere to chat', 'Start typing to open the chat bar')}
          <div class="slider-row">
            <div class="slider-heading">
              <label class="menu-item-label" for="hidden-opacity">Hidden bar visibility</label>
              <span class="slider-value opacity-value">${settings.hiddenOpacity}%</span>
            </div>
            <input id="hidden-opacity" class="slider opacity-slider" type="range" min="0" max="100" step="5"
              value="${settings.hiddenOpacity}" aria-label="Hidden bar visibility">
          </div>
          ${toggleRowHTML('hideDelayEnabled', 'Delay before hiding', 'When off, the bar hides instantly')}
          <div class="delay-controls" ${settings.hideDelayEnabled ? '' : 'hidden'}>
            <input class="slider delay-slider" type="range" min="0" max="${DELAY_SLIDER_MAX_MS}" step="50"
              value="${Math.min(settings.hideDelayMs, DELAY_SLIDER_MAX_MS)}" aria-label="Delay before hiding">
            <div class="delay-custom">
              <label for="delay-number">Custom</label>
              <input id="delay-number" class="delay-number" type="number" min="0" step="any"
                value="${formatDelay(settings.hideDelayMs, delayUnit)}" aria-label="Delay amount">
              <select class="delay-unit" aria-label="Delay unit">
                <option value="ms" ${delayUnit === 'ms' ? 'selected' : ''}>ms</option>
                <option value="s" ${delayUnit === 's' ? 'selected' : ''}>sec</option>
                <option value="min" ${delayUnit === 'min' ? 'selected' : ''}>min</option>
              </select>
            </div>
          </div>
          <div class="divider"></div>
          <div class="menu-header">Position</div>
          <div class="choice-grid corner-selector">
            ${choiceButtonHTML('corner', 'top-left', '↖ Top Left', settings.corner)}
            ${choiceButtonHTML('corner', 'top-right', '↗ Top Right', settings.corner)}
            ${choiceButtonHTML('corner', 'bottom-left', '↙ Bottom Left', settings.corner)}
            ${choiceButtonHTML('corner', 'bottom-right', '↘ Bottom Right', settings.corner)}
          </div>
          ${toggleRowHTML('avoidOverlap', 'Make room for other items', 'Turn off to always sit in the exact corner')}
          <div class="divider"></div>
          <div class="menu-header">Button style</div>
          <div class="choice-grid style-selector">
            ${choiceButtonHTML('style', 'label', 'Icon + text', pillStyle)}
            ${choiceButtonHTML('style', 'icon', 'Icon only', pillStyle)}
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
    shadowRoot.querySelectorAll('[data-setting]').forEach((row) => {
      const on = Boolean(settings[row.dataset.setting]);
      row.setAttribute('aria-checked', String(on));
      row.querySelector('.toggle').classList.toggle('active', on);
    });
  }

  function syncChoiceUI() {
    if (!shadowRoot) return;
    shadowRoot.querySelectorAll('[data-corner]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.corner === settings.corner);
    });
    shadowRoot.querySelectorAll('[data-style]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.style === settings.pillStyle);
    });
  }

  function syncSliderUI() {
    if (!shadowRoot) return;
    shadowRoot.querySelector('.opacity-slider').value = String(settings.hiddenOpacity);
    shadowRoot.querySelector('.opacity-value').textContent = `${settings.hiddenOpacity}%`;
  }

  // Shows the delay in the slider and the custom field without saving it.
  function showDelay(ms, unit = settings.hideDelayUnit) {
    if (!shadowRoot) return;
    shadowRoot.querySelector('.delay-slider').value = String(Math.min(ms, DELAY_SLIDER_MAX_MS));
    shadowRoot.querySelector('.delay-number').value = formatDelay(ms, unit);
    shadowRoot.querySelector('.delay-unit').value = unit;
  }

  function syncDelayUI() {
    if (!shadowRoot) return;
    shadowRoot.querySelector('.delay-controls').hidden = !settings.hideDelayEnabled;
    showDelay(settings.hideDelayMs);
  }

  function applyPillStyle() {
    PILL_STYLES.forEach((style) => pillElement.classList.remove(`style-${style}`));
    const style = PILL_STYLES.includes(settings.pillStyle) ? settings.pillStyle : 'label';
    pillElement.classList.add(`style-${style}`);
  }

  // Applies a setting change on this page (from the menu or another tab).
  function applySetting(key) {
    if (key === 'hiddenOpacity') {
      applyHiddenOpacity(settings.hiddenOpacity);
      syncSliderUI();
    }
    if (key === 'hideDelayEnabled' || key === 'hideDelayMs' || key === 'hideDelayUnit') {
      applyHideDelay();
      syncDelayUI();
      if (key === 'hideDelayEnabled') placePillNow();
    }
    if (key === 'corner') {
      syncChoiceUI();
      placePillNow();
    }
    if (key === 'pillStyle') {
      applyPillStyle();
      syncChoiceUI();
      placePillNow();
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

  // Gemini has its own theme setting, which it marks on <body>. When it
  // follows the system, the class may be missing, so fall back to the
  // browser's colour scheme.
  const darkSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function isGeminiDark() {
    if (document.body.classList.contains('dark-theme')) return true;
    if (document.body.classList.contains('light-theme')) return false;
    return darkSchemeQuery.matches;
  }

  function applyPillTheme() {
    if (pillElement) pillElement.classList.toggle('theme-dark', isGeminiDark());
  }

  function watchPillTheme() {
    new MutationObserver(applyPillTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    darkSchemeQuery.addEventListener('change', applyPillTheme);
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
    const slider = shadowRoot.querySelector('.opacity-slider');
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

    // Sliders preview while dragging, but only save when released, to stay
    // within chrome.storage.sync's write limits.
    slider.addEventListener('input', () => {
      settings.hiddenOpacity = Number(slider.value);
      applyHiddenOpacity(settings.hiddenOpacity);
      shadowRoot.querySelector('.opacity-value').textContent = `${settings.hiddenOpacity}%`;
    });
    slider.addEventListener('change', () => {
      saveSettings({ hiddenOpacity: Number(slider.value) });
    });

    const delaySlider = shadowRoot.querySelector('.delay-slider');
    const delayNumber = shadowRoot.querySelector('.delay-number');
    const delayUnit = shadowRoot.querySelector('.delay-unit');

    delaySlider.addEventListener('input', () => {
      const ms = Number(delaySlider.value);
      delayNumber.value = formatDelay(ms, settings.hideDelayUnit);
      applyHideDelay(ms);
    });
    delaySlider.addEventListener('change', () => {
      saveSettings({ hideDelayMs: Number(delaySlider.value) });
    });

    // Custom amounts can go past the slider's range, up to an hour.
    delayNumber.addEventListener('change', () => {
      const ms = clampDelayMs(Number(delayNumber.value) * DELAY_UNITS[settings.hideDelayUnit]);
      saveSettings({ hideDelayMs: ms });
      applyHideDelay();
      showDelay(ms);
    });
    delayNumber.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') delayNumber.blur();
    });

    // Switching units keeps the same delay and shows it in the new unit.
    delayUnit.addEventListener('change', () => {
      saveSettings({ hideDelayUnit: delayUnit.value });
      showDelay(settings.hideDelayMs);
    });

    shadowRoot.querySelectorAll('[data-corner]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveSettings({ corner: btn.dataset.corner });
        applySetting('corner');
      });
    });

    shadowRoot.querySelectorAll('[data-style]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveSettings({ pillStyle: btn.dataset.style });
        applySetting('pillStyle');
      });
    });

    applyPillTheme();
    watchPillTheme();

    document.body.appendChild(hostElement);
    placePill();

    watchLayoutChanges();
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

  // Only Gemini's composer. Another text box on the page must not keep the
  // bar open or receive characters typed elsewhere.
  function findChatEditor() {
    const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'));
    return (
      editors.find((el) => el.closest('input-container')) ||
      editors.find((el) => el.closest(BAR_SELECTORS)) ||
      null
    );
  }

  function editorHasDraft(el) {
    if (!el) return false;
    const text = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.textContent;
    return (text || '').trim().length > 0;
  }

  // execCommand still produces the input events Gemini listens for. If it
  // misses, insert the character directly and fire the same input event.
  function insertIntoEditor(el, text) {
    el.focus();
    moveCaretToEnd(el);
    if (document.execCommand('insertText', false, text)) return;

    if (el.tagName === 'TEXTAREA') {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      el.setRangeText(text, start, end, 'end');
    } else {
      const selection = window.getSelection();
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return;
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }

  function moveCaretToEnd(el) {
    if (el.tagName === 'TEXTAREA') {
      el.selectionStart = el.selectionEnd = el.value.length;
      return;
    }
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
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
      insertIntoEditor(editor, e.key);
    });
  }

  // ---------------------------------------------------------------------------
  // Chat bar tracking
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
      document.body.classList.toggle('has-content', editorHasDraft(findChatEditor()));
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

  async function init() {
    await loadSettings();
    applyHideState();
    createPill();
    watchInputContent();
    watchTyping();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
