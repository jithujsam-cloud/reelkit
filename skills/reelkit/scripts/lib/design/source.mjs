// Static scan of the project's own files for declared design decisions. Never executes project code:
// everything is read as text and matched conservatively. Results are "declared" evidence, which can be
// stale; reconciliation weighs them below what the rendered site shows.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseHex, toHex } from '../color.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.astro', '.output', '.vercel', '.turbo', 'dist', 'build', 'out', 'coverage', '.reelkit', 'media', 'vendor']);
const MAX_FILES = 400;
const MAX_BYTES = 400_000;

const DOC_NAMES = /^(design|brand|branding|style-?guide|styleguide|design-?system|visual-identity)(\.[a-z]+)?\.md$/i;

function walk(root, out = [], depth = 0, exclude = []) {
  if (exclude.some((x) => root === x || root.startsWith(x + path.sep))) return out;
  if (depth > 8 || out.length >= MAX_FILES || !existsSync(root)) return out;
  let entries;
  try {
    entries = readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    if (out.length >= MAX_FILES) break;
    if (SKIP_DIRS.has(name) || name.startsWith('.') && name !== '.storybook') continue;
    const p = path.join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out, depth + 1, exclude);
    else if (st.size <= MAX_BYTES) out.push(p);
  }
  return out;
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

/** Normalise #rgb / #rrggbb / #rrggbbaa to #rrggbb, else null. */
export function normHex(s) {
  const m = String(s).match(/^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i);
  return m ? toHex(parseHex(`#${m[1]}`)) : null;
}

const ROLE_WORDS = [
  ['primary', /\b(primary|brand|main)\b/i],
  ['accent', /\b(accent|secondary|highlight|tertiary)\b/i],
  ['background', /\b(background|bg|canvas|page)\b/i],
  ['surface', /\b(surface|card|panel|elevated)\b/i],
  ['text', /\b(text|foreground|fg|ink|body copy)\b/i],
  ['textMuted', /\b(muted|subtle|secondary text|caption)\b/i],
  ['border', /\b(border|divider|stroke|hairline|outline)\b/i],
  ['success', /\b(success|positive)\b/i],
  ['warning', /\b(warning|caution)\b/i],
  ['danger', /\b(danger|error|destructive|negative)\b/i],
];

/** Best-guess role from a token/label name. Most specific match wins (muted before text). */
export function roleFromName(name) {
  const s = String(name).replace(/[-_.]/g, ' ');
  if (/\b(muted|subtle)\b/i.test(s) && /\b(text|foreground|fg)\b/i.test(s)) return 'textMuted';
  if (/\b(primary|brand)\b/i.test(s) && /\b(foreground|fg|text)\b/i.test(s)) return null; // text-on-primary, not the brand colour
  for (const [role, re] of ROLE_WORDS) if (re.test(s)) return role;
  return null;
}

