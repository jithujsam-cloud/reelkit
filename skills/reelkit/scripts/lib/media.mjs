import { spawn, spawnSync } from 'node:child_process';
import { ReelkitError } from './log.mjs';
import { requireFfmpeg } from './deps.mjs';

/** Run ffmpeg (or ffprobe) and reject with the tail of stderr on failure. */
export function ffmpeg(args, { bin } = {}) {
  const exe = bin ?? requireFfmpeg().path;
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new ReelkitError(`ffmpeg failed: ${err.trim().split('\n').slice(-3).join(' | ')}`, 'Re-run with a full ffmpeg build (libx264, libvpx).'))));
  });
}

export function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.trim().slice(-300)}`))));
  });
}

export function probe(file) {
  const ff = requireFfmpeg();
  const bin = ff.ffprobe ?? 'ffprobe';
  const r = spawnSync(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v) return null;
  const [n, d] = (v.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    codec: v.codec_name,
    width: v.width,
    height: v.height,
    duration: Number(j.format.duration ?? v.duration ?? 0),
    fps: d ? n / d : 0,
    frames: Number(v.nb_frames || 0),
    pixFmt: v.pix_fmt,
  };
}

/** Full decode pass: proves the file actually plays end to end. */
export async function decodes(file) {
  try {
    await ffmpeg(['-i', file, '-f', 'null', '-']);
    return true;
  } catch {
    return false;
  }
}

export async function extractFrame(file, seconds, out, width) {
  const vf = width ? ['-vf', `scale=${width}:-2:flags=lanczos`] : [];
  const ss = String(Math.max(0, seconds));
  // GIFs store frames as transparent deltas: decode from the start (output seek) or frames ghost.
  const args = file.endsWith('.gif') ? ['-i', file, '-ss', ss] : ['-ss', ss, '-i', file];
  await ffmpeg([...args, '-frames:v', '1', ...vf, out]);
}
