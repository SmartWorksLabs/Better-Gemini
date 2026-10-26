/* Usage Tracker for Gemini — runs in the page (MAIN world) so it can read
   Gemini's session token and the token counts Gemini already returns. */
(function () {
  'use strict';

  const SOURCE = 'gemini-usage-bridge';
  const CMD = 'gemini-usage-bridge-cmd';
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
      let match;
      const re = /"usageMetadata"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g;
      while ((match = re.exec(text))) {
        try {
          last = normalizeMeta(JSON.parse(match[1])) || last;
        } catch (_) { /* partial */ }
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

  // Reads a copy of the response once it has finished (streams included),
  // so the page's own reader is not affected.
  async function scanResponse(response) {
    try {
      const meta = extractMetaFromText(await response.clone().text());
      if (meta) emitUsageMetadata(meta);
    } catch (_) { /* body already used or aborted */ }
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

  // Gemini's own responses carry usageMetadata. Requests are never changed.
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');
    const promise = originalFetch.apply(this, args);
    if (shouldInspect(url)) {
      promise.then((response) => {
        if (response && response.ok) scanResponse(response);
      }).catch(() => {});
    }
    return promise;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__guUrl = String(url || '');
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (shouldInspect(this.__guUrl || '')) {
      this.addEventListener('load', () => {
        try {
          const found = extractMetaFromText(this.responseText);
          if (found) emitUsageMetadata(found);
        } catch (_) { /* ignore */ }
      });
    }
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
  });

  post('ready', {});
})();
