// Evidence reconciliation: turns many weighted observations into one finding per design role,
// with confidence, provenance and explicit conflicts. Pure functions only (unit-tested).
import { deltaEOK, oklabToOklch, parseHex, rgbToOklab, toHex } from '../color.mjs';

/**
 * How much each kind of evidence counts. Rendered evidence (what the screenshots will actually show)
 * outranks declarations in source or docs, which may be stale.
 */
export const WEIGHTS = {
  'rendered-role': 3, // computed style of an element playing the role (button, body, link…)
  'rendered-var': 2.5, // computed value of a CSS custom property named for the role
  logo: 2, // colours inside the rendered logo
  meta: 1.5, // <meta name="theme-color">, web manifest
  pixel: 1, // share of the screenshot
  'source-css': 1, // custom property declared in project CSS
  'source-tokens': 1, // tailwind config / token files
  docs: 1, // DESIGN.md and friends
};

const RENDERED = new Set(['rendered-role', 'rendered-var', 'logo', 'meta', 'pixel']);
export const SAME_COLOR = 0.05; // ΔEok: below this, two hues count as the same colour (incl. hover shades)
export const SAME_NEUTRAL = 0.012; // neutrals (backgrounds, surfaces, text) differ by only 0.015-0.04
export const CHROMATIC = 0.04; // OKLCH chroma above which a colour counts as a hue, not a neutral

export function hexOf(rgb) {
  return toHex(rgb);
}

export function isChromatic(hexOrRgb) {
  const rgb = Array.isArray(hexOrRgb) ? hexOrRgb : parseHex(hexOrRgb);
  return oklabToOklch(rgbToOklab(rgb))[1] >= CHROMATIC;
}

export function oklchOf(hex) {
  const [L, C, h] = oklabToOklch(rgbToOklab(parseHex(hex)));
  return [round(L, 4), round(C, 4), round(h, 1)];
}

export const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function levelOf(confidence) {
  return confidence >= 0.75 ? 'high' : confidence >= 0.45 ? 'medium' : 'low';
}

const TYPE_ORDER = ['rendered-role', 'rendered-var', 'logo', 'meta', 'pixel', 'source-css', 'source-tokens', 'docs'];

