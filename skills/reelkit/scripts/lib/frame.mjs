import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { TEMPLATES_DIR } from './brand.mjs';
import { ReelkitError, c, log } from './log.mjs';
import { absoluteUrl, shotsFor } from './config.mjs';
import { ensureDir, rel } from './fsutil.mjs';
import { loadResults, saveResult } from './state.mjs';
import { inspectPng } from './imagecheck.mjs';
import { stillName } from './shoot.mjs';
import { encodeOutputs, masterPath, motionBase } from './record.mjs';
import { tools } from './deps.mjs';
import { extractFrame, ffmpeg, probe } from './media.mjs';
import { screenGeometry } from './authenticity.mjs';

const BACKGROUNDS = JSON.parse(readFileSync(path.join(TEMPLATES_DIR, 'backgrounds.json'), 'utf8'));
const TEMPLATE = pathToFileURL(path.join(TEMPLATES_DIR, 'frame.html')).href;

function luminance(hex) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return 0;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function background(cfg, theme, { opaque = false } = {}) {
  let name = theme === 'dark' ? cfg.frame.backgroundDark : cfg.frame.background;
  if (opaque && name === 'transparent') name = theme === 'dark' ? 'midnight' : 'paper';
  const preset = BACKGROUNDS[name];
  if (preset) return { css: preset.css, dark: preset.dark, transparent: name === 'transparent' };
  const dark = /^#/.test(name) ? luminance(name) < 0.5 : true;
  return { css: name, dark, transparent: false };
}

export function deviceType(viewport) {
  return viewport.device ?? (viewport.mobile ? 'phone' : viewport.width < 1100 ? 'tablet' : 'browser');
}

function urlLabel(cfg, scene) {
  if (cfg.frame.url === 'none') return '';
  if (cfg.frame.url) return cfg.frame.url;
  try {
    const u = new URL(absoluteUrl(cfg, scene.url));
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '';
  }
}

/** Average colour of the top edge of a screenshot, for a phone status bar that blends in. */
function topBar(file) {
  try {
    const png = PNG.sync.read(readFileSync(file));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < Math.min(6, png.height); y++) {
      for (let x = 0; x < png.width; x += 4) {
        const i = (y * png.width + x) * 4;
        r += png.data[i];
        g += png.data[i + 1];
        b += png.data[i + 2];
        n++;
      }
    }
    [r, g, b] = [r / n, g / n, b / n].map(Math.round);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return { bg: `rgb(${r},${g},${b})`, fg: lum > 0.55 ? '#0b0b0f' : '#ffffff' };
  } catch {
    return null;
  }
}

export function spec(cfg, shot, src, { barFrom } = {}) {
  const type = deviceType(shot.viewport);
  return {
    type,
    w: shot.viewport.width,
    h: shot.viewport.height,
    src: src ? pathToFileURL(src).href : null,
    chrome: shot.theme,
    url: urlLabel(cfg, shot.scene),
    bar: type === 'phone' ? topBar(barFrom ?? src) : null,
  };
}

/** Render the template once and screenshot the canvas. Returns canvas + screen rects in CSS px. */
export async function render(browser, opts, { dsf, out, mode = 'full', screenOnly = false, entry = 'render' }) {
  const page = await browser.newPage({ viewport: { width: 4200, height: 3200 }, deviceScaleFactor: dsf });
  try {
    await page.goto(TEMPLATE);
    const rects = await page.evaluate(({ fn, o }) => window[fn](o), { fn: entry, o: { ...opts, mode } });
    const clip = screenOnly ? rects.screen : { x: 0, y: 0, w: rects.canvas.w, h: rects.canvas.h };
    await page.screenshot({
      path: out,
      clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h },
      omitBackground: mode === 'overlay' || (mode !== 'mask' && opts.transparent),
      animations: 'disabled',
    });
    return rects;
  } finally {
    await page.close();
  }
}

export function baseOpts(cfg, theme, extra = {}) {
  const bg = background(cfg, theme, { opaque: extra.opaque });
  return {
    layout: 'single',
    background: bg.css,
    darkBg: bg.dark,
    transparent: bg.transparent,
    accent: cfg.frame.accent,
    padding: cfg.frame.padding,
    radius: cfg.frame.radius,
    shadow: cfg.frame.shadow,
    ...extra,
  };
}

function record(cfg, out, meta, status = 'PASS', reason) {
  const img = existsSync(out) ? inspectPng(out) : null;
  const st = img?.problems.length ? 'FAILED' : status;
  saveResult(cfg, rel(cfg.outDir, out), { ...meta, status: st, reason: reason ?? img?.problems.join('; ') ?? undefined, image: img ?? undefined });
  if (st === 'PASS') log.ok(`${rel(cfg.root, out)} ${c.dim(`${img.width}×${img.height}`)}`);
  else log.fail(`${rel(cfg.root, out)}: FAILED (${reason ?? img?.problems.join('; ')})`);
  return st === 'PASS';
}

