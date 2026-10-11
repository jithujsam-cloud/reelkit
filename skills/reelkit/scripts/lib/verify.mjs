import { existsSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NAME, VERSION } from './brand.mjs';
import { ReelkitError, c, log } from './log.mjs';
import { ensureDir, readJson, rel, sha256, writeJson } from './fsutil.mjs';
import { loadResults } from './state.mjs';
import { inspectPng } from './imagecheck.mjs';
import { qaFile, writeManifest } from './manifest.mjs';
import { tools } from './deps.mjs';
import { compareScreenRegion } from './authenticity.mjs';

const RUBRIC = [
  'fully loaded: real data, no skeletons, spinners or placeholder blocks',
  'no half-faded / mid-transition elements',
  'no cookie banners, chat bubbles, toasts or modals that were not intended',
  'no broken images or missing icons',
  'no layout overflow, clipped text or horizontal scroll at this viewport',
  'no visible PII (emails, names, keys) unless intended; no lorem ipsum',
  'content is meaningful (not an empty state unless that is the point)',
  'text is crisp (not blurry or upscaled)',
];

function globToRe(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

function kindOf(file) {
  if (file.endsWith('.gif')) return 'gif';
  if (file.endsWith('.mp4')) return 'mp4';
  if (file.endsWith('.webm')) return 'webm';
  return 'png';
}

/** Times (seconds) worth looking at in a video: start, middle, end and around each interaction. */
function sampleTimes(result) {
  const d = result.duration ?? 0;
  const times = new Map([
    [0.05, 'first'],
    [d / 2, 'middle'],
    [Math.max(0, d - 1.0), 'end-state'],
    [Math.max(0, d - 0.15), 'last'],
  ]);
  for (const [i, e] of (result.events ?? []).entries()) {
    if (e.type !== 'click' && e.type !== 'press' && e.type !== 'type') continue;
    times.set(Math.max(0, e.t - 0.25), `before-${e.type}-${i + 1}`);
    times.set(Math.min(d - 0.1, e.t + 0.6), `after-${e.type}-${i + 1}`);
  }
  return [...times.entries()].filter(([t]) => t >= 0 && t <= d).sort((a, b) => a[0] - b[0]);
}

async function automatedChecks(cfg, file, result) {
  const abs = path.join(cfg.outDir, file);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  if (result.status === 'FAILED') add('capture', false, result.reason);
  else add('capture', true, result.retries ? `${result.retries} retr${result.retries > 1 ? 'ies' : 'y'}` : undefined);
  if (!existsSync(abs)) {
    add('exists', false, 'file missing');
    return checks;
  }
  const bytes = statSync(abs).size;
  add('exists', bytes > 0, `${(bytes / 1024).toFixed(0)} KB`);
  const kind = kindOf(file);
  if (kind === 'png') {
    const img = inspectPng(abs);
    add('not-blank', !img.problems.length, img.problems[0]);
    add('dimensions', img.width >= 200 && img.height >= 200, `${img.width}×${img.height}`);
    // Framed stills record where the screen sits; prove it still holds the untouched capture.
    if (result.screen && result.from) {
      const source = path.join(cfg.outDir, result.from);
      if (!existsSync(source)) add('authentic', false, `source ${result.from} missing`);
      else {
        const cmp = compareScreenRegion({ framed: abs, raw: source, rect: result.screen.rect, src: result.screen.src, clips: result.screen.clips });
        add('authentic', cmp.ok, cmp.ok ? cmp.summary : cmp.reason);
      }
    }
  } else if (tools().ffmpeg) {
    const { probe, decodes } = await import('./media.mjs');
    const p = probe(abs);
    add('probe', !!p && p.duration > 0.3, p ? `${p.codec} ${p.width}×${p.height} ${p.duration.toFixed(1)}s` : 'unreadable');
    if (kind === 'mp4') add('h264', p?.codec === 'h264' && p?.pixFmt === 'yuv420p', p ? `${p.codec}/${p.pixFmt}` : undefined);
    if (kind !== 'gif') add('plays', await decodes(abs));
    if (kind === 'gif') add('gif-budget', bytes <= cfg.gif.maxBytes, `${(bytes / 1e6).toFixed(2)} MB of ${(cfg.gif.maxBytes / 1e6).toFixed(1)} MB`);
  }
  return checks;
}

async function sampleFrames(cfg, file, result) {
  const kind = kindOf(file);
  if (kind === 'png') return [path.join(cfg.outDir, file)];
  if (kind === 'webm' || !tools().ffmpeg) return [];
  const { extractFrame } = await import('./media.mjs');
  const dir = ensureDir(path.join(cfg.workDir, 'qa', file.replace(/[^a-z0-9-]+/gi, '_')));
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const out = [];
  for (const [t, label] of sampleTimes(result)) {
    const f = path.join(dir, `${t.toFixed(2).padStart(6, '0')}s-${label}.png`);
    await extractFrame(path.join(cfg.outDir, file), t, f, 1280).catch(() => null);
    if (existsSync(f)) out.push(f);
  }
  return out;
}

async function contactSheet(cfg, entries) {
  const tiles = entries
    .filter((e) => e.thumb)
    .map(
      (e) => `<figure class="${e.status.toLowerCase()}"><div class="img"><img src="${pathToFileURL(e.thumb).href}"></div>
      <figcaption><b>${e.file}</b><span>${e.status === 'PASS' ? '✓ PASS' : e.status === 'FAILED' ? '✗ FAILED' : '◌ needs review'}</span></figcaption></figure>`,
    )
    .join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:32px;background:#0f1117;color:#e8eaf2;font:14px/1.4 ui-sans-serif,system-ui,sans-serif}
    h1{margin:0 0 4px;font-size:22px} p{margin:0 0 22px;color:#8b90a6}
    main{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
    figure{margin:0;background:#181b24;border:1px solid #262a37;border-radius:12px;overflow:hidden}
    figure.failed{border-color:#f87171} figure.pending_review{border-color:#eab308}
    .img{height:200px;display:grid;place-items:center;background:repeating-conic-gradient(#20232e 0 25%,#1a1d27 0 50%) 0 0/16px 16px}
    img{max-width:100%;max-height:200px;object-fit:contain}
    figcaption{display:flex;justify-content:space-between;gap:8px;padding:10px 12px;font-size:12px}
    figcaption b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    figcaption span{white-space:nowrap}.pass span{color:#4ade80}.failed span{color:#f87171}.pending_review span{color:#eab308}
  </style><h1>${NAME} contact sheet</h1><p>${entries.length} assets · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p><main>${tiles}</main>`;
  const htmlFile = path.join(cfg.workDir, 'contact-sheet.html');
  writeFileSync(htmlFile, html);
  const { launchBrowser } = await import('./browser.mjs');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlFile).href);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    const out = path.join(cfg.workDir, 'contact-sheet.png');
    await page.screenshot({ path: out, fullPage: true });
    return out;
  } finally {
    await browser.close();
  }
}

function applyMarks(cfg, report, marks, note) {
  for (const m of marks) {
    const [pattern, verdictRaw] = m.split('=');
    const verdict = (verdictRaw ?? '').toLowerCase();
    if (!['pass', 'fail'].includes(verdict)) throw new ReelkitError(`Bad --mark "${m}".`, 'Use --mark <file>=pass or --mark <file>=fail --note "why"');
    if (verdict === 'fail' && !note) throw new ReelkitError('A fail verdict needs a reason.', 'Add --note "what is wrong" so the next capture can fix it.');
    const re = globToRe(pattern);
    const hits = Object.keys(report.assets).filter((f) => re.test(f));
    if (!hits.length) throw new ReelkitError(`--mark ${pattern} matches no asset.`, `Run \`${NAME} verify\` to list assets.`);
    for (const f of hits) {
      const abs = path.join(cfg.outDir, f);
      if (!existsSync(abs)) continue;
      report.assets[f].visual = { verdict, notes: note ?? '', sha256: sha256(abs), reviewedAt: new Date().toISOString() };
      log.ok(`${f}: visual ${verdict.toUpperCase()}${note ? ` (${note})` : ''}`);
    }
  }
}

export async function verify(cfg, { marks = [], note, strict = false, ci = false, json = false } = {}) {
  const results = loadResults(cfg).assets;
  const previous = readJson(qaFile(cfg), { assets: {} });
  const files = Object.keys(results).sort();
  if (!files.length) throw new ReelkitError('Nothing to verify yet.', `Run \`${NAME} shoot\` / \`${NAME} record\` first.`);

  const report = { generator: `${NAME} ${VERSION}`, generatedAt: new Date().toISOString(), rubric: RUBRIC, assets: {} };
  for (const file of files) {
    const r = results[file];
    const abs = path.join(cfg.outDir, file);
    const prev = previous.assets[file];
    const hash = existsSync(abs) ? sha256(abs) : null;
    // A verdict only counts for the exact bytes that were reviewed.
    const visual = prev?.visual && prev.visual.sha256 === hash ? prev.visual : { verdict: 'pending' };
    report.assets[file] = {
      scene: r.scene,
      viewport: r.viewport,
      theme: r.theme,
      kind: r.kind,
      sha256: hash,
      capture: { checks: r.checks, attempts: r.attempts, retries: r.retries ?? 0, reason: r.reason },
      visual,
    };
  }

  if (marks.length) {
    applyMarks(cfg, report, marks, note);
    for (const f of files) {
      const a = report.assets[f];
      a.automated = previous.assets[f]?.sha256 === a.sha256 ? previous.assets[f].automated : undefined;
      a.samples = previous.assets[f]?.samples;
    }
  }

  const entries = [];
  for (const file of files) {
    const a = report.assets[file];
    if (!a.automated) {
      const checks = await automatedChecks(cfg, file, results[file]);
      a.automated = { ok: checks.every((ch) => ch.ok), checks };
      a.samples = a.automated.ok ? (await sampleFrames(cfg, file, results[file])).map((p) => rel(cfg.root, p)) : [];
    }
    a.status = !a.automated.ok ? 'FAILED' : a.visual.verdict === 'pass' ? 'PASS' : a.visual.verdict === 'fail' ? 'FAILED' : 'PENDING_REVIEW';
    const thumb = a.samples?.length ? path.join(cfg.root, a.samples[Math.floor(a.samples.length / 2)]) : null;
    entries.push({ file, status: a.status, thumb });
  }

  const count = (s) => entries.filter((e) => e.status === s).length;
  report.summary = { total: entries.length, pass: count('PASS'), failed: count('FAILED'), pendingReview: count('PENDING_REVIEW') };
  writeJson(qaFile(cfg), report);
  writeManifest(cfg);
  if (!marks.length) {
    try {
      report.contactSheet = rel(cfg.root, await contactSheet(cfg, entries));
      writeJson(qaFile(cfg), report);
    } catch (err) {
      log.warn(`Contact sheet skipped: ${err.message.split('\n')[0]}`);
    }
  }

  if (json) console.log(JSON.stringify(report, null, 2));
  else printSummary(cfg, report, { marksOnly: marks.length > 0 });

  const automatedFailed = entries.filter((e) => report.assets[e.file].automated && !report.assets[e.file].automated.ok);
  const visualFailed = entries.filter((e) => report.assets[e.file].visual.verdict === 'fail');
  if (automatedFailed.length) {
    return { ok: false, message: `${automatedFailed.length} asset(s) failed automated checks.`, fix: 'Fix the reasons listed, re-capture with --only <scene>, then verify again.' };
  }
  if (visualFailed.length) {
    return { ok: false, message: `${visualFailed.length} asset(s) failed visual review.`, fix: 'Adjust the scene (waitFor/hide/scrollTo/mask), re-capture with --only <scene>, and review again.' };
  }
  if (strict && !ci && report.summary.pendingReview) {
    return { ok: false, message: `${report.summary.pendingReview} asset(s) still need a visual verdict.`, fix: `Open each listed file, then \`${NAME} verify --mark <file>=pass\` (or =fail --note "…").` };
  }
  return { ok: true, report };
}

function printSummary(cfg, report, { marksOnly }) {
  const s = report.summary;
  log.info('');
  log.info(c.bold(`QA summary: ${s.total} assets · ${c.green(`${s.pass} pass`)} · ${s.failed ? c.red(`${s.failed} failed`) : '0 failed'} · ${s.pendingReview ? c.yellow(`${s.pendingReview} need visual review`) : '0 pending'}`));
  if (marksOnly) return;
  for (const [file, a] of Object.entries(report.assets)) {
    const badge = a.status === 'PASS' ? c.green('PASS   ') : a.status === 'FAILED' ? c.red('FAILED ') : c.yellow('REVIEW ');
    const failed = a.automated.checks.filter((ch) => !ch.ok).map((ch) => `${ch.name}: ${ch.detail ?? 'failed'}`);
    const info = a.automated.checks.filter((ch) => ch.ok && ch.detail).map((ch) => ch.detail).join(' · ');
    log.info(`  ${badge} ${file} ${c.dim(failed.length ? failed.join('; ') : info)}${a.visual.verdict === 'fail' ? c.red(` visual: ${a.visual.notes}`) : ''}`);
  }
  const pending = Object.entries(report.assets).filter(([, a]) => a.status === 'PENDING_REVIEW');
  if (pending.length) {
    log.info(`\n${c.bold('Visual review needed.')} Open each image below and check it against the rubric (reference/qa-rubric.md):`);
    for (const [file, a] of pending) {
      log.info(`  ${file}`);
      for (const smp of a.samples ?? []) log.info(c.dim(`    ${smp}`));
    }
    log.info(`Then record verdicts: ${NAME} verify --mark <file>=pass   or   --mark <file>=fail --note "what is wrong"`);
  }
  if (report.contactSheet) log.info(`\nContact sheet: ${report.contactSheet}`);
  log.info(`QA report:     ${rel(cfg.root, qaFile(cfg))}`);
}
