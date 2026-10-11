import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

/** Cheap automated sanity checks on a PNG: blank / near-uniform frames are never shippable. */
export function inspectPng(file) {
  const png = PNG.sync.read(readFileSync(file));
  const { width, height, data } = png;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  const counts = new Map();
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
      n++;
      const key = (data[i] >> 3) | ((data[i + 1] >> 3) << 5) | ((data[i + 2] >> 3) << 10);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const mean = sum / n;
  const stddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const dominant = Math.max(...counts.values()) / n;
  const problems = [];
  if (stddev < 3 || dominant > 0.985) problems.push('image is blank or nearly uniform');
  return { width, height, stddev: +stddev.toFixed(2), dominant: +dominant.toFixed(4), colors: counts.size, problems };
}
