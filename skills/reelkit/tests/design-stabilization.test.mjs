// Phase 1 stabilisation: class-toggled dark themes, source scanning (components.json, @fontsource,
// next/font) with generated-font-name normalisation, deterministic output, unreachable sites,
// skipped login routes and repeatability. Complements design-profile.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHex } from '../scripts/lib/color.mjs';
import { classifyPage, stackFirst } from '../scripts/lib/design/analyze.mjs';
import { collectClaims, extractDesignSystemFromComponentsJson, extractFromNextFont, extractFromPackageJson } from '../scripts/lib/design/claims.mjs';
import { fontsourceFamily, normalizeFontFamily } from '../scripts/lib/design/fontnames.mjs';
import { RUN_JSON, profileFromObservations, runDesign } from '../scripts/lib/design/index.mjs';
import { validateProfile } from '../scripts/lib/design/profile.mjs';
import { renderMarkdown } from '../scripts/lib/design/render-md.mjs';
import { ReelkitError, setQuiet } from '../scripts/lib/log.mjs';

// node:test uses each test file's stdout as its event channel: progress lines printed by runDesign
// (log.step / log.dim) would corrupt it ("Unable to deserialize cloned data") and kill the file.
setQuiet(true);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures', 'design');

/* ───────────── synthetic observations (no browser) ───────────── */

const rgba = (hex, a = 1) => [...parseHex(hex), a];
const FONT = { family: 'Inter, sans-serif', size: 16, weight: 400, lineHeight: 24, letterSpacing: 0, transform: 'none' };
const el = (role, over = {}) => ({ tag: 'div', role, textLen: role === 'text' ? 40 : 0, color: null, bg: null, parentBg: rgba('#ffffff'), borderColor: null, borderWidth: 0, radius: 0, shadow: null, pad: [0, 0, 0, 0], gap: null, margin: [0, 0], font: { ...FONT }, rect: [0, 0, 200, 40], ...over });
const body = (family, n = 6) => Array.from({ length: n }, () => el('text', { color: rgba('#111111'), font: { ...FONT, family } }));
const VIT = { viewport: [1440, 900], overflowX: false, bodyFontSize: 16, h1: null, gridMaxCols: 0, headerPosition: null, navLinksVisible: null, menuButtonVisible: null, contentWidthPx: 1000 };
function observation(elements, main = {}, extra = {}) {
  return {
    url: 'http://t.test/', finalUrl: 'http://t.test/', errors: [],
    main: { url: 'http://t.test/', title: 'T', lang: 'en', description: null, siteName: null, themeColor: null, pageBg: { rgba: rgba('#ffffff'), defaulted: false }, bodyText: rgba('#111111'), elements, elementsTotal: elements.length, vars: [], fontFaces: [], documentFonts: [], unreadableSheets: 0, unreadableHrefs: [], darkClassRules: 0, rootDarkMarker: false, themeToggle: false, icons: [], ogImage: null, manifest: null, logos: [], layout: { maxWidths: {}, headerSticky: null }, vitals: { ...VIT }, ...main },
    responsive: { desktop: { ...VIT }, mobile: { ...VIT, viewport: [390, 844] } },
    dark: { bg: rgba('#ffffff'), text: rgba('#111111'), button: null }, // prefers-color-scheme changed nothing
    light: { bg: rgba('#ffffff'), text: rgba('#111111') },
    ...extra,
  };
}
const build = (elements, { main, extra, claims = [], designSystems = [] } = {}) => profileFromObservations([observation(elements, main, extra)], { url: 'http://t.test/', claims, designSystems });
const anyFont = (family, role = 'any') => ({ kind: 'font', role, family, file: 'package.json', line: 0, text: `dependencies: ${family}`, via: 'package.json' });

/* ───────────── 1. class-toggled dark themes ───────────── */

