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

  function findUsageMetadata(value, depth = 0) {
    if (!value || depth > 12) return null;
    if (typeof value === 'object') {
      if (typeof value.promptTokenCount === 'number' || typeof value.totalTokenCount === 'number') {
        return value;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findUsageMetadata(item, depth + 1);
          if (found) return found;
        }
      } else {
        for (const key of Object.keys(value)) {
          const found = findUsageMetadata(value[key], depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  }

  function emitUsageMetadata(meta) {
    if (!meta) return;
    const prompt = Number(meta.promptTokenCount) || 0;
    const candidates = Number(meta.candidatesTokenCount) || 0;
    const thoughts = Number(meta.thoughtsTokenCount) || 0;
    const total = Number(meta.totalTokenCount) || prompt + candidates + thoughts;
    post('usageMetadata', {
      promptTokenCount: prompt,
      candidatesTokenCount: candidates,
      thoughtsTokenCount: thoughts,
      totalTokenCount: total
    });
  }

  function extractMetaFromText(text) {
    if (!text || !text.includes('usageMetadata')) return null;
    let last = null;
    const re = /"usageMetadata"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g;
    let match;
    while ((match = re.exec(text))) {
      try {
        last = JSON.parse(match[1]);
      } catch (_) { /* partial chunk */ }
    }
    if (last) return last;
    return findUsageMetadata(safeParse(text));
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
        let lastMeta = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          const meta = extractMetaFromText(text);
          if (meta) lastMeta = meta;
        }
        if (lastMeta) emitUsageMetadata(lastMeta);
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

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = originalFetch.apply(this, args);
    try {
      const url = String(typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '');
      if (/gemini\.google\.com|BatchExecute|batchexecute|GenerateContent|StreamGenerate/i.test(url) ||
          (args[0] && typeof args[0] === 'object' && !url.startsWith('http'))) {
        promise.then((response) => {
          if (response && response.ok) readBodyText(response);
        }).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    return promise;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bgUrl = String(url || '');
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (!/gemini\.google\.com|BatchExecute|batchexecute|GenerateContent|StreamGenerate/i.test(this.__bgUrl || '')) return;
        const found = extractMetaFromText(this.responseText);
        if (found) emitUsageMetadata(found);
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

  async function fetchUsage() {
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

    for (const { payload } of decodeBatchExecute(text)) {
      const usage = extractUsage(payload);
      if (usage) return usage;
    }

    // Fallback line scan used by several public userscripts.
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.includes('wrb.fr') || !line.includes(RPC_USAGE)) continue;
      try {
        const parsed = JSON.parse(line);
        const payload = JSON.parse(parsed[0][2]);
        const usage = extractUsage(payload);
        if (usage) return usage;
      } catch (_) { /* next */ }
    }
    throw new Error('parse-failed');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== CMD) return;
    const { type, id } = event.data;
    if (type === 'ping') {
      post('ready', { id });
      return;
    }
    if (type === 'fetch-usage') {
      fetchUsage()
        .then((usage) => post('usage', { id, ok: true, usage }))
        .catch((err) => post('usage', { id, ok: false, error: String(err && err.message || err) }));
    }
  });

  post('ready', {});
})();
