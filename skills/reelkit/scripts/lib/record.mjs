import { existsSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { NAME } from './brand.mjs';
import { AuthExpiredError, ReelkitError, c, log } from './log.mjs';
import { absoluteUrl, shotsFor } from './config.mjs';
import { extraArgs, launchBrowser, openPage } from './browser.mjs';
import { assertSignedIn } from './auth.mjs';
import { Director } from './actions.mjs';
import { Cursor, installCursor } from './cursor.mjs';
import { stabilizeOnce, waitForCondition, waitForStable } from './stability.mjs';
import { ensureDir, rel } from './fsutil.mjs';
import { saveResult } from './state.mjs';
import { tools } from './deps.mjs';
import { ffmpeg, probe } from './media.mjs';
import { makeGif } from './gif.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function motionBase(scene, shot) {
  return scene.viewports.length * scene.themes.length === 1 ? scene.name : shot.id;
}

export function masterPath(cfg, base) {
  return path.join(cfg.workDir, 'video', `${base}.master.mp4`);
}

/**
 * Screencast frames arrive only when pixels change, so a frame's on-screen time is
 * the gap to the next one. Capping that gap (maxHold) is the dead-time trim.
 */
export function timeline(frames, { maxHold, startHold, endHold, typingDelay = [45, 120] }, events = []) {
  const out = [];
  let clock = 0;
  const typing = events.filter((e) => e.type === 'type' && e.end);
  const typeCap = (typingDelay[0] + typingDelay[1]) / 2000 + 0.02;
  for (let i = 0; i < frames.length; i++) {
    const gap = i < frames.length - 1 ? frames[i + 1].t - frames[i].t : endHold;
    const cap = typing.some((e) => frames[i].t >= e.t && frames[i].t <= e.end) ? typeCap : maxHold;
    let dur = i < frames.length - 1 ? Math.min(gap, cap) : endHold;
    if (i === 0) dur += startHold;
    out.push({ ...frames[i], start: clock, dur: Math.max(dur, 0.001) });
    clock += Math.max(dur, 0.001);
  }
  // Map a wall-clock time to the trimmed timeline (for zoom + QA sampling).
  const map = (t) => {
    let lo = 0;
    for (let i = 0; i < out.length; i++) if (out[i].t <= t) lo = i;
    const f = out[lo];
    return f.start + (lo === 0 ? startHold : 0) + Math.min(Math.max(0, t - f.t), f.dur);
  };
  return { frames: out, duration: clock, map };
}

const smooth = (a, b) => `(st(0,clip((it-${a.toFixed(3)})/${(b - a).toFixed(3)},0,1))*ld(0)*(3-2*ld(0)))`;

