// Deterministic colour census of a screenshot: which colours cover how much of the page.
// Grid-binning in OKLab followed by greedy merging (heaviest first): no random seeds, so the same
// pixels always produce the same palette.
import { PNG } from 'pngjs';
import { deltaEOK, oklabToOklch, rgbToOklab, toHex } from '../color.mjs';
import { CHROMATIC, round } from './reconcile.mjs';

export function colorCensus(pngOrBuffer, { maxSamples = 60000, mergeDistance = 0.04, top = 12 } = {}) {
  const png = Buffer.isBuffer(pngOrBuffer) ? PNG.sync.read(pngOrBuffer) : pngOrBuffer;
  const { width, height, data } = png;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSamples)));
  const bins = new Map();
  let n = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 200) continue;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      const [L, a, b] = rgbToOklab(rgb);
      const key = `${Math.round(L / 0.02)}|${Math.round(a / 0.015)}|${Math.round(b / 0.015)}`;
      const bin = bins.get(key);
      if (bin) {
        bin.count++;
        bin.sum[0] += rgb[0];
        bin.sum[1] += rgb[1];
        bin.sum[2] += rgb[2];
      } else bins.set(key, { key, count: 1, sum: [...rgb] });
      n++;
    }
  }
  const ranked = [...bins.values()]
    .map((b) => ({ rgb: b.sum.map((s) => Math.round(s / b.count)), count: b.count, key: b.key }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const merged = [];
  for (const b of ranked) {
    const home = merged.find((m) => deltaEOK(m.rgb, b.rgb) <= mergeDistance);
    if (home) home.count += b.count;
    else merged.push({ rgb: b.rgb, count: b.count });
  }
  return merged
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
    .map((m) => {
      const [, C] = oklabToOklch(rgbToOklab(m.rgb));
      return { hex: toHex(m.rgb), share: round(m.count / n, 4), chromatic: C >= CHROMATIC };
    });
}
