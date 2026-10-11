import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv from 'ajv';
import { CONFIG_FILE, NAME, SCHEMA_PATH, WORK_DIR } from './brand.mjs';
import { ReelkitError } from './log.mjs';
import { expandEnv } from './env.mjs';

export const VIEWPORTS = {
  mobile: { name: 'mobile', width: 390, height: 844, mobile: true, device: 'phone' },
  tablet: { name: 'tablet', width: 820, height: 1180, mobile: false, touch: true, device: 'tablet' },
  desktop: { name: 'desktop', width: 1440, height: 900, mobile: false, device: 'browser' },
  wide: { name: 'wide', width: 1920, height: 1080, mobile: false, device: 'laptop' },
};

const DEFAULTS = {
  output: 'docs/media',
  concurrency: 3,
  headers: {},
  defaults: { viewports: ['desktop'], theme: 'light', deviceScaleFactor: 2, outputs: ['still', 'framed'], hide: [], mask: [] },
  determinism: { time: '2026-01-15T09:30:00Z', locale: 'en-US', timezone: 'UTC', hideBuiltins: true, seed: 7 },
  stability: {
    timeout: 15000,
    retries: 3,
    networkQuietMs: 500,
    diffThreshold: 0.0005,
    diffInterval: 400,
    consecutiveMatches: 2,
    busySelectors: [],
    allowInfinite: [],
    ignoreRequests: [],
    scrollLazy: true,
  },
  auth: { mode: 'none', loggedOutSelector: 'input[type=password]', storageState: `${WORK_DIR}/auth.json` },
  motion: { fps: 30, cursor: true, zoom: false, maxHold: 0.7, startHold: 0.8, endHold: 1.6, loop: true, typingDelay: [45, 120], cursorSpeed: 1 },
  gif: { width: 960, fps: 15, quality: 90, maxBytes: 5_000_000, encoder: 'auto' },
  frame: { background: 'aurora', backgroundDark: 'midnight', accent: '#7c5cff', padding: 72, radius: 12, shadow: true },
  marketing: {},
  readme: { file: 'README.md' },
};

const FORM_DEFAULTS = {
  email: 'input[type=email], input[name=email], input[name=username]',
  password: 'input[type=password]',
  submit: 'button[type=submit]',
  emailEnv: 'REELKIT_EMAIL',
  passwordEnv: 'REELKIT_PASSWORD',
};

function merge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

export function findConfig(explicit, cwd = process.cwd()) {
  const file = path.resolve(cwd, explicit || CONFIG_FILE);
  if (!existsSync(file)) {
    throw new ReelkitError(
      `No ${path.basename(file)} found in ${path.dirname(file)}.`,
      `Run \`${NAME} init --url <your deployed URL>\` to draft one.`,
    );
  }
  return file;
}

let ajv;
function validator() {
  if (!ajv) ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
}

export function validateConfig(raw, file = CONFIG_FILE) {
  const validate = validator();
  if (validate(raw)) return;
  const lines = validate.errors
    // oneOf branches produce noisy duplicates; keep the most specific ones.
    .filter((e) => e.keyword !== 'oneOf' && e.keyword !== 'if')
    .slice(0, 8)
    .map((e) => {
      const at = e.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(root)';
      const extra = e.params?.additionalProperty ? ` "${e.params.additionalProperty}"` : e.params?.allowedValues ? `: ${e.params.allowedValues.join(', ')}` : '';
      return `  ${at}: ${e.message}${extra}`;
    });
  throw new ReelkitError(`${path.basename(file)} is invalid:\n${[...new Set(lines)].join('\n')}`, `Fix the fields above (see reference/config.md).`);
}

