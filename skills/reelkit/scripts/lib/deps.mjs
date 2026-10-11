import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ENV_PREFIX, SKILL_DIR } from './brand.mjs';
import { ReelkitError, log } from './log.mjs';

const isWin = process.platform === 'win32';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return r.error ? null : r;
}

function hint(tool) {
  const map = {
    ffmpeg: { darwin: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg  (or dnf/pacman)', win32: 'winget install Gyan.FFmpeg' },
    gifski: { darwin: 'brew install gifski', linux: 'cargo install gifski  (or your package manager)', win32: 'winget install gifski' },
  };
  return map[tool]?.[process.platform] ?? map[tool]?.linux;
}

function findFfmpeg() {
  const explicit = process.env[`${ENV_PREFIX}_FFMPEG`];
  for (const cmd of [explicit, 'ffmpeg'].filter(Boolean)) {
    const r = run(cmd, ['-hide_banner', '-version']);
    if (r && r.status === 0) {
      const enc = run(cmd, ['-hide_banner', '-encoders'])?.stdout ?? '';
      const probe = explicit ? path.join(path.dirname(explicit), isWin ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe';
      return {
        path: cmd,
        ffprobe: run(probe, ['-version'])?.status === 0 ? probe : null,
        version: r.stdout.split('\n')[0].replace(/^ffmpeg version /, '').split(' ')[0],
        x264: enc.includes('libx264'),
        vp9: enc.includes('libvpx-vp9'),
      };
    }
  }
  return null;
}

function findGifski() {
  const explicit = process.env[`${ENV_PREFIX}_GIFSKI`];
  const bundledDir = { darwin: 'macos/gifski', win32: 'windows/gifski.exe', linux: 'debian/gifski' }[process.platform];
  const bundled = bundledDir ? path.join(SKILL_DIR, 'node_modules', 'gifski', 'bin', ...bundledDir.split('/')) : null;
  for (const cmd of [explicit, 'gifski', bundled].filter(Boolean)) {
    if (cmd === bundled && !existsSync(cmd)) continue;
    const r = run(cmd, ['--version']);
    if (r && r.status === 0) return { path: cmd, version: r.stdout.trim().split(' ').pop(), bundled: cmd === bundled };
  }
  return null;
}

let cached;
export function tools() {
  cached ??= { ffmpeg: findFfmpeg(), gifski: findGifski() };
  return cached;
}

export function requireFfmpeg() {
  const t = tools();
  if (!t.ffmpeg) throw new ReelkitError('ffmpeg not found (needed for GIF/MP4).', `Install it: ${hint('ffmpeg')}   (or set ${ENV_PREFIX}_FFMPEG=/path/to/ffmpeg)`);
  return t.ffmpeg;
}

async function chromiumOk() {
  const { launchBrowser } = await import('./browser.mjs');
  try {
    const b = await launchBrowser();
    const v = b.version();
    await b.close();
    return v;
  } catch (err) {
    return null;
  }
}

/** Check everything; install Chromium automatically. Returns a summary for the report. */
export async function preflight({ needMotion = true, quiet = false } = {}) {
  const out = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 17)) {
    throw new ReelkitError(`Node ${process.versions.node} is too old.`, 'Install Node 18.17+ (https://nodejs.org or `nvm install --lts`).');
  }
  out.push(['node', process.versions.node, true]);

  let chrome = await chromiumOk();
  if (!chrome) {
    log.step('Installing Playwright Chromium (one-time, ~150 MB)…');
    const r = spawnSync(isWin ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], { cwd: SKILL_DIR, stdio: 'inherit', shell: isWin });
    chrome = r.status === 0 ? await chromiumOk() : null;
    if (!chrome) throw new ReelkitError('Could not install Playwright Chromium.', 'Run `npx playwright install --with-deps chromium` and re-try.');
  }
  out.push(['chromium', chrome, true]);

  const t = tools();
  out.push(['ffmpeg', t.ffmpeg ? `${t.ffmpeg.version}${t.ffmpeg.x264 ? '' : ' (no libx264!)'}` : `missing: ${hint('ffmpeg')}`, !!t.ffmpeg || !needMotion]);
  out.push(['gifski', t.gifski ? `${t.gifski.version}${t.gifski.bundled ? ' (bundled)' : ''}` : `missing, using ffmpeg palette fallback: ${hint('gifski')}`, true]);
  if (!quiet) {
    for (const [name, info, ok] of out) (ok ? log.ok : log.warn)(`${name.padEnd(9)} ${info}`);
  }
  if (needMotion && !t.ffmpeg) requireFfmpeg();
  if (t.ffmpeg && !t.ffmpeg.x264) log.warn('ffmpeg lacks libx264: MP4 output will be skipped. Install a full ffmpeg build.');
  return t;
}