test('dark scheme: a theme switched by class or toggle is "unverified", never reported as "no dark theme"', () => {
  const plain = build(body('Inter'));
  assert.equal(plain.tokens.schemes.prefersDark.value.responds, false);
  assert.equal(plain.tokens.schemes.prefersDark.value.status, 'verified');
  assert.equal(plain.tokens.schemes.prefersDark.value.toggle, 'none-detected');
  assert.ok(plain.tokens.schemes.prefersDark.confidence >= 0.7);

  const rules = build(body('Inter'), { main: { darkClassRules: 3 } });
  const v = rules.tokens.schemes.prefersDark;
  assert.equal(v.value.responds, false, 'responds keeps its original meaning');
  assert.equal(v.value.status, 'unverified');
  assert.equal(v.value.toggle, 'class-or-attribute');
  assert.equal(v.value.darkRules, 3);
  assert.ok(v.confidence <= 0.35 && v.level === 'low');
  assert.match(v.notes.join(' '), /unverified.*3 CSS rule\(s\) target a dark class/);
  assert.ok(rules.limitations.some((l) => /Dark theme unverified/.test(l)));
  assert.deepEqual(validateProfile(rules), []);

  const toggle = build(body('Inter'), { main: { themeToggle: true } });
  assert.equal(toggle.tokens.schemes.prefersDark.value.status, 'unverified');
  assert.equal(toggle.tokens.schemes.prefersDark.value.themeToggleControl, true);
});

test('dark scheme: unreadable cross-origin CSS makes it unverified, unless it is only a font host', () => {
  const fontsOnly = build(body('Inter'), { main: { unreadableSheets: 1, unreadableHrefs: ['https://fonts.googleapis.com/css2?family=Inter'] } });
  assert.equal(fontsOnly.tokens.schemes.prefersDark.value.status, 'verified');
  const opaque = build(body('Inter'), { main: { unreadableSheets: 1, unreadableHrefs: ['https://cdn.example.com/app.css'] } });
  assert.equal(opaque.tokens.schemes.prefersDark.value.status, 'unverified');
  assert.equal(opaque.tokens.schemes.prefersDark.value.toggle, 'unknown');
});

test('dark scheme: when prefers-color-scheme really changes the page it is verified', () => {
  const p = build(body('Inter'), { main: { darkClassRules: 2 }, extra: { dark: { bg: rgba('#0b0b14'), text: rgba('#eeeeee'), button: null } } });
  assert.deepEqual(p.tokens.schemes.prefersDark.value, { responds: true, status: 'verified', background: '#0b0b14', text: '#eeeeee' });
  assert.ok(!p.limitations.some((l) => /Dark theme unverified/.test(l)));
});

/* ───────────── 2. font names and source scanning ───────────── */

test('next/font generated aliases are normalised; metric fallbacks are skipped', () => {
  assert.deepEqual(normalizeFontFamily('__Inter_5e0a8e'), { family: 'Inter', generated: true, fallback: false });
  assert.deepEqual(normalizeFontFamily('"__Playfair_Display_9a1b2c"'), { family: 'Playfair Display', generated: true, fallback: false });
  assert.deepEqual(normalizeFontFamily('__Inter_Fallback_5e0a8e'), { family: 'Inter', generated: true, fallback: true });
  assert.deepEqual(normalizeFontFamily('Inter'), { family: 'Inter', generated: false, fallback: false });
  assert.equal(normalizeFontFamily('__proto__').generated, false, 'only hash-suffixed aliases are rewritten');
  assert.equal(stackFirst('__Inter_Fallback_5e0a8e, __Inter_5e0a8e, sans-serif'), '__Inter_5e0a8e');
  assert.equal(fontsourceFamily('@fontsource/playfair-display'), 'Playfair Display');
  assert.equal(fontsourceFamily('@fontsource-variable/ibm-plex-sans'), 'IBM Plex Sans');
  assert.equal(fontsourceFamily('react'), null);
});