export function loadConfig(explicit, cwd = process.cwd()) {
  const file = findConfig(explicit, cwd);
  let raw;
  try {
    raw = YAML.parse(readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    throw new ReelkitError(`${path.basename(file)} is not valid YAML: ${e.message.split('\n')[0]}`, 'Check indentation and quoting around the reported line.');
  }
  validateConfig(raw, file);
  const cfg = merge(DEFAULTS, raw);
  if (cfg.auth.mode === 'form') cfg.auth.form = { ...FORM_DEFAULTS, ...(raw.auth?.form ?? {}) };
  cfg.root = path.dirname(file);
  cfg.file = file;
  cfg.workDir = path.join(cfg.root, WORK_DIR);
  cfg.outDir = path.resolve(cfg.root, cfg.output);
  cfg.authFile = path.resolve(cfg.root, cfg.auth.storageState);
  const names = new Set();
  for (const s of cfg.scenes) {
    if (names.has(s.name)) throw new ReelkitError(`Duplicate scene name "${s.name}".`, 'Scene names must be unique (they become file names).');
    names.add(s.name);
  }
  return cfg;
}

export function resolveBaseUrl(cfg) {
  const url = expandEnv(cfg.baseUrl, 'baseUrl').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new ReelkitError(`baseUrl must start with http(s):// (got "${url}").`, 'Set baseUrl to your deployed URL, e.g. https://app.example.com');
  return url;
}

export function absoluteUrl(cfg, url) {
  const expanded = expandEnv(url, 'url');
  if (/^https?:\/\//.test(expanded)) return expanded;
  return resolveBaseUrl(cfg) + (expanded.startsWith('/') ? expanded : `/${expanded}`);
}

export function resolveViewport(v, cfg) {
  const base = typeof v === 'string' ? VIEWPORTS[v] : { mobile: false, device: v.width < 600 ? 'phone' : v.width < 1100 ? 'tablet' : 'browser', ...v };
  return { deviceScaleFactor: cfg.defaults.deviceScaleFactor, ...base };
}

/** Normalise a scene: fill defaults so downstream code never checks for undefined. */
export function resolveScene(scene, cfg) {
  const d = cfg.defaults;
  const s = {
    theme: d.theme,
    auth: false,
    hide: [],
    mask: [],
    actions: [],
    ...scene,
  };
  s.viewports = (scene.viewports ?? d.viewports).map((v) => resolveViewport(v, cfg));
  s.outputs = scene.outputs ?? d.outputs;
  s.hide = [...d.hide, ...s.hide];
  s.mask = [...d.mask, ...s.mask];
  s.waitFor = scene.waitFor ?? d.waitFor;
  s.stability = { ...cfg.stability, ...(scene.stability ?? {}) };
  s.themes = s.theme === 'both' ? ['light', 'dark'] : [s.theme];
  s.title = s.title ?? s.name.replace(/-/g, ' ').replace(/^./, (m) => m.toUpperCase());
  s.isMotion = s.outputs.includes('gif') || s.outputs.includes('mp4');
  s.isStill = s.outputs.includes('still') || s.outputs.includes('fullpage') || (!s.isMotion && s.outputs.includes('framed'));
  return s;
}

export function selectScenes(cfg, only) {
  const all = cfg.scenes.map((s) => resolveScene(s, cfg));
  if (!only || only.length === 0) return all;
  const wanted = new Set(only.flatMap((o) => o.split(',')).map((o) => o.trim()).filter(Boolean));
  const unknown = [...wanted].filter((w) => !all.some((s) => s.name === w));
  if (unknown.length) {
    throw new ReelkitError(`Unknown scene(s): ${unknown.join(', ')}.`, `Available: ${all.map((s) => s.name).join(', ')}`);
  }
  return all.filter((s) => wanted.has(s.name));
}

/** Expand a scene into concrete captures (one per viewport × theme). */
export function shotsFor(scene) {
  const shots = [];
  for (const viewport of scene.viewports) {
    for (const theme of scene.themes) {
      shots.push({ scene, viewport, theme, id: `${scene.name}-${viewport.name}-${theme}` });
    }
  }
  return shots;
}

export { merge };