/** Minimal CSS reader: custom properties with their selector and whether they sit in a dark context. */
export function cssCustomProperties(css) {
  const out = [];
  const stack = [];
  let buf = '';
  let i = 0;
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      // Declarations accumulated in `buf` belong to the innermost block.
      const selector = stack[stack.length - 1] ?? '';
      const media = stack.slice(0, -1).filter((p) => p.startsWith('@')).join(' ');
      for (const decl of buf.split(';')) {
        const m = decl.match(/^\s*(--[\w-]+)\s*:\s*([^;]+)$/);
        if (m) {
          out.push({
            name: m[1],
            value: m[2].trim(),
            selector,
            dark: /prefers-color-scheme:\s*dark/i.test(media) || /(\.dark|theme-dark|\[data-theme=["']?dark|\[data-mode=["']?dark)/i.test(selector),
          });
        }
      }
      stack.pop();
      buf = '';
    } else if (ch === ';' && !stack.length) {
      buf = '';
    } else buf += ch;
    i++;
  }
  return out;
}

/** Hex colours mentioned in Markdown, each with the label text around it. */
export function docColors(md) {
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    for (const m of line.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) {
      const hex = normHex(m[0]);
      if (!hex) continue;
      const label = line
        .slice(0, m.index)
        .replace(/[`*_>#|[\]()-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/[:=—–]/)
        .filter(Boolean)
        .pop() ?? '';
      out.push({ hex, label: label.trim().slice(-60), line: line.trim().slice(0, 140) });
    }
  }
  return out;
}

/** Font families named in Markdown ("Font: Geist", "Typeface — Söhne", `font-family: X`). */
export function docFonts(md) {
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/\b(font(?:-family)?|typeface|typography|heading font|body font|display font)\b[^:=—–]*[:=—–]\s*[`"']?(\p{Lu}[\p{L}\p{N} ._-]{1,40}?)[`"']?(?:[,;(]|\s{2}|$)/iu);
    if (m) {
      const role = /head|display|title/i.test(line) ? 'heading' : /body|text|paragraph/i.test(line) ? 'body' : /mono|code/i.test(line) ? 'mono' : 'any';
      out.push({ family: m[2].trim(), role, line: line.trim().slice(0, 140) });
    }
  }
  return out;
}

const DESIGN_SYSTEMS = [
  ['@mui/material', 'Material UI'],
  ['@chakra-ui/react', 'Chakra UI'],
  ['@mantine/core', 'Mantine'],
  ['@radix-ui/themes', 'Radix Themes'],
  ['antd', 'Ant Design'],
  ['bootstrap', 'Bootstrap'],
  ['@carbon/react', 'Carbon'],
  ['@shopify/polaris', 'Polaris'],
  ['@primer/css', 'Primer'],
  ['@primer/react', 'Primer'],
  ['@fluentui/react-components', 'Fluent UI'],
  ['@material/web', 'Material Web'],
  ['vuetify', 'Vuetify'],
  ['daisyui', 'daisyUI'],
  ['tailwindcss', 'Tailwind CSS'],
];

/**
 * Scan a project directory. Returns declared colours (with role guesses), fonts, design-system hints
 * and the list of files consulted.
 */
export function scanProject(root, { exclude = [] } = {}) {
  const result = { root, files: [], docs: [], colors: [], fonts: [], designSystems: [], manifests: [] };
  if (!root || !existsSync(root)) return result;
  const abs = path.resolve(root);
  // Exclusions only prune folders below the scanned root; an excluded ancestor never hides the root itself.
  const excluded = exclude.filter(Boolean).map((x) => path.resolve(x)).filter((x) => x !== abs && !abs.startsWith(x + path.sep));
  for (const file of walk(abs, [], 0, excluded)) {
    const name = path.basename(file);
    if (/^design-profile\.(md|json)$/i.test(name)) continue; // never read a previous profile back in
    const r = rel(root, file);
    const ext = path.extname(file).toLowerCase();
    let text;
    const read = () => (text ??= readFileSync(file, 'utf8'));
    try {
      if (DOC_NAMES.test(name) || (/\.md$/i.test(name) && /(^|\/)docs?\//i.test(r) && /(design|brand|style|token|color|colour|typograph)/i.test(name))) {
        result.docs.push(r);
        result.files.push(r);
        for (const c of docColors(read())) result.colors.push({ hex: c.hex, role: roleFromName(c.label), name: c.label || null, type: 'docs', detail: `${r}: ${c.line}` });
        for (const f of docFonts(read())) result.fonts.push({ family: f.family, role: f.role, type: 'docs', detail: `${r}: ${f.line}` });
      } else if (['.css', '.scss', '.pcss', '.less'].includes(ext)) {
        const props = cssCustomProperties(read());
        if (!props.length) continue;
        result.files.push(r);
        for (const p of props) {
          const hex = normHex(p.value);
          if (hex) result.colors.push({ hex, role: roleFromName(p.name), name: p.name, dark: p.dark, type: 'source-css', detail: `${r}: ${p.selector} { ${p.name}: ${p.value} }` });
        }
        for (const m of read().matchAll(/@font-face\s*{[^}]*font-family\s*:\s*["']?([^;"']+)/gi)) result.fonts.push({ family: m[1].trim(), role: 'any', type: 'source-css', detail: `${r}: @font-face` });
      } else if (/^tailwind\.config\.(c|m)?(js|ts)$/.test(name)) {
        result.files.push(r);
        for (const m of read().matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8})['"]/g)) {
          const hex = normHex(m[2]);
          if (hex) result.colors.push({ hex, role: roleFromName(m[1]), name: m[1], type: 'source-tokens', detail: `${r}: ${m[1]}: '${m[2]}'` });
        }
      } else if (/tokens?\.json$/i.test(name)) {
        result.files.push(r);
        const visit = (node, trail) => {
          if (!node || typeof node !== 'object') return;
          const v = node.$value ?? node.value;
          if (typeof v === 'string' && normHex(v)) {
            const tokenName = trail.join('.');
            result.colors.push({ hex: normHex(v), role: roleFromName(tokenName), name: tokenName, type: 'source-tokens', detail: `${r}: ${tokenName}` });
          }
          for (const [k, child] of Object.entries(node)) if (!k.startsWith('$') && typeof child === 'object') visit(child, [...trail, k]);
        };
        visit(JSON.parse(read()), []);
      } else if (name === 'package.json' && !r.includes('/')) {
        const pkg = JSON.parse(read());
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [dep, label] of DESIGN_SYSTEMS) if (deps[dep]) result.designSystems.push({ name: label, detail: `package.json: ${dep}` });
        for (const dep of Object.keys(deps).filter((d) => d.startsWith('@fontsource/')).sort()) {
          result.fonts.push({ family: dep.replace('@fontsource/', '').replace(/-/g, ' '), role: 'any', type: 'source-tokens', detail: `package.json: ${dep}` });
        }
        result.files.push(r);
      } else if (name === 'components.json' && read().includes('shadcn')) {
        result.designSystems.push({ name: 'shadcn/ui', detail: `${r}` });
        result.files.push(r);
      } else if (/\.(m?[jt]sx?)$/.test(ext) && /(layout|_app|_document|root|fonts?)\./i.test(name)) {
        const m = read().match(/import\s*{([^}]+)}\s*from\s*['"]next\/font\/google['"]/);
        if (m) {
          result.files.push(r);
          for (const f of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
            result.fonts.push({ family: f.replace(/_/g, ' '), role: 'any', type: 'source-tokens', detail: `${r}: next/font/google ${f}` });
          }
        }
      } else if (/^(site\.webmanifest|manifest\.(json|webmanifest))$/.test(name)) {
        const mf = JSON.parse(read());
        result.manifests.push({ file: r, theme_color: mf.theme_color ?? null, background_color: mf.background_color ?? null });
        result.files.push(r);
      }
    } catch {
      // Unreadable or unparsable files are skipped; scanning is best-effort by design.
    }
  }
  result.files = [...new Set(result.files)].sort();
  result.designSystems = result.designSystems.filter((d, i, a) => a.findIndex((x) => x.name === d.name) === i);
  return result;
}
