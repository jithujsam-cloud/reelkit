// Builds the design profile (JSON + Markdown) from rendered observations and declared evidence.
// Facts are "observed", declarations are "declared", heuristics are "inferred"; missing values stay
// null with a reason. Nothing here reads Reelkit's own frame defaults.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { NAME, SKILL_DIR, VERSION } from '../brand.mjs';
import { contrastRatio, deltaEOK, parseHex, relativeLuminance, toHex } from '../color.mjs';
import { findConflicts, inferred, isChromatic, levelOf, pickColor, pickValue, round, SAME_COLOR, SAME_NEUTRAL, clusterColors, oklchOf } from './reconcile.mjs';
import path from 'node:path';
import { roleFromName } from './source.mjs';

export const PROFILE_VERSION = 1;
export const SCHEMA_FILE = path.join(SKILL_DIR, 'schema', 'design-profile.schema.json');

const hex = (rgba) => (rgba ? toHex(rgba) : null);
const GENERIC_FONTS = new Set(['ui-sans-serif', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'sans-serif', 'serif', 'monospace', 'ui-monospace', 'segoe ui', 'roboto', 'helvetica neue', 'arial', 'helvetica', 'ui-serif', 'cursive']);
const first = (stack) => (stack || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
const median = (xs) => {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const topEntries = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
const mergeCounts = (list) => list.reduce((acc, c) => {
  for (const [k, v] of Object.entries(c)) acc[k] = (acc[k] || 0) + v;
  return acc;
}, {});

/** Colour candidates for every palette role, for one theme. */
function paletteCandidates(obs, declared, theme) {
  const c = { background: [], surface: [], text: [], textMuted: [], border: [], primary: [], accent: [] };
  const push = (role, h, type, detail, o, weight) => h && c[role].push({ hex: h, type, detail, route: o?.route, theme: o?.theme, ...(weight ? { weight } : {}) });
  for (const o of obs) {
    const p = o.probe;
    const bg = hex(p.page.background);
    push('background', bg, 'rendered-role', `${p.page.backgroundFrom} background-color`, o);
    push('text', hex(p.page.color), 'rendered-role', 'body color', o);
    const bgRgb = p.page.background;
    // Text colours by covered area: the dominant one is body text, a lower-contrast one is muted text.
    const texts = topEntries(p.counts.textColor, 6).map(([k]) => k.split(',').map(Number));
    if (texts[0]) push('text', toHex(texts[0]), 'rendered-role', 'most common text colour', o);
    if (bgRgb && texts.length > 1) {
      const main = texts[0];
      const muted = texts.slice(1).find((t) => contrastRatio(t, bgRgb) < contrastRatio(main, bgRgb) - 1 && !isChromatic(t));
      if (muted) push('textMuted', toHex(muted), 'rendered-role', 'secondary text colour (lower contrast)', o);
    }
    for (const s of p.surfaces.slice(0, 4)) {
      if (bgRgb && deltaEOK(s.bg, bgRgb) > 0.01 && !isChromatic(s.bg)) push('surface', hex(s.bg), 'rendered-role', `surface ${s.el}`, o);
    }
    const borders = topEntries(p.counts.border, 1);
    if (borders[0]) push('border', toHex(borders[0][0].split('|')[0].split(',').map(Number)), 'rendered-role', 'most common border colour', o);
    for (const b of p.buttons) {
      if (isChromatic(b.bg)) push('primary', hex(b.bg), 'rendered-role', `${b.hint ? 'primary-styled ' : ''}button ${b.el}${b.label ? ` "${b.label}"` : ''}`, o, b.hint ? 3.5 : 2.5);
    }
    for (const a of p.active) {
      if (a.bg && isChromatic(a.bg)) push('primary', hex(a.bg), 'rendered-role', `active item ${a.el}`, o, 1.5);
      else if (isChromatic(a.color)) push('primary', hex(a.color), 'rendered-role', `active item text ${a.el}`, o, 1.5);
    }
    const linkColors = {};
    for (const l of p.links) if (l.color && isChromatic(l.color)) linkColors[toHex(l.color)] = (linkColors[toHex(l.color)] || 0) + 1;
    for (const [h, n] of topEntries(linkColors, 2)) push('primary', h, 'rendered-role', `link colour (${n} links)`, o, 1.5);
    for (const [name, v] of Object.entries(p.vars)) {
      if (!v.rgba || v.rgba[3] < 0.5) continue;
      const role = roleFromName(name);
      if (role && c[role]) push(role, hex(v.rgba), 'rendered-var', `computed ${name}`, o);
    }
    for (const t of p.assets.themeColor) {
      if (!t.rgba) continue;
      const forTheme = !t.media || (theme === 'dark' ? /dark/.test(t.media) : /light/.test(t.media));
      if (forTheme && isChromatic(t.rgba)) push('primary', hex(t.rgba), 'meta', `<meta name="theme-color"${t.media ? ` media="${t.media}"` : ''}>`, o);
    }
    for (const logo of p.assets.logos) {
      for (const col of logo.colors ?? []) {
        const rgb = col.split(',').map(Number);
        if (isChromatic(rgb)) push('primary', toHex(rgb), 'logo', `logo ${logo.el}`, o);
      }
    }
    for (const px of o.census) {
      if (px.chromatic && px.share >= 0.002) push('primary', px.hex, 'pixel', `${(px.share * 100).toFixed(1)}% of the screenshot`, o, Math.min(1.5, px.share / 0.02));
      if (!px.chromatic && px.share >= 0.25) push('background', px.hex, 'pixel', `${(px.share * 100).toFixed(1)}% of the screenshot`, o);
    }
  }
  for (const d of declared.colors) {
    if (!d.role || (theme === 'dark') !== !!d.dark) continue;
    // A declared "accent" may support the brand slot, but only declared primary/brand values can
    // conflict with it (accent-2, accent-3 … are other hues, not claims about the brand colour).
    const role = d.role === 'accent' ? 'primary' : d.role;
    if (c[role]) c[role].push({ hex: d.hex, type: d.type, detail: d.detail, declaredRole: d.role });
  }
  for (const m of declared.manifests) {
    if (m.theme_color && parseHex(m.theme_color) && isChromatic(m.theme_color)) c.primary.push({ hex: toHex(parseHex(m.theme_color)), type: 'meta', detail: `${m.file} theme_color` });
  }
  return c;
}

function buildPalette(obs, declared, theme, conflicts) {
  if (!obs.length && !declared.colors.some((d) => (theme === 'dark') === !!d.dark)) return null;
  const c = paletteCandidates(obs, declared, theme);
  const roles = {};
  for (const role of ['background', 'surface', 'text', 'textMuted', 'border']) {
    roles[role] = pickColor(role, c[role], { tolerance: SAME_NEUTRAL, emptyReason: obs.length ? `no ${role} colour could be measured` : 'site not rendered; no declared value either' });
  }
  roles.primary = pickColor('primary', c.primary, {
    chromaticOnly: true,
    emptyReason: obs.length ? 'no chromatic brand colour observed: the UI appears monochrome, or the accent is only in images' : 'site not rendered and no declared brand colour',
  });
  for (const role of Object.keys(roles)) {
    const claims = c[role].filter((x) => !x.declaredRole || x.declaredRole === role);
    conflicts.push(...findConflicts(`${theme}.${role}`, roles[role], claims));
  }
  // Other recurring hues on the rendered site, excluding the primary.
  const chromaticRendered = c.primary.filter((x) => ['rendered-role', 'pixel', 'logo', 'rendered-var'].includes(x.type));
  // Tints and shades of the primary (same hue family) are part of the brand colour, not other hues.
  const primaryHue = roles.primary.value ? oklchOf(roles.primary.value)[2] : null;
  const sameFamily = (h) => {
    if (primaryHue === null) return false;
    const d = Math.abs(oklchOf(h)[2] - primaryHue);
    return Math.min(d, 360 - d) < 20;
  };
  const clusters = clusterColors(chromaticRendered).filter((k) => !roles.primary.value || (deltaEOK(parseHex(k.hex), parseHex(roles.primary.value)) > SAME_COLOR * 2 && !sameFamily(k.hex)));
  // Require real support: single gradient-blend pixels are not a hue the brand uses.
  const accents = clusters.filter((k) => k.weight >= 1.5 || k.kinds.size >= 2).slice(0, 3).map((k) => ({
    value: k.hex,
    oklch: oklchOf(k.hex),
    basis: 'observed',
    confidence: round(Math.min(0.9, k.weight / 10), 2),
    level: levelOf(Math.min(0.9, k.weight / 10)),
    sources: [...new Set(k.members.map((m) => m.detail))].sort().slice(0, 4).map((detail) => ({ type: k.members.find((m) => m.detail === detail).type, detail })),
  }));
  return { roles, accents };
}

export const FONT_NOT_LOADED = 'web font declared but not loaded (a fallback renders)';

/** Web fonts are those registered in document.fonts; anything else is a font installed on the machine. */
function fontStatus(family, loadedFamilies, webFamilies) {
  if (!family) return 'unknown';
  const key = family.toLowerCase();
  if (GENERIC_FONTS.has(key)) return 'system font stack';
  if (loadedFamilies.has(key)) return 'loaded web font';
  if (webFamilies.has(key)) return FONT_NOT_LOADED;
  return 'local font (not a web font; depends on the viewer having it installed)';
}

function buildTypography(obs, declared, conflicts) {
  const desktop = obs.filter((o) => o.viewport === 'desktop' && o.theme === 'light');
  const base = desktop.length ? desktop : obs;
  const loaded = new Set(obs.flatMap((o) => o.probe.fonts.filter((f) => f.status === 'loaded').map((f) => f.family.toLowerCase())));
  const webFamilies = new Set(obs.flatMap((o) => o.probe.fonts.map((f) => f.family.toLowerCase())));
  const cand = { heading: [], body: [], mono: [] };
  for (const o of base) {
    cand.body.push({ value: first(o.probe.page.font), type: 'rendered-role', detail: 'body font-family', route: o.route });
    const h = o.probe.headings.find((x) => x.level === 1) ?? o.probe.headings[0];
    if (h) cand.heading.push({ value: first(h.family), type: 'rendered-role', detail: `h${h.level} font-family`, route: o.route });
    for (const m of o.probe.monoFamilies) cand.mono.push({ value: m, type: 'rendered-role', detail: 'code / monospace text', route: o.route });
  }
  for (const f of declared.fonts) {
    if (f.role === 'heading' || f.role === 'body' || f.role === 'mono') cand[f.role].push({ value: f.family, type: f.type, detail: f.detail });
  }
  const out = {};
  for (const role of ['heading', 'body', 'mono']) {
    const f = pickValue(role, cand[role], { breadthByRoutes: true, emptyReason: role === 'mono' ? 'no monospace text observed' : 'no text measured' });
    if (f.value) {
      const stack = role === 'body' ? base[0]?.probe.page.font : role === 'heading' ? base.flatMap((o) => o.probe.headings).find((x) => first(x.family) === f.value)?.family : null;
      f.stack = stack ?? null;
      f.status = fontStatus(f.value, loaded, webFamilies);
    }
    out[role] = f;
  }
  // Declared fonts that the rendered site does not use.
  const renderedFamilies = new Set(base.flatMap((o) => [first(o.probe.page.font), ...o.probe.headings.map((h) => first(h.family))]).map((s) => s.toLowerCase()));
  for (const f of declared.fonts.filter((x) => x.type === 'docs')) {
    if (obs.length && !renderedFamilies.has(f.family.toLowerCase()) && !loaded.has(f.family.toLowerCase())) {
      conflicts.push({ field: `typography.${f.role}`, observed: out[f.role === 'any' ? 'body' : f.role]?.value ?? null, declared: f.family, declaredIn: f.detail, sourceType: 'docs', resolution: 'the documented font is not used by the rendered site; the rendered font is reported.' });
    }
  }
  const sizes = (lvl) => median(base.flatMap((o) => o.probe.headings.filter((h) => h.level === lvl).map((h) => h.size)));
  const weights = (lvl) => median(base.flatMap((o) => o.probe.headings.filter((h) => h.level === lvl).map((h) => h.weight)));
  out.scale = {
    basis: base.length ? 'observed' : 'unknown',
    body: { size: median(base.map((o) => o.probe.page.fontSize)), lineHeight: base[0]?.probe.page.lineHeight ?? null },
    h1: { size: sizes(1), weight: weights(1) },
    h2: { size: sizes(2), weight: weights(2) },
    h3: { size: sizes(3), weight: weights(3) },
  };
  const faces = {};
  for (const o of obs) for (const f of o.probe.fonts) if (f.status === 'loaded') (faces[f.family] ??= new Set()).add(f.weight);
  out.webFonts = Object.keys(faces).sort().map((family) => ({ family, weights: [...faces[family]].sort() }));
  return out;
}

function buildShape(obs) {
  const desk = obs.filter((o) => o.viewport === 'desktop');
  const base = desk.length ? desk : obs;
  if (!base.length) return { radius: { value: null, basis: 'unknown', confidence: 0, level: 'low', reason: 'site not rendered', sources: [] }, shadows: null, borders: null, spacing: null };
  const radius = mergeCounts(base.map((o) => o.probe.counts.radius));
  const shadows = mergeCounts(base.map((o) => o.probe.counts.shadow));
  const borders = mergeCounts(base.map((o) => o.probe.counts.border));
  const spacing = mergeCounts(base.map((o) => o.probe.counts.spacing));
  const radii = topEntries(radius, 5).map(([v, n]) => ({ px: +v, uses: n }));
  const main = radii.filter((r) => r.px < 999)[0]?.px ?? 0;
  const style = !radii.length ? 'sharp' : main <= 3 ? 'sharp' : main <= 8 ? 'subtle' : main <= 16 ? 'rounded' : 'soft';
  const shadowList = topEntries(shadows, 3);
  const surfaces = base.reduce((s, o) => s + o.probe.surfaces.length, 0);
  const withShadow = base.reduce((s, o) => s + o.probe.surfaces.filter((x) => x.shadow).length, 0);
  const elevation = !shadowList.length ? 'flat' : withShadow / Math.max(1, surfaces) > 0.5 ? 'elevated surfaces' : 'occasional shadows';
  const borderTop = topEntries(borders, 1)[0];
  const spacingTop = topEntries(spacing, 8).map(([v, n]) => ({ px: +v, uses: n }));
  const totalUses = spacingTop.reduce((s, x) => s + x.uses, 0);
  const share = (unit) => spacingTop.filter((x) => x.px % unit === 0).reduce((s, x) => s + x.uses, 0) / Math.max(1, totalUses);
  const unit = share(8) >= 0.7 ? 8 : share(4) >= 0.7 ? 4 : null;
  return {
    radius: { value: radii, basis: 'observed', confidence: 0.9, level: 'high', style: inferred(style, 0.7, `most common corner radius ${main}px`), sources: [{ type: 'rendered-role', detail: 'border-radius of visible filled elements' }] },
    shadows: { value: shadowList.map(([v, n]) => ({ css: v, uses: n })), basis: 'observed', confidence: 0.9, level: 'high', style: inferred(elevation, 0.65, `${withShadow} of ${surfaces} large surfaces have a shadow`), sources: [{ type: 'rendered-role', detail: 'box-shadow of visible elements' }] },
    borders: borderTop
      ? { value: { color: toHex(borderTop[0].split('|')[0].split(',').map(Number)), width: +borderTop[0].split('|')[1] }, basis: 'observed', confidence: 0.8, level: 'high', sources: [{ type: 'rendered-role', detail: 'most common border' }] }
      : { value: null, basis: 'observed', confidence: 0.7, level: 'medium', reason: 'no visible borders measured', sources: [] },
    spacing: { value: spacingTop, baseUnit: unit ? inferred(unit, round(Math.max(share(8), share(4)), 2), `${Math.round(share(unit) * 100)}% of common spacing values are multiples of ${unit}px`) : inferred(null, 0.3, 'no consistent 4px/8px grid'), basis: 'observed', confidence: 0.8, level: 'high', sources: [{ type: 'rendered-role', detail: 'padding/gap/margin of visible elements' }] },
  };
}

function buildLayout(obs) {
  const desk = obs.filter((o) => o.viewport === 'desktop');
  if (!desk.length) return { value: null, basis: 'unknown', reason: 'no desktop observation' };
  const sidebar = desk.filter((o) => o.probe.layout.sidebar).length;
  const top = desk.filter((o) => o.probe.layout.topNav).length;
  const navigation = sidebar > top ? 'sidebar' : top ? 'top bar' : 'none detected';
  const widths = desk.map((o) => o.probe.layout.maxContentWidth).filter(Boolean);
  const bgShare = median(desk.map((o) => o.census[0]?.share ?? 0));
  const density = bgShare >= 0.6 ? 'airy' : bgShare >= 0.35 ? 'balanced' : 'dense';
  return {
    navigation: inferred(navigation, desk.length > 1 ? 0.75 : 0.55, `${sidebar} of ${desk.length} desktop pages have a full-height side navigation, ${top} a top bar`),
    maxContentWidth: { value: median(widths), basis: 'observed', confidence: widths.length ? 0.6 : 0, level: widths.length ? 'medium' : 'low', note: 'widest content block narrower than the viewport' },
    density: inferred(density, 0.6, `the dominant (background) colour covers ${Math.round((bgShare ?? 0) * 100)}% of a typical desktop screenshot`),
  };
}

function buildResponsive(obs) {
  const routes = [...new Set(obs.map((o) => o.route))].sort();
  const out = [];
  for (const route of routes) {
    const d = obs.find((o) => o.route === route && o.viewport === 'desktop' && o.theme === 'light') ?? obs.find((o) => o.route === route && o.viewport === 'desktop');
    const m = obs.find((o) => o.route === route && o.viewport === 'mobile' && o.theme === 'light') ?? obs.find((o) => o.route === route && o.viewport === 'mobile');
    if (!d || !m) continue;
    const h1 = (o) => o.probe.headings.find((h) => h.level === 1)?.size ?? null;
    out.push({
      route,
      desktop: { navigation: d.probe.layout.sidebar ? 'sidebar' : d.probe.layout.topNav ? 'top bar' : 'none', h1: h1(d), overflowX: d.probe.layout.overflowX },
      mobile: { navigation: m.probe.layout.sidebar ? 'sidebar' : m.probe.layout.topNav ? 'top bar' : 'none', h1: h1(m), overflowX: m.probe.layout.overflowX },
      basis: 'observed',
    });
  }
  return out;
}

function buildAssets(obs, declared, savedLogos) {
  const icons = new Map();
  const theme = new Map();
  let manifest = null;
  let og = null;
  for (const o of obs) {
    for (const i of o.probe.assets.icons) icons.set(`${i.rel}|${i.href}`, i);
    for (const t of o.probe.assets.themeColor) theme.set(`${t.content}|${t.media}`, { value: t.content, media: t.media });
    manifest ??= o.probe.assets.manifest;
    og ??= o.probe.assets.ogImage;
  }
  return {
    logos: savedLogos,
    icons: [...icons.values()].sort((a, b) => `${a.rel}${a.href}`.localeCompare(`${b.rel}${b.href}`)),
    themeColor: [...theme.values()].sort((a, b) => `${a.value}${a.media}`.localeCompare(`${b.value}${b.media}`)),
    manifest: manifest ? { href: manifest, ...(obs.find((o) => o.manifest)?.manifest ?? {}) } : null,
    ogImage: og,
    declaredManifests: declared.manifests,
  };
}

/** Which colour schemes the site really supports. */
function themeSupport(byTheme, declared) {
  const light = byTheme.light ?? [];
  const dark = byTheme.dark ?? [];
  const pairs = light.map((l) => [l, dark.find((d) => d.route === l.route && d.viewport === l.viewport)]).filter(([, d]) => d);
  const changed = pairs.filter(([l, d]) => l.probe.page.background && d.probe.page.background && deltaEOK(l.probe.page.background, d.probe.page.background) > 0.1);
  const lightBg = light.map((o) => o.probe.page.background).filter(Boolean);
  const darkByDefault = lightBg.length && lightBg.every((b) => relativeLuminance(b) < 0.1);
  const classRules = Math.max(0, ...[...light, ...dark].map((o) => o.probe.darkSelectorRules));
  const declaredDark = declared.colors.some((c) => c.dark);
  let mode;
  let dark_;
  if (changed.length) {
    mode = 'light and dark';
    dark_ = { status: 'supported', via: 'prefers-color-scheme', basis: 'observed', evidence: `${changed.length} of ${pairs.length} pages change background under a dark colour scheme` };
  } else if (darkByDefault) {
    mode = 'dark only';
    dark_ = { status: 'default', via: 'always dark', basis: 'observed', evidence: 'the default rendering is already dark' };
  } else if (classRules || declaredDark) {
    mode = 'light (dark unverified)';
    dark_ = { status: 'unverified', via: 'class or attribute toggle suspected', basis: 'inferred', evidence: `${classRules} CSS rules target .dark/[data-theme=dark]${declaredDark ? '; dark tokens declared in source' : ''}, but prefers-color-scheme did not change the page` };
  } else {
    mode = light.length ? 'light only' : 'unknown';
    dark_ = { status: light.length ? 'not detected' : 'unknown', basis: light.length ? 'observed' : 'unknown', evidence: light.length ? 'no change under prefers-color-scheme: dark and no dark rules found' : 'site not rendered' };
  }
  return { mode, dark: dark_ };
}

/**
 * Assemble the profile. `run` = { cfg, routes: [{url, status, reason?, themes, viewports}], observations,
 * declared (scanProject result), savedLogos, sourceRoot }.
 */
export function buildProfile(run) {
  const { observations: obs, declared } = run;
  const byTheme = { light: obs.filter((o) => o.theme === 'light'), dark: obs.filter((o) => o.theme === 'dark') };
  const conflicts = [];
  const unverified = [];
  const support = themeSupport(byTheme, declared);
  const palette = { light: buildPalette(byTheme.light, declared, 'light', conflicts), dark: null };
  if (support.dark.status === 'supported') palette.dark = buildPalette(byTheme.dark, declared, 'dark', conflicts);
  else if (support.dark.status === 'default') palette.dark = null;

  // Declared CSS variables whose rendered value differs (stale source or runtime override).
  const rendered = new Map();
  for (const o of byTheme.light) for (const [name, v] of Object.entries(o.probe.vars)) if (v.rgba) rendered.set(name, toHex(v.rgba));
  for (const d of declared.colors.filter((x) => x.type === 'source-css' && !x.dark && x.name?.startsWith('--'))) {
    const r = rendered.get(d.name);
    if (r && deltaEOK(parseHex(r), parseHex(d.hex)) > SAME_COLOR) {
      conflicts.push({ field: `cssVar.${d.name}`, observed: r, declared: d.hex, declaredIn: d.detail, sourceType: 'source-css', deltaE: round(deltaEOK(parseHex(r), parseHex(d.hex)), 3), resolution: 'the rendered value is used; the scanned source differs from what is deployed.' });
    }
  }

  const typography = buildTypography(obs, declared, conflicts);
  const shape = buildShape(obs);
  const layout = buildLayout(obs);
  const assets = buildAssets(obs, declared, run.savedLogos ?? []);

  // What could not be verified.
  for (const r of run.routes.filter((x) => x.status !== 'ok')) unverified.push(`${r.url}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
  if (!obs.length) unverified.push('No page could be rendered: every value below is declared (from source/docs) or unknown, never observed.');
  if (support.dark.status === 'unverified') unverified.push(`Dark theme: ${support.dark.evidence}. Not captured.`);
  const cross = Math.max(0, ...obs.map((o) => o.probe.crossOriginSheets));
  if (cross) unverified.push(`${cross} cross-origin stylesheet(s) could not be read; their custom properties are only seen as computed values.`);
  if (obs.length && !assets.logos.length) unverified.push('No logo element was detected on the inspected pages.');
  if (palette.light && !palette.light.roles.primary.value) unverified.push(`Brand colour: ${palette.light.roles.primary.reason}.`);
  for (const role of ['heading', 'body']) if (typography[role]?.status === FONT_NOT_LOADED) unverified.push(`${role} font "${typography[role].value}" is a web font that did not finish loading; a fallback renders.`);
  for (const role of ['heading', 'body']) if (typography[role]?.status?.startsWith('local font')) unverified.push(`${role} font "${typography[role].value}" is not a web font; whether viewers see it depends on their installed fonts.`);
  if (!run.sourceRoot) unverified.push('Project source was not scanned (--no-source); only the rendered site was inspected.');
  // Declared accent colours that never appear on the rendered pages.
  if (obs.length) {
    const seen = [...obs.flatMap((o) => o.census.map((c) => c.hex)), ...Object.values(palette).filter(Boolean).flatMap((p) => [p.roles.primary.value, ...p.accents.map((a) => a.value)]).filter(Boolean)];
    for (const d of declared.colors.filter((x) => x.role === 'accent')) {
      if (!seen.some((h) => deltaEOK(parseHex(h), parseHex(d.hex)) <= SAME_COLOR)) unverified.push(`Declared accent ${d.hex} (${d.detail}) was not among the measured colours of the inspected pages (it may be used sparingly or on other pages).`);
    }
  }

  const primary = palette.light?.roles.primary;
  const colorCharacter = !obs.length ? null : !primary?.value ? 'monochrome' : (palette.light.accents.length ? 'brand colour with supporting hues' : 'single brand colour');
  const bg = palette.light?.roles.background.value;
  const text = palette.light?.roles.text.value;
  const style = {
    mode: { value: support.mode, basis: support.dark.basis === 'unknown' ? 'unknown' : support.dark.basis === 'inferred' ? 'inferred' : 'observed' },
    colorCharacter: obs.length ? inferred(colorCharacter, 0.7, `${palette.light.accents.length} other recurring hue(s) besides the primary`) : null,
    contrast: bg && text ? { value: round(contrastRatio(parseHex(text), parseHex(bg)), 2), basis: [palette.light.roles.text.basis, palette.light.roles.background.basis].every((b) => b === 'observed') ? 'observed' : 'declared', note: 'body text vs page background (WCAG ratio)' } : null,
    corners: shape.radius?.style ?? null,
    elevation: shape.shadows?.style ?? null,
    density: layout.density ?? null,
  };

  const coverage = {
    status: obs.length ? (run.routes.every((r) => r.status === 'ok') ? 'complete' : 'partial') : 'not rendered',
    routes: run.routes,
    themes: { light: byTheme.light.length ? 'inspected' : 'not inspected', dark: support.dark.status },
    viewports: [...new Set(obs.map((o) => o.viewport))].sort(),
    sourceRoot: run.sourceRoot ?? null,
    sourceFiles: declared.files,
    docs: declared.docs,
  };

  const designSystems = declared.designSystems.map((d) => ({ value: d.name, basis: 'declared', confidence: 0.6, level: 'medium', sources: [{ type: 'source-tokens', detail: d.detail }] }));

  const profile = {
    profileVersion: PROFILE_VERSION,
    generator: `${NAME} ${VERSION}`,
    site: { baseUrl: run.baseUrl, name: run.cfg.name ?? null },
    coverage,
    summary: summaryLine({ support, primary, typography, shape, layout, obs }),
    palette,
    typography,
    shape: { radius: shape.radius, shadows: shape.shadows, borders: shape.borders },
    spacing: shape.spacing,
    layout,
    responsive: buildResponsive(obs),
    style,
    assets,
    designSystems,
    observedColors: obs.length ? topColors(obs) : [],
    conflicts: dedupeConflicts(conflicts),
    unverified,
  };
  return profile;
}

function topColors(obs) {
  const acc = new Map();
  for (const o of obs.filter((x) => x.viewport === 'desktop')) {
    for (const c of o.census) {
      const k = `${o.theme}|${c.hex}`;
      const e = acc.get(k) ?? { hex: c.hex, theme: o.theme, chromatic: c.chromatic, share: 0, pages: 0 };
      e.share += c.share;
      e.pages += 1;
      acc.set(k, e);
    }
  }
  const pagesPerTheme = (t) => obs.filter((o) => o.viewport === 'desktop' && o.theme === t).length || 1;
  return [...acc.values()]
    .map((e) => ({ hex: e.hex, theme: e.theme, chromatic: e.chromatic, share: round(e.share / pagesPerTheme(e.theme), 4) }))
    .filter((e) => e.share >= 0.002)
    .sort((a, b) => a.theme.localeCompare(b.theme) || b.share - a.share || a.hex.localeCompare(b.hex))
    .slice(0, 24);
}

function dedupeConflicts(list) {
  const seen = new Set();
  return list
    .filter((c) => {
      const k = `${c.field}|${c.declared}|${c.declaredIn}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.field.localeCompare(b.field) || String(a.declared).localeCompare(String(b.declared)));
}

function summaryLine({ support, primary, typography, shape, layout, obs }) {
  if (!obs.length) return { value: 'The site could not be rendered; see coverage and unverified.', basis: 'unknown' };
  const parts = [
    `${support.mode} UI`,
    primary?.value ? `brand colour ${primary.value} (${primary.level} confidence)` : 'no chromatic brand colour observed',
    typography.body?.value ? `${typography.body.value} text${typography.heading?.value && typography.heading.value !== typography.body.value ? `, ${typography.heading.value} headings` : ''}` : null,
    shape.radius?.style?.value ? `${shape.radius.style.value} corners` : null,
    shape.shadows?.style?.value ?? null,
    layout.navigation?.value && layout.navigation.value !== 'none detected' ? `${layout.navigation.value} navigation` : null,
    layout.density?.value ? `${layout.density.value} density` : null,
  ].filter(Boolean);
  return { value: parts.join(', '), basis: 'inferred', note: 'generated from the findings below; each part carries its own confidence' };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

let compiled;
export function validateProfile(profile) {
  compiled ??= new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')));
  const ok = compiled(profile);
  return { ok, errors: ok ? [] : compiled.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`) };
}

// ---------------------------------------------------------------------------
// Markdown rendering (deterministic)
// ---------------------------------------------------------------------------

const conf = (f) => (f?.value === null || f?.value === undefined ? '—' : `${f.level} (${f.confidence})`);
/** Evidence column: identical observations on several pages are grouped ("×3 pages"). */
const srcs = (f, n = 3) => {
  const groups = new Map();
  for (const s of f?.sources ?? []) {
    const k = `${s.type}: ${s.detail}`;
    const g = groups.get(k) ?? { label: k, routes: new Set() };
    if (s.route) g.routes.add(s.route);
    groups.set(k, g);
  }
  const lines = [...groups.values()].slice(0, n).map((g) => `${g.label}${g.routes.size ? ` (${[...g.routes].sort().join(', ')})` : ''}`);
  return lines.join('<br>') || (f?.reason ?? '');
};
const swatch = (h) => (h ? `\`${h}\`` : '—');

export function profileMarkdown(p) {
  const L = [];
  L.push(`# Design profile${p.site.name ? `: ${p.site.name}` : ''}`, '');
  L.push(`Generated by ${p.generator} from ${p.site.baseUrl}. Profile format v${p.profileVersion}.`, '');
  L.push(`**Summary (inferred):** ${p.summary.value}`, '');
  L.push('Legend: **observed** = measured on the rendered site; **declared** = found only in source or docs; **inferred** = a heuristic reading of observed facts. Confidence is 0-1.', '');

  L.push('## Coverage', '');
  L.push(`Status: **${p.coverage.status}**. Viewports: ${p.coverage.viewports.join(', ') || 'none'}. Light: ${p.coverage.themes.light}; dark: ${p.coverage.themes.dark}.`, '');
  L.push('| Route | Status | Notes |', '|---|---|---|');
  for (const r of p.coverage.routes) L.push(`| \`${r.url}\` | ${r.status} | ${r.reason ?? `${r.themes.join(', ')} · ${r.viewports.join(', ')}`} |`);
  L.push('', `Source scanned: ${p.coverage.sourceRoot ? `\`${p.coverage.sourceRoot}\` (${p.coverage.sourceFiles.length} files${p.coverage.docs.length ? `; docs: ${p.coverage.docs.map((d) => `\`${d}\``).join(', ')}` : ''})` : 'no'}.`, '');

  for (const theme of ['light', 'dark']) {
    const pal = p.palette[theme];
    if (!pal) continue;
    L.push(`## Palette (${theme})`, '');
    L.push('| Role | Colour | Basis | Confidence | Evidence |', '|---|---|---|---|---|');
    for (const [role, f] of Object.entries(pal.roles)) L.push(`| ${role} | ${swatch(f.value)} | ${f.basis} | ${conf(f)} | ${srcs(f)} |`);
    for (const a of pal.accents) L.push(`| other hue | ${swatch(a.value)} | ${a.basis} | ${conf(a)} | ${srcs(a, 2)} |`);
    L.push('');
  }
  if (p.observedColors.length) {
    L.push('### Colour coverage on desktop screenshots', '', '| Colour | Theme | Share | Hue? |', '|---|---|---|---|');
    for (const c of p.observedColors.slice(0, 12)) L.push(`| ${swatch(c.hex)} | ${c.theme} | ${(c.share * 100).toFixed(1)}% | ${c.chromatic ? 'yes' : 'neutral'} |`);
    L.push('');
  }

  L.push('## Typography', '', '| Role | Family | Status | Basis | Confidence | Evidence |', '|---|---|---|---|---|---|');
  for (const role of ['heading', 'body', 'mono']) {
    const f = p.typography[role];
    L.push(`| ${role} | ${f.value ? `\`${f.value}\`` : '—'} | ${f.status ?? '—'} | ${f.basis} | ${conf(f)} | ${srcs(f, 2)} |`);
  }
  const s = p.typography.scale;
  L.push('', `Scale (desktop, px): body ${s.body.size ?? '—'} · h1 ${s.h1.size ?? '—'}/${s.h1.weight ?? '—'} · h2 ${s.h2.size ?? '—'}/${s.h2.weight ?? '—'} · h3 ${s.h3.size ?? '—'}/${s.h3.weight ?? '—'} (size/weight).`);
  if (p.typography.webFonts.length) L.push(`Web fonts loaded: ${p.typography.webFonts.map((f) => `${f.family} (${f.weights.join(', ')})`).join('; ')}.`);
  L.push('');

  L.push('## Shape, depth and spacing', '');
  const r = p.shape.radius;
  if (r?.value) L.push(`- **Corner radius:** ${r.value.map((x) => `${x.px}px ×${x.uses}`).join(', ')} → *${r.style.value}* (inferred, ${r.style.because}).`);
  const sh = p.shape.shadows;
  if (sh) L.push(`- **Shadows:** ${sh.value.length ? sh.value.map((x) => `\`${x.css}\``).join('; ') : 'none'} → *${sh.style.value}* (inferred, ${sh.style.because}).`);
  const b = p.shape.borders;
  if (b) L.push(`- **Borders:** ${b.value ? `${swatch(b.value.color)} ${b.value.width}px` : b.reason}.`);
  if (p.spacing) L.push(`- **Spacing values:** ${p.spacing.value.map((x) => `${x.px}`).join(', ')} px; base unit: ${p.spacing.baseUnit.value ? `${p.spacing.baseUnit.value}px` : 'none'} (inferred, ${p.spacing.baseUnit.because}).`);
  L.push('');

  L.push('## Layout and responsive behaviour', '');
  if (p.layout.navigation) {
    L.push(`- **Navigation:** ${p.layout.navigation.value} (inferred, ${p.layout.navigation.because}).`);
    L.push(`- **Content width:** ${p.layout.maxContentWidth.value ?? '—'}px (observed, ${p.layout.maxContentWidth.level}).`);
    L.push(`- **Density:** ${p.layout.density.value} (inferred, ${p.layout.density.because}).`);
  } else L.push(`- ${p.layout.reason}.`);
  for (const x of p.responsive) L.push(`- \`${x.route}\`: desktop ${x.desktop.navigation}, h1 ${x.desktop.h1 ?? '—'}px → mobile ${x.mobile.navigation}, h1 ${x.mobile.h1 ?? '—'}px${x.mobile.overflowX ? ', **horizontal overflow on mobile**' : ''}.`);
  L.push('');

  L.push('## Style (inferred)', '');
  const st = p.style;
  L.push(`- Mode: ${st.mode.value} (${st.mode.basis}).`);
  if (st.colorCharacter) L.push(`- Colour character: ${st.colorCharacter.value} (${st.colorCharacter.because}).`);
  if (st.contrast) L.push(`- Text contrast: ${st.contrast.value}:1 (${st.contrast.note}; ${st.contrast.basis}).`);
  if (st.corners) L.push(`- Corners: ${st.corners.value}. Elevation: ${st.elevation?.value ?? '—'}. Density: ${st.density?.value ?? '—'}.`);
  L.push('');

  L.push('## Brand assets', '');
  const a = p.assets;
  L.push(`- **Logo:** ${a.logos.length ? a.logos.map((l) => `${l.kind} ${l.width}×${l.height}${l.file ? ` → \`${l.file}\`` : l.src ? ` (${l.src})` : ''}${l.colors?.length ? `, colours ${l.colors.map(swatch).join(' ')}` : ''}`).join('; ') : 'not detected'}.`);
  L.push(`- **Icons:** ${a.icons.length ? a.icons.map((i) => `${i.rel}${i.sizes ? ` ${i.sizes}` : ''}`).join(', ') : 'none declared'}.`);
  L.push(`- **theme-color:** ${a.themeColor.length ? a.themeColor.map((t) => `${swatch(t.value)}${t.media ? ` (${t.media})` : ''}`).join(', ') : 'none'}.`);
  L.push(`- **Web manifest:** ${a.manifest ? `${a.manifest.href}${a.manifest.theme_color ? `, theme_color ${swatch(a.manifest.theme_color)}` : ''}` : 'none'}. **og:image:** ${a.ogImage ?? 'none'}.`);
  if (p.designSystems.length) L.push(`- **Design system (declared):** ${p.designSystems.map((d) => `${d.value} (${d.sources[0].detail})`).join(', ')}.`);
  L.push('');

  L.push('## Conflicts', '');
  if (!p.conflicts.length) L.push('None found between the rendered site and the scanned source/docs.');
  else {
    L.push('| Field | Rendered | Declared | Where | Resolution |', '|---|---|---|---|---|');
    for (const c of p.conflicts) L.push(`| ${c.field} | ${c.observed ? swatch(c.observed) : '—'} | ${c.declared.startsWith?.('#') ? swatch(c.declared) : c.declared} | ${c.declaredIn} | ${c.resolution} |`);
  }
  L.push('');
  L.push('## Not verified', '');
  L.push(p.unverified.length ? p.unverified.map((u) => `- ${u}`).join('\n') : 'Everything listed above was observed or explicitly marked.');
  L.push('');
  return L.join('\n');
}
