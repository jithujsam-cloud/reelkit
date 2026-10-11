// Profile schema and builder tests without a browser: validation, missing values, confidence
// metadata and the declared-only (site unreachable) path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProfile, profileMarkdown, validateProfile, PROFILE_VERSION } from '../scripts/lib/design/profile.mjs';
import { scanProject } from '../scripts/lib/design/source.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'design');

function declaredOnly(site = 'forest') {
  return buildProfile({
    cfg: { name: 'Fixture', root: FIXTURES },
    baseUrl: 'http://127.0.0.1:9',
    routes: [{ url: '/', status: 'unreachable', reason: 'connection refused', themes: [], viewports: [] }],
    observations: [],
    declared: scanProject(path.join(FIXTURES, site)),
    savedLogos: [],
    sourceRoot: site,
  });
}

const clone = (v) => JSON.parse(JSON.stringify(v));

test('a profile built without any rendering is valid, "not rendered" and never observed', () => {
  const p = declaredOnly();
  assert.equal(p.profileVersion, PROFILE_VERSION);
  const check = validateProfile(p);
  assert.ok(check.ok, check.errors.join('\n'));
  assert.equal(p.coverage.status, 'not rendered');
  assert.doesNotMatch(JSON.stringify(p), /"basis":"observed"/);
  const primary = p.palette.light.roles.primary;
  assert.equal(primary.value, '#1f6b45');
  assert.equal(primary.basis, 'declared');
  assert.ok(primary.confidence <= 0.6);
  assert.ok(p.unverified.some((u) => /No page could be rendered/.test(u)));
  assert.deepEqual(p.conflicts, [], 'nothing observed means nothing to conflict with');
});

test('missing values are null with a reason, never filled in', () => {
  const p = declaredOnly('plain');
  for (const [role, f] of Object.entries(p.palette.light?.roles ?? {})) {
    if (f.value === null) {
      assert.equal(f.basis, 'unknown', role);
      assert.equal(f.confidence, 0, role);
      assert.ok(f.reason, `${role} has a reason`);
    }
  }
  assert.equal(p.typography.mono.value, null);
  assert.ok(p.typography.mono.reason);
  assert.ok(validateProfile(p).ok);
});

test('markdown output is deterministic and labels basis', () => {
  const a = profileMarkdown(declaredOnly());
  assert.equal(a, profileMarkdown(declaredOnly()));
  assert.match(a, /not rendered/);
  assert.match(a, /declared/);
});

test('schema rejects malformed confidence metadata and missing fields', () => {
  const good = declaredOnly();
  const cases = {
    'confidence above 1': (p) => { p.palette.light.roles.primary.confidence = 1.2; },
    'unknown level': (p) => { p.palette.light.roles.primary.level = 'certain'; },
    'null value without a reason': (p) => { p.typography.mono = { value: null, basis: 'unknown', confidence: 0, level: 'low', sources: [] }; },
    'null value claimed as observed': (p) => { Object.assign(p.typography.mono, { basis: 'observed' }); },
    'null value with confidence': (p) => { Object.assign(p.typography.mono, { confidence: 0.4 }); },
    'value with basis unknown': (p) => { p.palette.light.roles.primary.basis = 'unknown'; },
    'non-hex colour': (p) => { p.palette.light.roles.primary.value = 'green'; },
    'unknown source type': (p) => { p.palette.light.roles.primary.sources[0].type = 'guess'; },
    'missing conflicts': (p) => { delete p.conflicts; },
    'missing unverified': (p) => { delete p.unverified; },
    'future profile version': (p) => { p.profileVersion = 2; },
    'conflict from a rendered source': (p) => { p.conflicts.push({ field: 'palette.light.primary', declared: '#000000', declaredIn: 'x', sourceType: 'rendered-role', resolution: 'r' }); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const p = clone(good);
    mutate(p);
    assert.equal(validateProfile(p).ok, false, `schema should reject: ${name}`);
  }
  const ok = clone(good);
  ok.conflicts.push({ field: 'palette.light.primary', observed: '#0d9488', declared: '#2563eb', declaredIn: 'DESIGN.md', sourceType: 'docs', deltaE: 0.2, resolution: 'rendered value used' });
  assert.ok(validateProfile(ok).ok, 'a well-formed conflict validates');
});
