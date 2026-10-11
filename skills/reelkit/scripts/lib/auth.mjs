import { existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ENV_PREFIX, NAME } from './brand.mjs';
import { AuthExpiredError, ReelkitError, c, log, registerSecret } from './log.mjs';
import { expandEnv, expandEnvDeep } from './env.mjs';
import { absoluteUrl, resolveBaseUrl } from './config.mjs';
import { extraArgs, launchBrowser } from './browser.mjs';
import { ensureDir, ensureGitignore } from './fsutil.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function onLoginPage(cfg, url) {
  const login = cfg.auth.loginUrl;
  if (!login) return false;
  const want = pathOf(absoluteUrl(cfg, login));
  return pathOf(url).replace(/\/$/, '') === want.replace(/\/$/, '');
}

/**
 * Throws AuthExpiredError if the page is showing a login screen instead of the
 * protected content. Called after navigation and again right before capture.
 */
export async function assertSignedIn(page, cfg, scene, status) {
  if (!scene.auth) return;
  if (status === 401 || status === 403) throw new AuthExpiredError(`HTTP ${status} on ${pathOf(page.url())}`);
  if (onLoginPage(cfg, page.url())) throw new AuthExpiredError(`redirected to ${pathOf(page.url())}`);
  const out = cfg.auth.loggedOutSelector;
  if (out && (await page.locator(out).first().isVisible().catch(() => false))) {
    throw new AuthExpiredError(`login form visible on ${pathOf(page.url())}`);
  }
  const inSel = cfg.auth.loggedInSelector;
  if (inSel && !(await page.locator(inSel).first().isVisible().catch(() => false))) {
    throw new AuthExpiredError(`"${inSel}" not visible on ${pathOf(page.url())}`);
  }
}

function headers(cfg) {
  return expandEnvDeep(cfg.headers ?? {}, 'headers');
}

function checkTarget(cfg) {
  if (cfg.auth.checkUrl) return cfg.auth.checkUrl;
  const scene = cfg.scenes.find((s) => s.auth);
  return scene?.url ?? null;
}

/** Load the saved session and confirm it still reaches a protected page. */
export async function verifySession(cfg, browser) {
  if (!existsSync(cfg.authFile)) return { ok: false, reason: 'no saved session' };
  const target = checkTarget(cfg);
  if (!target) return { ok: true, reason: 'no protected scene to check' };
  const own = !browser;
  browser ??= await launchBrowser();
  const context = await browser.newContext({ storageState: cfg.authFile, extraHTTPHeaders: headers(cfg) });
  try {
    const page = await context.newPage();
    const res = await page.goto(absoluteUrl(cfg, target), { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give client-side guards a moment to redirect.
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await assertSignedIn(page, cfg, { auth: true }, res?.status());
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthExpiredError) return { ok: false, reason: err.message.match(/\(([^)]*)\)/)?.[1] ?? 'expired' };
    throw err;
  } finally {
    await context.close();
    if (own) await browser.close();
  }
}

async function save(context, cfg) {
  ensureDir(path.dirname(cfg.authFile));
  ensureGitignore(cfg.root);
  await context.storageState({ path: cfg.authFile });
  try {
    chmodSync(cfg.authFile, 0o600);
  } catch {
    /* Windows */
  }
}