/** ffmpeg zoompan expressions that ease toward each click and back out. */
export function zoomFilter(events, { width, height, fps, duration }) {
  const zooms = events.filter((e) => e.type === 'click' && e.zoom > 1);
  if (!zooms.length) return null;
  const parts = [];
  const windows = [];
  for (const [i, e] of zooms.entries()) {
    const next = zooms[i + 1]?.t ?? duration;
    const inStart = Math.max(0, e.t - 0.55);
    const outStart = Math.min(Math.max(e.t + 1.1, inStart + 0.8), next - 0.7, duration - 0.9);
    const outEnd = Math.min(outStart + 0.6, duration);
    if (outStart <= e.t) continue;
    windows.push({ ...e, inStart, outStart, outEnd });
    // envelope: rises over [inStart, t], falls over [outStart, outEnd]
    parts.push(`if(between(it,${inStart.toFixed(3)},${outEnd.toFixed(3)}),${(e.zoom - 1).toFixed(3)}*if(lt(it,${e.t.toFixed(3)}),${smooth(inStart, e.t)},1-${smooth(outStart, outEnd)}),0)`);
  }
  if (!windows.length) return null;
  const z = `1+${parts.join('+')}`;
  const center = (axis) => {
    let expr = axis === 'x' ? 'iw/2' : 'ih/2';
    for (const w of [...windows].reverse()) expr = `if(between(it,${w.inStart.toFixed(3)},${w.outEnd.toFixed(3)}),${axis === 'x' ? w.px : w.py},${expr})`;
    return expr;
  };
  const x = `clip(${center('x')}-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip(${center('y')}-ih/zoom/2,0,ih-ih/zoom)`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps}`;
}

async function assemble(cfg, base, frames, events, dims) {
  const work = ensureDir(path.join(cfg.workDir, 'video'));
  const m = cfg.motion;
  const tl = timeline(frames, m, events);
  const list = tl.frames.map((f) => `file '${f.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\nduration ${f.dur.toFixed(4)}`).join('\n');
  // concat demuxer quirk: the last file must be listed twice for its duration to apply.
  writeFileSync(path.join(work, `${base}.timeline.json`), JSON.stringify({ frames: frames.map((f) => f.t), events }, null, 1));
  const listFile = path.join(work, `${base}.frames.txt`);
  writeFileSync(listFile, `${list}\nfile '${tl.frames.at(-1).file.replace(/\\/g, '/')}'\n`);
  const mapped = events.map((e) => ({ ...e, t: +tl.map(e.t).toFixed(3), ...(e.end ? { end: +tl.map(e.end).toFixed(3) } : {}), px: Math.round(e.x * dims.scale), py: Math.round(e.y * dims.scale) }));
  const even = (n) => n - (n % 2);
  // 1920 wide is plenty for every deliverable; zoom still samples the full-res frames.
  const fit = Math.min(1, 1920 / dims.width);
  const W = even(Math.round(dims.width * fit));
  const H = even(Math.round(dims.height * fit));
  const srcW = even(dims.width);
  const srcH = even(dims.height);
  const raw = path.join(work, `${base}.raw.mp4`);
  const zf = zoomFilter(mapped, { width: W, height: H, fps: m.fps, duration: tl.duration });
  const rawW = zf ? srcW : W;
  const rawH = zf ? srcH : H;
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=${m.fps},scale=${rawW}:${rawH},format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', raw]);
  let current = raw;
  if (zf) {
    const zoomed = path.join(work, `${base}.zoom.mp4`);
    const script = path.join(work, `${base}.zoom.txt`);
    writeFileSync(script, `[0:v]${zf},format=yuv420p[v]`);
    await ffmpeg(['-i', current, '-filter_complex_script', script, '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', zoomed]);
    current = zoomed;
  }
  const master = masterPath(cfg, base);
  if (m.loop && tl.duration > 1.5) {
    // Seamless loop: crossfade the held final state into the very first frame.
    const fade = 0.5;
    await ffmpeg([
      '-i', current,
      '-loop', '1', '-t', String(fade + 0.1), '-i', tl.frames[0].file,
      '-filter_complex', `[1:v]scale=${W}:${H},fps=${m.fps},format=yuv420p,settb=AVTB[first];[0:v]settb=AVTB[main];[main][first]xfade=transition=fade:duration=${fade}:offset=${(tl.duration - fade).toFixed(3)},format=yuv420p[v]`,
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', master,
    ]);
  } else {
    await ffmpeg(['-i', current, '-c', 'copy', master]);
  }
  for (const f of [raw, path.join(work, `${base}.zoom.mp4`)]) if (f !== master) rmSync(f, { force: true });
  return { master, events: mapped, zoomed: !!zf, duration: probe(master)?.duration ?? tl.duration, width: W, height: H };
}

