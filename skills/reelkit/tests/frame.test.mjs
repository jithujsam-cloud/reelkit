// Phase 0 regression baseline for the framing renderer.
//
// Uses synthetic, deterministic "captures" (a high-frequency pattern that exposes any offset or
// resampling) and the real renderer + real config defaults. Assertions are chosen to be stable across
// Linux/macOS/Windows: exact geometry, exact screen pixels, and background colour probes with a
// perceptual tolerance. Whole-image comparisons are avoided on purpose: the browser URL bar and
// headings use the platform's UI font, which legitimately differs between operating systems.
//
// To re-record after an INTENTIONAL renderer change:  REELKIT_UPDATE_BASELINE=1 npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { launchBrowser } from '../scripts/lib/browser.mjs';
import { loadConfig, resolveScene, shotsFor } from '../scripts/lib/config.mjs';
import { baseOpts, render, spec } from '../scripts/lib/frame.mjs';
import { compareScreenRegion, screenGeometry } from '../scripts/lib/authenticity.mjs';
import { deltaEOK } from '../scripts/lib/color.mjs';
import { TEMPLATES_DIR } from '../scripts/lib/brand.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(here, 'fixtures', 'frame-baseline.json');
const UPDATE = process.env.REELKIT_UPDATE_BASELINE === '1';
const PROBE_TOLERANCE = 0.02; // ΔEok: about one just-noticeable difference

let browser;
let dir;
let cfg;
const recorded = {};
const baseline = UPDATE ? {} : JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));

/** Deterministic test pattern: unique-ish colour per pixel, sharp edges every 8px. */
function pattern(width, height) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = (x * 7 + y * 3) & 255;
      png.data[i + 1] = (x ^ y) & 255;
      png.data[i + 2] = (((x >> 3) + (y >> 3)) * 16) & 255;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

function pixel(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'reelkit-frame-'));
  // A minimal config: everything else comes from the real built-in defaults.
  writeFileSync(
    path.join(dir, 'reelkit.config.yaml'),
    [
      'baseUrl: http://localhost:3000',
      'scenes:',
      '  - name: fx',
      '    url: /fx',
      '    theme: both',
      '    viewports: [desktop, tablet, mobile, wide, { name: square, width: 400, height: 300, device: none }]',
    ].join('\n'),
  );
  cfg = loadConfig(path.join(dir, 'reelkit.config.yaml'));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  if (UPDATE) writeFileSync(BASELINE_FILE, `${JSON.stringify(recorded, null, 2)}\n`);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function check(key, actual) {
  recorded[key] = actual;
  if (UPDATE) return;
  const want = baseline[key];
  assert.ok(want, `no baseline for ${key}; run with REELKIT_UPDATE_BASELINE=1 once`);
  assert.deepEqual(actual.canvas, want.canvas, `${key}: canvas size changed`);
  if (want.screen) assert.deepEqual(actual.screen, want.screen, `${key}: screen geometry changed`);
  for (const [name, rgb] of Object.entries(want.probes ?? {})) {
    const d = deltaEOK(actual.probes[name], rgb);
    assert.ok(d <= PROBE_TOLERANCE, `${key}: background probe ${name} drifted (ΔEok ${d.toFixed(4)}; ${actual.probes[name]} vs ${rgb})`);
  }
}

test('built-in frame defaults are unchanged (Phase 0 must not restyle anything)', () => {
  assert.deepEqual(
    { background: cfg.frame.background, backgroundDark: cfg.frame.backgroundDark, accent: cfg.frame.accent, padding: cfg.frame.padding, radius: cfg.frame.radius, shadow: cfg.frame.shadow },
    { background: 'aurora', backgroundDark: 'midnight', accent: '#7c5cff', padding: 72, radius: 12, shadow: true },
  );
  // Hash the parsed presets, not the file bytes: Git may check text out with CRLF on Windows.
  const presets = JSON.parse(readFileSync(path.join(TEMPLATES_DIR, 'backgrounds.json'), 'utf8'));
  const hash = createHash('sha256').update(JSON.stringify(presets)).digest('hex');
  recorded.backgroundsJson = hash;
  if (!UPDATE) assert.equal(hash, baseline.backgroundsJson, 'templates/backgrounds.json changed: presets are part of the baseline');
});

const scene = () => resolveScene(cfg.scenes[0], cfg);

for (const vp of ['desktop', 'tablet', 'mobile', 'wide', 'square']) {
  for (const theme of ['light', 'dark']) {
    test(`framed ${vp} (${theme}): geometry, background and an untouched screen`, async () => {
      const shot = shotsFor(scene()).find((s) => s.viewport.name === vp && s.theme === theme);
      const dsf = shot.viewport.deviceScaleFactor;
      const raw = pattern(shot.viewport.width * dsf, shot.viewport.height * dsf);
      const rawFile = path.join(dir, `${shot.id}.png`);
      writeFileSync(rawFile, PNG.sync.write(raw));
      const out = path.join(dir, `${shot.id}-framed.png`);
      const rects = await render(browser, baseOpts(cfg, theme, { devices: [spec(cfg, shot, rawFile)] }), { dsf, out });
      const framed = PNG.sync.read(readFileSync(out));
      const geo = screenGeometry(rects, dsf);

      // The screen must be a 1:1 copy of the capture (corners masked).
      const cmp = compareScreenRegion({ framed, raw, rect: geo.rect, src: geo.src, clips: geo.clips });
      assert.ok(cmp.ok, `${vp}/${theme}: ${cmp.reason}`);
      assert.equal(cmp.stats.identicalShare, 1, `${vp}/${theme}: expected an exact copy, got ${cmp.summary}`);

      check(`framed-${vp}-${theme}`, {
        canvas: [framed.width, framed.height],
        screen: { ...geo.rect, clips: geo.clips },
        probes: { topLeft: pixel(framed, 8, 8), topRight: pixel(framed, framed.width - 9, 8) },
      });
    });
  }
}

test('responsive trio and social card keep their size and background', async () => {
  const s = scene();
  const pick = (name, theme) => shotsFor(s).find((x) => x.viewport.name === name && x.theme === theme);
  for (const theme of ['light', 'dark']) {
    const devices = ['desktop', 'tablet', 'mobile'].map((name) => {
      const shot = pick(name, theme);
      const file = path.join(dir, `${shot.id}-src.png`);
      writeFileSync(file, PNG.sync.write(pattern(shot.viewport.width * 2, shot.viewport.height * 2)));
      return spec(cfg, shot, file);
    });
    devices[0].type = 'laptop';
    const trioOut = path.join(dir, `trio-${theme}.png`);
    await render(browser, baseOpts(cfg, theme, { layout: 'trio', width: 1800, height: 1060, padding: 80, devices }), { dsf: 1.5, out: trioOut });
    const trio = PNG.sync.read(readFileSync(trioOut));
    check(`trio-${theme}`, { canvas: [trio.width, trio.height], probes: { topLeft: pixel(trio, 8, 8), topRight: pixel(trio, trio.width - 9, 8) } });

    const socialOut = path.join(dir, `social-${theme}.png`);
    await render(browser, baseOpts(cfg, theme, { layout: 'social', opaque: true, brand: 'Fixture', title: 'Fixture', caption: 'Baseline', devices: [devices[0].type === 'laptop' ? { ...devices[0], type: 'browser' } : devices[0]] }), { dsf: 1, out: socialOut });
    const social = PNG.sync.read(readFileSync(socialOut));
    check(`social-${theme}`, { canvas: [social.width, social.height], probes: { topLeft: pixel(social, 8, 8), bottomLeft: pixel(social, 8, social.height - 9) } });
  }
});
