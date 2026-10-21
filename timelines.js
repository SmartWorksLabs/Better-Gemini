/* Better Gemini — Claude-style parallel message versions in the same chat.
   Snapshots abandoned branches locally on edit; switches UI in place; asks the
   page-world bridge to parent the next continue off the selected tip (Option A). */
(function () {
  'use strict';

  const BRIDGE_CMD = 'better-gemini-bridge-cmd';
  const BRIDGE_SRC = 'better-gemini-bridge';
  const STORE_KEY = 'betterGeminiTimelines';
  const MAX_CHATS = 40;
  const MAX_BRANCHES_PER_CHAT = 24;

  let enabled = true;
  let thread = null; // in-memory thread for the open chat
  let chatId = null;
  let pendingEdit = null; // { forkAt, prompt, oldBranchId, snapshot }
  let paintScheduled = false;
  let syncTimer = null;
  let bridgeReqId = 0;
  const bridgeWaiters = new Map();

  function bridgePost(type, extra = {}) {
    window.postMessage({ source: BRIDGE_CMD, type, ...extra }, window.location.origin);
  }

  function bridgeRequest(type, extra = {}) {
    const id = ++bridgeReqId;
    return new Promise((resolve) => {
      bridgeWaiters.set(id, resolve);
      bridgePost(type, { id, ...extra });
      setTimeout(() => {
        if (bridgeWaiters.has(id)) {
          bridgeWaiters.delete(id);
          resolve(null);
        }
      }, 12000);
    });
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function conversationId() {
    const m = location.pathname.match(/\/(?:app|c)\/([0-9a-f]+)/i);
    return m ? `c_${m[1]}` : null;
  }

  function storageGet() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORE_KEY], (result) => {
        resolve((result && result[STORE_KEY]) || {});
      });
    });
  }

  function storageSet(all) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORE_KEY]: all }, resolve);
    });
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
    if (!chatId || !thread) return;
    const all = await storageGet();
    thread.updatedAt = Date.now();
    all[chatId] = thread;
    // Prune oldest chats when over cap.
    const ids = Object.keys(all).sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0));
    while (ids.length > MAX_CHATS) {
      delete all[ids.shift()];
    }
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
    const t = ensureThread();
    return t.branches[t.activeBranchId] || null;
  }

  // ---- DOM turns -----------------------------------------------------------

  function turnNodes() {
    const nodes = Array.from(document.querySelectorAll('user-query, model-response'));
    return nodes.filter((n) => n && n.isConnected && !n.closest('.bg-timeline-replay'));
  }

  function roleOf(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'user-query') return 'user';
    if (tag === 'model-response') return 'model';
    return null;
  }

  function textOf(el) {
    if (!el) return '';
    const preferred =
      el.querySelector('.query-text') ||
      el.querySelector('.markdown') ||
      el.querySelector('[data-message-content]') ||
      el.querySelector('.model-response-text') ||
      el;
    return (preferred.innerText || preferred.textContent || '').replace(/\s+\n/g, '\n').trim();
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

  function userTurnIndexFromPrompt(prompt) {
    if (!prompt) return -1;
    const needle = String(prompt).trim();
    const users = turnNodes().filter((n) => roleOf(n) === 'user');
    for (let i = users.length - 1; i >= 0; i--) {
      const t = textOf(users[i]);
      if (t === needle || t.includes(needle.slice(0, 80)) || needle.includes(t.slice(0, 80))) {
        return i;
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

  // ---- Branch ops ----------------------------------------------------------

  async function syncActiveFromDom() {
    if (!enabled || !chatId) return;
    const t = ensureThread();
    const branch = activeBranch();
    if (!branch) return;
    // Don't clobber a frozen alternate view with live Gemini DOM.
    if (branch.tip && t.serverTip && branch.tip.responseId && t.serverTip.responseId
      && branch.tip.responseId !== t.serverTip.responseId
      && document.querySelector('.bg-timeline-replay')) {
      return;
    }
    const msgs = scrapeMessages();
    if (!msgs.length) return;
    branch.messages = msgs;
    branch.updatedAt = Date.now();
    if (t.serverTip) branch.tip = { ...t.serverTip };
    await saveThread();
    schedulePaint();
  }

  async function onEditDetected(meta) {
    if (!enabled || !chatId) return;
    const t = ensureThread();
    const live = scrapeMessages();
    const sourceMsgs = (activeBranch() && activeBranch().messages && activeBranch().messages.length)
      ? activeBranch().messages.slice()
      : live.slice();

    // forkAt = user-turn ordinal (0 = first user message), matching Claude's control seat.
    let userOrd = userTurnIndexFromPrompt(meta && meta.prompt);
    if (userOrd < 0) {
      const users = sourceMsgs.filter((m) => m.role === 'user');
      userOrd = Math.max(0, users.length - 1);
    }
    const msgIndex = messagesToUserOrdinal(sourceMsgs, userOrd);
    const forkAt = userOrd;

    // Freeze current path as the abandoned branch (keeps old prompt + replies).
    const oldId = t.activeBranchId;
    const oldBranch = t.branches[oldId] || {
      id: oldId,
      parentId: null,
      forkAt: 0,
      tip: t.serverTip,
      messages: sourceMsgs,
      updatedAt: Date.now()
    };
    oldBranch.messages = sourceMsgs.length ? sourceMsgs : oldBranch.messages;
    if (!oldBranch.tip && t.serverTip) oldBranch.tip = { ...t.serverTip };
    t.branches[oldId] = oldBranch;

    const newId = uid('b');
    const prefix = msgIndex >= 0 ? sourceMsgs.slice(0, msgIndex) : sourceMsgs.slice();
    const newPrompt = (meta && meta.prompt) || '';
    t.branches[newId] = {
      id: newId,
      parentId: oldId,
      forkAt,
      tip: null,
      messages: newPrompt
        ? prefix.concat([{ role: 'user', text: newPrompt }])
        : prefix.slice(),
      updatedAt: Date.now()
    };
    t.activeBranchId = newId;

    const key = String(forkAt);
    const fork = t.forks[key] || { branchIds: [], activeIndex: 0 };
    if (!fork.branchIds.includes(oldId)) fork.branchIds.push(oldId);
    if (!fork.branchIds.includes(newId)) fork.branchIds.push(newId);
    fork.activeIndex = fork.branchIds.indexOf(newId);
    t.forks[key] = fork;

    // Cap branches.
    const bIds = Object.keys(t.branches);
    if (bIds.length > MAX_BRANCHES_PER_CHAT) {
      // Drop oldest non-active, non-referenced lightly.
      bIds.sort((a, b) => (t.branches[a].updatedAt || 0) - (t.branches[b].updatedAt || 0));
      while (Object.keys(t.branches).length > MAX_BRANCHES_PER_CHAT) {
        const drop = bIds.shift();
        if (!drop || drop === t.activeBranchId) continue;
        delete t.branches[drop];
      }
    }

    pendingEdit = { forkAt, newId, oldId };
    await saveThread();
    // New path is what Gemini will show — clear any tip override.
    bridgePost('clear-tip-override', {});
    schedulePaint();
  }

  async function onSendDetected(meta) {
    if (!enabled || !chatId) return;
    const t = ensureThread();
    const branch = activeBranch();
    if (!branch) return;
    if (meta && meta.rewritten) {
      // Continue landed on the selected tip — trust upcoming stream tip.
    }
    // After a normal send, Gemini DOM is source of truth once reply finishes.
    setTimeout(() => syncActiveFromDom(), 800);
    setTimeout(() => syncActiveFromDom(), 2500);
    await saveThread();
  }

  async function onTip(tip) {
    if (!tip || !chatId) return;
    const t = ensureThread();
    t.serverTip = tip;
    const branch = activeBranch();
    if (branch) {
      branch.tip = { ...tip };
      branch.updatedAt = Date.now();
      // Keep the override tip advancing with each continue on this version so
      // the next send still parents off this branch (Option A).
      if (document.querySelector('.bg-timeline-replay') || pendingEdit) {
        bridgePost('set-tip-override', { tip });
      }
    }
    await saveThread();
    schedulePaint();
  }

  async function selectBranch(forkAt, branchId) {
    const t = ensureThread();
    const fork = t.forks[String(forkAt)];
    if (!fork || !fork.branchIds.includes(branchId)) return;
    const branch = t.branches[branchId];
    if (!branch) return;

    t.activeBranchId = branchId;
    fork.activeIndex = fork.branchIds.indexOf(branchId);
    await saveThread();

    const serverId = t.serverTip && t.serverTip.responseId;
    const branchTip = branch.tip && branch.tip.responseId;
    if (branchTip && serverId && branchTip === serverId) {
      bridgePost('clear-tip-override', {});
      clearReplay();
    } else if (branch.tip && branch.tip.responseId) {
      bridgePost('set-tip-override', { tip: branch.tip });
      paintReplay(forkAt, branch);
    } else {
      // No tip yet (brand-new branch mid-stream) — show DOM as-is.
      bridgePost('clear-tip-override', {});
      clearReplay();
    }
    schedulePaint();
  }

  // ---- Replay overlay (same chat, alternate version on screen) ------------

  function clearReplay() {
    document.querySelectorAll('.bg-timeline-replay').forEach((n) => n.remove());
    document.querySelectorAll('.bg-timeline-hidden').forEach((n) => {
      n.classList.remove('bg-timeline-hidden');
    });
  }

  function paintReplay(forkAt, branch) {
    clearReplay();
    const nodes = turnNodes();
    const userNodes = nodes.filter((n) => roleOf(n) === 'user');
    if (!userNodes.length) return;
    const forkUser = userNodes[Math.min(Math.max(0, forkAt), userNodes.length - 1)];
    if (!forkUser) return;

    // Hide native turns from the forked user message onward.
    let hiding = false;
    for (const n of nodes) {
      if (n === forkUser) hiding = true;
      if (hiding) n.classList.add('bg-timeline-hidden');
    }

    const msgs = branch.messages || [];
    let userSeen = -1;
    let start = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user') {
        userSeen++;
        if (userSeen === forkAt) {
          start = i;
          break;
        }
      }
    }
    const slice = msgs.slice(start);
    const host = forkUser.parentElement || forkUser;
    let insertAfter = forkUser;

    for (const msg of slice) {
      const el = document.createElement('div');
      el.className = `bg-timeline-replay bg-timeline-${msg.role}`;
      el.setAttribute('data-bg-role', msg.role);
      const label = document.createElement('div');
      label.className = 'bg-timeline-replay-label';
      label.textContent = msg.role === 'user' ? 'You' : 'Gemini';
      const body = document.createElement('div');
      body.className = 'bg-timeline-replay-body';
      body.textContent = msg.text || '';
      el.appendChild(label);
      el.appendChild(body);
      if (insertAfter.parentNode) {
        insertAfter.parentNode.insertBefore(el, insertAfter.nextSibling);
      } else {
        host.appendChild(el);
      }
      insertAfter = el;
    }
  }

  // ---- Version control UI -------------------------------------------------

  function ensureControls() {
    if (!enabled || !thread) {
      document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
      return;
    }
    const t = thread;
    const userNodes = turnNodes().filter((n) => roleOf(n) === 'user');

    Object.keys(t.forks).forEach((key) => {
      const forkAt = Number(key);
      const fork = t.forks[key];
      if (!fork || !fork.branchIds || fork.branchIds.length < 2) return;
      const host = userNodes[forkAt];
      if (!host) return;

      let row = host.querySelector(':scope > .bg-timeline-controls');
      if (!row) {
        // Prefer sitting near Gemini's own action row when present.
        const actions =
          host.querySelector('.actions-container') ||
          host.querySelector('[class*="buttons"]') ||
          host.querySelector('.response-container-footer') ||
          null;
        row = document.createElement('div');
        row.className = 'bg-timeline-controls';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', 'Message versions');
        if (actions && actions.parentElement) actions.parentElement.appendChild(row);
        else host.appendChild(row);
      }

      const total = fork.branchIds.length;
      const idx = Math.max(0, Math.min(fork.activeIndex || 0, total - 1));
      fork.activeIndex = idx;

      row.innerHTML = '';
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'bg-timeline-btn';
      prev.setAttribute('aria-label', 'Previous version');
      prev.textContent = '\u2039';
      prev.disabled = idx <= 0;

      const label = document.createElement('span');
      label.className = 'bg-timeline-count';
      label.textContent = `${idx + 1} / ${total}`;

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'bg-timeline-btn';
      next.setAttribute('aria-label', 'Next version');
      next.textContent = '\u203A';
      next.disabled = idx >= total - 1;

      prev.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (idx <= 0) return;
        selectBranch(forkAt, fork.branchIds[idx - 1]);
      });
      next.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (idx >= total - 1) return;
        selectBranch(forkAt, fork.branchIds[idx + 1]);
      });

      row.appendChild(prev);
      row.appendChild(label);
      row.appendChild(next);
    });
  }

  function schedulePaint() {
    if (paintScheduled) return;
    paintScheduled = true;
    requestAnimationFrame(() => {
      paintScheduled = false;
      try {
        ensureControls();
      } catch (_) { /* ignore */ }
    });
  }

  // ---- Lifecycle -----------------------------------------------------------

  async function onChatChanged() {
    const next = conversationId();
    if (next === chatId) return;
    chatId = next;
    clearReplay();
    pendingEdit = null;
    bridgePost('clear-tip-override', {});
    if (!chatId) {
      thread = null;
      return;
    }
    await loadThread(chatId);
    if (!thread) thread = emptyThread();
    // Re-apply tip override if viewing a non-server branch.
    const branch = activeBranch();
    if (branch && branch.tip && thread.serverTip
      && branch.tip.responseId !== thread.serverTip.responseId) {
      bridgePost('set-tip-override', { tip: branch.tip });
      const forkKeys = Object.keys(thread.forks);
      for (const key of forkKeys) {
        const fork = thread.forks[key];
        if (fork && fork.branchIds[fork.activeIndex] === branch.id) {
          paintReplay(Number(key), branch);
          break;
        }
      }
    }
    schedulePaint();
    syncActiveFromDom();
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
      if (type === 'timelineTip' && payload) {
        onTip(payload);
      }
    });
  }

  function watchDom() {
    const obs = new MutationObserver(() => {
      if (!enabled) return;
      schedulePaint();
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => syncActiveFromDom(), 600);

      // Snapshot while the editor is open so the abandoned path is frozen
      // even if the edit RPC shape changes and we miss the network event.
      const editing = document.querySelector('user-query.edit-mode, user-query[class*="edit"]');
      if (editing && chatId) {
        const t = ensureThread();
        const branch = activeBranch();
        const msgs = scrapeMessages();
        if (branch && msgs.length) {
          branch.messages = msgs;
          if (t.serverTip) branch.tip = { ...t.serverTip };
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    setInterval(() => {
      onChatChanged();
    }, 800);
  }

  function loadEnabled() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['showTimelines'], (result) => {
        enabled = result.showTimelines !== false;
        resolve(enabled);
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.showTimelines) {
      enabled = changes.showTimelines.newValue !== false;
      if (!enabled) {
        clearReplay();
        document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
        bridgePost('clear-tip-override', {});
      } else {
        schedulePaint();
        syncActiveFromDom();
      }
    }
  });

  async function init() {
    await loadEnabled();
    watchBridge();
    watchDom();
    await onChatChanged();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
