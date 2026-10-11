// The approval workflow as pure functions over files. The CLI is a thin layer on top.
//
//   propose → (preview) → select → [adjust → preview →] approve
//
// Nothing here ever approves implicitly: `approve` needs a selection, fresh previews of exactly the
// selected (and adjusted) direction, and an explicit confirmation passed in by the caller.
import { existsSync, readFileSync } from 'node:fs';
import { ReelkitError } from '../log.mjs';
import { assertUsableProfile, proposeDirections } from './generate.mjs';
import { KINDS, getPath, parseValue, setPath, sha256, validate } from './schema.mjs';
import { paths, readFile, writeCanonical } from './store.mjs';
import { contrast } from './palette.mjs';

const now = () => new Date().toISOString();
export const APPROVED_ID = 'approved';

export function loadProfile(root, profilePath) {
  const p = profilePath ?? paths(root).profile;
  if (!existsSync(p)) throw new ReelkitError(`No design profile at ${p}.`, 'Run `reelkit design --url <your site>` first; directions are built from the real design profile.');
  let profile;
  try {
    profile = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new ReelkitError(`The design profile is not valid JSON (${err.message.split('\n')[0]}).`, 'Re-run `reelkit design --url <your site>`.');
  }
  return assertUsableProfile(profile);
}

export function loadCandidates(root) {
  const c = readFile(paths(root).candidates, 'candidates');
  if (!c) throw new ReelkitError('No candidate directions yet.', 'Run `reelkit direction propose` first.');
  return c;
}
export const loadState = (root) => readFile(paths(root).state, 'state');
export const loadApproved = (root) => readFile(paths(root).approved, 'approved');

function mustState(root) {
  const s = loadState(root);
  if (!s) throw new ReelkitError('No direction session yet.', 'Run `reelkit direction propose` first.');
  return s;
}
const log = (state, event, id, note) => state.history.push({ event, at: now(), ...(id ? { id } : {}), ...(note ? { note } : {}) });

/** Base (unadjusted) direction by id; 'approved' resolves from reelkit.direction.json. */
export function baseDirection(root, candidates, id) {
  if (id === APPROVED_ID) {
    const a = loadApproved(root);
    if (!a) throw new ReelkitError('There is no approved direction file (reelkit.direction.json) to reuse.', 'Approve a direction first, or pick one of the candidate ids.');
    return { ...a.direction, id: APPROVED_ID };
  }
  const d = candidates.directions.find((x) => x.id === id);
  if (!d) throw new ReelkitError(`Unknown direction "${id}".`, `Available: ${candidates.directions.map((x) => x.id).join(', ')}${loadApprovedSafe(root) ? `, ${APPROVED_ID}` : ''}`);
  return d;
}
const loadApprovedSafe = (root) => {
  try {
    return loadApproved(root);
  } catch {
    return null;
  }
};

/** Base direction with the session's recorded adjustments applied. */
export function effectiveDirection(root, candidates, state, id) {
  let d = baseDirection(root, candidates, id);
  for (const { path: p, value } of state.adjustments[id] ?? []) {
    const next = setPath(d, p, value);
    if (next) d = next;
  }
  return d;
}

export function propose(root, { profilePath } = {}) {
  const profile = loadProfile(root, profilePath);
  const candidates = proposeDirections(profile);
  const P = paths(root);
  writeCanonical(P.candidates, candidates);
  const state = {
    schemaVersion: 1,
    kind: KINDS.state,
    status: 'proposed',
    profileSha256: candidates.profile.sha256,
    selected: null,
    adjustments: {},
    revision: 0,
    approved: loadApprovedSafe(root) ? { id: loadApproved(root).approvedFrom.id, revision: loadApproved(root).approvedFrom.revision, directionSha256: loadApproved(root).directionSha256 } : null,
    history: [],
  };
  log(state, 'proposed', null, candidates.directions.map((d) => d.id).join(', '));
  writeCanonical(P.state, state);
  return { candidates, state };
}

export function select(root, id) {
  const candidates = loadCandidates(root);
  const state = mustState(root);
  baseDirection(root, candidates, id); // validates the id
  state.selected = id;
  state.status = isApproved(root, candidates, state) ? 'approved' : 'selected';
  log(state, 'selected', id);
  writeCanonical(paths(root).state, state);
  return state;
}

const PROTECTED = new Set(['id', 'archetype', 'basis']);

/** Apply `--set path=value` changes to a direction; every change is validated. */
export function adjust(root, id, sets) {
  if (!sets.length) throw new ReelkitError('Nothing to adjust.', 'Use --set <path>=<value>, for example --set composition.single.deviceScale=0.7');
  const candidates = loadCandidates(root);
  const state = mustState(root);
  const target = id ?? state.selected;
  if (!target) throw new ReelkitError('No direction selected to adjust.', 'Pass a direction id or run `reelkit direction select <id>` first.');
  let d = effectiveDirection(root, candidates, state, target);
  const applied = [];
  for (const spec of sets) {
    const eq = spec.indexOf('=');
    if (eq < 1) throw new ReelkitError(`Bad --set "${spec}".`, 'Use <path>=<value>, for example palette.light.accent=#0f766e');
    const p = spec.slice(0, eq);
    const value = parseValue(spec.slice(eq + 1));
    if (PROTECTED.has(p.split('.')[0])) throw new ReelkitError(`"${p}" cannot be adjusted.`, 'id, archetype and basis record where the direction came from; adjust palette, typography, composition, devices, depth or motion.');
    if (getPath(d, p) === undefined) throw new ReelkitError(`Unknown setting "${p}".`, 'Run `reelkit direction show <id> --json` to see the available paths.');
    const next = setPath(d, p, value);
    if (!next) throw new ReelkitError(`Cannot set "${p}".`, 'The path must point at an existing field.');
    const problems = validate('direction', next);
    if (problems.length) throw new ReelkitError(`"${p}=${spec.slice(eq + 1)}" is not allowed:\n  ${problems.slice(0, 4).join('\n  ')}`, 'Nothing was changed.');
    const bad = readabilityProblems(next);
    if (bad.length) throw new ReelkitError(`"${p}" would make text unreadable: ${bad.join('; ')}`, 'Nothing was changed. Pick colours with at least 4.5:1 text contrast.');
    d = next;
    applied.push({ path: p, value });
  }
  const list = (state.adjustments[target] ?? []).filter((a) => !applied.some((n) => n.path === a.path)).concat(applied);
  state.adjustments[target] = list;
  state.selected = target;
  state.revision += 1;
  state.status = 'selected';
  log(state, 'adjusted', target, applied.map((a) => a.path).join(', '));
  writeCanonical(paths(root).state, state);
  return { state, direction: d };
}

