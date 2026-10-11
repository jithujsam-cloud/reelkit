// Phase 1: design profile. Two layers:
//   • synthetic observations → profile (no browser): schema, missing values, confidence, conflicts,
//     the default-palette guard;
//   • real Chromium against small fixture sites in tests/fixtures/design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHex, deltaEOK } from '../scripts/lib/color.mjs';
import { parseCssColor, findColorLiterals } from '../scripts/lib/design/css-color.mjs';
import { roleFromName, extractFromCss, extractFromMarkdown, extractFromTailwind, extractFromTokensJson } from '../scripts/lib/design/claims.mjs';
import { REELKIT_DEFAULT_PALETTE, levelOf, scoreConfidence, validateProfile } from '../scripts/lib/design/profile.mjs';
import { profileFromObservations } from '../scripts/lib/design/index.mjs';
import { renderMarkdown } from '../scripts/lib/design/render-md.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures', 'design');
const NOW = new Date('2026-01-15T09:30:00Z');

/* ───────────── synthetic observation helpers ───────────── */

const rgba = (hex, a = 1) => [...parseHex(hex), a];
const FONT = { family: 'Inter, sans-serif', size: 16, weight: 400, lineHeight: 24, letterSpacing: 0, transform: 'none' };
function el(role, over = {}) {
  return { tag: 'div', role, textLen: role === 'text' ? 40 : 0, color: null, bg: null, parentBg: rgba('#ffffff'), borderColor: null, borderWidth: 0, radius: 0, shadow: null, pad: [0, 0, 0, 0], gap: null, margin: [0, 0], font: { ...FONT }, rect: [0, 0, 200, 40], ...over };
}
const buttons = (hex, n, over = {}) => Array.from({ length: n }, () => el('button', { bg: rgba(hex), color: rgba('#ffffff'), textLen: 8, pad: [12, 24, 12, 24], radius: 8, rect: [0, 0, 120, 44], ...over }));
const bodyText = (hex = '#111111', n = 6) => Array.from({ length: n }, () => el('text', { color: rgba(hex) }));
const VIT = { viewport: [1440, 900], overflowX: false, bodyFontSize: 16, h1: null, gridMaxCols: 0, headerPosition: null, navLinksVisible: null, menuButtonVisible: null, contentWidthPx: 1000 };
function observation(elements, main = {}, extra = {}) {
  return {
    url: 'http://t.test/',
    finalUrl: 'http://t.test/',
    errors: [],
    main: {
      url: 'http://t.test/', title: 'Test site', lang: 'en', description: null, siteName: null, themeColor: null, colorSchemeMeta: null, rootColorScheme: 'normal',
      pageBg: { rgba: rgba('#ffffff'), defaulted: false }, bodyText: rgba('#111111'),
      elements, elementsTotal: elements.length, vars: [], fontFaces: [], documentFonts: [], unreadableSheets: 0,
      icons: [], ogImage: null, manifest: null, logos: [], layout: { maxWidths: {}, headerSticky: null }, vitals: { ...VIT },
      ...main,
    },
    responsive: { desktop: { ...VIT }, mobile: { ...VIT, viewport: [390, 844] } },
    ...extra,
  };
}
const build = (elements, { main, claims = [], extra } = {}) => profileFromObservations([observation(elements, main, extra)], { url: 'http://t.test/', claims, now: NOW });
const cssVar = (name, hex) => ({ name, scope: 'root', raw: hex, rgba: rgba(hex) });
const docClaim = (role, hex, file = 'DESIGN.md', line = 3) => ({ kind: 'color', role, hex, alpha: 1, file, line, text: `${role}: ${hex}`, via: 'design doc' });

/* ───────────── parsing and naming ───────────── */

