// Phase 2: design directions, previews and approval. Unit tests need no browser; the Chromium tests
// use real screenshots of the fixture sites as the product captures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { contrast } from '../scripts/lib/direction/palette.mjs';
import { distinctness, MIN_DIFFERING_AXES } from '../scripts/lib/direction/distinct.mjs';
import { proposeDirections } from '../scripts/lib/direction/generate.mjs';
import { readInputs, fontVoice } from '../scripts/lib/direction/inputs.mjs';
import { canonical, getPath, setPath, sha256, validate } from '../scripts/lib/direction/schema.mjs';
import { APPROVED_ID, adjust, approve, directionHash, effectiveDirection, loadCandidates, loadState, propose, select, status } from '../scripts/lib/direction/flow.mjs';
import { canvasCss, pickSource, renderPreviews, shadowsFor, templateOptions, SIZES } from '../scripts/lib/direction/preview.mjs';
import { paths, writeCanonical } from '../scripts/lib/direction/store.mjs';
import { compareScreenRegion, screenGeometry } from '../scripts/lib/authenticity.mjs';
import { render, spec } from '../scripts/lib/frame.mjs';
import { ReelkitError, setQuiet } from '../scripts/lib/log.mjs';
import { runDesign } from '../scripts/lib/design/index.mjs';
import { PROFILES } from './helpers/profiles.mjs';
import { makeProject } from './helpers/direction-project.mjs';

// node:test uses stdout as its event channel; keep reelkit's progress output out of it.
setQuiet(true);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures', 'design');
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `rk-dir-${p}-`));
const REELKIT_PURPLES = ['#7c5cff', '#22d3ee'];

const writeProfile = (root, profile) => {
  const p = paths(root);
  mkdirSync(p.design, { recursive: true });
  writeFileSync(p.profile, JSON.stringify(profile, null, 2));
};

/* ───────────── schema ───────────── */

test('schema: generated directions, candidates and approved records validate; damage is rejected', () => {
  const c = proposeDirections(PROFILES.green());
  assert.deepEqual(validate('candidates', c), []);
  for (const d of c.directions) assert.deepEqual(validate('direction', d), [], d.id);

  const bad = (mutate, pattern) => {
    const d = structuredClone(c.directions[0]);
    mutate(d);
    const problems = validate('direction', d);
    assert.ok(problems.length, `expected a problem for ${pattern}`);
    assert.ok(problems.some((m) => pattern.test(m)), `${pattern} not in ${problems.join(' | ')}`);
  };
  bad((d) => delete d.rationale, /rationale|required/);
  bad((d) => (d.palette.light.accent = 'purple'), /accent|pattern/);
  bad((d) => (d.palette.light.canvas = '#FFFFFF'), /canvas|pattern/);
  bad((d) => (d.composition.single.family = 'carousel'), /family|allowed/);
  bad((d) => (d.typography.weight = 1200), /weight|maximum/);
  bad((d) => (d.surprise = true), /surprise|additional/);
  bad((d) => (d.motion.cursor = 'hand'), /cursor|allowed/);
  bad((d) => (d.basis.fallbacks = [{ path: 'x', reason: 'no', used: 'y' }]), /reason|minLength|fewer/);

  const two = structuredClone(c);
  two.directions.pop();
  assert.ok(validate('candidates', two).length, 'exactly three directions are required');
  const v2 = structuredClone(c);
  v2.schemaVersion = 2;
  assert.ok(validate('candidates', v2).length, 'unsupported schemaVersion');
  const wrongKind = structuredClone(c);
  wrongKind.kind = 'something-else';
  assert.ok(validate('candidates', wrongKind).length);
});

test('canonical JSON is key-order independent and hashing is stable', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(sha256({ x: 1, y: [1, 2] }), sha256({ y: [1, 2], x: 1 }));
  assert.notEqual(sha256({ x: 1 }), sha256({ x: 2 }));
});

test('setPath/getPath only touch existing fields and never mutate the input', () => {
  const d = proposeDirections(PROFILES.green()).directions[0];
  const before = JSON.stringify(d);
  assert.equal(getPath(d, 'composition.single.deviceScale'), d.composition.single.deviceScale);
  assert.equal(setPath(d, 'composition.single.deviceScale', 0.5).composition.single.deviceScale, 0.5);
  assert.equal(JSON.stringify(d), before, 'input untouched');
  assert.equal(setPath(d, 'composition.nope.x', 1), null);
  assert.equal(setPath(d, 'composition.single.nope', 1), null);
  assert.equal(getPath(d, 'a.b.c'), undefined);
});

