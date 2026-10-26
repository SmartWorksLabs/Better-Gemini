/* Message Versions for Gemini — runs in the page (MAIN world) so it can see
   the reply ids in Gemini's responses and continue a chat from an older
   version.

   Gemini continues from the conversation tuple [c_id, r_id, rc_id]. After an
   edit, timelines.js keeps the abandoned replies locally; while one of them is
   on screen, the next send is rewritten so Gemini parents off that version —
   same chat address, no new chat. */
(function () {
  'use strict';

  const SOURCE = 'message-versions-bridge';
  const CMD = 'message-versions-bridge-cmd';
  const RPC_READ_CHAT = 'hNvQHb';
  const CONV_INDEX = 2;
  const ACTION_INDEX = 72;
  // Edit resends and regenerates carry their own parent; only plain sends are rewritten.
  const ACTION_EDIT = 2;
  const ACTION_REGENERATE = [5, 7];

  let tipOverride = null; // { conversationId, responseId, choiceId } | null

  function post(type, payload) {
    try {
      window.postMessage({ source: SOURCE, type, payload }, window.location.origin);
    } catch (_) { /* page tearing down */ }
  }

  function wiz() {
    return window.WIZ_global_data || {};
  }

  function sessionToken() {
    const data = wiz();
    if (typeof data.SNlM0e === 'string' && data.SNlM0e) return data.SNlM0e;
    try {
      const match = document.documentElement.innerHTML.match(/"SNlM0e":"([^"]+)"/);
      return match ? match[1] : null;
    } catch (_) {
      return null;
    }
  }

  function conversationIdFromPath() {
    const p = location.pathname;
    const m = p.match(/\/(?:app|c)\/([0-9a-f]+)/i) || p.match(/\/gem\/[^/]+\/([0-9a-f]{8,})/i);
    return m ? `c_${m[1]}` : null;
  }

  // Gemini's own chat endpoints (relative or absolute). Everything else is left alone.
  const INSPECT_RE = /BardChatUi|batchexecute|StreamGenerate|GenerateContent/i;

  function shouldInspect(url) {
    const u = String(url || '');
    if (!u || u.startsWith('blob:') || u.startsWith('data:')) return false;
    return INSPECT_RE.test(u);
  }

  // ---- reply ids ----

  // Every (response id, choice id) pair in a response, in order. A chat read lists all
  // turns; a stream lists the one being generated. The first choice follows its response.
  function extractIdPairs(text) {
    if (!text || typeof text !== 'string' || text.indexOf('r_') < 0) return [];
    const cid = conversationIdFromPath();
    const re = /\b(rc?)_([0-9a-f]{8,})\b/g;
    const pairs = [];
    let current = null;
    let m;
    while ((m = re.exec(text))) {
      if (m[1] === 'r') {
        current = { conversationId: cid, responseId: `r_${m[2]}`, choiceId: null };
        pairs.push(current);
      } else if (current && !current.choiceId) {
        current.choiceId = `rc_${m[2]}`;
      }
    }
    const seen = new Set();
    return pairs.filter((p) => (seen.has(p.responseId) ? false : seen.add(p.responseId)));
  }

  function noteTurnTips(text) {
    const tips = extractIdPairs(text);
    if (tips.length) post('timelineTips', { tips });
  }

  // ---- send rewrite ----

  function unwrapFreq(bodyText) {
    if (!bodyText || typeof bodyText !== 'string' || !bodyText.includes('f.req=')) return null;
    try {
      const params = new URLSearchParams(bodyText);
      const raw = params.get('f.req');
      if (!raw) return null;
      return { params, freq: JSON.parse(raw) };
    } catch (_) {
      return null;
    }
  }

  function findInnerFromFreq(freq) {
    // StreamGenerate: [null, "<inner json string>"]
    if (Array.isArray(freq) && freq.length >= 2 && typeof freq[1] === 'string') {
      try {
        const inner = JSON.parse(freq[1]);
        if (Array.isArray(inner)) return { inner, rebuild: (next) => [freq[0], JSON.stringify(next)] };
      } catch (_) { /* fall through */ }
    }
    // batchexecute: [[["rpcid", "<payload>", null, "generic"]]]
    if (Array.isArray(freq) && Array.isArray(freq[0]) && Array.isArray(freq[0][0])) {
      const row = freq[0][0];
      if (typeof row[1] === 'string') {
        try {
          const payload = JSON.parse(row[1]);
          // Some sends nest the same [null, innerString] shape inside.
          if (Array.isArray(payload) && typeof payload[1] === 'string') {
            const inner = JSON.parse(payload[1]);
            if (Array.isArray(inner)) {
              return {
                inner,
                rebuild: (next) => {
                  const copy = freq.map((x) => (Array.isArray(x) ? x.slice() : x));
                  copy[0] = copy[0].slice();
                  copy[0][0] = row.slice();
                  const nested = payload.slice();
                  nested[1] = JSON.stringify(next);
                  copy[0][0][1] = JSON.stringify(nested);
                  return copy;
                }
              };
            }
          }
          if (Array.isArray(payload) && payload.length > ACTION_INDEX) {
            return {
              inner: payload,
              rebuild: (next) => {
                const copy = freq.map((x) => (Array.isArray(x) ? x.slice() : x));
                copy[0] = copy[0].slice();
                copy[0][0] = row.slice();
                copy[0][0][1] = JSON.stringify(next);
                return copy;
              }
            };
          }
        } catch (_) { /* ignore */ }
      }
    }
    return null;
  }

  function readConvTuple(inner) {
    const t = inner && inner[CONV_INDEX];
    if (!Array.isArray(t)) return null;
    return {
      conversationId: typeof t[0] === 'string' ? t[0] : null,
      responseId: typeof t[1] === 'string' ? t[1] : null,
      choiceId: typeof t[2] === 'string' ? t[2] : null
    };
  }

  function writeConvTuple(inner, tip) {
    if (!Array.isArray(inner) || !tip) return inner;
    const next = inner.slice();
    const prev = Array.isArray(next[CONV_INDEX]) ? next[CONV_INDEX].slice() : [];
    if (tip.conversationId) prev[0] = tip.conversationId;
    if (tip.responseId) prev[1] = tip.responseId;
    if (tip.choiceId) prev[2] = tip.choiceId;
    next[CONV_INDEX] = prev;
    return next;
  }

  // Returns the body to send: unchanged unless a saved version is on screen
  // and this is a plain send that would continue from a different reply.
  function maybeRewriteBody(bodyText) {
    if (!tipOverride || !tipOverride.responseId || typeof bodyText !== 'string') return bodyText;
    const unwrapped = unwrapFreq(bodyText);
    if (!unwrapped) return bodyText;
    const found = findInnerFromFreq(unwrapped.freq);
    if (!found || !Array.isArray(found.inner)) return bodyText;

    const action = found.inner[ACTION_INDEX];
    if (action === ACTION_EDIT || ACTION_REGENERATE.includes(action)) return bodyText;

    const before = readConvTuple(found.inner);
    if (before && before.responseId === tipOverride.responseId) return bodyText;

    const rewritten = writeConvTuple(found.inner, tipOverride);
    rewritten[ACTION_INDEX] = null;
    unwrapped.params.set('f.req', JSON.stringify(found.rebuild(rewritten)));
    return unwrapped.params.toString();
  }

  // ---- network hooks ----

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');
    if (!shouldInspect(url)) return originalFetch.apply(this, args);

    try {
      const init = args[1] ? { ...args[1] } : null;
      if (init && typeof init.body === 'string') {
        const body = maybeRewriteBody(init.body);
        if (body !== init.body) {
          init.body = body;
          args = [args[0], init];
        }
      }
    } catch (_) { /* ignore */ }

    const promise = originalFetch.apply(this, args);
    promise.then((response) => {
      if (!response || !response.ok) return;
      response.clone().text().then(noteTurnTips).catch(() => {});
    }).catch(() => {});
    return promise;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mvUrl = String(url || '');
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (shouldInspect(this.__mvUrl || '')) {
      try {
        if (typeof args[0] === 'string') args[0] = maybeRewriteBody(args[0]);
      } catch (_) { /* ignore */ }
      this.addEventListener('load', () => {
        try {
          noteTurnTips(this.responseText);
        } catch (_) { /* ignore */ }
      });
    }
    return xhrSend.apply(this, args);
  };

  // ---- chat read ----

  function matchBracket(s, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function decodeBatchExecute(text) {
    const out = [];
    let idx = 0;
    while (idx < text.length) {
      const at = text.indexOf('[["wrb.fr"', idx);
      if (at < 0) break;
      const end = matchBracket(text, at);
      if (end < 0) break;
      try {
        const rows = JSON.parse(text.slice(at, end + 1));
        for (const row of rows) {
          if (Array.isArray(row) && row[0] === 'wrb.fr' && typeof row[1] === 'string' && typeof row[2] === 'string') {
            try {
              out.push({ rpcid: row[1], payload: JSON.parse(row[2]) });
            } catch (_) { /* skip */ }
          }
        }
      } catch (_) { /* skip */ }
      idx = end + 1;
    }
    return out;
  }

  // The ids of every turn in a chat, for versions saved before their ids were seen.
  async function fetchChatTurns(chatId) {
    const data = wiz();
    const token = sessionToken();
    if (!token) throw new Error('no-token');
    const cid = chatId || conversationIdFromPath();
    if (!cid) throw new Error('no-chat');

    const query = new URLSearchParams({
      rpcids: RPC_READ_CHAT,
      'source-path': location.pathname || '/app',
      rt: 'c'
    });
    if (typeof data.cfb2h === 'string') query.set('bl', data.cfb2h);
    if (typeof data.FdrFJe === 'string') query.set('f.sid', data.FdrFJe);
    query.set('hl', (document.documentElement.lang || 'en').split('-')[0]);
    query.set('_reqid', String(Math.floor(100000 + Math.random() * 9000000)));

    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[RPC_READ_CHAT, JSON.stringify([cid, 100, null, 1, [1], [4], null, 1]), null, 'generic']]]),
      at: token
    });

    const response = await originalFetch(`/_/BardChatUi/data/batchexecute?${query}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1'
      },
      body: body.toString()
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const text = await response.text();

    const turns = [];
    for (const { rpcid, payload } of decodeBatchExecute(text)) {
      if (rpcid !== RPC_READ_CHAT) continue;
      const list = Array.isArray(payload) ? payload[0] : null;
      if (!Array.isArray(list)) continue;
      for (const turn of list) {
        if (!Array.isArray(turn)) continue;
        const ids = Array.isArray(turn[1]) ? turn[1] : (Array.isArray(turn[0]) ? turn[0] : []);
        let choiceId = null;
        try {
          const cand = turn[3] && turn[3][0] && turn[3][0][0];
          if (Array.isArray(cand) && typeof cand[0] === 'string') choiceId = cand[0];
        } catch (_) { /* ignore */ }
        turns.push({
          conversationId: typeof ids[0] === 'string' ? ids[0] : cid,
          responseId: typeof ids[1] === 'string' ? ids[1] : null,
          choiceId: choiceId || (typeof ids[2] === 'string' ? ids[2] : null)
        });
      }
    }
    return { chatId: cid, turns };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== CMD) return;
    const { type, id } = event.data;
    if (type === 'set-tip-override') {
      const tip = event.data.tip;
      tipOverride = tip && tip.responseId
        ? {
            conversationId: tip.conversationId || conversationIdFromPath(),
            responseId: tip.responseId,
            choiceId: tip.choiceId || null
          }
        : null;
      return;
    }
    if (type === 'clear-tip-override') {
      tipOverride = null;
      return;
    }
    if (type === 'read-chat') {
      fetchChatTurns(event.data.chatId)
        .then((result) => post('chatTurns', { id, ok: true, ...result }))
        .catch((err) => post('chatTurns', { id, ok: false, error: String(err && err.message || err) }));
    }
  });
})();
