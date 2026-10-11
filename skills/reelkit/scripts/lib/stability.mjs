import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { BUILTIN_BUSY } from './builtins.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GateError extends Error {
  constructor(gate, reason) {
    super(`${gate}: ${reason}`);
    this.gate = gate;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// In-page probes. Each runs inside the browser and returns plain data.
// ---------------------------------------------------------------------------

function probeImages() {
  const describe = (img) => (img.currentSrc || img.src || '').slice(0, 120);
  const visible = (el) => el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
  const loading = [];
  const broken = [];
  for (const img of document.images) {
    if (!visible(img)) continue;
    if (!img.complete) loading.push(describe(img));
    else if (img.naturalWidth === 0 && (img.currentSrc || img.src)) broken.push(describe(img));
  }
  return { loading, broken };
}

function probeBusy({ builtin, extra }) {
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
  };
  const visible = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const animated = (el) => el.getAnimations({ subtree: true }).some((a) => a.playState === 'running');
  const strong = /skeleton|shimmer|spinner/i;
  const hits = new Set();
  // Explicit signals: aria-busy, progressbars and user selectors always count.
  for (const sel of extra) for (const el of document.querySelectorAll(sel)) if (visible(el)) hits.add(describe(el));
  for (const sel of builtin) {
    let els;
    try {
      els = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of els) {
      if (!visible(el)) continue;
      const explicit = el.getAttribute('aria-busy') === 'true' || el.getAttribute('role') === 'progressbar' || el.dataset.loading === 'true';
      const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
      // Heuristic class names only count when they look unambiguous or are actually moving.
      if (explicit || strong.test(cls) || animated(el)) hits.add(describe(el));
    }
  }
  return [...hits].slice(0, 5);
}

function probeAnimations({ allowInfinite }) {
  const describe = (el) => {
    if (!el || !el.tagName) return 'document';
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
  };
  const out = [];
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running' && a.playState !== 'pending') continue;
    const target = a.effect && a.effect.target;
    const el = target && target.nodeType === 1 ? target : target?.element;
    if (el && el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) continue;
    const timing = a.effect ? a.effect.getComputedTiming() : {};
    const infinite = timing.iterations === Infinity || timing.endTime === Infinity;
    if (infinite && el && allowInfinite.length && el.closest(allowInfinite.join(','))) continue;
    const remaining = infinite ? Infinity : Math.max(0, (timing.endTime ?? 0) - (Number(a.currentTime) || 0));
    out.push({ el: describe(el), name: a.animationName || a.transitionProperty || a.id || 'animation', infinite, remaining });
  }
  return out;
}

async function scrollLazy(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const max = Math.min(document.documentElement.scrollHeight, 30000);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
}

async function waitNetworkQuiet(page, net, quietMs, deadline) {
  while (Date.now() < deadline) {
    if (net.quietFor() >= quietMs) return;
    await sleep(100);
  }
  const pending = net.pending();
  throw new GateError('network', pending.length ? `still loading ${pending.length} request(s), e.g. ${pending[0].slice(0, 100)}` : 'requests kept starting');
}

async function waitFonts(page, deadline) {
  const ok = await Promise.race([
    page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].every((f) => f.status !== 'loading');
    }),
    sleep(Math.max(0, deadline - Date.now())).then(() => false),
  ]);
  if (!ok) throw new GateError('fonts', 'web fonts did not finish loading');
}

async function waitImages(page, deadline) {
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(probeImages);
    if (last.broken.length) throw new GateError('images', `broken image ${last.broken[0]}`);
    if (!last.loading.length) return;
    await sleep(150);
  }
  throw new GateError('images', `${last.loading.length} image(s) still loading, e.g. ${last.loading[0]}`);
}

async function waitNotBusy(page, opts, deadline) {
  let hits = [];
  while (Date.now() < deadline) {
    hits = await page.evaluate(probeBusy, { builtin: BUILTIN_BUSY, extra: opts.busySelectors ?? [] });
    if (!hits.length) return;
    await sleep(150);
  }
  throw new GateError('busy', `loading indicator still visible: ${hits.join(', ')}`);
}

async function waitAnimations(page, opts, deadline) {
  let running = [];
  let infiniteSince = null;
  while (Date.now() < deadline) {
    running = await page.evaluate(probeAnimations, { allowInfinite: opts.allowInfinite ?? [] });
    if (!running.length) return;
    const finite = running.filter((a) => !a.infinite);
    if (!finite.length) {
      // Only infinite animations left: they will never settle on their own.
      infiniteSince ??= Date.now();
      if (Date.now() - infiniteSince > 2500) break;
      await sleep(200);
      continue;
    }
    infiniteSince = null;
    const wait = Math.min(Math.max(...finite.map((a) => a.remaining)) + 60, 1500);
    await sleep(Math.max(80, wait));
  }
  const a = running[0];
  if (a?.infinite) {
    throw new GateError('animations', `infinite animation "${a.name}" on ${a.el}; hide it or add it to stability.allowInfinite`);
  }
  throw new GateError('animations', `${running.length} animation(s) still running, e.g. "${a?.name}" on ${a?.el}`);
}

