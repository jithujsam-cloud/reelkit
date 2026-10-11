// Are three directions genuinely different? Compared on independent compositional axes, not on colour.
// Two directions that differ only in hue (same layouts, same depth, same type) fail.
import { lightness } from './palette.mjs';

const bucket = (v, cuts) => cuts.filter((c) => v >= c).length;

export const AXES = {
  'single.family': (d) => d.composition.single.family,
  'social.family': (d) => d.composition.social.family,
  'trio.family': (d) => d.composition.trio.family,
  'background.kind': (d) => d.palette.background.kind,
  'canvas.tone': (d) => ['dark', 'mid', 'light'][bucket(lightness(d.palette.light.canvas), [0.3, 0.7])],
  'type.weight': (d) => (d.typography.weight >= 700 ? 'heavy' : d.typography.weight >= 550 ? 'medium' : 'light'),
  'type.voice': (d) => d.typography.voice,
  'device.scale': (d) => ['small', 'medium', 'large'][bucket(d.composition.single.deviceScale, [0.6, 0.8])],
  'depth.shadow': (d) => d.depth.shadow,
  'accent.use': (d) => d.palette.accentUse,
  'motion.cursor': (d) => d.motion.cursor,
};

export const MIN_DIFFERING_AXES = 6;
const COMPOSITION_AXES = ['single.family', 'social.family', 'trio.family'];

export function compare(a, b) {
  const differing = Object.keys(AXES).filter((k) => AXES[k](a) !== AXES[k](b));
  const compositionDiffs = COMPOSITION_AXES.filter((k) => differing.includes(k)).length;
  return { a: a.id, b: b.id, differing, count: differing.length, compositionDiffs };
}

/** → { ok, minDifferingAxes, axes, pairs, failures } */
export function distinctness(directions) {
  const pairs = [];
  for (let i = 0; i < directions.length; i++) for (let j = i + 1; j < directions.length; j++) pairs.push(compare(directions[i], directions[j]));
  const failures = pairs
    .filter((p) => p.count < MIN_DIFFERING_AXES || p.compositionDiffs < 2)
    .map((p) => `${p.a} and ${p.b} differ on only ${p.count} axes (${p.compositionDiffs} of 3 compositions): ${p.differing.join(', ') || 'none'}`);
  return { ok: failures.length === 0, minDifferingAxes: Math.min(...pairs.map((p) => p.count)), axes: Object.keys(AXES), pairs, failures };
}
