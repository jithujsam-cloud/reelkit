// Builds the design profile from observed facts (analyze.mjs) and claims (claims.mjs / live CSS
// variables). Rules, in order of precedence:
//   1. What the rendered site shows beats everything else.
//   2. CSS variables served by the site rank next; repo docs/config files rank last (they rot).
//   3. A value nobody observed or declared is `null` with a reason. Nothing is filled in from
//      Reelkit's own defaults (guards.reelkitDefaults records when a real observation happens to match them).
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { VERSION, SKILL_DIR } from '../brand.mjs';
import path from 'node:path';
import { deltaEOK, toHex } from '../color.mjs';
import { oklch, logoScore, iconRank, SAME_COLOR } from './analyze.mjs';
import { roleFromName } from './claims.mjs';

export const SCHEMA_VERSION = 1;
export const SCHEMA_FILE = path.join(SKILL_DIR, 'schema', 'design-profile.schema.json');

/** Reelkit's own default palette. Mirrors `frame.accent` in config.mjs (a test keeps them in sync). */
export const REELKIT_DEFAULT_PALETTE = [
  { hex: '#7c5cff', source: 'frame.accent default' },
  { hex: '#22d3ee', source: 'demo app / aurora secondary' },
];

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const rgb3 = (c) => [c[0], c[1], c[2]];

export const levelOf = (c) => (c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : c > 0 ? 'low' : 'none');

/**
 * Confidence in an observed value, 0-1.
 *   base 0.5 + 0.35·share   (share = how much of the role's evidence agrees on this value)
 *   capped at 0.55 when fewer than 3 elements support it
 *   +0.10 per independent source that agrees (max +0.15)
 *   −0.15 per conflicting claim
 */
export function scoreConfidence({ share = 1, n = 3, corroboratedBy = 0, conflicts = 0, cap = 1 }) {
  let c = 0.5 + 0.35 * clamp(share);
  if (n < 3) c = Math.min(c, 0.55);
  c += Math.min(0.15, 0.1 * corroboratedBy);
  c -= 0.15 * conflicts;
  return round(clamp(Math.min(c, cap), 0.05, 1));
}

class Evidence {
  constructor() {
    this.items = [];
    this.index = new Map();
  }
  add(kind, where, detail) {
    const key = `${kind}|${where}|${detail}`;
    if (!this.index.has(key)) {
      const id = `e${this.items.length + 1}`;
      this.index.set(key, id);
      this.items.push({ id, kind, where, detail });
    }
    return this.index.get(key);
  }
}

const colorValue = (rgb) => {
  const [l, c, h] = oklch(rgb);
  return { hex: toHex(rgb), oklch: { l: round(l, 3), c: round(c, 3), h: round(h, 1) } };
};

function token(value, { confidence, sources = [], notes = [], basis }) {
  return { value, confidence, level: levelOf(confidence), sources, ...(basis ? { basis } : {}), ...(notes.length ? { notes } : {}) };
}