export function sourceOk(cfg, file) {
  const r = loadResults(cfg).assets[file];
  return r?.status === 'PASS' && existsSync(path.join(cfg.outDir, file));
}

async function frameStills(cfg, scenes, browser) {
  let failed = 0;
  for (const scene of scenes.filter((s) => s.isStill && s.outputs.includes('framed'))) {
    for (const shot of shotsFor(scene)) {
      const src = stillName(shot);
      const out = path.join(cfg.outDir, `${shot.id}-framed.png`);
      rmSync(out, { force: true });
      const meta = { scene: scene.name, viewport: shot.viewport.name, theme: shot.theme, kind: 'framed', from: src };
      if (!sourceOk(cfg, src)) {
        failed++;
        saveResult(cfg, rel(cfg.outDir, out), { ...meta, status: 'FAILED', reason: `source ${src} did not pass capture` });
        log.fail(`${rel(cfg.root, out)}: skipped, source ${src} is missing or FAILED`);
        continue;
      }
      const dsf = shot.viewport.deviceScaleFactor;
      const rects = await render(browser, baseOpts(cfg, shot.theme, { devices: [spec(cfg, shot, path.join(cfg.outDir, src))] }), { dsf, out });
      // Metadata only: lets `verify` prove the screen region is the untouched capture.
      if (!record(cfg, out, { ...meta, screen: screenGeometry(rects, dsf) })) failed++;
    }
  }
  return failed;
}

