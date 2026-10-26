/* Message Versions for Gemini — Claude-style parallel message versions in the same chat.

   Gemini's own turns are never edited. Every finished turn (Gemini's
   `.conversation-container`, keyed by its own id) is saved as a node whose parent
   is the turn before it, so an edited prompt simply becomes a sibling node.
   Showing another version hides the live turns and inserts saved copies next to
   them; showing the live version removes the copies again.

   Debug: run `localStorage.mvDebug = '1'` in the page console and reload. */
(function () {
  'use strict';

  const BRIDGE_CMD = 'message-versions-bridge-cmd';
  const BRIDGE_SRC = 'message-versions-bridge';
  const STORE_KEY = 'messageVersions';
  const STORE_VERSION = 9;
  const MAX_CHATS = 40;
  const UNKNOWN = '?'; // parent not known (turn was first on screen, chat not scrolled to top)
  const TICK_MS = 250;
  const SAVE_MS = 800;
  const STABLE_MS = 700; // a finished reply must stay unchanged this long before it is saved

  let enabled = true;
  let chatId = null;
  let thread = null; // { v, seq, nodes: { [turnId]: node } }
  let view = null; // { path: [turnId] } while a non-live version is shown
  let tickTimer = null;
  let saveTimer = null;
  let renderSig = '';
  let lastPointerAt = 0;
  let lastMutationAt = 0;
  let tipsByResp = Object.create(null);
  let readChatAskedAt = 0;
  let overrideKey = '';
  const stableSince = new Map();

  // ---- helpers ----------------------------------------------------------------

  function debugOn() {
    try {
      return localStorage.getItem('mvDebug') === '1';
    } catch (_) {
      return false;
    }
  }

  function dlog(...args) {
    if (debugOn()) console.log('[Message Versions]', ...args);
  }

  function bridgePost(type, extra = {}) {
    window.postMessage({ source: BRIDGE_CMD, type, ...extra }, window.location.origin);
  }

  /** Gemini's own conversation id, when the address has one (normal chats and chats with a Gem). */
  function conversationId() {
    const p = location.pathname;
    const m = p.match(/\/(?:app|c)\/([0-9a-f]+)/i) || p.match(/\/gem\/[^/]+\/([0-9a-f]{8,})/i);
    return m ? `c_${m[1]}` : null;
  }

  /** Key for saved versions. Falls back to the address for any other chat page; null on a blank new chat. */
  function chatKey() {
    const id = conversationId();
    if (id) return id;
    const p = location.pathname.replace(/\/+$/, '');
    return /^(\/u\/\d+)?(\/app)?$/.test(p) ? null : `p_${p}`;
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
      if (!extAlive()) return resolve({});
      try {
        chrome.storage.local.get([STORE_KEY], (result) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve((result && result[STORE_KEY]) || {});
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  function storageSet(all) {
    return new Promise((resolve) => {
      if (!extAlive()) return resolve(false);
      try {
        chrome.storage.local.set({ [STORE_KEY]: all }, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            console.warn('[Message Versions] could not save message versions:', err.message);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      } catch (err) {
        console.warn('[Message Versions] could not save message versions:', err);
        resolve(false);
      }
    });
  }

  function newThread() {
    return { v: STORE_VERSION, seq: 0, nodes: {} };
  }

  async function loadThread(id) {
    const all = await storageGet();
    const saved = all[id];
    return saved && saved.v === STORE_VERSION && saved.nodes ? saved : newThread();
  }

  // ---- Gemini DOM -------------------------------------------------------------

  function scroller() {
    return (
      document.querySelector('infinite-scroller[data-test-id="chat-history-container"]') ||
      document.querySelector('infinite-scroller')
    );
  }

  /** Gemini's own turns, in order. Our saved copies live in [data-mv-run] wrappers and never match. */
  function liveContainers() {
    const sc = scroller();
    if (!sc) return [];
    return Array.from(sc.children).filter(
      (c) => c.classList && c.classList.contains('conversation-container') && !c.hasAttribute('data-mv-clone')
    );
  }

  function isEditing(c) {
    return Boolean(c.querySelector('.edit-form, rich-textarea.edit-rich-textarea'));
  }

  function isComplete(c) {
    return Boolean(c.querySelector('.response-footer.complete')) && !isEditing(c);
  }

  function hasStopButton() {
    return Boolean(
      document.querySelector(
        'button[aria-label*="Stop" i], [data-test-id="stop-button"], button.stop-generating-button'
      )
    );
  }

  function isGenerating() {
    const D = liveContainers();
    const last = D[D.length - 1];
    if (!last || isComplete(last) || isEditing(last)) return false;
    return hasStopButton() || Date.now() - lastMutationAt < 2500;
  }

  function scrollParent(el) {
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      let s;
      try {
        s = getComputedStyle(p);
      } catch (_) {
        continue;
      }
      if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
    }
    return document.scrollingElement;
  }

  function atTop() {
    const sc = scroller();
    if (!sc) return true;
    const sp = scrollParent(sc);
    return !sp || sp.scrollTop <= 12;
  }

  function userTextOf(c) {
    const el = c.querySelector('.query-text-line') || c.querySelector('.query-text');
    return el ? el.textContent.trim().slice(0, 200) : '';
  }

  function serializeContainer(c) {
    const copy = c.cloneNode(true);
    copy.removeAttribute('data-mv-hidden');
    copy.querySelectorAll('.mv-controls, iframe, script').forEach((n) => n.remove());
    return copy.outerHTML.replace(/<!--[\s\S]*?-->/g, '');
  }

  /** Build a read-only copy of a saved turn. Ids are dropped so they never clash with the live page. */
  function buildClone(node) {
    if (!node || !node.html) return null;
    const tpl = document.createElement('template');
    tpl.innerHTML = node.html;
    const root = tpl.content.firstElementChild;
    if (!root) return null;
    root.removeAttribute('id');
    root.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    root.querySelectorAll('script, iframe, .mv-controls').forEach((n) => n.remove());
    // Saved markup is only ever Gemini's own rendered page, but never let it run anything.
    [root, ...root.querySelectorAll('*')].forEach((n) => {
      Array.from(n.attributes).forEach((a) => {
        if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) {
          n.removeAttribute(a.name);
        }
      });
    });
    root.querySelectorAll('mini-app').forEach((n) => {
      const ph = document.createElement('div');
      ph.className = 'mv-canvas-placeholder';
      ph.textContent = 'Canvas is not available in saved versions.';
      n.replaceWith(ph);
    });
    root.setAttribute('data-mv-clone', '1');
    root.setAttribute('data-mv-node-id', node.id);
    return document.adoptNode(root);
  }

  // ---- version tree -----------------------------------------------------------

  function buildIndex() {
    const idx = new Map();
    if (!thread) return idx;
    Object.keys(thread.nodes).forEach((id) => {
      const n = thread.nodes[id];
      if (!n || n.parentId === UNKNOWN) return;
      const key = n.parentId == null ? null : n.parentId;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(n);
    });
    idx.forEach((list) => list.sort((a, b) => a.seq - b.seq));
    return idx;
  }

  function hasForks(idx) {
    const index = idx || buildIndex();
    for (const list of index.values()) if (list.length >= 2) return true;
    return false;
  }

  function tipFor(id) {
    return tipsByResp[`r_${id}`] || null;
  }

  function mergeTip(tip) {
    if (!tip || !tip.responseId) return false;
    const prev = tipsByResp[tip.responseId];
    const next = {
      conversationId: tip.conversationId || (prev && prev.conversationId) || conversationId(),
      responseId: tip.responseId,
      choiceId: tip.choiceId || (prev && prev.choiceId) || null
    };
    tipsByResp[tip.responseId] = next;
    if (thread) {
      const node = thread.nodes[tip.responseId.replace(/^r_/, '')];
      if (node && (!node.tip || !node.tip.choiceId)) node.tip = next;
    }
    return true;
  }

  function parentFromDom(D, i) {
    if (i > 0) return D[i - 1].id || UNKNOWN;
    return atTop() ? null : UNKNOWN;
  }

  /** Save finished turns. Returns true when a finished turn is still settling. */
  function captureLive(force) {
    if (!thread) return false;
    const D = liveContainers();
    const now = Date.now();
    let settling = false;
    let changed = false;

    for (let i = 0; i < D.length; i++) {
      const c = D[i];
      const id = c.id;
      if (!id) continue;
      let node = thread.nodes[id];
      // A turn first seen mid-scroll gets its real parent (or root) once that is on screen.
      // Done even while the turn is being edited: that is when you are at the top, about to fork it.
      if (node && !node.parentLocked) {
        const dom = parentFromDom(D, i);
        const cur = node.parentId;
        if ((cur === UNKNOWN && dom !== UNKNOWN) || (cur === null && dom && dom !== UNKNOWN)) {
          node.parentId = dom;
          changed = true;
          dlog('parent updated', id, dom);
        }
      }
      if (!isComplete(c)) {
        stableSince.delete(id);
        continue;
      }
      if (!node) {
        if (!force) {
          if (!stableSince.has(id)) stableSince.set(id, now);
          if (now - stableSince.get(id) < STABLE_MS) {
            settling = true;
            continue;
          }
        }
        // A reply sent while a saved version is on screen continues from that version.
        const continuing = Boolean(view);
        const parentId = continuing ? view.path[view.path.length - 1] : parentFromDom(D, i);
        node = thread.nodes[id] = {
          id,
          parentId,
          parentLocked: continuing,
          seq: ++thread.seq,
          html: serializeContainer(c),
          userText: userTextOf(c),
          tip: tipFor(id)
        };
        if (continuing) view.path.push(id);
        const parent = parentId && parentId !== UNKNOWN ? thread.nodes[parentId] : null;
        if (parent) parent.activeChild = id;
        changed = true;
        dlog('saved turn', id, 'parent', parentId, node.userText);
      } else {
        if (!node.tip || !node.tip.choiceId) {
          const tip = tipFor(id);
          if (tip && tip.choiceId) {
            node.tip = tip;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      syncOverride();
      schedulePersist();
    }
    return settling;
  }

  function buildPath(targetId, idx, liveIds) {
    const nodes = thread.nodes;
    const chain = [];
    const seen = new Set();
    let cur = targetId;
    while (cur && cur !== UNKNOWN && nodes[cur] && !seen.has(cur)) {
      seen.add(cur);
      chain.unshift(cur);
      cur = nodes[cur].parentId;
    }
    let tail = targetId;
    for (let guard = 0; guard < 500; guard++) {
      const kids = idx.get(tail) || [];
      const li = liveIds.indexOf(tail);
      if (li === liveIds.length - 1) break; // this is the live conversation's last turn
      if (!kids.length) break;
      let next = null;
      if (li >= 0 && kids.some((k) => k.id === liveIds[li + 1])) next = liveIds[li + 1];
      if (!next) {
        const ac = nodes[tail].activeChild;
        next = ac && kids.some((k) => k.id === ac) ? ac : kids[kids.length - 1].id;
      }
      if (seen.has(next)) break;
      seen.add(next);
      chain.push(next);
      tail = next;
    }
    return chain;
  }

  function rememberChildren(path) {
    for (let i = 1; i < path.length; i++) {
      const parent = thread.nodes[path[i - 1]];
      if (parent) parent.activeChild = path[i];
    }
  }

  // ---- showing a version ------------------------------------------------------

  function removeRuns() {
    document.querySelectorAll('[data-mv-run]').forEach((n) => n.remove());
  }

  function clearView() {
    removeRuns();
    document.querySelectorAll('[data-mv-hidden]').forEach((n) => n.removeAttribute('data-mv-hidden'));
    renderSig = '';
  }

  function placeRun(run, anchor, prev, D) {
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(run, anchor);
    } else if (prev && prev.parentNode) {
      prev.parentNode.insertBefore(run, prev.nextSibling);
    } else if (D[0] && D[0].parentNode) {
      D[0].parentNode.insertBefore(run, D[0]);
    } else {
      const sc = scroller();
      if (sc) sc.appendChild(run);
    }
  }

  function applyView() {
    if (!view) {
      if (renderSig !== '' || document.querySelector('[data-mv-run], [data-mv-hidden]')) clearView();
      return;
    }
    const D = liveContainers();
    const ids = D.map((c) => c.id);
    const seq = [];
    let last = -1;
    for (const id of view.path) {
      const i = ids.indexOf(id);
      if (i > last) {
        seq.push({ live: D[i] });
        last = i;
      } else {
        seq.push({ clone: id });
      }
    }
    // A reply that is still arriving (or not saved yet) stays visible after the saved turns.
    for (let i = last + 1; i < D.length; i++) {
      const c = D[i];
      if ((!isComplete(c) && !isEditing(c)) || (isComplete(c) && !thread.nodes[c.id])) seq.push({ live: c });
    }

    const liveSet = new Set(seq.filter((s) => s.live).map((s) => s.live));
    D.forEach((c) => {
      if (liveSet.has(c)) {
        if (c.hasAttribute('data-mv-hidden')) c.removeAttribute('data-mv-hidden');
      } else if (c.getAttribute('data-mv-hidden') !== '1') {
        c.setAttribute('data-mv-hidden', '1');
      }
    });

    const sig = seq.map((s) => (s.live ? `L${s.live.id}` : `C${s.clone}`)).join('|');
    let runs = 0;
    for (let i = 0; i < seq.length; i++) {
      if (!seq[i].live && (i === 0 || seq[i - 1].live)) runs++;
    }
    if (sig === renderSig && document.querySelectorAll('[data-mv-run]').length === runs) return;

    removeRuns();
    for (let i = 0; i < seq.length; ) {
      if (seq[i].live) {
        i++;
        continue;
      }
      const run = document.createElement('div');
      run.setAttribute('data-mv-run', '1');
      let j = i;
      while (j < seq.length && !seq[j].live) {
        const el = buildClone(thread.nodes[seq[j].clone]);
        if (el) run.appendChild(el);
        j++;
      }
      placeRun(run, j < seq.length ? seq[j].live : null, i > 0 ? seq[i - 1].live : null, D);
      i = j;
    }
    renderSig = sig;
    dlog('showing saved version', view.path);
  }

  function setPath(path, liveIds) {
    const same = path.length === liveIds.length && path.every((id, i) => id === liveIds[i]);
    view = same ? null : { path };
    renderSig = '';
    try {
      applyView();
    } catch (err) {
      console.warn('[Message Versions] could not show that version, going back to the live one', err);
      view = null;
      clearView();
    }
    syncOverride();
    ensureControls();
    schedulePersist();
  }

  function navigate(turnId, dir) {
    if (!enabled || !thread || isGenerating()) return;
    captureLive(true);
    const idx = buildIndex();
    const node = thread.nodes[turnId];
    if (!node) return;
    const sibs = idx.get(node.parentId == null ? null : node.parentId) || [];
    const at = sibs.findIndex((s) => s.id === turnId);
    const target = sibs[at + dir];
    if (!target) return;
    const liveIds = liveContainers().map((c) => c.id);
    const path = buildPath(target.id, idx, liveIds);
    rememberChildren(path);
    dlog('switch', turnId, '->', target.id, path);
    setPath(path, liveIds);
  }

  // ---- continuing from a saved version ----------------------------------------

  function syncOverride() {
    const leaf = view && view.path[view.path.length - 1];
    const node = leaf && thread ? thread.nodes[leaf] : null;
    const tip = node && node.tip && node.tip.responseId ? node.tip : null;
    const key = view ? (tip ? `${tip.responseId}|${tip.choiceId}` : 'none') : '';
    if (key === overrideKey) return;
    overrideKey = key;
    if (view && tip) {
      bridgePost('set-tip-override', { tip });
    } else {
      bridgePost('clear-tip-override', {});
      if (view) {
        console.warn(
          '[Message Versions] this version has no Gemini ids saved, so a new message will continue from the live conversation'
        );
        requestChatTips();
      }
    }
  }

  function requestChatTips() {
    const geminiId = conversationId();
    if (!geminiId || Date.now() - readChatAskedAt < 15000) return;
    readChatAskedAt = Date.now();
    bridgePost('read-chat', { id: `mv-${Date.now()}`, chatId: geminiId });
  }

  // ---- version controls -------------------------------------------------------

  function mountControls(host, row) {
    // Must live inside user-query: siblings of it get wiped when Gemini re-renders.
    if (!host || !row) return;
    if (host.contains(row)) return;
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

  function makeControls(turnId) {
    const row = document.createElement('div');
    row.className = 'mv-controls';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Message versions');
    row.dataset.turnId = turnId;

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'mv-btn';
    prev.dataset.dir = 'prev';
    prev.setAttribute('aria-label', 'Previous version');
    prev.textContent = '‹';

    const label = document.createElement('span');
    label.className = 'mv-count';

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'mv-btn';
    next.dataset.dir = 'next';
    next.setAttribute('aria-label', 'Next version');
    next.textContent = '›';

    row.append(prev, label, next);
    return row;
  }

  function setDisabled(btn, value) {
    // Assigning the same value still counts as a DOM change, so only write on change.
    if (btn.disabled !== value) btn.disabled = value;
  }

  function removeAllControls() {
    document.querySelectorAll('.mv-controls').forEach((n) => n.remove());
  }

  function ensureControls() {
    if (!enabled || !thread) return removeAllControls();
    const idx = buildIndex();
    if (!hasForks(idx)) return removeAllControls();
    const sc = scroller();
    if (!sc) return removeAllControls();

    const generating = isGenerating();
    const shown = Array.from(
      sc.querySelectorAll(
        ':scope > .conversation-container:not([data-mv-hidden]), :scope > [data-mv-run] > .conversation-container'
      )
    );
    const keep = new Set();
    shown.forEach((el) => {
      const id = el.getAttribute('data-mv-node-id') || el.id;
      const node = id && thread.nodes[id];
      if (!node || node.parentId === UNKNOWN) return;
      const sibs = idx.get(node.parentId == null ? null : node.parentId) || [];
      if (sibs.length < 2) return;
      const host = el.querySelector('user-query');
      if (!host) return;
      let row = host.querySelector('.mv-controls');
      if (!row || row.dataset.turnId !== id) {
        if (row) row.remove();
        row = makeControls(id);
      }
      mountControls(host, row);
      const at = sibs.findIndex((s) => s.id === id);
      const text = `${at + 1} / ${sibs.length}`;
      const label = row.querySelector('.mv-count');
      if (label.textContent !== text) label.textContent = text;
      setDisabled(row.querySelector('[data-dir="prev"]'), generating || at <= 0);
      setDisabled(row.querySelector('[data-dir="next"]'), generating || at >= sibs.length - 1);
      keep.add(row);
    });
    document.querySelectorAll('.mv-controls').forEach((row) => {
      if (!keep.has(row)) row.remove();
    });
  }

  /** pointerdown in the capture phase: Gemini swallows plain clicks inside user-query. */
  function onControlsPointer(event) {
    if (event.button != null && event.button !== 0) return;
    const btn = event.target && event.target.closest && event.target.closest('.mv-btn');
    if (!btn || !enabled || !thread) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    if (btn.disabled) return;
    // A mouse press sends pointerdown then click: act on the pointerdown only.
    // Keyboard and assistive clicks have no pointerdown, so they still work.
    const now = Date.now();
    if (event.type === 'click' && now - lastPointerAt < 700) return;
    if (event.type === 'pointerdown') lastPointerAt = now;
    const row = btn.closest('.mv-controls');
    if (!row) return;
    navigate(row.dataset.turnId, btn.dataset.dir === 'prev' ? -1 : 1);
    try {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    } catch (_) {
      /* ignore */
    }
  }

  // ---- persistence ------------------------------------------------------------

  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist();
    }, SAVE_MS);
  }

  async function persist() {
    if (!chatId || !thread || !hasForks()) return;
    const all = await storageGet();
    thread.updatedAt = Date.now();
    all[chatId] = thread;
    const ids = Object.keys(all).sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0));
    while (ids.length > MAX_CHATS) delete all[ids.shift()];
    const ok = await storageSet(all);
    if (!ok) console.warn('[Message Versions] message versions are only kept until this tab closes');
  }

  // ---- loop -------------------------------------------------------------------

  function scheduleTick(ms) {
    if (tickTimer) return;
    tickTimer = setTimeout(tick, ms == null ? TICK_MS : ms);
  }

  function tick() {
    tickTimer = null;
    if (!enabled || !chatId || !thread) return;
    if (!scroller()) return;
    try {
      const settling = captureLive(false);
      applyView();
      ensureControls();
      if (settling) scheduleTick(STABLE_MS / 2);
    } catch (err) {
      console.warn('[Message Versions] message versions', err);
      view = null;
      clearView();
    }
  }

  function teardown() {
    view = null;
    overrideKey = '';
    clearView();
    removeAllControls();
    stableSince.clear();
    bridgePost('clear-tip-override', {});
  }

  async function onChatChanged() {
    const next = chatKey();
    if (next === chatId) return;
    teardown();
    chatId = next;
    thread = null;
    tipsByResp = Object.create(null);
    readChatAskedAt = 0;
    if (!next) return;
    const loaded = await loadThread(next);
    if (chatId !== next) return;
    thread = loaded;
    dlog('chat', next, 'loaded', Object.keys(thread.nodes).length, 'saved turns');
    scheduleTick(50);
  }

  function watchBridge() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.source !== BRIDGE_SRC) return;
      const { type, payload } = event.data;
      if (type === 'timelineTips' && payload && Array.isArray(payload.tips)) {
        let any = false;
        payload.tips.forEach((tip) => {
          any = mergeTip(tip) || any;
        });
        if (any && thread) {
          if (view) syncOverride();
          scheduleTick(100);
        }
      } else if (type === 'chatTurns' && payload && Array.isArray(payload.turns)) {
        payload.turns.forEach((t) => mergeTip(t));
        if (view) syncOverride();
      }
    });
  }

  function watchDom() {
    const obs = new MutationObserver((records) => {
      if (!enabled) return;
      const relevant = records.some((r) => {
        const t = r.target;
        const el = t && t.nodeType === 1 ? t : t && t.parentElement;
        return !(el && el.closest && el.closest('[data-mv-run], .mv-controls'));
      });
      if (!relevant) return;
      lastMutationAt = Date.now();
      scheduleTick();
    });
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
    setInterval(() => {
      onChatChanged();
      if (enabled && chatId) scheduleTick();
    }, 1000);
  }

  function loadEnabled() {
    return new Promise((resolve) => {
      if (!extAlive()) {
        enabled = true;
        return resolve(enabled);
      }
      try {
        chrome.storage.sync.get(['showTimelines'], (result) => {
          enabled = chrome.runtime.lastError ? true : !result || result.showTimelines !== false;
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
        if (area !== 'sync' || !changes.showTimelines) return;
        enabled = changes.showTimelines.newValue !== false;
        if (!enabled) teardown();
        else scheduleTick(50);
      });
    } catch (_) {
      /* extension reloaded */
    }
  }

  async function init() {
    if (extAlive()) {
      await new Promise((resolve) => {
        try {
          chrome.storage.local.get(['messageVersionsStoreVersion'], (result) => {
            if (!chrome.runtime.lastError && result.messageVersionsStoreVersion !== STORE_VERSION) {
              chrome.storage.local.remove([STORE_KEY], () => {
                chrome.storage.local.set({ messageVersionsStoreVersion: STORE_VERSION }, resolve);
              });
            } else {
              resolve();
            }
          });
        } catch (_) {
          resolve();
        }
      });
    }
    await loadEnabled();
    document.addEventListener('pointerdown', onControlsPointer, true);
    document.addEventListener('click', onControlsPointer, true);
    // Save everything on screen right before an edit is submitted: Gemini deletes the later turns.
    document.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target;
        if (
          t &&
          t.closest &&
          t.closest('.update-button, [data-test-id="prompt-edit-button"], button[aria-label*="Edit" i]')
        ) {
          try {
            captureLive(true);
          } catch (_) {
            /* ignore */
          }
        }
      },
      true
    );
    // Scrolling to the top is what tells us a first message really is the first.
    document.addEventListener('scroll', () => scheduleTick(), { capture: true, passive: true });
    window.addEventListener('pageshow', () => {
      // Back from the bfcache: show the live conversation again.
      view = null;
      overrideKey = '';
      clearView();
      bridgePost('clear-tip-override', {});
      scheduleTick(50);
    });
    watchSettings();
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
