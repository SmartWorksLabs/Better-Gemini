/* Drives bridge.js and usage.js against a minimal Gemini page.
   Run:  NODE_PATH="$(npm root -g)" node test/usage.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ORIGIN = 'https://gemini.google.com';
const URL = `${ORIGIN}/app/abc123def456`;
const bridgeJs = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
const usageJs = fs.readFileSync(path.join(__dirname, '..', 'usage.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');

// A chat bar and the disclaimer under it, plus a chrome.* stub.
const PAGE = `<!doctype html><html><head><style>${css}
.input-area-container{position:fixed;left:200px;width:600px;bottom:40px;height:60px}
</style></head><body>
<div class="input-area-container"><div contenteditable="true"></div></div>
</body></html>`;

// chrome.* stub, installed before the content script like the real extension APIs.
const CHROME_STUB = `  const store = { sync: {}, local: {} };
  const mk = (k) => ({
    get(keys, cb) { const o = {}; [].concat(keys).forEach((x) => { if (x in store[k]) o[x] = store[k][x]; }); setTimeout(() => cb(o), 0); },
    set(obj, cb) { Object.assign(store[k], obj); if (k === 'sync' && window.__onChanged) { const c = {}; Object.keys(obj).forEach((x) => { c[x] = { newValue: obj[x] }; }); window.__onChanged(c, 'sync'); } setTimeout(() => cb && cb(), 0); }
  });
  window.chrome = { runtime: { id: 'test', lastError: null }, storage: { local: mk('local'), sync: mk('sync'), onChanged: { addListener(fn) { window.__onChanged = fn; } } } };
`;

const metric = (fraction, period) => [null, fraction, period, [[1900000000]]];
const USAGE_REPLY = ")]}'\n" + JSON.stringify([['wrb.fr', 'jSf9Qc', JSON.stringify([[metric(0.42, 1), metric(0.93, 2)]])]]);

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

  let usageHtml = '';
  let streamBody = null;
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (/StreamGenerate/.test(u)) {
      streamBody = route.request().postData();
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ')]}\'\n{"usageMetadata":{"promptTokenCount":1200,"candidatesTokenCount":300,"totalTokenCount":1500}}\n' });
    }
    if (/batchexecute/.test(u)) return route.fulfill({ status: 200, contentType: 'text/plain', body: USAGE_REPLY });
    if (/\/usage$/.test(u)) return route.fulfill({ status: 200, contentType: 'text/html', body: usageHtml });
    if (u.startsWith(ORIGIN)) return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': "require-trusted-types-for 'script'" }, body: PAGE });
    return route.abort();
  });
  const prepare = async (p) => {
    await p.addInitScript(() => { window.WIZ_global_data = { SNlM0e: 'token' }; });
    await p.addInitScript({ content: bridgeJs }); // like the extension: document_start, before the page
  };
  await prepare(page);

  const planFor = async (html) => {
    usageHtml = html;
    return page.evaluate(() => new Promise((resolve) => {
      const onMsg = (e) => { if (e.data && e.data.source === 'gemini-usage-bridge' && e.data.type === 'usage') { window.removeEventListener('message', onMsg); resolve(e.data.payload); } };
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'gemini-usage-bridge-cmd', type: 'fetch-usage', id: 'u1' }, location.origin);
      setTimeout(() => resolve({ timeout: true }), 3000);
    }));
  };

  await page.goto(URL);

  await step('bridge: Current and Weekly usage are read from the limits RPC', async () => {
    const res = await planFor('');
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.usage.current.percent, 42);
    assert.strictEqual(res.usage.weekly.percent, 93);
  });

  await step('bridge: plan is read from the usage page under Trusted Types, without errors', async () => {
    const cases = [
      ['<usage-metrics-window><div class="usage-metrics-header"><span>Google AI</span> <span>Pro</span></div></usage-metrics-window>', 'PRO'],
      ['<div class="usage-metrics-header"><b>ULTRA</b></div>', 'ULTRA'],
      ['<script>var x={"tier":"PLUS"};</script><p>nothing here</p>', 'PLUS'],
      ['<p>Upgrade to Pro for more</p>', null]
    ];
    for (const [html, want] of cases) {
      const res = await planFor(html);
      assert.strictEqual(res.tier || null, want, html + ' -> ' + JSON.stringify(res));
    }
    assert.deepStrictEqual(errors.filter((e) => /TrustedHTML/.test(e)), []);
  });

  await step('bridge: token counts in a reply are reported, and the request is sent unchanged', async () => {
    const meta = await page.evaluate(() => new Promise((resolve) => {
      window.addEventListener('message', (e) => { if (e.data && e.data.source === 'gemini-usage-bridge' && e.data.type === 'usageMetadata') resolve(e.data.payload); });
      fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate', { method: 'POST', body: 'f.req=%5B%5D&at=token' });
      setTimeout(() => resolve(null), 3000);
    }));
    assert.strictEqual(meta && meta.totalTokenCount, 1500);
    assert.strictEqual(streamBody, 'f.req=%5B%5D&at=token');
  });

  // The content script on a fresh page, as Chrome would load it.
  usageHtml = '<div class="usage-metrics-header"><b>PRO</b></div>';
  const upage = await ctx.newPage();
  upage.on('pageerror', (e) => errors.push(e.message));
  upage.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') errors.push(m.text()); });
  await prepare(upage);
  await upage.addInitScript({ content: CHROME_STUB });
  await upage.addInitScript({ content: usageJs });
  await upage.goto(URL);
  await sleep(1500);

  await step('footer: usage pills and context line sit under the chat bar', async () => {
    const info = await upage.evaluate(() => {
      const f = document.getElementById('gemini-usage-footer');
      const bar = document.querySelector('.input-area-container').getBoundingClientRect();
      return {
        placed: f.classList.contains('placed'),
        left: parseInt(f.style.left, 10),
        width: parseInt(f.style.width, 10),
        usage: f.querySelector('.gemini-usage-pills').textContent,
        level: f.querySelector('.gemini-usage-pills').className,
        context: f.querySelector('.gemini-usage-context').textContent,
        barLeft: Math.round(bar.left),
        barWidth: Math.round(bar.width)
      };
    });
    assert.ok(info.placed, 'footer is shown');
    assert.strictEqual(info.left, info.barLeft);
    assert.strictEqual(info.width, info.barWidth);
    assert.ok(info.usage.includes('Current Usage·42%'), info.usage);
    assert.ok(info.usage.includes('Weekly Usage·93%'), info.usage);
    assert.ok(info.level.includes('level-danger'), 'worst of the two sets the colour');
    assert.ok(/Context Window·.+ \/ 1M/.test(info.context), info.context);
  });

  await step('popup settings hide each part, and both hide the footer', async () => {
    await upage.evaluate(() => chrome.storage.sync.set({ showUsage: false }));
    await sleep(100);
    let state = await upage.evaluate(() => [document.querySelector('.gemini-usage-pills').hidden, document.getElementById('gemini-usage-footer').hidden]);
    assert.deepStrictEqual(state, [true, false]);
    await upage.evaluate(() => chrome.storage.sync.set({ showContext: false }));
    await sleep(100);
    state = await upage.evaluate(() => document.getElementById('gemini-usage-footer').hidden);
    assert.strictEqual(state, true);
  });

  const noise = errors.filter((e) => !/Failed to load resource|net::ERR/.test(e));
  await step('no script errors or warnings', async () => assert.deepStrictEqual(noise, []));

  await browser.close();
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
