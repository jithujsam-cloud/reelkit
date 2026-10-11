import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, deltaEOK, oklabToOklch, parseHex, relativeLuminance, rgbToOklab, srgbToLinear, toHex } from '../scripts/lib/color.mjs';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);

test('parseHex / toHex round-trip and reject garbage', () => {
  assert.deepEqual(parseHex('#7c5cff'), [124, 92, 255]);
  assert.deepEqual(parseHex('7C5CFF'), [124, 92, 255]);
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.equal(parseHex('rgb(1,2,3)'), null);
  assert.equal(parseHex('#12345'), null);
  assert.equal(toHex([124, 92, 255]), '#7c5cff');
  assert.equal(toHex([300, -4, 12.6]), '#ff000d');
});

test('sRGB transfer function endpoints and breakpoint', () => {
  assert.equal(srgbToLinear(0), 0);
  assert.equal(srgbToLinear(255), 1);
  near(srgbToLinear(10), 10 / 255 / 12.92, 1e-12, 'linear segment');
  near(srgbToLinear(128), 0.2158605, 1e-6, 'mid grey');
});

test('WCAG relative luminance and contrast match published values', () => {
  near(relativeLuminance([255, 255, 255]), 1, 1e-12);
  near(relativeLuminance([0, 0, 0]), 0, 1e-12);
  near(contrastRatio([0, 0, 0], [255, 255, 255]), 21, 1e-9, 'black/white');
  near(contrastRatio([255, 255, 255], [0, 0, 0]), 21, 1e-9, 'order-independent');
  // #767676 on white is the well-known smallest grey passing AA (4.54:1).
  near(contrastRatio(parseHex('#767676'), [255, 255, 255]), 4.54, 0.01, '#767676');
  near(contrastRatio(parseHex('#777777'), [255, 255, 255]), 4.48, 0.01, '#777777');
});

test('OKLab reference values (Ottosson)', () => {
  const [Lw, aw, bw] = rgbToOklab([255, 255, 255]);
  near(Lw, 1, 1e-4, 'white L');
  near(aw, 0, 1e-4, 'white a');
  near(bw, 0, 1e-4, 'white b');
  const [Lr, ar, br] = rgbToOklab([255, 0, 0]);
  near(Lr, 0.62796, 1e-4, 'red L');
  near(ar, 0.22486, 1e-4, 'red a');
  near(br, 0.12585, 1e-4, 'red b');
  assert.deepEqual(rgbToOklab([0, 0, 0]).map((v) => Math.round(v * 1e6) / 1e6 + 0), [0, 0, 0]);
});

test('OKLCH hue and achromatic handling', () => {
  const [, C, h] = oklabToOklch(rgbToOklab([255, 0, 0]));
  near(C, 0.25768, 1e-4, 'red chroma');
  near(h, 29.23, 0.05, 'red hue');
  const [, Cg, hg] = oklabToOklch(rgbToOklab([128, 128, 128]));
  assert.ok(Cg < 1e-4, 'grey has ~no chroma');
  assert.equal(hg, 0);
  const [, , hb] = oklabToOklch(rgbToOklab([0, 0, 255]));
  assert.ok(hb > 260 && hb < 270, `blue hue ${hb}`);
});

test('ΔEok is a metric with sensible scale', () => {
  assert.equal(deltaEOK([12, 34, 56], [12, 34, 56]), 0);
  near(deltaEOK([0, 0, 0], [255, 255, 255]), 1, 1e-4, 'black/white');
  const ab = deltaEOK([10, 120, 40], [60, 80, 200]);
  assert.equal(ab, deltaEOK([60, 80, 200], [10, 120, 40]), 'symmetric');
  assert.ok(deltaEOK([100, 100, 100], [101, 100, 100]) < 0.01, 'one-level change is imperceptible');
});
