// End-to-end design inspection against static fixture sites (served locally, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../scripts/lib/browser.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { setQuiet } from '../scripts/lib/log.mjs';
import { inspectDesign } from '../scripts/lib/design/inspect.mjs';
import { validateProfile } from '../scripts/lib/design/profile.mjs';
import { deltaEOK, parseHex } from '../scripts/lib/color.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'design');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/markdown' };
const REELKIT_DEFAULTS = ['#7c5cff', '#6d4cff', '#8b5cf6', '#22b8e0', '#22d3ee'];

let server;
let base;
let browser;
const tmpDirs = [];

before(async () => {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(FIXTURES, p);
    if (!file.startsWith(FIXTURES) || !existsSync(file)) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
  setQuiet(true);
});

after(async () => {
  setQuiet(false);
  await browser?.close();
  server?.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Inspect one fixture site; `scenes` are YAML scene lines. */
async function inspect(site, scenes, { viewports = ['desktop'], baseUrl = `${base}/${site}`, source = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `reelkit-design-${site}-`));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, 'reelkit.config.yaml'), `baseUrl: ${baseUrl}\nstability: { timeout: 6000, retries: 1 }\nscenes:\n${scenes.map((s) => `  - ${s}`).join('\n')}\n`);
  const cfg = loadConfig(path.join(dir, 'reelkit.config.yaml'));
  const { profile, jsonFile, mdFile } = await inspectDesign(cfg, { browser, viewports, outDir: path.join(dir, 'out'), sourceRoot: source ? path.join(FIXTURES, site) : false });
  assert.ok(existsSync(jsonFile) && existsSync(mdFile), 'both profile files are written');
  const check = validateProfile(profile);
  assert.ok(check.ok, check.errors.join('\n'));
  return { profile, md: readFileSync(mdFile, 'utf8'), json: readFileSync(jsonFile, 'utf8'), dir };
}

const near = (a, b, tol = 0.03) => deltaEOK(parseHex(a), parseHex(b)) <= tol;

test('forest-green SaaS: brand colour, neutrals, assets and responsive data are observed with provenance', async () => {
  const { profile, json } = await inspect('forest', ['{ name: home, url: / }', '{ name: pricing, url: /pricing.html }'], { viewports: ['desktop', 'mobile'] });
  const light = profile.palette.light.roles;
  assert.ok(near(light.primary.value, '#1f6b45'), `primary ${light.primary.value}`);
  assert.equal(light.primary.basis, 'observed');
  assert.equal(light.primary.level, 'high', `confidence ${light.primary.confidence}`);
  const types = new Set(light.primary.sources.map((s) => s.type));
  for (const t of ['rendered-role', 'rendered-var', 'logo', 'meta', 'docs']) assert.ok(types.has(t), `primary evidence includes ${t}`);
  assert.ok(near(light.background.value, '#f7f8f5', 0.012), `background ${light.background.value}`);
  assert.ok(near(light.text.value, '#18211c', 0.012), `text ${light.text.value}`);
  assert.ok(near(light.surface.value, '#ffffff', 0.012), `surface ${light.surface.value}`);
  assert.ok(near(light.border.value, '#dfe4dc', 0.012), `border ${light.border.value}`);
  assert.equal(profile.conflicts.length, 0, JSON.stringify(profile.conflicts));
  assert.equal(profile.style.mode.value, 'light only');
  assert.equal(profile.palette.dark, null);
  assert.equal(profile.typography.body.value, 'Georgia');
  assert.match(profile.typography.body.status, /^local font/, 'Georgia is installed locally, not a loaded web font');
  assert.ok(profile.assets.logos.length >= 1 && profile.assets.logos[0].colors.includes('#1f6b45'));
  assert.ok(profile.assets.themeColor.some((t) => t.value === '#1f6b45'));
  assert.equal(profile.responsive.length, 2);
  assert.ok(profile.responsive.every((r) => r.mobile.h1 < r.desktop.h1), 'h1 shrinks on mobile');
  assert.deepEqual(profile.coverage.docs, ['DESIGN.md']);
  // Never borrow Reelkit's own palette for a site that does not use it.
  for (const h of REELKIT_DEFAULTS) assert.ok(!json.toLowerCase().includes(h), `profile must not mention reelkit default ${h}`);
});