test('source extractors: @fontsource, next/font (with role hints and aliases) and components.json', () => {
  const pkg = extractFromPackageJson(JSON.stringify({ dependencies: { '@fontsource/inter': '5', react: '19' }, devDependencies: { '@fontsource/jetbrains-mono': '5' } }), 'package.json');
  assert.deepEqual(pkg.map((c) => [c.role, c.family]), [['any', 'Inter'], ['mono', 'Jetbrains Mono']]);
  assert.deepEqual(extractFromPackageJson('{broken', 'package.json'), []);

  const src = "import { Inter, Playfair_Display, Geist_Mono as GM } from 'next/font/google';\nconst inter = Inter({ variable: '--font-sans' });\nconst h = Playfair_Display({ variable: '--font-heading' });\nconst m = GM({});";
  const nf = extractFromNextFont(src, 'app/layout.tsx');
  assert.deepEqual(nf.map((c) => [c.role, c.family, c.line]), [['body', 'Inter', 1], ['heading', 'Playfair Display', 1], ['mono', 'Geist Mono', 1]]);
  assert.deepEqual(extractFromNextFont("import x from 'next/font/local'", 'a.tsx'), [], 'next/font/local names no family');

  const ds = extractDesignSystemFromComponentsJson(readFileSync(path.join(FIXTURES, 'nextproject', 'components.json'), 'utf8'), 'components.json');
  assert.deepEqual(ds, { name: 'shadcn/ui', file: 'components.json', details: { style: 'new-york', baseColor: 'zinc', cssVariables: true, css: 'app/globals.css', iconLibrary: 'lucide' } });
  assert.equal(extractDesignSystemFromComponentsJson('{"hello":1}', 'components.json'), null);
  assert.equal(extractDesignSystemFromComponentsJson('nope', 'components.json'), null);
});

test('collectClaims reads package.json, components.json and next/font imports from a project folder', () => {
  const { files, claims, designSystems } = collectClaims(path.join(FIXTURES, 'nextproject'));
  assert.deepEqual(files.map((f) => f.file).sort(), ['app/layout.tsx', 'components.json', 'package.json']);
  assert.deepEqual(claims.filter((c) => c.kind === 'font').map((c) => `${c.role}:${c.family}`).sort(), ['body:Inter', 'heading:Playfair Display', 'mono:Jetbrains Mono']);
  assert.equal(designSystems[0].name, 'shadcn/ui');
  assert.deepEqual(collectClaims(path.join(FIXTURES, 'does-not-exist')), { files: [], claims: [], designSystems: [] });
});

test('"any"-role font claims can corroborate an observed font but never create a conflict', () => {
  const els = body('Inter, sans-serif');
  const agree = build(els, { claims: [anyFont('Inter')] });
  const differ = build(els, { claims: [anyFont('Lora')] });
  assert.ok(agree.tokens.typography.body.confidence > differ.tokens.typography.body.confidence);
  assert.ok(agree.tokens.typography.body.sources.some((id) => agree.evidence.find((e) => e.id === id).kind === 'repo-file'));
  assert.equal(differ.conflicts.length, 0, 'an installed-but-unused font is not a contradiction');
  const roled = build(els, { claims: [anyFont('Lora', 'body')] });
  assert.equal(roled.conflicts.length, 1, 'a role-specific claim that disagrees is still a conflict (unchanged)');
});

test('a generated next/font alias is reported as its family, with the alias kept and the claim corroborating', () => {
  const stack = '__Inter_5e0a8e, __Inter_Fallback_5e0a8e, system-ui, sans-serif';
  const p = build(body(stack), { claims: [anyFont('Inter')], designSystems: [{ name: 'shadcn/ui', file: 'components.json', details: { style: 'new-york', baseColor: 'zinc' } }] });
  const f = p.tokens.typography.body;
  assert.equal(f.value.family, 'Inter');
  assert.equal(f.value.cssFamily, '__Inter_5e0a8e');
  assert.equal(f.value.generated, true);
  assert.equal(f.value.origin, 'webfont-declared-not-loaded', 'a generated alias can never be a system font');
  assert.match(f.notes.join(' '), /normalised to "Inter"/);
  assert.ok(f.sources.length >= 2, 'rendered + the matching package.json claim');
  assert.equal(p.site.designSystems[0].name, 'shadcn/ui');
  assert.deepEqual(validateProfile(p), []);
  assert.match(renderMarkdown(p), /Design system signal: \*\*shadcn\/ui\*\*, style `new-york`/);
  const bad = JSON.parse(JSON.stringify(p));
  bad.site.designSystems[0].evidence = 'e999';
  assert.ok(validateProfile(bad).some((m) => /designSystems.*e999/.test(m)));
});

