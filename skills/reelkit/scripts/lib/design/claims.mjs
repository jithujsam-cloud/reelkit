// "Claims": what the project's own files say about its design (design docs, token files, Tailwind
// config, stylesheets). They are lower-priority evidence than what the rendered page shows, because
// docs rot. Extraction is heuristic and line-based; every claim keeps its file and line.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { walk } from '../discover.mjs';
import { findColorLiterals, parseCssColor } from './css-color.mjs';
import { toHex } from '../color.mjs';
import { fontsourceFamily, normalizeFontFamily } from './fontnames.mjs';

/** Map a variable/key/label to a colour role, or null when it is not one we track. */
export function roleFromName(raw) {
  const n = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!n) return null;
  const w = new Set(n.split(' '));
  const has = (...ks) => ks.some((k) => w.has(k));
  if (has('on', 'contrast', 'inverse') && has('primary', 'brand', 'accent', 'secondary')) return null;
  if (has('foreground', 'fg') && has('primary', 'brand', 'accent', 'secondary', 'card', 'popover')) return null;
  if (has('muted', 'secondary', 'subtle', 'tertiary') && has('foreground', 'text', 'fg', 'ink')) return 'textMuted';
  if (has('accent')) return 'accent';
  if (has('primary', 'brand')) return 'primary';
  if (has('secondary')) return 'secondary';
  if (has('destructive', 'danger', 'error')) return 'danger';
  if (has('success', 'positive')) return 'success';
  if (has('warning')) return 'warning';
  if (has('border', 'outline', 'divider')) return 'border';
  if (has('card', 'surface', 'panel', 'popover')) return 'surface';
  if (has('foreground', 'text', 'fg', 'ink', 'body') ) return 'text';
  if (has('background', 'bg', 'canvas', 'page')) return 'background';
  return null;
}

const FONT_ROLE = (label) => (/mono|code/i.test(label) ? 'mono' : /head|display|title/i.test(label) ? 'heading' : 'body');
const GENERIC = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'cursive', 'fantasy', 'inherit', 'initial', 'var']);

/** First real family in a CSS font stack ("Inter", system-ui → Inter), or null. */
export function firstFamily(stack) {
  for (const part of String(stack).split(',')) {
    const f = part.trim().replace(/^['"`]|['"`]$/g, '');
    if (f && !GENERIC.has(f.toLowerCase()) && !f.startsWith('var(') && !f.startsWith('-apple-system') && !/^(blinkmacsystemfont|segoe ui|roboto|helvetica neue|arial)$/i.test(f)) return f;
  }
  return null;
}

const colorClaim = (role, rgba, file, line, text, via) => ({ kind: 'color', role, hex: toHex(rgba), alpha: rgba[3], file, line, text: text.trim().slice(0, 160), via });
const fontClaim = (role, family, file, line, text, via) => ({ kind: 'font', role, family, file, line, text: text.trim().slice(0, 160), via });

export function extractFromCss(src, file) {
  const out = [];
  src.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    for (const [, name, value] of text.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
      if (/font/i.test(name)) {
        const fam = firstFamily(value);
        if (fam) out.push(fontClaim(FONT_ROLE(name), fam, file, line, text, `css-variable ${name}`));
      } else {
        const role = roleFromName(name);
        const rgba = role && parseCssColor(value);
        if (rgba && rgba[3] > 0) out.push(colorClaim(role, rgba, file, line, text, `css-variable ${name}`));
      }
    }
    const ff = text.match(/(?:^|[;{\s])font-family\s*:\s*([^;}]+)/i);
    if (ff) {
      const fam = firstFamily(ff[1]);
      if (fam) out.push(fontClaim('body', fam, file, line, text, 'font-family declaration'));
    }
  });
  return out;
}

