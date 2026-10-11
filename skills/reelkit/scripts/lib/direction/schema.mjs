// Validation, canonical JSON and hashing for direction files. Canonical files (candidates, approved
// direction) never contain timestamps, so identical inputs give byte-identical files and hashes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { SKILL_DIR } from '../brand.mjs';

export const SCHEMA_PATH = path.join(SKILL_DIR, 'schema', 'direction.schema.json');
export const KINDS = { candidates: 'reelkit-directions', state: 'reelkit-direction-state', approved: 'reelkit-direction', previews: 'reelkit-direction-previews' };

/** Deterministic stringify: object keys sorted recursively. */
export function canonical(value, space = 2) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value), null, space) + '\n';
}

export const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');

let ajv;
const validators = {};
function validatorFor(def) {
  if (!ajv) {
    ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addSchema(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')), 'direction');
  }
  validators[def] ??= ajv.getSchema(`direction#/definitions/${def}`);
  return validators[def];
}

function messages(errors) {
  return [...new Set((errors ?? []).filter((e) => !['oneOf', 'if'].includes(e.keyword)).map((e) => `${e.instancePath || '(root)'}: ${e.message}${e.params?.additionalProperty ? ` "${e.params.additionalProperty}"` : e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`))];
}

/** definition: 'direction' | 'candidates' | 'state' | 'approved' | 'previews'. Returns problems ([] = valid). */
export function validate(definition, value) {
  const v = validatorFor(definition);
  if (v(value)) return [];
  return messages(v.errors);
}

/** Dotted path helpers for `--set composition.single.deviceScale=0.7`. Arrays are not addressable. */
export function getPath(obj, p) {
  return p.split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), obj);
}
export function setPath(obj, p, value) {
  const keys = p.split('.');
  const out = structuredClone(obj);
  let node = out;
  for (const k of keys.slice(0, -1)) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !(k in node)) return null;
    node = node[k];
  }
  const last = keys[keys.length - 1];
  if (!node || typeof node !== 'object' || Array.isArray(node) || !(last in node)) return null;
  node[last] = value;
  return out;
}

/** CLI values arrive as strings: JSON when it parses (numbers, booleans, null), else the raw text. */
export function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