/* ───────────── page classification (login walls, HTTP errors) ───────────── */

test('classifyPage: 401/403 and redirects to login/SSO are auth-required; other 4xx/5xx are errors; normal pages pass', () => {
  const c = (req, fin, st) => classifyPage(req, fin, st);
  assert.equal(c('https://a.test/app', 'https://a.test/app', 401).kind, 'auth-required');
  assert.equal(c('https://a.test/app', 'https://a.test/app', 403).kind, 'auth-required');
  assert.match(c('https://a.test/app', 'https://a.test/login?next=%2Fapp', 200).reason, /redirected to \/login/);
  assert.equal(c('https://a.test/app', 'https://a.test/users/sign_in', 200).kind, 'auth-required');
  assert.equal(c('https://a.test/app', 'https://idp.test/oauth2/authorize', 200).kind, 'auth-required');
  assert.equal(c('https://a.test/login', 'https://a.test/login', 200), null, 'asking for the login page itself is fine');
  assert.equal(c('https://a.test/', 'https://a.test/en', 200), null, 'ordinary redirects are fine');
  assert.equal(c('https://a.test/x', 'https://a.test/x', 404).kind, 'http-error');
  assert.equal(c('https://a.test/x', 'https://a.test/x', 503).kind, 'http-error');
  assert.equal(c('https://a.test/', 'https://a.test/', 200), null);
});

/* ───────────── real browser: dark, source scanning, skipped routes, repeatability ───────────── */

const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml', '.css': 'text/css' };
/** Static files from `dir` plus optional route handlers: (req,res) => true when handled. */
function serve(dir, routes = {}) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (routes[url]) return routes[url](req, res);
    let p = path.join(dir, decodeURIComponent(url));
    if (existsSync(p) && !path.extname(p)) p = path.join(p, 'index.html');
    if (!existsSync(p) || !p.startsWith(dir)) return res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title><p>not found</p>');
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' }).end(readFileSync(p));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}
const tmpdir = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));

