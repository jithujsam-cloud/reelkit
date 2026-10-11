// Where direction files live, and atomic canonical reads/writes.
//   .reelkit/design/directions/   working files (git-ignored): candidates, state, previews, compare.html
//   reelkit.direction.json        the approved direction (project root, committable, canonical)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WORK_DIR } from '../brand.mjs';
import { ReelkitError } from '../log.mjs';
import { canonical, validate } from './schema.mjs';

export const APPROVED_FILE = 'reelkit.direction.json';

export function paths(root) {
  const design = path.join(root, WORK_DIR, 'design');
  const dir = path.join(design, 'directions');
  return {
    root,
    design,
    profile: path.join(design, 'design-profile.json'),
    profileMd: path.join(design, 'design-profile.md'),
    dir,
    candidates: path.join(dir, 'candidates.json'),
    state: path.join(dir, 'state.json'),
    previewsDir: path.join(dir, 'previews'),
    previews: path.join(dir, 'previews.json'),
    compare: path.join(dir, 'compare.html'),
    approved: path.join(root, APPROVED_FILE),
  };
}

export function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export const writeCanonical = (file, obj) => writeAtomic(file, canonical(obj));

/** Read + parse + (optionally) validate against a schema definition. Missing → null; corrupt → ReelkitError. */
export function readFile(file, definition) {
  if (!existsSync(file)) return null;
  let obj;
  try {
    obj = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ReelkitError(`${path.basename(file)} is not valid JSON (${err.message.split('\n')[0]}).`, `Fix or delete ${path.relative(process.cwd(), file) || file} and re-run the command that creates it.`);
  }
  if (definition) {
    const problems = validate(definition, obj);
    if (problems.length) throw new ReelkitError(`${path.basename(file)} is invalid:\n  ${problems.slice(0, 6).join('\n  ')}`, `Fix the fields above, or delete the file and re-run the command that creates it.`);
  }
  return obj;
}
