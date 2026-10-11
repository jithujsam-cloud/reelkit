// Previews: every direction rendered from the SAME captured screenshot, at fixed comparable sizes,
// through the existing frame template (no second renderer). Product pixels are only ever placed by
// <img>: scaled uniformly, never recoloured, filtered or redrawn. If there is no passing capture there
// are no previews; nothing is ever invented to fill the space.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ReelkitError } from '../log.mjs';
import { selectScenes } from '../config.mjs';
import { findShot, render, spec } from '../frame.mjs';
import { rel } from '../fsutil.mjs';
import { directionHash } from './flow.mjs';
import { KINDS } from './schema.mjs';
import { paths, writeAtomic, writeCanonical } from './store.mjs';

export const SIZES = { single: { w: 1600, h: 1000 }, social: { w: 1280, h: 640 }, trio: { w: 1800, h: 1060 } };
const STACKS = {
  // Single quotes only: these are interpolated into inline style="…" attributes.
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export function shadowsFor(d, pal) {
  switch (d.depth.shadow) {
    case 'soft': return ['0 22px 34px rgba(0,0,0,.30)'];
    case 'layered': return ['0 2px 3px rgba(0,0,0,.18)', '0 14px 22px rgba(0,0,0,.22)', '0 34px 60px rgba(0,0,0,.26)'];
    case 'hard': return [`14px 14px 0 ${rgba(pal.text, 0.28)}`];
    default: return [];
  }
}

/** Flat colour fields only: split is a hard stop between two solid colours, never a gradient. */
export function canvasCss(d, kind, pal) {
  if (d.palette.background.kind !== 'split') return pal.canvas;
  const stop = kind === 'social' ? 58 : kind === 'single' ? 36 : 50;
  return `linear-gradient(90deg, ${pal.canvas} 0 ${stop}%, ${pal.canvas2} ${stop}% 100%)`;
}

/** Everything the template needs for one direction/kind. Pure; unit-tested. */
export function templateOptions(d, kind, theme, { devices, title, caption, brand }) {
  const pal = d.palette[theme];
  return {
    kind,
    size: SIZES[kind],
    pal,
    canvasCss: canvasCss(d, kind, pal),
    type: { stack: STACKS[d.typography.voice], weight: d.typography.weight, tracking: d.typography.tracking, case: d.typography.case },
    depth: { radius: d.depth.radius, dropShadows: shadowsFor(d, pal), ring: d.depth.ring },
    comp: d.composition[kind],
    chrome: d.devices.chrome === 'auto' ? undefined : d.devices.chrome,
    devices,
    title,
    caption,
    brand,
  };
}

const fileSha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** Choose the product capture all previews will share. Errors (never fakes) when none is usable. */
export function pickSource(cfg, { scene, theme } = {}) {
  const scenes = selectScenes(cfg, []);
  const order = [scene, cfg.marketing?.social?.scene, cfg.marketing?.hero, cfg.marketing?.trio, ...scenes.map((s) => s.name)].filter(Boolean);
  if (scene && !scenes.some((s) => s.name === scene)) throw new ReelkitError(`Unknown scene "${scene}".`, `Available: ${scenes.map((s) => s.name).join(', ')}`);
  for (const name of [...new Set(scene ? [scene] : order)]) {
    for (const t of theme ? [theme] : ['light', 'dark']) {
      const found = findShot(cfg, scenes, name, 'desktop', t) ?? findShot(cfg, scenes, name, null, t);
      if (found) return { scenes, scene: name, theme: t, ...found };
    }
  }
  const authScenes = scenes.filter((s) => s.auth).map((s) => s.name);
  throw new ReelkitError(
    scene ? `Scene "${scene}" has no passing capture${theme ? ` for the ${theme} theme` : ''}.` : 'No scene has a passing still capture, so there is nothing real to preview.',
    `Run \`reelkit shoot\` first${authScenes.length ? ` (scenes needing login: ${authScenes.join(', ')}; run \`reelkit auth\` if the session expired)` : ''}. Previews are never drawn without a real screenshot.`,
  );
}

/** Render the three comparable previews for each direction. Returns the previews manifest. */
export async function renderPreviews({ root, cfg, browser, directions, profileSha, scene, theme, onlyIds }) {
  const P = paths(root);
  const src = pickSource(cfg, { scene, theme });
  mkdirSync(P.previewsDir, { recursive: true });
  const title = cfg.name ?? '';
  const caption = cfg.tagline ?? '';
  const brand = cfg.name ?? '';
  const skipped = [];
  const items = [];
  if (!title) skipped.push({ kind: 'copy', reason: 'config has no `name`; previews show no headline text' });

  const tablet = findShot(cfg, src.scenes, src.scene, 'tablet', src.theme);
  const phone = findShot(cfg, src.scenes, src.scene, 'mobile', src.theme);
  const trioReady = !!(tablet && phone);
  if (!trioReady) skipped.push({ kind: 'trio', reason: `scene "${src.scene}" needs passing ${src.theme} captures at tablet and mobile as well as desktop; the trio preview is not drawn rather than faked` });

  const desktopSpec = () => spec(cfg, src.shot, src.file);
  for (const d of directions.filter((x) => !onlyIds || onlyIds.includes(x.id))) {
    const hash = directionHash(d);
    for (const kind of ['single', 'social', 'trio']) {
      if (kind === 'trio' && !trioReady) continue;
      const file = path.join(P.previewsDir, `${d.id}-${kind}.png`);
      rmSync(file, { force: true });
      let devices = [desktopSpec()];
      if (kind === 'trio') {
        devices = [desktopSpec(), spec(cfg, tablet.shot, tablet.file), spec(cfg, phone.shot, phone.file)];
        if (devices[0].type === 'browser') devices[0].type = 'laptop';
      }
      const opts = templateOptions(d, kind, src.theme, { devices, title: kind === 'single' && d.composition.single.heading === false ? '' : title, caption, brand });
      await render(browser, opts, { dsf: 1, out: file, entry: 'renderDirection' });
      items.push({ id: d.id, kind, file: rel(P.dir, file), width: SIZES[kind].w, height: SIZES[kind].h, directionSha256: hash, productPixels: 'unmodified' });
    }
  }
  const manifest = {
    schemaVersion: 1,
    kind: KINDS.previews,
    source: { scene: src.scene, theme: src.theme, file: rel(root, src.file), sha256: fileSha(src.file), viewport: src.shot.viewport.name },
    profileSha256: profileSha,
    items,
    skipped,
  };
  // Merge with previews of other directions rendered earlier (--only), keeping a single source capture.
  const prev = existsSync(P.previews) ? safeRead(P.previews) : null;
  if (prev && onlyIds && prev.source.sha256 === manifest.source.sha256 && prev.profileSha256 === profileSha) {
    manifest.items = [...prev.items.filter((i) => !onlyIds.includes(i.id)), ...items];
  }
  manifest.items.sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
  writeCanonical(P.previews, manifest);
  return manifest;
}

function safeRead(f) {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Static side-by-side sheet (no scripts, no network): open the file in any browser. */
export function writeCompareSheet({ root, directions, manifest, status, profile }) {
  const P = paths(root);
  const cols = directions.map((d) => {
    const pal = d.palette[manifest.source.theme];
    const imgs = ['single', 'social', 'trio'].map((k) => {
      const it = manifest.items.find((i) => i.id === d.id && i.kind === k);
      return it ? `<figure><img src="${esc(it.file)}" alt="${esc(d.name)} ${k} preview"><figcaption>${k} · ${it.width}×${it.height}</figcaption></figure>` : `<figure class="none"><figcaption>${k}: not drawn (${esc(manifest.skipped.find((s) => s.kind === k)?.reason ?? 'no preview')})</figcaption></figure>`;
    }).join('');
    const fb = d.basis.fallbacks.map((f) => `<li><b>${esc(f.path)}</b>: ${esc(f.reason)} → ${esc(f.used)}</li>`).join('');
    return `<section><h2>${esc(d.name)} <small>${esc(d.id)}</small></h2>
      <p class="why">${esc(d.rationale)}</p>
      <div class="sw">${['canvas', 'canvas2', 'text', 'accent'].map((k) => `<i title="${k} ${pal[k]}" style="background:${pal[k]}"></i>`).join('')}</div>
      <p class="meta">${esc(d.composition.single.family)} · ${esc(d.composition.social.family)} · ${esc(d.composition.trio.family)} | type ${esc(d.typography.voice)} ${d.typography.weight} | ${esc(d.depth.shadow)} depth | cursor ${esc(d.motion.cursor)}, ripple ${esc(d.motion.ripple.style)} (${esc(d.motion.ripple.color)}), zoom ${esc(d.motion.zoom)}</p>
      ${imgs}
      ${fb ? `<details open><summary>Fallbacks (profile values missing or uncertain)</summary><ul>${fb}</ul></details>` : ''}
      ${d.basis.warnings.length ? `<details><summary>Warnings</summary><ul>${[...new Set(d.basis.warnings)].map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
    </section>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>reelkit directions</title>
<style>body{font:15px/1.45 system-ui,sans-serif;margin:24px;color:#1b1d22;background:#f6f6f4}h1{margin:0 0 4px}.src{color:#555;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}section{background:#fff;border:1px solid #ddd;border-radius:10px;padding:16px}
h2 small{color:#777;font-weight:400}img{width:100%;border:1px solid #ddd;border-radius:6px;display:block}figure{margin:10px 0}figcaption{font-size:12px;color:#666}
figure.none{padding:12px;border:1px dashed #bbb;border-radius:6px}.sw i{display:inline-block;width:26px;height:26px;border-radius:5px;margin-right:6px;border:1px solid #0002}
.why{margin:8px 0}.meta{font-size:12px;color:#555}@media(max-width:1100px){.grid{grid-template-columns:1fr}}</style>
<h1>Compare directions</h1>
<p class="src">All previews use the same real capture: <b>${esc(manifest.source.file)}</b> (scene ${esc(manifest.source.scene)}, ${esc(manifest.source.theme)}, ${esc(manifest.source.viewport)}). Profile confidence ${esc(profile?.summary?.level)} (${esc(profile?.summary?.overallConfidence)}). Status: <b>${esc(status)}</b>. Product pixels are placed unmodified; only the surroundings differ. Previews are scaled compositions, not authenticity-checked outputs.</p>
<div class="grid">${cols}</div>`;
  writeAtomic(P.compare, html);
  return P.compare;
}
