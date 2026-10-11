// The synthetic cursor lives inside the page so it is captured by the screencast and
// zooms together with the content. It survives navigations via sessionStorage.

function cursorRuntime({ id, accent }) {
  const KEY = `${id}:pos`;
  const ns = (window[`__${id}`] = window[`__${id}`] || {});
  let pos = { x: -40, y: -40 };
  try {
    pos = JSON.parse(sessionStorage.getItem(KEY)) || pos;
  } catch {}

  function ensure() {
    let el = document.getElementById(`${id}-cursor`);
    if (el || !document.body) return el;
    const style = document.createElement('style');
    style.textContent = `
      #${id}-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647;
        pointer-events: none; transform-origin: 3px 2px; will-change: transform; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      #${id}-cursor svg { display: block; transition: transform .12s ease; }
      #${id}-cursor.down svg { transform: scale(.82); }
      .${id}-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 16px; height: 16px; margin: -8px 0 0 -8px;
        border-radius: 50%; border: 2px solid ${accent}; background: ${accent}33; }
      .${id}-key { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483646; pointer-events: none;
        font: 600 15px/1 ui-sans-serif, system-ui, sans-serif; color: #fff; background: rgba(20,20,28,.82); padding: 9px 14px; border-radius: 10px; }`;
    document.documentElement.appendChild(style);
    el = document.createElement('div');
    el.id = `${id}-cursor`;
    el.innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15.1 L18.6 15.1 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.documentElement.appendChild(el);
    place(pos.x, pos.y);
    return el;
  }

  function place(x, y) {
    pos = { x, y };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(pos));
    } catch {}
    const el = document.getElementById(`${id}-cursor`);
    if (el) el.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
  }

  ns.pos = () => pos;
  ns.show = () => !!ensure();
  ns.place = (x, y) => {
    ensure();
    place(x, y);
  };
  // Glide along a gently curved path with ease-in-out. Uses the Web Animations API,
  // which runs on the real document timeline even when the page clock is frozen.
  ns.move = (x, y, duration) => {
    const el = ensure();
    if (!el) return Promise.resolve();
    const from = { ...pos };
    const dx = x - from.x;
    const dy = y - from.y;
    const bend = Math.min(80, Math.hypot(dx, dy) * 0.12);
    const cx = from.x + dx / 2 - (dy / (Math.hypot(dx, dy) || 1)) * bend;
    const cy = from.y + dy / 2 + (dx / (Math.hypot(dx, dy) || 1)) * bend;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const frames = [];
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const t = ease(i / N);
      const px = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * x;
      const py = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * y;
      frames.push({ transform: `translate(${px - 3}px, ${py - 2}px)` });
    }
    const anim = el.animate(frames, { duration, easing: 'linear', fill: 'forwards' });
    return anim.finished.then(() => {
      anim.cancel();
      place(x, y);
    });
  };
  ns.press = (down) => ensure()?.classList.toggle('down', down);
  ns.ripple = (x, y) => {
    const r = document.createElement('div');
    r.className = `${id}-ripple`;
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    document.documentElement.appendChild(r);
    const a = r.animate(
      [
        { transform: 'scale(.4)', opacity: 0.9 },
        { transform: 'scale(3.2)', opacity: 0 },
      ],
      { duration: 520, easing: 'cubic-bezier(.2,.7,.3,1)' },
    );
    return a.finished.then(() => r.remove());
  };
  ns.key = (label) => {
    const k = document.createElement('div');
    k.className = `${id}-key`;
    k.textContent = label;
    document.documentElement.appendChild(k);
    const a = k.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 900 });
    return a.finished.then(() => k.remove());
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure);
  else ensure();
}

export async function installCursor(context, { id, accent }) {
  await context.addInitScript(cursorRuntime, { id, accent });
}

export class Cursor {
  constructor(page, id, speed = 1) {
    this.page = page;
    this.id = id;
    this.speed = speed;
  }
  call(fn, ...args) {
    return this.page.evaluate(
      ([id, fn, args]) => {
        const ns = window[`__${id}`];
        return ns && ns[fn] ? ns[fn](...args) : null;
      },
      [this.id, fn, args],
    );
  }
  async pos() {
    return (await this.call('pos')) ?? { x: 0, y: 0 };
  }
  async place(x, y) {
    await this.call('place', x, y);
  }
  async moveTo(x, y) {
    const from = await this.pos();
    const dist = Math.hypot(x - from.x, y - from.y);
    const duration = Math.round(Math.min(1100, 380 + dist * 0.55) / this.speed);
    // Real mouse follows so :hover styles appear exactly when the cursor arrives.
    await Promise.all([this.call('move', x, y, duration), this.page.mouse.move(x, y, { steps: Math.max(4, Math.round(duration / 40)) })]);
  }
  async click(x, y) {
    await this.call('press', true);
    this.call('ripple', x, y).catch(() => {});
    await this.page.mouse.down();
    await new Promise((r) => setTimeout(r, 70));
    await this.page.mouse.up();
    await this.call('press', false).catch(() => {});
  }
  async key(label) {
    await this.call('key', label).catch(() => {});
  }
}