export function extractFromMarkdown(src, file) {
  const out = [];
  src.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    const lits = findColorLiterals(text);
    if (lits.length) {
      const label = text.slice(0, lits[0].index);
      const role = roleFromName(label.replace(/[`*|]/g, ' '));
      if (role) out.push(colorClaim(role, lits[0].rgba, file, line, text, 'design doc'));
    }
    const fm = text.match(/\b(heading|display|title|body|text|mono|code|font|typeface)s?\b[^:\n`'"]*[:=—–-]\s*[`'"*]*([A-Z][A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]+)*)/i);
    if (fm && !lits.length) {
      const fam = firstFamily(fm[2]);
      if (fam) out.push(fontClaim(FONT_ROLE(fm[1]), fam, file, line, text, 'design doc'));
    }
  });
  return out;
}

export function extractFromTailwind(src, file) {
  const out = [];
  src.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    const c = text.match(/['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]/);
    if (c) {
      const role = roleFromName(c[1]);
      const rgba = role && parseCssColor(c[2]);
      if (rgba) out.push(colorClaim(role, rgba, file, line, text, `tailwind ${c[1]}`));
    }
    const f = text.match(/\b(sans|serif|mono|display|heading|body)\s*:\s*\[\s*['"]([^'"]+)['"]/);
    if (f) {
      const fam = firstFamily(f[2]);
      if (fam) out.push(fontClaim(f[1] === 'sans' || f[1] === 'serif' ? 'body' : FONT_ROLE(f[1]), fam, file, line, text, `tailwind fontFamily.${f[1]}`));
    }
  });
  return out;
}

export function extractFromTokensJson(src, file) {
  const out = [];
  let data;
  try {
    data = JSON.parse(src);
  } catch {
    return out;
  }
  const visit = (node, trail) => {
    if (node && typeof node === 'object') {
      const v = node.$value ?? node.value;
      if (typeof v === 'string' && (node.$type === 'color' || node.type === 'color' || parseCssColor(v))) {
        const role = roleFromName(trail.join(' '));
        const rgba = role && parseCssColor(v);
        if (rgba) out.push(colorClaim(role, rgba, file, 0, `${trail.join('.')}: ${v}`, 'token file'));
        return;
      }
      for (const [k, child] of Object.entries(node)) visit(child, [...trail, k]);
    } else if (typeof node === 'string') {
      const rgba = parseCssColor(node);
      const role = rgba && roleFromName(trail.join(' '));
      if (role) out.push(colorClaim(role, rgba, file, 0, `${trail.join('.')}: ${node}`, 'token file'));
    }
  };
  visit(data, []);
  return out;
}


// Fonts declared by dependencies and framework helpers say "this project uses X" but not where, so
// they carry role 'any': they can corroborate an observed font and never contradict one.
const fontRoleOrAny = (label) => (/mono|code/i.test(label) ? 'mono' : /head|display|title/i.test(label) ? 'heading' : /body|sans|text/i.test(label) ? 'body' : 'any');
const monoOrAny = (family) => (/mono|code/i.test(family) ? 'mono' : 'any');

/** `@fontsource/*` and `@fontsource-variable/*` dependencies in a package.json. */
export function extractFromPackageJson(src, file) {
  let pkg;
  try {
    pkg = JSON.parse(src);
  } catch {
    return [];
  }
  const out = [];
  for (const section of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[section] ?? {}).sort()) {
      const family = fontsourceFamily(name);
      if (family) out.push(fontClaim(monoOrAny(family), family, file, 0, `${section}: ${name}`, `package.json ${name}`));
    }
  }
  return out;
}

/** next/font/google imports ("Playfair_Display" → "Playfair Display"); the variable/const name hints the role. */
export function extractFromNextFont(src, file) {
  const out = [];
  const lines = src.split(/\r?\n/);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]next\/font\/google['"]/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    for (const part of m[1].split(',')) {
      const imported = part.trim().split(/\s+as\s+/)[0].trim();
      if (!imported) continue;
      const family = normalizeFontFamily(imported).family.replace(/_/g, ' ');
      const use = src.match(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${imported}\\s*\\(([\\s\\S]*?)\\)\\s*;?`));
      const variable = use?.[2].match(/variable\s*:\s*['"](--[\w-]+)['"]/)?.[1] ?? '';
      const hinted = fontRoleOrAny(`${use?.[1] ?? ''} ${variable}`);
      out.push(fontClaim(hinted === 'any' ? monoOrAny(family) : hinted, family, file, line, lines[line - 1] ?? imported, `next/font/google ${imported}`));
    }
  }
  return out;
}

/** shadcn/ui `components.json`: no colours or fonts, but a design-system signal and the stylesheet to read. */
export function extractDesignSystemFromComponentsJson(src, file) {
  let json;
  try {
    json = JSON.parse(src);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || !(json.$schema?.includes?.('shadcn') || json.tailwind || json.aliases)) return null;
  return {
    name: 'shadcn/ui',
    file,
    details: {
      style: json.style ?? null,
      baseColor: json.tailwind?.baseColor ?? null,
      cssVariables: json.tailwind?.cssVariables ?? null,
      css: json.tailwind?.css ?? null,
      iconLibrary: json.iconLibrary ?? null,
    },
  };
}

const MAX_BYTES = 300_000;
const DESIGN_MD = /(^|\/)(design|brand|branding|style-?guide|design-system|ui-guidelines)[\w-]*\.mdx?$/i;
const TAILWIND = /(^|\/)tailwind\.config\.(js|cjs|mjs|ts)$/i;
const TOKENS = /(^|\/)(design-)?tokens\.json$|(^|\/)theme\.json$/i;
const PACKAGE_JSON = /(^|\/)package\.json$/i;
const COMPONENTS_JSON = /(^|\/)components\.json$/i;
const SOURCE_FILE = /\.(m?[jt]sx?|cjs)$/i;
const MAX_SOURCE_FILES = 600; // next/font imports live in a handful of layout files; do not read a whole monorepo

/** Scan a project directory for design documentation. Never throws: unreadable files are skipped. */
export function collectClaims(root) {
  const result = { files: [], claims: [], designSystems: [] };
  if (!root || !existsSync(root)) return result;
  const toPosix = (p) => p.split(path.sep).join('/');
  let cssSeen = 0;
  let sourcesSeen = 0;
  const seenFonts = new Set();
  for (const f of walk(root)) {
    const rel = toPosix(path.relative(root, f));
    let kind = null;
    if (DESIGN_MD.test(rel)) kind = 'md';
    else if (TAILWIND.test(rel)) kind = 'tailwind';
    else if (TOKENS.test(rel)) kind = 'tokens';
    else if (COMPONENTS_JSON.test(rel)) kind = 'components';
    else if (PACKAGE_JSON.test(rel)) kind = 'package';
    else if (/\.css$/i.test(rel) && cssSeen < 30) kind = 'css';
    else if (SOURCE_FILE.test(rel) && !/\.(test|spec|stories)\./.test(rel) && sourcesSeen < MAX_SOURCE_FILES) kind = 'source';
    if (!kind) continue;
    try {
      if (statSync(f).size > MAX_BYTES) continue;
      if (kind === 'source') sourcesSeen++;
      const src = readFileSync(f, 'utf8');
      if (kind === 'source' && !src.includes('next/font')) continue;
      if (kind === 'components') {
        const ds = extractDesignSystemFromComponentsJson(src, rel);
        if (ds) {
          result.designSystems.push(ds);
          result.files.push({ file: rel, kind, claims: 0 });
        }
        continue;
      }
      let found = { md: extractFromMarkdown, tailwind: extractFromTailwind, tokens: extractFromTokensJson, css: extractFromCss, package: extractFromPackageJson, source: extractFromNextFont }[kind](src, rel);
      if (kind === 'css' || kind === 'package' || kind === 'source') {
        if (kind === 'css' && found.length) cssSeen++;
        found = found.filter((c) => c.kind !== 'font' || !seenFonts.has(`${c.role}|${c.family.toLowerCase()}|${c.file}`));
        if (!found.length) continue;
      }
      for (const c of found) if (c.kind === 'font') seenFonts.add(`${c.role}|${c.family.toLowerCase()}|${c.file}`);
      result.files.push({ file: rel, kind, claims: found.length });
      result.claims.push(...found);
    } catch {
      /* unreadable: skip */
    }
  }
  return result;
}
