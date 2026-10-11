import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { ENV_PREFIX, NAME } from './brand.mjs';
import { ReelkitError, log } from './log.mjs';
import { expandEnvDeep } from './env.mjs';
import { BUILTIN_HIDE } from './builtins.mjs';

function candidateExecutables() {
  const out = [];
  if (process.env[`${ENV_PREFIX}_CHROMIUM`]) out.push(process.env[`${ENV_PREFIX}_CHROMIUM`]);
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(root, d, rel);
        if (existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

/** Launch Chromium; if Playwright's pinned build is missing, fall back to any installed one. */
export function extraArgs() {
  return (process.env[`${ENV_PREFIX}_CHROMIUM_ARGS`] ?? '').split(/\s+/).filter(Boolean);
}

export async function launchBrowser({ headless = true } = {}) {
  const args = ['--hide-scrollbars', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', ...extraArgs()];
  try {
    return await chromium.launch({ headless, args });
  } catch (err) {
    if (!/Executable doesn't exist|browserType\.launch/i.test(err.message)) throw err;
    for (const executablePath of candidateExecutables()) {
      try {
        const b = await chromium.launch({ headless, args, executablePath });
        log.dim(`  using Chromium at ${executablePath}`);
        return b;
      } catch {
        /* try next */
      }
    }
    throw new ReelkitError('Chromium for Playwright is not installed.', `Run: npx playwright install chromium   (or set ${ENV_PREFIX}_CHROMIUM=/path/to/chrome)`);
  }
}

export function hideCss({ hide = [], mask = [], builtins = true, motion = false, keepBackdropBlur = false }) {
  const hidden = [...(builtins ? BUILTIN_HIDE : []), ...hide];
  return [
    hidden.length ? `${hidden.join(',\n')} { display: none !important; }` : '',
    mask.length ? `${mask.join(',\n')} { filter: blur(7px) saturate(0.6) !important; }` : '',
    '* { caret-color: transparent !important; }',
    // Headless Chromium renders backdrop blur in software: at 2x it drops recordings to ~3 fps.
    motion && !keepBackdropBlur ? '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }' : '',
    'html { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }',
  ].join('\n');
}

// Runs in the page before any app script. Keeps our stylesheet attached even if the app
// replaces <head> children (frameworks do this during hydration).
function installStyleScript({ css, id }) {
  const attach = () => {
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    (document.head || document.documentElement)?.appendChild(el);
  };
  if (document.documentElement) attach();
  new MutationObserver(attach).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', attach);
}

/**
 * Tracks in-flight requests so "network idle" means *our* page is idle, not
 * Playwright's 500ms heuristic which never fires on sites with polling.
 */
export class NetworkTracker {
  constructor(page, ignore = []) {
    this.inflight = new Map();
    this.last = Date.now();
    this.mainStatus = null;
    this.ignore = ignore;
    const skip = (req) => ['websocket', 'eventsource', 'manifest'].includes(req.resourceType()) || this.ignore.some((p) => req.url().includes(p));
    page.on('request', (req) => {
      if (skip(req)) return;
      this.inflight.set(req, Date.now());
      this.last = Date.now();
    });
    const done = (req) => {
      if (this.inflight.delete(req)) this.last = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    page.on('response', (res) => {
      if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) this.mainStatus = res.status();
    });
  }
  /** Long-lived requests (>10s) are treated as streaming/long-poll and ignored. */
  pending() {
    const now = Date.now();
    return [...this.inflight.entries()].filter(([, t]) => now - t < 10_000).map(([r]) => r.url());
  }
  quietFor() {
    return this.pending().length ? 0 : Date.now() - this.last;
  }
}

export function contextOptions(cfg, shot, { motion = false, authFile } = {}) {
  const v = shot.viewport;
  const opts = {
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.deviceScaleFactor,
    isMobile: !!v.mobile,
    hasTouch: !!(v.mobile || v.touch),
    colorScheme: shot.theme,
    reducedMotion: motion ? 'no-preference' : 'reduce',
    locale: cfg.determinism.locale,
    timezoneId: cfg.determinism.timezone,
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
  };
  const headers = expandEnvDeep(cfg.headers ?? {}, 'headers');
  if (Object.keys(headers).length) opts.extraHTTPHeaders = headers;
  if (shot.scene.auth) {
    if (!authFile || !existsSync(authFile)) {
      throw new ReelkitError(`Scene "${shot.scene.name}" needs auth but no saved session exists.`, `Run \`${NAME} auth\` first.`, { code: 3 });
    }
    opts.storageState = authFile;
  }
  return opts;
}

/** A fully prepared page for one shot: deterministic clock, hidden noise, network tracking. */
export async function openPage(browser, cfg, shot, { motion = false } = {}) {
  const context = await browser.newContext(contextOptions(cfg, shot, { motion, authFile: cfg.authFile }));
  if (cfg.determinism.time) {
    await context.clock.install({ time: new Date(cfg.determinism.time) });
  }
  const css = hideCss({ hide: shot.scene.hide, mask: shot.scene.mask, builtins: cfg.determinism.hideBuiltins, motion, keepBackdropBlur: cfg.motion.keepBackdropBlur });
  await context.addInitScript(installStyleScript, { css, id: `${NAME}-hide` });
  const page = await context.newPage();
  page.setDefaultTimeout(shot.scene.stability.timeout);
  const net = new NetworkTracker(page, shot.scene.stability.ignoreRequests);
  return { context, page, net };
}
