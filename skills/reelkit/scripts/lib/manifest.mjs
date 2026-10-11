import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { NAME, VERSION } from './brand.mjs';
import { readJson, writeJson } from './fsutil.mjs';
import { loadResults } from './state.mjs';

export function qaFile(cfg) {
  return path.join(cfg.workDir, 'qa-report.json');
}

/** docs/media/manifest.json: what exists, how big, and whether it passed QA. */
export function writeManifest(cfg) {
  const results = loadResults(cfg).assets;
  const qa = readJson(qaFile(cfg), { assets: {} }).assets;
  const assets = Object.values(results)
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((r) => {
      const abs = path.join(cfg.outDir, r.file);
      const exists = existsSync(abs);
      const visual = qa[r.file]?.visual;
      return {
        file: r.file,
        scene: r.scene,
        viewport: r.viewport,
        theme: r.theme,
        kind: r.kind,
        bytes: exists ? statSync(abs).size : 0,
        width: r.width ?? r.image?.width ?? null,
        height: r.height ?? r.image?.height ?? null,
        duration: r.duration,
        status: !exists && r.status === 'PASS' ? 'MISSING' : r.status,
        reason: r.reason,
        qa: visual?.verdict ?? 'pending',
      };
    });
  writeJson(path.join(cfg.outDir, 'manifest.json'), { generator: `${NAME} ${VERSION}`, generatedAt: new Date().toISOString(), assets });
  return assets;
}
