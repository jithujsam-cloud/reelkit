// Parses the colour syntaxes found in stylesheets and design docs (not in rendered pages: there the
// browser itself normalises any syntax to sRGB, see inspect.mjs). Returns [r, g, b, a] with r/g/b in
// 0-255 and a in 0-1, or null when the text is not a colour this module understands.
import { parseHex } from '../color.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const linearToSrgb = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => clamp(Math.round(linearToSrgb(clamp(v, 0, 1))), 0, 255));
}

export function hslToRgb(h, s, l) {
  const S = clamp(s, 0, 100) / 100;
  const Lt = clamp(l, 0, 100) / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(Lt, 1 - Lt);
  const f = (n) => Lt - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

const alphaOf = (s) => (s === undefined ? 1 : clamp(s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s), 0, 1));

export function parseCssColor(input) {
  if (typeof input !== 'string') return null;
  const t = input.trim().replace(/\s*!important$/i, '');
  const hex = parseHex(t);
  if (hex && t.startsWith('#')) return [...hex, 1];
  if (/^#[0-9a-f]{8}$/i.test(t)) {
    return [0, 2, 4].map((i) => parseInt(t.slice(1 + i, 3 + i), 16)).concat(+(parseInt(t.slice(7, 9), 16) / 255).toFixed(3));
  }
  let m = t.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (m) {
    const ch = [m[1], m[2], m[3]].map((v) => clamp(Math.round(v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v)), 0, 255));
    return [...ch, alphaOf(m[4])];
  }
  m = t.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (m) return [...hslToRgb(parseFloat(m[1]) % 360, parseFloat(m[2]), parseFloat(m[3])), alphaOf(m[4])];
  m = t.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/i);
  if (m) {
    const L = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    const C = m[2].endsWith('%') ? (parseFloat(m[2]) / 100) * 0.4 : parseFloat(m[2]);
    return [...oklchToRgb(L, C, parseFloat(m[3])), alphaOf(m[4])];
  }
  // shadcn-style bare HSL channels: "221.2 83.2% 53.3%" (consumed as hsl(var(--x)))
  m = t.match(/^([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%$/);
  if (m) return [...hslToRgb(parseFloat(m[1]) % 360, parseFloat(m[2]), parseFloat(m[3])), 1];
  return null;
}

/** Every colour literal in a line of text (hex, rgb[a](), hsl[a](), oklch()). */
export function findColorLiterals(text) {
  const out = [];
  const re = /#[0-9a-f]{8}\b|#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|(?:rgba?|hsla?|oklch)\([^)]*\)/gi;
  for (const m of String(text).matchAll(re)) {
    const rgba = parseCssColor(m[0]);
    if (rgba) out.push({ text: m[0], rgba, index: m.index });
  }
  return out;
}

