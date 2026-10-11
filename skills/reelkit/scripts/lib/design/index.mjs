// `reelkit design`: inspect a site, write .reelkit/design/design-profile.{json,md}.
// Read-only with respect to the project: nothing outside the work directory is written, and no
// renderer setting or config default is read or changed.
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { WORK_DIR } from '../brand.mjs';
import { ensureDir, writeJson } from '../fsutil.mjs';
import { ReelkitError, log } from '../log.mjs';
import { analyze } from './analyze.mjs';
import { collectClaims } from './claims.mjs';
import { buildProfile, validateProfile } from './profile.mjs';
import { renderMarkdown } from './render-md.mjs';

export const PROFILE_JSON = 'design-profile.json';
export const PROFILE_MD = 'design-profile.md';

/** Pure assembly step (no browser): observations + claims → validated profile. */
export function profileFromObservations(observations, { url, claims = [], repoFiles = [], now } = {}) {
  const facts = analyze(observations);
  if (!facts) {
    const why = observations.flatMap((o) => o.errors ?? []).join('; ') || 'the page could not be loaded';
    throw new ReelkitError(`Could not inspect ${url}: ${why}.`, 'Check the URL is reachable without login and try again (add --pages for other public routes).');
  }
  const profile = buildProfile({ facts, claims, repoFiles, url, now });
  const problems = validateProfile(profile);
  if (problems.length) throw new ReelkitError(`Internal error: generated profile failed validation:\n  ${problems.slice(0, 8).join('\n  ')}`, 'This is a reelkit bug; please report it with the URL.');
  return profile;
}

export async function runDesign({ browser, url, pages = ['/'], root = process.cwd(), outDir, docsRoot }) {
  const { inspectPage } = await import('./inspect.mjs');
  const base = new URL(url);
  const targets = [...new Set(pages.map((p) => new URL(p, base).href))].slice(0, 5);
  const dir = ensureDir(outDir ?? path.join(root, WORK_DIR, 'design'));
  const observations = [];
  for (const [i, u] of targets.entries()) {
    log.step(`Inspecting ${u}`);
    observations.push(await inspectPage(browser, u, { assetsDir: i === 0 ? path.join(dir, 'assets') : undefined, onWarn: log.warn }));
  }
  const { files, claims } = collectClaims(docsRoot ?? root);
  if (files.length) log.dim(`  read ${files.length} project file(s) with design claims: ${files.map((f) => f.file).slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`);
  const profile = profileFromObservations(observations, { url: base.href, claims, repoFiles: files });
  writeJson(path.join(dir, PROFILE_JSON), profile);
  writeFileSync(path.join(dir, PROFILE_MD), renderMarkdown(profile));
  return { profile, dir, jsonFile: path.join(dir, PROFILE_JSON), mdFile: path.join(dir, PROFILE_MD) };
}