/** Deliverables from a master: small H.264 MP4, WebM, and a budgeted GIF. */
export async function encodeOutputs(cfg, master, base, { wantGif, wantMp4, zoomed = false }) {
  const out = [];
  const t = tools();
  const maxW = 1920;
  const scale = `scale='min(${maxW},iw)':-2:flags=lanczos`;
  if (wantMp4 || wantGif) {
    if (t.ffmpeg.x264) {
      const mp4 = path.join(cfg.outDir, `${base}.mp4`);
      await ffmpeg(['-i', master, '-vf', `${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-tune', 'animation', '-movflags', '+faststart', '-an', mp4]);
      out.push({ file: mp4, kind: 'mp4' });
    }
    if (t.ffmpeg.vp9) {
      const webm = path.join(cfg.outDir, `${base}.webm`);
      await ffmpeg(['-i', master, '-vf', scale, '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-an', webm]);
      out.push({ file: webm, kind: 'webm' });
    }
  }
  if (wantGif) {
    const gif = path.join(cfg.outDir, `${base}.gif`);
    const g = await makeGif(master, gif, cfg.gif, path.join(cfg.workDir, 'video'), { zoomed });
    out.push({ file: gif, kind: 'gif', gif: g });
  }
  return out;
}

const browsers = new Map();
async function recordingBrowser(dsf) {
  // Headless screencast only returns device-scale frames when the scale is forced at launch.
  if (!browsers.has(dsf)) {
    const args = [`--force-device-scale-factor=${dsf}`, '--hide-scrollbars', '--font-render-hinting=none', '--force-color-profile=srgb', ...extraArgs()];
    browsers.set(dsf, await chromium.launch({ args }).catch(() => launchBrowser()));
  }
  return browsers.get(dsf);
}

async function recordOne(cfg, shot, base) {
  const scene = shot.scene;
  const browser = await recordingBrowser(shot.viewport.deviceScaleFactor);
  const frameDir = path.join(cfg.workDir, 'frames', base);
  rmSync(frameDir, { recursive: true, force: true });
  ensureDir(frameDir);
  const { context, page, net } = await openPage(browser, cfg, shot, { motion: true });
  const cursorId = `${NAME}${Math.random().toString(36).slice(2, 7)}`;
  if (cfg.motion.cursor) await installCursor(context, { id: cursorId, accent: cfg.frame.accent });
  const cursor = cfg.motion.cursor ? new Cursor(page, cursorId, cfg.motion.cursorSpeed) : null;
  const director = new Director(page, { scene, cfg, absoluteUrl: (u) => absoluteUrl(cfg, u), cursor, net, seed: cfg.determinism.seed });
  let cdp;
  try {
    const res = await page.goto(absoluteUrl(cfg, scene.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await assertSignedIn(page, cfg, scene, res?.status());
    await waitForCondition(page, scene.waitFor, scene.stability.timeout);
    // The first frame must be as clean as any still.
    const stable = await waitForStable(page, net, scene.stability, {
      onRetry: (n, err) => log.warn(`${base}: start frame not stable (${err.gate}: ${err.reason}); retry ${n}`),
    });
    await assertSignedIn(page, cfg, scene, net.mainStatus);
    if (!stable.ok) return { ok: false, reason: `start frame never stable: ${stable.gate}: ${stable.reason}`, attempts: stable.attempts };
    const vp = shot.viewport;
    if (cursor) await cursor.place(Math.round(vp.width * 0.62), Math.round(vp.height * 0.7));
    await sleep(150);

    const frames = [];
    let lastHash = null;
    let pending = Promise.resolve();
    cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (f.data === lastHash) return; // identical pixels: extend the previous frame instead
      lastHash = f.data;
      const file = path.join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
      frames.push({ t: f.metadata.timestamp, file });
      const buf = Buffer.from(f.data, 'base64');
      pending = pending.then(() => import('node:fs/promises').then((fs) => fs.writeFile(file, buf)));
    });
    const dsf = vp.deviceScaleFactor;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: vp.width * dsf, maxHeight: vp.height * dsf, everyNthFrame: 1 });
    // Nudge a repaint so the first frame arrives immediately.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    await sleep(300);
    await director.run(scene.actions);
    // Let the final state settle completely before the end hold.
    await stabilizeOnce(page, net, scene.stability, { budget: 8000, lazy: false }).catch(() => {});
    await assertSignedIn(page, cfg, scene, net.mainStatus);
    await sleep(250);
    await cdp.send('Page.stopScreencast');
    await pending;
    if (frames.length < 2) return { ok: false, reason: 'screencast produced no frames' };
    return { ok: true, frames, events: director.events, scale: dsf, width: vp.width * dsf, height: vp.height * dsf, retries: stable.attempts.length - 1 };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function record(cfg, scenes, _opts = {}) {
  const jobs = scenes.filter((s) => s.isMotion).flatMap((scene) => shotsFor(scene).map((shot) => ({ shot, base: motionBase(scene, shot) })));
  if (!jobs.length) return { total: 0, failed: 0 };
  if (!tools().ffmpeg) throw new ReelkitError('ffmpeg is required for recordings.', 'Run `reelkit preflight` for the install command.');
  log.step(`Recording ${jobs.length} flow(s)…`);
  let failed = 0;
  try {
    for (const { shot, base } of jobs) {
      const scene = shot.scene;
      const wantGif = scene.outputs.includes('gif');
      const wantMp4 = scene.outputs.includes('mp4');
      const names = [wantMp4 || wantGif ? `${base}.mp4` : null, wantMp4 || wantGif ? `${base}.webm` : null, wantGif ? `${base}.gif` : null].filter(Boolean);
      for (const n of names) rmSync(path.join(cfg.outDir, n), { force: true });
      const meta = { scene: scene.name, viewport: shot.viewport.name, theme: shot.theme, source: absoluteUrl(cfg, scene.url) };
      const t0 = Date.now();
      try {
        const rec = await recordOne(cfg, shot, base);
        if (!rec.ok) {
          failed++;
          for (const n of names) saveResult(cfg, n, { ...meta, kind: path.extname(n).slice(1), status: 'FAILED', reason: rec.reason, attempts: rec.attempts });
          log.fail(`${base}: FAILED: ${rec.reason}`);
          continue;
        }
        const asm = await assemble(cfg, base, rec.frames, rec.events, { width: rec.width, height: rec.height, scale: rec.scale });
        ensureDir(cfg.outDir);
        const outs = await encodeOutputs(cfg, asm.master, base, { wantGif, wantMp4, zoomed: asm.zoomed });
        for (const o of outs) {
          const name = rel(cfg.outDir, o.file);
          const p = probe(o.file);
          const status = o.kind === 'gif' && !o.gif.underBudget ? 'FAILED' : 'PASS';
          saveResult(cfg, name, {
            ...meta,
            kind: o.kind,
            status,
            reason: status === 'FAILED' ? `GIF over budget (${(o.gif.bytes / 1e6).toFixed(1)} MB)` : undefined,
            duration: asm.duration,
            width: p?.width,
            height: p?.height,
            events: asm.events,
            retries: rec.retries,
            master: rel(cfg.root, asm.master),
            gif: o.gif?.settings,
          });
          const size = `${(statSync(o.file).size / 1e6).toFixed(2)} MB`;
          log.ok(`${rel(cfg.root, o.file)} ${c.dim(`${p?.width}×${p?.height} · ${asm.duration.toFixed(1)}s · ${size}${o.gif ? ` · ${o.gif.encoder} ${o.gif.settings.width}px@${o.gif.settings.fps}fps` : ''}`)}`);
        }
        log.dim(`    ${rec.frames.length} unique frames, ${asm.events.length} interactions, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        failed++;
        const reason = err instanceof ReelkitError ? err.message : `error: ${err.message.split('\n')[0]}`;
        for (const n of names) saveResult(cfg, n, { ...meta, kind: path.extname(n).slice(1), status: 'FAILED', reason });
        log.fail(`${base}: FAILED: ${reason}`);
        if (err.fix) log.dim(`  fix: ${err.fix}`);
      }
    }
  } finally {
    for (const b of browsers.values()) await b.close().catch(() => {});
    browsers.clear();
  }
  return { total: jobs.length, failed };
}
