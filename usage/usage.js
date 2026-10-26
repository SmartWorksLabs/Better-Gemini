(function () {
  'use strict';

  const BAR_SELECTORS = [
    'input-container',
    '.input-area-container',
    '[class*="input-area"]'
  ].join(', ');

  const SYNC_KEYS = ['showUsage', 'showContext'];
  const CONTEXT_TIERS = [32000, 128000, 1000000];
  const WARN_AT = 0.75;
  const DANGER_AT = 0.9;
  const SIDE_MIN_GAP = 24; // px from the chat column edge to context and usage
  const BRIDGE_CMD = 'gemini-usage-bridge-cmd';
  const BRIDGE_SRC = 'gemini-usage-bridge';

  let settings = {
    showUsage: true,
    showContext: true
  };

  let barElement = null;
  let footerElement = null;
  let contextElement = null;
  let usageElement = null;
  let usageState = { current: null, weekly: null, updatedAt: 0 };
  let contextState = { tokens: 0, limit: 32000, estimated: true };
  let planState = { tier: null, limit: null, updatedAt: 0 };
  let usageFetchId = 0;

  const PLAN_LIMITS = {
    FREE: 32000,
    PLUS: 128000,
    PRO: 1000000,
    ULTRA: 1000000,
    ADVANCED: 1000000
  };

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(SYNC_KEYS, (result) => {
        if (!chrome.runtime.lastError && result) settings = { ...settings, ...result };
        resolve(settings);
      });
    });
  }

  // Settings are changed from the toolbar popup.
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return;
    let changed = false;
    SYNC_KEYS.forEach((key) => {
      if (!changes[key] || changes[key].newValue === undefined) return;
      settings[key] = changes[key].newValue;
      changed = true;
    });
    if (!changed) return;
    updateFooterVisibility();
    placeChatFooter();
    requestUsageFetch();
  });

  // ---------------------------------------------------------------------------
  // Chat bar
  // ---------------------------------------------------------------------------

  // Only Gemini's composer, not another text box on the page.
  function findChatEditor() {
    const editors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'));
    return (
      editors.find((el) => el.closest('input-container')) ||
      editors.find((el) => el.closest(BAR_SELECTORS)) ||
      null
    );
  }

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

  // Gemini re-renders the bar when switching chats, so look it up again
  // each time the footer is placed.
  function trackBar() {
    barElement = findBar();
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

  function applyFooterTheme() {
    if (footerElement) footerElement.classList.toggle('theme-dark', isGeminiDark());
  }

  // The bar can slide (Hide Chat Bar for Gemini, panels opening, window
  // resizes). Follow it on every frame for a moment so the line stays under it.
  let followUntil = 0;
  let following = false;

  function followLayout(duration = 700) {
    followUntil = Math.max(followUntil, performance.now() + duration);
    if (following) return;
    following = true;
    const step = () => {
      placeChatFooter();
      if (performance.now() < followUntil) {
        requestAnimationFrame(step);
      } else {
        following = false;
      }
    };
    requestAnimationFrame(step);
  }

  function watchLayoutChanges() {
    window.addEventListener('resize', () => followLayout(300));
    document.addEventListener('click', () => followLayout(), true);
    document.addEventListener('keyup', () => followLayout(), true);
    document.addEventListener('focusin', () => followLayout(), true);
    for (const type of ['transitionrun', 'transitionend']) {
      document.addEventListener(type, () => followLayout(type === 'transitionend' ? 100 : 700), true);
    }

    let lastMutation = 0;
    new MutationObserver(() => {
      const now = performance.now();
      if (now - lastMutation < 150) return;
      lastMutation = now;
      followLayout(100);
    }).observe(document.body, { childList: true, subtree: true });

    new MutationObserver(applyFooterTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    darkSchemeQuery.addEventListener('change', applyFooterTheme);
  }

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
      let hours = d.getHours();
      const mins = String(d.getMinutes()).padStart(2, '0');
      const ap = hours >= 12 ? 'pm' : 'am';
      hours = hours % 12 || 12;
      const time = `${hours}:${mins}${ap}`;
      if (sameDay) return time;
      const day = d.toLocaleDateString(undefined, { weekday: 'short' });
      return `${day} ${time}`;
    } catch (_) {
      return '';
    }
  }

  function openUsagePage() {
    const match = location.pathname.match(/^\/u\/(\d+)/);
    location.href = match ? `/u/${match[1]}/usage` : '/usage';
  }

  function buildPair(className, labelText, valueText, valueClass) {
    const row = document.createElement('div');
    row.className = className;

    const label = document.createElement('span');
    label.className = 'gu-label';
    label.textContent = labelText;

    const sep = document.createElement('span');
    sep.className = 'gu-sep';
    sep.textContent = '\u00B7';

    const value = document.createElement('span');
    value.className = valueClass;
    value.textContent = valueText;

    row.appendChild(label);
    row.appendChild(sep);
    row.appendChild(value);
    return row;
  }

  // Two lines, e.g. "Current Usage · 1%" over "Resets · 6:31pm".
  function buildStack(label, value, metaLabel, metaValue) {
    const stack = document.createElement('div');
    stack.className = 'gu-stack';
    stack.appendChild(buildPair('gu-stack-top', label, value, 'gu-value'));
    stack.appendChild(buildPair('gu-stack-meta', metaLabel, metaValue, 'gu-value gu-value-meta'));
    return stack;
  }

  function buildUsageStack(kind, metric) {
    return buildStack(
      kind === 'current' ? 'Current Usage' : 'Weekly Usage',
      metric ? `${metric.percent}%` : '-',
      'Resets',
      formatReset(metric && metric.resetEpoch) || '—'
    );
  }

  function renderUsageLabel() {
    if (!usageElement) return;
    const current = usageState.current;
    const weekly = usageState.weekly;
    const worst = Math.max(current ? current.percent : 0, weekly ? weekly.percent : 0);
    usageElement.classList.remove('level-ok', 'level-warn', 'level-danger');
    usageElement.classList.add(levelClass(worst));
    usageElement.textContent = '';
    usageElement.appendChild(buildUsageStack('current', current));
    usageElement.appendChild(buildUsageStack('weekly', weekly));
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
    chrome.storage.local.set({ planTier: planState });
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
          chrome.storage.local.set({ usageSnapshot: usageState });
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
      if (root.id === 'gemini-usage-footer' || root.id === 'hcb-pill-host') return;
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
      .replace(/Usage Tracker for Gemini[\s\S]{0,40}context/gi, '')
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
    chrome.storage.local.get(['contextByChat'], (result) => {
      const map = (result && result.contextByChat) || {};
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
      chrome.storage.local.set({ contextByChat: map });
    });
  }

  function loadContextStateForChat() {
    const key = conversationKey();
    chrome.storage.local.get(['contextByChat'], (result) => {
      const saved = result && result.contextByChat && result.contextByChat[key];
      if (saved && typeof saved.tokens === 'number' && saved.tokens > 0) {
        contextState.tokens = saved.tokens;
        contextState.estimated = saved.estimated !== false ? !!saved.estimated : false;
        contextState.limit = resolveContextLimit(saved.tokens);
        renderContextLabel();
      }
    });
  }

  function createChatFooter() {
    if (document.getElementById('gemini-usage-footer')) {
      footerElement = document.getElementById('gemini-usage-footer');
      contextElement = footerElement.querySelector('.gemini-usage-context');
      usageElement = footerElement.querySelector('.gemini-usage-pills');
      const leftover = footerElement.querySelector('.gemini-usage-footer-spacer');
      if (leftover) leftover.remove();
      return;
    }

    footerElement = document.createElement('div');
    footerElement.id = 'gemini-usage-footer';
    footerElement.className = 'gemini-usage-footer';

    contextElement = document.createElement('div');
    contextElement.className = 'gemini-usage-context';
    contextElement.setAttribute('aria-live', 'polite');

    usageElement = document.createElement('div');
    usageElement.className = 'gemini-usage-pills';
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

  // Only inside a chat (an address with a chat id), not on the new-chat screen.
  function inChat() {
    const p = location.pathname;
    return /\/(?:app|c)\/[0-9a-f]+/i.test(p) || /\/gem\/[^/]+\/[0-9a-f]{8,}/i.test(p);
  }

  function updateFooterVisibility() {
    if (contextElement) contextElement.hidden = !settings.showContext;
    if (usageElement) usageElement.hidden = !settings.showUsage;
    if (footerElement) {
      footerElement.hidden = !inChat() || (!settings.showContext && !settings.showUsage);
    }
  }

  function renderContextLabel() {
    if (!contextElement) return;
    const { tokens, limit } = contextState;
    const ratio = limit > 0 ? tokens / limit : 0;
    contextElement.classList.remove('level-ok', 'level-warn', 'level-danger');
    contextElement.classList.add(
      ratio >= DANGER_AT ? 'level-danger' : ratio >= WARN_AT ? 'level-warn' : 'level-ok'
    );
    contextElement.textContent = '';
    // Same two-stack shape as the usage side, so both sides can be the same width.
    const percent = tokens > 0 && ratio < 0.005 ? '<1%' : `${Math.round(ratio * 100)}%`;
    contextElement.appendChild(buildStack('Context Window', percent, 'Used', formatTokens(tokens)));
    contextElement.appendChild(
      buildStack('Remaining', formatTokens(Math.max(0, limit - tokens)), 'Limit', formatTokens(limit))
    );
    placeChatFooter();
  }

  function findDisclaimerEl() {
    if (!barElement) return null;
    const barRect = barElement.getBoundingClientRect();
    const nodes = document.querySelectorAll('div, span, p');
    for (const el of nodes) {
      if (el.closest('#gemini-usage-footer') || el.closest('#hcb-pill-host')) continue;
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

  // Footer box matches the chat bar width so Gemini's disclaimer stays centered
  // under the bar. Context/usage hang flush outside the left/right edges.
  function placeChatFooter() {
    updateFooterVisibility();
    if (!footerElement || footerElement.hidden) return;
    trackBar();
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
    let height = settings.showUsage ? 32 : 16;
    // Always force Gemini's sans stack. Copying computed font-family can fall
    // through to the browser serif default (Times) on some builds.
    footerElement.style.fontFamily = '"Google Sans", "Google Sans Text", Roboto, Arial, Helvetica, sans-serif';
    footerElement.style.fontWeight = '400';
    footerElement.style.fontStyle = 'normal';
    footerElement.style.letterSpacing = '0.01em';
    if (disclaimer) {
      const d = disclaimer.getBoundingClientRect();
      height = Math.max(height, Math.round(d.height));
      // Keep our block vertically centered on the disclaimer so the Gemini
      // line stays visually mid-row while twin stacks sit beside it.
      top = d.top + d.height / 2 - height / 2;
      const style = getComputedStyle(disclaimer);
      footerElement.style.fontSize = style.fontSize || '12px';
      footerElement.style.lineHeight = '15px';
      footerElement.style.color = style.color || '#5f6368';
    } else {
      top = barRect.bottom + 8;
      footerElement.style.fontSize = '12px';
      footerElement.style.lineHeight = '15px';
      footerElement.style.color = '';
    }

    footerElement.style.transform = '';
    footerElement.style.maxWidth = '';
    footerElement.style.left = `${Math.round(barRect.left)}px`;
    footerElement.style.width = `${Math.round(barRect.width)}px`;
    footerElement.style.top = `${Math.round(top)}px`;
    footerElement.style.height = `${Math.round(height)}px`;
    footerElement.classList.toggle('theme-dark', isGeminiDark());
    footerElement.classList.add('placed');
    balanceSides(barRect);
  }

  // Gemini centres the bar in the chat column, so the space beside it is the
  // same on both sides. Context and usage get the same width (their stacks
  // spread across it) and sit against the bar's ends, so their gaps to the bar
  // and to the column edges match on both sides. When the column is too narrow
  // they slide under the bar's ends, keeping SIDE_MIN_GAP to the edges.
  function balanceSides(barRect) {
    const viewportRight = document.documentElement.clientWidth || window.innerWidth;
    const side = Math.max(0, viewportRight - barRect.right);
    contextElement.style.width = '';
    usageElement.style.width = '';
    const width = Math.max(
      settings.showContext ? contextElement.offsetWidth : 0,
      settings.showUsage ? usageElement.offsetWidth : 0
    );
    contextElement.style.width = `${width}px`;
    usageElement.style.width = `${width}px`;
    const inset = Math.min(0, side - SIDE_MIN_GAP - width);
    contextElement.style.marginRight = `${Math.round(inset)}px`;
    usageElement.style.marginLeft = `${Math.round(inset)}px`;
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
    chrome.storage.local.get(['usageSnapshot', 'planTier'], (result) => {
      if (result && result.usageSnapshot) {
        usageState = { ...usageState, ...result.usageSnapshot };
        renderUsageLabel();
      }
      if (result && result.planTier && result.planTier.limit) {
        planState = { ...planState, ...result.planTier };
        contextState.limit = resolveContextLimit(contextState.tokens);
        renderContextLabel();
      }
    });
    createChatFooter();
    watchLayoutChanges();
    watchBridge();
    watchContext();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
