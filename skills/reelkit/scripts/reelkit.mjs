#!/usr/bin/env node
// reelkit CLI entry. Uses only Node built-ins until dependencies are confirmed present,
// so the very first run can install them itself.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`✗ Node ${process.versions.node} is too old.\n  fix: install Node 18.17+ (https://nodejs.org or \`nvm install --lts\`)`);
  process.exit(1);
}

const needed = ['playwright', 'pixelmatch', 'pngjs', 'yaml', 'ajv'];
if (needed.some((d) => !existsSync(path.join(skillDir, 'node_modules', d, 'package.json')))) {
  console.log('› First run: installing dependencies into the skill folder (npm install)…');
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: skillDir,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
  if (r.status !== 0) {
    console.error(`✗ npm install failed in ${skillDir}\n  fix: run \`npm install\` there manually and check network access to the npm registry.`);
    process.exit(1);
  }
}

const { main } = await import('./lib/cli.mjs');
await main(process.argv.slice(2));