/* ───────────── generation from real profiles ───────────── */

for (const name of Object.keys(PROFILES)) {
  test(`directions from the "${name}" profile: three, valid, genuinely distinct, readable, no Reelkit purple unless the brand is`, () => {
    const profile = PROFILES[name]();
    const c = proposeDirections(profile);
    assert.equal(c.directions.length, 3);
    assert.equal(new Set(c.directions.map((d) => d.id)).size, 3);
    const dist = distinctness(c.directions);
    assert.ok(dist.ok, dist.failures.join('; '));
    assert.ok(c.distinctness.minDifferingAxes >= MIN_DIFFERING_AXES, `${c.distinctness.minDifferingAxes} axes`);
    for (const p of dist.pairs) assert.ok(p.compositionDiffs >= 2, `${p.a}/${p.b} differ in only ${p.compositionDiffs} compositions`);
    for (const d of c.directions) {
      for (const theme of ['light', 'dark']) {
        const pal = d.palette[theme];
        assert.ok(contrast(pal.text, pal.canvas) >= 4.5, `${d.id} ${theme} text contrast`);
        assert.ok(contrast(pal.muted, pal.canvas) >= 3.5, `${d.id} ${theme} muted contrast`);
        assert.ok(contrast(pal.accent, pal.canvas) >= 3, `${d.id} ${theme} accent contrast`);
      }
    }
    const json = JSON.stringify(c.directions.map((d) => d.palette)).toLowerCase();
    if (name !== 'purple') for (const hex of REELKIT_PURPLES) assert.ok(!json.includes(hex), `${hex} must not appear for a non-purple brand`);
    assert.deepEqual(validate('candidates', c), []);
  });
}

test('the three proposed archetypes adapt to the profile instead of being a fixed trio', () => {
  const ids = (n) => proposeDirections(PROFILES[n]()).directions.map((d) => d.id);
  assert.ok(ids('dark').includes('dark-stage'), 'a dark interface gets a dark stage');
  assert.ok(!ids('green').includes('dark-stage'), 'a light product does not');
  assert.ok(ids('green').includes('brand-led'), 'a strong chromatic brand gets a brand-led direction');
  assert.ok(!ids('sparse').includes('brand-led'), 'no brand evidence, no brand-led direction');
  assert.notDeepEqual(ids('green'), ids('sparse'));
});

test('the brand colour is used when it is the brand, and a genuinely purple brand may use purple', () => {
  const c = proposeDirections(PROFILES.purple());
  const brandLed = c.directions.find((d) => d.id === 'brand-led');
  assert.ok(brandLed.basis.used.some((u) => u.path === 'tokens.colors.primary' && u.value === '#7c5cff'), 'built from the observed brand colour');
  assert.ok(brandLed.basis.choices.some((x) => /cannot carry readable text.*darkened/.test(x.why)), 'a mid-tone brand is darkened for readability, and says so');
  assert.ok(contrast(brandLed.palette.light.text, brandLed.palette.light.canvas) >= 4.5);
  const green = proposeDirections(PROFILES.green()).directions.find((d) => d.id === 'brand-led');
  assert.equal(green.palette.light.canvas, '#1f7a4d');
});

/* ───────────── distinctness is about composition, not colour ───────────── */

test('directions that differ only in accent colour are rejected', () => {
  const base = proposeDirections(PROFILES.green()).directions[0];
  const recolour = (id, accent) => {
    const d = structuredClone(base);
    d.id = id;
    d.palette.light.accent = accent;
    d.palette.light.canvas = accent;
    return d;
  };
  const dist = distinctness([recolour('a-one', '#0f766e'), recolour('a-two', '#e8604c'), recolour('a-three', '#2563eb')]);
  assert.equal(dist.ok, false);
  assert.ok(dist.failures.length >= 3);
  assert.match(dist.failures[0], /differ on only/);
});

test('changing only layout families is not enough either: six independent axes must differ', () => {
  const [a, b, c] = proposeDirections(PROFILES.green()).directions.map((d) => structuredClone(d));
  b.palette = a.palette; b.typography = a.typography; b.depth = a.depth; b.motion = a.motion; b.palette.accentUse = a.palette.accentUse;
  b.composition.single.deviceScale = a.composition.single.deviceScale;
  const dist = distinctness([a, b, c]);
  assert.equal(dist.ok, false);
});

/* ───────────── missing and low-confidence profile values ───────────── */

