// `reelkit design inspect`: renders representative routes (light/dark × desktop/mobile), measures the
// design as rendered, scans declared design sources, and writes design-profile.{json,md}.
import { existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SKILL_DIR } from '../brand.mjs';
import { AuthExpiredError, ReelkitError, c, log } from '../log.mjs';
import { absoluteUrl, resolveBaseUrl, resolveViewport, selectScenes } from '../config.mjs';
import { openPage } from '../browser.mjs';
import { assertSignedIn } from '../auth.mjs';
import { waitForCondition, waitForStable } from '../stability.mjs';
import { pool } from '../shoot.mjs';
import { ensureDir, rel, writeJson } from '../fsutil.mjs';
import { designProbe } from './probe.mjs';
import { colorCensus } from './pixels.mjs';
import { scanProject } from './source.mjs';
import { buildProfile, profileMarkdown, validateProfile } from './profile.mjs';

const routeKey = (scene) => scene.url;

/** One representative scene per distinct URL, in config order. */
function routesFrom(scenes, limit) {
  const seen = new Map();
  for (const s of scenes) if (!seen.has(routeKey(s))) seen.set(routeKey(s), s);
  return [...seen.values()].slice(0, limit);
}

async function observe(browser, cfg, scene, viewportName, theme) {
  const viewport = resolveViewport(viewportName, cfg);
  // Inspection never runs a scene's actions (flows); it looks at the page as it loads.
  const shot = { scene: { ...scene, actions: [] }, viewport, theme, id: `${scene.name}-${viewportName}-${theme}` };
  const { context, page, net } = await openPage(browser, cfg, shot);
  try {
    const res = await page.goto(absoluteUrl(cfg, scene.url), { waitUntil: 'domcontentloaded', timeout: Math.max(30000, scene.stability.timeout) });
    if (res && res.status() >= 400 && !scene.auth) throw new ReelkitError(`HTTP ${res.status()}`);
    await assertSignedIn(page, cfg, scene, res?.status() ?? net.mainStatus);
    await waitForCondition(page, scene.waitFor, scene.stability.timeout).catch(() => {});
    const stable = await waitForStable(page, net, { ...scene.stability, retries: Math.min(2, scene.stability.retries) });
    if (!stable.ok) return { error: `page never stabilised (${stable.gate}: ${stable.reason}); not measured, to avoid recording loading states` };
    const probe = await page.evaluate(designProbe, {});
    const census = colorCensus(await page.screenshot({ scale: 'css', animations: 'disabled', caret: 'hide' }));
    let manifest = null;
    if (probe.assets.manifest && new URL(probe.assets.manifest).origin === new URL(page.url()).origin) {
      manifest = await page
        .evaluate(async (u) => {
          const r = await fetch(u, { credentials: 'same-origin' });
          if (!r.ok) return null;
          const m = await r.json();
          return { name: m.name ?? null, theme_color: m.theme_color ?? null, background_color: m.background_color ?? null };
        }, probe.assets.manifest)
        .catch(() => null);
    }
    return { probe, census, manifest };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Keep logo SVG markup as files (only from the inspected site, never fetched elsewhere). */
function saveLogos(observations, outDir) {
  const out = [];
  const seen = new Set();
  for (const o of observations) {
    for (const logo of o.probe.assets.logos) {
      const key = logo.markup ? createHash('sha256').update(logo.markup).digest('hex').slice(0, 12) : logo.src;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const entry = { kind: logo.kind, element: logo.el, width: logo.width, height: logo.height, route: o.route, colors: (logo.colors ?? []).map((c) => '#' + c.split(',').map((v) => (+v).toString(16).padStart(2, '0')).join('')).sort(), basis: 'observed' };
      if (logo.markup) {
        const file = path.join(ensureDir(path.join(outDir, 'assets')), `logo-${key}.svg`);
        writeFileSync(file, logo.markup);
        entry.file = `assets/${path.basename(file)}`;
      } else entry.src = logo.src;
      out.push(entry);
    }
  }
  return out.sort((a, b) => `${a.route}${a.element}`.localeCompare(`${b.route}${b.element}`)).slice(0, 4);
}

export async function inspectDesign(cfg, { browser, only = [], outDir, sourceRoot, maxRoutes = 6, viewports = ['desktop', 'mobile'], themes = ['light', 'dark'] } = {}) {
  resolveBaseUrl(cfg); // fail fast on a bad baseUrl
  const scenes = routesFrom(selectScenes(cfg, only), maxRoutes);
  const out = ensureDir(outDir ?? path.join(cfg.workDir, 'design'));
  log.step(`Inspecting ${scenes.length} route(s) × ${themes.length} theme(s) × ${viewports.length} viewport(s)…`);

  const jobs = [];
  for (const scene of scenes) for (const theme of themes) for (const vp of viewports) jobs.push({ scene, theme, vp });
  const routeState = new Map(scenes.map((s) => [s.url, { url: s.url, status: 'ok', themes: new Set(), viewports: new Set() }]));
  const observations = [];
  const hasSession = existsSync(cfg.authFile);

  await pool(jobs, cfg.concurrency, async ({ scene, theme, vp }) => {
    const state = routeState.get(scene.url);
    if (scene.auth && !hasSession) {
      state.status = 'auth required';
      state.reason = 'needs a saved session; run `reelkit auth`';
      return;
    }
    try {
      const res = await observe(browser, cfg, scene, vp, theme);
      if (res.error) {
        if (state.status === 'ok') {
          state.status = 'partial';
          state.reason = res.error;
        }
        return;
      }
      observations.push({ route: scene.url, theme, viewport: vp, ...res });
      state.themes.add(theme);
      state.viewports.add(vp);
      log.dim(`    ${scene.url} ${theme}/${vp} ✓`);
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        state.status = 'auth expired';
        state.reason = 'session expired or missing; run `reelkit auth`';
      } else {
        state.status = observations.some((o) => o.route === scene.url) ? 'partial' : 'unreachable';
        state.reason = (err.message || String(err)).split('\n')[0].slice(0, 160);
      }
    }
  });

  // Stable order regardless of concurrency.
  observations.sort((a, b) => `${a.route}|${a.theme}|${a.viewport}`.localeCompare(`${b.route}|${b.theme}|${b.viewport}`));
  const routes = [...routeState.values()].map((r) => ({
    url: r.url,
    status: r.status === 'ok' && !r.themes.size ? 'not measured' : r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    themes: [...r.themes].sort(),
    viewports: [...r.viewports].sort(),
  }));

  // Declared sources: the project's own files, never Reelkit's.
  let declared = { files: [], docs: [], colors: [], fonts: [], designSystems: [], manifests: [] };
  const srcRoot = sourceRoot === false ? null : sourceRoot ?? null;
  if (srcRoot) {
    if (!existsSync(srcRoot)) throw new ReelkitError(`--source ${srcRoot} does not exist.`, 'Point --source at the app\'s source folder, or omit it.');
    declared = scanProject(srcRoot, { exclude: [SKILL_DIR, cfg.outDir, cfg.workDir, out] });
  }

  const savedLogos = saveLogos(observations, out);
  const profile = buildProfile({ cfg, baseUrl: resolveBaseUrl(cfg), routes, observations, declared, savedLogos, sourceRoot: srcRoot ? rel(cfg.root, srcRoot) || '.' : null });
  const check = validateProfile(profile);
  if (!check.ok) throw new ReelkitError(`Generated design profile failed schema validation: ${check.errors.slice(0, 3).join('; ')}`, 'This is a reelkit bug; please report it with the command you ran.');
  const jsonFile = path.join(out, 'design-profile.json');
  const mdFile = path.join(out, 'design-profile.md');
  writeJson(jsonFile, profile);
  writeFileSync(mdFile, profileMarkdown(profile));

  const primary = profile.palette.light?.roles.primary;
  log.ok(`Design profile: ${rel(cfg.root, mdFile)} and ${path.basename(jsonFile)} (${profile.coverage.status})`);
  log.info(`  ${c.dim(profile.summary.value)}`);
  if (primary) log.info(`  brand colour: ${primary.value ?? 'not observed'}${primary.value ? ` (${primary.basis}, ${primary.level} confidence)` : ` (${primary.reason})`}`);
  if (profile.conflicts.length) log.warn(`${profile.conflicts.length} conflict(s) between the rendered site and declared sources; see the profile.`);
  if (profile.unverified.length) log.info(c.dim(`  ${profile.unverified.length} item(s) could not be verified; listed in the profile.`));
  return { profile, jsonFile, mdFile };
}
