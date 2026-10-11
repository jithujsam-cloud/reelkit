import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AuthExpiredError, ReelkitError, c, log } from './log.mjs';
import { absoluteUrl, shotsFor } from './config.mjs';
import { openPage } from './browser.mjs';
import { assertSignedIn } from './auth.mjs';
import { Director } from './actions.mjs';
import { waitForCondition, waitForStable } from './stability.mjs';
import { inspectPng } from './imagecheck.mjs';
import { ensureDir, rel } from './fsutil.mjs';
import { saveResult } from './state.mjs';

/** Run tasks with a concurrency limit; an AuthExpiredError aborts everything. */
export async function pool(items, limit, fn) {
  const results = [];
  let i = 0;
  let fatal = null;
  const worker = async () => {
    while (i < items.length && !fatal) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        fatal = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (fatal) throw fatal;
  return results;
}

export function stillName(shot, full = false) {
  return `${shot.id}${full ? '-full' : ''}.png`;
}

async function resolveScrollY(page, scrollTo) {
  if (scrollTo === undefined || scrollTo === null) return 0;
  if (typeof scrollTo === 'number') return scrollTo;
  const y = await page
    .locator(scrollTo)
    .first()
    .evaluate((el) => Math.max(0, el.getBoundingClientRect().top + window.scrollY - 24))
    .catch(() => null);
  if (y === null) throw new ReelkitError(`scrollTo selector ${scrollTo} not found.`, 'Fix scene.scrollTo.');
  return y;
}

/** Navigate, check auth, wait for the scene's condition and run its actions. */
export async function prepareScene(page, net, cfg, shot, director) {
  const scene = shot.scene;
  const res = await page.goto(absoluteUrl(cfg, scene.url), { waitUntil: 'domcontentloaded', timeout: Math.max(30000, scene.stability.timeout) });
  await assertSignedIn(page, cfg, scene, res?.status() ?? net.mainStatus);
  try {
    await waitForCondition(page, scene.waitFor, scene.stability.timeout);
  } catch {
    // The page may have bounced to a login screen client-side; prefer that diagnosis.
    await assertSignedIn(page, cfg, scene, net.mainStatus);
    throw new ReelkitError(`Scene "${scene.name}": waitFor ${JSON.stringify(scene.waitFor)} never became visible.`, 'Fix scene.waitFor or check that the page renders that content.');
  }
  await director.run(scene.actions);
}

async function shootOne(browser, cfg, shot) {
  const scene = shot.scene;
  const files = [];
  const wantStill = scene.outputs.includes('still') || scene.outputs.includes('framed');
  const wantFull = scene.outputs.includes('fullpage');
  if (wantStill) files.push(path.join(cfg.outDir, stillName(shot)));
  if (wantFull) files.push(path.join(cfg.outDir, stillName(shot, true)));
  // Never leave a stale image behind that could be mistaken for a fresh, verified one.
  for (const f of files) if (existsSync(f)) rmSync(f);

  const t0 = Date.now();
  const { context, page, net } = await openPage(browser, cfg, shot);
  const base = { scene: scene.name, viewport: shot.viewport.name, theme: shot.theme, kind: 'still', source: absoluteUrl(cfg, scene.url) };
  try {
    const director = new Director(page, { scene, cfg, absoluteUrl: (u) => absoluteUrl(cfg, u), net, seed: cfg.determinism.seed });
    await prepareScene(page, net, cfg, shot, director);
    const scrollY = await resolveScrollY(page, scene.scrollTo);
    let retries = 0;
    const stable = await waitForStable(page, net, scene.stability, {
      scrollY,
      onRetry: (n, err) => {
        retries = n;
        log.warn(`${shot.id}: not stable yet (${err.gate}: ${err.reason}); retry ${n}/${scene.stability.retries - 1}`);
      },
      reload: async () => {
        await prepareScene(page, net, cfg, shot, director);
      },
    });
    await assertSignedIn(page, cfg, scene, net.mainStatus);
    if (!stable.ok) {
      for (const f of files) saveResult(cfg, rel(cfg.outDir, f), { ...base, status: 'FAILED', reason: `${stable.gate}: ${stable.reason}`, attempts: stable.attempts, retries });
      log.fail(`${shot.id}: FAILED after ${stable.attempts.length} attempts: ${stable.gate}: ${stable.reason}`);
      return { ok: false };
    }
    ensureDir(cfg.outDir);
    for (const f of files) {
      const full = f.endsWith('-full.png');
      await page.screenshot({ path: f, fullPage: full, caret: 'hide', animations: 'disabled', scale: 'device' });
      const img = inspectPng(f);
      const status = img.problems.length ? 'FAILED' : 'PASS';
      saveResult(cfg, rel(cfg.outDir, f), {
        ...base,
        kind: full ? 'fullpage' : 'still',
        status,
        reason: img.problems.join('; ') || undefined,
        checks: stable.checks,
        attempts: stable.attempts,
        retries,
        image: img,
      });
      const ms = ((Date.now() - t0) / 1000).toFixed(1);
      if (status === 'PASS') log.ok(`${rel(cfg.root, f)} ${c.dim(`${img.width}×${img.height} · stable in ${ms}s${retries ? ` · ${retries} retr${retries > 1 ? 'ies' : 'y'}` : ''}`)}`);
      else log.fail(`${rel(cfg.root, f)}: FAILED (${img.problems.join('; ')})`);
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthExpiredError) throw err;
    const reason = err instanceof ReelkitError ? err.message : `error: ${err.message.split('\n')[0]}`;
    for (const f of files) saveResult(cfg, rel(cfg.outDir, f), { ...base, status: 'FAILED', reason });
    log.fail(`${shot.id}: FAILED: ${reason}`);
    if (err instanceof ReelkitError && err.fix) log.dim(`  fix: ${err.fix}`);
    return { ok: false };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function shoot(cfg, scenes, { browser }) {
  const shots = scenes.filter((s) => s.isStill).flatMap(shotsFor);
  if (!shots.length) return { total: 0, failed: 0 };
  log.step(`Shooting ${shots.length} still(s)…`);
  const results = await pool(shots, cfg.concurrency, (shot) => shootOne(browser, cfg, shot));
  return { total: shots.length, failed: results.filter((r) => !r.ok).length };
}
