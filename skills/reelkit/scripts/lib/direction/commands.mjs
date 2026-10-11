// `reelkit direction <profile|propose|preview|show|select|adjust|approve|status>`
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { c, log, ReelkitError } from '../log.mjs';
import { findConfig, loadConfig } from '../config.mjs';
import { NAME } from '../brand.mjs';
import { APPROVED_ID, adjust, approve, directionHash, effectiveDirection, loadApproved, loadCandidates, loadProfile, loadState, propose, select, status } from './flow.mjs';
import { renderPreviews, writeCompareSheet } from './preview.mjs';
import { paths, readFile } from './store.mjs';

const SUBS = ['profile', 'propose', 'preview', 'show', 'select', 'adjust', 'approve', 'status'];
const pct = (v) => `${Math.round(v * 100)}%`;

function projectRoot(args) {
  if (args.root) return path.resolve(args.root);
  try {
    return path.dirname(findConfig(args.config));
  } catch {
    return process.cwd();
  }
}

function describe(d) {
  const comp = d.composition;
  return [
    `${c.bold(d.name)} ${c.dim(`(${d.id})`)}`,
    `  ${d.rationale}`,
    `  layout   single ${comp.single.family} (${pct(comp.single.deviceScale)} wide) · social ${comp.social.family} · trio ${comp.trio.family}`,
    `  palette  ${d.palette.light.canvas} canvas · ${d.palette.light.text} text · ${d.palette.light.accent} accent · background ${d.palette.background.kind} · accent as ${d.palette.accentUse}`,
    `  type     ${d.typography.voice} ${d.typography.weight}${d.typography.brandFont ? ` (site heading font "${d.typography.brandFont.family}" recorded, not embedded)` : ''}`,
    `  depth    ${d.depth.shadow}${d.depth.ring ? ` + ${d.depth.ring.px}px ring` : ''} · radius ${d.depth.radius}px`,
    `  motion   cursor ${d.motion.cursor} · ripple ${d.motion.ripple.style} (${d.motion.ripple.color}) · zoom ${d.motion.zoom} · ${d.motion.pacing}`,
    ...d.basis.fallbacks.map((f) => `  ${c.yellow('fallback')} ${f.path}: ${f.reason} → ${f.used}`),
    ...[...new Set(d.basis.warnings)].map((w) => `  ${c.yellow('warning')}  ${w}`),
  ].join('\n');
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function runDirection(sub, args, { withBrowser }) {
  if (!SUBS.includes(sub)) throw new ReelkitError(sub ? `Unknown direction command "${sub}".` : 'direction needs a command.', `Use one of: ${SUBS.join(', ')}. Workflow: ${NAME} design → direction propose → preview → select → approve.`);
  const root = projectRoot(args);
  const P = paths(root);

  if (sub === 'profile') {
    const p = loadProfile(root, args.profile);
    if (args.json) return console.log(JSON.stringify(p.summary, null, 2));
    const col = p.tokens.colors;
    log.info(`${c.bold('Design profile')} ${p.site.name || p.site.url}  ${c.dim(args.profile ?? path.relative(process.cwd(), P.profile))}`);
    log.info(`  overall confidence ${p.summary.level} (${pct(p.summary.overallConfidence)}) · ${p.summary.conflicts} conflict(s) · ${p.summary.missing} value(s) not found`);
    log.info(`  brand ${col.primary.value?.hex ?? 'not established'} (${col.primary.level}${col.primary.basis ? `, ${col.primary.basis}` : ''}) · background ${col.background.value?.hex ?? '—'} · text ${col.text.value?.hex ?? '—'} · heading font ${p.tokens.typography.heading.value?.family ?? '—'}`);
    for (const w of p.summary.warnings ?? []) log.warn(w);
    log.info(c.dim(`  full report: ${path.relative(process.cwd(), P.profileMd)}`));
    return;
  }

  if (sub === 'propose') {
    const { candidates } = propose(root, { profilePath: args.profile });
    log.ok(`Three directions written to ${path.relative(process.cwd(), P.candidates)}`);
    log.info(`  profile confidence ${candidates.profile.level} (${pct(candidates.profile.overallConfidence)}) · quality ${candidates.profile.quality} · differ on ≥ ${candidates.distinctness.minDifferingAxes} of ${candidates.distinctness.axes.length} axes`);
    for (const d of candidates.directions) log.info(`\n${describe(d)}`);
    log.info(`\nNext: ${c.bold(`${NAME} direction preview`)} (renders all three from the same screenshot), then ${c.bold('select')} and ${c.bold('approve')}.`);
    return;
  }

  const candidates = loadCandidates(root);
  const state = loadState(root);

  if (sub === 'preview') {
    const cfg = loadConfig(args.config);
    const ids = args._[2] ? [args._[2]] : args.only.length ? args.only.flatMap((o) => o.split(',')) : undefined;
    const list = candidates.directions.map((d) => effectiveDirection(root, candidates, state, d.id));
    if (state.selected === APPROVED_ID || ids?.includes(APPROVED_ID)) list.push(effectiveDirection(root, candidates, state, APPROVED_ID));
    for (const id of ids ?? []) if (!list.some((d) => d.id === id)) throw new ReelkitError(`Unknown direction "${id}".`, `Available: ${list.map((d) => d.id).join(', ')}`);
    const manifest = await withBrowser((browser) => renderPreviews({ root, cfg, browser, directions: list, profileSha: state.profileSha256, scene: args.scene, theme: args.theme, onlyIds: ids }));
    const sheet = writeCompareSheet({ root, directions: list, manifest, status: status(root).status, profile: loadProfile(root, args.profile) });
    log.ok(`${manifest.items.length} preview(s) from ${manifest.source.file} → ${path.relative(process.cwd(), P.previewsDir)}/`);
    for (const s of manifest.skipped) log.warn(`${s.kind}: ${s.reason}`);
    log.info(`  compare side by side: ${path.relative(process.cwd(), sheet)}`);
    return;
  }

  if (sub === 'show') {
    const id = args._[2] ?? state?.selected;
    if (!id) {
      for (const d of candidates.directions) log.info(`\n${describe(effectiveDirection(root, candidates, state, d.id))}`);
      return;
    }
    const d = effectiveDirection(root, candidates, state, id);
    if (args.json) return console.log(JSON.stringify(d, null, 2));
    log.info(describe(d));
    const st = status(root);
    log.info(c.dim(`  status ${st.status}${st.profileStale ? ' · PROFILE CHANGED since proposal (run propose again)' : ''} · previews ${st.previewsFresh ? 'up to date' : 'missing or stale'}`));
    return;
  }

  if (sub === 'select') {
    const id = args._[2];
    if (!id) throw new ReelkitError('select needs a direction id.', `Available: ${candidates.directions.map((d) => d.id).join(', ')}${existsSync(P.approved) ? `, ${APPROVED_ID}` : ''}`);
    select(root, id);
    log.ok(`Selected "${id}". Not approved yet: review the previews, adjust if needed, then run \`${NAME} direction approve\`.`);
    return;
  }

  if (sub === 'adjust') {
    const hasId = args._[2] && !args._[2].includes('=');
    const { direction } = adjust(root, hasId ? args._[2] : undefined, args.set);
    log.ok(`Adjusted "${direction.id}" (revision ${loadState(root).revision}). Previews are now out of date: run \`${NAME} direction preview\`, then approve.`);
    return;
  }

  if (sub === 'status') {
    const st = status(root);
    if (args.json) return console.log(JSON.stringify(st, null, 2));
    log.info(`status ${c.bold(st.status)} · selected ${st.selected ?? '—'} · revision ${st.revision} · previews ${st.previewsFresh ? 'up to date' : 'missing or stale'}${st.profileStale ? ' · profile changed since proposal' : ''}${st.approvedFile ? ` · ${path.basename(P.approved)} present` : ''}`);
    for (const h of st.history.slice(-5)) log.dim(`  ${h.at} ${h.event}${h.id ? ` ${h.id}` : ''}${h.note ? ` (${h.note})` : ''}`);
    return;
  }

  // approve
  if (!state?.selected) throw new ReelkitError('No direction has been selected.', `Run \`${NAME} direction select <id>\` after comparing the previews.`);
  const eff = effectiveDirection(root, candidates, state, state.selected);
  log.info(describe(eff));
  let confirmed = !!args.yes;
  if (!confirmed) confirmed = await confirm(`Approve "${eff.name}" (${state.selected}) and write ${path.basename(P.approved)}?`);
  const record = approve(root, { confirmed, acceptLowConfidence: !!args.acceptLowConfidence });
  log.ok(`Approved. Saved to ${path.relative(process.cwd(), P.approved)} (${record.directionSha256.slice(0, 12)}). Commit it to reuse the direction.`);
  log.dim('  Full-media generation does not read it yet (Phase 3); today it only records the decision.');
}