test('design stabilisation in Chromium', async (t) => {
  const { launchBrowser } = await import('../scripts/lib/browser.mjs');
  const browser = await launchBrowser();
  t.after(() => browser.close());

  await t.test('classdark: html.dark + a theme toggle is reported unverified, not "no dark theme"', async () => {
    const site = await serve(path.join(FIXTURES, 'classdark'));
    const out = tmpdir('rk-dark-');
    try {
      const { profile: p } = await runDesign({ browser, url: site.url, outDir: out, root: out, docsRoot: out });
      const v = p.tokens.schemes.prefersDark;
      assert.equal(v.value.responds, false);
      assert.equal(v.value.status, 'unverified');
      assert.equal(v.value.toggle, 'class-or-attribute');
      assert.ok(v.value.darkRules >= 1 && v.value.themeToggleControl === true, JSON.stringify(v.value));
      assert.ok(p.limitations.some((l) => /Dark theme unverified/.test(l)));
      assert.match(readFileSync(path.join(out, 'design-profile.md'), 'utf8'), /Dark scheme: \*\*unverified\*\*/);
      assert.deepEqual(validateProfile(p), []);
    } finally {
      site.close();
      rmSync(out, { recursive: true, force: true });
    }
  });

  await t.test('mono (no dark rules, no toggle, no unreadable CSS): "none found" is a verified statement', async () => {
    const site = await serve(path.join(FIXTURES, 'mono'));
    const out = tmpdir('rk-mono-');
    try {
      const { profile: p } = await runDesign({ browser, url: site.url, outDir: out, root: out, docsRoot: out });
      assert.equal(p.tokens.schemes.prefersDark.value.status, 'verified');
      assert.equal(p.tokens.schemes.prefersDark.value.toggle, 'none-detected');
    } finally {
      site.close();
      rmSync(out, { recursive: true, force: true });
    }
  });

  await t.test('nextproject: generated aliases become Inter / Playfair Display and the project files corroborate them', async () => {
    const site = await serve(path.join(FIXTURES, 'nextproject'));
    const out = tmpdir('rk-next-');
    try {
      const { profile: p } = await runDesign({ browser, url: site.url, outDir: out, root: out, docsRoot: path.join(FIXTURES, 'nextproject') });
      const { body: b, heading: h, mono: m } = p.tokens.typography;
      assert.equal(b.value.family, 'Inter');
      assert.equal(b.value.cssFamily, '__Inter_5e0a8e');
      assert.equal(h.value.family, 'Playfair Display');
      assert.equal(m.value.family, 'JetBrains Mono');
      for (const tok of [b, h, m]) assert.ok(tok.sources.some((id) => p.evidence.find((e) => e.id === id).kind === 'repo-file'), 'corroborated by layout.tsx / package.json');
      assert.equal(p.conflicts.filter((c) => c.path.startsWith('tokens.typography') && c.severity !== 'info').length, 0);
      assert.equal(p.site.designSystems[0].name, 'shadcn/ui');
      assert.deepEqual(validateProfile(p), []);
    } finally {
      site.close();
      rmSync(out, { recursive: true, force: true });
    }
  });

  await t.test('login routes are skipped and reported, never profiled as the site', async () => {
    const site = await serve(path.join(FIXTURES, 'fernhill'), {
      '/private': (_req, res) => res.writeHead(302, { location: '/login?next=/private' }).end(),
      '/login': (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Sign in to Acme</title><style>body{background:#fee}</style><form><input type=password></form>'),
      '/locked': (_req, res) => res.writeHead(401, { 'content-type': 'text/html' }).end('<!doctype html><title>Unauthorized</title><p>no</p>'),
    });
    const out = tmpdir('rk-auth-');
    try {
      const { profile: p } = await runDesign({ browser, url: site.url, pages: ['/', '/private', '/locked'], outDir: out, root: out, docsRoot: out });
      assert.deepEqual(p.site.pages.map((x) => new URL(x.url).pathname), ['/'], 'only the public page was profiled');
      assert.deepEqual(p.site.skipped.map((s) => [new URL(s.url).pathname, s.kind]), [['/private', 'auth-required'], ['/locked', 'auth-required']]);
      assert.match(p.site.skipped[0].reason, /redirected to \/login/);
      assert.match(p.site.skipped[1].reason, /HTTP 401/);
      assert.equal(p.tokens.colors.background.value.hex, '#f7f4ec', 'the login page background (#fee) did not leak in');
      assert.ok(p.limitations.filter((l) => /requires login/.test(l)).length === 2);
      assert.ok(!JSON.stringify(p).includes('Sign in to Acme'));
      assert.deepEqual(validateProfile(p), []);
    } finally {
      site.close();
      rmSync(out, { recursive: true, force: true });
    }
  });

  await t.test('when every requested page needs login there is no profile, only a clear error', async () => {
    const site = await serve(FIXTURES, { '/': (_req, res) => res.writeHead(302, { location: '/login' }).end(), '/login': (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Login</title>') });
    const out = tmpdir('rk-allauth-');
    try {
      await assert.rejects(runDesign({ browser, url: site.url, outDir: out, root: out, docsRoot: out }), (err) => {
        assert.ok(err instanceof ReelkitError);
        assert.match(err.message, /Every page needs login/);
        assert.match(err.fix, /public pages only/);
        return true;
      });
      assert.deepEqual(readdirSync(out), [], 'nothing written');
    } finally {
      site.close();
      rmSync(out, { recursive: true, force: true });
    }
  });

  await t.test('a 404 or 500 page is an error, not a profile of the error page', async () => {
    const site = await serve(FIXTURES, { '/': (_req, res) => res.writeHead(500, { 'content-type': 'text/html' }).end('<!doctype html><title>Oops</title><p>boom</p>') });
    const out = tmpdir('rk-500-');
    try {
      await assert.rejects(runDesign({ browser, url: site.url, outDir: out, root: out, docsRoot: out }), /answered HTTP 500/);
      assert.deepEqual(readdirSync(out), []);
    } finally {
      site.close();
      rmSync(out, { recursive: true, force: true });
    }
  });

  await t.test('an unreachable host fails with a fix line and writes nothing', async () => {
    const out = tmpdir('rk-down-');
    try {
      await assert.rejects(runDesign({ browser, url: 'http://127.0.0.1:9/', outDir: out, root: out, docsRoot: out }), (err) => {
        assert.ok(err instanceof ReelkitError);
        assert.match(err.message, /Could not inspect http:\/\/127\.0\.0\.1:9\//);
        assert.match(err.fix, /reachable without login/);
        return true;
      });
      assert.deepEqual(readdirSync(out), []);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  await t.test('repeatability: two runs give byte-identical profile and markdown; only the run file differs', async () => {
    const site = await serve(path.join(FIXTURES, 'fernhill'));
    const a = tmpdir('rk-rep-a-');
    const b = tmpdir('rk-rep-b-');
    try {
      const docs = path.join(FIXTURES, 'fernhill');
      const r1 = await runDesign({ browser, url: site.url, outDir: a, root: a, docsRoot: docs });
      await new Promise((r) => setTimeout(r, 1100)); // guarantee different wall-clock seconds
      const r2 = await runDesign({ browser, url: site.url, outDir: b, root: b, docsRoot: docs });
      for (const f of ['design-profile.json', 'design-profile.md']) assert.equal(readFileSync(path.join(a, f), 'utf8'), readFileSync(path.join(b, f), 'utf8'), `${f} is byte-identical`);
      assert.deepEqual(readdirSync(path.join(a, 'assets')).sort(), readdirSync(path.join(b, 'assets')).sort());
      assert.ok(!('generatedAt' in r1.profile.generator), 'no timestamp in the canonical profile');
      assert.ok(!/20\d\d-\d\d-\d\dT/.test(readFileSync(path.join(a, 'design-profile.json'), 'utf8')), 'no ISO timestamp anywhere in the JSON');
      const m1 = JSON.parse(readFileSync(r1.runFile, 'utf8'));
      const m2 = JSON.parse(readFileSync(r2.runFile, 'utf8'));
      assert.notEqual(m1.generatedAt, m2.generatedAt, 'run metadata records when each run happened');
      assert.equal(m1.profileSha256, m2.profileSha256, 'and proves the profile content is identical');
      assert.equal(path.basename(r1.runFile), RUN_JSON);
    } finally {
      site.close();
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

/* ───────────── CLI ───────────── */

test('reelkit design: unreachable URL exits non-zero with a fix line and creates no profile', async () => {
  const out = tmpdir('rk-cli-down-');
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(SKILL, 'scripts', 'reelkit.mjs'), 'design', '--url', 'http://127.0.0.1:9/'], { cwd: out });
      let all = '';
      child.stdout.on('data', (d) => (all += d));
      child.stderr.on('data', (d) => (all += d));
      child.on('close', (status) => resolve({ status, all }));
    });
    assert.notEqual(run.status, 0);
    assert.match(run.all, /Could not inspect/);
    assert.match(run.all, /fix:/);
    assert.ok(!existsSync(path.join(out, '.reelkit', 'design', 'design-profile.json')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
