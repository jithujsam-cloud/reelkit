import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { compareScreenRegion, screenGeometry } from '../scripts/lib/authenticity.mjs';

// ---------------------------------------------------------------------------
// Unit tests on synthetic images
// ---------------------------------------------------------------------------

function img(w, h, fn) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

const raw = img(200, 120, (x, y) => [(x * 5) & 255, (y * 9) & 255, (x ^ y) & 255]);
const BG = [40, 80, 160];
// "Framed": the raw capture pasted at (37, 41) on a flat background.
const composite = (edit = () => null) =>
  img(300, 220, (x, y) => {
    const ix = x - 37;
    const iy = y - 41;
    if (ix >= 0 && iy >= 0 && ix < 200 && iy < 120) {
      return edit(ix, iy) ?? [raw.data[(iy * 200 + ix) * 4], raw.data[(iy * 200 + ix) * 4 + 1], raw.data[(iy * 200 + ix) * 4 + 2]];
    }
    return BG;
  });
const RECT = { x: 37, y: 41, w: 200, h: 120 };

test('an untouched screen region passes as an exact copy', () => {
  const res = compareScreenRegion({ framed: composite(), raw, rect: RECT });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.stats.identicalShare, 1);
  assert.equal(res.stats.compared, 200 * 120);
});

test('an altered block inside the screen is detected', () => {
  const framed = composite((x, y) => (x >= 50 && x < 60 && y >= 50 && y < 60 ? [255, 0, 255] : null));
  const res = compareScreenRegion({ framed, raw, rect: RECT });
  assert.equal(res.ok, false);
  assert.match(res.reason, /differs from the raw capture/);
  assert.equal(res.stats.compared - Math.round(res.stats.identicalShare * res.stats.compared), 100);
});

test('a subtle global colour shift (e.g. colour-profile change) is detected', () => {
  const framed = composite((x, y) => {
    const i = (y * 200 + x) * 4;
    return [Math.min(255, raw.data[i] + 6), raw.data[i + 1], Math.max(0, raw.data[i + 2] - 6)];
  });
  const res = compareScreenRegion({ framed, raw, rect: RECT });
  assert.equal(res.ok, false);
});

test('an off-by-one placement is detected', () => {
  const res = compareScreenRegion({ framed: composite(), raw, rect: { ...RECT, x: 38 } });
  assert.equal(res.ok, false);
});

test('rounded corners are masked only when the clip is declared', () => {
  const r = 20;
  const outside = (x, y) => {
    const cx = x < r ? r : x >= 200 - r ? 200 - r : null;
    const cy = y < r ? r : y >= 120 - r ? 120 - r : null;
    return cx !== null && cy !== null && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r - 1.5;
  };
  const framed = composite((x, y) => (outside(x, y) ? BG : null));
  assert.equal(compareScreenRegion({ framed, raw, rect: RECT }).ok, false, 'undeclared corners count as differences');
  const res = compareScreenRegion({ framed, raw, rect: RECT, clips: [{ x: 0, y: 0, w: 200, h: 120, radii: [r, r, r, r] }] });
  assert.equal(res.ok, true, res.reason);
  assert.ok(res.stats.masked > 0);
});

test('scaled (fractional) placements are refused, not approximated', () => {
  const res = compareScreenRegion({ framed: composite(), raw, rect: { x: 37.5, y: 41, w: 200, h: 120 } });
  assert.equal(res.ok, false);
  assert.equal(res.unsupported, true);
});

test('a region larger than the raw capture is reported, not compared', () => {
  const res = compareScreenRegion({ framed: composite(), raw, rect: { x: 0, y: 0, w: 260, h: 120 } });
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not contain/);
});

test('screenGeometry converts CSS px to device px', () => {
  const g = screenGeometry({ screen: { x: 72, y: 116, w: 1440, h: 900, clips: [{ x: 0, y: 0, w: 1440, h: 900, radii: [0, 0, 12, 12] }] } }, 2);
  assert.deepEqual(g.rect, { x: 144, y: 232, w: 2880, h: 1800 });
  assert.deepEqual(g.clips[0].radii, [0, 0, 24, 24]);
  assert.deepEqual(g.src, { x: 0, y: 0 });
});

// ---------------------------------------------------------------------------
// Regression over the committed dogfood assets (read-only; skipped when the
// skill is installed on its own without the repository's docs/media).
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const configFile = path.join(repoRoot, 'reelkit.config.yaml');
const mediaDir = path.join(repoRoot, 'docs', 'media');
const haveRepo = existsSync(configFile) && existsSync(path.join(mediaDir, 'manifest.json'));