test('css colour parsing: hex, rgb, hsl, oklch, bare shadcn channels; rejects var() and junk', () => {
  assert.deepEqual(parseCssColor('#2563eb'), [37, 99, 235, 1]);
  assert.deepEqual(parseCssColor('rgb(37 99 235 / 50%)'), [37, 99, 235, 0.5]);
  assert.deepEqual(parseCssColor('221.2 83.2% 53.3%').slice(0, 3), [37, 99, 235]);
  const ok = parseCssColor('oklch(0.62 0.19 259)');
  assert.ok(deltaEOK(ok, [53, 129, 246]) < 0.01);
  assert.equal(parseCssColor('var(--x)'), null);
  assert.equal(parseCssColor('not-a-colour'), null);
  assert.equal(findColorLiterals('a #fff and rgb(0,0,0) and nothing').length, 2);
});

test('roleFromName maps design-token names to roles and skips "on-colour" tokens', () => {
  const cases = { '--primary': 'primary', '--brand-accent': 'accent', '--primary-foreground': null, '--muted-foreground': 'textMuted', '--background': 'background', '--card': 'surface', '--color-danger': 'danger', 'Brand color': 'primary', '--radius': null };
  for (const [name, role] of Object.entries(cases)) assert.equal(roleFromName(name), role, name);
});

test('claim extractors keep file and line; tailwind, tokens and markdown are understood', () => {
  const css = extractFromCss(':root {\n  --primary: 221.2 83.2% 53.3%;\n  --font-sans: "Inter", system-ui;\n}', 'globals.css');
  assert.deepEqual(css.map((c) => [c.kind, c.role, c.hex ?? c.family, c.line]), [['color', 'primary', '#2563eb', 2], ['font', 'body', 'Inter', 3]]);
  const md = extractFromMarkdown('| Primary | `#2563eb` |\nHeading font: Fraunces', 'DESIGN.md');
  assert.deepEqual(md.map((c) => c.hex ?? c.family), ['#2563eb', 'Fraunces']);
  assert.equal(extractFromTailwind("colors: {\n primary: '#112233',\n}\nfontFamily: { sans: ['Inter', 'sans-serif'] }", 'tailwind.config.js').length, 2);
  assert.equal(extractFromTokensJson(JSON.stringify({ color: { brand: { primary: { $value: '#112233', $type: 'color' } } } }), 'tokens.json')[0].role, 'primary');
  assert.deepEqual(extractFromTokensJson('{not json', 'x.json'), []);
});

/* ───────────── confidence ───────────── */

test('confidence: thin support is capped, agreement raises, conflicts lower; levels have fixed thresholds', () => {
  assert.equal(scoreConfidence({ share: 1, n: 10 }), 0.85);
  assert.ok(scoreConfidence({ share: 1, n: 2 }) <= 0.55, 'fewer than 3 supporting elements caps at 0.55');
  assert.ok(scoreConfidence({ share: 1, n: 10, corroboratedBy: 1 }) > scoreConfidence({ share: 1, n: 10 }));
  assert.equal(scoreConfidence({ share: 1, n: 10, corroboratedBy: 5 }), 1, 'corroboration adds at most 0.15');
  assert.ok(scoreConfidence({ share: 1, n: 10, conflicts: 1 }) < scoreConfidence({ share: 1, n: 10 }));
  assert.equal(scoreConfidence({ share: 1, n: 10, cap: 0.35 }), 0.35);
  assert.deepEqual([0, 0.2, 0.5, 0.74, 0.75].map(levelOf), ['none', 'low', 'medium', 'medium', 'high']);
});

test('a colour used by few elements is reported with low/medium confidence, a dominant one with high', () => {
  const dominant = build([...bodyText(), ...buttons('#0b6bcb', 8)]);
  const thin = build([...bodyText(), ...buttons('#0b6bcb', 2)]);
  assert.equal(dominant.tokens.colors.primary.value.hex, '#0b6bcb');
  assert.ok(dominant.tokens.colors.primary.confidence > thin.tokens.colors.primary.confidence);
  assert.ok(thin.tokens.colors.primary.confidence <= 0.55);
  assert.equal(thin.tokens.colors.primary.level, 'medium');
});

