// Small, dependency-free colour utilities. Kept deliberately minimal: what the authenticity check
// needs now, plus the contrast/OKLab primitives later design phases will build on.

/** "#rgb" / "#rrggbb" (case-insensitive) → [r, g, b] in 0-255, or null. */
export function parseHex(hex) {
  const m = String(hex).trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** sRGB channel 0-255 → linear-light 0-1 (IEC 61966-2-1). */
export function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an sRGB colour. */
export function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio, 1-21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB 0-255 → OKLab (Björn Ottosson, 2020). L in 0-1. */
export function rgbToOklab([r, g, b]) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → OKLCH; hue in degrees 0-360 (0 for achromatic colours). */
export function oklabToOklch([L, a, b]) {
  const C = Math.hypot(a, b);
  const h = C < 1e-4 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
  return [L, C, h < 0 ? h + 360 : h];
}

/**
 * Euclidean distance in OKLab ("ΔEok"). 0 = identical; ~0.02 is around the threshold of a just
 * noticeable difference; black↔white = 1. Chosen over CIEDE2000 for simplicity and because OKLab is
 * already perceptually uniform enough for thresholding.
 */
export function deltaEOK(rgb1, rgb2) {
  const [L1, a1, b1] = rgbToOklab(rgb1);
  const [L2, a2, b2] = rgbToOklab(rgb2);
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2);
}
