// Unit tests for evidence reconciliation, source parsing and the pixel census (no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { clusterColors, confidenceFor, findConflicts, pickColor, pickValue, SAME_NEUTRAL } from '../scripts/lib/design/reconcile.mjs';
import { cssCustomProperties, docColors, docFonts, roleFromName } from '../scripts/lib/design/source.mjs';
import { colorCensus } from '../scripts/lib/design/pixels.mjs';

const btn = (hex, route = '/') => ({ hex, type: 'rendered-role', detail: 'primary button', route });

test('clustering does not depend on input order', () => {
  const cands = [btn('#1f6b45'), btn('#1d6a44', '/b'), { hex: '#2563eb', type: 'docs', detail: 'DESIGN.md' }, { hex: '#1f6b45', type: 'logo', detail: 'logo' }];
  const a = clusterColors(cands);
  const b = clusterColors([...cands].reverse());
  assert.deepEqual(a.map((k) => [k.hex, k.weight]), b.map((k) => [k.hex, k.weight]));
  assert.equal(a[0].hex, '#1f6b45', 'representative is the exact value with the most rendered weight');
  assert.equal(a[0].members.length, 3, 'near-identical shades merge');
});

test('no candidates gives a null finding with a reason, never a default colour', () => {
  const f = pickColor('primary', [], { emptyReason: 'nothing measured' });
  assert.deepEqual(f, { value: null, basis: 'unknown', confidence: 0, level: 'low', reason: 'nothing measured', sources: [] });
});

test('chromaticOnly ignores neutrals for brand roles', () => {
  const f = pickColor('primary', [btn('#111111'), btn('#ffffff')], { chromaticOnly: true, emptyReason: 'monochrome' });
  assert.equal(f.value, null);
  assert.equal(f.reason, 'monochrome');
});

test('confidence reflects margin over the runner-up and breadth of evidence', () => {
  const strong = { weight: 9, kinds: new Set(['rendered-role', 'logo', 'meta']) };
  const thin = { weight: 3, kinds: new Set(['rendered-role']) };
  assert.equal(confidenceFor(strong, 0), 1);
  assert.equal(confidenceFor(strong, 9), 0.5);
  assert.equal(confidenceFor(thin, 0), 0.6);
  assert.ok(confidenceFor(strong, 1) > confidenceFor(thin, 1));
});

test('declared-only findings are labelled declared and capped at 0.6', () => {
  const f = pickColor('primary', [
    { hex: '#1f6b45', type: 'docs', detail: 'DESIGN.md' },
    { hex: '#1f6b45', type: 'source-css', detail: 'a.css' },
    { hex: '#1f6b45', type: 'source-tokens', detail: 'tokens.json' },
  ]);
  assert.equal(f.basis, 'declared');
  assert.ok(f.confidence <= 0.6);
  assert.match(f.note, /not seen on the rendered site/);
  assert.deepEqual(findConflicts('light.primary', f, []), [], 'declared findings never produce conflicts with themselves');
});

test('a declaration that disagrees with the rendered value is a conflict; a matching one is not', () => {
  const cands = [btn('#0d9488'), btn('#0d9488', '/b'), { hex: '#2563EB', type: 'docs', detail: 'DESIGN.md: Primary #2563eb' }, { hex: '#0d9488', type: 'source-css', detail: 'app.css' }];
  const f = pickColor('primary', cands);
  assert.equal(f.value, '#0d9488');
  assert.equal(f.basis, 'observed');
  const conflicts = findConflicts('light.primary', f, cands);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].declared, '#2563eb');
  assert.equal(conflicts[0].field, 'palette.light.primary');
  assert.ok(conflicts[0].deltaE > 0.05);
});

test('neutral tolerance keeps background and surface apart', () => {
  const k = clusterColors([btn('#f6f7fb'), btn('#ffffff')], SAME_NEUTRAL);
  assert.equal(k.length, 2);
});

test('pickValue measures font breadth by routes', () => {
  const one = pickValue('body', [{ value: 'Inter', type: 'rendered-role', detail: 'body', route: '/' }], { breadthByRoutes: true });
  const three = pickValue('body', ['/', '/a', '/b'].map((route) => ({ value: 'Inter', type: 'rendered-role', detail: 'body', route })), { breadthByRoutes: true });
  assert.equal(one.confidence, 0.7);
  assert.equal(three.confidence, 1);
  const declared = pickValue('body', [{ value: 'Inter', type: 'docs', detail: 'DESIGN.md' }], { breadthByRoutes: true });
  assert.equal(declared.basis, 'declared');
  assert.ok(declared.confidence <= 0.6);
  assert.equal(pickValue('mono', [], { emptyReason: 'no code' }).reason, 'no code');
});

test('CSS custom properties: dark scopes are detected', () => {
  const vars = cssCustomProperties('/* c */ :root{--brand:#1F6B45;--bg:#fff}\n.dark{--bg:#000}\n@media (prefers-color-scheme: dark){:root{--text:#eee}}');
  assert.deepEqual(vars.map((v) => [v.name, v.dark]), [['--brand', false], ['--bg', false], ['--bg', true], ['--text', true]]);
});

test('role names map to palette roles, foreground variants are skipped', () => {
  assert.equal(roleFromName('--brand'), 'primary');
  assert.equal(roleFromName('--muted-foreground'), 'textMuted');
  assert.equal(roleFromName('--primary-foreground'), null);
  assert.equal(roleFromName('--bg'), 'background');
  assert.equal(roleFromName('--surface'), 'surface');
});

test('docs: colours and fonts (including non-ASCII names) are extracted with their line', () => {
  const md = '# Brand\n\nPrimary brand colour: #2563eb\nHeading font: Söhne\nBody font: Inter, sans-serif\n';
  const colors = docColors(md);
  assert.equal(colors.length, 1);
  assert.equal(colors[0].hex.toLowerCase(), '#2563eb');
  assert.deepEqual(docFonts(md).map((f) => [f.family, f.role]), [['Söhne', 'heading'], ['Inter', 'body']]);
  assert.deepEqual(docFonts('No fonts here.\n'), []);
});

test('pixel census is deterministic and reports shares', () => {
  const png = new PNG({ width: 40, height: 40 });
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const i = (y * 40 + x) * 4;
      const brand = x < 10;
      png.data[i] = brand ? 0x1f : 0xf7;
      png.data[i + 1] = brand ? 0x6b : 0xf8;
      png.data[i + 2] = brand ? 0x45 : 0xf5;
      png.data[i + 3] = 255;
    }
  }
  const buf = PNG.sync.write(png);
  const a = colorCensus(buf);
  assert.deepEqual(a, colorCensus(buf));
  assert.equal(a[0].hex, '#f7f8f5');
  assert.ok(Math.abs(a[0].share - 0.75) < 0.01);
  assert.equal(a[0].chromatic, false);
  assert.equal(a[1].hex, '#1f6b45');
  assert.equal(a[1].chromatic, true);
});