function hasDisplay() {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function manualLogin(cfg) {
  if (!hasDisplay()) {
    throw new ReelkitError(
      'Manual login needs a visible browser window, but no display is available (CI or remote shell).',
      `Use auth.mode: form (with ${ENV_PREFIX}_EMAIL/${ENV_PREFIX}_PASSWORD) or token, or run \`${NAME} auth\` on your own machine.`,
    );
  }
  const browser = await chromium.launch({ headless: false, args: extraArgs() }).catch(() => launchBrowser({ headless: false }));
  const context = await browser.newContext({ viewport: null, extraHTTPHeaders: headers(cfg) });
  const page = await context.newPage();
  const start = absoluteUrl(cfg, cfg.auth.loginUrl ?? '/');
  await page.goto(start);
  log.info(`\n${c.bold('A browser window is open.')} Sign in there as you normally would (OAuth, magic link and 2FA all work).`);
  log.info(`${NAME} saves the session as soon as you land on a page that is not the login page. Close the window to cancel.\n`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let closed = false;
  page.on('close', () => (closed = true));
  let goodSince = null;
  while (Date.now() < deadline && !closed) {
    await sleep(500);
    const url = page.url();
    const loginVisible = cfg.auth.loggedOutSelector ? await page.locator(cfg.auth.loggedOutSelector).first().isVisible().catch(() => true) : false;
    const ok = url.startsWith(resolveBaseUrl(cfg)) && !onLoginPage(cfg, url) && !loginVisible && url !== start;
    goodSince = ok ? goodSince ?? Date.now() : null;
    if (goodSince && Date.now() - goodSince > 1500) break;
  }
  if (closed || !goodSince) {
    await browser.close().catch(() => {});
    throw new ReelkitError('Login was not completed.', `Run \`${NAME} auth\` again and finish signing in before closing the window.`);
  }
  await save(context, cfg);
  await browser.close();
}

async function formLogin(cfg) {
  const f = cfg.auth.form;
  const email = process.env[f.emailEnv];
  const password = process.env[f.passwordEnv];
  if (!email || !password) {
    throw new ReelkitError(
      `auth.mode is "form" but ${f.emailEnv} / ${f.passwordEnv} are not set.`,
      `Put them in .env (git-ignored): ${f.emailEnv}=you@example.com and ${f.passwordEnv}=…`,
    );
  }
  registerSecret(password);
  if (!cfg.auth.loginUrl) throw new ReelkitError('auth.mode "form" needs auth.loginUrl.', 'Set auth.loginUrl, e.g. /login');
  const browser = await launchBrowser();
  const context = await browser.newContext({ extraHTTPHeaders: headers(cfg) });
  try {
    const page = await context.newPage();
    await page.goto(absoluteUrl(cfg, cfg.auth.loginUrl), { waitUntil: 'domcontentloaded' });
    const field = async (sel, what) => {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
        throw new ReelkitError(`Could not find the ${what} field (${sel}) on ${cfg.auth.loginUrl}.`, `Set auth.form.${what} to the right selector.`);
      });
      return loc;
    };
    await (await field(f.email, 'email')).fill(email);
    await (await field(f.password, 'password')).fill(password);
    await (await field(f.submit, 'submit')).click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(300);
      const away = !onLoginPage(cfg, page.url());
      const inOk = cfg.auth.loggedInSelector ? await page.locator(cfg.auth.loggedInSelector).first().isVisible().catch(() => false) : true;
      if (away && inOk) break;
    }
    if (onLoginPage(cfg, page.url())) {
      const msg = await page.locator('[role=alert], .error, .form-error').first().textContent({ timeout: 500 }).catch(() => null);
      throw new ReelkitError(`Login failed: still on ${cfg.auth.loginUrl} after submitting${msg ? ` ("${msg.trim().slice(0, 80)}")` : ''}.`, `Check ${f.emailEnv}/${f.passwordEnv} and the auth.form selectors.`);
    }
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await save(context, cfg);
  } finally {
    await browser.close();
  }
}

async function tokenLogin(cfg) {
  const t = cfg.auth.token ?? {};
  if (!t.url && !t.cookies) throw new ReelkitError('auth.mode "token" needs auth.token.url or auth.token.cookies.', 'See reference/auth.md (Mode C).');
  const browser = await launchBrowser();
  const context = await browser.newContext({ extraHTTPHeaders: { ...headers(cfg), ...expandEnvDeep(t.headers ?? {}, 'auth.token.headers') } });
  try {
    if (t.cookies) {
      const base = new URL(resolveBaseUrl(cfg));
      await context.addCookies(
        t.cookies.map((ck) => ({ name: ck.name, value: expandEnv(ck.value, 'auth.token.cookies'), domain: ck.domain ?? base.hostname, path: ck.path ?? '/' })),
      );
    }
    if (t.url) {
      const page = await context.newPage();
      const res = await page.goto(absoluteUrl(cfg, t.url), { waitUntil: 'domcontentloaded' });
      if (res && res.status() >= 400) {
        throw new ReelkitError(`Token login URL answered HTTP ${res.status()}.`, 'Check the token env var and that the preview login route is enabled on this deployment.');
      }
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }
    await save(context, cfg);
  } finally {
    await browser.close();
  }
}

export async function runAuth(cfg, { mode, check = false } = {}) {
  ensureGitignore(cfg.root);
  if (check) {
    const res = await verifySession(cfg);
    if (!res.ok) throw new ReelkitError(`Saved session is not valid: ${res.reason}.`, `Run \`${NAME} auth\` to sign in again.`, { code: 3 });
    log.ok('Saved session is valid.');
    return;
  }
  const m = mode ?? cfg.auth.mode;
  if (m === 'none') {
    log.info('auth.mode is "none": nothing to do.');
    return;
  }
  log.step(`Signing in (mode: ${m})…`);
  if (m === 'manual') await manualLogin(cfg);
  else if (m === 'form') await formLogin(cfg);
  else if (m === 'token') await tokenLogin(cfg);
  else throw new ReelkitError(`Unknown auth.mode "${m}".`, 'Use manual, form, token or none.');
  const res = await verifySession(cfg);
  if (!res.ok) throw new ReelkitError(`Signed in, but the session does not reach protected pages (${res.reason}).`, 'Check auth.loginUrl / auth.checkUrl in the config.', { code: 3 });
  log.ok(`Session saved to ${path.relative(cfg.root, cfg.authFile)} (git-ignored, never printed).`);
}

/** Before a capture run: make sure auth scenes have a valid session, refreshing it when we can do so unattended. */
export async function ensureSession(cfg, scenes, browser) {
  if (!scenes.some((s) => s.auth)) return;
  const res = await verifySession(cfg, browser);
  if (res.ok) return;
  if (cfg.auth.mode === 'form' || cfg.auth.mode === 'token') {
    log.warn(`Saved session unusable (${res.reason}); signing in again with auth.mode "${cfg.auth.mode}".`);
    await runAuth(cfg);
    return;
  }
  throw new AuthExpiredError(res.reason);
}