test('committed framed stills contain their raw captures, pixel for pixel', { skip: haveRepo ? false : 'repository media not present' }, async (t) => {
  const { loadConfig, selectScenes, shotsFor } = await import('../scripts/lib/config.mjs');
  const { baseOpts, render, spec } = await import('../scripts/lib/frame.mjs');
  const { launchBrowser } = await import('../scripts/lib/browser.mjs');
  const cfg = loadConfig(configFile);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'reelkit-auth-'));
  const browser = await launchBrowser();
  const checked = [];
  try {
    for (const scene of selectScenes(cfg, []).filter((s) => s.isStill && s.outputs.includes('framed'))) {
      for (const shot of shotsFor(scene)) {
        const rawFile = path.join(mediaDir, `${shot.id}.png`);
        const framedFile = path.join(mediaDir, `${shot.id}-framed.png`);
        if (!existsSync(rawFile) || !existsSync(framedFile)) continue;
        const dsf = shot.viewport.deviceScaleFactor;
        // Re-derive geometry from the current template (rendered to a temp file, never into docs/media).
        const rects = await render(browser, baseOpts(cfg, shot.theme, { devices: [spec(cfg, shot, rawFile)] }), { dsf, out: path.join(tmp, `${shot.id}.png`) });
        const geo = screenGeometry(rects, dsf);
        const committed = PNG.sync.read(readFileSync(framedFile));
        assert.deepEqual([committed.width, committed.height], [Math.round(rects.canvas.w * dsf), Math.round(rects.canvas.h * dsf)], `${shot.id}: committed size no longer matches the template geometry`);
        const res = compareScreenRegion({ framed: committed, raw: rawFile, rect: geo.rect, src: geo.src, clips: geo.clips });
        assert.ok(res.ok, `${shot.id}: ${res.reason}`);
        checked.push(`${shot.id} (${res.summary})`);
      }
    }
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const line of checked) t.diagnostic(line);
  assert.ok(checked.length >= 12, `expected the 12 committed framed stills, checked ${checked.length}`);
});

// ---------------------------------------------------------------------------
// End-to-end: `frame` records geometry and `verify` runs the check (temp project).
// ---------------------------------------------------------------------------

test('verify reports "authentic" for framed stills and fails a tampered one', async () => {
  const { writeFileSync } = await import('node:fs');
  const { loadConfig, selectScenes } = await import('../scripts/lib/config.mjs');
  const { saveResult } = await import('../scripts/lib/state.mjs');
  const { frameAll } = await import('../scripts/lib/frame.mjs');
  const { verify } = await import('../scripts/lib/verify.mjs');
  const { launchBrowser } = await import('../scripts/lib/browser.mjs');
  const { setQuiet } = await import('../scripts/lib/log.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reelkit-verify-'));
  setQuiet(true);
  try {
    writeFileSync(path.join(dir, 'reelkit.config.yaml'), 'baseUrl: http://localhost:3000\noutput: media\nscenes:\n  - { name: fx, url: /, viewports: [mobile], theme: light, outputs: [still, framed] }\n');
    const cfg = loadConfig(path.join(dir, 'reelkit.config.yaml'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(cfg.outDir, { recursive: true });
    const still = img(780, 1688, (x, y) => [(x * 3) & 255, (y * 5) & 255, ((x + y) * 7) & 255]);
    writeFileSync(path.join(cfg.outDir, 'fx-mobile-light.png'), PNG.sync.write(still));
    saveResult(cfg, 'fx-mobile-light.png', { scene: 'fx', viewport: 'mobile', theme: 'light', kind: 'still', status: 'PASS' });
    const browser = await launchBrowser();
    try {
      await frameAll(cfg, selectScenes(cfg, []), { browser });
    } finally {
      await browser.close();
    }
    const qaFile = path.join(cfg.workDir, 'qa-report.json');
    const authentic = () => JSON.parse(readFileSync(qaFile, 'utf8')).assets['fx-mobile-light-framed.png'].automated.checks.find((c) => c.name === 'authentic');

    await verify(cfg, {});
    assert.equal(authentic()?.ok, true, JSON.stringify(authentic()));

    // Paint a block over the middle of the framed screen: verify must fail it.
    const framedFile = path.join(cfg.outDir, 'fx-mobile-light-framed.png');
    const framed = PNG.sync.read(readFileSync(framedFile));
    for (let y = 1000; y < 1040; y++) for (let x = 500; x < 540; x++) framed.data.set([255, 0, 255, 255], (y * framed.width + x) * 4);
    writeFileSync(framedFile, PNG.sync.write(framed));
    const res = await verify(cfg, {});
    assert.equal(res.ok, false);
    assert.equal(authentic()?.ok, false);
    assert.match(authentic().detail, /differs from the raw capture/);
  } finally {
    setQuiet(false);
    rmSync(dir, { recursive: true, force: true });
  }
});
