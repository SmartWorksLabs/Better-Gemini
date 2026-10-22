/* Drives timelines.js against a mock of Gemini's real chat markup.
   Run:  NODE_PATH="$(npm root -g)" node test/versions.test.js
   The mock follows the structure captured from gemini.google.com (conversation-container
   per turn, .response-footer.complete, .edit-form, table-block, code-block, mini-app). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ORIGIN = 'https://gemini.google.com';
const URL = `${ORIGIN}/app/abc123def456`;
const timelinesJs = fs.readFileSync(path.join(__dirname, '..', 'timelines.js'), 'utf8');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log('  ok   ', name);
  } catch (e) {
    failures++;
    console.log('  FAIL ', name, '\n        ', e.message.split('\n').join('\n         '));
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith(ORIGIN)) return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    return route.abort();
  });
  const boot = async () => { await page.goto(URL); await page.addScriptTag({ content: timelinesJs }); await sleep(300); };
  const vis = () => page.evaluate(() => window.mock.visible());
  const ctl = () => page.evaluate(() => window.mock.controls());
  const click = (id, dir) => page.evaluate(([i, d]) => window.mock.click(i, d), [id, dir]);

  // Chat with four turns: normal, table, code, canvas.
  await boot();
  await page.evaluate(() => {
    mock.add('t1', 'hello how are you doing', 'plain');
    mock.add('t2', 'create me a sample table', 'table');
    mock.add('t3', 'now a code block', 'code');
    mock.add('t4', 'now a canvas', 'canvas');
    ['t1', 't2', 't3', 't4'].forEach((i) => mock.tip(i));
  });
  await sleep(1300);

  await step('no controls and nothing hidden before any edit', async () => {
    assert.deepStrictEqual(await ctl(), []);
    assert.deepStrictEqual(await vis(), ['t1', 't2', 't3', 't4']);
  });

  await step('edit turn 2: later turns vanish, new turn streams then finishes', async () => {
    await page.evaluate(() => mock.openEdit('t2'));
    await page.dispatchEvent('.update-button', 'pointerdown');
    await page.evaluate(() => mock.submitEdit('t2', 'e2', "how's it going", 'plain'));
    await sleep(400);
    await page.evaluate(() => { mock.complete('e2'); mock.tip('e2'); });
    await sleep(1400);
    assert.deepStrictEqual(await vis(), ['t1', 'e2']);
    assert.deepStrictEqual(await ctl(), ['e2:2 / 2:false/true']);
  });

  await step('previous version: saved turns come back intact, live reply hidden', async () => {
    await click('e2', 'prev');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['t1', 't2*', 't3*', 't4*']);
    const html = await page.evaluate(() => document.querySelector('[data-bg-run]').innerHTML);
    assert.ok(html.includes('cell-t2'), 'table content kept');
    assert.ok(html.includes('table-block'), 'table wrapper kept');
    assert.ok(html.includes('hljs-keyword'), 'code highlighting kept');
    assert.ok(html.includes('bg-canvas-placeholder'), 'canvas replaced by a placeholder');
    assert.ok(!html.includes('<iframe'), 'no iframe in saved copy');
    assert.deepStrictEqual(await ctl(), ['t2:1 / 2:true/false']);
  });

  await step('saved copies never duplicate Gemini element ids', async () => {
    const dup = await page.evaluate(() => {
      const seen = {}; const bad = [];
      document.querySelectorAll('[id]').forEach((n) => { if (seen[n.id]) bad.push(n.id); seen[n.id] = 1; });
      return bad;
    });
    assert.deepStrictEqual(dup, []);
  });

  await step('Gemini\'s live turn is untouched while hidden', async () => {
    const info = await page.evaluate(() => {
      const e = document.getElementById('e2');
      return { hidden: e.getAttribute('data-bg-hidden'), reply: e.querySelector('.markdown').innerHTML };
    });
    assert.strictEqual(info.hidden, '1');
    assert.strictEqual(info.reply, '<p>reply e2</p>');
  });

  await step('next brings the live version back and removes all copies', async () => {
    await click('t2', 'next');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['t1', 'e2']);
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('[data-bg-run],[data-bg-hidden]').length), 0);
  });

  await step('continuing from the older version rewrites the tip and attaches the reply to it', async () => {
    await click('e2', 'prev');
    await sleep(300);
    const calls = await page.evaluate(() => window.__bridge.filter((b) => b.type === 'set-tip-override'));
    assert.ok(calls.length, 'tip override set');
    assert.strictEqual(calls[calls.length - 1].tip.responseId, 'r_t4');
    assert.strictEqual(calls[calls.length - 1].tip.choiceId, 'rc_t4');
    // user sends a message while viewing the older version: Gemini appends a new turn at the end
    await page.evaluate(() => mock.add('n5', 'and now?', 'plain', false));
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['t1', 't2*', 't3*', 't4*', 'n5'], 'streaming reply visible after the old version');
    await page.evaluate(() => { mock.complete('n5'); mock.tip('n5'); });
    await sleep(1400);
    assert.deepStrictEqual(await vis(), ['t1', 't2*', 't3*', 't4*', 'n5']);
    assert.deepStrictEqual(await ctl(), ['t2:1 / 2:true/false'], 'new turn is not a sibling of anything');
    const last = await page.evaluate(() => window.__bridge.filter((b) => b.type === 'set-tip-override').pop().tip.responseId);
    assert.strictEqual(last, 'r_n5', 'next message would continue from the new turn');
  });

  await step('switching to the other version hides the new turn that belongs to the older one', async () => {
    await click('t2', 'next');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['t1', 'e2']);
    assert.strictEqual(await page.evaluate(() => document.getElementById('n5').getAttribute('data-bg-hidden')), '1');
    await click('e2', 'prev');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['t1', 't2*', 't3*', 't4*', 'n5'], 'and brings it back with the older version');
  });

  await step('versions survive a page reload', async () => {
    await boot();
    await page.evaluate(() => { mock.add('t1', 'hello how are you doing', 'plain'); mock.add('e2', "how's it going", 'plain'); });
    await sleep(1300);
    assert.deepStrictEqual(await vis(), ['t1', 'e2']);
    assert.deepStrictEqual(await ctl(), ['e2:2 / 2:false/true']);
    await click('e2', 'prev');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['t1', 't2*', 't3*', 't4*', 'n5*'], 'older path is restored from storage');
  });

  await step('sub-branches: an edit inside a version does not collide with edits elsewhere', async () => {
    await boot();
    // fresh chat so nothing carries over
    await page.evaluate(() => sessionStorage.clear());
    await boot();
    await page.evaluate(() => { mock.add('a1', 'one', 'plain'); mock.add('b1', 'two', 'plain'); mock.add('c1', 'three', 'plain'); ['a1','b1','c1'].forEach((i) => mock.tip(i)); });
    await sleep(1300);
    // edit turn 3
    await page.evaluate(() => mock.openEdit('c1'));
    await page.dispatchEvent('.update-button', 'pointerdown');
    await page.evaluate(() => mock.submitEdit('c1', 'c2', 'three again', 'plain'));
    await sleep(300);
    await page.evaluate(() => { mock.complete('c2'); mock.tip('c2'); });
    await sleep(1300);
    assert.deepStrictEqual(await ctl(), ['c2:2 / 2:false/true']);
    // now edit turn 2
    await page.evaluate(() => mock.openEdit('b1'));
    await page.dispatchEvent('.update-button', 'pointerdown');
    await page.evaluate(() => mock.submitEdit('b1', 'b2', 'two again', 'plain'));
    await sleep(300);
    await page.evaluate(() => { mock.complete('b2'); mock.tip('b2'); });
    await sleep(1300);
    assert.deepStrictEqual(await ctl(), ['b2:2 / 2:false/true']);
    // back to the first version of turn 2: it remembers its own sub-branch (turn 3 has two versions)
    await click('b2', 'prev');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['a1', 'b1*', 'c2*']);
    assert.deepStrictEqual(await ctl(), ['b1:1 / 2:true/false', 'c2:2 / 2:false/true']);
    await click('c2', 'prev');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['a1', 'b1*', 'c1*']);
    assert.deepStrictEqual(await ctl(), ['b1:1 / 2:true/false', 'c1:1 / 2:true/false']);
    await click('b1', 'next');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['a1', 'b2']);
    assert.deepStrictEqual(await ctl(), ['b2:2 / 2:false/true']);
  });

  await step('a cancelled edit creates no version', async () => {
    await page.evaluate(() => sessionStorage.clear());
    await boot();
    await page.evaluate(() => { mock.add('x1', 'one', 'plain'); mock.add('x2', 'two', 'plain'); });
    await sleep(1300);
    await page.evaluate(() => mock.openEdit('x2'));
    await sleep(300);
    await page.evaluate(() => document.querySelector('.edit-form').remove());
    await sleep(800);
    assert.deepStrictEqual(await ctl(), []);
    assert.deepStrictEqual(await vis(), ['x1', 'x2']);
  });

  await step('switching is disabled while a reply is streaming', async () => {
    await page.evaluate(() => sessionStorage.clear());
    await boot();
    await page.evaluate(() => { mock.add('y1', 'one', 'plain'); mock.add('y2', 'two', 'plain'); });
    await sleep(1300);
    await page.evaluate(() => mock.openEdit('y2'));
    await page.dispatchEvent('.update-button', 'pointerdown');
    await page.evaluate(() => { mock.submitEdit('y2', 'y3', 'two again', 'plain'); mock.complete('y3'); });
    await sleep(1400);
    await page.evaluate(() => { mock.add('y4', 'next', 'plain', false); });
    await sleep(300);
    const states = await ctl();
    assert.deepStrictEqual(states, ['y3:2 / 2:true/true']);
  });

  await step('turning message versions off removes everything the extension added', async () => {
    await page.evaluate(() => sessionStorage.clear());
    await boot();
    await page.evaluate(() => { mock.add('z1', 'one', 'plain'); mock.add('z2', 'two', 'plain'); mock.tip('z1'); mock.tip('z2'); });
    await sleep(1300);
    await page.evaluate(() => mock.openEdit('z2'));
    await page.dispatchEvent('.update-button', 'pointerdown');
    await page.evaluate(() => { mock.submitEdit('z2', 'z3', 'two again', 'plain'); mock.complete('z3'); });
    await sleep(1400);
    await click('z3', 'prev');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['z1', 'z2*']);
    await page.evaluate(() => window.__onChanged({ showTimelines: { newValue: false } }, 'sync'));
    await sleep(300);
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('[data-bg-run],[data-bg-hidden],.bg-timeline-controls').length), 0);
    assert.deepStrictEqual(await vis(), ['z1', 'z3']);
  });

  await step('Angular re-rendering over our controls and hidden turns is repaired', async () => {
    await page.evaluate(() => sessionStorage.clear());
    await boot();
    await page.evaluate(() => { mock.add('r1', 'one', 'plain'); mock.add('r2', 'two', 'plain'); mock.tip('r1'); mock.tip('r2'); });
    await sleep(1300);
    await page.evaluate(() => mock.openEdit('r2'));
    await page.dispatchEvent('.update-button', 'pointerdown');
    await page.evaluate(() => { mock.submitEdit('r2', 'r3', 'two again', 'plain'); mock.complete('r3'); mock.tip('r3'); });
    await sleep(1400);
    assert.deepStrictEqual(await ctl(), ['r3:2 / 2:false/true']);
    // Gemini re-renders the user bubble: our controls are wiped
    await page.evaluate(() => { const uq = document.querySelector('#r3 user-query'); uq.replaceWith(uq.cloneNode(true)); document.querySelector('#r3 .bg-timeline-controls')?.remove(); });
    await sleep(500);
    assert.deepStrictEqual(await ctl(), ['r3:2 / 2:false/true'], 'controls come back after a re-render');
    await click('r3', 'prev');
    await sleep(300);
    assert.deepStrictEqual(await vis(), ['r1', 'r2*']);
    // Gemini re-creates the hidden live turn: it must be hidden again
    await page.evaluate(() => { const old = document.getElementById('r3'); const fresh = old.cloneNode(true); fresh.removeAttribute('data-bg-hidden'); old.replaceWith(fresh); });
    await sleep(500);
    assert.deepStrictEqual(await vis(), ['r1', 'r2*']);
    // Gemini removes our wrapper outright
    await page.evaluate(() => document.querySelector('[data-bg-run]').remove());
    await sleep(500);
    assert.deepStrictEqual(await vis(), ['r1', 'r2*'], 'saved copy is put back');
  });

  await step('idle page: the extension makes no DOM changes of its own', async () => {
    const n = await page.evaluate(() => new Promise((resolve) => {
      let count = 0;
      const mo = new MutationObserver((r) => { count += r.length; });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      setTimeout(() => { mo.disconnect(); resolve(count); }, 2500);
    }));
    assert.strictEqual(n, 0);
  });

  await step('a saved version without Gemini ids warns and does not rewrite the next message', async () => {
    const before = errors.length;
    await page.evaluate(() => sessionStorage.clear());
    await boot();
    await page.evaluate(() => { mock.add('w1', 'one', 'plain'); mock.add('w2', 'two', 'plain'); });
    await sleep(1300);
    await page.evaluate(() => mock.openEdit('w2'));
    await page.dispatchEvent('.update-button', 'pointerdown');
    await page.evaluate(() => { mock.submitEdit('w2', 'w3', 'two again', 'plain'); mock.complete('w3'); });
    await sleep(1400);
    await page.evaluate(() => { window.__bridge.length = 0; });
    await click('w3', 'prev');
    await sleep(300);
    const sets = await page.evaluate(() => window.__bridge.filter((b) => b.type === 'set-tip-override').length);
    assert.strictEqual(sets, 0);
    assert.ok(errors.slice(before).some((e) => /no Gemini ids saved/.test(e)), 'warned');
    errors.length = before; // expected warning, not noise
  });

  // ---- bridge.js: ids per turn, what gets inspected ----
  const bridgeJs = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  const bpage = await ctx.newPage();
  await bpage.route('**/*', (route) => {
    const u = route.request().url();
    if (/StreamGenerate/.test(u)) {
      // a stream of chunks that repeat the same ids, like Gemini's
      const chunk = (rc) => ')]}\'\n[["wrb.fr",null,"[[\\"c_abc123def456\\",\\"r_aaaaaaaa1111\\"],[[\\"rc_bbbbbbbb2222\\",[\\"hi' + rc + '\\"]],[\\"rc_cccccccc3333\\",[\\"draft\\"]]]]"]]\n';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: chunk('a') + chunk('ab') + chunk('abc') });
    }
    if (/batchexecute/.test(u)) return route.fulfill({ status: 200, contentType: 'text/plain', body: '[["wrb.fr","hNvQHb","[[[\\"c_abc123def456\\",\\"r_1111111111aa\\"],[[\\"rc_2222222222bb\\"]]],[[\\"c_abc123def456\\",\\"r_3333333333cc\\"],[[\\"rc_4444444444dd\\"]]]]"]]' });
    if (u.startsWith(ORIGIN)) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' });
    return route.abort();
  });
  await bpage.goto(URL);
  await bpage.addScriptTag({ content: bridgeJs });
  await bpage.evaluate(() => {
    window.__tips = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.source === 'better-gemini-bridge' && e.data.type === 'timelineTips') window.__tips.push(e.data.payload.tips); });
  });

  await step('bridge: a streamed reply yields its response id with the first choice', async () => {
    await bpage.evaluate(() => fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate', { method: 'POST', body: 'x' }).then((r) => r.text()));
    await sleep(300);
    const tips = await bpage.evaluate(() => window.__tips);
    assert.deepStrictEqual(tips, [[{ conversationId: 'c_abc123def456', responseId: 'r_aaaaaaaa1111', choiceId: 'rc_bbbbbbbb2222' }]]);
  });

  await step('bridge: a chat read yields an id pair for every turn', async () => {
    await bpage.evaluate(() => { window.__tips.length = 0; return fetch('/_/BardChatUi/data/batchexecute?rpcids=hNvQHb', { method: 'POST', body: 'x' }).then((r) => r.text()); });
    await sleep(300);
    const tips = await bpage.evaluate(() => window.__tips[0]);
    assert.deepStrictEqual(tips.map((t) => [t.responseId, t.choiceId]), [['r_1111111111aa', 'rc_2222222222bb'], ['r_3333333333cc', 'rc_4444444444dd']]);
  });

  await step('bridge: requests to anything else are not inspected', async () => {
    await bpage.evaluate(() => { window.__tips.length = 0; return fetch('/static/app.js').then((r) => r.text()).catch(() => ''); });
    await sleep(200);
    assert.deepStrictEqual(await bpage.evaluate(() => window.__tips), []);
  });

  const noise = errors.filter((e) => !/Failed to load resource|net::ERR/.test(e));
  await step('no script errors or warnings', async () => assert.deepStrictEqual(noise, []));

  await browser.close();
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
