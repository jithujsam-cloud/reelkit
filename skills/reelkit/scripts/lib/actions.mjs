import { ReelkitError, log } from './log.mjs';
import { expandEnv } from './env.mjs';
import { waitForCondition } from './stability.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic PRNG so "human" typing jitter is identical on every run. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function describeStep(step) {
  const [kind, arg] = Object.entries(step)[0];
  if (kind === 'type') return `type into ${arg.into}${String(arg.text).includes('${') ? ' (from env)' : ` "${arg.text}"`}`;
  if (typeof arg === 'object' && arg !== null) return `${kind} ${JSON.stringify(arg)}`;
  return `${kind} ${arg}`;
}

/**
 * Runs scene actions. In motion mode every pointer action goes through the synthetic
 * cursor and is logged as an event (used for zoom and QA frame sampling).
 */
export class Director {
  constructor(page, { scene, cfg, absoluteUrl, cursor = null, net = null, seed = 7 }) {
    this.page = page;
    this.scene = scene;
    this.cfg = cfg;
    this.absoluteUrl = absoluteUrl;
    this.cursor = cursor;
    this.net = net;
    this.random = rng(seed);
    this.events = [];
    this.timeout = scene.stability.timeout;
  }

  get motion() {
    return !!this.cursor;
  }