test('missing brand colour: explicit fallbacks with reasons, never a default palette', () => {
  const c = proposeDirections(PROFILES.sparse());
  assert.equal(c.profile.quality, 'low');
  for (const d of c.directions) {
    assert.ok(d.basis.fallbacks.length > 0, `${d.id} reports its fallbacks`);
    assert.ok(d.basis.fallbacks.every((f) => f.reason.length > 10 && f.used.length > 0));
    assert.ok(d.basis.warnings.some((w) => /overall profile confidence/.test(w)));
  }
  const text = JSON.stringify(c.directions);
  for (const hex of REELKIT_PURPLES) assert.ok(!text.toLowerCase().includes(hex));
  assert.ok(c.directions.some((d) => d.basis.fallbacks.some((f) => /accent/.test(f.path))));
});

test('a brand colour that was only declared (never seen) is not used as the brand', () => {
  const profile = PROFILES.declaredOnly();
  const I = readInputs(profile);
  assert.equal(I.brand.hex, null);
  assert.match(I.brand.reason, /declared-only|not observed in use|below/);
  const c = proposeDirections(profile);
  assert.ok(!c.directions.some((d) => d.basis.used.some((u) => u.path === 'tokens.colors.primary')));
  assert.ok(!JSON.stringify(c.directions).includes('#0a7f5a'));
});

test('failed stylesheets (profile capped at 40%) mark the whole set low quality and carry the warning', () => {
  const c = proposeDirections(PROFILES.brokenCss());
  assert.equal(c.profile.quality, 'low');
  assert.ok(c.directions.every((d) => d.basis.warnings.some((w) => /stylesheet\(s\) failed to load/.test(w))));
  assert.equal(readInputs(PROFILES.brokenCss()).brand.hex, null, 'a 40% brand colour is not trusted');
});

test('very light and very dark brand colours still produce readable directions', () => {
  for (const n of ['yellow', 'navy']) {
    for (const d of proposeDirections(PROFILES[n]()).directions) {
      for (const theme of ['light', 'dark']) assert.ok(contrast(d.palette[theme].text, d.palette[theme].canvas) >= 4.5, `${n}/${d.id}/${theme}`);
    }
  }
});

test('font voice is a generic class only; brand fonts are recorded but not embedded', () => {
  assert.equal(fontVoice('Playfair Display'), 'serif');
  assert.equal(fontVoice('Inter'), 'sans');
  assert.equal(fontVoice('JetBrains Mono'), 'mono');
  assert.equal(fontVoice('Source Sans 3'), 'sans');
  assert.equal(fontVoice(null), null);
  const c = proposeDirections(PROFILES.green());
  for (const d of c.directions) if (d.typography.brandFont) assert.equal(d.typography.brandFont.embed, false);
});

test('invalid or empty profiles are refused with a fix line', () => {
  assert.throws(() => proposeDirections(null), (e) => e instanceof ReelkitError && /reelkit design/.test(e.fix));
  const broken = PROFILES.green();
  delete broken.tokens.colors;
  assert.throws(() => proposeDirections(broken), (e) => e instanceof ReelkitError && /invalid/.test(e.message));
});

/* ───────────── repeatability ───────────── */

test('proposing twice gives byte-identical candidates; key order of the input profile does not matter', () => {
  const p = PROFILES.green();
  const a = canonical(proposeDirections(p));
  const b = canonical(proposeDirections(JSON.parse(JSON.stringify(p))));
  assert.equal(a, b);
  const reordered = Object.fromEntries(Object.keys(p).reverse().map((k) => [k, p[k]]));
  assert.equal(canonical(proposeDirections(reordered)), a);
  assert.ok(!/20\d\d-\d\d-\d\dT/.test(a), 'no timestamp in canonical candidates');
});

/* ───────────── approval state machine (files only) ───────────── */

function previewManifest(root, candidates, state, ids) {
  const p = paths(root);
  const items = ids.map((id) => ({ id, kind: 'single', file: `previews/${id}-single.png`, width: 1600, height: 1000, directionSha256: directionHash(effectiveDirection(root, candidates, state, id)), productPixels: 'unmodified' }));
  writeCanonical(p.previews, { schemaVersion: 1, kind: 'reelkit-direction-previews', source: { scene: 'home', theme: 'light', file: 'media/x.png', sha256: 'a'.repeat(64), viewport: 'desktop' }, profileSha256: state.profileSha256, items, skipped: [] });
}