async function frameVideos(cfg, scenes, browser) {
  let failed = 0;
  for (const scene of scenes.filter((s) => s.isMotion && s.outputs.includes('framed'))) {
    for (const shot of shotsFor(scene)) {
      const base = motionBase(scene, shot);
      const master = masterPath(cfg, base);
      const meta = { scene: scene.name, viewport: shot.viewport.name, theme: shot.theme };
      const sourceFile = scene.outputs.includes('mp4') || scene.outputs.includes('gif') ? `${base}.mp4` : null;
      if (!existsSync(master) || (sourceFile && !sourceOk(cfg, sourceFile))) {
        failed++;
        saveResult(cfg, `${base}-framed.mp4`, { ...meta, kind: 'mp4', status: 'FAILED', reason: 'recording missing or FAILED' });
        log.fail(`${base}-framed: skipped, recording is missing or FAILED (run record first)`);
        continue;
      }
      const v = probe(master);
      const dsf = v.width / shot.viewport.width;
      const work = ensureDir(path.join(cfg.workDir, 'video'));
      const files = { base: path.join(work, `${base}.frame-base.png`), mask: path.join(work, `${base}.frame-mask.png`), over: path.join(work, `${base}.frame-over.png`) };
      const first = path.join(work, `${base}.first.png`);
      await extractFrame(master, 0, first);
      const opts = baseOpts(cfg, shot.theme, { devices: [spec(cfg, shot, null, { barFrom: first })], opaque: true });
      const rects = await render(browser, opts, { dsf, out: files.base, mode: 'hole' });
      await render(browser, opts, { dsf, out: files.mask, mode: 'mask', screenOnly: true });
      await render(browser, opts, { dsf, out: files.over, mode: 'overlay' });
      const px = (n) => Math.round(n * dsf);
      const sw = px(rects.screen.w);
      const sh = px(rects.screen.h);
      const framedMaster = path.join(work, `${base}-framed.master.mp4`);
      await ffmpeg([
        '-loop', '1', '-i', files.base,
        '-i', master,
        '-loop', '1', '-i', files.mask,
        '-loop', '1', '-i', files.over,
        '-filter_complex',
        // Crop from the top to the viewport's aspect (a phone status bar takes the top of the screen).
        `[1:v]crop=iw:min(ih\\,trunc(iw*${sh}/${sw}/2)*2):0:0,scale=${sw}:${sh}:flags=lanczos,format=rgba[v];[2:v]scale=${sw}:${sh},format=gray[m];[v][m]alphamerge[vm];` +
          `[0:v][vm]overlay=${px(rects.screen.x)}:${px(rects.screen.y)}:shortest=1[a];[a][3:v]overlay=0:0:shortest=1,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[out]`,
        '-map', '[out]', '-t', v.duration.toFixed(3), '-r', String(cfg.motion.fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', framedMaster,
      ]);
      const outs = await encodeOutputs(cfg, framedMaster, `${base}-framed`, {
        wantGif: scene.outputs.includes('gif'),
        wantMp4: true,
        zoomed: loadResults(cfg).assets[`${base}.mp4`]?.events?.some((e) => e.zoom > 1),
      });
      const src = loadResults(cfg).assets[`${base}.mp4`] ?? {};
      for (const o of outs) {
        const p = probe(o.file);
        const ok = o.kind !== 'gif' || o.gif.underBudget;
        saveResult(cfg, rel(cfg.outDir, o.file), {
          ...meta,
          kind: o.kind,
          framed: true,
          status: ok ? 'PASS' : 'FAILED',
          reason: ok ? undefined : 'GIF over budget',
          duration: p?.duration,
          width: p?.width,
          height: p?.height,
          events: src.events,
          gif: o.gif?.settings,
        });
        log.ok(`${rel(cfg.root, o.file)} ${c.dim(`${p?.width}×${p?.height} · ${(statSync(o.file).size / 1e6).toFixed(2)} MB`)}`);
        if (!ok) failed++;
      }
    }
  }
  return failed;
}

export function findShot(cfg, scenes, name, viewportName, theme) {
  const scene = scenes.find((s) => s.name === name);
  if (!scene) return null;
  const shot = shotsFor(scene).find((s) => (!viewportName || s.viewport.name === viewportName || (viewportName === 'desktop' && s.viewport.name === 'wide')) && (!theme || s.theme === theme));
  if (!shot) return null;
  const file = stillName(shot);
  return sourceOk(cfg, file) ? { shot, file: path.join(cfg.outDir, file) } : null;
}

async function marketing(cfg, allScenes, browser) {
  let failed = 0;
  const m = cfg.marketing ?? {};
  const desktopOf = (name, theme) => findShot(cfg, allScenes, name, 'desktop', theme) ?? findShot(cfg, allScenes, name, null, theme);
  const tagline = cfg.tagline ?? '';

  // README hero (still): the hero scene's desktop shot with the product name on top.
  const heroScene = m.hero ? allScenes.find((s) => s.name === m.hero) : null;
  if (heroScene && !heroScene.isMotion) {
    for (const theme of ['light', 'dark']) {
      const src = desktopOf(heroScene.name, theme);
      if (!src) continue;
      const out = path.join(cfg.outDir, `hero-${theme}.png`);
      const rects = await render(browser, baseOpts(cfg, theme, { padding: Math.round(cfg.frame.padding * 1.25), title: cfg.name, caption: tagline, devices: [spec(cfg, src.shot, src.file)] }), { dsf: 2, out });
      // The hero renders at 2x; the screen is 1:1 with the capture only when the capture is 2x too.
      const oneToOne = src.shot.viewport.deviceScaleFactor === 2;
      const extra = oneToOne ? { from: path.basename(src.file), screen: screenGeometry(rects, 2) } : {};
      if (!record(cfg, out, { scene: heroScene.name, theme, kind: 'hero', ...extra })) failed++;
    }
  }

  // Responsive trio: desktop + tablet + phone of one scene, overlapping.
  if (m.trio) {
    for (const theme of ['light', 'dark']) {
      const big = desktopOf(m.trio, theme);
      const tab = findShot(cfg, allScenes, m.trio, 'tablet', theme);
      const ph = findShot(cfg, allScenes, m.trio, 'mobile', theme);
      if (!big || !tab || !ph) {
        if (theme === 'light') log.warn(`Trio needs ${m.trio} at desktop, tablet and mobile (${theme}); add those viewports to the scene.`);
        continue;
      }
      const out = path.join(cfg.outDir, `${m.trio}-trio-${theme}.png`);
      const devices = [spec(cfg, big.shot, big.file), spec(cfg, tab.shot, tab.file), spec(cfg, ph.shot, ph.file)];
      if (devices[0].type === 'browser') devices[0].type = 'laptop';
      await render(browser, baseOpts(cfg, theme, { layout: 'trio', width: 1800, height: 1060, padding: 80, devices }), { dsf: 1.5, out });
      if (!record(cfg, out, { scene: m.trio, theme, kind: 'trio' })) failed++;
    }
  }

  // GitHub social preview: exactly 1280×640.
  if (m.social?.scene) {
    const theme = findShot(cfg, allScenes, m.social.scene, null, 'dark') ? 'dark' : 'light';
    const src = desktopOf(m.social.scene, theme);
    if (src) {
      const out = path.join(cfg.outDir, 'social-preview.png');
      const opts = baseOpts(cfg, theme, {
        layout: 'social',
        opaque: true,
        brand: cfg.name ?? '',
        title: m.social.title ?? cfg.name ?? '',
        caption: m.social.subtitle ?? tagline,
        devices: [spec(cfg, src.shot, src.file)],
      });
      await render(browser, opts, { dsf: 1, out });
      if (!record(cfg, out, { scene: m.social.scene, theme, kind: 'social' })) failed++;
    } else {
      log.warn(`Social preview needs a passing still of "${m.social.scene}".`);
    }
  }
  return failed;
}

export async function frameAll(cfg, scenes, { browser }) {
  log.step('Framing…');
  ensureDir(cfg.outDir);
  let failed = await frameStills(cfg, scenes, browser);
  if (scenes.some((s) => s.isMotion && s.outputs.includes('framed'))) {
    if (!tools().ffmpeg) throw new ReelkitError('ffmpeg is required to frame recordings.', 'Run `reelkit preflight` for the install command.');
    failed += await frameVideos(cfg, scenes, browser);
  }
  // Marketing assets combine scenes, so they use every scene's latest capture.
  const { selectScenes } = await import('./config.mjs');
  failed += await marketing(cfg, selectScenes(cfg, []), browser);
  return { failed };
}