async function waitPixels(page, opts, deadline) {
  const need = opts.consecutiveMatches ?? 2;
  const threshold = opts.diffThreshold ?? 0.0005;
  const grab = async () => PNG.sync.read(await page.screenshot({ scale: 'css', caret: 'hide', animations: 'allow' }));
  let prev = await grab();
  let streak = 0;
  let lastRatio = 1;
  while (Date.now() < deadline) {
    await sleep(opts.diffInterval ?? 400);
    const cur = await grab();
    if (cur.width !== prev.width || cur.height !== prev.height) {
      prev = cur;
      streak = 0;
      continue;
    }
    const diff = pixelmatch(prev.data, cur.data, null, cur.width, cur.height, { threshold: 0.1 });
    lastRatio = diff / (cur.width * cur.height);
    streak = lastRatio <= threshold ? streak + 1 : 0;
    if (streak >= need) return { diffRatio: lastRatio };
    prev = cur;
  }
  throw new GateError('pixels', `page kept changing (${(lastRatio * 100).toFixed(2)}% of pixels between frames)`);
}

export async function waitForCondition(page, waitFor, timeout) {
  if (!waitFor) return;
  if (typeof waitFor === 'string') {
    await page.locator(waitFor).first().waitFor({ state: 'visible', timeout });
  } else if (waitFor.selector) {
    await page.locator(waitFor.selector).first().waitFor({ state: 'visible', timeout: waitFor.timeout ?? timeout });
  } else if (waitFor.text) {
    await page.getByText(waitFor.text, { exact: false }).first().waitFor({ state: 'visible', timeout: waitFor.timeout ?? timeout });
  }
}

/**
 * One full pass through every gate. Throws GateError naming the first gate that failed.
 * Returns timings per gate for the QA report.
 */
export async function stabilizeOnce(page, net, opts, { budget, scrollY = null, lazy = true } = {}) {
  const t0 = Date.now();
  const deadline = t0 + budget;
  const checks = {};
  const mark = (name, start) => (checks[name] = { ok: true, ms: Date.now() - start });
  let s = Date.now();
  await waitNetworkQuiet(page, net, opts.networkQuietMs ?? 500, deadline);
  mark('network', s);
  s = Date.now();
  await waitFonts(page, deadline);
  mark('fonts', s);
  if (lazy && opts.scrollLazy !== false) {
    s = Date.now();
    await scrollLazy(page);
    await waitNetworkQuiet(page, net, opts.networkQuietMs ?? 500, deadline);
    mark('lazy', s);
  }
  if (scrollY !== null) await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  s = Date.now();
  await waitImages(page, deadline);
  mark('images', s);
  s = Date.now();
  await waitNotBusy(page, opts, deadline);
  mark('busy', s);
  s = Date.now();
  await waitAnimations(page, opts, deadline);
  mark('animations', s);
  s = Date.now();
  const { diffRatio } = await waitPixels(page, opts, deadline);
  checks.pixels = { ok: true, ms: Date.now() - s, diffRatio };
  return { checks, ms: Date.now() - t0 };
}

/**
 * Retry with escalating waits. Never throws for instability: returns
 * { ok:false, reason } so the caller can mark the asset FAILED instead of shipping it.
 */
export async function waitForStable(page, net, opts, { scrollY = null, onRetry, reload } = {}) {
  const retries = opts.retries ?? 3;
  const attempts = [];
  for (let i = 0; i < retries; i++) {
    const budget = Math.round((opts.timeout ?? 15000) * (1 + i * 0.5));
    try {
      const res = await stabilizeOnce(page, net, opts, { budget, scrollY, lazy: i === 0 || !!reload });
      attempts.push({ ok: true, ms: res.ms });
      return { ok: true, checks: res.checks, attempts };
    } catch (err) {
      if (!(err instanceof GateError)) throw err;
      attempts.push({ ok: false, gate: err.gate, reason: err.reason });
      if (i < retries - 1) {
        onRetry?.(i + 1, err);
        await sleep(1000 * (i + 1) ** 2);
        // Last chance: a fresh load sometimes clears stuck states (e.g. a hung lazy chunk).
        if (i === retries - 2 && reload) await reload();
      }
    }
  }
  const last = attempts[attempts.length - 1];
  return { ok: false, gate: last.gate, reason: last.reason, attempts };
}

export { GateError };