function readabilityProblems(d) {
  const out = [];
  for (const theme of ['light', 'dark']) {
    const p = d.palette[theme];
    const c = contrast(p.text, p.canvas);
    if (c < 4.5) out.push(`${theme} text on canvas is ${c.toFixed(1)}:1`);
  }
  return out;
}

// The id is a session alias (an approved direction can be re-selected as "approved"); content is what is hashed.
export const directionHash = (d) => sha256({ ...d, id: undefined });

function isApproved(root, candidates, state) {
  if (!state.approved || !state.selected) return false;
  const approved = loadApprovedSafe(root);
  if (!approved || approved.directionSha256 !== state.approved.directionSha256) return false;
  try {
    return directionHash(effectiveDirection(root, candidates, state, state.selected)) === approved.directionSha256;
  } catch {
    return false;
  }
}

export function status(root) {
  const P = paths(root);
  const state = loadState(root);
  if (!state) return { exists: false };
  const candidates = readFile(P.candidates, 'candidates');
  let profileNow = null;
  try {
    profileNow = sha256(JSON.parse(readFileSync(P.profile, 'utf8')));
  } catch {
    /* profile missing: reported as stale below */
  }
  const previews = readFile(P.previews, 'previews');
  const eff = candidates && state.selected ? directionHash(effectiveDirection(root, candidates, state, state.selected)) : null;
  const previewsFresh = !!(previews && eff && previews.items.some((i) => i.id === state.selected) && previews.items.filter((i) => i.id === state.selected).every((i) => i.directionSha256 === eff) && previews.profileSha256 === state.profileSha256);
  return {
    exists: true,
    status: candidates ? (isApproved(root, candidates, state) ? 'approved' : state.status === 'approved' ? 'selected' : state.status) : state.status,
    selected: state.selected,
    revision: state.revision,
    adjustments: state.adjustments,
    profileStale: !!profileNow && profileNow !== state.profileSha256,
    previewsFresh,
    approvedFile: existsSync(P.approved),
    approvedMatchesSelection: !!candidates && isApproved(root, candidates, state),
    history: state.history,
  };
}

/**
 * Approve the selected direction. `confirmed` must be true (the CLI obtains it from an interactive
 * prompt or an explicit --yes); there is deliberately no path that approves without it.
 */
export function approve(root, { confirmed, acceptLowConfidence = false } = {}) {
  if (confirmed !== true) throw new ReelkitError('Approval needs an explicit confirmation.', 'Review the previews, then run `reelkit direction approve` in a terminal and answer y, or pass --yes.');
  const P = paths(root);
  const candidates = loadCandidates(root);
  const state = mustState(root);
  if (!state.selected) throw new ReelkitError('No direction has been selected.', 'Run `reelkit direction select <id>` after comparing the previews.');
  const st = status(root);
  if (st.profileStale) throw new ReelkitError('The design profile changed since these directions were proposed.', 'Run `reelkit direction propose` again so the directions match the current profile.');
  if (!st.previewsFresh) throw new ReelkitError(`There are no up-to-date previews of "${state.selected}".`, 'Run `reelkit direction preview` (it must show exactly what you are approving, including any adjustments).');
  if (candidates.profile.quality === 'low' && !acceptLowConfidence) {
    throw new ReelkitError('The design profile is low-confidence (uncertain or partial values), so this direction rests on fallbacks.', 'Read `reelkit direction show`, fix the profile if you can, or pass --accept-low-confidence to approve knowingly.');
  }
  let direction = effectiveDirection(root, candidates, state, state.selected);
  if (state.selected === APPROVED_ID) direction = { ...direction, id: loadApproved(root).direction.id };
  const record = {
    schemaVersion: 1,
    kind: KINDS.approved,
    approvedFrom: { id: state.selected, archetype: direction.archetype, profileSha256: state.profileSha256, revision: state.revision, adjustments: state.adjustments[state.selected] ?? [] },
    direction,
    directionSha256: directionHash(direction),
  };
  const problems = validate('approved', record);
  if (problems.length) throw new ReelkitError(`Internal error: approved record failed validation:\n  ${problems.slice(0, 4).join('\n  ')}`, 'This is a reelkit bug.');
  writeCanonical(P.approved, record);
  state.approved = { id: state.selected, revision: state.revision, directionSha256: record.directionSha256 };
  state.status = 'approved';
  log(state, 'approved', state.selected);
  writeCanonical(P.state, state);
  return record;
}
