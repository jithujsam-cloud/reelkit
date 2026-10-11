import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, NAME } from './brand.mjs';
import { ReelkitError, log } from './log.mjs';
import { discover } from './discover.mjs';
import { ensureGitignore } from './fsutil.mjs';
import { validateConfig } from './config.mjs';
import YAML from 'yaml';

const q = (s) => JSON.stringify(s);

export function draftConfig({ url, root, name }) {
  const found = discover(root);
  const candidates = found.routes.filter((r) => !r.dynamic && r.route !== found.login && !/sign-?up|register|forgot|reset|logout/.test(r.route));
  const scenes = candidates.slice(0, 6);
  if (!scenes.length) scenes.push({ route: '/', likelyAuth: false });
  const hasAuth = scenes.some((s) => s.likelyAuth);
  const slug = (r) => (r === '/' ? 'home' : r.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase());
  const lines = [
    `# ${NAME} config. Drafted by \`${NAME} init\` from ${found.framework} routes; review before shooting.`,
    `# Full reference: reference/config.md in the ${NAME} skill. Validate with: ${NAME} verify --config-only`,
    `# yaml-language-server: $schema=https://raw.githubusercontent.com/jithujsam-cloud/reelkit/main/skills/reelkit/schema/reelkit.schema.json`,
    '',
    `name: ${q(name)}`,
    `baseUrl: ${q(url)}          # deployed URL; may use \${ENV_VAR}`,
    'output: docs/media',
    '',
    'defaults:',
    '  viewports: [desktop, mobile]   # mobile 390x844 · tablet 820x1180 · desktop 1440x900 · wide 1920x1080',
    '  theme: light                   # light | dark | both',
    '  outputs: [still, framed]',
    '  mask: []                       # selectors to blur everywhere (emails, names, API keys)',
    '',
  ];
  if (hasAuth || found.login) {
    lines.push(
      'auth:',
      '  mode: manual                   # manual (you log in in a real window) | form (env vars) | token (preview login URL)',
      `  loginUrl: ${q(found.login ?? '/login')}`,
      '  # form: { email: "#email", password: "#password", submit: "button[type=submit]" }  # uses REELKIT_EMAIL / REELKIT_PASSWORD',
      '',
    );
  }
  lines.push('scenes:');
  for (const s of scenes) {
    lines.push(`  - name: ${slug(s.route)}`, `    url: ${q(s.route)}`);
    if (s.likelyAuth) lines.push('    auth: true');
    lines.push(`    # waitFor: { text: "…" }       # something that only shows once real data is on screen`);
  }
  lines.push(
    '',
    '  # A demo flow recorded as GIF + MP4 (uncomment and adapt):',
    '  # - name: create-flow',
    `  #   url: ${q(scenes.find((s) => s.likelyAuth)?.route ?? '/')}`,
    hasAuth ? '  #   auth: true' : '  #   auth: false',
    '  #   viewports: [desktop]',
    '  #   outputs: [mp4, gif, framed]',
    '  #   actions:',
    '  #     - click: "text=New"',
    '  #     - type: { into: "#name", text: "Q4 Outbound" }',
    '  #     - click: "text=Create"',
    '',
    'marketing:',
    `  hero: ${slug(scenes[0].route)}`,
    `  social: { scene: ${slug(scenes[0].route)}, title: ${q(name)} }`,
    '',
  );
  const text = lines.join('\n');
  validateConfig(YAML.parse(text));
  return { text, found };
}

export function init({ root, url, force, name }) {
  if (!url) throw new ReelkitError('init needs the deployed URL.', `Run \`${NAME} init --url https://your-app.example.com\``);
  if (!/^https?:\/\//.test(url)) throw new ReelkitError(`"${url}" is not a URL.`, 'Pass a full URL including https://');
  const file = path.join(root, CONFIG_FILE);
  if (existsSync(file) && !force) throw new ReelkitError(`${CONFIG_FILE} already exists.`, 'Edit it, or pass --force to overwrite.');
  const { text, found } = draftConfig({ url, root, name: name ?? path.basename(root) });
  writeFileSync(file, text);
  const added = ensureGitignore(root);
  log.ok(`Wrote ${CONFIG_FILE} (${found.framework}, ${found.routes.length} routes found).`);
  if (added.length) log.ok(`Added ${added.join(', ')} to .gitignore.`);
  return { file, text };
}