  async target(selector, step) {
    const loc = this.page.locator(selector).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: this.timeout });
    } catch {
      throw new ReelkitError(
        `Scene "${this.scene.name}", step "${describeStep(step)}": no visible element matches ${selector}.`,
        'Check the selector (CSS, text=…, role=…) against the live page, or add a wait step before it.',
      );
    }
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    return loc;
  }

  async point(loc) {
    const box = await loc.boundingBox();
    if (!box) throw new ReelkitError(`Element for scene "${this.scene.name}" has no box (hidden or detached).`, 'Wait for it to appear first.');
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), box };
  }

  record(type, extra) {
    this.events.push({ type, t: Date.now() / 1000, ...extra });
  }

  /** After an interaction, give the UI a moment to respond so the video does not rush. */
  async settle(maxMs = 1800) {
    if (!this.motion) return;
    const end = Date.now() + maxMs;
    await sleep(220);
    while (Date.now() < end) {
      const quiet = this.net ? this.net.quietFor() >= 250 : true;
      const busy = await this.page
        .evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length)
        .catch(() => 0);
      if (quiet && busy === 0) return;
      await sleep(80);
    }
  }

  zoomFor(arg) {
    const z = typeof arg === 'object' && arg && 'zoom' in arg ? arg.zoom : this.scene.zoom ?? this.cfg.motion.zoom;
    if (!z) return 0;
    return z === true ? 1.5 : Number(z);
  }

  async run(steps = []) {
    for (const [i, step] of steps.entries()) {
      const [kind, arg] = Object.entries(step)[0];
      log.dim(`    ${i + 1}. ${describeStep(step)}`);
      const fn = this[`do_${kind}`];
      if (!fn) throw new ReelkitError(`Unknown action "${kind}" in scene "${this.scene.name}".`, 'Use one of: click, type, hover, scroll, press, wait, select, drag, goto, waitFor.');
      await fn.call(this, arg, step);
    }
  }

  async do_click(arg, step) {
    const selector = typeof arg === 'string' ? arg : arg.selector;
    const loc = await this.target(selector, step);
    if (!this.motion) return loc.click();
    const { x, y } = await this.point(loc);
    await this.cursor.moveTo(x, y);
    await sleep(120);
    this.record('click', { x, y, zoom: this.zoomFor(arg) });
    await this.cursor.click(x, y);
    await this.settle();
  }

  async do_hover(selector, step) {
    const loc = await this.target(selector, step);
    if (!this.motion) return loc.hover();
    const { x, y } = await this.point(loc);
    await this.cursor.moveTo(x, y);
    this.record('hover', { x, y });
    await sleep(500);
  }

  async do_type(arg, step) {
    const text = expandEnv(arg.text, `scene ${this.scene.name} type.text`);
    const loc = await this.target(arg.into, step);
    if (!this.motion) {
      if (arg.clear !== false) await loc.fill('');
      return loc.pressSequentially(text, { delay: 0 });
    }
    const { x, y } = await this.point(loc);
    await this.cursor.moveTo(x, y);
    this.record('click', { x, y, zoom: this.zoomFor(arg) });
    await this.cursor.click(x, y);
    if (arg.clear !== false) await loc.fill('');
    await sleep(200);
    const [lo, hi] = this.cfg.motion.typingDelay;
    const typeStart = Date.now() / 1000;
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      // Longer pauses after spaces/punctuation read as natural typing.
      const pause = lo + this.random() * (hi - lo) + (/[\s,.]/.test(ch) ? 60 : 0);
      await sleep(pause);
    }
    // Keystroke round-trips can be slower than real typing; the assembler re-times this window.
    this.events.push({ type: 'type', t: typeStart, end: Date.now() / 1000, x, y, chars: text.length });
    await sleep(250);
  }

  async do_press(arg) {
    const key = typeof arg === 'string' ? arg : arg.key;
    if (typeof arg === 'object' && arg.into) await this.page.locator(arg.into).first().focus();
    if (this.motion) {
      this.cursor.key(key.replace('Control', 'Ctrl').replace('Meta', '⌘'));
      this.record('press', { key });
    }
    await this.page.keyboard.press(key);
    await this.settle();
  }

  async do_scroll(arg, step) {
    const smooth = this.motion ? 'smooth' : 'instant';
    if (typeof arg === 'number' || (typeof arg === 'object' && arg.by !== undefined)) {
      const by = typeof arg === 'number' ? arg : arg.by;
      await this.page.evaluate(([by, behavior]) => window.scrollBy({ top: by, behavior }), [by, smooth]);
    } else {
      const to = typeof arg === 'string' ? arg : arg.to;
      if (to === 'top' || to === 'bottom') {
        await this.page.evaluate(([to, behavior]) => window.scrollTo({ top: to === 'top' ? 0 : document.documentElement.scrollHeight, behavior }), [to, smooth]);
      } else {
        const loc = this.page.locator(to).first();
        await loc.waitFor({ state: 'attached', timeout: this.timeout }).catch(() => {
          throw new ReelkitError(`Scene "${this.scene.name}", step "${describeStep(step)}": nothing matches ${to}.`, 'Fix the selector.');
        });
        await loc.evaluate((el, behavior) => el.scrollIntoView({ block: 'center', behavior }), smooth);
      }
    }
    if (this.motion) this.record('scroll', {});
    await sleep(this.motion ? 900 : 150);
  }

  async do_wait(arg) {
    if (typeof arg === 'number') return sleep(arg);
    if (arg.for) await this.page.locator(arg.for).first().waitFor({ state: 'visible', timeout: this.timeout });
    if (arg.text) await this.page.getByText(arg.text).first().waitFor({ state: 'visible', timeout: this.timeout });
    if (arg.hidden) await this.page.locator(arg.hidden).first().waitFor({ state: 'hidden', timeout: this.timeout });
  }

  async do_waitFor(arg) {
    await waitForCondition(this.page, arg, this.timeout);
  }

  async do_select(arg, step) {
    const loc = await this.target(arg.from, step);
    if (this.motion) {
      const { x, y } = await this.point(loc);
      await this.cursor.moveTo(x, y);
      this.record('click', { x, y, zoom: 0 });
      this.cursor.call('ripple', x, y).catch(() => {});
      await sleep(250);
    }
    // Match by value first, then by visible label.
    try {
      await loc.selectOption({ value: arg.value }, { timeout: 1500 });
    } catch {
      await loc.selectOption({ label: arg.value });
    }
    await this.settle(600);
  }

  async do_drag(arg, step) {
    const from = await this.point(await this.target(arg.from, step));
    const to = await this.point(await this.target(arg.to, step));
    if (this.motion) await this.cursor.moveTo(from.x, from.y);
    else await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    if (this.motion) {
      this.record('drag', { x: from.x, y: from.y });
      await this.cursor.moveTo(to.x, to.y);
    } else {
      await this.page.mouse.move(to.x, to.y, { steps: 12 });
    }
    await this.page.mouse.up();
    await this.settle();
  }

  async do_goto(url) {
    await this.page.goto(this.absoluteUrl(url), { waitUntil: 'domcontentloaded' });
    if (this.motion) this.record('goto', {});
    await this.settle(4000);
  }
}
