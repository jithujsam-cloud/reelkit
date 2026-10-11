import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ReelkitError, registerSecret } from './log.mjs';

/** Minimal .env loader: KEY=VALUE lines, optional quotes, never overrides real env. */
export function loadDotEnv(cwd = process.cwd()) {
  const file = path.join(cwd, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/**
 * Expand ${VAR} and ${VAR:-default} from the environment. Every expanded value is
 * registered as a secret so it is redacted from all output.
 */
export function expandEnv(value, where = 'config') {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const v = process.env[name] ?? fallback;
    if (v === undefined || v === '') {
      throw new ReelkitError(
        `${where} references \${${name}} but it is not set.`,
        `Add ${name}=… to .env (git-ignored) or export it in your shell.`,
      );
    }
    if (process.env[name] !== undefined) registerSecret(v);
    return v;
  });
}

export function expandEnvDeep(obj, where) {
  if (Array.isArray(obj)) return obj.map((v) => expandEnvDeep(v, where));
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expandEnvDeep(v, `${where}.${k}`)]));
  }
  return expandEnv(obj, where);
}
