/* Drives content.js against a minimal Gemini chat page.
   Run:  NODE_PATH="$(npm root -g)" node test/bar.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ORIGIN = 'https://gemini.google.com';
const contentJs = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');

// A chat list above a chat bar docked at the bottom, like an open chat.
const PAGE = `<!doctype html><html><head><style>${css}
body{margin:0;height:100vh;display:flex;flex-direction:column}
#chat{flex:1;overflow:auto}
.input-area-container{height:80px;margin:0 auto 20px;width:600px}
</style></head><body>
<div id="chat"><p>hello</p></div>
<input-container><div class="input-area-container"><div contenteditable="true"></div></div></input-container>
</body></html>`;

const CHROME_STUB = `
  const store = {};
  window.chrome = { runtime: { id: 'test', lastError: null }, storage: {
    sync: { get(keys, cb) { setTimeout(() => cb({ ...store }), 0); }, set(obj) { Object.assign(store, obj); } },
    onChanged: { addListener() {} } } };
`;

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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', (route) => route.request().url().startsWith(ORIGIN)
    ? route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
    : route.abort());
  await page.addInitScript({ content: CHROME_STUB });
  await page.addInitScript({ content: contentJs });
  await page.goto(`${ORIGIN}/app/abc123def456`);
  await page.waitForTimeout(800);

  await step('the docked chat bar is tagged and hidden', async () => {
    const info = await page.evaluate(() => ({
      tagged: document.querySelector('.input-area-container').classList.contains('hcb-bar'),
      docked: document.body.classList.contains('hcb-docked'),
      opacity: getComputedStyle(document.querySelector('.input-area-container')).opacity
    }));
    assert.deepStrictEqual(info, { tagged: true, docked: true, opacity: '0' });
  });

  await step('the settings button is placed, with only chat bar settings', async () => {
    const info = await page.evaluate(() => {
      const host = document.getElementById('hcb-pill-host');
      return { exists: Boolean(host), size: host && host.getBoundingClientRect().width };
    });
    assert.ok(info.exists, 'button host exists');
    assert.ok(!contentJs.includes('showUsage') && !contentJs.includes('showTimelines'), 'no usage or versions toggles');
  });

  await step('typing anywhere goes into the chat box and shows the bar', async () => {
    await page.click('#chat');
    await page.keyboard.type('hi');
    await page.waitForTimeout(300);
    const info = await page.evaluate(() => ({
      text: document.querySelector('[contenteditable]').textContent,
      draft: document.body.classList.contains('has-content'),
      opacity: getComputedStyle(document.querySelector('.input-area-container')).opacity
    }));
    assert.strictEqual(info.text, 'hi');
    assert.strictEqual(info.draft, true);
    assert.strictEqual(info.opacity, '1');
  });

  await step('no script errors or warnings', async () => assert.deepStrictEqual(errors, []));

  await browser.close();
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
})();
