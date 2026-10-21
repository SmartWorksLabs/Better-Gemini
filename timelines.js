/* Better Gemini — Claude-style parallel message versions in the same chat.
   No custom chat overlay. Switching versions swaps text inside Gemini's own
   message elements so styling stays Gemini's. Continues use tip override.

   Works on existing chats: live text buffer freezes on edit — no new chat. */
(function () {
  'use strict';

  const BRIDGE_CMD = 'better-gemini-bridge-cmd';
  const BRIDGE_SRC = 'better-gemini-bridge';
  const STORE_KEY = 'betterGeminiTimelines';
  const OVERLAY_ID = 'better-gemini-timeline-overlay';
  const STORE_VERSION = 5;
  const MAX_CHATS = 40;
  const MAX_BRANCHES_PER_CHAT = 24;

  let enabled = true;
  let thread = null;
  let chatId = null;
  let pendingEdit = null;
  let viewingAlternate = false;
  let liveDomBackup = null;
  let paintScheduled = false;
  let syncTimer = null;
  let bufferTimer = null;
  let liveBuffer = [];
  let preEditFreeze = null;
  const bridgeWaiters = new Map();

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

  function turnNodes() {
    return Array.from(document.querySelectorAll('user-query, model-response')).filter(
      (n) => n && n.isConnected && !n.dataset.bgTimelineClone
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

  function contentBox(el, role) {
    if (!el) return null;
    if (role === 'user') {
      return (
        el.querySelector('.query-text') ||
        el.querySelector('[class*="query-text"]') ||
        el.querySelector('.query-content') ||
        null
      );
    }
    return (
      el.querySelector('message-content .markdown') ||
      el.querySelector('.markdown') ||
      el.querySelector('message-content') ||
      el.querySelector('.model-response-text') ||
      null
    );
  }

  function textOf(el) {
    if (!el) return '';
    const role = roleOf(el);
    const box = contentBox(el, role) || el;
    const clone = box.cloneNode(true);
    clone.querySelectorAll(
      '[aria-hidden="true"], .sr-only, .cdk-visually-hidden, .bg-timeline-controls'
    ).forEach((n) => n.remove());
    return cleanMessageText(clone.innerText || clone.textContent || '');
  }

  function setNativeText(el, role, text) {
    const box = contentBox(el, role);
    if (!box) return false;
    // Only replace text inside Gemini's content node — keeps Gemini fonts/CSS.
    box.textContent = cleanMessageText(text);
    return true;
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
      if (source[i].role === 'user') users.push({ text: source[i].text });
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
    document.querySelectorAll('.bg-timeline-clone, .bg-timeline-replay, [data-bg-timeline-clone]').forEach((n) => n.remove());
    document.querySelectorAll('.bg-timeline-hidden, [data-bg-timeline-hide]').forEach((n) => {
      n.classList.remove('bg-timeline-hidden');
      n.style.display = '';
      delete n.dataset.bgTimelineHide;
    });
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
  }

  function restoreLiveView() {
    scrubLegacyArtifacts();
    if (liveDomBackup && liveDomBackup.length) {
      const nodes = turnNodes();
      for (let i = 0; i < Math.min(nodes.length, liveDomBackup.length); i++) {
        setNativeText(nodes[i], liveDomBackup[i].role, liveDomBackup[i].text);
      }
    }
    liveDomBackup = null;
    viewingAlternate = false;
  }

  function applyBranchInChat(forkAt, branch) {
    const msgs = (branch.messages || []).map((m) => ({
      role: m.role,
      text: cleanMessageText(m.text)
    }));
    if (!msgs.length) return;

    let base = turnNodes();
    if (!base.length) return;

    if (!viewingAlternate) {
      liveDomBackup = base.map((n) => ({ role: roleOf(n), text: textOf(n) }));
    }

    scrubLegacyArtifacts();
    base = turnNodes();
    if (liveDomBackup && liveDomBackup.length) {
      for (let i = 0; i < Math.min(base.length, liveDomBackup.length); i++) {
        setNativeText(base[i], liveDomBackup[i].role, liveDomBackup[i].text);
      }
      base = turnNodes();
    }

    const userNodes = base.filter((n) => roleOf(n) === 'user');
    const forkUser = userNodes[Math.min(Math.max(0, forkAt), Math.max(0, userNodes.length - 1))];
    const forkIndex = forkUser ? base.indexOf(forkUser) : 0;

    let userSeen = -1;
    let msgStart = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user') {
        userSeen++;
        if (userSeen === forkAt) {
          msgStart = i;
          break;
        }
      }
    }
    const slice = msgs.slice(msgStart);

    let mi = 0;
    for (let ni = forkIndex; ni < base.length && mi < slice.length; ni++, mi++) {
      setNativeText(base[ni], slice[mi].role || roleOf(base[ni]), slice[mi].text);
    }

    for (let ni = forkIndex + slice.length; ni < base.length; ni++) {
      base[ni].style.display = 'none';
      base[ni].dataset.bgTimelineHide = '1';
    }

    viewingAlternate = true;
  }

  async function syncActiveFromDom() {
    if (!enabled || !chatId || viewingAlternate) return;
    refreshLiveBuffer();
    if (!pendingEdit && (!thread || !hasForks(thread))) return;
    const t = ensureThread();
    const branch = activeBranch();
    if (!branch) return;
    const forkKeys = Object.keys(t.forks);
    let onLive = !forkKeys.length;
    for (const key of forkKeys) {
      if (liveBranchId(t.forks[key]) === branch.id) onLive = true;
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

    restoreLiveView();
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
    if (!fork.branchIds.includes(oldId)) fork.branchIds.push(oldId);
    fork.branchIds = fork.branchIds.filter((id) => id !== newId).concat([newId]);
    fork.activeIndex = fork.branchIds.length - 1;
    t.forks[key] = fork;

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
      bridgePost('clear-tip-override', {});
      restoreLiveView();
    } else {
      if (branch.tip && branch.tip.responseId) {
        bridgePost('set-tip-override', { tip: branch.tip });
      } else {
        bridgePost('clear-tip-override', {});
      }
      applyBranchInChat(forkAt, branch);
    }

    await saveThread();
    schedulePaint();
  }

  function ensureControls() {
    if (!enabled || !thread || !hasForks(thread)) {
      document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
      return;
    }

    const t = thread;
    const userNodes = turnNodes().filter((n) => roleOf(n) === 'user' && n.style.display !== 'none');
    const keep = new Set();

    Object.keys(t.forks).forEach((key) => {
      const forkAt = Number(key);
      const fork = t.forks[key];
      if (!fork || !fork.branchIds || fork.branchIds.length < 2) return;
      const host = userNodes[forkAt] || turnNodes().filter((n) => roleOf(n) === 'user')[forkAt];
      if (!host) return;

      const total = fork.branchIds.length;
      const idx = Math.max(0, Math.min(fork.activeIndex || 0, total - 1));
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
    if (!btn || !enabled || !thread) return;
    const row = btn.closest('.bg-timeline-controls');
    if (!row) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    const forkAt = Number(row.dataset.forkAt);
    const fork = thread.forks[String(forkAt)];
    if (!fork || !fork.branchIds || fork.branchIds.length < 2) return;
    const idx = Math.max(0, Math.min(fork.activeIndex || 0, fork.branchIds.length - 1));
    const dir = btn.dataset.dir;
    if (dir === 'prev' && idx > 0) selectBranch(forkAt, fork.branchIds[idx - 1]);
    else if (dir === 'next' && idx < fork.branchIds.length - 1) {
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

  async function onChatChanged() {
    const next = conversationId();
    if (next === chatId) return;
    chatId = next;
    pendingEdit = null;
    preEditFreeze = null;
    liveBuffer = [];
    liveDomBackup = null;
    viewingAlternate = false;
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
            restoreLiveView();
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
    window.addEventListener('pageshow', () => {
      liveDomBackup = null;
      viewingAlternate = false;
      scrubLegacyArtifacts();
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
