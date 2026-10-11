// Turns raw page observations (inspect.mjs) into design facts. Pure functions: no browser, no I/O.
// Facts say what was *seen* and how strongly; profile.mjs decides how to weigh them against claims.
import { deltaEOK, oklabToOklch, rgbToOklab, toHex, contrastRatio } from '../color.mjs';

export const CHROMA_MIN = 0.06; // below this a colour reads as neutral (grey/black/white)
export const SAME_COLOR = 0.03; // ΔEok under which two colours are one colour for counting

export const oklch = (rgb) => oklabToOklch(rgbToOklab(rgb));
export const isChromatic = (rgb) => oklch(rgb)[1] >= CHROMA_MIN;
const rgb3 = (c) => [c[0], c[1], c[2]];
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const mode = (arr) => {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
};
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** Greedy perceptual clustering. items: [{rgb:[r,g,b], w}] → clusters sorted by total weight. */
export function clusterColors(items, threshold = SAME_COLOR) {
  const clusters = [];
  for (const it of [...items].sort((a, b) => b.w - a.w)) {
    const hit = clusters.find((c) => deltaEOK(c.rgb, it.rgb) < threshold);
    if (hit) {
      hit.w += it.w;
      hit.n += it.n ?? 1;
    } else clusters.push({ rgb: it.rgb, w: it.w, n: it.n ?? 1 });
  }
  const total = clusters.reduce((s, c) => s + c.w, 0) || 1;
  return clusters.sort((a, b) => b.w - a.w).map((c) => ({ ...c, share: c.w / total, hex: toHex(c.rgb) }));
}

const opaque = (c) => c && c[3] >= 0.5;

function colorFacts(els, main) {
  const pageBg = rgb3(main.pageBg.rgba);
  const far = (rgb) => deltaEOK(rgb, pageBg) > SAME_COLOR;
  const text = clusterColors(els.filter((e) => e.role === 'text' && e.color && opaque(e.color)).map((e) => ({ rgb: rgb3(e.color), w: e.textLen })));
  const topText = text[0] ?? null;
  const muted = topText
    ? text.slice(1).find((c) => c.n >= 3 && !isChromatic(c.rgb) && contrastRatio(c.rgb, pageBg) >= 2 && contrastRatio(c.rgb, pageBg) < contrastRatio(topText.rgb, pageBg))
    : null;

  const interactive = [];
  for (const e of els) {
    if (e.role === 'button' && opaque(e.bg)) interactive.push({ rgb: rgb3(e.bg), w: 3, src: 'button background' });
    if (e.role === 'button' && e.borderColor && opaque(e.borderColor) && !opaque(e.bg)) interactive.push({ rgb: rgb3(e.borderColor), w: 1, src: 'button border' });
    if (e.role === 'link' && e.color && opaque(e.color) && e.textLen > 0) interactive.push({ rgb: rgb3(e.color), w: 1, src: 'link text' });
  }
  const chromatic = clusterColors(interactive.filter((i) => isChromatic(i.rgb) && far(i.rgb) && (!topText || deltaEOK(i.rgb, topText.rgb) > SAME_COLOR)));
  const decorative = clusterColors(els.filter((e) => e.role === 'block' && opaque(e.bg) && isChromatic(rgb3(e.bg))).map((e) => ({ rgb: rgb3(e.bg), w: 0.5 })));

  let primary = null;
  let primaryBasis = null;
  if (chromatic[0]) {
    primary = chromatic[0];
    primaryBasis = 'interactive';
  } else {
    const neutralButtons = clusterColors(els.filter((e) => e.role === 'button' && opaque(e.bg)).map((e) => ({ rgb: rgb3(e.bg), w: 3 }))).filter((c) => far(c.rgb) && contrastRatio(c.rgb, pageBg) >= 3);
    if (neutralButtons[0]) {
      primary = neutralButtons[0];
      primaryBasis = 'neutral-interactive';
    } else if (decorative[0]) {
      primary = decorative[0];
      primaryBasis = 'decorative';
    }
  }
  const accent = chromatic
    .slice(1)
    .find((c) => c.n >= 2 && primary && deltaEOK(c.rgb, primary.rgb) >= 0.08 && (Math.abs(oklch(c.rgb)[2] - oklch(primary.rgb)[2]) % 360 >= 20));

  const surfaces = clusterColors(els.filter((e) => e.role === 'card' && opaque(e.bg) && far(rgb3(e.bg))).map((e) => ({ rgb: rgb3(e.bg), w: Math.min(e.rect[2] * e.rect[3], 400_000) })));
  const border = clusterColors(els.filter((e) => e.borderColor && opaque(e.borderColor) && e.borderWidth > 0).map((e) => ({ rgb: rgb3(e.borderColor), w: 1 })));
  const palette = clusterColors([
    { rgb: pageBg, w: 5, n: 1 },
    ...els.flatMap((e) => [e.bg && opaque(e.bg) && { rgb: rgb3(e.bg), w: Math.sqrt(e.rect[2] * e.rect[3]) / 20 }, e.color && e.textLen > 0 && opaque(e.color) && { rgb: rgb3(e.color), w: e.textLen / 20 }].filter(Boolean)),
  ]).slice(0, 8);
  return { pageBg: { rgb: pageBg, defaulted: main.pageBg.defaulted }, text, topText, muted, primary, primaryBasis, accent, chromatic, surfaces, border, palette, textSamples: els.filter((e) => e.role === 'text').length };
}