test('dark-only interface: detected as dark by default, accent observed', async () => {
  const { profile } = await inspect('dark', ['{ name: home, url: / }']);
  assert.equal(profile.style.mode.value, 'dark only');
  assert.equal(profile.coverage.themes.dark, 'default');
  const roles = profile.palette.light.roles;
  assert.ok(near(roles.background.value, '#0e1116', 0.012), roles.background.value);
  assert.ok(near(roles.primary.value, '#f59e0b'), roles.primary.value);
  assert.equal(roles.primary.basis, 'observed');
});

test('documentation that contradicts the rendered UI is recorded as a conflict, not silently chosen', async () => {
  const { profile, md } = await inspect('conflict', ['{ name: home, url: / }']);
  const primary = profile.palette.light.roles.primary;
  assert.ok(near(primary.value, '#0d9488'), `rendered teal wins, got ${primary.value}`);
  const colour = profile.conflicts.find((c) => c.field === 'palette.light.primary');
  assert.ok(colour, 'colour conflict recorded');
  assert.equal(colour.declared, '#2563eb');
  assert.match(colour.declaredIn, /DESIGN\.md/);
  assert.ok(colour.deltaE > 0.05);
  const font = profile.conflicts.find((c) => c.field.startsWith('typography.'));
  assert.ok(font && font.declared === 'Söhne', 'documented font that the site does not use is a conflict');
  assert.match(md, /## Conflicts[\s\S]*#2563eb/);
});

test('a monochrome site gets no invented brand colour', async () => {
  const { profile, md } = await inspect('mono', ['{ name: home, url: / }']);
  const primary = profile.palette.light.roles.primary;
  assert.equal(primary.value, null);
  assert.equal(primary.basis, 'unknown');
  assert.equal(primary.confidence, 0);
  assert.match(primary.reason, /monochrome/);
  assert.ok(profile.unverified.some((u) => /Brand colour/.test(u)));
  assert.ok(profile.unverified.some((u) => /No logo/.test(u)));
  assert.match(md, /no chromatic brand colour observed/);
});

test('no design system or docs: findings come only from the rendered page, at modest confidence', async () => {
  const { profile } = await inspect('plain', ['{ name: home, url: / }']);
  assert.deepEqual(profile.coverage.docs, []);
  assert.deepEqual(profile.designSystems, []);
  const primary = profile.palette.light.roles.primary;
  assert.ok(near(primary.value, '#0645ad'), primary.value);
  assert.notEqual(primary.level, 'high', 'a single link colour is not strong brand evidence');
  for (const role of ['background', 'text']) assert.equal(profile.palette.light.roles[role].basis, 'observed');
});

test('class-toggled dark theme is reported as unverified, not invented', async () => {
  const { profile } = await inspect('classdark', ['{ name: home, url: / }']);
  assert.equal(profile.coverage.themes.dark, 'unverified');
  assert.equal(profile.palette.dark, null);
  assert.ok(profile.unverified.some((u) => /Dark theme/.test(u)));
});

test('unreachable site: nothing observed, profile still valid and honest', async () => {
  const { profile, md } = await inspect('forest', ['{ name: home, url: / }'], { baseUrl: 'http://127.0.0.1:9' });
  assert.equal(profile.coverage.status, 'not rendered');
  assert.equal(profile.coverage.routes[0].status, 'unreachable');
  // Declared values may appear, but only as "declared", never as "observed".
  const primary = profile.palette.light.roles.primary;
  assert.equal(primary.basis, 'declared');
  assert.ok(primary.confidence <= 0.6);
  assert.match(JSON.stringify(profile.palette), /"basis":"declared"/);
  assert.doesNotMatch(JSON.stringify(profile.palette), /"basis":"observed"/);
  assert.ok(profile.unverified.some((u) => /No page could be rendered/.test(u)));
  assert.match(md, /not rendered/);
});

test('auth-protected route without a saved session is skipped and reported', async () => {
  const { profile } = await inspect('forest', ['{ name: home, url: / }', '{ name: app, url: /pricing.html, auth: true }'], { source: false });
  const app = profile.coverage.routes.find((r) => r.url === '/pricing.html');
  assert.equal(app.status, 'auth required');
  assert.equal(profile.coverage.status, 'partial');
  assert.ok(profile.unverified.some((u) => u.startsWith('/pricing.html: auth required')));
  assert.ok(profile.unverified.some((u) => /--no-source/.test(u)));
});

test('repeated inspection produces a byte-identical profile', async () => {
  const a = await inspect('forest', ['{ name: home, url: / }']);
  const b = await inspect('forest', ['{ name: home, url: / }']);
  assert.equal(a.json, b.json);
});
