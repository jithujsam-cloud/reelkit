import { readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { log } from './log.mjs';
import { ensureDir } from './fsutil.mjs';
import { tools } from './deps.mjs';
import { ffmpeg, run } from './media.mjs';

/** Settings to try, best first, until the GIF fits the byte budget. */
function ladder({ width, fps, quality }) {
  const steps = [];
  const widths = [width, Math.round(width * 0.85), Math.round(width * 0.72), 640, 560, 480].filter((w, i, a) => w <= width && a.indexOf(w) === i);
  const fpss = [fps, Math.min(fps, 12), 10, 8].filter((f, i, a) => f <= fps && a.indexOf(f) === i);
  for (const w of widths) {
    for (const f of fpss) {
      steps.push({ width: w, fps: f, quality });
      if (quality > 70) steps.push({ width: w, fps: f, quality: 70 });
    }
  }
  return steps;
}

async function encodeGifski(input, out, s, work) {
  const dir = ensureDir(path.join(work, `gif-${s.width}-${s.fps}`));
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  await ffmpeg(['-i', input, '-vf', `fps=${s.fps},scale=${s.width}:-2:flags=lanczos`, path.join(dir, 'f%05d.png')]);
  const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(dir, f));
  await run(tools().gifski.path, ['--quiet', '--fps', String(s.fps), '--quality', String(s.quality), '--width', String(s.width), '-o', out, ...frames]);
  rmSync(dir, { recursive: true, force: true });
}

async function encodeFfmpeg(input, out, s) {
  const colors = s.quality >= 80 ? 256 : s.quality >= 60 ? 192 : 128;
  await ffmpeg([
    '-i', input,
    '-filter_complex', `fps=${s.fps},scale=${s.width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
    '-loop', '0', out,
  ]);
}

/**
 * Encode a GIF under cfg.maxBytes, stepping down fps/width/quality as needed.
 * Returns { bytes, settings, underBudget, encoder }.
 */
export async function makeGif(input, out, gifCfg, work, { zoomed = false } = {}) {
  // gifski reuses pixels across frames; when zoom moves every pixel that leaves faint ghost
  // trails, so "auto" switches to ffmpeg's palette encoder for zoomed recordings.
  const wanted = gifCfg.encoder ?? 'auto';
  const encoder = wanted === 'ffmpeg' || !tools().gifski || (wanted === 'auto' && zoomed) ? 'ffmpeg' : 'gifski';
  const tmp = `${out}.tmp.gif`;
  let best = null;
  for (const s of ladder(gifCfg)) {
    if (encoder === 'gifski') await encodeGifski(input, tmp, s, work);
    else await encodeFfmpeg(input, tmp, s);
    const bytes = statSync(tmp).size;
    if (!best || bytes < best.bytes) {
      copyFileSync(tmp, out);
      best = { bytes, settings: s };
    }
    if (bytes <= gifCfg.maxBytes) break;
    log.dim(`    gif ${s.width}px ${s.fps}fps q${s.quality}: ${(bytes / 1e6).toFixed(1)} MB > budget, stepping down`);
  }
  rmSync(tmp, { force: true });
  const underBudget = best.bytes <= gifCfg.maxBytes;
  if (!underBudget) {
    log.warn(`${path.basename(out)} is ${(best.bytes / 1e6).toFixed(1)} MB even at ${best.settings.width}px/${best.settings.fps}fps. Shorten the flow or use the MP4 in the README.`);
  }
  return { ...best, underBudget, encoder };
}