test('an agreeing CSS variable and design doc raise confidence and are cited as evidence', () => {
  const els = [...bodyText(), ...buttons('#0b6bcb', 6)];
  const alone = build(els);
  const backed = build(els, { main: { vars: [cssVar('--primary', '#0b6bcb')] }, claims: [docClaim('primary', '#0b6bcb')] });
  const p = backed.tokens.colors.primary;
  assert.ok(p.confidence > alone.tokens.colors.primary.confidence);
  assert.ok(p.sources.length >= 3, 'rendered + css-variable + repo-file');
  assert.deepEqual([...new Set(p.sources.map((id) => backed.evidence.find((e) => e.id === id).kind))].sort(), ['css-variable', 'rendered', 'repo-file']);
  assert.equal(backed.conflicts.length, 0);
});

test('a page with no opaque background is flagged: assumed white is not a design decision', () => {
  const p = build(bodyText(), { main: { pageBg: { rgba: rgba('#ffffff'), defaulted: true } } });
  assert.ok(p.tokens.colors.background.confidence <= 0.5);
  assert.match(p.tokens.colors.background.notes.join(' '), /browser default/);
});

/* ───────────── conflicting evidence ───────────── */

test('a stale doc and a misleading CSS variable lose to the rendered site, and both are recorded', () => {
  const p = build([...bodyText(), ...buttons('#1f7a4d', 6)], {
    main: { vars: [cssVar('--primary', '#3b82f6')] },
    claims: [docClaim('primary', '#ef4444', 'docs/DESIGN.md', 7)],
  });
  const prim = p.tokens.colors.primary;
  assert.equal(prim.value.hex, '#1f7a4d', 'observed value kept');
  assert.equal(p.conflicts.filter((c) => c.path === 'tokens.colors.primary').length, 2);
  const byVia = Object.fromEntries(p.conflicts.map((c) => [c.claimed.via, c]));
  assert.equal(byVia['css-variable --primary'].claimed.value, '#3b82f6');
  assert.equal(byVia['design doc'].claimed.value, '#ef4444');
  for (const c of p.conflicts) {
    assert.equal(c.resolution, 'observed-kept');
    assert.ok(c.deltaE > 0.1);
    assert.equal(p.evidence.find((e) => e.id === c.claimed.evidence).where.includes('DESIGN.md') || c.claimed.via.startsWith('css-variable'), true);
  }
  const clean = build([...bodyText(), ...buttons('#1f7a4d', 6)]);
  assert.ok(prim.confidence < clean.tokens.colors.primary.confidence, 'conflicts lower confidence');
});

test('a font named in the docs but not rendered is a conflict; one that matches is corroboration', () => {
  const els = [...bodyText(), el('heading', { level: 1, font: { ...FONT, family: '"Fraunces", serif', size: 40 } }), el('heading', { level: 1, font: { ...FONT, family: '"Fraunces", serif', size: 40 } })];
  const doc = (family) => [{ kind: 'font', role: 'heading', family, file: 'DESIGN.md', line: 2, text: `Heading font: ${family}`, via: 'design doc' }];
  const bad = build(els, { claims: doc('Playfair Display') });
  const good = build(els, { claims: doc('Fraunces') });
  assert.equal(bad.tokens.typography.heading.value.family, 'Fraunces');
  assert.equal(bad.conflicts.filter((c) => c.path === 'tokens.typography.heading').length, 1);
  assert.equal(good.conflicts.length, 0);
  assert.ok(good.tokens.typography.heading.confidence > bad.tokens.typography.heading.confidence);
});

