// Profile → three candidate directions. Deterministic: the same profile always yields byte-identical
// candidates (no clocks, no randomness, no network, no model calls).
import { VERSION } from '../brand.mjs';
import { ReelkitError } from '../log.mjs';
import { validateProfile } from '../design/profile.mjs';
import { ARCHETYPES } from './archetypes.mjs';
import { distinctness } from './distinct.mjs';
import { readInputs } from './inputs.mjs';
import { KINDS, sha256, validate } from './schema.mjs';

const round = (v) => Math.round(v * 100) / 100;

/** Throws a ReelkitError for an unusable profile; returns the problems-free profile otherwise. */
export function assertUsableProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new ReelkitError('The design profile is empty or unreadable.', 'Run `reelkit design --url <site>` to create it.');
  const problems = validateProfile(profile);
  if (problems.length) throw new ReelkitError(`The design profile is invalid:\n  ${problems.slice(0, 5).join('\n  ')}`, 'Re-run `reelkit design --url <site>`; do not edit design-profile.json by hand.');
  return profile;
}

export function proposeDirections(profile) {
  assertUsableProfile(profile);
  const I = readInputs(profile);
  const ranked = ARCHETYPES.map((a) => ({ a, fit: a.fit(I) })).sort((x, y) => y.fit - x.fit || x.a.id.localeCompare(y.a.id));

  // Best three by fit; if (unexpectedly) they are not distinct enough, try the next best combination.
  const combos = [];
  for (let i = 0; i < ranked.length; i++) for (let j = i + 1; j < ranked.length; j++) for (let k = j + 1; k < ranked.length; k++) combos.push([ranked[i], ranked[j], ranked[k]]);
  combos.sort((p, q) => q.reduce((s, r) => s + r.fit, 0) - p.reduce((s, r) => s + r.fit, 0));
  for (const combo of combos) {
    const directions = combo.map(({ a, fit }) => {
      const d = a.build(I);
      d.basis.choices.unshift({ path: 'archetype', why: `chosen for this profile: fit ${round(fit)} of ${ARCHETYPES.length} archetypes considered` });
      d.basis.warnings.push(...I.warnings);
      return d;
    });
    const dist = distinctness(directions);
    if (!dist.ok) continue;
    for (const d of directions) {
      const problems = validate('direction', d);
      if (problems.length) throw new ReelkitError(`Internal error: generated direction "${d.id}" failed validation:\n  ${problems.slice(0, 5).join('\n  ')}`, 'This is a reelkit bug; please report it.');
    }
    const candidates = {
      schemaVersion: 1,
      kind: KINDS.candidates,
      generator: { name: 'reelkit', version: VERSION },
      profile: { sha256: sha256(profile), overallConfidence: round(profile.summary.overallConfidence), level: profile.summary.level, quality: I.quality },
      directions,
      distinctness: { ok: true, minDifferingAxes: dist.minDifferingAxes, axes: dist.axes, pairs: dist.pairs.map((p) => ({ a: p.a, b: p.b, differing: p.differing })) },
    };
    const problems = validate('candidates', candidates);
    if (problems.length) throw new ReelkitError(`Internal error: candidates failed validation:\n  ${problems.slice(0, 5).join('\n  ')}`, 'This is a reelkit bug; please report it.');
    return candidates;
  }
  throw new ReelkitError('Could not produce three sufficiently different directions for this profile.', 'Report the profile that caused this; no directions were written.');
}
