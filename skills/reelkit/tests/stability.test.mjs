// Proves the stability engine waits for (or refuses) unstable pages.
// Run: npm test   (inside skills/reelkit)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launchBrowser, NetworkTracker } from '../scripts/lib/browser.mjs';
import { waitForStable } from '../scripts/lib/stability.mjs';

const PAGES = {
  '/slow-animation': `<style>.box{width:200px;height:200px;background:#7c5cff;animation:in 2.4s ease both}
    @keyframes in{from{opacity:0;transform:translateX(-80px)}to{opacity:1;transform:none}}</style><div class=box></div>`,
  '/skeleton-then-content': `<style>.skeleton{height:40px;background:#ddd;animation:p 1s infinite}@keyframes p{50%{opacity:.5}}</style>
    <div id=root><div class=skeleton></div></div>
    <script>setTimeout(()=>{root.innerHTML='<h1>Loaded</h1>'},2000)</script>`,
  '/skeleton-forever': `<div aria-busy="true" style="height:40px;background:#ddd">loading</div>`,
  '/infinite-decor': `<style>.blob{width:80px;height:80px;background:red;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style><div class=blob></div>`,
  '/broken-image': `<img src="/nope.png" width=100 height=100>`,
  '/slow-request': `<div id=out>…</div><script>fetch('/api/slow').then(r=>r.text()).then(t=>out.textContent=t)</script>`,
  '/ticking': `<div id=t style="font-size:40px"></div><script>let i=0;setInterval(()=>{t.textContent=i++},100)</script>`,
  '/stable': `<h1>Hello</h1><p>Nothing moves here.</p>`,
};

let server;
let browser;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/slow') return setTimeout(() => res.end('data arrived'), 1500);
    if (PAGES[req.url]) return res.end(`<!doctype html><html><body>${PAGES[req.url]}</body></html>`);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  server?.close();
});

const OPTS = { timeout: 6000, retries: 2, networkQuietMs: 300, diffThreshold: 0.0005, diffInterval: 300, consecutiveMatches: 2, busySelectors: [], allowInfinite: [], ignoreRequests: [] };

async function run(path, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  const net = new NetworkTracker(page);
  const t0 = Date.now();
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  const res = await waitForStable(page, net, { ...OPTS, ...opts });
  const ms = Date.now() - t0;
  const text = await page.textContent('body');
  await page.close();
  return { ...res, ms, text };
}

test('waits for a slow 2.4s entrance animation to finish', async () => {
  const r = await run('/slow-animation');
  assert.equal(r.ok, true);
  assert.ok(r.ms >= 2300, `captured too early (${r.ms}ms)`);
});

test('waits for a skeleton to be replaced by content', async () => {
  const r = await run('/skeleton-then-content');
  assert.equal(r.ok, true);
  assert.match(r.text, /Loaded/);
});

test('refuses a page whose skeleton never resolves', async () => {
  const r = await run('/skeleton-forever', { timeout: 1500 });
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'busy');
  assert.equal(r.attempts.length, 2, 'should retry before giving up');
});

test('refuses infinite decorative animations unless allowlisted', async () => {
  const bad = await run('/infinite-decor', { timeout: 4000, retries: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.gate, 'animations');
  assert.match(bad.reason, /allowInfinite/);
  const ok = await run('/infinite-decor', { allowInfinite: ['.blob'], diffThreshold: 0.2, retries: 1 });
  assert.equal(ok.ok, true);
});

test('fails on broken images with the URL in the reason', async () => {
  const r = await run('/broken-image', { retries: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'images');
  assert.match(r.reason, /nope\.png/);
});

test('waits for in-flight requests before capturing', async () => {
  const r = await run('/slow-request');
  assert.equal(r.ok, true);
  assert.match(r.text, /data arrived/);
});

test('pixel gate catches JS-driven changes that are not animations', async () => {
  const r = await run('/ticking', { timeout: 2500, retries: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.gate, 'pixels');
});

test('a stable page passes quickly', async () => {
  const r = await run('/stable');
  assert.equal(r.ok, true);
  assert.ok(r.ms < 4000, `took ${r.ms}ms`);
});
