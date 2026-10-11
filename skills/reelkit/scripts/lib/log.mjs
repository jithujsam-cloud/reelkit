import { NAME } from './brand.mjs';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
};

// Values that must never reach the terminal (passwords, tokens). Filled by env.mjs.
const secrets = new Set();
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 4) secrets.add(value);
}
export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('••••••');
  return out;
}

let quiet = false;
export function setQuiet(q) {
  quiet = q;
}

const write = (stream, msg) => stream.write(redact(msg) + '\n');
export const log = {
  info: (m) => !quiet && write(process.stdout, m),
  step: (m) => !quiet && write(process.stdout, `${c.cyan('›')} ${m}`),
  ok: (m) => !quiet && write(process.stdout, `${c.green('✓')} ${m}`),
  warn: (m) => write(process.stderr, `${c.yellow('!')} ${m}`),
  fail: (m) => write(process.stderr, `${c.red('✗')} ${m}`),
  dim: (m) => !quiet && write(process.stdout, c.dim(m)),
};

/** An error that carries a one-line fix. The CLI prints both and exits non-zero. */
export class ReelkitError extends Error {
  constructor(message, fix, { code = 1 } = {}) {
    super(message);
    this.fix = fix;
    this.exitCode = code;
  }
}

export class AuthExpiredError extends ReelkitError {
  constructor(detail) {
    super(
      `Session expired or missing (${detail}). Refusing to capture a login screen.`,
      `Run \`${NAME} auth\` to sign in again, then re-run this command.`,
      { code: 3 },
    );
  }
}