test('a web font that was requested but not painted is reported as an info conflict, a missing system font is not', () => {
  const heading = (n) => Array.from({ length: n }, () => el('heading', { level: 1, font: { ...FONT, family: '"Brand Sans", sans-serif', size: 40 } }));
  const web = build([...bodyText(), ...heading(3)], { main: { documentFonts: [{ family: 'Brand Sans', weight: '400', style: 'normal', status: 'loaded' }] }, extra: { rendered: { heading: { family: 'DejaVu Sans' } } } });
  assert.equal(web.conflicts.find((c) => c.path === 'tokens.typography.heading')?.severity, 'info');
  const sys = build([...bodyText(), ...heading(3)], { extra: { rendered: { heading: { family: 'DejaVu Sans' } } } });
  assert.equal(sys.conflicts.length, 0);
  assert.match(sys.tokens.typography.heading.notes.join(' '), /not installed on the inspecting machine/);
});

test('declared-only colours are used with low confidence, labelled, and disagreement between them is recorded', () => {
  const p = build(bodyText(), { main: { vars: [cssVar('--primary', '#0a7f5a')] }, claims: [docClaim('primary', '#aa3377')] });
  const prim = p.tokens.colors.primary;
  assert.equal(prim.value.hex, '#0a7f5a', 'live CSS variable outranks a repo doc');
  assert.equal(prim.basis, 'declared-only');
  assert.ok(prim.confidence <= 0.35 && prim.level === 'low');
  assert.match(prim.notes.join(' '), /not observed/);
  assert.equal(p.conflicts.length, 1);
  assert.equal(p.conflicts[0].observed, null);
  assert.equal(p.conflicts[0].resolution, 'declared-used');
});

test('failed stylesheets cap every observed value at 40% and raise a visible warning', () => {
  const els = [...bodyText(), ...buttons('#0b6bcb', 8)];
  const ok = build(els);
  const broken = build(els, { extra: { failedResources: [{ url: 'http://t.test/brand.css', type: 'stylesheet', reason: 'HTTP 404' }] } });
  assert.ok(ok.tokens.colors.primary.confidence > 0.7);
  for (const k of ['background', 'text', 'primary']) assert.ok(broken.tokens.colors[k].confidence <= 0.4, k);
  assert.ok(broken.tokens.typography.body.confidence <= 0.4);
  assert.equal(broken.tokens.colors.primary.value.hex, '#0b6bcb', 'values are kept, only trust is lowered');
  assert.match(broken.summary.warnings[0], /stylesheet\(s\) failed to load.*brand\.css HTTP 404/);
  assert.match(renderMarkdown(broken), /\*\*Warning:\*\*/);
  assert.deepEqual(validateProfile(broken), []);
  const fontOnly = build(els, { extra: { failedResources: [{ url: 'http://t.test/a.woff2', type: 'font', reason: 'net::ERR_FAILED' }] } });
  assert.ok(fontOnly.tokens.colors.primary.confidence > 0.7, 'a missing font alone does not cap colours');
  assert.match(fontOnly.summary.warnings[0], /web font/);
});

test('the browser’s default link blue is flagged, not trusted as a brand colour', () => {
  const links = Array.from({ length: 6 }, () => el('link', { color: rgba('#0000ee'), textLen: 5 }));
  const p = build([...bodyText(), ...links]);
  assert.equal(p.tokens.colors.primary.value.hex, '#0000ee');
  assert.ok(p.tokens.colors.primary.confidence <= 0.3);
  assert.match(p.tokens.colors.primary.notes.join(' '), /default link colour/);
});

/* ───────────── missing values ───────────── */

