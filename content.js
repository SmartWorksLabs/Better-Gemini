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
    'hideDelayEnabled', 'hideDelayMs', 'hideDelayUnit', 'pillStyle', 'revealMode',
    'showUsage', 'showContext', 'firstInstalledDate'
  ];
  const TOGGLE_KEYS = ['typeToChat', 'avoidOverlap', 'hideDelayEnabled', 'showUsage', 'showContext'];

  const DELAY_UNITS = { ms: 1, s: 1000, min: 60000 };
  const DELAY_SLIDER_MAX_MS = 5000;
  const DELAY_MAX_MS = 60 * 60000;
  const PILL_STYLES = ['label', 'icon'];
  const REVEAL_MODES = ['hover', 'click'];
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const CONTEXT_TIERS = [32000, 128000, 1000000];
  const WARN_AT = 0.75;
  const DANGER_AT = 0.9;
  const BRIDGE_CMD = 'better-gemini-bridge-cmd';
  const BRIDGE_SRC = 'better-gemini-bridge';

  let settings = {
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
    firstInstalledDate: Date.now()
  };

  let hostElement = null;
  let pillElement = null;
  let shadowRoot = null;
  let menuOpen = false;
  let placementScheduled = false;
  let footerElement = null;
  let contextElement = null;
  let usageElement = null;
  let usageState = { current: null, weekly: null, updatedAt: 0 };
  let contextState = { tokens: 0, limit: 32000, estimated: true };
  let planState = { tier: null, limit: null, updatedAt: 0 };
  let bridgeReady = false;
  let usageFetchId = 0;

  const PLAN_LIMITS = {
    FREE: 32000,
    PLUS: 128000,
    PRO: 1000000,
    ULTRA: 1000000,
    ADVANCED: 1000000
  };

  const CONTEXT_INFO =
    'Set by your Google AI plan (Free 32k, Plus 128k, Pro/Ultra 1M) — not by Flash vs Pro.';

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
    document.body.classList.add('better-gemini-enabled');
    document.body.classList.add('better-gemini-active');
    applyHiddenOpacity(settings.hiddenOpacity);
    applyHideDelay();
    applyRevealMode();
  }

  function revealMode() {
    return REVEAL_MODES.includes(settings.revealMode) ? settings.revealMode : 'click';
  }

  function applyRevealMode() {
    const hover = revealMode() === 'hover';
    document.body.classList.toggle('better-gemini-reveal-hover', hover);
    if (hover) document.body.classList.remove('better-gemini-opened');
    else setHoverRevealed(false, true);
  }

  function applyHiddenOpacity(percent) {
    document.documentElement.style.setProperty('--better-gemini-hidden-opacity', String(percent / 100));
  }

  function applyHideDelay(ms = settings.hideDelayMs) {
    const delay = settings.hideDelayEnabled ? ms : 0;
    document.documentElement.style.setProperty('--better-gemini-hide-delay', `${delay}ms`);
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
  // inside them are. Returns { rect, content } for obstacles, or null.
  // content: true when the hit is scrolling chat text - prefer stacking under
  // rather than sitting beside it.
  function asObstacle(el, px, py, viewport) {
    if (el === document.documentElement || el === document.body) return null;
    if (el.id === 'better-gemini-footer' || el.closest('#better-gemini-footer')) return null;

    // Our own settings host (shadow root) - use the visible widget size.
    if (el === hostElement && pillElement) {
      return { rect: pillElement.getBoundingClientRect(), content: false };
    }

    // The chat bar counts even while hidden, since it can come back at any time.
    const bar = el.closest('.better-gemini-bar');
    if (bar) return { rect: bar.getBoundingClientRect(), content: false };

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') return null;

    // Scrolling conversation text: only treat as an obstacle when the hit is
    // actual text, so the pill can sit beside chrome but not on top of words.
    if (isInsideScrollingArea(el)) {
      const line = textLineAt(el, px, py);
      return line ? { rect: line.rect, content: true } : null;
    }

    // A hit outside the element's own box means it is drawing content that
    // lives elsewhere, such as another extension's widget inside a shadow
    // root. Its real size can't be measured, so the caller steps past it.
    const rect = el.getBoundingClientRect();
    const containsPoint = px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
    if (!containsPoint || rect.width === 0 || rect.height === 0) return { rect: null, content: false };

    if (rect.width > viewport.width * 0.5 || rect.height > viewport.height * 0.5) {
      const line = textLineAt(el, px, py);
      return line ? { rect: line.rect, content: true } : null;
    }
    return { rect, content: false };
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
  // obstacle found. excludeEl is the host of the widget being placed.
  function findObstacle(x, y, width, height, viewport, excludeEl) {
    const xs = samplePoints(x, width);
    const ys = samplePoints(y, height);

    for (const py of ys) {
      for (const px of xs) {
        if (px < 0 || py < 0 || px >= viewport.width || py >= viewport.height) continue;

        const topElement = document.elementsFromPoint(px, py).find((el) => el !== excludeEl);
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
        const hit = document.elementsFromPoint(x, viewport.height * fraction).find(
        (el) => el !== hostElement && el !== footerElement
      );
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

  // Moves past chrome sideways (toward the middle of the main area) when there
  // is room and that spot does not sit on scrolling chat text. Returns null if
  // a content hit forces a vertical stack, or if there is no free side spot.
  function placeBesideObstacles(start, size, viewport, area, fromRight, excludeEl) {
    let x = start.x;
    const y = start.y;
    const pad = OBSTACLE_GAP - 1;

    for (let step = 0; step < MAX_PLACEMENT_STEPS; step++) {
      const hit = findObstacle(x - pad, y, size.width + pad * 2, size.height, viewport, excludeEl);
      if (!hit) return { x, y };

      // Words in the conversation: do not sit beside them; stack under instead.
      if (hit.content) return null;

      let next;
      if (hit.rect) {
        next = fromRight
          ? hit.rect.left - OBSTACLE_GAP - size.width
          : hit.rect.right + OBSTACLE_GAP;
      }
      if (next === undefined || (fromRight ? next >= x : next <= x)) {
        next = fromRight ? x - OBSTACLE_GAP : x + OBSTACLE_GAP;
      }
      x = next;

      const minX = area.left + EDGE_PADDING;
      const maxX = area.right - EDGE_PADDING - size.width;
      if (x < minX || x > maxX) return null;
    }
    return null;
  }

  // Fall back: move straight down (or up for bottom corners) past anything in
  // the way. Stops at the middle of the screen.
  function stackBelowObstacles(start, size, viewport, upwards, excludeEl) {
    let y = start.y;
    const pad = OBSTACLE_GAP - 1;

    for (let step = 0; step < MAX_PLACEMENT_STEPS; step++) {
      const hit = findObstacle(start.x, y - pad, size.width, size.height + pad * 2, viewport, excludeEl);
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

  // Prefer sitting beside chrome when that does not cover chat text; otherwise
  // stack under the obstacle as before.
  function placeAvoidingObstacles(start, size, viewport, area, fromRight, upwards, excludeEl) {
    return placeBesideObstacles(start, size, viewport, area, fromRight, excludeEl)
      || stackBelowObstacles(start, size, viewport, upwards, excludeEl)
      || start;
  }

  function computeFloatingPosition(cornerName, size, viewport, area, excludeEl) {
    const right = cornerName.endsWith('right');
    const bottom = cornerName.startsWith('bottom');
    const y = Math.max(0, bottom ? viewport.height - EDGE_PADDING - size.height : EDGE_PADDING);

    if (!settings.avoidOverlap) {
      return {
        x: Math.max(0, right ? viewport.width - EDGE_PADDING - size.width : EDGE_PADDING),
        y
      };
    }

    const corner = {
      x: Math.max(area.left, right ? area.right - EDGE_PADDING - size.width : area.left + EDGE_PADDING),
      y
    };
    return placeAvoidingObstacles(corner, size, viewport, area, right, bottom, excludeEl);
  }

  function computePillPosition(viewport, area) {
    const size = { width: pillElement.offsetWidth, height: pillElement.offsetHeight };
    return computeFloatingPosition(settings.corner, size, viewport, area, hostElement);
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
    if (pillElement && !menuOpen) {
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
    placeChatFooter();
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
    window.addEventListener('resize', () => {
      followLayout(300);
      scheduleDockCheck(true);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        followLayout(300);
        scheduleDockCheck(true);
      });
    }

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
      if (document.hidden) return;
      schedulePlacement();
      scheduleDockCheck(false);
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

      .choice-label {
        display: block;
        padding: 8px 16px 0;
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
    const pillStyle = PILL_STYLES.includes(settings.pillStyle) ? settings.pillStyle : 'icon';
    return `
      <div class="pill-container pos-${settings.corner} style-${pillStyle}">
        <button class="pill-button" aria-label="Better Gemini settings" title="Better Gemini settings" aria-haspopup="true" aria-expanded="false" aria-controls="better-gemini-settings">
          ${PILL_ICON_SVG}
          <span class="pill-label">Better Gemini</span>
        </button>
        <div class="menu" id="better-gemini-settings">
          <div class="menu-header">Features</div>
          ${toggleRowHTML('showUsage', 'Usage tracker', 'Current and weekly limits under the chat bar')}
          ${toggleRowHTML('showContext', 'Context window', 'Tokens used in this chat, under the bar')}
          <div class="divider"></div>
          <div class="menu-header">Chat bar</div>
          <span class="menu-item-label choice-label" id="reveal-label">Show the chat bar on</span>
          <div class="choice-grid reveal-selector" role="group" aria-labelledby="reveal-label">
            ${choiceButtonHTML('reveal', 'hover', 'Hover', revealMode())}
            ${choiceButtonHTML('reveal', 'click', 'Click or tap', revealMode())}
          </div>
          ${toggleRowHTML('typeToChat', 'Type anywhere to chat', 'Type or paste to open the chat bar')}
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
          <div class="menu-header">Settings button</div>
          <div class="choice-grid corner-selector">
            ${choiceButtonHTML('corner', 'top-left', 'Top Left', settings.corner)}
            ${choiceButtonHTML('corner', 'top-right', 'Top Right', settings.corner)}
            ${choiceButtonHTML('corner', 'bottom-left', 'Bottom Left', settings.corner)}
            ${choiceButtonHTML('corner', 'bottom-right', 'Bottom Right', settings.corner)}
          </div>
          ${toggleRowHTML('avoidOverlap', 'Make room for other items', 'Sit beside chrome when there is room; under content if needed')}
          <div class="divider"></div>
          <div class="menu-header">Button style</div>
          <div class="choice-grid style-selector">
            ${choiceButtonHTML('style', 'label', 'Icon + text', pillStyle)}
            ${choiceButtonHTML('style', 'icon', 'Icon only', pillStyle)}
          </div>
          <div class="review-prompt" style="display: none;">
            <div class="divider"></div>
            <a class="review-link" href="${reviewUrl}" target="_blank" rel="noopener noreferrer">
              Enjoying this? Leave a Review
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
    shadowRoot.querySelectorAll('[data-reveal]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.reveal === revealMode());
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
    const style = PILL_STYLES.includes(settings.pillStyle) ? settings.pillStyle : 'icon';
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
    if (key === 'revealMode') {
      applyRevealMode();
      syncChoiceUI();
    }
    if (key === 'avoidOverlap') placePillNow();
    if (key === 'showUsage' || key === 'showContext') {
      syncToggleUI();
      updateFooterVisibility();
      placeChatFooter();
    }
    if (TOGGLE_KEYS.includes(key) && key !== 'showUsage' && key !== 'showContext') syncToggleUI();
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
    if (document.getElementById('better-gemini-pill-host')) return;

    hostElement = document.createElement('div');
    hostElement.id = 'better-gemini-pill-host';

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

    shadowRoot.querySelectorAll('[data-reveal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveSettings({ revealMode: btn.dataset.reveal });
        applySetting('revealMode');
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

  // True when a key or paste should be moved into Gemini's composer.
  function canRedirectInput(e) {
    if (!settings.typeToChat) return false;
    const path = e.composedPath();
    if (hostElement && path.includes(hostElement)) return false;
    if (path.some(isEditable) || isEditable(document.activeElement)) return false;
    if (hasOpenOverlay()) return false;
    return true;
  }

  // Ctrl/Cmd+V, including Shift+Ctrl/Cmd+V (paste without formatting).
  function isPasteShortcut(e) {
    if (e.altKey || e.isComposing || e.repeat) return false;
    if (!(e.ctrlKey || e.metaKey)) return false;
    return e.key === 'v' || e.key === 'V';
  }

  // Paste that is not already aimed at the composer or another text box.
  function pasteShouldMove(e) {
    if (!settings.typeToChat) return false;
    const path = e.composedPath();
    if (hostElement && path.includes(hostElement)) return false;
    if (hasOpenOverlay()) return false;
    const editor = findChatEditor();
    if (!editor || path.includes(editor)) return false;
    if (path.some(isEditable)) return false;
    if (isEditable(document.activeElement) && document.activeElement !== editor) return false;
    return true;
  }

  // Gemini's upload control accepts images dropped onto a file input. Returns
  // false when there is nothing to hand the files to.
  function forwardFiles(editor, files) {
    editor.focus();
    const root = barElement && barElement.contains(editor) ? barElement : editor.parentElement;
    const input = root && root.querySelector('input[type="file"]');
    if (!input || !files.length) return false;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function watchTyping() {
    // Focus the composer before the default paste, so Gemini receives images
    // as well as text. Capture runs before the target's own handlers.
    window.addEventListener('keydown', (e) => {
      if (!isPasteShortcut(e) || !canRedirectInput(e)) return;
      const editor = findChatEditor();
      if (!editor) return;
      editor.focus();
      moveCaretToEnd(editor);
    }, true);

    // Bubble phase on window, so Gemini's own shortcuts get the key first.
    window.addEventListener('keydown', (e) => {
      if (!settings.typeToChat || e.defaultPrevented || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Only single printable characters. Space is skipped so it can still scroll the page.
      if (e.key.length !== 1 || e.key === ' ') return;
      if (!canRedirectInput(e)) return;

      const editor = findChatEditor();
      if (!editor) return;

      e.preventDefault();
      insertIntoEditor(editor, e.key);
    });

    // Right-click paste, the Edit menu, and any Ctrl/Cmd+V that did not land
    // in the composer. Keyboard image paste is left to Gemini after the focus
    // above. Text is inserted here so the bar opens either way.
    window.addEventListener('paste', (e) => {
      if (!pasteShouldMove(e)) return;
      const editor = findChatEditor();
      if (!editor) return;
      const clipboard = e.clipboardData;
      const text = clipboard ? clipboard.getData('text/plain') : '';
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        insertIntoEditor(editor, text);
        return;
      }
      const files = clipboard && clipboard.files;
      if (files && files.length && forwardFiles(editor, files)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  // ---------------------------------------------------------------------------
  // Chat bar tracking
  // ---------------------------------------------------------------------------

  let barElement = null;

  function syncBarHeight(bar) {
    if (!bar) return;
    document.documentElement.style.setProperty('--better-gemini-bar-height', `${bar.offsetHeight}px`);
  }

  const barResizeObserver = new ResizeObserver(() => {
    syncBarHeight(barElement);
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
      if (bar && !bar.classList.contains('better-gemini-bar')) bar.classList.add('better-gemini-bar');
      return false;
    }

    if (barElement) {
      barElement.classList.remove('better-gemini-bar', 'better-gemini-revealed');
      barResizeObserver.unobserve(barElement);
    }
    barElement = bar;
    if (bar) {
      bar.classList.add('better-gemini-bar');
      barResizeObserver.observe(bar);
      syncBarHeight(bar);
    }
    return true;
  }

  // The overlap layout is only for a bar docked at the bottom of an open
  // chat. On the new-chat screen the composer sits in the upper middle, and
  // pulling it up makes it narrower, higher, and covers the model picker.
  function updateDockState() {
    const bar = barElement;
    if (!bar || !bar.isConnected) {
      document.body.classList.remove('better-gemini-docked');
      return;
    }
    if (isSliding() || marginIsGliding(bar)) return;
    // Measuring turns transitions off. Doing that mid-glide snaps the chat.

    // Freeze transitions so the measurement can't animate the bar.
    const previousTransition = bar.style.transition;
    const previousPriority = bar.style.getPropertyPriority('transition');
    bar.style.setProperty('transition', 'none', 'important');
    let top = 0;
    let bottom = 0;
    try {
      document.body.classList.add('better-gemini-measuring');
      const rect = bar.getBoundingClientRect();
      top = rect.top;
      bottom = rect.bottom;
      document.body.classList.remove('better-gemini-measuring');
      const distance = window.innerHeight - bottom;
      const height = bottom - top;
      // A docked composer sits low, close to the bottom edge, and is not a
      // tall page wrapper. The centered new-chat bar fails this test.
      const docked = height > 0 && height < window.innerHeight * 0.55 &&
        top > window.innerHeight * 0.35 && distance >= -40 && distance <= 140;
      document.body.classList.toggle('better-gemini-docked', docked);
      void bar.offsetHeight;
    } finally {
      document.body.classList.remove('better-gemini-measuring');
      if (previousTransition) bar.style.setProperty('transition', previousTransition, previousPriority);
      else bar.style.removeProperty('transition');
    }
  }

  let lastDockCheck = 0;
  function scheduleDockCheck(force) {
    const now = performance.now();
    if (!force && now - lastDockCheck < 500) return;
    lastDockCheck = now;
    updateDockState();
  }

  function barIsDocked() {
    return document.body.classList.contains('better-gemini-docked');
  }

  // Focus, a draft, click-to-open, or a hover hold means the bar is back in
  // its own space instead of floating over the conversation.
  function barCoversNaturally() {
    if (!barElement || !barIsDocked()) return false;
    if (barElement.classList.contains('better-gemini-revealed')) return true;
    if (barElement.matches(':focus-within')) return true;
    if (document.body.classList.contains('has-content')) return true;
    return document.body.classList.contains('better-gemini-opened') && revealMode() === 'click';
  }

  // The strip at the very bottom of the screen, under the floating bar.
  // Hovering or clicking here shows the bar without landing on the buttons.
  const BOTTOM_REVEAL_PX = 36;
  function pointerInBottomEdge(e) {
    if (!barIsDocked() || !barElement) return false;
    const rect = barElement.getBoundingClientRect();
    return e.clientY >= window.innerHeight - BOTTOM_REVEAL_PX &&
      e.clientX >= rect.left - 24 && e.clientX <= rect.right + 24;
  }

  function pointerOverBarBox(e) {
    if (!barElement) return false;
    const rect = barElement.getBoundingClientRect();
    return e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
  }

  // Copy, thumbs up/down, and redo sit under the floating bar. They are small
  // controls in the conversation column, not the bar's own send button.
  function responseControl(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node === barElement) return null;
      if (barElement && barElement.contains(node)) return null;
      if (hostElement && (node === hostElement || hostElement.contains(node))) return null;
      const action = node.getAttribute('jsaction') || '';
      const clickable = node.matches('button, a, [role="button"], [role="menuitem"]') ||
        action.includes('click') ||
        (node.hasAttribute('aria-label') && node.tabIndex >= 0);
      if (!clickable) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.height > 72 || rect.width > 320) continue;
      return node;
    }
    return null;
  }

  function responseActionAt(x, y) {
    if (!barElement) return null;
    const barRect = barElement.getBoundingClientRect();
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      if (!(el instanceof Element)) continue;
      const control = responseControl(el);
      if (!control) continue;
      const rect = control.getBoundingClientRect();
      const underPointer = x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 4 && y <= rect.bottom + 4;
      if (!underPointer) continue;
      const overlapsX = rect.left < barRect.right + 48 && rect.right > barRect.left - 48;
      const nearBar = rect.bottom > barRect.top - 96 && rect.top < barRect.bottom - 4;
      if (overlapsX && nearBar) return control;
    }
    return null;
  }

  // Once the bar is open, keep it open while the pointer is on it or on the
  // buttons that moved up with the conversation. The extra height matches the
  // overlap, so opening the bar does not immediately count as a leave.
  function pointerNearRevealedBar(e) {
    if (!barElement || !barCoversNaturally()) return false;
    const rect = barElement.getBoundingClientRect();
    const slop = Math.max(56, barElement.offsetHeight);
    return e.clientX >= rect.left - 12 && e.clientX <= rect.right + 12 &&
      e.clientY >= rect.top - slop && e.clientY <= rect.bottom + 24;
  }

  // How far from the end still counts as "scrolled to the bottom".
  const BOTTOM_TOLERANCE = 8;
  // The margin glide is 480ms. Follow a little longer so the last frame lands.
  const SCROLL_FOLLOW_MS = 560;
  const SLIDE_MS = 640;
  let slideUntil = 0;

  function markSliding(delayMs = 0) {
    slideUntil = Math.max(slideUntil, performance.now() + delayMs + SLIDE_MS);
  }

  function marginIsGliding(bar) {
    if (!bar || !bar.getAnimations) return false;
    return bar.getAnimations().some((anim) => anim.transitionProperty === 'margin-top' && anim.playState === 'running');
  }

  function isSliding() {
    return performance.now() < slideUntil;
  }

  function nodeParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    if (root instanceof ShadowRoot) return root.host;
    return null;
  }

  function isChatScroller(node) {
    if (!(node instanceof Element) || node === document.documentElement || node === document.body) return false;
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false;
    if (node.scrollHeight <= node.clientHeight + 1) return false;
    const rect = node.getBoundingClientRect();
    return rect.height >= 80 && rect.width >= 160;
  }

  function scrollGap(scroller) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  }

  function isAtBottom(scroller) {
    return !!scroller && scrollGap(scroller) <= BOTTOM_TOLERANCE;
  }

  // The message list is whichever scrolling box lines up with the chat bar.
  // Gemini has used a sibling scroller, a nested one, and one inside a shadow
  // root, so check the elements just above the bar as well as nearby layout.
  function findChatScroller() {
    if (!barElement) return null;
    const barRect = barElement.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 2, Math.max(2, barRect.left + Math.min(barRect.width / 2, 240)));
    let best = null;
    let bestScore = Infinity;

    const consider = (node) => {
      if (!isChatScroller(node)) return;
      const rect = node.getBoundingClientRect();
      const score = Math.abs(rect.bottom - barRect.top) + Math.abs(rect.width - barRect.width) * 0.25;
      if (score < bestScore) {
        best = node;
        bestScore = score;
      }
    };

    for (const y of [barRect.top - 28, barRect.top - 80, barRect.top + 12]) {
      if (y < 0 || y > window.innerHeight) continue;
      for (const el of document.elementsFromPoint(x, y)) {
        for (let node = el; node; node = nodeParent(node)) consider(node);
      }
    }

    const roots = [];
    if (barElement.previousElementSibling) roots.push(barElement.previousElementSibling);
    const parent = barElement.parentElement;
    if (parent) {
      if (parent.previousElementSibling) roots.push(parent.previousElementSibling);
      roots.push(parent);
    }
    const walk = (node, depth) => {
      if (!(node instanceof Element) || depth > 8) return;
      consider(node);
      for (const child of node.children) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);
    return best;
  }

  // True only while the user is sitting at the bottom. A scroll up clears it,
  // so showing the bar never yanks someone back down from earlier messages.
  let bottomAnchored = false;
  let observedScroller = null;
  let lastScrollerHeight = 0;
  let pinningScroller = false;
  let followingScroll = false;
  let lastScrollerFind = 0;

  function onScrollerScroll() {
    // The bar slide itself can nudge the scrollbar. Ignore that while we are
    // the ones keeping the bottom in view.
    if (pinningScroller || followingScroll || !observedScroller) return;
    bottomAnchored = isAtBottom(observedScroller);
  }

  const scrollerResizeObserver = new ResizeObserver(() => {
    if (!observedScroller) return;
    const height = observedScroller.clientHeight;
    const changed = height !== lastScrollerHeight;
    lastScrollerHeight = height;
    if (!changed || !bottomAnchored) return;
    // The bar's slide changes the list height over several frames.
    followBottom(0);
  });

  function bindScroller(scroller) {
    if (!scroller || scroller === observedScroller) return;
    if (observedScroller) {
      scrollerResizeObserver.unobserve(observedScroller);
      observedScroller.removeEventListener('scroll', onScrollerScroll);
    }
    observedScroller = scroller;
    lastScrollerHeight = scroller.clientHeight;
    bottomAnchored = isAtBottom(scroller);
    scroller.addEventListener('scroll', onScrollerScroll, { passive: true });
    scrollerResizeObserver.observe(scroller);
  }

  function ensureScroller() {
    const now = performance.now();
    if (observedScroller && observedScroller.isConnected && now - lastScrollerFind < 400) return observedScroller;
    lastScrollerFind = now;
    const found = findChatScroller();
    if (found) bindScroller(found);
    return found || (observedScroller && observedScroller.isConnected ? observedScroller : null);
  }

  // Read the anchor before a layout change. Forcing layout after the bar has
  // already opened would see the new gap and forget that the user was at the bottom.
  function refreshBottomAnchor() {
    // A follow already captured "at the bottom" before the bar moved.
    // Measuring again mid-slide would see the new gap and forget that the user was at the bottom.
    if (followingScroll) return;
    lastScrollerFind = 0;
    const scroller = ensureScroller();
    if (scroller) bottomAnchored = isAtBottom(scroller);
  }

  // The list's own scroll anchoring keeps the top of the chat still while the
  // bar's margin eases. The bottom then skips up in one go when that ease
  // ends. Take over the scroll for the glide and move it by the same amount
  // the margin has moved, so the chat rises with the bar.
  let glideScroll = null;

  function barMargin() {
    if (!barElement) return 0;
    return parseFloat(getComputedStyle(barElement).marginTop) || 0;
  }

  function releaseGlideScroll() {
    const glide = glideScroll;
    if (!glide) return;
    cancelAnimationFrame(glide.frame);
    glideScroll = null;
    const scroller = glide.scroller;
    if (!scroller || !scroller.isConnected) return;
    if (glide.anchor) scroller.style.overflowAnchor = glide.anchor;
    else scroller.style.removeProperty('overflow-anchor');
    if (glide.behavior) scroller.style.scrollBehavior = glide.behavior;
    else scroller.style.removeProperty('scroll-behavior');
  }

  // Call before the open or close class changes, while the list is still settled.
  function armGlideScroll() {
    if (!bottomAnchored || !barElement) return;
    const scroller = ensureScroller();
    if (!scroller) return;
    if (glideScroll && glideScroll.scroller === scroller) {
      glideScroll.startScroll = scroller.scrollTop;
      glideScroll.startMargin = barMargin();
      return;
    }
    if (glideScroll) releaseGlideScroll();
    const startScroll = scroller.scrollTop;
    const startMargin = barMargin();
    const anchor = scroller.style.overflowAnchor;
    const behavior = scroller.style.scrollBehavior;
    scroller.style.setProperty('overflow-anchor', 'none');
    scroller.style.setProperty('scroll-behavior', 'auto');
    glideScroll = {
      scroller,
      startScroll,
      startMargin,
      anchor,
      behavior,
      until: 0,
      frame: 0,
      running: false
    };
  }

  function stepGlideScroll() {
    const glide = glideScroll;
    if (!glide || !glide.scroller.isConnected || !bottomAnchored || !barElement) return;
    const target = glide.startScroll + (barMargin() - glide.startMargin);
    if (Math.abs(glide.scroller.scrollTop - target) < 0.5) return;
    pinningScroller = true;
    glide.scroller.scrollTop = target;
    pinningScroller = false;
  }

  // Call after measuring and before the class change, so a scroll event from
  // the slide cannot clear the anchor.
  function armBottomFollow() {
    refreshBottomAnchor();
    if (!bottomAnchored) {
      followingScroll = false;
      releaseGlideScroll();
      return;
    }
    followingScroll = true;
    armGlideScroll();
  }

  // delayMs covers the CSS hide delay, when the margin does not move until
  // that wait is over. The loop runs the whole time, so the list tracks the
  // margin instead of catching up after it.
  function followBottom(delayMs = 0) {
    if (!bottomAnchored) {
      followingScroll = false;
      releaseGlideScroll();
      return;
    }
    followingScroll = true;
    if (!glideScroll) armGlideScroll();
    if (!glideScroll) {
      followingScroll = false;
      return;
    }
    const state = glideScroll;
    state.until = Math.max(state.until, performance.now() + delayMs + SCROLL_FOLLOW_MS);
    if (state.running) return;
    state.running = true;
    const step = () => {
      if (glideScroll !== state) return;
      if (!bottomAnchored) {
        followingScroll = false;
        releaseGlideScroll();
        return;
      }
      stepGlideScroll();
      if (performance.now() < state.until) state.frame = requestAnimationFrame(step);
      else {
        stepGlideScroll();
        followingScroll = false;
        releaseGlideScroll();
      }
    };
    state.frame = requestAnimationFrame(step);
  }

  function hideFollowDelay() {
    return settings.hideDelayEnabled ? clampDelayMs(settings.hideDelayMs) : 0;
  }

  let revealHoldTimer = null;
  function setHoverRevealed(on, immediate = false) {
    if (!barElement) return;
    const revealed = barElement.classList.contains('better-gemini-revealed');
    if (on) {
      if (revealHoldTimer) {
        clearTimeout(revealHoldTimer);
        revealHoldTimer = null;
      }
      if (!revealed) {
        markSliding(0);
        armBottomFollow();
        barElement.classList.add('better-gemini-revealed');
        followBottom(0);
      }
      return;
    }
    if (!revealed) return;
    if (revealHoldTimer) {
      if (!immediate) return;
      clearTimeout(revealHoldTimer);
      revealHoldTimer = null;
    }
    if (immediate) {
      markSliding(hideFollowDelay());
      armBottomFollow();
      barElement.classList.remove('better-gemini-revealed');
      followBottom(hideFollowDelay());
      return;
    }
    const delay = settings.hideDelayEnabled ? clampDelayMs(settings.hideDelayMs) : 0;
    revealHoldTimer = setTimeout(() => {
      revealHoldTimer = null;
      if (!barElement) return;
      markSliding(hideFollowDelay());
      armBottomFollow();
      barElement.classList.remove('better-gemini-revealed');
      followBottom(hideFollowDelay());
    }, delay);
  }

  function watchHoverReveal() {
    window.addEventListener('pointermove', (e) => {
      if (!barIsDocked() || revealMode() !== 'hover') return;
      const overAction = !!responseActionAt(e.clientX, e.clientY);
      if (barCoversNaturally()) {
        setHoverRevealed(pointerNearRevealedBar(e) || pointerInBottomEdge(e) || overAction);
        return;
      }
      // Hidden and pointing at Copy / thumbs / redo: leave the bar hidden so
      // the click lands on that button.
      if (overAction) {
        setHoverRevealed(false);
        return;
      }
      setHoverRevealed(pointerInBottomEdge(e) || pointerOverBarBox(e));
    }, { passive: true });

    window.addEventListener('pointerleave', () => {
      if (revealMode() === 'hover') setHoverRevealed(false);
    });
    window.addEventListener('blur', () => setHoverRevealed(false));

    // Capture, and do not re-measure here. Focusing the box reveals it, and a
    // layout read in this handler would already include that reveal.
    document.addEventListener('focusin', () => {
      if (!barIsDocked() || !barElement || !barElement.contains(document.activeElement)) return;
      markSliding(0);
      armBottomFollow();
      followBottom(0);
    }, true);
  }

  function openBarFromPointer(e) {
    if (barIsDocked()) {
      markSliding(0);
      armBottomFollow();
    }
    document.body.classList.add('better-gemini-opened');
    if (barIsDocked()) followBottom(0);
    const interactive = e.target instanceof Element &&
      e.target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"]');
    if (!interactive) {
      const editor = findChatEditor();
      if (editor) requestAnimationFrame(() => editor.focus());
    }
  }

  // In click mode, a click or tap on the bar keeps it open until the next
  // click elsewhere. Gemini's popups (upload menu, model picker) are drawn
  // outside the bar, so clicks in them leave it open. A docked bar is removed
  // from hit testing while it is hidden, so the bottom edge and the bar's box
  // are checked by position. Response buttons keep the click.
  function watchBarClicks() {
    document.addEventListener('pointerdown', (e) => {
      if (revealMode() !== 'click') return;
      const path = e.composedPath();
      if (hostElement && path.includes(hostElement)) return;
      if (path.some((el) => el instanceof Element && el.matches('.cdk-overlay-container'))) return;

      if (barIsDocked()) {
        const overAction = !!responseActionAt(e.clientX, e.clientY);
        const overBar = pointerOverBarBox(e) || pointerInBottomEdge(e) || (barElement && path.includes(barElement));
        if (overBar && !overAction) {
          openBarFromPointer(e);
          return;
        }
        if (overAction) return;
        markSliding(hideFollowDelay());
        armBottomFollow();
        document.body.classList.remove('better-gemini-opened');
        followBottom(hideFollowDelay());
        return;
      }

      if (barElement && path.includes(barElement)) {
        openBarFromPointer(e);
        return;
      }
      document.body.classList.remove('better-gemini-opened');
    }, true);
  }

  // Gemini streams responses into the DOM, which fires a large number of
  // mutations, so the content check is batched to once per animation frame.
  function watchInputContent() {
    let scheduled = false;

    function checkContent() {
      scheduled = false;
      const barChanged = trackBar();
      scheduleDockCheck(barChanged);
      ensureScroller();
      const hasDraft = editorHasDraft(findChatEditor());
      const hadDraft = document.body.classList.contains('has-content');
      if (hasDraft !== hadDraft && barIsDocked()) {
        markSliding(0);
        armBottomFollow();
      }
      document.body.classList.toggle('has-content', hasDraft);
      if (hasDraft !== hadDraft && barIsDocked()) followBottom(0);
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

  // ---------------------------------------------------------------------------
  // Usage tracker (Current + Weekly from Gemini's own limits RPC)
  // ---------------------------------------------------------------------------

  function levelClass(percent) {
    if (percent >= DANGER_AT * 100) return 'level-danger';
    if (percent >= WARN_AT * 100) return 'level-warn';
    return 'level-ok';
  }

  function formatReset(epochSec) {
    if (!epochSec) return '';
    try {
      const d = new Date(epochSec * 1000);
      const n = new Date();
      const sameDay = d.toDateString() === n.toDateString();
      return sameDay
        ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function openUsagePage() {
    const match = location.pathname.match(/^\/u\/(\d+)/);
    location.href = match ? `/u/${match[1]}/usage` : '/usage';
  }

  function metricText(kind, metric) {
    const label = kind === 'current' ? 'Current' : 'Weekly';
    if (!metric) return `${label} -`;
    return `${label} ${metric.percent}%`;
  }

  function renderUsageLabel() {
    if (!usageElement) return;
    const current = usageState.current;
    const weekly = usageState.weekly;
    const worst = Math.max(current ? current.percent : 0, weekly ? weekly.percent : 0);
    usageElement.classList.remove('level-ok', 'level-warn', 'level-danger');
    usageElement.classList.add(levelClass(worst));
    usageElement.textContent = '';
    const cur = document.createElement('span');
    cur.className = 'bg-text';
    cur.textContent = metricText('current', current);
    const sep = document.createElement('span');
    sep.className = 'bg-sep';
    sep.textContent = '\u00B7';
    const week = document.createElement('span');
    week.className = 'bg-text';
    week.textContent = metricText('weekly', weekly);
    usageElement.appendChild(cur);
    usageElement.appendChild(sep);
    usageElement.appendChild(week);
    const resets = [formatReset(current && current.resetEpoch), formatReset(weekly && weekly.resetEpoch)]
      .filter(Boolean)
      .join(' / ');
    usageElement.title = resets
      ? `Gemini usage limits. Resets ${resets}. Click for details.`
      : 'Gemini usage limits. Click for details.';
    placeChatFooter();
  }

  function bridgePost(type, extra = {}) {
    window.postMessage({ source: BRIDGE_CMD, type, ...extra }, window.location.origin);
  }

  function applyPlanTier(tier) {
    if (!tier) return;
    const key = String(tier).toUpperCase().replace(/^GOOGLE\s+AI\s+/, '');
    const limit = PLAN_LIMITS[key];
    if (!limit) return;
    planState = { tier: key, limit, updatedAt: Date.now() };
    chrome.storage.local.set({ betterGeminiPlan: planState });
    contextState.limit = resolveContextLimit(contextState.tokens);
    renderContextLabel();
  }

  function requestUsageFetch() {
    // Refresh usage percentages and/or plan tier (needed for the context limit).
    if (!settings.showUsage && !settings.showContext) return;
    const id = ++usageFetchId;
    bridgePost('fetch-usage', { id });
  }

  function watchBridge() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.source !== BRIDGE_SRC) return;
      const { type, payload } = event.data;

      if (type === 'ready') {
        bridgeReady = true;
        requestUsageFetch();
        return;
      }

      if (type === 'usage' && payload) {
        if (payload.id && payload.id !== usageFetchId) return;
        if (!payload.ok) return;
        if (payload.tier) applyPlanTier(payload.tier);
        if (payload.usage) {
          const { current, weekly } = payload.usage;
          usageState = {
            current: current ? { percent: current.percent, resetEpoch: current.resetEpoch } : usageState.current,
            weekly: weekly ? { percent: weekly.percent, resetEpoch: weekly.resetEpoch } : usageState.weekly,
            updatedAt: Date.now()
          };
          chrome.storage.local.set({ betterGeminiUsage: usageState });
          renderUsageLabel();
        }
        return;
      }

      if (type === 'usageMetadata' && payload) {
        // After a reply, context used is input history + this output.
        const prompt = Number(payload.promptTokenCount) || 0;
        const candidates = Number(payload.candidatesTokenCount) || 0;
        const total = Number(payload.totalTokenCount) || 0;
        const used = Math.max(total, prompt + candidates, prompt);
        if (used > 0) {
          setContextTokens(used, false);
          persistContextState();
          if (settings.showUsage) setTimeout(() => requestUsageFetch(), 2500);
        }
      }
    });

    bridgePost('ping');
    setInterval(() => {
      if (document.hidden) return;
      requestUsageFetch();
    }, 120000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) requestUsageFetch();
    });
  }

  // ---------------------------------------------------------------------------
  // Context window (beside the chat bar)
  // Gemini Apps sets the limit by Google AI plan (32k / 128k / 1M), not by
  // which model (Flash / Pro) is selected. See Google's Gemini Apps help.
  // ---------------------------------------------------------------------------

  function detectContextLimit() {
    // Prefer the plan read from Gemini's Usage limits page / RPC.
    if (planState.limit && CONTEXT_TIERS.includes(planState.limit)) return planState.limit;

    const nodes = document.querySelectorAll(
      '[data-test-id*="plan"], [aria-label*="Google AI"], [aria-label*="AI Pro"], [aria-label*="AI Ultra"], [aria-label*="AI Plus"]'
    );
    for (const el of nodes) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      if (/Ultra/i.test(label) && !/Upgrade/i.test(label)) return 1000000;
      if (/\bPro\b/i.test(label) && !/Upgrade/i.test(label)) return 1000000;
      if (/Plus/i.test(label) && !/Upgrade/i.test(label)) return 128000;
    }

    const sample = (document.body && document.body.innerText || '').slice(0, 12000);
    if (/Google AI Ultra|\bAI Ultra\b/i.test(sample) && !/Upgrade to.*Ultra/i.test(sample)) return 1000000;
    if (/Google AI Pro|\bAI Pro\b/i.test(sample) && !/Upgrade to Google AI Pro/i.test(sample)) return 1000000;
    if (/Google AI Plus|\bAI Plus\b/i.test(sample) && !/Upgrade to Google AI Plus/i.test(sample)) return 128000;

    // On the usage page itself, scrape the tier badge.
    if (/\/usage(?:\/|$)/.test(location.pathname)) {
      const root =
        document.querySelector('usage-metrics-window') ||
        document.querySelector('.usage-metrics-container') ||
        document.querySelector('.usage-metrics-header');
      const text = ((root && root.textContent) || '').replace(/\s+/g, ' ');
      const match = text.match(/\b(?:GOOGLE\s+AI\s+)?(FREE|PLUS|PRO|ULTRA)\b/i);
      if (match) {
        const limit = PLAN_LIMITS[match[1].toUpperCase()];
        if (limit) {
          applyPlanTier(match[1].toUpperCase());
          return limit;
        }
      }
    }

    return contextState.limit && CONTEXT_TIERS.includes(contextState.limit)
      ? contextState.limit
      : 32000;
  }

  function resolveContextLimit(used) {
    let limit = detectContextLimit();
    if (!CONTEXT_TIERS.includes(limit)) {
      limit = CONTEXT_TIERS.find((t) => t >= used) || CONTEXT_TIERS[0];
    }
    while (used > limit) {
      const idx = CONTEXT_TIERS.indexOf(limit);
      if (idx < 0 || idx >= CONTEXT_TIERS.length - 1) break;
      limit = CONTEXT_TIERS[idx + 1];
    }
    return limit;
  }

  function formatTokens(n) {
    if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
    if (n >= 1000) {
      const rounded = n >= 10000 ? Math.round(n / 1000) : Math.round(n / 100) / 10;
      return `${rounded}k`.replace('.0k', 'k');
    }
    return String(Math.round(n));
  }

  // Walk light DOM and open shadow roots so Angular/Lit message text is counted.
  function collectVisibleText(root, parts, depth) {
    if (!root || depth > 24) return;
    if (root.nodeType === Node.TEXT_NODE) {
      const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && !(root instanceof ShadowRoot)) return;

    if (root instanceof Element) {
      const tag = root.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') return;
      if (root.id === 'better-gemini-footer' || root.id === 'better-gemini-pill-host') return;
      if (root.getAttribute('aria-hidden') === 'true') return;
      if (root.shadowRoot) collectVisibleText(root.shadowRoot, parts, depth + 1);
    }

    const children = root.childNodes;
    for (let i = 0; i < children.length; i++) {
      collectVisibleText(children[i], parts, depth + 1);
    }
  }

  function conversationRoots() {
    const roots = [];
    const selectors = [
      'chat-window',
      'infinite-scroller',
      '.chat-history',
      '[data-test-id="chat-history"]',
      'message-content',
      'user-query',
      'model-response',
      '.conversation-container',
      '[class*="conversation"]'
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => roots.push(el));
    }
    // Deduplicate nested roots: keep outermost only.
    return roots.filter((el, i, all) => !all.some((other, j) => j !== i && other.contains(el)));
  }

  function estimateTokensFromDom() {
    const parts = [];
    const roots = conversationRoots();
    if (roots.length) {
      for (const root of roots) collectVisibleText(root, parts, 0);
    } else {
      // Fallback: sample the main column above the composer, not the whole page chrome.
      if (barElement) {
        const barRect = barElement.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 2, Math.max(2, barRect.left + barRect.width / 2));
        const y = Math.max(40, barRect.top - 80);
        const hit = document.elementFromPoint(x, y);
        let node = hit;
        while (node && node !== document.body) {
          if (node.scrollHeight > window.innerHeight * 0.35) {
            collectVisibleText(node, parts, 0);
            break;
          }
          node = node.parentElement;
        }
      }
    }

    let text = parts.join('\n');
    // Strip repeated UI chrome that often leaks into conversation containers.
    text = text
      .replace(/Gemini is AI and can make mistakes\.?/gi, '')
      .replace(/Better Gemini[\s\S]{0,40}context/gi, '')
      .replace(/\b(New chat|Settings|Gemini Apps|Google Account)\b/gi, '');

    if (!text.trim()) return 0;
    // ~4 chars/token is the usual English heuristic until Gemini returns exact counts.
    return Math.max(0, Math.ceil(text.length / 4));
  }

  function setContextTokens(tokens, estimated) {
    const next = Math.max(0, Math.round(tokens));
    if (!estimated) {
      // Exact counts from Gemini always win.
      contextState.tokens = next;
      contextState.estimated = false;
    } else if (!contextState.estimated && contextState.tokens > 0) {
      // Keep the last exact reading; DOM estimates must not overwrite it.
      contextState.limit = resolveContextLimit(contextState.tokens);
      renderContextLabel();
      return;
    } else {
      // Estimates only move upward (chat grows); ignore tiny downward DOM jitter.
      if (next + 40 < contextState.tokens) {
        renderContextLabel();
        return;
      }
      contextState.tokens = Math.max(contextState.tokens, next);
      contextState.estimated = true;
    }
    contextState.limit = resolveContextLimit(contextState.tokens);
    renderContextLabel();
  }

  function persistContextState() {
    const key = conversationKey();
    chrome.storage.local.get(['betterGeminiContext'], (result) => {
      const map = (result && result.betterGeminiContext) || {};
      map[key] = {
        tokens: contextState.tokens,
        limit: contextState.limit,
        estimated: contextState.estimated,
        updatedAt: Date.now()
      };
      // Keep the map small.
      const keys = Object.keys(map);
      if (keys.length > 40) {
        keys
          .sort((a, b) => (map[a].updatedAt || 0) - (map[b].updatedAt || 0))
          .slice(0, keys.length - 40)
          .forEach((k) => { delete map[k]; });
      }
      chrome.storage.local.set({ betterGeminiContext: map });
    });
  }

  function loadContextStateForChat() {
    const key = conversationKey();
    chrome.storage.local.get(['betterGeminiContext'], (result) => {
      const saved = result && result.betterGeminiContext && result.betterGeminiContext[key];
      if (saved && typeof saved.tokens === 'number' && saved.tokens > 0) {
        contextState.tokens = saved.tokens;
        contextState.estimated = saved.estimated !== false ? !!saved.estimated : false;
        contextState.limit = resolveContextLimit(saved.tokens);
        renderContextLabel();
      }
    });
  }

  function createChatFooter() {
    if (document.getElementById('better-gemini-footer')) {
      footerElement = document.getElementById('better-gemini-footer');
      contextElement = footerElement.querySelector('.better-gemini-context');
      usageElement = footerElement.querySelector('.better-gemini-usage');
      return;
    }

    footerElement = document.createElement('div');
    footerElement.id = 'better-gemini-footer';
    footerElement.className = 'better-gemini-footer';

    contextElement = document.createElement('div');
    contextElement.className = 'better-gemini-context';
    contextElement.setAttribute('aria-live', 'polite');

    usageElement = document.createElement('div');
    usageElement.className = 'better-gemini-usage';
    usageElement.setAttribute('role', 'link');
    usageElement.tabIndex = 0;
    usageElement.addEventListener('click', openUsagePage);
    usageElement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openUsagePage();
      }
    });

    footerElement.appendChild(contextElement);
    footerElement.appendChild(usageElement);
    document.body.appendChild(footerElement);

    updateFooterVisibility();
    renderContextLabel();
    renderUsageLabel();
  }

  function updateFooterVisibility() {
    if (contextElement) contextElement.hidden = !settings.showContext;
    if (usageElement) usageElement.hidden = !settings.showUsage;
    if (footerElement) {
      footerElement.hidden = !settings.showContext && !settings.showUsage;
    }
  }

  function renderContextLabel() {
    if (!contextElement) return;
    const { tokens, limit, estimated } = contextState;
    const ratio = limit > 0 ? tokens / limit : 0;
    contextElement.classList.remove('level-ok', 'level-warn', 'level-danger');
    contextElement.classList.add(
      ratio >= DANGER_AT ? 'level-danger' : ratio >= WARN_AT ? 'level-warn' : 'level-ok'
    );
    const approx = estimated ? '~' : '';
    const planNote = planState.tier ? ` Detected plan: ${planState.tier}.` : '';
    contextElement.removeAttribute('title');
    contextElement.textContent = '';

    const mark = document.createElement('span');
    mark.className = 'bg-mark';
    mark.textContent = 'Context Window';

    const info = document.createElement('span');
    info.className = 'bg-info';
    info.textContent = 'i';
    info.title = CONTEXT_INFO + planNote;
    info.setAttribute('aria-label', CONTEXT_INFO + planNote);
    info.setAttribute('role', 'img');

    const sep = document.createElement('span');
    sep.className = 'bg-sep';
    sep.textContent = '\u00B7';

    const value = document.createElement('span');
    value.className = 'bg-text';
    value.textContent = `${approx}${formatTokens(tokens)} / ${formatTokens(limit)}`;
    value.title = estimated
      ? 'Estimated until Gemini returns an exact count.'
      : 'Exact token count from Gemini.';

    contextElement.appendChild(mark);
    contextElement.appendChild(info);
    contextElement.appendChild(sep);
    contextElement.appendChild(value);
    placeChatFooter();
  }

  function findDisclaimerEl() {
    if (!barElement) return null;
    const barRect = barElement.getBoundingClientRect();
    const nodes = document.querySelectorAll('div, span, p');
    for (const el of nodes) {
      if (el.closest('#better-gemini-footer') || el.closest('#better-gemini-pill-host')) continue;
      if (el.childElementCount > 2) continue;
      const text = (el.textContent || '').trim();
      if (!/^Gemini is AI and can make mistakes\.?$/i.test(text)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 8) continue;
      if (rect.top < barRect.bottom - 8 || rect.top > barRect.bottom + 48) continue;
      return el;
    }
    return null;
  }

  // One row under the composer: context (left) + Gemini disclaimer (center) + usage (right).
  function placeChatFooter() {
    if (!footerElement || footerElement.hidden) return;
    if (!barElement || !barElement.isConnected) {
      footerElement.classList.remove('placed');
      return;
    }
    const barRect = barElement.getBoundingClientRect();
    if (barRect.width < 40 || barRect.height < 10) {
      footerElement.classList.remove('placed');
      return;
    }

    const disclaimer = findDisclaimerEl();
    let top;
    let height = 16;
    if (disclaimer) {
      const d = disclaimer.getBoundingClientRect();
      top = d.top;
      height = Math.max(14, Math.round(d.height));
      const style = getComputedStyle(disclaimer);
      footerElement.style.fontSize = style.fontSize || '12px';
      footerElement.style.lineHeight = style.lineHeight || '16px';
      footerElement.style.fontFamily = style.fontFamily || "'Google Sans', Roboto, Arial, sans-serif";
      footerElement.style.color = style.color || '#5f6368';
    } else {
      top = barRect.bottom + (barIsDocked() && !barCoversNaturally() ? 2 : 8);
      footerElement.style.fontSize = '12px';
      footerElement.style.lineHeight = '16px';
    }

    footerElement.style.left = `${Math.round(barRect.left)}px`;
    footerElement.style.width = `${Math.round(barRect.width)}px`;
    footerElement.style.top = `${Math.round(top)}px`;
    footerElement.style.height = `${height}px`;
    footerElement.classList.toggle('theme-dark', isGeminiDark());
    footerElement.classList.add('placed');
  }

  function conversationKey() {
    const match = location.pathname.match(/\/(?:app|c|u\/\d+\/app)\/([^/?#]+)/);
    if (match) return match[1];
    const u = location.pathname.match(/^\/u\/(\d+)/);
    return u ? `u/${u[1]}${location.pathname}` : location.pathname;
  }

  function watchContext() {
    let lastKey = conversationKey();
    let estimateTimer = null;

    const refreshEstimate = () => {
      if (!settings.showContext) return;
      const estimate = estimateTokensFromDom();
      if (estimate > 0 || contextState.estimated) setContextTokens(estimate, true);
      if (estimate > 0) persistContextState();
    };

    setInterval(() => {
      const key = conversationKey();
      if (key !== lastKey) {
        lastKey = key;
        contextState = { tokens: 0, limit: detectContextLimit(), estimated: true };
        loadContextStateForChat();
        refreshEstimate();
      }
      placeChatFooter();
    }, 1000);

    new MutationObserver(() => {
      if (estimateTimer) clearTimeout(estimateTimer);
      estimateTimer = setTimeout(refreshEstimate, 400);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    loadContextStateForChat();
    refreshEstimate();
  }

  async function init() {
    await loadSettings();
    chrome.storage.local.get(['betterGeminiUsage', 'betterGeminiPlan'], (result) => {
      if (result && result.betterGeminiUsage) {
        usageState = { ...usageState, ...result.betterGeminiUsage };
        renderUsageLabel();
      }
      if (result && result.betterGeminiPlan && result.betterGeminiPlan.limit) {
        planState = { ...planState, ...result.betterGeminiPlan };
        contextState.limit = resolveContextLimit(contextState.tokens);
        renderContextLabel();
      }
    });
    applyHideState();
    createPill();
    createChatFooter();
    watchBridge();
    watchContext();
    watchInputContent();
    watchTyping();
    watchBarClicks();
    watchHoverReveal();

    const themeWatcher = new MutationObserver(() => {
      applyPillTheme();
      if (footerElement) footerElement.classList.toggle('theme-dark', isGeminiDark());
    });
    themeWatcher.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