export function buildProfile({ facts, claims = [], repoFiles = [], designSystems = [], url, command = 'design' }) {
  const ev = new Evidence();
  const conflicts = [];
  const missing = [];
  const page = facts.pages[0];
  const where = page.url;
  const gone = (path_, reason) => {
    missing.push({ path: path_, reason });
    return { value: null, confidence: 0, level: 'none', sources: [], reason };
  };
  const rendered = (detail) => ev.add('rendered', where, detail);

  // Claims from the live site's CSS variables join the repo claims.
  const live = facts.vars
    .filter((v) => v.scope === 'root' && v.rgba && v.rgba[3] > 0.5)
    .map((v) => ({ kind: 'color', role: roleFromName(v.name), hex: toHex(rgb3(v.rgba)), origin: 'css-variable', where, via: `css-variable ${v.name}`, text: `${v.name}: ${v.raw}` }))
    .filter((c) => c.role);
  const repo = claims.filter((c) => c.kind === 'color' && (c.alpha ?? 1) > 0.5).map((c) => ({ ...c, origin: 'repo-file', where: c.line ? `${c.file}:${c.line}` : c.file }));
  const colorClaims = [...live, ...repo];
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  /** Resolve one colour role from an observed cluster plus any claims about the same role. */
  function color(pathKey, roles, observed, { basis, cap = 1, evidenceDetail, notes = [] } = {}) {
    const mine = colorClaims.filter((c) => roles.includes(c.role));
    const sources = [];
    const myNotes = [...notes];
    let corroboratedBy = 0;
    let nConflicts = 0;
    if (observed) {
      sources.push(rendered(evidenceDetail));
      const kindsAgreeing = new Set();
      for (const c of mine) {
        const d = deltaEOK(observed.rgb, parse(c.hex));
        const cid = ev.add(c.origin === 'css-variable' ? 'css-variable' : 'repo-file', c.where, c.text);
        if (d <= SAME_COLOR) {
          sources.push(cid);
          kindsAgreeing.add(c.origin);
        } else {
          nConflicts++;
          conflicts.push({
            path: pathKey,
            summary: `${c.via} says ${c.hex}, but the rendered site shows ${toHex(observed.rgb)}`,
            observed: { value: toHex(observed.rgb), evidence: sources[0] },
            claimed: { value: c.hex, evidence: cid, via: c.via },
            deltaE: round(d, 3),
            resolution: 'observed-kept',
          });
        }
      }
      corroboratedBy = kindsAgreeing.size;
      if (corroboratedBy) myNotes.push(`also declared by ${[...kindsAgreeing].join(' and ')}`);
      const conf = scoreConfidence({ share: observed.share ?? 1, n: observed.n ?? 3, corroboratedBy, conflicts: nConflicts, cap });
      return token(colorValue(observed.rgb), { confidence: conf, sources, notes: myNotes, basis });
    }
    if (mine.length) {
      // Declared but never seen: usable, but weak and labelled as such.
      const best = mine.find((c) => c.origin === 'css-variable') ?? mine[0];
      const cid = ev.add(best.origin === 'css-variable' ? 'css-variable' : 'repo-file', best.where, best.text);
      for (const c of mine) {
        if (c === best) continue;
        const d = deltaEOK(parse(best.hex), parse(c.hex));
        if (d > SAME_COLOR) {
          conflicts.push({
            path: pathKey,
            summary: `${c.via} says ${c.hex} but ${best.via} says ${best.hex}; neither was observed rendering`,
            observed: null,
            claimed: { value: c.hex, evidence: ev.add(c.origin === 'css-variable' ? 'css-variable' : 'repo-file', c.where, c.text), via: c.via },
            deltaE: round(d, 3),
            resolution: 'declared-used',
          });
          nConflicts++;
        }
      }
      return token(colorValue(parse(best.hex)), {
        confidence: scoreConfidence({ share: 0, n: 1, conflicts: nConflicts, cap: 0.35 }),
        sources: [cid],
        notes: [...myNotes, 'declared but not observed on the rendered page'],
        basis: 'declared-only',
      });
    }
    return null;
  }

  const C = facts.colors;
  const colors = {};
  const bgDefaulted = C.pageBg.defaulted;
  const bgToken = color('tokens.colors.background', ['background'], { rgb: C.pageBg.rgb, share: 1, n: 5 }, { evidenceDetail: `effective background of <body>${bgDefaulted ? ' (no opaque background found; assumed browser-default white)' : ''}`, cap: bgDefaulted ? 0.5 : 1, notes: bgDefaulted ? ['no opaque background was set; white is the browser default, not a design decision'] : [] });
  if (!facts.pageBgAgreement) {
    bgToken.notes = [...(bgToken.notes ?? []), 'background differs between the inspected pages'];
    bgToken.confidence = round(bgToken.confidence - 0.15);
    bgToken.level = levelOf(bgToken.confidence);
  }
  colors.background = bgToken;

  colors.text = C.topText
    ? color('tokens.colors.text', ['text'], { rgb: C.topText.rgb, share: C.topText.share, n: C.topText.n }, { evidenceDetail: `most used body-text colour (${C.topText.n} text elements)` })
    : color('tokens.colors.text', ['text'], null) ?? gone('tokens.colors.text', 'no visible body text was sampled');
  colors.textMuted = C.muted
    ? color('tokens.colors.textMuted', ['textMuted'], { rgb: C.muted.rgb, share: C.muted.share, n: C.muted.n }, { evidenceDetail: `secondary neutral text colour (${C.muted.n} elements)` })
    : color('tokens.colors.textMuted', ['textMuted'], null) ?? gone('tokens.colors.textMuted', 'no distinct secondary text colour observed');

  const primaryBasisNote = { interactive: null, 'neutral-interactive': 'brand appears monochrome: the primary action colour is a neutral', decorative: 'no interactive chromatic colour found; inferred from large decorative fills only' };
  if (C.primary) {
    const chromaticTotal = C.chromatic.reduce((s, c) => s + c.w, 0) || C.primary.w;
    colors.primary = color('tokens.colors.primary', ['primary'], { rgb: C.primary.rgb, share: C.primaryBasis === 'interactive' ? C.primary.w / chromaticTotal : C.primary.share, n: C.primary.n }, {
      basis: C.primaryBasis,
      cap: C.primaryBasis === 'decorative' ? 0.4 : 1,
      evidenceDetail: `most used ${C.primaryBasis === 'decorative' ? 'decorative fill' : 'interactive colour (button backgrounds, link text)'} (${C.primary.n} elements)`,
      notes: primaryBasisNote[C.primaryBasis] ? [primaryBasisNote[C.primaryBasis]] : [],
    });
  } else {
    colors.primary = color('tokens.colors.primary', ['primary'], null) ?? gone('tokens.colors.primary', 'no buttons, links or fills with a distinguishable brand colour were observed; not defaulting to any palette');
  }
  const UA_LINKS = ['#0000ee', '#551a8b'];
  if (colors.primary.value && colors.primary.basis === 'interactive' && UA_LINKS.includes(colors.primary.value.hex)) {
    colors.primary.notes = [...(colors.primary.notes ?? []), `${colors.primary.value.hex} is the browser's default link colour: the page may be unstyled, or may simply not restyle links`];
    colors.primary.confidence = Math.min(colors.primary.confidence, 0.3);
    colors.primary.level = levelOf(colors.primary.confidence);
  }
  colors.accent = C.accent
    ? color('tokens.colors.accent', ['accent', 'secondary'], { rgb: C.accent.rgb, share: C.accent.w / (C.chromatic.reduce((s, c) => s + c.w, 0) || 1), n: C.accent.n }, { evidenceDetail: `second distinct chromatic colour (${C.accent.n} elements)` })
    : color('tokens.colors.accent', ['accent', 'secondary'], null) ?? gone('tokens.colors.accent', 'only one chromatic colour was observed, so no secondary accent is claimed');
  colors.surface = C.surfaces[0]
    ? color('tokens.colors.surface', ['surface'], { rgb: C.surfaces[0].rgb, share: C.surfaces[0].share, n: C.surfaces[0].n }, { evidenceDetail: `most common card/panel fill differing from the page background (${C.surfaces[0].n} elements)` })
    : color('tokens.colors.surface', ['surface'], null) ?? gone('tokens.colors.surface', 'no card or panel with a fill distinct from the page background was observed');
  colors.border = C.border[0]
    ? color('tokens.colors.border', ['border'], { rgb: C.border[0].rgb, share: C.border[0].share, n: C.border[0].n }, { evidenceDetail: `most common border colour (${C.border[0].n} elements)` })
    : color('tokens.colors.border', ['border'], null) ?? gone('tokens.colors.border', 'no visible borders were observed');
  for (const role of ['danger', 'success', 'warning']) {
    colors[role] = color(`tokens.colors.${role}`, [role], null) ?? gone(`tokens.colors.${role}`, 'semantic colours are only recorded when the site declares them; none was found');
  }
  colors.palette = token(
    C.palette.map((p) => ({ hex: p.hex, share: round(p.share, 3) })),
    { confidence: C.palette.length ? 0.7 : 0.05, sources: [rendered(`weighted histogram of background, text and fill colours across ${facts.pages.reduce((s, p) => s + p.elements, 0)} sampled elements`)], notes: ['descriptive histogram; roles above are the interpreted values'] },
  );

  // theme-color meta: corroboration only, never a replacement.
  const theme = facts.assets.themeColor?.rgba;
  if (theme && theme[3] > 0.5 && colors.primary.value) {
    const d = deltaEOK(rgb3(theme), parse(colors.primary.value.hex));
    if (d <= SAME_COLOR) {
      colors.primary.sources.push(ev.add('markup', where, `<meta name="theme-color" content="${facts.assets.themeColor.raw}">`));
      colors.primary.confidence = round(Math.min(1, colors.primary.confidence + 0.05));
      colors.primary.level = levelOf(colors.primary.confidence);
    }
  }

  // ── typography
  const T = facts.typography;
  const fontClaims = claims.filter((c) => c.kind === 'font');
  const typography = {};
  for (const role of ['heading', 'body', 'ui', 'mono']) {
    const f = T.families[role];
    if (!f) {
      typography[role] = role === 'ui' ? gone('tokens.typography.ui', 'no buttons observed') : gone(`tokens.typography.${role}`, role === 'mono' ? 'no code or preformatted text on the inspected pages' : `no ${role} text was sampled`);
      continue;
    }
    const sources = [rendered(`computed font-family on ${f.n} ${role} element(s): ${f.stack}`)];
    const notes = [];
    const name = f.display ?? f.first; // human family: next/font aliases like __Inter_5e0a8e become "Inter"
    let nConflicts = 0;
    let corroboratedBy = 0;
    if (!f.first) notes.push('only generic families (sans-serif, system-ui, …) are specified');
    if (f.generated) notes.push(`next/font alias "${f.first}" normalised to "${name}"`);
    if (f.origin === 'webfont') notes.push('web font, loaded on the page');
    if (f.origin === 'webfont-declared-not-loaded') notes.push(f.generated ? 'next/font web font; its file was not loaded in this render' : 'declared via @font-face but not loaded in this render');
    if (f.origin === 'system-or-unlisted') notes.push(facts.unreadableSheets ? 'not found among readable @font-face rules; some stylesheets were cross-origin, so it may still be a web font' : 'no @font-face found: treated as an installed/system font');
    if (f.rendered && name && f.rendered.toLowerCase() !== name.toLowerCase()) {
      if (f.origin === 'system-or-unlisted') {
        notes.push(`${name} is not installed on the inspecting machine, so ${f.rendered} was painted instead; the profile records what the site asks for`);
      } else {
        notes.push(`the stack starts with ${name} but Chromium painted ${f.rendered}: the web font may have failed to load`);
        conflicts.push({ path: `tokens.typography.${role}`, summary: `web font "${name}" was requested but "${f.rendered}" was rendered`, observed: { value: f.rendered, evidence: sources[0] }, claimed: { value: name, evidence: sources[0], via: 'computed font-family' }, deltaE: null, resolution: 'observed-kept', severity: 'info' });
      }
    }
    const wantRole = role === 'ui' ? 'body' : role;
    // role 'any' claims (@fontsource, next/font without a role hint) can only corroborate, never contradict.
    const mine = fontClaims.filter((c) => c.role === wantRole || c.role === 'any');
    const seen = [name, f.first, f.rendered].filter(Boolean).map((x) => x.toLowerCase());
    for (const c of mine) {
      const matches = seen.includes(c.family.toLowerCase());
      if (c.role === 'any' && !matches) continue;
      const cid = ev.add('repo-file', c.line ? `${c.file}:${c.line}` : c.file, c.text);
      if (role === 'ui' && !matches) continue; // ui buttons often differ from body claims; not a conflict
      if (matches) {
        sources.push(cid);
        corroboratedBy = 1;
      } else {
        nConflicts++;
        conflicts.push({ path: `tokens.typography.${role}`, summary: `${c.via} names "${c.family}", but the rendered ${role} text asks for "${name ?? f.rendered ?? f.stack}"`, observed: { value: name ?? f.rendered, evidence: sources[0] }, claimed: { value: c.family, evidence: cid, via: c.via }, deltaE: null, resolution: 'observed-kept' });
      }
    }
    typography[role] = token({ family: name ?? f.rendered, rendered: f.rendered, declaredStack: f.stack, origin: f.origin, ...(f.generated ? { cssFamily: f.first, generated: true } : {}) }, { confidence: scoreConfidence({ share: f.share, n: f.n, corroboratedBy, conflicts: nConflicts, cap: f.first || f.rendered ? 1 : 0.4 }), sources, notes });
  }
  typography.base = T.base
    ? token(T.base, { confidence: scoreConfidence({ share: 1, n: T.base.n }), sources: [rendered(`most common body-text size/weight over ${T.base.n} elements`)] })
    : gone('tokens.typography.base', 'no body text was sampled');
  typography.headings = Object.keys(T.headings).length
    ? token(T.headings, { confidence: scoreConfidence({ share: 1, n: Math.min(...Object.values(T.headings).map((h) => h.n)) * 3 }), sources: [rendered('median computed style of h1–h4 on the inspected pages')] })
    : gone('tokens.typography.headings', 'no h1–h4 elements were found');
  typography.scale = T.scaleRatio
    ? token({ ratio: T.scaleRatio, levels: T.scaleLevels, sizes: T.sizes }, { confidence: T.scaleLevels >= 3 ? 0.6 : 0.4, sources: [rendered('median ratio between consecutive heading sizes')], notes: ['ratio is descriptive; sites rarely follow a strict modular scale'] })
    : gone('tokens.typography.scale', `need at least 3 distinct heading levels to estimate a type-scale ratio (found ${T.scaleLevels})`);
  typography.weights = T.weights.length ? token(T.weights, { confidence: 0.7, sources: [rendered('font-weight histogram over text elements')] }) : gone('tokens.typography.weights', 'no text sampled');
  typography.buttonCase = T.buttonCase ? token(T.buttonCase, { confidence: 0.6, sources: [rendered('text-transform of buttons')] }) : gone('tokens.typography.buttonCase', 'no buttons observed');

  // ── spacing, shape, surfaces
  const S = facts.spacing;
  const spacing = {
    unit: S.unit
      ? token(S.unit, { confidence: round(clamp(0.4 + 0.5 * (S.coverage ?? 0), 0, 0.9)), sources: [rendered(`${Math.round(S.coverage * 100)}% of ${S.n} padding/margin/gap values are multiples of ${S.unit}px`)] })
      : gone('tokens.spacing.unit', S.n < 10 ? `only ${S.n} spacing values sampled` : 'no 2/4/8px base unit covers 80% of the observed spacing values; spacing looks ad hoc'),
    scale: S.scale.length ? token(S.scale, { confidence: S.n >= 10 ? 0.7 : 0.3, sources: [rendered(`most frequent spacing values over ${S.n} samples`)] }) : gone('tokens.spacing.scale', 'too few spacing values sampled'),
  };
  const H = facts.shape;
  const radius = (k, label) =>
    H.radius[k]
      ? token(H.radius[k].value, { confidence: scoreConfidence({ share: H.radius[k].share, n: H.radius[k].n }), sources: [rendered(`most common border-radius of ${H.radius[k].n} ${label}(s) (${Math.round(H.radius[k].share * 100)}% agree)`)] })
      : gone(`tokens.shape.radius${k[0].toUpperCase()}${k.slice(1)}`, `fewer than 2 ${label}s observed`);
  const shape = { radiusButton: radius('button', 'button'), radiusCard: radius('card', 'card'), radiusInput: radius('input', 'input'), borderWidth: H.borderWidth ? token(H.borderWidth, { confidence: 0.6, sources: [rendered('most common non-zero border width')] }) : gone('tokens.shape.borderWidth', 'no borders observed') };
  const surfaces = {
    style: H.surfaceStyle
      ? token(H.surfaceStyle, { confidence: scoreConfidence({ share: Math.max(H.surfaceStyle.shadowShare, H.surfaceStyle.borderShare, H.surfaceStyle.fillShare), n: H.surfaceStyle.n }), sources: [rendered(`${H.surfaceStyle.n} card-like surfaces classified by shadow/border/fill`)] })
      : gone('tokens.surfaces.style', 'fewer than 3 card-like surfaces observed'),
    shadows: H.shadows.length ? token(H.shadows, { confidence: 0.7, sources: [rendered('box-shadow values on cards and other elements')] }) : gone('tokens.surfaces.shadows', 'no box-shadows observed (the site looks flat)'),
  };

  // ── layout, responsive, schemes
  const L = facts.layout;
  const layout = {
    maxContentWidth: L.maxContentWidth ? token(L.maxContentWidth.width, { confidence: scoreConfidence({ share: 0.6, n: L.maxContentWidth.n }), sources: [rendered(`computed max-width on ${L.maxContentWidth.n} container(s)`)] }) : gone('tokens.layout.maxContentWidth', 'no container with a max-width ≥ 480px was found'),
    headerSticky: L.headerSticky === null ? gone('tokens.layout.headerSticky', 'no <header>/<nav> found') : token(L.headerSticky, { confidence: 0.8, sources: [rendered('computed position of the first header/nav')] }),
    gridColumns: L.gridColumns ? token(L.gridColumns, { confidence: 0.6, sources: [rendered('widest CSS grid (resolved columns) at 1440px')] }) : gone('tokens.layout.gridColumns', 'no wide CSS grid found (layout may use flexbox or floats)'),
  };
  const R = facts.responsive;
  const responsive = {
    viewports: R.viewports.length >= 2 ? token(R.viewports, { confidence: round(0.3 + 0.2 * R.viewports.length), sources: [rendered(`inspected at ${R.viewports.map((v) => `${v.name} ${v.viewport[0]}px`).join(', ')}`)] }) : gone('tokens.responsive.viewports', 'fewer than two viewports could be inspected'),
    behaviors: R.viewports.length >= 2 ? token(R.notes, { confidence: 0.6, sources: [rendered('comparison of desktop, tablet and mobile renders')], notes: R.notes.length ? [] : ['no notable differences detected; this does not prove the layout is not responsive'] }) : gone('tokens.responsive.behaviors', 'fewer than two viewports could be inspected'),
  };
  let schemeLimitation = null;
  // Dark scheme. `responds` keeps its original meaning (prefers-color-scheme changes the page). A theme
  // switched by a class/attribute (html.dark, [data-theme=dark], Tailwind `dark:`) or by a toggle control
  // cannot be seen through prefers-color-scheme emulation, so "no dark theme" is then *unverified*, not a fact.
  const sc = facts.scheme;
  let prefersDark;
  if (sc.responds === null) prefersDark = gone('tokens.schemes.prefersDark', 'the dark-scheme probe did not run');
  else if (sc.responds) {
    prefersDark = token({ responds: true, status: 'verified', background: toHex(sc.dark.background), text: toHex(sc.dark.text) }, { confidence: 0.7, sources: [rendered('page background re-measured under prefers-color-scheme: dark')] });
  } else {
    const classToggle = sc.classRules > 0 || sc.toggleControl;
    const opaque = !classToggle && sc.unreadableOpaque > 0;
    const unverified = classToggle || opaque;
    const detail = classToggle
      ? [sc.classRules > 0 && `${sc.classRules} CSS rule(s) target a dark class/attribute`, sc.toggleControl && 'a theme-toggle control exists'].filter(Boolean).join(' and ')
      : opaque
        ? `${sc.unreadableOpaque} cross-origin stylesheet(s) could not be read, so dark rules in them would be invisible`
        : null;
    prefersDark = token(
      { responds: false, status: unverified ? 'unverified' : 'verified', toggle: classToggle ? 'class-or-attribute' : opaque ? 'unknown' : 'none-detected', ...(sc.classRules ? { darkRules: sc.classRules } : {}), ...(sc.toggleControl ? { themeToggleControl: true } : {}) },
      {
        confidence: unverified ? 0.35 : 0.7,
        sources: [rendered(unverified ? `prefers-color-scheme: dark did not change the page; ${detail}` : 'page background re-measured under prefers-color-scheme: dark')],
        notes: unverified
          ? [`dark theme unverified: ${detail}. It is switched by something this inspection does not exercise, so dark colours are not recorded and "no dark theme" must not be assumed`]
          : ['the page ignores prefers-color-scheme and no class-based dark rules or theme toggle were found'],
      },
    );
    if (unverified) schemeLimitation = `Dark theme unverified: ${detail}. Not exercised, so no dark colours are recorded.`;
  }
  const schemes = { prefersDark };

  // ── assets
  const A = facts.assets;
  const assets = {};
  const bestLogo = [...A.logos].sort((a, b) => logoScore(b) - logoScore(a))[0];
  if (bestLogo && logoScore(bestLogo) >= 2) {
    const sc = logoScore(bestLogo);
    const fetched = A.fetched?.logo;
    const saved = bestLogo.svg ? A.inlineLogoSaved : fetched && !fetched.error ? fetched : null;
    assets.logo = token(
      { kind: bestLogo.kind, src: bestLogo.src, alt: bestLogo.alt, width: bestLogo.width, height: bestLogo.height, savedAs: saved?.savedAs ?? null, sha256: saved?.sha256 ?? null, fills: [...new Set((bestLogo.fills ?? []).map((f) => toHex(rgb3(f))))].sort() },
      { confidence: sc >= 6 ? 0.85 : sc >= 5 ? 0.75 : sc >= 3 ? 0.55 : 0.35, sources: [rendered(`logo candidate: ${bestLogo.kind}${bestLogo.homeLink ? ' linking home' : ''}${bestLogo.inHeader ? ' in the header' : ''}${bestLogo.named ? ', named logo/brand' : ''}`)], notes: fetched?.error ? [`download failed: ${fetched.error}`] : [] },
    );
  } else assets.logo = gone('assets.logo', A.logos.length ? 'image/SVG candidates near the top of the page did not look like a logo (not in the header, not linked home, not named logo/brand)' : 'no <img> or inline <svg> found in the header or in a logo/brand container');
  const icon = [...A.icons].filter((i) => i.href).sort((a, b) => iconRank(b) - iconRank(a))[0];
  if (icon) {
    const f = A.fetched?.favicon;
    assets.favicon = token({ href: icon.href, rel: icon.rel, sizes: icon.sizes, type: icon.type, savedAs: f && !f.error ? f.savedAs : null, sha256: f && !f.error ? f.sha256 : null }, { confidence: f?.error ? 0.5 : 0.85, sources: [ev.add('markup', where, `<link rel="${icon.rel}" href="${icon.href}">`)], notes: f?.error ? [`download failed: ${f.error}`] : [] });
  } else assets.favicon = gone('assets.favicon', 'no <link rel="icon"> declared (browsers may fall back to /favicon.ico, which was not probed)');
  if (A.ogImage) {
    const f = A.fetched?.['og-image'];
    assets.ogImage = token({ href: A.ogImage, savedAs: f && !f.error ? f.savedAs : null, sha256: f && !f.error ? f.sha256 : null }, { confidence: f?.error ? 0.5 : 0.8, sources: [ev.add('markup', where, `og:image ${A.ogImage}`)], notes: f?.error ? [`download failed: ${f.error}`] : ['declared share image; may not match the on-page look'] });
  } else assets.ogImage = gone('assets.ogImage', 'no og:image / twitter:image meta tag');
  assets.themeColor = A.themeColor?.rgba && A.themeColor.rgba[3] > 0.5 ? token(colorValue(rgb3(A.themeColor.rgba)), { confidence: 0.6, sources: [ev.add('markup', where, `<meta name="theme-color" content="${A.themeColor.raw}">`)], notes: ['declared by the site; browsers use it for UI chrome, so it is not necessarily the brand colour'] }) : gone('assets.themeColor', 'no <meta name="theme-color">');

  // ── guards: observed values that coincide with Reelkit's default palette
  const matches = [];
  for (const k of ['primary', 'accent', 'background', 'surface']) {
    const t = colors[k];
    if (!t.value) continue;
    for (const d of REELKIT_DEFAULT_PALETTE) {
      if (deltaEOK(parse(t.value.hex), parse(d.hex)) <= SAME_COLOR) {
        const observed = t.sources.some((id) => ev.items.find((e) => e.id === id)?.kind === 'rendered');
        matches.push({ path: `tokens.colors.${k}`, hex: t.value.hex, reelkitDefault: d.hex, defaultSource: d.source, observedOnSite: observed, note: observed ? "Measured on the target site itself; it merely coincides with Reelkit's default palette, so a project built with these colours cannot reveal brand mismatches." : "Not observed rendering: this must not be trusted as the site's brand just because it equals Reelkit's default." });
      }
    }
  }

  const warnings = [];
  const failedCss = facts.failedResources.filter((f) => f.type === 'stylesheet');
  const failedFonts = facts.failedResources.filter((f) => f.type === 'font');
  if (failedCss.length) {
    warnings.push(`${failedCss.length} stylesheet(s) failed to load (${failedCss.slice(0, 3).map((f) => `${f.url} ${f.reason}`).join('; ')}). The page was only partly styled, so every observed value is capped at 40% confidence. Fix reachability (or run from a network that can load the site's CSS) and re-run.`);
    const capTo = (node) => {
      if (node && typeof node === 'object' && 'confidence' in node && 'sources' in node) {
        if (node.value !== null && node.confidence > 0.4) {
          node.confidence = 0.4;
          node.level = levelOf(0.4);
          node.notes = [...(node.notes ?? []), 'capped: stylesheets failed to load during inspection'];
        }
      } else if (node && typeof node === 'object') Object.values(node).forEach(capTo);
    };
    capTo({ colors, typography, spacing, shape, surfaces, layout });
  }
  if (failedFonts.length) warnings.push(`${failedFonts.length} web font file(s) failed to load (${failedFonts.slice(0, 3).map((f) => `${f.url} ${f.reason}`).join('; ')}); typography may show fallbacks.`);

  const core = [colors.background, colors.text, colors.primary, typography.heading, typography.body];
  const overall = round(core.reduce((s, t) => s + t.confidence, 0) / core.length);
  const limitations = [
    'Only anonymous, publicly reachable pages are inspected; pages behind login are not.',
    `At most ${1500} elements per page are sampled, evenly across the document; counts are therefore approximate.`,
    'Hover, focus and active states, animations and modals are not observed; resting styles only.',
    'Design-doc extraction is heuristic (line-based); a missed claim means "not found", not "not claimed".',
    'Roles (primary, accent, surface) are inferred from usage; the site may name them differently.',
  ];
  if (facts.unreadableSheets) limitations.push(`${facts.unreadableSheets} cross-origin stylesheet(s) could not be read, so their CSS variables and @font-face rules are not listed.`);
  if (facts.pages.length === 1) limitations.push('A single page was inspected; other pages may use different treatments.');
  if (schemeLimitation) limitations.push(schemeLimitation);
  for (const k of facts.skipped) limitations.push(`Skipped ${k.url}: ${k.kind === 'auth-required' ? 'it requires login' : 'not usable'} (${k.reason}). reelkit design profiles public pages only; its login screen is not the site's design.`);
  if (facts.errors.length) limitations.push(...facts.errors.map((e) => `Inspection error: ${e}`));

  return {
    schemaVersion: SCHEMA_VERSION,
    // No timestamp here: the canonical profile is byte-stable across runs. Run metadata is written
    // separately (design-profile.run.json, see index.mjs).
    generator: { name: 'reelkit', version: VERSION, command },
    site: { url, pages: facts.pages, title: facts.site.title || null, name: facts.site.name || null, lang: facts.site.lang || null, description: facts.site.description || null, viewports: facts.responsive.viewports.map((v) => ({ name: v.name, width: v.viewport[0], height: v.viewport[1] })), ...(designSystems.length ? { designSystems: designSystems.map((d) => ({ name: d.name, ...d.details, evidence: ev.add('repo-file', d.file, `${d.name} configuration`) })) } : {}), ...(facts.skipped.length ? { skipped: facts.skipped } : {}) },
    summary: { overallConfidence: overall, level: levelOf(overall), warnings, coreTokens: ['colors.background', 'colors.text', 'colors.primary', 'typography.heading', 'typography.body'], conflicts: conflicts.length, missing: missing.length, repoFilesRead: repoFiles.length },
    tokens: { colors, typography, spacing, shape, surfaces, layout, responsive, schemes },
    assets,
    evidence: ev.items,
    conflicts,
    missing,
    guards: { reelkitDefaults: { checked: REELKIT_DEFAULT_PALETTE.map((d) => d.hex), matches }, fallbacksUsed: false, note: 'No value in this profile was taken from reelkit.config.yaml or from Reelkit defaults.' },
    limitations,
  };
}

