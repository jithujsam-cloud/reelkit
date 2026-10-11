// Colour derivations for directions. Every colour comes from the design profile or from a neutral
// constant below; Reelkit's own purple palette is never used.
import { contrastRatio, parseHex, rgbToOklab, toHex } from '../color.mjs';

export const INK = '#14161a';
export const PAPER = '#fafaf8';
export const WHITE = '#ffffff';
export const BLACK = '#000000';

export const rgb = (hex) => parseHex(hex);
export const lightness = (hex) => rgbToOklab(rgb(hex))[0];
export const contrast = (a, b) => contrastRatio(rgb(a), rgb(b));

/** sRGB blend: t = share of b. */
export function mix(a, b, t) {
  const A = rgb(a);
  const B = rgb(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}

/** First candidate with enough contrast on bg; else whichever of black/white is better. */
export function readable(bg, prefs, min = 4.5) {
  for (const c of prefs) if (c && contrast(c, bg) >= min) return c;
  return contrast(WHITE, bg) >= contrast(INK, bg) ? WHITE : INK;
}

/** Move `fg` toward black or white (whichever helps) until it reaches `min` contrast on bg. */
export function ensureContrast(fg, bg, min = 3) {
  if (contrast(fg, bg) >= min) return fg;
  const target = lightness(bg) > 0.55 ? BLACK : WHITE;
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}

/** Complete palette for one canvas colour. */
export function paletteOn(canvas, { accent, text, canvas2 } = {}) {
  const t = readable(canvas, [text, WHITE, INK]);
  const base2 = canvas2 ?? mix(canvas, t, 0.07);
  return {
    canvas,
    canvas2: base2,
    text: t,
    muted: ensureContrast(mix(t, canvas, 0.3), canvas, 3.5),
    accent: ensureContrast(accent ?? t, canvas, 3),
    surface: mix(canvas, t, 0.06),
    border: mix(canvas, t, 0.18),
  };
}
