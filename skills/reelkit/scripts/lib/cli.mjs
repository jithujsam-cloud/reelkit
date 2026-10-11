import path from 'node:path';
import { CONFIG_FILE, NAME, VERSION } from './brand.mjs';
import { ReelkitError, c, log, setQuiet } from './log.mjs';
import { loadDotEnv } from './env.mjs';
import { loadConfig, selectScenes } from './config.mjs';

const HELP = `${c.bold(NAME)} ${VERSION}: verified screenshots, framed mockups and demo GIFs for your README

Usage: ${NAME} <command> [options]

Commands
  preflight            Check Node, Chromium, ffmpeg, gifski (installs Chromium if missing)
  discover [dir]       List the app's routes (Next, SvelteKit, Remix, Astro, React Router, HTML)
  init --url <url>     Draft ${CONFIG_FILE} from discovered routes
  auth                 Save a login session (--mode manual|form|token, --check to verify only)
  shoot                Capture stills (every frame passes the stability engine)
  record               Record flows to MP4/WebM/GIF with cursor, zoom and dead-time trim
  frame                Device frames, responsive trio, social preview, hero (light + dark)
  verify               QA: automated checks, sampled frames, contact sheet, manifest
                         --mark <file>=pass|fail [--note "..."]  record a visual verdict
                         --strict  also require a visual PASS for every asset
  readme               Print the README block (--write inserts it between markers)
  all                  preflight → auth check → shoot → record → frame → verify (→ readme if markers exist)

Options
  --config <file>      Config path (default ./${CONFIG_FILE})
  --only <a,b>         Only these scenes (fast iteration)
  --ci                 Non-interactive; visual review is reported as pending, not failed
  --json               Machine-readable output where supported
  -q, --quiet          Less output
`;

function parseArgs(argv) {
  const args = { _: [], mark: [], only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else if (a === '-q' || a === '--quiet') args.quiet = true;
    else if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const key = k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const flags = ['ci', 'json', 'force', 'check', 'strict', 'write', 'headed', 'sample', 'configOnly', 'noReadme'];
      if (flags.includes(key)) args[key] = inline === undefined ? true : inline !== 'false';
      else {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new ReelkitError(`--${k} needs a value.`, `See \`${NAME} --help\`.`);
        if (key === 'mark' || key === 'only') args[key].push(v);
        else args[key] = v;
      }
    } else args._.push(a);
  }
  return args;
}

