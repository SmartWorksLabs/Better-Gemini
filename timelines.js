/* Better Gemini — Claude-style parallel message versions in the same chat.
   Snapshots abandoned branches locally on edit; switches by rewriting text
   inside Gemini's own message elements (no custom bubbles). Continues are
   re-parented onto the selected tip via the page-world bridge (Option A). */
(function () {
  'use strict';

  const BRIDGE_CMD = 'better-gemini-bridge-cmd';
  const BRIDGE_SRC = 'better-gemini-bridge';
  const STORE_KEY = 'betterGeminiTimelines';
  const MAX_CHATS = 40;
  const MAX_BRANCHES_PER_CHAT = 24;

  let enabled = true;
  let thread = null;
  let chatId = null;
  let pendingEdit = null;
  let viewingAlternate = false;
  let liveDomBackup = null; // [{ role, text }] snapshot of native DOM before alternate apply
  let paintScheduled = false;
  let syncTimer = null;
  let bridgeReqId = 0;
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
    if (!chatId || !thread) return;
    // Never persist empty placeholder threads.
    if (!Object.keys(thread.forks || {}).length && Object.keys(thread.branches || {}).length <= 1) {
      const only = thread.branches && thread.branches[thread.activeBranchId];
      if (!only || !only.messages || !only.messages.length) return;
    }
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

  // ---- DOM turns (Gemini native elements only) ----------------------------

  function turnNodes() {
    return Array.from(document.querySelectorAll('user-query, model-response')).filter(
      (n) => n && n.isConnected && !n.classList.contains('bg-timeline-clone')
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
    // Gemini puts screen-reader prefixes in the same text tree.
    t = t.replace(/^(You said|Gemini said|Model said)\s+/i, '');
    // Drop duplicated "You said … / …" lines from bad prior scrapes.
    const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const a = lines[0].replace(/^(You said)\s+/i, '');
      const b = lines[1].replace(/^(You said)\s+/i, '');
      if (a === b) t = a;
    }
    return t.trim();
  }

  function textContainer(el, role) {
    if (!el) return null;
    if (role === 'user') {
      return (
        el.querySelector('.query-text') ||
        el.querySelector('.user-query-bubble-with-background') ||
        el.querySelector('[class*="query-text"]') ||
        el.querySelector('.query-content') ||
        null
      );
    }
    return (
      el.querySelector('message-content') ||
      el.querySelector('.markdown') ||
      el.querySelector('.model-response-text') ||
      el.querySelector('[data-message-content]') ||
      null
    );
  }

  function textOf(el) {
    if (!el) return '';
    const role = roleOf(el);
    const box = textContainer(el, role) || el;
    // Prefer visible text; skip elements marked for assistive tech when possible.
    const clone = box.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], .sr-only, .cdk-visually-hidden').forEach((n) => n.remove());
    return cleanMessageText(clone.innerText || clone.textContent || '');
  }

  function setTurnText(el, role, text) {
    const clean = cleanMessageText(text);
    const box = textContainer(el, role);
    if (!box) return false;
    // Trusted Types: no innerHTML — replace with a plain text node tree.
    clearChildren(box);
    if (role === 'user') {
      box.textContent = clean;
    } else {
      const p = document.createElement('p');
      p.textContent = clean;
      box.appendChild(p);
    }
    return true;
  }

  function scrapeMessages() {
    const out = [];
    for (const el of turnNodes()) {
      if (el.classList.contains('bg-timeline-hidden')) continue;
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
    const needle = cleanMessageText(prompt);
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
    if (!enabled || !chatId || viewingAlternate) return;
    // Only track chats that already have versions, or an edit in flight.
    if (!pendingEdit && (!thread || !hasForks(thread))) return;
    const t = ensureThread();
    const branch = activeBranch();
    if (!branch) return;
    const msgs = scrapeMessages();
    if (!msgs.length) return;
    branch.messages = msgs.map((m) => ({ role: m.role, text: cleanMessageText(m.text) }));
    branch.updatedAt = Date.now();
    if (t.serverTip) branch.tip = { ...t.serverTip };
    if (hasForks(t) || pendingEdit) await saveThread();
    schedulePaint();
  }

  async function onEditDetected(meta) {
    if (!enabled || !chatId) return;
    // Require a real edit action from the bridge.
    if (!meta || !meta.isEdit) return;

    const t = ensureThread();
    const live = scrapeMessages().map((m) => ({ role: m.role, text: cleanMessageText(m.text) }));
    const sourceMsgs = (activeBranch() && activeBranch().messages && activeBranch().messages.length)
      ? activeBranch().messages.map((m) => ({ role: m.role, text: cleanMessageText(m.text) }))
      : live.slice();

    let userOrd = userTurnIndexFromPrompt(meta.prompt);
    if (userOrd < 0) {
      const users = sourceMsgs.filter((m) => m.role === 'user');
      userOrd = Math.max(0, users.length - 1);
    }
    const msgIndex = messagesToUserOrdinal(sourceMsgs, userOrd);
    const forkAt = userOrd;

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
    if (!fork.branchIds.includes(newId)) fork.branchIds.push(newId);
    fork.activeIndex = fork.branchIds.indexOf(newId);
    t.forks[key] = fork;

    const bIds = Object.keys(t.branches);
    if (bIds.length > MAX_BRANCHES_PER_CHAT) {
      bIds.sort((a, b) => (t.branches[a].updatedAt || 0) - (t.branches[b].updatedAt || 0));
      while (Object.keys(t.branches).length > MAX_BRANCHES_PER_CHAT) {
        const drop = bIds.shift();
        if (!drop || drop === t.activeBranchId) continue;
        delete t.branches[drop];
      }
    }

    pendingEdit = { forkAt, newId, oldId };
    viewingAlternate = false;
    liveDomBackup = null;
    restoreNativeDom();
    await saveThread();
    bridgePost('clear-tip-override', {});
    schedulePaint();
  }

  async function onSendDetected(meta) {
    if (!enabled || !chatId || !thread) return;
    if (!hasForks(thread) && !pendingEdit) return;
    setTimeout(() => syncActiveFromDom(), 800);
    setTimeout(() => {
      pendingEdit = null;
      syncActiveFromDom();
    }, 2500);
    await saveThread();
  }

  async function onTip(tip) {
    if (!tip || !chatId || !thread) return;
    thread.serverTip = tip;
    const branch = activeBranch();
    if (branch) {
      branch.tip = { ...tip };
      branch.updatedAt = Date.now();
      if (viewingAlternate || pendingEdit) {
        bridgePost('set-tip-override', { tip });
      }
    }
    if (hasForks(thread) || pendingEdit) await saveThread();
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

    const serverId = t.serverTip && t.serverTip.responseId;
    const branchTip = branch.tip && branch.tip.responseId;
    const isLiveServerPath = Boolean(branchTip && serverId && branchTip === serverId);

    if (isLiveServerPath) {
      viewingAlternate = false;
      bridgePost('clear-tip-override', {});
      restoreNativeDom();
    } else {
      if (branchTip) bridgePost('set-tip-override', { tip: branch.tip });
      else bridgePost('clear-tip-override', {});
      applyBranchInPlace(forkAt, branch);
    }

    await saveThread();
    schedulePaint();
  }

  // ---- In-place apply using Gemini's own message elements -----------------

  function restoreNativeDom() {
    document.querySelectorAll('.bg-timeline-clone').forEach((n) => n.remove());
    document.querySelectorAll('.bg-timeline-hidden').forEach((n) => {
      n.classList.remove('bg-timeline-hidden');
    });
    // Remove any leftover custom replay nodes from older builds.
    document.querySelectorAll('.bg-timeline-replay').forEach((n) => n.remove());

    if (liveDomBackup && liveDomBackup.length) {
      const nodes = turnNodes();
      for (let i = 0; i < Math.min(nodes.length, liveDomBackup.length); i++) {
        setTurnText(nodes[i], liveDomBackup[i].role, liveDomBackup[i].text);
      }
    }
    liveDomBackup = null;
    viewingAlternate = false;
  }

  function applyBranchInPlace(forkAt, branch) {
    const nodes = turnNodes();
    const userNodes = nodes.filter((n) => roleOf(n) === 'user');
    if (!userNodes.length) return;
    const forkUser = userNodes[Math.min(Math.max(0, forkAt), userNodes.length - 1)];
    if (!forkUser) return;

    // Backup whatever Gemini is showing now (the live path) once.
    if (!viewingAlternate) {
      liveDomBackup = scrapeMessages();
    }
    viewingAlternate = true;

    // Drop prior clones; unhide everything before re-applying.
    document.querySelectorAll('.bg-timeline-clone').forEach((n) => n.remove());
    document.querySelectorAll('.bg-timeline-hidden').forEach((n) => {
      n.classList.remove('bg-timeline-hidden');
    });
    document.querySelectorAll('.bg-timeline-replay').forEach((n) => n.remove());

    const msgs = (branch.messages || []).map((m) => ({
      role: m.role,
      text: cleanMessageText(m.text)
    }));
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

    // Map fork user → index in full native list.
    const forkIndex = nodes.indexOf(forkUser);
    if (forkIndex < 0) return;

    // Hide native turns from the fork onward (live path underneath).
    for (let i = forkIndex; i < nodes.length; i++) {
      nodes[i].classList.add('bg-timeline-hidden');
    }

    // Clone Gemini's own elements so styling stays native.
    const userTemplate = userNodes[0];
    const modelTemplate = nodes.find((n) => roleOf(n) === 'model') || null;
    const parent = forkUser.parentNode;
    if (!parent) return;

    // Insert clones before the hidden live fork user (order preserved).
    const anchor = forkUser;
    for (let i = 0; i < slice.length; i++) {
      const msg = slice[i];
      const template = msg.role === 'user' ? userTemplate : modelTemplate;
      if (!template) continue;
      const clone = template.cloneNode(true);
      clone.classList.add('bg-timeline-clone');
      clone.classList.remove('bg-timeline-hidden');
      clone.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
      setTurnText(clone, msg.role, msg.text);
      parent.insertBefore(clone, anchor);
    }
  }

  // ---- Version control UI (only the < n / m > chrome) ---------------------

  function ensureControls() {
    if (!enabled || !thread || !hasForks(thread)) {
      document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
      return;
    }
    const t = thread;
    const userNodes = turnNodes().filter((n) => roleOf(n) === 'user' && !n.classList.contains('bg-timeline-hidden'));
    // Prefer visible user turns; fall back to all (including hidden live ones).
    const hosts = userNodes.length
      ? userNodes
      : turnNodes().filter((n) => roleOf(n) === 'user');
    const keep = new Set();

    Object.keys(t.forks).forEach((key) => {
      const forkAt = Number(key);
      const fork = t.forks[key];
      if (!fork || !fork.branchIds || fork.branchIds.length < 2) return;

      // Attach controls to the visible clone of that user turn when alternate,
      // otherwise the native user turn.
      let host = null;
      const clones = Array.from(document.querySelectorAll('user-query.bg-timeline-clone'));
      if (viewingAlternate && clones.length) {
        host = clones[0];
      } else {
        host = hosts[forkAt] || turnNodes().filter((n) => roleOf(n) === 'user')[forkAt];
      }
      if (!host) return;

      const total = fork.branchIds.length;
      const idx = Math.max(0, Math.min(fork.activeIndex || 0, total - 1));
      fork.activeIndex = idx;
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

  // ---- Lifecycle -----------------------------------------------------------

  async function onChatChanged() {
    const next = conversationId();
    if (next === chatId) return;
    chatId = next;
    viewingAlternate = false;
    liveDomBackup = null;
    pendingEdit = null;
    restoreNativeDom();
    bridgePost('clear-tip-override', {});
    document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
    if (!chatId) {
      thread = null;
      return;
    }
    await loadThread(chatId);
    // Do not invent empty threads for chats that were never edited.
    if (thread && hasForks(thread)) {
      schedulePaint();
    } else {
      thread = null;
    }
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
      if (viewingAlternate) return;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => syncActiveFromDom(), 600);

      const editing = document.querySelector('user-query.edit-mode, user-query[class*="edit"]');
      if (editing && chatId) {
        const t = thread || ensureThread();
        const branch = activeBranch();
        const msgs = scrapeMessages();
        if (branch && msgs.length) {
          branch.messages = msgs.map((m) => ({ role: m.role, text: cleanMessageText(m.text) }));
          if (t.serverTip) branch.tip = { ...t.serverTip };
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(() => {
      onChatChanged();
    }, 800);
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
            restoreNativeDom();
            document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
            bridgePost('clear-tip-override', {});
          } else {
            schedulePaint();
          }
        }
      });
    } catch (_) { /* extension reloaded */ }
  }

  async function init() {
    // Wipe older timeline data that used custom bubbles / "You said" scrapes.
    if (extAlive()) {
      try {
        chrome.storage.local.get(['betterGeminiTimelinesVersion'], (result) => {
          if (chrome.runtime.lastError) return;
          if (result.betterGeminiTimelinesVersion !== 2) {
            chrome.storage.local.remove([STORE_KEY], () => {
              chrome.storage.local.set({ betterGeminiTimelinesVersion: 2 });
            });
            thread = null;
          }
        });
      } catch (_) { /* ignore */ }
    }

    await loadEnabled();
    document.addEventListener('click', onControlsClick, true);
    watchSettings();
    watchBridge();
    watchDom();
    // Clean any leftover custom nodes from the previous build immediately.
    restoreNativeDom();
    await onChatChanged();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