test('unknown values are null with a reason, listed in missing[], and never invented', () => {
  const p = build([el('text', { color: rgba('#222222') })]);
  const t = p.tokens;
  const expectMissing = ['colors.primary', 'colors.accent', 'colors.surface', 'colors.border', 'colors.danger', 'typography.heading', 'typography.mono', 'spacing.unit', 'shape.radiusCard', 'surfaces.style', 'layout.maxContentWidth'];
  for (const k of expectMissing) {
    const tok = k.split('.').reduce((n, key) => n[key], t);
    assert.equal(tok.value, null, k);
    assert.equal(tok.confidence, 0, k);
    assert.equal(tok.level, 'none', k);
    assert.ok(tok.reason.length > 10, k);
    assert.ok(p.missing.some((m) => m.path === `tokens.${k}` && m.reason === tok.reason), `${k} listed in missing[]`);
  }
  for (const k of ['logo', 'favicon', 'ogImage', 'themeColor']) assert.equal(p.assets[k].value, null, k);
  assert.equal(p.summary.missing, p.missing.length);
  assert.deepEqual(validateProfile(p), []);
  assert.match(renderMarkdown(p), /## Not found[\s\S]*tokens\.colors\.primary/);
});

test('a monochrome site yields a neutral primary (labelled), not a missing or invented brand colour', () => {
  const p = build([...bodyText(), ...buttons('#111111', 4)]);
  assert.equal(p.tokens.colors.primary.value.hex, '#111111');
  assert.equal(p.tokens.colors.primary.basis, 'neutral-interactive');
  assert.match(p.tokens.colors.primary.notes.join(' '), /monochrome/);
  assert.equal(p.tokens.colors.accent.value, null);
});

test('with no usable colour evidence at all, primary is null: Reelkit’s purple is never a fallback', () => {
  const p = build(bodyText());
  assert.equal(p.tokens.colors.primary.value, null);
  assert.equal(p.guards.fallbacksUsed, false);
  assert.equal(p.guards.reelkitDefaults.matches.length, 0);
  const json = JSON.stringify({ tokens: p.tokens, assets: p.assets }).toLowerCase();
  for (const d of REELKIT_DEFAULT_PALETTE) assert.ok(!json.includes(d.hex), `${d.hex} must not appear in any token`);
});

/* ───────────── default-palette guard ───────────── */

test('the guard’s default palette stays in sync with the real config default, and design code never touches it', () => {
  const cfg = loadConfig(path.join(SKILL, 'reelkit.config.example.yaml'));
  assert.equal(REELKIT_DEFAULT_PALETTE[0].hex, cfg.frame.accent.toLowerCase());
  const dir = path.join(SKILL, 'scripts', 'lib', 'design');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/from '\.\.\/config\.mjs'/.test(src), `${f} must not import config.mjs`);
    if (f !== 'profile.mjs') assert.ok(!/7c5cff|22d3ee/i.test(src), `${f} must not mention the default palette`);
  }
});

test('a real site that genuinely renders #7c5cff is recorded as observed, with the coincidence flagged', () => {
  const p = build([...bodyText(), ...buttons('#7c5cff', 4)]);
  assert.equal(p.tokens.colors.primary.value.hex, '#7c5cff');
  const m = p.guards.reelkitDefaults.matches.find((x) => x.path === 'tokens.colors.primary');
  assert.equal(m.observedOnSite, true);
  assert.match(renderMarkdown(p), /matches Reelkit’s default palette/);
});

test('a purple that is only declared (never seen) is flagged as not observed', () => {
  const p = build(bodyText(), { main: { vars: [cssVar('--primary', '#7c5cff')] } });
  const m = p.guards.reelkitDefaults.matches.find((x) => x.path === 'tokens.colors.primary');
  assert.equal(m.observedOnSite, false);
  assert.equal(p.tokens.colors.primary.basis, 'declared-only');
});

/* ───────────── schema ───────────── */