async function withBrowser(fn) {
  const { launchBrowser } = await import('./browser.mjs');
  const browser = await launchBrowser();
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

const commands = {
  async preflight() {
    const { preflight } = await import('./deps.mjs');
    await preflight({ needMotion: false });
  },

  async discover(args) {
    const { discover } = await import('./discover.mjs');
    const root = path.resolve(args._[1] ?? '.');
    const res = discover(root);
    if (args.json) return console.log(JSON.stringify(res, null, 2));
    log.info(`${c.bold(res.framework)} · ${res.routes.length} route(s)${res.login ? ` · login at ${res.login}` : ''}`);
    for (const r of res.routes) {
      const tags = [r.dynamic && c.yellow('dynamic: needs an example URL'), r.likelyAuth && c.cyan('auth?')].filter(Boolean).join(' ');
      log.info(`  ${r.route.padEnd(28)} ${c.dim(r.file)} ${tags}`);
    }
  },

  async init(args) {
    const { init } = await import('./init.mjs');
    const res = init({ root: path.resolve(args.dir ?? '.'), url: args.url, force: args.force, name: args.name });
    if (!args.quiet) log.info(`\n${c.dim(res.text)}`);
  },

  async auth(args) {
    const { runAuth } = await import('./auth.mjs');
    const cfg = loadConfig(args.config);
    await runAuth(cfg, { mode: args.mode, check: args.check });
  },

  async shoot(args) {
    const cfg = loadConfig(args.config);
    const scenes = selectScenes(cfg, args.only);
    const { shoot } = await import('./shoot.mjs');
    const { ensureSession } = await import('./auth.mjs');
    const res = await withBrowser(async (browser) => {
      await ensureSession(cfg, scenes, browser);
      return shoot(cfg, scenes, { browser });
    });
    await writeManifestQuietly(cfg);
    if (res.failed) throw new ReelkitError(`${res.failed}/${res.total} still(s) FAILED.`, 'Read the reasons above, adjust waitFor/hide/stability, and re-run with --only <scene>.', { code: 2 });
  },

  async record(args) {
    const cfg = loadConfig(args.config);
    const scenes = selectScenes(cfg, args.only);
    const { preflight } = await import('./deps.mjs');
    if (scenes.some((s) => s.isMotion)) await preflight({ needMotion: true, quiet: true });
    const { record } = await import('./record.mjs');
    const { ensureSession } = await import('./auth.mjs');
    const res = await withBrowser(async (browser) => {
      await ensureSession(cfg, scenes, browser);
      return record(cfg, scenes, { browser });
    });
    await writeManifestQuietly(cfg);
    if (res.failed) throw new ReelkitError(`${res.failed}/${res.total} recording(s) FAILED.`, 'Read the reasons above and re-run with --only <scene>.', { code: 2 });
  },

  async frame(args) {
    const cfg = loadConfig(args.config);
    const scenes = selectScenes(cfg, args.only);
    const { frameAll } = await import('./frame.mjs');
    const res = await withBrowser((browser) => frameAll(cfg, scenes, { browser, only: args.only.length > 0 }));
    await writeManifestQuietly(cfg);
    if (res.failed) throw new ReelkitError(`${res.failed} framed asset(s) FAILED.`, 'See reasons above.', { code: 2 });
  },

  async verify(args) {
    const cfg = loadConfig(args.config);
    if (args.configOnly) return log.ok(`${path.basename(cfg.file)} is valid (${cfg.scenes.length} scenes).`);
    const { verify } = await import('./verify.mjs');
    const res = await verify(cfg, { marks: args.mark, note: args.note, strict: args.strict, ci: args.ci, json: args.json });
    if (!res.ok) throw new ReelkitError(res.message, res.fix, { code: 2 });
  },

  async readme(args) {
    const cfg = loadConfig(args.config);
    const { readme } = await import('./readme.mjs');
    await readme(cfg, { write: args.write, file: args.file });
  },

  async all(args) {
    const cfg = loadConfig(args.config);
    const scenes = selectScenes(cfg, args.only);
    const { preflight } = await import('./deps.mjs');
    log.step('Preflight');
    await preflight({ needMotion: scenes.some((s) => s.isMotion) });
    const { ensureSession } = await import('./auth.mjs');
    const { shoot } = await import('./shoot.mjs');
    const { record } = await import('./record.mjs');
    const { frameAll } = await import('./frame.mjs');
    let failed = 0;
    await withBrowser(async (browser) => {
      await ensureSession(cfg, scenes, browser);
      failed += (await shoot(cfg, scenes, { browser })).failed;
      failed += (await record(cfg, scenes, { browser })).failed;
      failed += (await frameAll(cfg, scenes, { browser, only: args.only.length > 0 })).failed;
    });
    const { verify } = await import('./verify.mjs');
    const res = await verify(cfg, { strict: args.strict, ci: args.ci });
    if (!args.noReadme) {
      const { readme } = await import('./readme.mjs');
      await readme(cfg, { write: 'if-markers', quietIfMissing: true });
    }
    if (!res.ok || failed) throw new ReelkitError(res.ok ? `${failed} asset(s) FAILED.` : res.message, res.fix ?? 'See the QA summary above.', { code: 2 });
  },
};
commands.doctor = commands.preflight;

async function writeManifestQuietly(cfg) {
  const { writeManifest } = await import('./manifest.mjs');
  writeManifest(cfg);
}

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.version) return console.log(VERSION);
    const cmd = args._[0];
    if (args.help || !cmd) return console.log(HELP);
    if (!commands[cmd]) throw new ReelkitError(`Unknown command "${cmd}".`, `Run \`${NAME} --help\` for the list.`);
    setQuiet(!!args.quiet);
    loadDotEnv(process.cwd());
    await commands[cmd](args);
  } catch (err) {
    if (err instanceof ReelkitError) {
      log.fail(err.message);
      if (err.fix) log.info(`  ${c.bold('fix:')} ${err.fix}`);
      process.exitCode = err.exitCode ?? 1;
    } else {
      log.fail(err.stack || String(err));
      process.exitCode = 1;
    }
  }
}
