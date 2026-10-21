/* Better Gemini — Claude-style parallel message versions in the same chat.
   Never mutates Gemini message nodes or page CSS. Alternate versions render
   in a closed shadow overlay. Continues are re-parented via tip override.

   Works on existing chats: as soon as the feature is on, we keep a live text
   buffer of the open chat. The first edit after enable freezes that buffer as
   version 1 — no need to start a new chat. */
(function () {
  'use strict';

  const BRIDGE_CMD = 'better-gemini-bridge-cmd';
  const BRIDGE_SRC = 'better-gemini-bridge';
  const STORE_KEY = 'betterGeminiTimelines';
  const OVERLAY_ID = 'better-gemini-timeline-overlay';
  const STORE_VERSION = 4;
  const MAX_CHATS = 40;
  const MAX_BRANCHES_PER_CHAT = 24;

  let enabled = true;
  let thread = null;
  let chatId = null;
  let pendingEdit = null;
  let viewingAlternate = false;
  let paintScheduled = false;
  let syncTimer = null;
  let bufferTimer = null;
  let liveBuffer = []; // rolling scrape of the open chat (works before any fork)
  let preEditFreeze = null; // snapshot taken when the pencil editor opens
  const bridgeWaiters = new Map();
  let bridgeReqId = 0;

  function bridgePost(type, extra = {}) {
    window.postMessage({ source: BRIDGE_CMD, type, ...extra }, window.location.origin);
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function conversationId() {
    const m = location.pathname.match(/\/(?:app|c)\/([0-9a-f]+)/i);
    return m ? `c_${m[1]}` : null;
  }

  function extAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function storageGet() {
    return new Promise((resolve) => {
      if (!extAlive()) {
        resolve({});
        return;
      }
      try {
        chrome.storage.local.get([STORE_KEY], (result) => {
          if (chrome.runtime.lastError) {
            resolve({});
            return;
          }
          resolve((result && result[STORE_KEY]) || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  function storageSet(all) {
    return new Promise((resolve) => {
      if (!extAlive()) {
        resolve();
        return;
      }
      try {
        chrome.storage.local.set({ [STORE_KEY]: all }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  async function loadThread(id) {
    if (!id) {
      thread = null;
      return null;
    }
    const all = await storageGet();
    thread = all[id] || null;
    return thread;
  }

  async function saveThread() {
    if (!chatId || !thread || !hasForks(thread)) return;
    const all = await storageGet();
    thread.updatedAt = Date.now();
    all[chatId] = thread;
    const ids = Object.keys(all).sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0));
    while (ids.length > MAX_CHATS) delete all[ids.shift()];
    await storageSet(all);
  }

  function emptyThread() {
    const branchId = uid('b');
    return {
      updatedAt: Date.now(),
      activeBranchId: branchId,
      serverTip: null,
      forks: {},
      branches: {
        [branchId]: {
          id: branchId,
          parentId: null,
          forkAt: 0,
          tip: null,
          messages: [],
          updatedAt: Date.now()
        }
      }
    };
  }

  function ensureThread() {
    if (!thread) thread = emptyThread();
    return thread;
  }

  function activeBranch() {
    if (!thread) return null;
    return thread.branches[thread.activeBranchId] || null;
  }

  function hasForks(t) {
    if (!t || !t.forks) return false;
    return Object.keys(t.forks).some((k) => {
      const f = t.forks[k];
      return f && f.branchIds && f.branchIds.length >= 2;
    });
  }

  /** After an edit, the last id in branchIds is always the path Gemini is showing. */
  function liveBranchId(fork) {
    if (!fork || !fork.branchIds || !fork.branchIds.length) return null;
    return fork.branchIds[fork.branchIds.length - 1];
  }

  function resetForksToLive() {
    if (!thread || !thread.forks) return;
    Object.keys(thread.forks).forEach((key) => {
      const fork = thread.forks[key];
      if (!fork || !fork.branchIds || !fork.branchIds.length) return;
      const liveId = liveBranchId(fork);
      fork.activeIndex = fork.branchIds.length - 1;
      if (liveId) thread.activeBranchId = liveId;
    });
  }

  // ---- Read-only Gemini DOM (never write into message bodies) -------------

  function turnNodes() {
    return Array.from(document.querySelectorAll('user-query, model-response')).filter(
      (n) => n && n.isConnected
    );
  }

  function roleOf(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'user-query') return 'user';
    if (tag === 'model-response') return 'model';
    return null;
  }

  function cleanMessageText(raw) {
    let t = String(raw || '').replace(/\s+\n/g, '\n').trim();
    t = t.replace(/^(You said|Gemini said|Model said)\s+/i, '');
    const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const a = lines[0].replace(/^(You said)\s+/i, '');
      const b = lines[1].replace(/^(You said)\s+/i, '');
      if (a === b) t = a;
    }
    return t.trim();
  }

  function textOf(el) {
    if (!el) return '';
    const role = roleOf(el);
    let box = el;
    if (role === 'user') {
      box =
        el.querySelector('.query-text') ||
        el.querySelector('[class*="query-text"]') ||
        el.querySelector('.query-content') ||
        el;
    } else {
      box =
        el.querySelector('message-content') ||
        el.querySelector('.markdown') ||
        el.querySelector('.model-response-text') ||
        el;
    }
    const clone = box.cloneNode(true);
    clone.querySelectorAll(
      '[aria-hidden="true"], .sr-only, .cdk-visually-hidden, .bg-timeline-controls'
    ).forEach((n) => n.remove());
    return cleanMessageText(clone.innerText || clone.textContent || '');
  }

  function scrapeMessages() {
    const out = [];
    for (const el of turnNodes()) {
      const role = roleOf(el);
      if (!role) continue;
      const text = textOf(el);
      if (!text && role === 'model') continue;
      out.push({ role, text });
    }
    return out;
  }

  function refreshLiveBuffer() {
    if (!enabled || !chatId || viewingAlternate) return;
    const msgs = scrapeMessages();
    if (!msgs.length) return;
    liveBuffer = msgs.map((m) => ({ role: m.role, text: cleanMessageText(m.text) }));
  }

  function bestFreezeMessages() {
    if (preEditFreeze && preEditFreeze.length) return preEditFreeze.slice();
    if (liveBuffer.length) return liveBuffer.slice();
    return scrapeMessages().map((m) => ({ role: m.role, text: cleanMessageText(m.text) }));
  }

  function userTurnIndexFromPrompt(prompt, messages) {
    if (!prompt) return -1;
    const needle = cleanMessageText(prompt);
    const users = [];
    const source = messages && messages.length
      ? messages
      : turnNodes().filter((n) => roleOf(n) === 'user').map((n) => ({ role: 'user', text: textOf(n) }));
    for (let i = 0; i < source.length; i++) {
      if (source[i].role === 'user') users.push({ i, text: source[i].text });
    }
    for (let u = users.length - 1; u >= 0; u--) {
      const t = users[u].text;
      if (t === needle || t.includes(needle.slice(0, 80)) || needle.includes(t.slice(0, 80))) {
        return u;
      }
    }
    return users.length ? users.length - 1 : -1;
  }

  function messagesToUserOrdinal(messages, userOrdinal) {
    let seen = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        seen++;
        if (seen === userOrdinal) return i;
      }
    }
    return -1;
  }

  function scrubLegacyArtifacts() {
    document.querySelectorAll('.bg-timeline-clone, .bg-timeline-replay').forEach((n) => n.remove());
    document.querySelectorAll('.bg-timeline-hidden').forEach((n) => {
      n.classList.remove('bg-timeline-hidden');
    });
    hideOverlay();
  }

  // ---- Shadow overlay -----------------------------------------------------

  function findChatScrollRoot() {
    return (
      document.querySelector('infinite-scroller') ||
      document.querySelector('.chat-history') ||
      document.querySelector('[data-test-id="chat-history"]') ||
      document.querySelector('chat-window') ||
      document.querySelector('main') ||
      null
    );
  }

  function hideOverlay() {
    const host = document.getElementById(OVERLAY_ID);
    if (host) {
      if (host.__bgSync) {
        window.removeEventListener('resize', host.__bgSync);
        window.removeEventListener('scroll', host.__bgSync, true);
        host.__bgSync = null;
      }
      host.remove();
    }
    viewingAlternate = false;
  }

  function overlayStyles() {
    const dark = document.body.classList.contains('dark-theme');
    return `
      :host {
        all: initial;
        display: block;
        font-family: "Google Sans", "Google Sans Text", Roboto, Arial, Helvetica, sans-serif;
        color: ${dark ? '#e3e3e3' : '#1f1f1f'};
      }
      .wrap {
        box-sizing: border-box;
        height: 100%;
        overflow: auto;
        padding: 16px 16px 96px;
        background: ${dark ? '#131314' : '#fff'};
      }
      .banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px 16px;
        margin: 0 auto 20px;
        max-width: 800px;
        padding: 10px 14px;
        border-radius: 12px;
        background: ${dark ? '#2d2e30' : '#f0f4f9'};
        font-size: 13px;
        color: ${dark ? '#c4c7c5' : '#444746'};
        position: sticky;
        top: 0;
        z-index: 2;
      }
      .banner-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .banner-left strong { font-weight: 500; color: inherit; }
      .banner-right {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
      }
      .banner-link {
        appearance: none;
        border: none;
        background: transparent;
        color: ${dark ? '#a8c7fa' : '#0b57d0'};
        cursor: pointer;
        font: inherit;
        font-weight: 500;
        padding: 4px 8px;
        white-space: nowrap;
      }
      .msg {
        max-width: 800px;
        margin: 0 auto 20px;
        line-height: 1.6;
        font-size: 16px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .msg-user {
        width: fit-content;
        max-width: min(800px, 92%);
        margin-left: auto;
        margin-right: auto;
        margin-bottom: 20px;
        padding: 12px 16px;
        border-radius: 18px;
        background: ${dark ? '#2d2e30' : '#f0f4f9'};
      }
      .msg-model { padding: 4px 0; }
      .empty {
        max-width: 800px;
        margin: 48px auto;
        text-align: center;
        color: ${dark ? '#9aa0a6' : '#5f6368'};
        font-size: 14px;
      }
      .controls {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        user-select: none;
        font-size: 13px;
        color: ${dark ? '#e8eaed' : '#202124'};
      }
      .controls button {
        appearance: none;
        border: 1px solid ${dark ? 'rgba(232,234,237,0.2)' : 'rgba(60,64,67,0.2)'};
        background: ${dark ? '#1e1f20' : '#fff'};
        color: inherit;
        cursor: pointer;
        padding: 4px 10px;
        border-radius: 8px;
        font-size: 16px;
        line-height: 1;
        min-width: 32px;
      }
      .controls button:disabled { opacity: 0.35; cursor: default; }
      .controls button:hover:not(:disabled) {
        background: ${dark ? 'rgba(232,234,237,0.08)' : 'rgba(60,64,67,0.08)'};
      }
      .count {
        font-variant-numeric: tabular-nums;
        min-width: 2.75em;
        text-align: center;
        font-weight: 600;
      }
    `;
  }

  function placeOverlayHost(host, root) {
    const sync = () => {
      const r = root.getBoundingClientRect();
      host.style.top = `${Math.max(0, r.top)}px`;
      host.style.left = `${Math.max(0, r.left)}px`;
      host.style.width = `${Math.max(0, r.width)}px`;
      host.style.height = `${Math.max(0, r.height)}px`;
    };
    sync();
    if (host.__bgSync) {
      window.removeEventListener('resize', host.__bgSync);
      window.removeEventListener('scroll', host.__bgSync, true);
    }
    host.__bgSync = sync;
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
  }

  function buildVersionControls(forkAt, fork, idx, total) {
    const controls = document.createElement('div');
    controls.className = 'controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Message versions');

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous version');
    prev.textContent = '\u2039';
    prev.disabled = idx <= 0;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${idx + 1} / ${total}`;

    const next = document.createElement('button');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next version');
    next.textContent = '\u203A';
    next.disabled = idx >= total - 1;

    prev.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (idx > 0) selectBranch(forkAt, fork.branchIds[idx - 1]);
    });
    next.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (idx < total - 1) selectBranch(forkAt, fork.branchIds[idx + 1]);
    });

    controls.appendChild(prev);
    controls.appendChild(count);
    controls.appendChild(next);
    return controls;
  }

  function showOverlay(forkAt, branch, fork) {
    const root = findChatScrollRoot();
    if (!root) return;

    let host = document.getElementById(OVERLAY_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = OVERLAY_ID;
      host.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:auto;';
      document.body.appendChild(host);
    }
    placeOverlayHost(host, root);
    let shadow = host.shadowRoot;
    if (!shadow) shadow = host.attachShadow({ mode: 'open' });

    const msgs = (branch.messages || []).map((m) => ({
      role: m.role,
      text: cleanMessageText(m.text)
    }));

    const total = fork.branchIds.length;
    const idx = Math.max(0, Math.min(fork.activeIndex || 0, total - 1));

    clearChildren(shadow);
    const style = document.createElement('style');
    style.textContent = overlayStyles();
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const banner = document.createElement('div');
    banner.className = 'banner';

    const left = document.createElement('div');
    left.className = 'banner-left';
    const strong = document.createElement('strong');
    strong.textContent = `Version ${idx + 1} of ${total}`;
    const hint = document.createElement('span');
    hint.textContent = 'Saved copy — Gemini underneath is unchanged';
    left.appendChild(strong);
    left.appendChild(hint);

    const right = document.createElement('div');
    right.className = 'banner-right';
    // Always show both arrows here so > is never lost after pressing <.
    right.appendChild(buildVersionControls(forkAt, fork, idx, total));

    const liveBtn = document.createElement('button');
    liveBtn.type = 'button';
    liveBtn.className = 'banner-link';
    liveBtn.textContent = 'Show current';
    liveBtn.addEventListener('click', () => {
      const liveId = liveBranchId(fork);
      if (liveId) selectBranch(forkAt, liveId);
    });
    right.appendChild(liveBtn);

    banner.appendChild(left);
    banner.appendChild(right);
    wrap.appendChild(banner);

    if (!msgs.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent =
        'No saved text for this version. Open edit on a message (pencil) before updating so the prior reply can be captured.';
      wrap.appendChild(empty);
    } else {
      for (const msg of msgs) {
        const el = document.createElement('div');
        el.className = msg.role === 'user' ? 'msg msg-user' : 'msg msg-model';
        el.textContent = msg.text || '';
        wrap.appendChild(el);
      }
    }

    shadow.appendChild(wrap);
    viewingAlternate = true;
  }

  // ---- Branch ops ----------------------------------------------------------

  async function syncActiveFromDom() {
    if (!enabled || !chatId || viewingAlternate) return;
    refreshLiveBuffer();
    if (!pendingEdit && (!thread || !hasForks(thread))) return;
    const t = ensureThread();
    const branch = activeBranch();
    if (!branch) return;
    // Only overwrite the live (latest) branch from the DOM.
    const forkKeys = Object.keys(t.forks);
    let onLive = !forkKeys.length;
    for (const key of forkKeys) {
      const fork = t.forks[key];
      if (liveBranchId(fork) === branch.id) onLive = true;
    }
    if (!onLive && !pendingEdit) return;

    const msgs = liveBuffer.length ? liveBuffer : scrapeMessages();
    if (!msgs.length) return;
    branch.messages = msgs.map((m) => ({ role: m.role, text: cleanMessageText(m.text) }));
    branch.updatedAt = Date.now();
    if (t.serverTip) branch.tip = { ...t.serverTip };
    await saveThread();
    schedulePaint();
  }

  async function onEditDetected(meta) {
    if (!enabled || !chatId) return;
    if (!meta || !meta.isEdit) return;

    hideOverlay();
    const t = ensureThread();
    const freeze = bestFreezeMessages();
    preEditFreeze = null;

    let userOrd = userTurnIndexFromPrompt(meta.prompt, freeze);
    if (userOrd < 0) {
      const users = freeze.filter((m) => m.role === 'user');
      userOrd = Math.max(0, users.length - 1);
    }
    const msgIndex = messagesToUserOrdinal(freeze, userOrd);
    const forkAt = userOrd;

    const oldId = t.activeBranchId;
    const oldBranch = t.branches[oldId] || {
      id: oldId,
      parentId: null,
      forkAt: 0,
      tip: t.serverTip,
      messages: freeze,
      updatedAt: Date.now()
    };
    // Keep the pre-edit transcript + replies as version N.
    if (freeze.length) oldBranch.messages = freeze;
    if (!oldBranch.tip && t.serverTip) oldBranch.tip = { ...t.serverTip };
    t.branches[oldId] = oldBranch;

    const newId = uid('b');
    const prefix = msgIndex >= 0 ? freeze.slice(0, msgIndex) : freeze.slice();
    const newPrompt = cleanMessageText(meta.prompt || '');
    t.branches[newId] = {
      id: newId,
      parentId: oldId,
      forkAt,
      tip: null,
      messages: newPrompt ? prefix.concat([{ role: 'user', text: newPrompt }]) : prefix.slice(),
      updatedAt: Date.now()
    };
    t.activeBranchId = newId;

    const key = String(forkAt);
    const fork = t.forks[key] || { branchIds: [], activeIndex: 0 };
    // Preserve history order: older versions first, new live path last.
    if (!fork.branchIds.includes(oldId)) fork.branchIds.push(oldId);
    if (!fork.branchIds.includes(newId)) fork.branchIds.push(newId);
    // Move newId to the end so liveBranchId() is correct.
    fork.branchIds = fork.branchIds.filter((id) => id !== newId).concat([newId]);
    fork.activeIndex = fork.branchIds.length - 1;
    t.forks[key] = fork;

    const bIds = Object.keys(t.branches);
    if (bIds.length > MAX_BRANCHES_PER_CHAT) {
      bIds.sort((a, b) => (t.branches[a].updatedAt || 0) - (t.branches[b].updatedAt || 0));
      while (Object.keys(t.branches).length > MAX_BRANCHES_PER_CHAT) {
        const drop = bIds.shift();
        if (!drop || drop === t.activeBranchId) continue;
        if (fork.branchIds.includes(drop) && fork.branchIds.length <= 2) continue;
        delete t.branches[drop];
        fork.branchIds = fork.branchIds.filter((id) => id !== drop);
      }
      fork.activeIndex = Math.max(0, fork.branchIds.indexOf(newId));
    }

    pendingEdit = { forkAt, newId, oldId };
    await saveThread();
    bridgePost('clear-tip-override', {});
    schedulePaint();
  }

  async function onSendDetected() {
    if (!enabled || !chatId) return;
    setTimeout(() => syncActiveFromDom(), 800);
    setTimeout(() => {
      pendingEdit = null;
      syncActiveFromDom();
    }, 2500);
  }

  async function onTip(tip) {
    if (!tip || !chatId) return;
    if (!thread && !pendingEdit) return;
    const t = ensureThread();
    t.serverTip = tip;
    const branch = activeBranch();
    if (branch) {
      branch.tip = { ...tip };
      branch.updatedAt = Date.now();
      if (viewingAlternate || pendingEdit) bridgePost('set-tip-override', { tip });
    }
    if (hasForks(t) || pendingEdit) await saveThread();
    schedulePaint();
  }

  async function selectBranch(forkAt, branchId) {
    const t = thread;
    if (!t) return;
    const fork = t.forks[String(forkAt)];
    if (!fork || !fork.branchIds.includes(branchId)) return;
    const branch = t.branches[branchId];
    if (!branch) return;

    t.activeBranchId = branchId;
    fork.activeIndex = fork.branchIds.indexOf(branchId);

    const liveId = liveBranchId(fork);
    if (branchId === liveId) {
      // Live Gemini path — never cover it with the overlay.
      bridgePost('clear-tip-override', {});
      hideOverlay();
    } else {
      if (branch.tip && branch.tip.responseId) {
        bridgePost('set-tip-override', { tip: branch.tip });
      } else {
        bridgePost('clear-tip-override', {});
      }
      showOverlay(forkAt, branch, fork);
    }

    await saveThread();
    schedulePaint();
  }

  // ---- Controls on the live Gemini user turn ------------------------------

  function ensureControls() {
    if (!enabled || !thread || !hasForks(thread)) {
      document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
      return;
    }
    if (viewingAlternate) {
      document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
      return;
    }

    const t = thread;
    const userNodes = turnNodes().filter((n) => roleOf(n) === 'user');
    const keep = new Set();

    Object.keys(t.forks).forEach((key) => {
      const forkAt = Number(key);
      const fork = t.forks[key];
      if (!fork || !fork.branchIds || fork.branchIds.length < 2) return;
      const host = userNodes[forkAt];
      if (!host) return;

      const total = fork.branchIds.length;
      // On the live Gemini view, always reflect the live (last) index.
      const liveIdx = total - 1;
      if (fork.activeIndex !== liveIdx && !viewingAlternate) {
        // Keep stored index for overlay, but show live controls as N/N.
      }
      const idx = viewingAlternate
        ? Math.max(0, Math.min(fork.activeIndex || 0, total - 1))
        : liveIdx;
      keep.add(key);

      let row =
        host.querySelector(`.bg-timeline-controls[data-fork-at="${key}"]`) ||
        document.querySelector(`.bg-timeline-controls[data-fork-at="${key}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'bg-timeline-controls';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', 'Message versions');
        row.dataset.forkAt = key;
        host.appendChild(row);
      }
      row.dataset.forkAt = key;

      let prev = row.querySelector('.bg-timeline-btn[data-dir="prev"]');
      let label = row.querySelector('.bg-timeline-count');
      let next = row.querySelector('.bg-timeline-btn[data-dir="next"]');

      if (!prev || !label || !next) {
        clearChildren(row);
        prev = document.createElement('button');
        prev.type = 'button';
        prev.className = 'bg-timeline-btn';
        prev.dataset.dir = 'prev';
        prev.setAttribute('aria-label', 'Previous version');
        prev.textContent = '\u2039';

        label = document.createElement('span');
        label.className = 'bg-timeline-count';

        next = document.createElement('button');
        next.type = 'button';
        next.className = 'bg-timeline-btn';
        next.dataset.dir = 'next';
        next.setAttribute('aria-label', 'Next version');
        next.textContent = '\u203A';

        row.appendChild(prev);
        row.appendChild(label);
        row.appendChild(next);
      }

      // Live Gemini view: show "2 / 2" with < enabled and > disabled.
      label.textContent = `${idx + 1} / ${total}`;
      prev.disabled = idx <= 0;
      next.disabled = idx >= total - 1;
    });

    document.querySelectorAll('.bg-timeline-controls').forEach((row) => {
      if (!keep.has(row.dataset.forkAt)) row.remove();
    });
  }

  function onControlsClick(event) {
    const btn = event.target && event.target.closest && event.target.closest('.bg-timeline-btn');
    if (!btn || !enabled || !thread || viewingAlternate) return;
    const row = btn.closest('.bg-timeline-controls');
    if (!row) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    const forkAt = Number(row.dataset.forkAt);
    const fork = thread.forks[String(forkAt)];
    if (!fork || !fork.branchIds || fork.branchIds.length < 2) return;

    // From the live Gemini view, active visual index is always the last.
    const idx = fork.branchIds.length - 1;
    const dir = btn.dataset.dir;
    if (dir === 'prev' && idx > 0) {
      selectBranch(forkAt, fork.branchIds[idx - 1]);
    } else if (dir === 'next' && idx < fork.branchIds.length - 1) {
      selectBranch(forkAt, fork.branchIds[idx + 1]);
    }
  }

  function schedulePaint() {
    if (paintScheduled) return;
    paintScheduled = true;
    requestAnimationFrame(() => {
      paintScheduled = false;
      try {
        ensureControls();
      } catch (err) {
        console.warn('[Better Gemini] timeline UI', err);
      }
    });
  }

  function noteEditModeOpen() {
    if (!enabled || !chatId || viewingAlternate) return;
    refreshLiveBuffer();
    const msgs = liveBuffer.length
      ? liveBuffer.slice()
      : scrapeMessages().map((m) => ({ role: m.role, text: cleanMessageText(m.text) }));
    if (msgs.length) preEditFreeze = msgs;
  }

  // ---- Lifecycle -----------------------------------------------------------

  async function onChatChanged() {
    const next = conversationId();
    if (next === chatId) return;
    chatId = next;
    pendingEdit = null;
    preEditFreeze = null;
    liveBuffer = [];
    // Refresh / chat switch: always show clean Gemini, never an overlay.
    hideOverlay();
    scrubLegacyArtifacts();
    document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
    bridgePost('clear-tip-override', {});
    if (!chatId) {
      thread = null;
      return;
    }
    await loadThread(chatId);
    if (thread && hasForks(thread)) {
      resetForksToLive();
      await saveThread();
      schedulePaint();
    } else {
      thread = null;
    }
    refreshLiveBuffer();
  }

  function watchBridge() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.source !== BRIDGE_SRC) return;
      const { type, payload } = event.data;
      const id = (payload && payload.id) || event.data.id;
      if (id && bridgeWaiters.has(id)) {
        const resolve = bridgeWaiters.get(id);
        bridgeWaiters.delete(id);
        resolve(payload || event.data);
      }
      if (type === 'timelineEdit' && payload) {
        onEditDetected(payload);
        return;
      }
      if (type === 'timelineSend' && payload) {
        onSendDetected(payload);
        return;
      }
      if (type === 'timelineTip' && payload) onTip(payload);
    });
  }

  function watchDom() {
    const obs = new MutationObserver(() => {
      if (!enabled) return;
      schedulePaint();

      const editing = document.querySelector(
        'user-query.edit-mode, user-query[class*="edit-mode"], user-query[editing], .edit-mode'
      );
      if (editing) noteEditModeOpen();

      if (viewingAlternate) return;
      if (bufferTimer) clearTimeout(bufferTimer);
      bufferTimer = setTimeout(() => refreshLiveBuffer(), 400);
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => syncActiveFromDom(), 700);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => onChatChanged(), 800);
    // Keep buffer warm even without mutations.
    setInterval(() => {
      if (enabled && chatId && !viewingAlternate) refreshLiveBuffer();
    }, 2000);
  }

  function loadEnabled() {
    return new Promise((resolve) => {
      if (!extAlive()) {
        enabled = true;
        resolve(enabled);
        return;
      }
      try {
        chrome.storage.sync.get(['showTimelines'], (result) => {
          if (chrome.runtime.lastError) {
            enabled = true;
            resolve(enabled);
            return;
          }
          enabled = !result || result.showTimelines !== false;
          resolve(enabled);
        });
      } catch (_) {
        enabled = true;
        resolve(enabled);
      }
    });
  }

  function watchSettings() {
    if (!extAlive()) return;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.showTimelines) {
          enabled = changes.showTimelines.newValue !== false;
          if (!enabled) {
            hideOverlay();
            scrubLegacyArtifacts();
            document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
            bridgePost('clear-tip-override', {});
            liveBuffer = [];
            preEditFreeze = null;
          } else {
            refreshLiveBuffer();
            schedulePaint();
          }
        }
      });
    } catch (_) { /* extension reloaded */ }
  }

  function watchRefreshSafety() {
    // Always land on clean Gemini after reload / back-forward cache.
    window.addEventListener('pageshow', () => {
      scrubLegacyArtifacts();
      hideOverlay();
      bridgePost('clear-tip-override', {});
      if (thread && hasForks(thread)) {
        resetForksToLive();
        schedulePaint();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scrubLegacyArtifacts();
    });
  }

  async function init() {
    scrubLegacyArtifacts();
    if (extAlive()) {
      try {
        chrome.storage.local.get(['betterGeminiTimelinesVersion'], (result) => {
          if (chrome.runtime.lastError) return;
          if (result.betterGeminiTimelinesVersion !== STORE_VERSION) {
            chrome.storage.local.remove([STORE_KEY], () => {
              chrome.storage.local.set({ betterGeminiTimelinesVersion: STORE_VERSION });
            });
            thread = null;
          }
        });
      } catch (_) { /* ignore */ }
    }

    await loadEnabled();
    document.addEventListener('click', onControlsClick, true);
    // Capture the moment the user opens the pencil (before Update).
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('[data-test-id="edit-button"], button[aria-label*="Edit" i], button[aria-label*="edit" i]')) {
          setTimeout(noteEditModeOpen, 50);
          setTimeout(noteEditModeOpen, 300);
        }
      },
      true
    );
    watchSettings();
    watchBridge();
    watchDom();
    watchRefreshSafety();
    await onChatChanged();
    refreshLiveBuffer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