test('schema accepts a complete profile and rejects structural damage', () => {
  const good = build([...bodyText(), ...buttons('#0b6bcb', 6)], { main: { vars: [cssVar('--primary', '#0b6bcb')] } });
  assert.deepEqual(validateProfile(good), []);
  const clone = () => JSON.parse(JSON.stringify(good));

  let p = clone();
  delete p.tokens.colors.primary.confidence;
  assert.ok(validateProfile(p).some((m) => /confidence/.test(m)), 'missing confidence');

  p = clone();
  p.tokens.colors.primary.confidence = 1.4;
  assert.ok(validateProfile(p).length, 'confidence out of range');

  p = clone();
  p.tokens.colors.textMuted = { value: null, confidence: 0, level: 'none', sources: [] };
  assert.ok(validateProfile(p).length, 'null value without a reason');

  p = clone();
  p.tokens.colors.primary.surprise = true;
  assert.ok(validateProfile(p).length, 'unknown token key');

  p = clone();
  delete p.evidence;
  assert.ok(validateProfile(p).some((m) => /evidence/.test(m)), 'missing evidence list');

  p = clone();
  p.schemaVersion = 2;
  assert.ok(validateProfile(p).length, 'unsupported schema version');

  p = clone();
  p.guards.fallbacksUsed = true;
  assert.ok(validateProfile(p).length, 'fallbacksUsed must be false');
});

test('cross-reference checks catch what JSON Schema cannot: dangling evidence, wrong level, unlisted nulls', () => {
  const good = build([...bodyText(), ...buttons('#0b6bcb', 6)]);
  const clone = () => JSON.parse(JSON.stringify(good));

  let p = clone();
  p.tokens.colors.primary.sources = ['e999'];
  assert.ok(validateProfile(p).some((m) => /e999/.test(m)));

  p = clone();
  p.tokens.colors.primary.level = 'low';
  assert.ok(validateProfile(p).some((m) => /does not match confidence/.test(m)));

  p = clone();
  p.missing = p.missing.filter((m) => m.path !== 'tokens.colors.accent');
  assert.ok(validateProfile(p).some((m) => /not listed in missing/.test(m)));

  p = clone();
  p.tokens.colors.primary.sources = [];
  assert.ok(validateProfile(p).some((m) => /at least one evidence/.test(m)));

  p = clone();
  p.missing.push({ path: 'tokens.colors.primary', reason: 'bogus' });
  assert.ok(validateProfile(p).some((m) => /does not point to a null token/.test(m)));
});

/* ───────────── real browser, fixture sites ───────────── */