/** Deterministic ordering for sources (strongest evidence first) so profiles are byte-stable. */
function sortSources(sources) {
  const key = (s) => `${String(TYPE_ORDER.indexOf(s.type)).padStart(2, '0')}|${s.detail}|${s.route ?? ''}|${s.theme ?? ''}`;
  return [...sources].sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Group colour candidates whose colours are within SAME_COLOR of each other.
 * Clusters are seeded by weight (heaviest first) so the result does not depend on input order.
 * Each candidate: { hex, type, detail, route?, theme?, weight? }.
 */
export function clusterColors(candidates, tolerance = SAME_COLOR) {
  const items = candidates
    .filter((c) => parseHex(c.hex))
    .map((c) => ({ ...c, hex: c.hex.toLowerCase(), w: c.weight ?? WEIGHTS[c.type] ?? 1 }))
    .sort((a, b) => b.w - a.w || a.hex.localeCompare(b.hex) || `${a.type}${a.detail}`.localeCompare(`${b.type}${b.detail}`));
  const clusters = [];
  for (const c of items) {
    const rgb = parseHex(c.hex);
    const home = clusters.find((k) => deltaEOK(parseHex(k.hex), rgb) <= tolerance);
    if (home) home.members.push(c);
    else clusters.push({ hex: c.hex, members: [c] });
  }
  for (const k of clusters) {
    k.weight = k.members.reduce((s, m) => s + m.w, 0);
    k.kinds = new Set(k.members.map((m) => m.type));
    // Representative colour: the exact value with the most rendered weight (else the most weight).
    const byHex = new Map();
    for (const m of k.members) {
      const e = byHex.get(m.hex) ?? { hex: m.hex, rendered: 0, all: 0 };
      e.all += m.w;
      if (RENDERED.has(m.type)) e.rendered += m.w;
      byHex.set(m.hex, e);
    }
    k.hex = [...byHex.values()].sort((a, b) => b.rendered - a.rendered || b.all - a.all || a.hex.localeCompare(b.hex))[0].hex;
  }
  return clusters.sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
}

/**
 * Confidence = how decisively the winner beats its nearest competitor (w1 / (w1 + w2)), discounted
 * when the winner rests on a single kind of evidence. Declared-only winners are capped at medium.
 * Using the runner-up rather than all evidence keeps multi-colour UIs from looking uncertain.
 */
export function confidenceFor(cluster, runnerUpWeight = 0) {
  const agreement = cluster.weight / (cluster.weight + runnerUpWeight);
  const kinds = cluster.kinds.size;
  const breadth = kinds >= 3 ? 1 : kinds === 2 ? 0.85 : 0.6;
  let c = agreement * breadth;
  const rendered = [...cluster.kinds].some((k) => RENDERED.has(k));
  if (!rendered) c = Math.min(c, 0.6);
  return round(c, 2);
}

/**
 * Pick the colour for one role. Returns a Finding:
 * { value, basis, confidence, level, sources, alternatives? } or { value: null, reason }.
 * `chromaticOnly` restricts candidates to real hues (for brand/primary roles).
 */
export function pickColor(role, candidates, { chromaticOnly = false, emptyReason, tolerance = SAME_COLOR } = {}) {
  const usable = candidates.filter((c) => parseHex(c.hex) && (!chromaticOnly || isChromatic(c.hex)));
  if (!usable.length) {
    return {
      value: null,
      basis: 'unknown',
      confidence: 0,
      level: 'low',
      reason: emptyReason ?? `no evidence for ${role}`,
      sources: [],
    };
  }
  const clusters = clusterColors(usable, tolerance);
  const [win, ...rest] = clusters;
  const rendered = [...win.kinds].some((k) => RENDERED.has(k));
  const finding = {
    value: win.hex,
    oklch: oklchOf(win.hex),
    basis: rendered ? 'observed' : 'declared',
    confidence: confidenceFor(win, rest[0]?.weight ?? 0),
    sources: sortSources(win.members.map(({ hex, type, detail, route, theme }) => ({ type, detail, hex, ...(route ? { route } : {}), ...(theme ? { theme } : {}) }))),
  };
  finding.level = levelOf(finding.confidence);
  if (rest.length) {
    finding.alternatives = rest.slice(0, 4).map((k) => ({ value: k.hex, weight: round(k.weight, 2), types: [...k.kinds].sort() }));
  }
  if (!rendered) finding.note = 'declared in source or docs only; not seen on the rendered site';
  return finding;
}

/**
 * Conflicts: a declared value (docs, source CSS, tokens) for a role that disagrees with what the
 * rendered site shows. The rendered value wins, but the disagreement is recorded, never hidden.
 */
export function findConflicts(role, finding, candidates) {
  if (!finding?.value || finding.basis !== 'observed') return [];
  const winner = parseHex(finding.value);
  const declared = candidates.filter((c) => ['docs', 'source-css', 'source-tokens'].includes(c.type) && parseHex(c.hex));
  const out = [];
  for (const d of declared) {
    const delta = deltaEOK(parseHex(d.hex), winner);
    if (delta > SAME_COLOR) {
      out.push({
        field: `palette.${role}`,
        observed: finding.value,
        declared: d.hex.toLowerCase(),
        declaredIn: d.detail,
        sourceType: d.type,
        deltaE: round(delta, 3),
        resolution: 'the rendered value is used; the declaration may be stale. Confirm with the site owner.',
      });
    }
  }
  return out.sort((a, b) => a.declaredIn.localeCompare(b.declaredIn) || a.declared.localeCompare(b.declared));
}

/** Pick the most-supported non-colour value (font family, radius bucket, …). */
export function pickValue(role, candidates, { emptyReason, breadthByRoutes = false } = {}) {
  const usable = candidates.filter((c) => c.value !== undefined && c.value !== null && c.value !== '');
  if (!usable.length) return { value: null, basis: 'unknown', confidence: 0, level: 'low', reason: emptyReason ?? `no evidence for ${role}`, sources: [] };
  const groups = new Map();
  for (const c of usable) {
    const key = typeof c.value === 'string' ? c.value.toLowerCase() : JSON.stringify(c.value);
    if (!groups.has(key)) groups.set(key, { value: c.value, members: [] });
    groups.get(key).members.push({ ...c, w: c.weight ?? WEIGHTS[c.type] ?? 1 });
  }
  const ranked = [...groups.values()]
    .map((g) => ({ ...g, weight: g.members.reduce((s, m) => s + m.w, 0), kinds: new Set(g.members.map((m) => m.type)) }))
    .sort((a, b) => b.weight - a.weight || String(a.value).localeCompare(String(b.value)));
  const win = ranked[0];
  const rendered = [...win.kinds].some((k) => RENDERED.has(k));
  let confidence = confidenceFor(win, ranked[1]?.weight ?? 0);
  if (breadthByRoutes) {
    // For values measured on every page (fonts), agreement across pages is the right breadth signal.
    const routes = new Set(win.members.map((m) => m.route).filter(Boolean)).size;
    const agreement = win.weight / (win.weight + (ranked[1]?.weight ?? 0));
    confidence = round(Math.min(rendered ? 1 : 0.6, agreement * (routes >= 3 ? 1 : routes === 2 ? 0.9 : 0.7)), 2);
  }
  const finding = {
    value: win.value,
    basis: rendered ? 'observed' : 'declared',
    confidence,
    level: levelOf(confidence),
    sources: sortSources(win.members.map(({ type, detail, route, theme }) => ({ type, detail, ...(route ? { route } : {}), ...(theme ? { theme } : {}) }))),
  };
  if (ranked.length > 1) finding.alternatives = ranked.slice(1, 4).map((g) => ({ value: g.value, weight: round(g.weight, 2), types: [...g.kinds].sort() }));
  return finding;
}

/** An inferred (heuristic) characteristic: always labelled as inference, never "observed". */
export function inferred(value, confidence, because) {
  return { value, basis: 'inferred', confidence: round(confidence, 2), level: levelOf(confidence), because };
}
