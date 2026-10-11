// Screen-region authenticity: proves a framed composite still contains the raw capture, unaltered.
//
// Only valid when the screen is drawn 1:1 (one capture pixel per output pixel), which holds for
// framed stills and the still hero: the template lays the screen out at the viewport's CSS size and
// renders at the capture's deviceScaleFactor. Scaled placements (trio, social card) and videos are
// refused rather than approximated; see docs/design/phase0-baseline.md.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { deltaEOK } from './color.mjs';

export const THRESHOLDS = {
  // A pixel "differs" when ΔEok exceeds a just-noticeable difference.
  pixelDeltaE: 0.02,
  // At most 0.1 % of compared pixels may differ, and the mean must stay tiny.
  maxDifferingShare: 0.001,
  maxMeanDeltaE: 0.002,
};

const load = (img) => (typeof img === 'string' ? PNG.sync.read(readFileSync(img)) : img);
const isInt = (v) => Math.abs(v - Math.round(v)) < 0.01;

/**
 * True when the pixel centre (x, y) of the region lies outside the rounded rectangle `clip`
 * (region-relative device px), allowing an anti-aliasing band inside the curved edge.
 */
function outsideClip(x, y, { x: cx, y: cy, w, h, radii: [tl, tr, br, bl] }, band) {
  const px = x + 0.5 - cx;
  const py = y + 0.5 - cy;
  if (px < 0 || py < 0 || px > w || py > h) return true;
  const arc = (r, ox, oy) => r > 0 && Math.hypot(px - ox, py - oy) > r - band;
  if (px < tl && py < tl) return arc(tl, tl, tl);
  if (px > w - tr && py < tr) return arc(tr, w - tr, tr);
  if (px > w - br && py > h - br) return arc(br, w - br, h - br);
  if (px < bl && py > h - bl) return arc(bl, bl, h - bl);
  return false;
}

/**
 * Compare `rect` (device px) of the framed image with the raw capture starting at `src` (device px).
 * `clips` are rounded rectangles (region-relative device px) that clip the screen; pixels outside any
 * of them (or in their anti-aliased edge) are not compared. Returns { ok, reason, stats }.
 */
export function compareScreenRegion({ framed, raw, rect, src = { x: 0, y: 0 }, clips, thresholds = THRESHOLDS }) {
  const f = load(framed);
  const r = load(raw);
  const { x, y, w, h } = rect;
  if (![x, y, w, h, src.x, src.y].every(isInt)) {
    return { ok: false, unsupported: true, reason: 'screen is not placed on whole pixels (scaled placement); comparison unsupported' };
  }
  const [X, Y, W, H, SX, SY] = [x, y, w, h, src.x, src.y].map(Math.round);
  if (X < 0 || Y < 0 || X + W > f.width || Y + H > f.height) {
    return { ok: false, reason: `screen rect ${W}×${H}@${X},${Y} falls outside the framed image ${f.width}×${f.height}` };
  }
  if (SX < 0 || SY < 0 || SX + W > r.width || SY + H > r.height) {
    return { ok: false, reason: `raw capture ${r.width}×${r.height} does not contain a ${W}×${H} region at ${SX},${SY} (scaled or wrong source?)` };
  }
  const band = 1.5;
  const regionClips = clips?.length ? clips : [{ x: 0, y: 0, w: W, h: H, radii: [0, 0, 0, 0] }];
  let compared = 0;
  let masked = 0;
  let identical = 0;
  let differing = 0;
  let sum = 0;
  let max = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (regionClips.some((c) => outsideClip(i, j, c, band))) {
        masked++;
        continue;
      }
      const a = ((Y + j) * f.width + X + i) * 4;
      const b = ((SY + j) * r.width + SX + i) * 4;
      compared++;
      if (f.data[a] === r.data[b] && f.data[a + 1] === r.data[b + 1] && f.data[a + 2] === r.data[b + 2]) {
        identical++;
        continue;
      }
      const d = deltaEOK([f.data[a], f.data[a + 1], f.data[a + 2]], [r.data[b], r.data[b + 1], r.data[b + 2]]);
      sum += d;
      if (d > max) max = d;
      if (d > thresholds.pixelDeltaE) differing++;
    }
  }
  const stats = {
    compared,
    masked,
    identicalShare: compared ? identical / compared : 0,
    differingShare: compared ? differing / compared : 0,
    meanDeltaE: compared ? sum / compared : 0,
    maxDeltaE: max,
  };
  if (!compared) return { ok: false, reason: 'nothing to compare', stats };
  const ok = stats.differingShare <= thresholds.maxDifferingShare && stats.meanDeltaE <= thresholds.maxMeanDeltaE;
  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  return {
    ok,
    reason: ok ? undefined : `screen differs from the raw capture: ${pct(stats.differingShare)} of pixels over ΔEok ${thresholds.pixelDeltaE}, mean ${stats.meanDeltaE.toFixed(4)}`,
    stats,
    summary: `${pct(stats.identicalShare)} identical, mean ΔEok ${stats.meanDeltaE.toFixed(4)}`,
  };
}

/** Geometry record stored with a framed asset: everything needed to rerun the comparison later. */
export function screenGeometry(rects, dsf) {
  const s = rects.screen;
  const scale = (c) => ({ x: c.x * dsf, y: c.y * dsf, w: c.w * dsf, h: c.h * dsf, radii: c.radii.map((v) => v * dsf) });
  return {
    rect: { x: s.x * dsf, y: s.y * dsf, w: s.w * dsf, h: s.h * dsf },
    clips: (s.clips ?? []).map(scale),
    // The viewport image is top-aligned and unscaled, so the screen shows the capture's top-left region.
    src: { x: 0, y: 0 },
    dsf,
  };
}