const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml', '.css': 'text/css' };
function serve(dir) {
  const server = http.createServer((req, res) => {
    let p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!existsSync(p) || !p.startsWith(dir)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}

async function inspectFixture(name, browser, { docs = false } = {}) {
  const { inspectPage } = await import('../scripts/lib/design/inspect.mjs');
  const { collectClaims } = await import('../scripts/lib/design/claims.mjs');
  const site = await serve(path.join(FIXTURES, name));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rk-design-'));
  try {
    const obs = await inspectPage(browser, site.url, { assetsDir: path.join(tmp, 'assets') });
    const { claims, files } = docs ? collectClaims(path.join(FIXTURES, name)) : { claims: [], files: [] };
    const profile = profileFromObservations([obs], { url: site.url, claims, repoFiles: files, now: NOW });
    return { profile, assets: existsSync(path.join(tmp, 'assets')) ? readdirSync(path.join(tmp, 'assets')) : [] };
  } finally {
    site.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('fixture sites inspected in Chromium', async (t) => {
  const { launchBrowser } = await import('../scripts/lib/browser.mjs');
  const browser = await launchBrowser();
  t.after(() => browser.close());

  await t.test('fernhill: brand colours, fonts, spacing and responsive behaviour come from the page, not from Reelkit', async () => {
    const { profile: p, assets } = await inspectFixture('fernhill', browser, { docs: true });
    assert.deepEqual(validateProfile(p), []);
    const c = p.tokens.colors;
    assert.equal(c.primary.value.hex, '#1f7a4d');
    assert.equal(c.accent.value.hex, '#d9822b');
    assert.equal(c.background.value.hex, '#f7f4ec');
    assert.equal(c.surface.value.hex, '#ffffff');
    assert.ok(deltaEOK(parseHex(c.primary.value.hex), parseHex('#7c5cff')) > 0.2, 'not the Reelkit purple');
    assert.equal(p.guards.reelkitDefaults.matches.length, 0);
    assert.ok(c.primary.confidence >= 0.6, `primary confidence ${c.primary.confidence}`);
    // fonts: what the CSS asks for (the box running the test may not have Georgia installed)
    assert.equal(p.tokens.typography.heading.value.family, 'Georgia');
    assert.equal(p.tokens.typography.body.value.family, 'Helvetica');
    assert.equal(p.tokens.typography.base.value.size, 16);
    assert.equal(p.tokens.typography.headings.value.h1.size, 48);
    assert.equal(p.tokens.spacing.unit.value, 8);
    assert.equal(p.tokens.shape.radiusButton.value, 8);
    assert.equal(p.tokens.surfaces.style.value.kind, 'bordered');
    assert.equal(p.tokens.layout.maxContentWidth.value, 1120);
    assert.equal(p.tokens.layout.headerSticky.value, true);
    assert.equal(p.tokens.schemes.prefersDark.value.responds, true);
    assert.equal(p.tokens.schemes.prefersDark.value.background, '#11170f');
    // responsive
    const kinds = p.tokens.responsive.behaviors.value.map((n) => n.kind);
    assert.ok(kinds.includes('nav-collapses') && kinds.includes('h1-scales-down') && kinds.includes('grid-reflows'), kinds.join());
    assert.deepEqual(p.tokens.responsive.viewports.value.map((v) => v.name), ['desktop', 'tablet', 'mobile']);
    // assets
    assert.equal(p.assets.logo.value.kind, 'inline-svg');
    assert.ok(p.assets.logo.confidence >= 0.75);
    assert.ok(p.assets.favicon.value.href.endsWith('/favicon.svg'));
    assert.equal(p.assets.themeColor.value.hex, '#1f7a4d');
    assert.ok(assets.some((f) => f.startsWith('logo-inline-')) && assets.some((f) => f.startsWith('favicon-')) && assets.some((f) => f.startsWith('og-image-')), assets.join());
  });

  await t.test('fernhill: the stale design doc is recorded as a conflict and loses to the page', async () => {
    const { profile: p } = await inspectFixture('fernhill', browser, { docs: true });
    const stale = p.conflicts.find((x) => x.path === 'tokens.colors.primary');
    assert.equal(stale.claimed.value, '#3b82f6');
    assert.equal(stale.observed.value, '#1f7a4d');
    assert.equal(p.tokens.colors.primary.value.hex, '#1f7a4d');
    assert.ok(p.conflicts.some((x) => x.path === 'tokens.typography.heading' && x.claimed.value === 'Fraunces'));
    // the same doc agrees about the background, which therefore gains a repo-file source
    const bgKinds = p.tokens.colors.background.sources.map((id) => p.evidence.find((e) => e.id === id).kind);
    assert.ok(bgKinds.includes('repo-file') && bgKinds.includes('css-variable') && bgKinds.includes('rendered'));
    const md = renderMarkdown(p);
    assert.match(md, /## Conflicts between sources[\s\S]*#3b82f6/);
  });

  await t.test('mono: a monochrome brand is described as monochrome; absent logo/favicon/fonts are reported missing', async () => {
    const { profile: p } = await inspectFixture('mono', browser);
    assert.deepEqual(validateProfile(p), []);
    assert.equal(p.tokens.colors.primary.value.hex, '#111111');
    assert.equal(p.tokens.colors.primary.basis, 'neutral-interactive');
    assert.equal(p.tokens.colors.accent.value, null);
    assert.equal(p.assets.logo.value, null);
    assert.equal(p.assets.favicon.value, null);
    assert.equal(p.tokens.typography.mono.value, null);
    assert.equal(p.tokens.typography.body.value.family, 'Times New Roman');
    assert.equal(p.tokens.surfaces.style.value.kind, 'bordered');
    assert.equal(p.tokens.schemes.prefersDark.value.responds, false);
  });

  await t.test('sparse: an almost empty page produces a valid profile that mostly says "not found"', async () => {
    const { profile: p } = await inspectFixture('sparse', browser);
    assert.deepEqual(validateProfile(p), []);
    assert.equal(p.tokens.colors.primary.value, null);
    assert.ok(p.missing.length >= 15, `missing: ${p.missing.length}`);
    assert.ok(p.summary.overallConfidence < 0.75);
    assert.equal(p.guards.fallbacksUsed, false);
  });

  await t.test('purple: a site that really is #7c5cff is measured as such and the coincidence is disclosed', async () => {
    const { profile: p } = await inspectFixture('purple', browser);
    assert.equal(p.tokens.colors.primary.value.hex, '#7c5cff');
    assert.equal(p.tokens.colors.background.value.hex, '#0b0b14');
    const m = p.guards.reelkitDefaults.matches.find((x) => x.path === 'tokens.colors.primary');
    assert.ok(m && m.observedOnSite);
    assert.equal(p.tokens.colors.primary.sources.map((id) => p.evidence.find((e) => e.id === id).kind).includes('css-variable'), true, '--primary also declared');
  });

  await t.test('brokencss: a page whose stylesheet 404s is flagged as unreliable instead of reported as branded', async () => {
    const { profile: p } = await inspectFixture('brokencss', browser);
    assert.deepEqual(validateProfile(p), []);
    assert.match(p.summary.warnings.join(' '), /missing-brand\.css HTTP 404/);
    assert.ok(p.tokens.colors.primary.confidence <= 0.3, `primary ${p.tokens.colors.primary.confidence}`);
    assert.ok(p.tokens.typography.body.confidence <= 0.4);
    assert.ok(p.summary.overallConfidence <= 0.45, `overall ${p.summary.overallConfidence}`);
  });

  await t.test('inspection is deterministic: two runs give identical profiles', async () => {
    const a = (await inspectFixture('fernhill', browser, { docs: true })).profile;
    const b = (await inspectFixture('fernhill', browser, { docs: true })).profile;
    const strip = (p) => JSON.stringify({ ...p, site: { ...p.site, url: '' }, evidence: p.evidence.map((e) => ({ ...e, where: e.where.replace(/127\.0\.0\.1:\d+/, 'host') })) }).replace(/127\.0\.0\.1:\d+/g, 'host');
    assert.equal(strip(a), strip(b));
  });
});

/* ───────────── CLI ───────────── */

test('reelkit design writes design-profile.json + .md to the work dir and touches nothing else', async () => {
  const site = await serve(path.join(FIXTURES, 'fernhill'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rk-cli-'));
  try {
    // async spawn: the fixture server lives in this process, so the event loop must stay free
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(SKILL, 'scripts', 'reelkit.mjs'), 'design', '--url', site.url, '--root', path.join(FIXTURES, 'fernhill')], { cwd: tmp });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const dir = path.join(tmp, '.reelkit', 'design');
    const json = JSON.parse(readFileSync(path.join(dir, 'design-profile.json'), 'utf8'));
    assert.deepEqual(validateProfile(json), []);
    assert.match(readFileSync(path.join(dir, 'design-profile.md'), 'utf8'), /^# Design profile: Fernhill/);
    assert.deepEqual(readdirSync(tmp), ['.reelkit'], 'only the work dir was created (no docs/media, no config)');
    assert.match(run.stdout, /overall confidence/);
  } finally {
    site.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('reelkit design reports an unreachable site with a fix line instead of a profile', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'rk-cli-'));
  try {
    const r = spawnSync(process.execPath, [path.join(SKILL, 'scripts', 'reelkit.mjs'), 'design', '--url', 'http://127.0.0.1:9/'], { cwd: tmp, encoding: 'utf8', timeout: 90_000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Could not inspect/);
    assert.match(r.stdout + r.stderr, /fix:/);
    assert.ok(!existsSync(path.join(tmp, '.reelkit', 'design', 'design-profile.json')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
