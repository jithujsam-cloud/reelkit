import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.svelte-kit', '.astro', '.output', '.vercel', 'coverage', '.turbo', '.reelkit']);

function walk(dir, out = [], depth = 0) {
  if (depth > 12 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
  return out;
}

const toPosix = (p) => p.split(path.sep).join('/');

function route(segments) {
  const r = '/' + segments.filter(Boolean).join('/');
  return r === '/' ? '/' : r.replace(/\/+$/, '');
}

const isDynamic = (r) => /\[|\$|:/.test(r);

function nextApp(root, appDir) {
  const routes = [];
  for (const f of walk(appDir)) {
    const relp = toPosix(path.relative(appDir, f));
    if (!/(^|\/)page\.(t|j)sx?$|(^|\/)page\.mdx?$/.test(relp)) continue;
    const segs = relp.split('/').slice(0, -1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@') && !s.startsWith('_'));
    if (segs[0] === 'api') continue;
    routes.push({ route: route(segs), file: toPosix(path.relative(root, f)) });
  }
  return routes;
}

function nextPages(root, pagesDir) {
  const routes = [];
  for (const f of walk(pagesDir)) {
    const relp = toPosix(path.relative(pagesDir, f));
    if (!/\.(t|j)sx?$|\.mdx?$/.test(relp) || relp.startsWith('api/') || /(^|\/)_(app|document|error)\./.test(relp) || /^(404|500)\./.test(relp)) continue;
    const segs = relp.replace(/\.(t|j)sx?$|\.mdx?$/, '').split('/');
    if (segs[segs.length - 1] === 'index') segs.pop();
    routes.push({ route: route(segs), file: toPosix(path.relative(root, f)) });
  }
  return routes;
}

function sveltekit(root, dir) {
  return walk(dir)
    .filter((f) => /\+page\.svelte$/.test(f))
    .map((f) => {
      const segs = toPosix(path.relative(dir, f)).split('/').slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
      return { route: route(segs), file: toPosix(path.relative(root, f)) };
    });
}

function remix(root, dir) {
  return walk(dir)
    .filter((f) => /\.(t|j)sx?$/.test(f) && path.dirname(f) === dir || /route\.(t|j)sx?$/.test(f))
    .map((f) => {
      let name = toPosix(path.relative(dir, f)).replace(/\/route\.(t|j)sx?$/, '').replace(/\.(t|j)sx?$/, '');
      if (name.startsWith('api.') || name.startsWith('resources.') || name === 'root') return null;
      const segs = name
        .split('.')
        .filter((s) => s !== '_index' && !s.startsWith('_'))
        .map((s) => s.replace(/_$/, ''));
      return { route: route(segs), file: toPosix(path.relative(root, f)) };
    })
    .filter(Boolean);
}

function astro(root, dir) {
  return walk(dir)
    .filter((f) => /\.(astro|md|mdx)$/.test(f))
    .map((f) => {
      const segs = toPosix(path.relative(dir, f)).replace(/\.(astro|mdx?)$/, '').split('/');
      if (segs[segs.length - 1] === 'index') segs.pop();
      return { route: route(segs), file: toPosix(path.relative(root, f)) };
    });
}

function reactRouter(root) {
  const routes = [];
  const src = path.join(root, 'src');
  for (const f of walk(existsSync(src) ? src : root)) {
    if (!/\.(t|j)sx?$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    if (!/react-router/.test(text)) continue;
    for (const m of text.matchAll(/path\s*[:=]\s*\{?\s*["'`]([^"'`]+)["'`]/g)) {
      if (m[1] === '*') continue;
      routes.push({ route: m[1].startsWith('/') ? m[1] : `/${m[1]}`, file: toPosix(path.relative(root, f)) });
    }
  }
  return routes;
}

function plainHtml(root) {
  return walk(root)
    .filter((f) => f.endsWith('.html'))
    .map((f) => {
      const r = toPosix(path.relative(root, f)).replace(/index\.html$/, '').replace(/\.html$/, '');
      return { route: route(r.split('/')), file: toPosix(path.relative(root, f)) };
    });
}

export function detectFramework(root) {
  const pkg = existsSync(path.join(root, 'package.json')) ? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (d) => !!deps[d];
  const first = (...dirs) => dirs.map((d) => path.join(root, d)).find((d) => existsSync(d));
  if (has('next')) {
    const app = first('app', 'src/app');
    const pages = first('pages', 'src/pages');
    const routes = [...(app ? nextApp(root, app) : []), ...(pages ? nextPages(root, pages) : [])];
    return { framework: app ? 'next (app router)' : 'next (pages router)', routes };
  }
  if (has('@sveltejs/kit')) return { framework: 'sveltekit', routes: sveltekit(root, path.join(root, 'src', 'routes')) };
  if (has('@remix-run/react') || has('@react-router/dev')) {
    const dir = first('app/routes');
    if (dir) return { framework: has('@remix-run/react') ? 'remix' : 'react-router (framework)', routes: remix(root, dir) };
  }
  if (has('astro')) return { framework: 'astro', routes: astro(root, path.join(root, 'src', 'pages')) };
  if (has('react-router-dom') || has('react-router')) return { framework: 'react-router', routes: reactRouter(root) };
  return { framework: 'static html', routes: plainHtml(root) };
}

const PUBLIC = /^\/($|login|signin|sign-in|signup|sign-up|register|pricing|about|blog|docs|terms|privacy|contact|features|forgot|reset)/;
const LOGIN = /^\/(login|signin|sign-in|auth\/login|auth\/signin)$/;

export function discover(root) {
  const { framework, routes } = detectFramework(root);
  const seen = new Set();
  const unique = routes.filter((r) => (seen.has(r.route) ? false : seen.add(r.route)));
  unique.sort((a, b) => a.route.split('/').length - b.route.split('/').length || a.route.localeCompare(b.route));
  const login = unique.find((r) => LOGIN.test(r.route))?.route ?? null;
  return {
    framework,
    login,
    routes: unique.map((r) => ({
      ...r,
      dynamic: isDynamic(r.route),
      likelyAuth: !!login && !PUBLIC.test(r.route),
    })),
  };
}
