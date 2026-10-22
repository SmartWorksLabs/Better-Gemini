/* Better Gemini — runs in the page (MAIN world) so it can read Gemini's
   session tokens and the token counts Gemini already returns. */
(function () {
  'use strict';

  const SOURCE = 'better-gemini-bridge';
  const CMD = 'better-gemini-bridge-cmd';
  const RPC_USAGE = 'jSf9Qc';

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

  function normalizeMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const prompt = Number(raw.promptTokenCount ?? raw.prompt_token_count) || 0;
    const candidates = Number(raw.candidatesTokenCount ?? raw.candidates_token_count) || 0;
    const thoughts = Number(raw.thoughtsTokenCount ?? raw.thoughts_token_count) || 0;
    const total = Number(raw.totalTokenCount ?? raw.total_token_count) || 0;
    if (!prompt && !candidates && !thoughts && !total) return null;
    return {
      promptTokenCount: prompt,
      candidatesTokenCount: candidates,
      thoughtsTokenCount: thoughts,
      totalTokenCount: total || prompt + candidates + thoughts
    };
  }

  function findUsageMetadata(value, depth = 0) {
    if (!value || depth > 14) return null;
    if (typeof value === 'object') {
      const direct = normalizeMeta(value);
      if (direct) return direct;
      if (value.usageMetadata) {
        const nested = normalizeMeta(value.usageMetadata);
        if (nested) return nested;
      }
      if (Array.isArray(value)) {
        let best = null;
        for (const item of value) {
          const found = findUsageMetadata(item, depth + 1);
          if (found && (!best || found.totalTokenCount >= best.totalTokenCount)) best = found;
        }
        return best;
      }
      let best = null;
      for (const key of Object.keys(value)) {
        const found = findUsageMetadata(value[key], depth + 1);
        if (found && (!best || found.totalTokenCount >= best.totalTokenCount)) best = found;
      }
      return best;
    }
    return null;
  }

  function emitUsageMetadata(meta) {
    const normalized = normalizeMeta(meta);
    if (!normalized) return;
    post('usageMetadata', normalized);
  }

  function extractMetaFromText(text) {
    if (!text) return null;
    let last = null;

    if (text.includes('usageMetadata') || text.includes('promptTokenCount') || text.includes('prompt_token_count')) {
      const patterns = [
        /"usageMetadata"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g,
        /"promptTokenCount"\s*:\s*(\d+)/g
      ];
      for (const re of patterns) {
        let match;
        while ((match = re.exec(text))) {
          if (re.source.includes('usageMetadata')) {
            try {
              last = normalizeMeta(JSON.parse(match[1])) || last;
            } catch (_) { /* partial */ }
          }
        }
      }
      // Broader object scan around promptTokenCount.
      const idx = text.lastIndexOf('"promptTokenCount"');
      if (idx >= 0) {
        const start = text.lastIndexOf('{', idx);
        const end = text.indexOf('}', idx);
        if (start >= 0 && end > start) {
          try {
            last = normalizeMeta(JSON.parse(text.slice(start, end + 1))) || last;
          } catch (_) { /* ignore */ }
        }
      }
    }

    const fromTree = findUsageMetadata(safeParse(text));
    if (fromTree && (!last || fromTree.totalTokenCount >= last.totalTokenCount)) last = fromTree;

    // batchexecute envelopes often wrap JSON strings — decode and search those too.
    if (text.includes('wrb.fr')) {
      for (const { payload } of decodeBatchExecute(text)) {
        const found = findUsageMetadata(payload);
        if (found && (!last || found.totalTokenCount >= last.totalTokenCount)) last = found;
      }
    }
    return last;
  }

  async function readBodyText(response) {
    try {
      const clone = response.clone();
      const contentType = (clone.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/event-stream') || contentType.includes('application/octet-stream')) {
        const reader = clone.body && clone.body.getReader();
        if (!reader) {
          const meta = extractMetaFromText(await clone.text());
          if (meta) emitUsageMetadata(meta);
          return null;
        }
        const decoder = new TextDecoder();
        let text = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        // Parse once when the stream has finished, not on every chunk.
        const meta = extractMetaFromText(text);
        if (meta) emitUsageMetadata(meta);
        return text;
      }
      const text = await clone.text();
      const found = extractMetaFromText(text);
      if (found) emitUsageMetadata(found);
      return text;
    } catch (_) {
      return null;
    }
  }

  function safeParse(text) {
    if (!text) return null;
    const trimmed = text.replace(/^\)\]\}'\s*/, '').trim();
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return null;
    }
  }

  // Gemini's own chat endpoints (relative or absolute). Everything else is left alone.
  const INSPECT_RE = /BardChatUi|batchexecute|StreamGenerate|GenerateContent/i;

  function shouldInspect(url) {
    const u = String(url || '');
    if (!u || u.startsWith('blob:') || u.startsWith('data:')) return false;
    return INSPECT_RE.test(u);
  }

  // ---- Parallel timelines (Option A): tip rewrite in the same chat ----
  // Gemini continues from conversation tuple [c_id, r_id, rc_id]. After an
  // edit, we keep abandoned tips locally and rewrite the next continue so it
  // parents off the version the user is viewing — same chat URL, no new chat.
  const ACTION_EDIT = 2;
  const CONV_INDEX = 2;
  const ACTION_INDEX = 72;
  const RPC_READ_CHAT = 'hNvQHb';

  let tipOverride = null; // { conversationId, responseId, choiceId } | null
  let lastServerTip = null;
  let lastEditAt = 0;

  function conversationIdFromPath() {
    const p = location.pathname;
    const m = p.match(/\/(?:app|c)\/([0-9a-f]+)/i) || p.match(/\/gem\/[^/]+\/([0-9a-f]{8,})/i);
    return m ? `c_${m[1]}` : null;
  }

  function lastMatch(text, re) {
    let last = null;
    let m;
    const copy = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    while ((m = copy.exec(text))) last = m;
    return last;
  }

  function extractIdsFromText(text) {
    if (!text || typeof text !== 'string') return null;
    // Prefer the last ids in a stream — those are the tip of the new turn.
    const c = lastMatch(text, /\bc_([0-9a-f]{8,})\b/i);
    const r = lastMatch(text, /\br_([0-9a-f]{8,})\b/i);
    const rc = lastMatch(text, /\brc_([0-9a-f]{8,})\b/i);
    if (!r && !rc) return null;
    return {
      conversationId: c ? `c_${c[1]}` : conversationIdFromPath(),
      responseId: r ? `r_${r[1]}` : null,
      choiceId: rc ? `rc_${rc[1]}` : null
    };
  }

  function noteServerTip(tip) {
    if (!tip || !tip.responseId) return;
    lastServerTip = tip;
    post('timelineTip', tip);
  }

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
        if (Array.isArray(inner)) return { kind: 'stream', inner, rebuild: (next) => [freq[0], JSON.stringify(next)] };
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
                kind: 'batch-nested',
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
              kind: 'batch',
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

  function promptTextFromInner(inner) {
    try {
      const p = inner && inner[0];
      if (Array.isArray(p) && typeof p[0] === 'string') return p[0];
      if (typeof p === 'string') return p;
    } catch (_) { /* ignore */ }
    return null;
  }

  function maybeRewriteBody(bodyText) {
    if (!tipOverride || !tipOverride.responseId || typeof bodyText !== 'string') {
      return { body: bodyText, meta: null };
    }
    const unwrapped = unwrapFreq(bodyText);
    if (!unwrapped) return { body: bodyText, meta: null };
    const found = findInnerFromFreq(unwrapped.freq);
    if (!found || !Array.isArray(found.inner)) return { body: bodyText, meta: null };

    const action = found.inner[ACTION_INDEX];
    // Never rewrite edit resends or regenerates — only normal continues.
    if (action === ACTION_EDIT || action === 5 || action === 7) {
      return { body: bodyText, meta: inspectSendMeta(found.inner, false) };
    }

    const before = readConvTuple(found.inner);
    // Only rewrite when parent tip differs from the version the user selected.
    if (before && before.responseId === tipOverride.responseId) {
      return { body: bodyText, meta: inspectSendMeta(found.inner, false) };
    }

    const rewrittenInner = writeConvTuple(found.inner, tipOverride);
    // Clear action so this is a normal continue on the selected tip.
    rewrittenInner[ACTION_INDEX] = null;
    const newFreq = found.rebuild(rewrittenInner);
    unwrapped.params.set('f.req', JSON.stringify(newFreq));
    return {
      body: unwrapped.params.toString(),
      meta: inspectSendMeta(rewrittenInner, true)
    };
  }

  function inspectSendMeta(inner, rewritten) {
    const tip = readConvTuple(inner);
    const action = inner[ACTION_INDEX];
    const prompt = promptTextFromInner(inner);
    return {
      action: action == null ? null : action,
      isEdit: action === ACTION_EDIT,
      prompt,
      tip,
      rewritten: Boolean(rewritten),
      chatId: (tip && tip.conversationId) || conversationIdFromPath()
    };
  }

  function inspectOutgoing(bodyText) {
    const unwrapped = unwrapFreq(bodyText);
    if (!unwrapped) return null;
    const found = findInnerFromFreq(unwrapped.freq);
    if (!found) return null;
    return inspectSendMeta(found.inner, false);
  }

  function emitOutgoing(meta) {
    if (!meta) return;
    if (meta.isEdit) {
      lastEditAt = Date.now();
      post('timelineEdit', meta);
    } else {
      post('timelineSend', meta);
    }
  }

  async function readRequestBody(input, init) {
    try {
      if (init && typeof init.body === 'string') return init.body;
      if (typeof input !== 'string' && input && typeof input.clone === 'function') {
        const req = input.clone();
        if (typeof req.text === 'function') return await req.text();
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');
    const inspect = shouldInspect(url);

    if (!inspect) return originalFetch.apply(this, args);

    // Rewrite continue-sends synchronously when body is already a string.
    try {
      const init = args[1] ? { ...args[1] } : {};
      if (typeof init.body === 'string' && init.body.includes('f.req=')) {
        const inspected = inspectOutgoing(init.body);
        const { body, meta } = maybeRewriteBody(init.body);
        if (body !== init.body) {
          init.body = body;
          args = [args[0], init];
          emitOutgoing(meta || inspected);
        } else if (inspected) {
          emitOutgoing(inspected);
        }
      } else {
        readRequestBody(args[0], args[1]).then((body) => {
          if (body) emitOutgoing(inspectOutgoing(body));
        }).catch(() => {});
      }
    } catch (_) { /* ignore */ }

    const promise = originalFetch.apply(this, args);
    promise.then((response) => {
      if (response && response.ok) {
        readBodyText(response).then((text) => {
          if (!text) return;
          const tip = extractIdsFromText(text);
          if (tip) noteServerTip(tip);
          noteTurnTips(text);
        }).catch(() => {});
      }
    }).catch(() => {});
    return promise;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bgUrl = String(url || '');
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (shouldInspect(this.__bgUrl || '') && typeof args[0] === 'string' && args[0].includes('f.req=')) {
        const inspected = inspectOutgoing(args[0]);
        const { body, meta } = maybeRewriteBody(args[0]);
        if (body !== args[0]) {
          args[0] = body;
          emitOutgoing(meta || inspected);
        } else if (inspected) {
          emitOutgoing(inspected);
        }
      }
    } catch (_) { /* ignore */ }

    this.addEventListener('load', () => {
      try {
        if (!shouldInspect(this.__bgUrl || '')) return;
        const found = extractMetaFromText(this.responseText);
        if (found) emitUsageMetadata(found);
        const tip = extractIdsFromText(this.responseText);
        if (tip) noteServerTip(tip);
        noteTurnTips(this.responseText);
      } catch (_) { /* ignore */ }
    });
    return xhrSend.apply(this, args);
  };

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

  function readMetric(m) {
    if (!Array.isArray(m) || m.length < 4) return null;
    const fraction = m[1];
    const period = m[2];
    const resetWrap = m[3];
    if (typeof fraction !== 'number' || fraction < 0 || fraction > 1.5) return null;
    if (typeof period !== 'number') return null;
    if (!Array.isArray(resetWrap) || !Array.isArray(resetWrap[0])) return null;
    const epoch = resetWrap[0][0];
    if (typeof epoch !== 'number' || epoch < 1_600_000_000) return null;
    return { percent: Math.round(fraction * 100), resetEpoch: epoch, period };
  }

  function extractUsage(payload) {
    if (!Array.isArray(payload)) return null;
    const metricsArr = payload.find((x) => Array.isArray(x) && x.some((m) => readMetric(m)));
    if (!metricsArr) return null;
    const metrics = metricsArr.map(readMetric).filter(Boolean);
    if (!metrics.length) return null;
    const current = metrics.find((m) => m.period === 1) || null;
    const weekly = metrics.find((m) => m.period === 2) || null;
    return (current || weekly) ? { current, weekly } : null;
  }

  function usagePath() {
    const match = location.pathname.match(/^\/u\/(\d+)/);
    return match ? `/u/${match[1]}/usage` : '/usage';
  }

  // Tag-stripped text of a chunk of HTML. Gemini enforces Trusted Types, so
  // DOMParser/innerHTML on a string is blocked; this reads text without any HTML sink.
  function htmlToText(html) {
    return String(html)
      .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ');
  }

  // Google AI plan from the Usage limits page (Free 32k / Plus 128k / Pro+Ultra 1M).
  function parsePlanFromUsageHtml(html) {
    if (!html) return null;

    // Header badge: the text right after the usage metrics header.
    const anchor = html.search(/usage-metrics-(?:window|container|header)/i);
    if (anchor !== -1) {
      const headerText = htmlToText(html.slice(anchor, anchor + 2000));
      const headerMatch = headerText.match(/\b(?:GOOGLE\s+AI\s+)?(FREE|PLUS|PRO|ULTRA|ADVANCED)\b/i);
      if (headerMatch) return headerMatch[1].toUpperCase();
    }

    // Raw HTML / embedded JSON.
    const raw = html;
    const badge = raw.match(/usage-metrics-header[\s\S]{0,400}?\b(FREE|PLUS|PRO|ULTRA)\b/i);
    if (badge) return badge[1].toUpperCase();
    if (/"tier"\s*:\s*"(FREE|PLUS|PRO|ULTRA)"/i.test(raw)) {
      return raw.match(/"tier"\s*:\s*"(FREE|PLUS|PRO|ULTRA)"/i)[1].toUpperCase();
    }
    if (/\b(GOOGLE_ONE_AI_PREMIUM|GEMINI_ADVANCED|AI_PREMIUM|PAID_TIER|AI_PRO)\b/i.test(raw)) return 'PRO';
    if (/\b(AI_ULTRA|GOOGLE_ONE_AI_ULTRA)\b/i.test(raw)) return 'ULTRA';
    if (/\b(AI_PLUS|GOOGLE_ONE_AI_PLUS)\b/i.test(raw)) return 'PLUS';
    if (/>\s*PRO\s*</i.test(raw) && !/Upgrade[\s\S]{0,48}Pro/i.test(raw)) return 'PRO';
    if (/>\s*ULTRA\s*</i.test(raw) && !/Upgrade[\s\S]{0,48}Ultra/i.test(raw)) return 'ULTRA';
    if (/>\s*PLUS\s*</i.test(raw) && !/Upgrade[\s\S]{0,48}Plus/i.test(raw)) return 'PLUS';
    return null;
  }

  function extractTierFromPayload(value, depth = 0) {
    if (!value || depth > 10) return null;
    if (typeof value === 'string') {
      const m = value.match(/\b(GOOGLE\s+AI\s+)?(FREE|PLUS|PRO|ULTRA|ADVANCED)\b/i);
      return m ? m[2].toUpperCase() : null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = extractTierFromPayload(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const found = extractTierFromPayload(value[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function detectPlanFromWiz() {
    try {
      const blob = JSON.stringify(wiz());
      if (/ULTRA/i.test(blob) && /(GOOGLE_?ONE|AI_|GEMINI|SUBSCRIPTION|TIER)/i.test(blob)) {
        if (!/UPGRADE[\s\S]{0,24}ULTRA/i.test(blob)) return 'ULTRA';
      }
      if (/\bPRO\b|AI_PRO|GEMINI_ADVANCED|AI_PREMIUM|PAID_TIER/i.test(blob)) {
        if (!/UPGRADE[\s\S]{0,24}PRO/i.test(blob)) return 'PRO';
      }
      if (/\bPLUS\b|AI_PLUS/i.test(blob) && !/UPGRADE[\s\S]{0,24}PLUS/i.test(blob)) return 'PLUS';
    } catch (_) { /* ignore */ }
    return null;
  }

  async function fetchPlanTier() {
    const fromWiz = detectPlanFromWiz();
    const path = usagePath();
    const response = await originalFetch(path, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/html' }
    });
    if (!response.ok) return fromWiz;
    const html = await response.text();
    return parsePlanFromUsageHtml(html) || fromWiz;
  }

  async function fetchUsageAndPlan() {
    const data = wiz();
    const token = sessionToken();
    if (!token) throw new Error('no-token');

    const query = new URLSearchParams({
      rpcids: RPC_USAGE,
      'source-path': usagePath(),
      rt: 'c'
    });
    if (typeof data.cfb2h === 'string') query.set('bl', data.cfb2h);
    if (typeof data.FdrFJe === 'string') query.set('f.sid', data.FdrFJe);
    query.set('hl', (document.documentElement.lang || 'en').split('-')[0]);
    query.set('_reqid', String(Math.floor(100000 + Math.random() * 9000000)));

    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[RPC_USAGE, '[]', null, 'generic']]]),
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

    let usage = null;
    let tier = null;
    for (const { payload } of decodeBatchExecute(text)) {
      if (!usage) usage = extractUsage(payload);
      if (!tier) tier = extractTierFromPayload(payload);
    }

    if (!usage) {
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line.includes('wrb.fr') || !line.includes(RPC_USAGE)) continue;
        try {
          const parsed = JSON.parse(line);
          const payload = JSON.parse(parsed[0][2]);
          usage = extractUsage(payload);
          if (!tier) tier = extractTierFromPayload(payload);
          if (usage) break;
        } catch (_) { /* next */ }
      }
    }

    if (!tier) {
      try {
        tier = await fetchPlanTier();
      } catch (_) { /* optional */ }
    }

    if (!usage && !tier) throw new Error('parse-failed');
    return { usage: usage || null, tier: tier || null };
  }

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
        const userBlock = turn[2];
        const respBlock = turn[3];
        let userText = '';
        try {
          userText = (userBlock && userBlock[0] && userBlock[0][0]) || '';
        } catch (_) { /* ignore */ }
        let modelText = '';
        let choiceId = null;
        try {
          const cand = respBlock && respBlock[0] && respBlock[0][0];
          if (Array.isArray(cand)) {
            choiceId = typeof cand[0] === 'string' ? cand[0] : null;
            const chunks = cand[1];
            if (Array.isArray(chunks)) modelText = chunks.filter((x) => typeof x === 'string').join('');
            else if (typeof chunks === 'string') modelText = chunks;
          }
        } catch (_) { /* ignore */ }
        turns.push({
          conversationId: typeof ids[0] === 'string' ? ids[0] : cid,
          responseId: typeof ids[1] === 'string' ? ids[1] : null,
          choiceId: choiceId || (typeof ids[2] === 'string' ? ids[2] : null),
          userText: String(userText || ''),
          modelText: String(modelText || '')
        });
      }
    }
    return { chatId: cid, turns, tip: lastServerTip };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== CMD) return;
    const { type, id } = event.data;
    if (type === 'ping') {
      post('ready', { id });
      return;
    }
    if (type === 'fetch-usage') {
      fetchUsageAndPlan()
        .then((result) => post('usage', { id, ok: true, usage: result.usage, tier: result.tier }))
        .catch((err) => post('usage', { id, ok: false, error: String(err && err.message || err) }));
      return;
    }
    if (type === 'set-tip-override') {
      const tip = event.data.tip;
      if (tip && tip.responseId) {
        tipOverride = {
          conversationId: tip.conversationId || conversationIdFromPath(),
          responseId: tip.responseId,
          choiceId: tip.choiceId || null
        };
      } else {
        tipOverride = null;
      }
      post('tipOverride', { id, ok: true, tip: tipOverride });
      return;
    }
    if (type === 'clear-tip-override') {
      tipOverride = null;
      post('tipOverride', { id, ok: true, tip: null });
      return;
    }
    if (type === 'get-timeline-state') {
      post('timelineState', {
        id,
        ok: true,
        tipOverride,
        lastServerTip,
        lastEditAt,
        chatId: conversationIdFromPath()
      });
      return;
    }
    if (type === 'read-chat') {
      fetchChatTurns(event.data.chatId)
        .then((result) => post('chatTurns', { id, ok: true, ...result }))
        .catch((err) => post('chatTurns', { id, ok: false, error: String(err && err.message || err) }));
    }
  });

  post('ready', {});
})();
