import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WORK_DIR } from './brand.mjs';

export const ensureDir = (d) => (mkdirSync(d, { recursive: true }), d);

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic write so an interrupted run never leaves half a manifest. */
export function writeJson(file, data, { mode } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
  if (mode) chmodSync(file, mode);
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Make sure session files and secrets can never be committed. Returns lines added. */
export function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  const want = [`${WORK_DIR}/`, '.env'];
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const missing = want.filter((w) => !lines.includes(w) && !lines.includes(w.replace(/\/$/, '')));
  if (missing.length) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${prefix}# reelkit: session files and secrets\n${missing.join('\n')}\n`);
  }
  return missing;
}

export const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