test('approval workflow: every illegal step is refused, and approval is never implicit', () => {
  const root = tmp('flow');
  try {
    writeProfile(root, PROFILES.green());
    assert.throws(() => select(root, 'minimal'), (e) => e instanceof ReelkitError && /No candidate directions/.test(e.message) && /direction propose/.test(e.fix), 'select before propose');
    const { candidates } = propose(root);
    assert.equal(loadState(root).status, 'proposed');
    assert.throws(() => approve(root, { confirmed: true }), /No direction has been selected/);
    assert.throws(() => select(root, 'nope'), /Unknown direction "nope"/);
    select(root, 'minimal');
    assert.equal(loadState(root).status, 'selected');
    assert.throws(() => approve(root, { confirmed: false }), /explicit confirmation/);
    assert.throws(() => approve(root, {}), /explicit confirmation/);
    assert.throws(() => approve(root, { confirmed: 'yes' }), /explicit confirmation/, 'only literal true counts');
    assert.throws(() => approve(root, { confirmed: true }), /no up-to-date previews/);
    assert.ok(!existsSync(paths(root).approved), 'nothing written without approval');

    previewManifest(root, candidates, loadState(root), ['minimal']);
    assert.equal(status(root).previewsFresh, true);
    const record = approve(root, { confirmed: true });
    assert.deepEqual(validate('approved', record), []);
    assert.equal(record.approvedFrom.id, 'minimal');
    assert.equal(record.directionSha256, directionHash(record.direction));
    assert.ok(existsSync(paths(root).approved));
    assert.equal(status(root).status, 'approved');
    assert.ok(!/20\d\d-\d\d-\d\dT/.test(readFileSync(paths(root).approved, 'utf8')), 'approved file has no timestamp');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adjusting a direction: validated, recorded, original kept, previews go stale, approval resets to selected', () => {
  const root = tmp('adjust');
  try {
    writeProfile(root, PROFILES.green());
    const { candidates } = propose(root);
    select(root, 'minimal');
    previewManifest(root, candidates, loadState(root), ['minimal']);
    approve(root, { confirmed: true });
    const approvedBytes = readFileSync(paths(root).approved, 'utf8');

    assert.throws(() => adjust(root, null, []), /Nothing to adjust/);
    assert.throws(() => adjust(root, 'minimal', ['nope=1']), /Unknown setting/);
    assert.throws(() => adjust(root, 'minimal', ['composition.single.deviceScale=7']), /not allowed/);
    assert.throws(() => adjust(root, 'minimal', ['composition.single.family=carousel']), /not allowed/);
    assert.throws(() => adjust(root, 'minimal', ['id=x']), /cannot be adjusted/);
    assert.throws(() => adjust(root, 'minimal', ['basis.used=[]']), /cannot be adjusted/);
    assert.throws(() => adjust(root, 'minimal', ['palette.light.text=#fafaf8']), /unreadable/);
    assert.throws(() => adjust(root, 'minimal', ['bad']), /Bad --set/);
    assert.equal(loadState(root).revision, 0, 'failed adjustments change nothing');

    const { direction } = adjust(root, 'minimal', ['composition.single.deviceScale=0.7', 'depth.radius=10', 'motion.cursor="ring"']);
    assert.equal(direction.composition.single.deviceScale, 0.7);
    assert.equal(direction.motion.cursor, 'ring');
    const s = loadState(root);
    assert.equal(s.revision, 1);
    assert.equal(s.status, 'selected', 'approval no longer matches the working direction');
    assert.equal(status(root).previewsFresh, false);
    assert.equal(status(root).approvedMatchesSelection, false);
    assert.equal(readFileSync(paths(root).approved, 'utf8'), approvedBytes, 'the previously approved file is untouched until re-approval');
    assert.equal(loadCandidates(root).directions.find((d) => d.id === 'minimal').composition.single.deviceScale, candidates.directions.find((d) => d.id === 'minimal').composition.single.deviceScale, 'original candidate preserved');

    assert.throws(() => approve(root, { confirmed: true }), /no up-to-date previews/);
    previewManifest(root, loadCandidates(root), loadState(root), ['minimal']);
    const second = approve(root, { confirmed: true });
    assert.deepEqual(second.approvedFrom.adjustments.map((a) => a.path).sort(), ['composition.single.deviceScale', 'depth.radius', 'motion.cursor']);
    assert.equal(second.approvedFrom.revision, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a changed profile makes the proposal stale and blocks approval; re-proposing keeps the approved file', () => {
  const root = tmp('stale');
  try {
    writeProfile(root, PROFILES.green());
    const { candidates } = propose(root);
    select(root, 'editorial');
    previewManifest(root, candidates, loadState(root), ['editorial']);
    approve(root, { confirmed: true });
    const keep = readFileSync(paths(root).approved, 'utf8');

    writeProfile(root, PROFILES.coral());
    assert.equal(status(root).profileStale, true);
    assert.throws(() => approve(root, { confirmed: true }), /profile changed/);
    propose(root);
    assert.equal(readFileSync(paths(root).approved, 'utf8'), keep, 'approved direction survives a new proposal');
    assert.equal(loadState(root).approved.id, 'editorial');
    const s = select(root, APPROVED_ID);
    assert.equal(s.selected, APPROVED_ID);
    assert.equal(effectiveDirection(root, loadCandidates(root), s, APPROVED_ID).archetype, 'editorial');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a low-confidence profile needs --accept-low-confidence to be approved', () => {
  const root = tmp('low');
  try {
    writeProfile(root, PROFILES.sparse());
    const { candidates } = propose(root);
    const id = candidates.directions[0].id;
    select(root, id);
    previewManifest(root, candidates, loadState(root), [id]);
    assert.throws(() => approve(root, { confirmed: true }), /low-confidence/);
    assert.ok(!existsSync(paths(root).approved));
    approve(root, { confirmed: true, acceptLowConfidence: true });
    assert.ok(existsSync(paths(root).approved));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt or invalid state files give a clear error, never a crash or a silent reset', () => {
  const root = tmp('corrupt');
  try {
    writeProfile(root, PROFILES.green());
    propose(root);
    writeFileSync(paths(root).candidates, '{not json');
    assert.throws(() => select(root, 'minimal'), (e) => e instanceof ReelkitError && /not valid JSON/.test(e.message));
    propose(root);
    const state = JSON.parse(readFileSync(paths(root).state, 'utf8'));
    state.status = 'finished';
    writeFileSync(paths(root).state, JSON.stringify(state));
    assert.throws(() => select(root, 'minimal'), (e) => e instanceof ReelkitError && /invalid/.test(e.message));
    propose(root);
    writeFileSync(paths(root).approved, JSON.stringify({ kind: 'reelkit-direction' }));
    assert.throws(() => select(root, APPROVED_ID), (e) => e instanceof ReelkitError && /invalid/.test(e.message));
    assert.throws(() => propose(tmp('noprofile')), (e) => e instanceof ReelkitError && /No design profile/.test(e.message) && /reelkit design/.test(e.fix));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ───────────── template options (pure) ───────────── */

test('template options: flat colour fields only, comparable sizes, shadows per depth style', () => {
  const c = proposeDirections(PROFILES.green());
  const spec1 = { type: 'browser', w: 1440, h: 900, src: 'file:///x.png', chrome: 'light', url: 'x' };
  for (const d of c.directions) {
    for (const kind of ['single', 'social', 'trio']) {
      const o = templateOptions(d, kind, 'light', { devices: [spec1], title: 'T', caption: 'C', brand: 'B' });
      assert.deepEqual(o.size, SIZES[kind]);
      assert.ok(!/radial|conic/.test(o.canvasCss), 'no radial/conic gradients');
      if (d.palette.background.kind !== 'split') assert.equal(o.canvasCss, d.palette.light.canvas);
      else {
        const stops = o.canvasCss.match(/ 0 (\d+)%, .* (\d+)% 100%/);
        assert.equal(stops[1], stops[2], 'hard colour stop: two flat fields, not a gradient');
      }
    }
  }
  assert.deepEqual(shadowsFor({ depth: { shadow: 'none' } }, c.directions[0].palette.light), []);
  assert.equal(shadowsFor({ depth: { shadow: 'layered' } }, c.directions[0].palette.light).length, 3);
  assert.match(shadowsFor({ depth: { shadow: 'hard' } }, c.directions[0].palette.light)[0], /^14px 14px 0 rgba\(/);
  assert.equal(canvasCss({ palette: { background: { kind: 'solid' } } }, 'single', { canvas: '#112233', canvas2: '#000000' }), '#112233');
});

/* ───────────── CLI surface and legacy compatibility ───────────── */

const run = (args, cwd, input) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SKILL, 'scripts', 'reelkit.mjs'), ...args], { cwd });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
    child.stdin.end(input ?? '');
  });

test('CLI: unknown subcommand and missing profile fail with a fix line; help lists the command; old commands intact', async () => {
  const root = tmp('cli');
  try {
    const unknown = await run(['direction', 'dance'], root);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.out, /Unknown direction command "dance"/);
    const none = await run(['direction'], root);
    assert.match(none.out, /direction needs a command/);
    const missing = await run(['direction', 'propose'], root);
    assert.notEqual(missing.status, 0);
    assert.match(missing.out, /No design profile/);
    assert.match(missing.out, /fix:.*reelkit design/s);
    const help = await run(['--help'], root);
    assert.match(help.out, /direction <cmd>/);
    for (const cmd of ['preflight', 'discover', 'init', 'auth', 'shoot', 'record', 'frame', 'verify', 'readme', 'design', 'all']) assert.match(help.out, new RegExp(`^  ${cmd}\\b`, 'm'), cmd);
    assert.ok(readdirSync(root).length === 0, 'failed commands write nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: approve refuses to run non-interactively without --yes, and `direction show` of a stale/absent session is an error', async () => {
  const root = tmp('cli2');
  try {
    writeProfile(root, PROFILES.green());
    const { candidates } = propose(root);
    select(root, 'minimal');
    previewManifest(root, candidates, loadState(root), ['minimal']);
    const refused = await run(['direction', 'approve'], root, '');
    assert.notEqual(refused.status, 0);
    assert.match(refused.out, /explicit confirmation/);
    assert.ok(!existsSync(paths(root).approved), 'closed stdin must never approve');
    const yes = await run(['direction', 'approve', '--yes'], root);
    assert.equal(yes.status, 0, yes.out);
    assert.ok(existsSync(paths(root).approved));
    const st = await run(['direction', 'status', '--json'], root);
    assert.equal(JSON.parse(st.out).status, 'approved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ───────────── Chromium: real captures, comparable previews ───────────── */

const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml' };
function serve(dir) {
  const server = http.createServer((req, res) => {
    let p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (existsSync(p) && !path.extname(p)) p = path.join(p, 'index.html');
    if (!existsSync(p)) return res.writeHead(404).end('nf');
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

test('previews and workflow in Chromium', async (t) => {
  const { launchBrowser } = await import('../scripts/lib/browser.mjs');
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const site = await serve(path.join(FIXTURES, 'fernhill'));
  t.after(() => site.close());
  const root = tmp('pv');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cfg } = await makeProject({ root, browser, siteUrl: site.url });
  const mediaBefore = readdirSync(path.join(root, 'media')).sort();
  await runDesign({ browser, url: site.url, outDir: paths(root).design, root, docsRoot: path.join(FIXTURES, 'fernhill') });
  const profile = JSON.parse(readFileSync(paths(root).profile, 'utf8'));
  const { candidates, state } = propose(root);

  await t.test('all three directions are previewed from the same capture at comparable sizes', async () => {
    const manifest = await renderPreviews({ root, cfg, browser, directions: candidates.directions, profileSha: state.profileSha256 });
    assert.deepEqual(validate('previews', manifest), []);
    assert.equal(manifest.items.length, 9);
    assert.equal(manifest.source.file, 'media/home-desktop-light.png');
    assert.equal(manifest.source.sha256, sha(path.join(root, manifest.source.file)), 'recorded hash is the capture file hash');
    for (const kind of ['single', 'social', 'trio']) {
      const items = manifest.items.filter((i) => i.kind === kind);
      assert.equal(items.length, 3);
      for (const it of items) {
        const png = PNG.sync.read(readFileSync(path.join(paths(root).dir, it.file)));
        assert.deepEqual([png.width, png.height], [SIZES[kind].w, SIZES[kind].h], `${it.id} ${kind} has the shared size`);
        assert.equal(it.productPixels, 'unmodified');
      }
    }
  });

  await t.test('the compare sheet names the shared capture, every direction and its fallbacks', async () => {
    const { writeCompareSheet } = await import('../scripts/lib/direction/preview.mjs');
    const manifest = JSON.parse(readFileSync(paths(root).previews, 'utf8'));
    const file = writeCompareSheet({ root, directions: candidates.directions, manifest, status: 'proposed', profile });
    const html = readFileSync(file, 'utf8');
    assert.match(html, /media\/home-desktop-light\.png/);
    for (const d of candidates.directions) assert.ok(html.includes(d.name), d.name);
    assert.ok(!/<script/i.test(html), 'static page: no scripts');
    assert.equal((html.match(/<img /g) ?? []).length, 9);
  });

  await t.test('the previews are genuinely different compositions of the same product', async () => {
    const rects = [];
    for (const d of candidates.directions) {
      const file = path.join(root, `probe-${d.id}.png`);
      const o = templateOptions(d, 'single', 'light', { devices: [spec(cfg, { viewport: { width: 1440, height: 900, device: 'browser' }, theme: 'light', scene: { url: '/' } }, path.join(root, 'media', 'home-desktop-light.png'))], title: 'Fernhill', caption: 'Native plants', brand: 'Fernhill' });
      rects.push({ id: d.id, ...(await render(browser, o, { dsf: 1, out: file, entry: 'renderDirection' })).screen, file });
    }
    const near = (a, b) => Math.abs(a - b) < 40;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        assert.ok(!(near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w)), `${a.id} and ${b.id} place the product identically`);
        const pa = PNG.sync.read(readFileSync(a.file));
        const pb = PNG.sync.read(readFileSync(b.file));
        let diff = 0;
        for (let k = 0; k < pa.data.length; k += 16) if (Math.abs(pa.data[k] - pb.data[k]) + Math.abs(pa.data[k + 1] - pb.data[k + 1]) + Math.abs(pa.data[k + 2] - pb.data[k + 2]) > 24) diff++;
        assert.ok(diff / (pa.data.length / 16) > 0.2, `${a.id} vs ${b.id}: only ${(100 * diff / (pa.data.length / 16)).toFixed(0)}% of pixels differ`);
      }
    }
  });

  await t.test('product pixels are untouched: at 1:1 the framed screen equals the capture (existing authenticity check)', async () => {
    const d = structuredClone(candidates.directions.find((x) => x.id === 'minimal'));
    d.composition.single = { family: 'stage', deviceScale: 0.9, heading: false }; // 0.9 × 1600 = 1440: scale exactly 1, fully inside the canvas
    d.depth.radius = 0;
    d.depth.shadow = 'none';
    d.depth.ring = null;
    const out = path.join(root, 'native.png');
    const raw = path.join(root, 'media', 'home-desktop-light.png');
    const o = templateOptions(d, 'single', 'light', { devices: [spec(cfg, { viewport: { width: 1440, height: 900, device: 'browser' }, theme: 'light', scene: { url: '/' } }, raw)], title: '', caption: '', brand: 'Fernhill' });
    const rects = await render(browser, o, { dsf: 1, out, entry: 'renderDirection' });
    assert.equal(rects.screen.w, 1440);
    const g = screenGeometry(rects, 1);
    const cmp = compareScreenRegion({ framed: out, raw, rect: g.rect, src: g.src, clips: g.clips });
    assert.ok(cmp.ok, cmp.reason);
    // and a doctored composite is caught by the same check (the check is not vacuous)
    const png = PNG.sync.read(readFileSync(out));
    for (let y = Math.round(g.rect.y) + 100; y < Math.round(g.rect.y) + 160; y++) for (let x = Math.round(g.rect.x) + 100; x < Math.round(g.rect.x) + 400; x++) png.data[(y * png.width + x) * 4] = 255 - png.data[(y * png.width + x) * 4];
    const tampered = path.join(root, 'tampered.png');
    writeFileSync(tampered, PNG.sync.write(png));
    assert.equal(compareScreenRegion({ framed: tampered, raw, rect: g.rect, src: g.src, clips: g.clips }).ok, false);
  });

  await t.test('previews are repeatable: re-rendering gives identical manifests and image bytes', async () => {
    const a = JSON.parse(readFileSync(paths(root).previews, 'utf8'));
    const hashes = Object.fromEntries(a.items.map((i) => [i.file, sha(path.join(paths(root).dir, i.file))]));
    await renderPreviews({ root, cfg, browser, directions: candidates.directions, profileSha: state.profileSha256 });
    const b = JSON.parse(readFileSync(paths(root).previews, 'utf8'));
    assert.equal(canonical(a), canonical(b));
    for (const i of b.items) assert.equal(sha(path.join(paths(root).dir, i.file)), hashes[i.file], `${i.file} is byte-identical`);
  });

  await t.test('nothing outside .reelkit changes: committed-media location untouched', async () => {
    assert.deepEqual(readdirSync(path.join(root, 'media')).sort(), mediaBefore);
    assert.ok(readdirSync(paths(root).previewsDir).every((f) => f.endsWith('.png')));
  });

  await t.test('--only re-renders one direction and keeps the others valid; adjusting makes only that one stale', async () => {
    select(root, 'minimal');
    adjust(root, 'minimal', ['composition.single.deviceScale=0.55']);
    const s = loadState(root);
    const cands = loadCandidates(root);
    const list = cands.directions.map((d) => effectiveDirection(root, cands, s, d.id));
    assert.equal(status(root).previewsFresh, false);
    await renderPreviews({ root, cfg, browser, directions: list, profileSha: s.profileSha256, onlyIds: ['minimal'] });
    assert.equal(status(root).previewsFresh, true);
    const m = JSON.parse(readFileSync(paths(root).previews, 'utf8'));
    assert.equal(m.items.length, 9, 'other directions kept');
  });

  await t.test('no passing capture means an error with a fix, not a made-up preview', async () => {
    const empty = tmp('nocap');
    try {
      writeFileSync(path.join(empty, 'reelkit.config.yaml'), `name: X\nbaseUrl: ${site.url}\nscenes:\n  - { name: home, url: / }\n  - { name: dash, url: /dashboard, auth: true }\n`);
      const { loadConfig } = await import('../scripts/lib/config.mjs');
      const c = loadConfig(path.join(empty, 'reelkit.config.yaml'));
      assert.throws(() => pickSource(c, {}), (e) => e instanceof ReelkitError && /No scene has a passing still capture/.test(e.message) && /reelkit shoot/.test(e.fix) && /reelkit auth/.test(e.fix) && /dash/.test(e.fix));
      assert.throws(() => pickSource(c, { scene: 'nope' }), /Unknown scene/);
      await assert.rejects(renderPreviews({ root: empty, cfg: c, browser, directions: candidates.directions, profileSha: state.profileSha256 }), /passing still capture/);
      assert.ok(!existsSync(paths(empty).previewsDir), 'no preview files written');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  await t.test('without tablet and mobile captures the trio is skipped and said so, never faked', async () => {
    const solo = tmp('solo');
    try {
      const { cfg: c } = await makeProject({ root: solo, browser, siteUrl: site.url, views: ['desktop'] });
      writeProfile(solo, profile);
      const { candidates: cc, state: ss } = propose(solo);
      const m = await renderPreviews({ root: solo, cfg: c, browser, directions: cc.directions, profileSha: ss.profileSha256 });
      assert.equal(m.items.filter((i) => i.kind === 'trio').length, 0);
      assert.equal(m.items.length, 6);
      assert.match(m.skipped.find((s) => s.kind === 'trio').reason, /tablet and mobile/);
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });
});

/* ───────────── end to end through the CLI ───────────── */

test('CLI end to end: design → propose → preview → select → adjust → preview → approve → status', async (t) => {
  const { launchBrowser } = await import('../scripts/lib/browser.mjs');
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const site = await serve(path.join(FIXTURES, 'fernhill'));
  t.after(() => site.close());
  const root = tmp('e2e');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await makeProject({ root, browser, siteUrl: site.url });
  const step = async (args, ok = true) => {
    const r = await run(args, root);
    assert.equal(r.status === 0, ok, `${args.join(' ')}\n${r.out}`);
    return r.out;
  };
  await step(['design', '--url', site.url, '--root', path.join(FIXTURES, 'fernhill')]);
  const proposed = await step(['direction', 'propose']);
  assert.match(proposed, /Brand-led/);
  assert.match(proposed, /Restrained minimal/);
  assert.match(proposed, /Editorial/);
  assert.match(await step(['direction', 'profile']), /brand #1f7a4d/);
  await step(['direction', 'approve', '--yes'], false); // nothing selected
  await step(['direction', 'preview']);
  assert.ok(existsSync(paths(root).compare));
  await step(['direction', 'select', 'brand-led']);
  await step(['direction', 'approve', '--yes'], true); // previews exist and are fresh for the unadjusted direction
  assert.equal(JSON.parse(readFileSync(paths(root).approved, 'utf8')).approvedFrom.id, 'brand-led');
  await step(['direction', 'adjust', '--set', 'composition.single.deviceScale=0.6']);
  assert.match(await step(['direction', 'status']), /status selected/);
  await step(['direction', 'approve', '--yes'], false); // adjusted: previews are stale
  await step(['direction', 'preview']);
  await step(['direction', 'approve', '--yes']);
  const final = JSON.parse(readFileSync(paths(root).approved, 'utf8'));
  assert.equal(final.direction.composition.single.deviceScale, 0.6);
  assert.equal(final.approvedFrom.revision, 1);
  assert.match(await step(['direction', 'status']), /status approved/);
  assert.ok(existsSync(path.join(root, 'media', 'home-desktop-light.png')) && readdirSync(path.join(root, 'media')).length === 3, 'media folder untouched');
  const shown = JSON.parse(await step(['direction', 'show', 'brand-led', '--json']));
  assert.equal(shown.composition.single.deviceScale, 0.6, 'show reflects the revision');
});
