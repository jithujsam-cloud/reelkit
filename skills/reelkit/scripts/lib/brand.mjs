// The one place the project name lives. Rename the tool by changing NAME.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const NAME = 'reelkit';
export const ENV_PREFIX = NAME.toUpperCase().replace(/[^A-Z0-9]/g, '_');
export const WORK_DIR = `.${NAME}`;
export const CONFIG_FILE = `${NAME}.config.yaml`;
export const MARK_START = `<!-- ${NAME}:start -->`;
export const MARK_END = `<!-- ${NAME}:end -->`;

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATES_DIR = path.join(SKILL_DIR, 'templates');
export const SCHEMA_PATH = path.join(SKILL_DIR, 'schema', `${NAME}.schema.json`);

export const VERSION = JSON.parse(readFileSync(path.join(SKILL_DIR, 'package.json'), 'utf8')).version;

export const env = (key) => `${ENV_PREFIX}_${key}`;