/* ───────────── validation ───────────── */

let compiled;
function validator() {
  compiled ??= new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')));
  return compiled;
}

/**
 * Schema validation plus the cross-reference rules a JSON Schema cannot express. Returns a list of
 * human-readable problems (empty = valid).
 */
export function validateProfile(profile) {
  const validate = validator();
  const problems = [];
  if (!validate(profile)) {
    for (const e of validate.errors.filter((x) => x.keyword !== 'if')) problems.push(`${e.instancePath || '(root)'}: ${e.message}${e.params?.additionalProperty ? ` "${e.params.additionalProperty}"` : ''}`);
    return [...new Set(problems)];
  }
  const ids = new Set(profile.evidence.map((e) => e.id));
  const missingPaths = new Set(profile.missing.map((m) => m.path));
  const visit = (node, trail) => {
    if (node && typeof node === 'object' && 'confidence' in node && 'level' in node && 'sources' in node) {
      for (const s of node.sources) if (!ids.has(s)) problems.push(`${trail}: source "${s}" is not in evidence`);
      if (node.level !== levelOf(node.confidence)) problems.push(`${trail}: level "${node.level}" does not match confidence ${node.confidence}`);
      if (node.value === null && !missingPaths.has(trail)) problems.push(`${trail}: null value is not listed in missing[]`);
      if (node.value !== null && node.confidence === 0) problems.push(`${trail}: a present value must have confidence > 0`);
      if (node.value !== null && node.sources.length === 0) problems.push(`${trail}: a present value must cite at least one evidence item`);
      return;
    }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) visit(v, trail ? `${trail}.${k}` : k);
  };
  visit(profile.tokens, 'tokens');
  visit(profile.assets, 'assets');
  for (const m of profile.missing) {
    const walkTo = m.path.split('.').reduce((n, k) => n?.[k], profile);
    if (!walkTo || walkTo.value !== null) problems.push(`missing[] path "${m.path}" does not point to a null token`);
  }
  for (const d of profile.site.designSystems ?? []) if (!ids.has(d.evidence)) problems.push(`site.designSystems: evidence "${d.evidence}" not found`);
  for (const c of profile.conflicts) {
    if (c.observed && !ids.has(c.observed.evidence)) problems.push(`conflict at ${c.path}: observed evidence "${c.observed.evidence}" not found`);
    if (!ids.has(c.claimed.evidence)) problems.push(`conflict at ${c.path}: claimed evidence "${c.claimed.evidence}" not found`);
  }
  return problems;
}