const GENERIC_FAMILIES = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'cursive', 'fantasy']);
export function stackFirst(stack) {
  for (const part of String(stack).split(',')) {
    const f = part.trim().replace(/^['"]|['"]$/g, '');
    if (f && !GENERIC_FAMILIES.has(f.toLowerCase())) return f;
  }
  return null;
}

function typographyFacts(els, main, rendered) {
  const byRole = {
    heading: els.filter((e) => e.role === 'heading'),
    body: els.filter((e) => e.role === 'text'),
    ui: els.filter((e) => e.role === 'button'),
    mono: els.filter((e) => e.role === 'code'),
  };
  const families = {};
  for (const [role, list] of Object.entries(byRole)) {
    if (!list.length) continue;
    const counts = new Map();
    for (const e of list) counts.set(e.font.family, (counts.get(e.font.family) ?? 0) + (role === 'body' ? Math.max(1, e.textLen) : 1));
    const [stack, w] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const total = [...counts.values()].reduce((s, v) => s + v, 0);
    const first = stackFirst(stack);
    const loaded = main.documentFonts.some((f) => f.family.toLowerCase() === first?.toLowerCase() && f.status === 'loaded');
    const declared = main.fontFaces.some((f) => f.family.toLowerCase() === first?.toLowerCase());
    families[role] = {
      stack,
      first,
      share: w / total,
      n: list.length,
      origin: !first ? 'generic-only' : loaded ? 'webfont' : declared ? 'webfont-declared-not-loaded' : 'system-or-unlisted',
      rendered: rendered?.[role]?.family ?? null,
    };
  }
  const headingSizes = {};
  for (let lvl = 1; lvl <= 4; lvl++) {
    const hs = byRole.heading.filter((e) => e.level === lvl);
    if (!hs.length) continue;
    headingSizes[`h${lvl}`] = { size: median(hs.map((e) => e.font.size)), weight: median(hs.map((e) => e.font.weight)), lineHeight: median(hs.map((e) => e.font.lineHeight).filter(Boolean)), letterSpacing: median(hs.map((e) => e.font.letterSpacing)), n: hs.length };
  }
  const bodySizes = mode(byRole.body.map((e) => e.font.size));
  const sizes = mode(els.filter((e) => e.textLen > 0).map((e) => e.font.size)).slice(0, 10);
  const levels = Object.values(headingSizes).map((h) => h.size);
  const ratios = levels.slice(1).map((s, i) => levels[i] / s).filter((r) => r > 1);
  const bodyLh = median(byRole.body.map((e) => (e.font.lineHeight && e.font.size ? e.font.lineHeight / e.font.size : null)).filter(Boolean));
  const buttonCase = mode(byRole.ui.map((e) => e.font.transform))[0]?.[0] ?? null;
  return {
    families,
    headings: headingSizes,
    base: bodySizes[0] ? { size: bodySizes[0][0], weight: mode(byRole.body.map((e) => e.font.weight))[0]?.[0] ?? null, lineHeightRatio: bodyLh ? round(bodyLh) : null, n: byRole.body.length } : null,
    sizes: sizes.map(([size, count]) => ({ size, count })),
    weights: mode(els.filter((e) => e.textLen > 0).map((e) => e.font.weight)).slice(0, 5).map(([weight, count]) => ({ weight, count })),
    scaleRatio: ratios.length >= 2 ? round(median(ratios)) : null,
    scaleLevels: levels.length,
    buttonCase,
  };
}

function spacingFacts(els) {
  const vals = [];
  for (const e of els) {
    for (const v of e.pad) if (v > 0) vals.push(Math.round(v));
    if (e.gap > 0) vals.push(Math.round(e.gap));
    for (const v of e.margin) if (v > 0) vals.push(Math.round(v));
  }
  const usable = vals.filter((v) => v <= 160);
  if (usable.length < 10) return { n: usable.length, unit: null, coverage: null, scale: [] };
  let unit = null;
  let coverage = null;
  for (const u of [8, 4, 2]) {
    const cov = usable.filter((v) => v % u === 0).length / usable.length;
    if (cov >= 0.8) {
      unit = u;
      coverage = cov;
      break;
    }
  }
  const scale = mode(usable).slice(0, 8).map(([value, count]) => ({ value, count })).sort((a, b) => a.value - b.value);
  return { n: usable.length, unit, coverage: coverage === null ? null : round(coverage), scale };
}

function shapeFacts(els) {
  const radiusOf = (list) => {
    if (list.length < 2) return null;
    const vals = list.map((e) => (e.radius >= Math.min(e.rect[2], e.rect[3]) / 2 - 0.5 && e.radius > 0 ? 'pill' : Math.round(e.radius ?? 0)));
    const [v, n] = mode(vals)[0];
    return { value: v, share: round(n / vals.length), n: vals.length };
  };
  const cards = els.filter((e) => e.role === 'card');
  const shadows = mode(cards.concat(els.filter((e) => e.shadow && e.role !== 'card')).map((e) => e.shadow).filter(Boolean)).slice(0, 3).map(([css, count]) => ({ css, count }));
  let style = null;
  if (cards.length >= 3) {
    const sh = cards.filter((c) => c.shadow).length / cards.length;
    const bd = cards.filter((c) => c.borderWidth > 0 && c.borderColor).length / cards.length;
    const fill = cards.filter((c) => c.bg).length / cards.length;
    style = { kind: sh >= 0.5 ? 'elevated' : bd >= 0.5 ? 'bordered' : fill >= 0.5 ? 'tinted' : 'flat', shadowShare: round(sh), borderShare: round(bd), fillShare: round(fill), n: cards.length };
  }
  return {
    radius: { button: radiusOf(els.filter((e) => e.role === 'button')), card: radiusOf(cards), input: radiusOf(els.filter((e) => e.role === 'input')) },
    shadows,
    surfaceStyle: style,
    borderWidth: mode(els.filter((e) => e.borderWidth > 0).map((e) => e.borderWidth))[0]?.[0] ?? null,
  };
}

function layoutFacts(main) {
  const widths = Object.entries(main.layout.maxWidths).map(([w, n]) => ({ width: +w, n })).sort((a, b) => b.n - a.n || b.width - a.width);
  return { maxContentWidth: widths[0] ?? null, headerSticky: main.layout.headerSticky, gridColumns: main.vitals.gridMaxCols || null };
}

function responsiveFacts(res) {
  const names = ['desktop', 'tablet', 'mobile'].filter((n) => res?.[n]);
  const d = res?.desktop;
  const notes = [];
  for (const n of names) if (res[n].overflowX) notes.push({ kind: 'horizontal-overflow', viewport: n, detail: `${n} (${res[n].viewport[0]}px) scrolls horizontally` });
  const m = res?.mobile;
  if (d && m) {
    if (d.h1 && m.h1 && m.h1.size < d.h1.size * 0.9) notes.push({ kind: 'h1-scales-down', detail: `h1 ${d.h1.size}px on desktop → ${m.h1.size}px on mobile` });
    if (d.navLinksVisible >= 3 && (m.navLinksVisible ?? 0) <= 1) notes.push({ kind: 'nav-collapses', detail: `${d.navLinksVisible} header links on desktop → ${m.navLinksVisible ?? 0} on mobile${m.menuButtonVisible ? ' (menu button shown)' : ''}` });
    if (d.gridMaxCols && m.gridMaxCols !== d.gridMaxCols) notes.push({ kind: 'grid-reflows', detail: `max grid columns ${d.gridMaxCols} → ${m.gridMaxCols}` });
    if (d.bodyFontSize !== m.bodyFontSize) notes.push({ kind: 'body-size-changes', detail: `body ${d.bodyFontSize}px → ${m.bodyFontSize}px` });
  }
  return { viewports: names.map((n) => ({ name: n, ...res[n] })), notes };
}

/** Collapse observations from one or more pages (first = primary) into facts. */
export function analyze(observations) {
  const ok = observations.filter((o) => o.main);
  if (!ok.length) return null;
  const main = ok[0].main;
  const els = ok.flatMap((o) => o.main.elements);
  const dark = ok[0].dark;
  const light = ok[0].light;
  let scheme = { responds: null, dark: null };
  if (dark && light) {
    const moved = deltaEOK(rgb3(dark.bg), rgb3(light.bg)) > 0.05;
    scheme = { responds: moved, dark: moved ? { background: rgb3(dark.bg), text: rgb3(dark.text) } : null };
  }
  const pageBgs = ok.map((o) => rgb3(o.main.pageBg.rgba));
  return {
    pages: ok.map((o) => ({ url: o.finalUrl ?? o.url, title: o.main.title, elements: o.main.elements.length, of: o.main.elementsTotal })),
    pageBgAgreement: pageBgs.every((c) => deltaEOK(c, pageBgs[0]) < SAME_COLOR),
    site: { title: main.title, name: main.siteName, lang: main.lang, description: main.description },
    colors: colorFacts(els, main),
    typography: typographyFacts(els, main, ok[0].rendered),
    spacing: spacingFacts(els),
    shape: shapeFacts(els),
    layout: layoutFacts(main),
    responsive: responsiveFacts(ok[0].responsive),
    scheme,
    vars: main.vars,
    unreadableSheets: main.unreadableSheets,
    assets: { logos: main.logos, icons: main.icons, ogImage: main.ogImage, manifest: main.manifest, themeColor: main.themeColor, fetched: ok[0].fetched ?? null, inlineLogoSaved: ok[0].inlineLogoSaved ?? null },
    failedResources: ok[0].failedResources ?? [],
    errors: observations.flatMap((o) => o.errors ?? []),
  };
}

export function logoScore(l) {
  return (l.homeLink ? 3 : 0) + (l.inHeader ? 2 : 0) + (l.named ? 2 : 0) + (l.kind === 'img' || l.svg ? 0.5 : 0);
}

export function iconRank(i) {
  const size = parseInt(String(i.sizes ?? '').split('x')[0], 10) || 0;
  return (/svg/.test(i.type ?? '') || /\.svg(\?|$)/.test(i.href) ? 1000 : 0) + size + (i.rel === 'apple-touch-icon' ? 50 : 0);
}
