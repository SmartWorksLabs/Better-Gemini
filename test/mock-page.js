/* Mock of Gemini's chat markup (structure captured from gemini.google.com). */
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');

const PAGE = `<!doctype html><html><head><style>${css}
.conversation-container{display:block;padding:4px}
</style></head><body>
<div id="app" style="height:600px;overflow:auto">
<infinite-scroller data-test-id="chat-history-container" class="chat-history"></infinite-scroller>
</div>
<script>
// ---- chrome.* stub; storage survives reloads via sessionStorage ----
(function () {
  const load = (k) => { try { return JSON.parse(sessionStorage.getItem(k) || '{}'); } catch (_) { return {}; } };
  const mk = (k) => ({
    get(keys, cb) { const s = load(k); const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach(x => { if (x in s) o[x] = JSON.parse(JSON.stringify(s[x])); }); setTimeout(() => cb(o), 0); },
    set(obj, cb) { const s = load(k); Object.assign(s, JSON.parse(JSON.stringify(obj))); sessionStorage.setItem(k, JSON.stringify(s)); setTimeout(() => cb && cb(), 0); },
    remove(keys, cb) { const s = load(k); [].concat(keys).forEach(x => delete s[x]); sessionStorage.setItem(k, JSON.stringify(s)); setTimeout(() => cb && cb(), 0); }
  });
  window.chrome = { runtime: { id: 'test', lastError: null }, storage: { local: mk('local'), sync: mk('sync'), onChanged: { addListener(fn) { window.__onChanged = fn; } } } };
  window.__bridge = [];
  window.addEventListener('message', (e) => { if (e.data && e.data.source === 'better-gemini-bridge-cmd') window.__bridge.push({ type: e.data.type, tip: e.data.tip || null }); });
})();

// ---- mock Gemini ----
const sc = () => document.querySelector('infinite-scroller');
function replyHtml(kind, id) {
  if (kind === 'table') return '<response-element><table-block><div class="table-wrapper"><table class="t"><tr><td>cell-' + id + '</td></tr></table></div></table-block></response-element>';
  if (kind === 'code') return '<code-block><div class="code-block"><pre><code><span class="hljs-keyword">const</span> x_' + id + '</code></pre></div></code-block>';
  if (kind === 'canvas') return '<mini-app><iframe src="https://scf.usercontent.goog/x/shim.html"></iframe></mini-app><p>canvas ' + id + '</p>';
  return '<p>reply ' + id + '</p>';
}
function turnHtml(id, text, kind, complete) {
  return '<user-query class="ng-star-inserted"><span class="user-query-container"><user-query-content class="user-query-container"><div class="user-query-container"><div class="query-content" id="user-query-content-' + id + '"><div class="query-bubble-with-status"><span class="user-query-bubble-with-background"><span class="horizontal-container"><div class="query-text"><p class="query-text-line">' + text + '</p></div></span></span></div></div></div></user-query-content></span></user-query>' +
    '<model-response><div class="response-container"><message-content id="message-content-id-r_' + id + '"><div class="markdown" id="markdown-' + id + '">' + replyHtml(kind, id) + '</div></message-content>' +
    '<div class="response-footer gap' + (complete ? ' complete' : '') + '"><button class="copy">copy</button></div></div></model-response>';
}
window.mock = {
  add(id, text, kind, complete = true) {
    const d = document.createElement('div');
    d.className = 'conversation-container message-actions-hover-boundary ng-star-inserted turn-content-visibility';
    d.id = id; d.innerHTML = turnHtml(id, text, kind, complete);
    sc().appendChild(d); return d;
  },
  complete(id) { document.getElementById(id).querySelector('.response-footer').classList.add('complete'); },
  openEdit(id) {
    const q = document.getElementById(id).querySelector('.query-content');
    q.insertAdjacentHTML('beforeend', '<div class="edit-form"><rich-textarea class="edit-rich-textarea"><div class="ql-editor"><p>x</p></div></rich-textarea><button class="update-button">Update</button><button class="cancel-button">Cancel</button></div>');
  },
  // what Gemini does on a submitted edit: the edited turn and every later turn disappear, a new turn appears
  submitEdit(oldId, newId, text, kind) {
    const all = Array.from(sc().children).filter(c => c.classList.contains('conversation-container'));
    const at = all.findIndex(c => c.id === oldId);
    all.slice(at).forEach(c => c.remove());
    return window.mock.add(newId, text, kind, false);
  },
  tip(id, rc) { window.postMessage({ source: 'better-gemini-bridge', type: 'timelineTips', payload: { tips: [{ conversationId: 'c_abc123def456', responseId: 'r_' + id, choiceId: 'rc_' + (rc || id) }] } }, location.origin); },
  visible() { return Array.from(sc().querySelectorAll(':scope > .conversation-container:not([data-bg-hidden]), :scope > [data-bg-run] > .conversation-container')).map(c => (c.getAttribute('data-bg-node-id') || c.id) + (c.hasAttribute('data-bg-clone') ? '*' : '')); },
  controls() { return Array.from(document.querySelectorAll('.bg-timeline-controls')).map(r => r.dataset.turnId + ':' + r.querySelector('.bg-timeline-count').textContent + ':' + r.querySelector('[data-dir=prev]').disabled + '/' + r.querySelector('[data-dir=next]').disabled); },
  click(turnId, dir) { const b = document.querySelector('.bg-timeline-controls[data-turn-id="' + turnId + '"] [data-dir=' + dir + ']'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); }
};
</script></body></html>`;

module.exports = { PAGE };
