import path from 'node:path';
import { readJson, writeJson } from './fsutil.mjs';

/** Capture results across runs (so --only re-runs merge instead of clobbering). */
export function resultsFile(cfg) {
  return path.join(cfg.workDir, 'results.json');
}

export function loadResults(cfg) {
  return readJson(resultsFile(cfg), { assets: {} });
}

export function saveResult(cfg, file, result) {
  const all = loadResults(cfg);
  all.assets[file] = { ...result, file, updatedAt: new Date().toISOString() };
  writeJson(resultsFile(cfg), all);
}

export function dropResultsFor(cfg, predicate) {
  const all = loadResults(cfg);
  for (const k of Object.keys(all.assets)) if (predicate(all.assets[k])) delete all.assets[k];
  writeJson(resultsFile(cfg), all);
}
