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
  const STORE_VERSION = 8;
  const MAX_CHATS = 40;
  const MAX_BRANCHES_PER_CHAT = 48;

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
  /** Last complete user+model transcript before edit UI rewrote the DOM. */
  let lastGoodTranscript = [];
  /** Branch currently generating a reply (null when idle). */
  let streamingBranchId = null;
  let paintGuard = false;
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

  function persistableThread(src) {
    // chrome.storage cannot hold DOM nodes — keep html/text only on disk.
    const out = {
      updatedAt: src.updatedAt || Date.now(),
      activeBranchId: src.activeBranchId,
      ownerBranchId: src.ownerBranchId || src.geminiTipBranchId || src.activeBranchId,
      geminiTipBranchId: src.geminiTipBranchId || src.ownerBranchId || src.activeBranchId,
      serverTip: src.serverTip ? { ...src.serverTip } : null,
      forks: src.forks ? JSON.parse(JSON.stringify(src.forks)) : {},
      branches: {}
    };
    Object.keys(src.branches || {}).forEach((id) => {
      const b = src.branches[id];
      if (!b) return;
      out.branches[id] = {
        id: b.id,
        parentId: b.parentId || null,
        forkAt: b.forkAt || 0,
        tip: b.tip ? { ...b.tip } : null,
        messages: (b.messages || []).map((m) => ({
          role: m.role,
          text: typeof m.text === 'string' ? m.text : '',
          html: typeof m.html === 'string' ? m.html : ''
        })),
        updatedAt: b.updatedAt || Date.now()
      };
    });
    return out;
  }

  async function saveThread() {
    if (!chatId || !thread || !hasForks(thread)) return;
    const all = await storageGet();
    thread.updatedAt = Date.now();
    all[chatId] = persistableThread(thread);
    const ids = Object.keys(all).sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0));
    while (ids.length > MAX_CHATS) delete all[ids.shift()];
    await storageSet(all);
  }

  function emptyThread() {
    const branchId = uid('b');
    return {
      updatedAt: Date.now(),
      activeBranchId: branchId,
      /** Branch whose content the live Gemini DOM currently represents. */
      ownerBranchId: branchId,
      geminiTipBranchId: branchId,
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

  function ownerIdOf(t) {
    if (!t) return null;
    return t.ownerBranchId || t.geminiTipBranchId || t.activeBranchId || null;
  }

  function setBranchMessages(branch, msgs) {
    if (!branch) return;
    // Always deep-copy — branches must never share message arrays.
    branch.messages = snapshotMessages(msgs || []);
    branch.updatedAt = Date.now();
  }

  function isGenerating() {
    // Keep this narrow — broad "Stop" / aria-busy matches match Gemini chrome and
    // can leave suppress-gen stuck or thrash the version controls.
    return Boolean(
      document.querySelector(
        [
          'button[aria-label*="Stop generating" i]',
          'button[aria-label="Stop" i]',
          '[data-test-id="stop-button"]',
          'button.stop-generating-button'
        ].join(', ')
      )
    );
  }

  function setGeneratingUiSuppressed(suppressed) {
    document.documentElement.classList.toggle('bg-timeline-suppress-gen', Boolean(suppressed));
  }

  /** Point every fork that listed `fromId` at `toId` instead (nested history stays linked). */
  function remapBranchId(fromId, toId) {
    if (!thread || !fromId || !toId || fromId === toId) return;
    Object.keys(thread.forks || {}).forEach((key) => {
      const fork = thread.forks[key];
      if (!fork || !fork.branchIds) return;
      fork.branchIds = fork.branchIds.map((id) => (id === fromId ? toId : id));
      const seen = new Set();
      fork.branchIds = fork.branchIds.filter((id) => {
        if (!id || !thread.branches[id] || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    });
  }

  /** When a path is selected, mark that id active on every fork that contains it. */
  function alignForksToBranch(branchId) {
    if (!thread || !branchId) return;
    Object.keys(thread.forks || {}).forEach((key) => {
      const fork = thread.forks[key];
      if (!fork || !fork.branchIds) return;
      const idx = fork.branchIds.indexOf(branchId);
      if (idx >= 0) fork.activeIndex = idx;
    });
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
      if (liveId) {
        thread.activeBranchId = liveId;
        thread.ownerBranchId = liveId;
        thread.geminiTipBranchId = liveId;
      }
    });
  }

  function turnNodes(opts = {}) {
    const includeClones = Boolean(opts.includeClones);
    return Array.from(document.querySelectorAll('user-query, model-response')).filter((n) => {
      if (!n || !n.isConnected) return false;
      if (!includeClones && n.dataset.bgTimelineClone) return false;
      return true;
    });
  }

  function countUserTurns(messages) {
    return (messages || []).filter((m) => m && m.role === 'user').length;
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
    // Prefer the richest reply shell that still includes Gemini table/code chrome
    // (scroll wrappers, table-block, etc.). Nested .markdown alone loses that.
    const candidates = [
      el.querySelector('.model-response-text'),
      el.querySelector('message-content'),
      el.querySelector('.markdown-main-panel'),
      el.querySelector('[class*="response-content"]'),
      el.querySelector('.markdown')
    ].filter(Boolean);
    if (!candidates.length) return null;
    const rich = candidates.find((c) =>
      c.querySelector(
        'table, .table-block, [class*="table-block"], [class*="horizontal-scroll"], ' +
          'pre, code-block, .code-block, [class*="code-block"], math, .math-block'
      )
    );
    // Prefer the outermost candidate that still contains the rich node.
    if (rich) {
      let best = rich;
      for (const c of candidates) {
        if (c !== rich && c.contains(rich)) best = c;
      }
      return best;
    }
    return candidates[0];
  }

  function stripTimelineBits(root) {
    if (!root || !root.querySelectorAll) return root;
    root.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
    return root;
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

  /** Snapshot Gemini's content root as OUTER html so wrappers/classes stay intact. */
  function htmlOf(el) {
    if (!el) return '';
    const role = roleOf(el);
    const box = contentBox(el, role);
    if (!box) return '';
    const clone = stripTimelineBits(box.cloneNode(true));
    try {
      return clone.outerHTML || '';
    } catch (_) {
      try {
        return clone.innerHTML || '';
      } catch (__) {
        return '';
      }
    }
  }

  function cloneContentNode(el, role) {
    const box = contentBox(el, role);
    if (!box) return null;
    return stripTimelineBits(box.cloneNode(true));
  }

  function parseGeminiHtml(html) {
    if (!html) return null;
    try {
      const trimmed = String(html).trim();
      // Outer snapshot of a single root element (message-content, etc.).
      if (trimmed.startsWith('<')) {
        const parsed = new DOMParser().parseFromString(trimmed, 'text/html');
        if (parsed.body && parsed.body.firstElementChild) {
          return stripTimelineBits(parsed.body.firstElementChild);
        }
      }
      // Legacy innerHTML snapshots from older versions.
      const wrapped = new DOMParser().parseFromString(
        `<div data-bg-root="1">${html}</div>`,
        'text/html'
      );
      const root = wrapped.querySelector('[data-bg-root]');
      return root || null;
    } catch (_) {
      return null;
    }
  }

  /** Restore Gemini markup by replacing the content root — keeps native wrappers. */
  function fillBoxFromHtml(box, html) {
    if (!box || !html) return false;
    try {
      const incoming = parseGeminiHtml(html);
      if (!incoming) return false;
      const parent = box.parentNode;
      if (!parent) return false;

      // Same tag → replace the whole root (preserves Gemini classes on the host).
      if (incoming.dataset && incoming.dataset.bgRoot === '1') {
        while (box.firstChild) box.removeChild(box.firstChild);
        Array.from(incoming.childNodes).forEach((n) => {
          box.appendChild(document.importNode(n, true));
        });
        return true;
      }

      if (incoming.tagName && box.tagName && incoming.tagName === box.tagName) {
        const node =
          incoming.ownerDocument === document
            ? incoming.cloneNode(true)
            : document.importNode(incoming, true);
        parent.replaceChild(node, box);
        return true;
      }

      // Tag mismatch (legacy inner snapshot): fill children only.
      while (box.firstChild) box.removeChild(box.firstChild);
      if (incoming.dataset && incoming.dataset.bgRoot === '1') {
        Array.from(incoming.childNodes).forEach((n) => {
          box.appendChild(document.importNode(n, true));
        });
      } else {
        box.appendChild(
          incoming.ownerDocument === document
            ? incoming.cloneNode(true)
            : document.importNode(incoming, true)
        );
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function setNativeContent(el, role, payload) {
    if (!el || !payload) return false;
    const box = contentBox(el, role);
    if (!box) return false;

    // In-memory DOM clone is the highest fidelity (no HTML round-trip).
    if (payload.node && payload.node.nodeType === 1) {
      const parent = box.parentNode;
      if (parent) {
        const node = stripTimelineBits(payload.node.cloneNode(true));
        parent.replaceChild(node, box);
        return true;
      }
    }

    if (payload.html && fillBoxFromHtml(box, payload.html)) return true;

    // Never textContent-wipe rich model replies — that destroys tables/code.
    if (role === 'model') return false;
    if (typeof payload.text === 'string') {
      box.textContent = payload.text;
      return true;
    }
    return false;
  }

  function scrapeMessages() {
    const out = [];
    for (const el of turnNodes()) {
      const role = roleOf(el);
      if (!role) continue;
      const text = textOf(el);
      const html = htmlOf(el);
      const node = cloneContentNode(el, role);
      if (!text && !html && role === 'model') continue;
      out.push({ role, text, html, node });
    }
    return out;
  }

  function snapshotMessages(list) {
    // Keep an in-memory DOM clone when present (not written to chrome.storage).
    return (list || []).map((m) => {
      const snap = {
        role: m.role,
        text: typeof m.text === 'string' ? m.text : '',
        html: typeof m.html === 'string' ? m.html : ''
      };
      if (m.node && m.node.nodeType === 1) {
        try {
          snap.node = stripTimelineBits(m.node.cloneNode(true));
        } catch (_) {
          /* ignore */
        }
      }
      return snap;
    });
  }

  function isEditModeOpen() {
    return Boolean(
      document.querySelector(
        'user-query.edit-mode, user-query[class*="edit-mode"], user-query[editing], ' +
          '.query-content.edit-mode, .query-text.edit-mode, [class*="edit-mode"] textarea'
      )
    );
  }

  function transcriptScore(msgs) {
    const list = msgs || [];
    let score = list.length * 10;
    for (const m of list) {
      if (m && m.role === 'model' && (m.text || m.html)) score += 100;
      if (m && m.role === 'user' && (m.text || m.html)) score += 5;
    }
    return score;
  }

  function pickRicherTranscript(a, b) {
    return transcriptScore(b) > transcriptScore(a) ? snapshotMessages(b) : snapshotMessages(a || []);
  }

  function refreshLiveBuffer() {
    if (!enabled || !chatId || viewingAlternate || isEditModeOpen()) return;
    const msgs = scrapeMessages();
    if (!msgs.length) return;
    liveBuffer = snapshotMessages(msgs);
    // Keep a stable pre-edit snapshot so forks don't freeze an already-rewritten DOM.
    if (transcriptScore(msgs) >= transcriptScore(lastGoodTranscript)) {
      lastGoodTranscript = snapshotMessages(msgs);
    }
  }

  function bestFreezeMessages() {
    // Never scrape mid-edit — Gemini has often already replaced the bubble by then.
    let best = [];
    if (preEditFreeze && preEditFreeze.length) best = pickRicherTranscript(best, preEditFreeze);
    if (lastGoodTranscript && lastGoodTranscript.length) {
      best = pickRicherTranscript(best, lastGoodTranscript);
    }
    if (liveBuffer && liveBuffer.length && !isEditModeOpen()) {
      best = pickRicherTranscript(best, liveBuffer);
    }
    const ab = activeBranch();
    if (ab && ab.messages && ab.messages.length) best = pickRicherTranscript(best, ab.messages);
    if (best.length) return best;
    if (!isEditModeOpen()) return snapshotMessages(scrapeMessages());
    return [];
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
    document.querySelectorAll('[data-bg-timeline-clone]').forEach((n) => n.remove());
    document.querySelectorAll('[data-bg-timeline-hide], .bg-timeline-hidden').forEach((n) => {
      n.classList.remove('bg-timeline-hidden');
      n.style.display = '';
      delete n.dataset.bgTimelineHide;
    });
    if (liveDomBackup && liveDomBackup.length) {
      const nodes = turnNodes({ includeClones: false });
      for (let i = 0; i < Math.min(nodes.length, liveDomBackup.length); i++) {
        setNativeContent(nodes[i], liveDomBackup[i].role, liveDomBackup[i]);
      }
      for (let i = liveDomBackup.length; i < nodes.length; i++) {
        nodes[i].style.display = 'none';
        nodes[i].dataset.bgTimelineHide = '1';
      }
    }
    liveDomBackup = null;
    viewingAlternate = false;
  }

  /** Grow the chat DOM so a saved branch with more turns can be shown in Gemini shells. */
  function ensureSlotsForMessages(msgs) {
    document.querySelectorAll('[data-bg-timeline-hide]').forEach((n) => {
      n.style.display = '';
      delete n.dataset.bgTimelineHide;
    });

    let nodes = turnNodes({ includeClones: true });
    if (!msgs.length) return nodes;

    const userTpl = nodes.find((n) => roleOf(n) === 'user');
    const modelTpl = nodes.find((n) => roleOf(n) === 'model') || userTpl;
    if (!userTpl) return nodes;
    const parent = userTpl.parentNode;
    if (!parent) return nodes;

    while (nodes.length < msgs.length) {
      const role = msgs[nodes.length].role === 'model' ? 'model' : 'user';
      const tpl = role === 'model' ? modelTpl : userTpl;
      if (!tpl) break;
      const clone = tpl.cloneNode(true);
      clone.dataset.bgTimelineClone = '1';
      clone.style.display = '';
      clone.classList.remove('bg-timeline-hidden');
      clone.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
      const box = contentBox(clone, role);
      if (box) while (box.firstChild) box.removeChild(box.firstChild);
      parent.appendChild(clone);
      nodes = turnNodes({ includeClones: true });
    }

    return turnNodes({ includeClones: true });
  }

  /** Paint a branch's stored messages into Gemini shells. Never shares arrays across branches. */
  function paintBranchMessages(branch) {
    const msgs = snapshotMessages(branch && branch.messages ? branch.messages : []);
    if (!msgs.length) {
      console.warn('[Better Gemini] version has no saved messages; cannot restore');
      return false;
    }

    paintGuard = true;
    try {
      document.querySelectorAll('[data-bg-timeline-clone]').forEach((n) => n.remove());
      document.querySelectorAll('[data-bg-timeline-hide], .bg-timeline-hidden').forEach((n) => {
        n.classList.remove('bg-timeline-hidden');
        n.style.display = '';
        delete n.dataset.bgTimelineHide;
      });

      const nodes = ensureSlotsForMessages(msgs);
      for (let i = 0; i < msgs.length && i < nodes.length; i++) {
        nodes[i].style.display = '';
        delete nodes[i].dataset.bgTimelineHide;
        nodes[i].classList.remove('bg-timeline-hidden');
        setNativeContent(nodes[i], msgs[i].role || roleOf(nodes[i]), msgs[i]);
      }
      for (let i = msgs.length; i < nodes.length; i++) {
        nodes[i].style.display = 'none';
        nodes[i].dataset.bgTimelineHide = '1';
      }
      clearMessageFocusChrome();
      return true;
    } finally {
      // Allow the next tick to observe again after our own DOM writes settle.
      setTimeout(() => {
        paintGuard = false;
      }, 50);
    }
  }

  function applyBranchInChat(forkAt, branch) {
    const ok = paintBranchMessages(branch);
    if (ok) viewingAlternate = true;
    void forkAt;
    return ok;
  }

  /** Write the on-screen transcript into one branch only (deep copy). */
  function captureDomIntoBranch(branchId) {
    const t = thread;
    if (!t || !branchId || !t.branches[branchId]) return false;
    const msgs = scrapeMessages();
    if (!msgs.length) return false;
    setBranchMessages(t.branches[branchId], msgs);
    if (t.serverTip && (branchId === streamingBranchId || branchId === ownerIdOf(t))) {
      t.branches[branchId].tip = { ...t.serverTip };
    }
    return true;
  }

  /** Before leaving a branch, freeze its content so siblings never inherit it. */
  function commitActiveBranch() {
    const t = thread;
    if (!t || !t.activeBranchId) return;
    const activeId = t.activeBranchId;
    const ownerId = ownerIdOf(t);
    // Only scrape into the branch that currently owns the live DOM.
    // Viewing another version means the DOM may be a mix — trust that branch's store.
    if (activeId === ownerId) {
      captureDomIntoBranch(activeId);
      liveBuffer = snapshotMessages(t.branches[activeId].messages || []);
      if (transcriptScore(liveBuffer) >= transcriptScore(lastGoodTranscript)) {
        lastGoodTranscript = snapshotMessages(liveBuffer);
      }
    }
  }

  /**
   * Keep branches isolated:
   * - DOM scrapes ONLY update the owner branch, and ONLY while that branch is on screen
   *   (otherwise the DOM is a painted alternate and must not overwrite the owner).
   * - While viewing another version during generation, re-paint that version and hide
   *   stop/generating chrome so streams never visually merge.
   */
  async function syncBranchesFromDom() {
    if (!enabled || !chatId || isEditModeOpen() || paintGuard) return;
    const t = ensureThread();
    if (!t.ownerBranchId && t.geminiTipBranchId) t.ownerBranchId = t.geminiTipBranchId;

    const activeId = t.activeBranchId;
    const ownerId = ownerIdOf(t);
    if (!activeId || !ownerId || !t.branches[ownerId]) return;

    const generating = isGenerating();
    if (!generating && streamingBranchId) {
      // Stream finished. If that branch is on screen, capture the final DOM into it.
      if (activeId === streamingBranchId || activeId === ownerId) {
        captureDomIntoBranch(streamingBranchId || ownerId);
      }
      streamingBranchId = null;
    }

    if (activeId === ownerId) {
      viewingAlternate = false;
      setGeneratingUiSuppressed(false);
      const msgs = scrapeMessages();
      if (msgs.length) {
        setBranchMessages(t.branches[ownerId], msgs);
        liveBuffer = snapshotMessages(msgs);
        if (transcriptScore(msgs) >= transcriptScore(lastGoodTranscript)) {
          lastGoodTranscript = snapshotMessages(msgs);
        }
      }
    } else {
      viewingAlternate = true;
      // Never scrape into the viewed branch or the owner while painted over —
      // that is what caused versions to merge. Just keep the viewed transcript
      // on screen and hide generating UI that belongs to the other version.
      const viewed = t.branches[activeId];
      if (viewed && viewed.messages && viewed.messages.length) {
        if (generating || streamingBranchId) {
          paintBranchMessages(viewed);
          setGeneratingUiSuppressed(true);
        } else {
          setGeneratingUiSuppressed(false);
        }
      } else {
        setGeneratingUiSuppressed(generating || Boolean(streamingBranchId));
      }
    }

    if (hasForks(t) || pendingEdit) await saveThread();
    schedulePaint();
  }

  async function syncActiveFromDom() {
    return syncBranchesFromDom();
  }

  async function onEditDetected(meta) {
    if (!enabled || !chatId) return;
    if (!meta || !meta.isEdit) return;

    const t = ensureThread();
    // Freeze BEFORE restoring live DOM — and never trust the post-edit scrape.
    let freeze = bestFreezeMessages();
    if (viewingAlternate) {
      const shown = activeBranch();
      if (shown && shown.messages && shown.messages.length) {
        freeze = pickRicherTranscript(freeze, shown.messages);
      }
    }
    // Keep whatever we froze as last-good even if Gemini already mutated the page.
    if (freeze.length) lastGoodTranscript = snapshotMessages(freeze);
    preEditFreeze = null;
    restoreLiveView();

    if (!freeze.length) {
      console.warn('[Better Gemini] edit detected but no transcript to branch from');
      return;
    }

    let userOrd = userTurnIndexFromPrompt(meta.prompt, freeze);
    if (userOrd < 0) {
      const users = freeze.filter((m) => m.role === 'user');
      userOrd = Math.max(0, users.length - 1);
    }
    const msgIndex = messagesToUserOrdinal(freeze, userOrd);
    const forkAt = userOrd;

    // Snapshot the path being left into a dedicated id so siblings are never overwritten.
    const parentId = t.activeBranchId;
    const abandonedId = uid('b');
    t.branches[abandonedId] = {
      id: abandonedId,
      parentId: parentId,
      forkAt,
      tip: t.serverTip ? { ...t.serverTip } : null,
      messages: snapshotMessages(freeze),
      updatedAt: Date.now()
    };
    // Also keep the parent tip populated so nested remaps still have content.
    if (t.branches[parentId]) {
      setBranchMessages(
        t.branches[parentId],
        pickRicherTranscript(t.branches[parentId].messages || [], freeze)
      );
    }

    // Point every fork that referenced the tip we left at this frozen snapshot instead.
    // That keeps nested ‹n/m› controls wired to the same path when you switch back.
    remapBranchId(parentId, abandonedId);

    const newId = uid('b');
    const prefix = snapshotMessages(msgIndex >= 0 ? freeze.slice(0, msgIndex) : freeze.slice());
    const newPrompt = cleanMessageText(meta.prompt || '');
    t.branches[newId] = {
      id: newId,
      parentId: abandonedId,
      forkAt,
      tip: null,
      messages: newPrompt
        ? prefix.concat([{ role: 'user', text: newPrompt, html: '' }])
        : prefix.slice(),
      updatedAt: Date.now()
    };
    t.activeBranchId = newId;
    t.ownerBranchId = newId;
    t.geminiTipBranchId = newId;
    streamingBranchId = newId;
    viewingAlternate = false;
    setGeneratingUiSuppressed(false);

    const key = String(forkAt);
    const fork = t.forks[key] || { branchIds: [], activeIndex: 0 };
    // Keep every surviving sibling; ensure abandoned + new are present (no duplicates).
    const kept = (fork.branchIds || []).filter(
      (id) => id && t.branches[id] && id !== newId && id !== abandonedId
    );
    if (!kept.includes(abandonedId)) kept.push(abandonedId);
    kept.push(newId);
    fork.branchIds = kept;
    fork.activeIndex = fork.branchIds.length - 1;
    t.forks[key] = fork;

    // Never delete downstream forks — nested versions stay until the chat is cleared.
    Object.keys(t.forks).forEach((fk) => {
      const f = t.forks[fk];
      if (!f || !f.branchIds) return;
      f.branchIds = f.branchIds.filter((id) => id && t.branches[id]);
    });

    alignForksToBranch(newId);
    pendingEdit = { forkAt, newId, oldId: abandonedId };
    await saveThread();
    bridgePost('clear-tip-override', {});
    schedulePaint();
  }

  async function onSendDetected() {
    if (!enabled || !chatId) return;
    const t = ensureThread();
    // The branch the user is viewing owns this send — never merge into siblings.
    const sendId = t.activeBranchId;
    if (sendId && t.branches[sendId]) {
      commitActiveBranch();
      t.ownerBranchId = sendId;
      t.geminiTipBranchId = sendId;
      streamingBranchId = sendId;
      viewingAlternate = false;
      setGeneratingUiSuppressed(false);
      if (t.branches[sendId].tip && t.branches[sendId].tip.responseId) {
        bridgePost('set-tip-override', { tip: t.branches[sendId].tip });
      }
    }
    setTimeout(() => syncBranchesFromDom(), 400);
    setTimeout(() => syncBranchesFromDom(), 1200);
    setTimeout(() => {
      pendingEdit = null;
      syncBranchesFromDom();
    }, 2800);
  }

  async function onTip(tip) {
    if (!tip || !chatId) return;
    if (!thread && !pendingEdit) return;
    const t = ensureThread();
    t.serverTip = tip;
    // Attribute the new tip to the streaming/owner branch — not whatever is on screen.
    const targetId = streamingBranchId || ownerIdOf(t) || t.activeBranchId;
    const target = targetId ? t.branches[targetId] : null;
    if (target) {
      target.tip = { ...tip };
      target.updatedAt = Date.now();
    }
    // Continues from the viewed branch should use that branch's tip.
    const viewed = activeBranch();
    if (viewed && viewed.tip && viewed.tip.responseId) {
      bridgePost('set-tip-override', { tip: viewed.tip });
    } else if (target && (viewingAlternate || pendingEdit)) {
      bridgePost('set-tip-override', { tip });
    }
    if (hasForks(t) || pendingEdit) await saveThread();
    schedulePaint();
  }

  function branchHasContent(branch) {
    if (!branch || !branch.messages || !branch.messages.length) return false;
    return branch.messages.some((m) => m && ((m.text && m.text.trim()) || (m.html && m.html.trim())));
  }

  function recoverBranchMessages(branch, otherBranch) {
    if (branchHasContent(branch)) return true;
    // Prefer last-good transcript when it differs from the other version on screen.
    const candidates = [lastGoodTranscript, liveBuffer, otherBranch && otherBranch.messages];
    for (const cand of candidates) {
      if (!cand || !cand.length) continue;
      if (otherBranch && branchHasContent(otherBranch)) {
        const otherText = (otherBranch.messages || []).map((m) => m.text || '').join('\n');
        const candText = cand.map((m) => m.text || '').join('\n');
        if (candText && candText === otherText) continue;
      }
      if (cand.some((m) => m && ((m.text && m.text.trim()) || (m.html && m.html.trim())))) {
        setBranchMessages(branch, cand);
        return branchHasContent(branch);
      }
    }
    return false;
  }

  async function selectBranch(forkAt, branchId) {
    const t = thread;
    if (!t) return;
    const fork = t.forks[String(forkAt)];
    if (!fork || !fork.branchIds.includes(branchId)) return;
    const branch = t.branches[branchId];
    if (!branch) return;
    if (branchId === t.activeBranchId) return;

    // Freeze the branch we're leaving so its reply never bleeds into the other.
    commitActiveBranch();

    const leaving = t.branches[t.activeBranchId];
    if (!branchHasContent(branch)) {
      recoverBranchMessages(branch, leaving);
    }
    if (!branchHasContent(branch) && branchId === ownerIdOf(t)) {
      captureDomIntoBranch(branchId);
    }
    if (!branchHasContent(branch)) {
      console.warn('[Better Gemini] cannot switch — version has no saved content');
      schedulePaint();
      return;
    }

    t.activeBranchId = branchId;
    fork.activeIndex = fork.branchIds.indexOf(branchId);
    alignForksToBranch(branchId);

    // Always paint from that branch's own stored transcript (isolated).
    const applied = paintBranchMessages(branch);
    if (!applied) {
      schedulePaint();
      return;
    }

    const ownerId = ownerIdOf(t);
    viewingAlternate = branchId !== ownerId;
    setGeneratingUiSuppressed(viewingAlternate && (isGenerating() || Boolean(streamingBranchId)));

    if (branch.tip && branch.tip.responseId) {
      bridgePost('set-tip-override', { tip: branch.tip });
    } else {
      bridgePost('clear-tip-override', {});
    }

    await saveThread();
    clearMessageFocusChrome();
    schedulePaint();
    void forkAt;
  }

  function isUserTurnVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.dataset.bgTimelineHide === '1') return false;
    if (el.style.display === 'none') return false;
    try {
      if (window.getComputedStyle(el).display === 'none') return false;
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  function mountVersionControls(host, row) {
    // Must live INSIDE user-query. Sibling mounts get wiped by Gemini re-renders.
    if (!host || !row) return;
    if (row.parentElement === host) return;
    const bubble =
      host.querySelector('.user-query-bubble-with-background') ||
      host.querySelector('.user-query-bubble-container') ||
      host.querySelector('[class*="user-query-bubble"]');
    if (bubble && bubble.parentElement && host.contains(bubble.parentElement)) {
      bubble.parentElement.appendChild(row);
    } else {
      host.appendChild(row);
    }
  }

  function ensureControls() {
    if (!enabled || !thread || !hasForks(thread)) {
      document.querySelectorAll('.bg-timeline-controls').forEach((n) => n.remove());
      return;
    }

    const t = thread;
    const userNodes = turnNodes({ includeClones: true }).filter(
      (n) => roleOf(n) === 'user' && isUserTurnVisible(n)
    );
    const keep = new Set();
    const visibleUserCount = userNodes.length;

    Object.keys(t.forks).forEach((key) => {
      const forkAt = Number(key);
      const fork = t.forks[key];
      if (!fork || !fork.branchIds || fork.branchIds.length < 2) return;

      // Drop ids that were deleted; never drop surviving siblings.
      fork.branchIds = fork.branchIds.filter((id) => id && t.branches[id]);
      if (fork.branchIds.length < 2) return;

      // Prefer the visible turn; fall back to any matching user-query so controls
      // still appear while Gemini is mid-render.
      let host = forkAt < visibleUserCount ? userNodes[forkAt] : null;
      if (!host) {
        const allUsers = turnNodes({ includeClones: true }).filter((n) => roleOf(n) === 'user');
        host = allUsers[forkAt] || allUsers[Math.min(forkAt, Math.max(0, allUsers.length - 1))];
      }
      if (!host) return;

      const total = fork.branchIds.length;
      let idx = fork.branchIds.indexOf(t.activeBranchId);
      if (idx < 0) idx = Math.max(0, Math.min(fork.activeIndex || 0, total - 1));
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
      }
      row.dataset.forkAt = key;
      mountVersionControls(host, row);

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

  function clearMessageFocusChrome() {
    try {
      const ae = document.activeElement;
      if (
        ae &&
        ae.closest &&
        (ae.closest('user-query') ||
          ae.closest('model-response') ||
          ae.closest('.bg-timeline-controls'))
      ) {
        ae.blur();
      }
    } catch (_) {
      /* ignore */
    }
    document.querySelectorAll('user-query').forEach((uq) => {
      uq.classList.remove(
        'focused',
        'selected',
        'cdk-focused',
        'cdk-mouse-focused',
        'cdk-program-focused',
        'cdk-keyboard-focused'
      );
      uq.style.outline = '';
      uq.style.boxShadow = '';
      uq.querySelectorAll(
        '.user-query-bubble-with-background, .user-query-bubble-container, [class*="user-query-bubble"], .query-text, .query-content'
      ).forEach((node) => {
        node.classList.remove(
          'focused',
          'selected',
          'cdk-focused',
          'cdk-mouse-focused',
          'cdk-program-focused'
        );
        node.style.outline = '';
        node.style.boxShadow = '';
      });
    });
  }

  let lastControlNavAt = 0;

  /** Use pointerdown in capture phase — Gemini often swallows click inside user-query. */
  function onControlsPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const btn = event.target && event.target.closest && event.target.closest('.bg-timeline-btn');
    if (!btn || !enabled || !thread) return;
    if (btn.disabled) return;
    const row = btn.closest('.bg-timeline-controls');
    if (!row) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    // pointerdown + click both fire — only navigate once.
    const now = Date.now();
    if (now - lastControlNavAt < 400) return;
    lastControlNavAt = now;

    const forkAt = Number(row.dataset.forkAt);
    const fork = thread.forks[String(forkAt)];
    if (!fork || !fork.branchIds || fork.branchIds.length < 2) return;

    // Prefer activeBranchId so the label and the click target stay in sync.
    let idx = fork.branchIds.indexOf(thread.activeBranchId);
    if (idx < 0) idx = Math.max(0, Math.min(fork.activeIndex || 0, fork.branchIds.length - 1));
    fork.activeIndex = idx;

    const dir = btn.dataset.dir;
    if (dir === 'prev' && idx > 0) {
      selectBranch(forkAt, fork.branchIds[idx - 1]);
    } else if (dir === 'next' && idx < fork.branchIds.length - 1) {
      selectBranch(forkAt, fork.branchIds[idx + 1]);
    }
    requestAnimationFrame(() => clearMessageFocusChrome());
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
    if (!enabled || !chatId) return;
    // Capture once when edit opens — later DOM scrapes are already poisoned.
    if (preEditFreeze && preEditFreeze.length) return;
    if (viewingAlternate) {
      const shown = activeBranch();
      if (shown && shown.messages && shown.messages.length) {
        preEditFreeze = snapshotMessages(shown.messages);
        lastGoodTranscript = snapshotMessages(shown.messages);
        return;
      }
    }
    // Prefer the last complete transcript over a live scrape that may already be edit UI.
    if (lastGoodTranscript && lastGoodTranscript.length) {
      preEditFreeze = snapshotMessages(lastGoodTranscript);
      return;
    }
    if (liveBuffer.length) {
      preEditFreeze = snapshotMessages(liveBuffer);
      return;
    }
    const ab = activeBranch();
    if (ab && ab.messages && ab.messages.length) {
      preEditFreeze = snapshotMessages(ab.messages);
      return;
    }
    if (!isEditModeOpen()) {
      const msgs = scrapeMessages();
      if (msgs.length) preEditFreeze = snapshotMessages(msgs);
    }
  }

  async function onChatChanged() {
    const next = conversationId();
    if (next === chatId) return;
    chatId = next;
    pendingEdit = null;
    preEditFreeze = null;
    liveBuffer = [];
    lastGoodTranscript = [];
    liveDomBackup = null;
    streamingBranchId = null;
    viewingAlternate = false;
    setGeneratingUiSuppressed(false);
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
      if (!enabled || paintGuard) return;
      schedulePaint();
      const editing = document.querySelector(
        'user-query.edit-mode, user-query[class*="edit-mode"], user-query[editing], .edit-mode'
      );
      if (editing) noteEditModeOpen();
      if (bufferTimer) clearTimeout(bufferTimer);
      bufferTimer = setTimeout(() => {
        if (!viewingAlternate) refreshLiveBuffer();
      }, 400);
      if (syncTimer) clearTimeout(syncTimer);
      // Always sync — when viewing another version this captures the owner stream
      // into that branch only, then re-paints the viewed version.
      syncTimer = setTimeout(() => syncBranchesFromDom(), 350);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => onChatChanged(), 800);
    setInterval(() => {
      if (enabled && chatId && !viewingAlternate && !isEditModeOpen()) refreshLiveBuffer();
      if (enabled && chatId && hasForks(thread)) syncBranchesFromDom();
    }, 1500);
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
            streamingBranchId = null;
            setGeneratingUiSuppressed(false);
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
      streamingBranchId = null;
      viewingAlternate = false;
      setGeneratingUiSuppressed(false);
      scrubLegacyArtifacts();
      bridgePost('clear-tip-override', {});
      if (thread && hasForks(thread)) {
        if (!thread.ownerBranchId) thread.ownerBranchId = thread.geminiTipBranchId || thread.activeBranchId;
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
    document.addEventListener('pointerdown', onControlsPointerDown, true);
    document.addEventListener('click', onControlsPointerDown, true);
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
