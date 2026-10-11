// Browser pass: observe what a page actually renders. Pure observation, no interpretation; the
// analysis lives in analyze.mjs so it can be tested without a browser.
//
// Everything here runs against the live site as an anonymous visitor. Colours are normalised by the
// browser itself (canvas), so oklch(), color-mix(), system colours etc. all arrive as sRGB.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hideCss } from '../browser.mjs';
import { iconRank, logoScore } from './analyze.mjs';

export const INSPECT_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'tablet', width: 820, height: 1180, mobile: false, touch: true },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];

/* ───────────── runs inside the page; must be self-contained ───────────── */

function collectInPage({ maxElements }) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const toRGBA = (css) => {
    if (!css || css === 'transparent' || !CSS.supports('color', css)) return css === 'transparent' ? [0, 0, 0, 0] : null;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = css;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], +(d[3] / 255).toFixed(3)];
  };
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const gs = (el, pseudo) => getComputedStyle(el, pseudo);
  const root = document.documentElement;
  const rootCs = gs(root);

  // Effective background: composite translucent layers upwards; report whether we had to assume white.
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => Math.round((top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a)).concat(+a.toFixed(3));
  };
  const effectiveBg = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = toRGBA(gs(n).backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (c && c[3] >= 1) break;
    }
    let acc = [255, 255, 255, 1];
    let defaulted = true;
    if (layers.length && layers[layers.length - 1][3] >= 1) defaulted = false;
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return { rgba: acc, defaulted };
  };

  const pageBg = effectiveBg(document.body);
  const bodyCs = gs(document.body);

  // ── elements
  const visible = (el, cs, r) => r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility === 'visible' && +cs.opacity > 0.05;
  const roleOf = (el, cs) => {
    const t = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'button' || el.getAttribute('role') === 'button' || (t === 'input' && /^(submit|button)$/.test(el.type))) return 'button';
    if (t === 'a') return /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i.test(el.className?.baseVal ?? el.className ?? '') ? 'button' : 'link';
    if (['input', 'textarea', 'select'].includes(t)) return 'input';
    if (t === 'code' || t === 'pre' || t === 'kbd') return 'code';
    if (t === 'header' || t === 'nav') return 'nav';
    return null;
  };
  const directText = (el) => {
    let n = 0;
    for (const c of el.childNodes) if (c.nodeType === 3) n += c.textContent.trim().length;
    return n;
  };
  const all = [...document.body.querySelectorAll('*')];
  const step = all.length > maxElements ? all.length / maxElements : 1;
  const elements = [];
  for (let i = 0; i < all.length && elements.length < maxElements; i += step) {
    const el = all[Math.floor(i)];
    if (['script', 'style', 'noscript', 'svg', 'path', 'br', 'meta', 'link'].includes(el.tagName.toLowerCase()) || el.closest('svg')) continue;
    const cs = gs(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, cs, r)) continue;
    const text = directText(el);
    let role = roleOf(el, cs);
    const bg = toRGBA(cs.backgroundColor);
    const borderW = px(cs.borderTopWidth) || 0;
    const shadow = cs.boxShadow !== 'none' ? cs.boxShadow : null;
    const parentBg = el.parentElement ? effectiveBg(el.parentElement).rgba : pageBg.rgba;
    const hasFill = bg && bg[3] > 0.05;
    const isSurface = !role && r.width >= 120 && r.height >= 60 && (shadow || (borderW > 0 && cs.borderTopStyle !== 'none') || (hasFill && Math.abs(bg[0] - parentBg[0]) + Math.abs(bg[1] - parentBg[1]) + Math.abs(bg[2] - parentBg[2]) > 12));
    if (!role && isSurface) role = 'card';
    if (!role && text > 0) role = 'text';
    if (!role && !(hasFill && r.width * r.height > 400)) continue;
    elements.push({
      tag: el.tagName.toLowerCase(),
      level: /^h[1-6]$/.test(el.tagName.toLowerCase()) ? +el.tagName[1] : undefined,
      role: role ?? 'block',
      textLen: Math.min(text, 400),
      color: text > 0 || role === 'link' || role === 'button' ? toRGBA(cs.color) : null,
      bg: hasFill ? bg : null,
      parentBg,
      borderColor: borderW > 0 && cs.borderTopStyle !== 'none' ? toRGBA(cs.borderTopColor) : null,
      borderWidth: borderW,
      radius: px(cs.borderTopLeftRadius),
      shadow,
      pad: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
      gap: cs.display.includes('flex') || cs.display.includes('grid') ? px(cs.rowGap) : null,
      margin: [px(cs.marginTop), px(cs.marginBottom)],
      font: { family: cs.fontFamily, size: px(cs.fontSize), weight: +cs.fontWeight || null, lineHeight: cs.lineHeight === 'normal' ? null : px(cs.lineHeight), letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing), transform: cs.textTransform },
      rect: [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)],
    });
  }

  // ── CSS custom properties declared on :root / html / body (light) or dark scopes
  const vars = new Map();
  let unreadableSheets = 0;
  const fontFaces = [];
  const scope = (sel) => (/^(:root|html|body)(\s*,|$)/.test(sel.trim()) ? 'root' : /(\.dark|\[data-theme=["']?dark|\[data-mode=["']?dark|prefers-color-scheme)/i.test(sel) ? 'dark' : null);
  const walkRules = (rules, inDarkMedia) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const sc = inDarkMedia && /^(:root|html|body)/.test(rule.selectorText) ? 'dark' : scope(rule.selectorText);
        if (!sc) continue;
        for (let i = 0; i < rule.style.length; i++) {
          const name = rule.style[i];
          if (name.startsWith('--') && vars.size < 400) vars.set(`${sc}|${name}`, { name, scope: sc, raw: rule.style.getPropertyValue(name).trim() });
        }
      } else if (rule.type === CSSRule.FONT_FACE_RULE) {
        const s = rule.style;
        const src = s.getPropertyValue('src');
        fontFaces.push({ family: s.getPropertyValue('font-family').replace(/^['"]|['"]$/g, '').trim(), weight: s.getPropertyValue('font-weight').trim() || 'normal', style: s.getPropertyValue('font-style').trim() || 'normal', src: (src.match(/url\(["']?([^"')]+)/) ?? [])[1] ?? null });
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        walkRules(rule.cssRules, inDarkMedia || /prefers-color-scheme:\s*dark/.test(rule.conditionText));
      } else if (rule.cssRules) {
        walkRules(rule.cssRules, inDarkMedia);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walkRules(sheet.cssRules, false);
    } catch {
      unreadableSheets++;
    }
  }
  // Resolve each variable the way the page would use it, so oklch()/hsl-channel/var() chains become sRGB.
  const probe = document.createElement('span');
  probe.style.display = 'none';
  root.appendChild(probe);
  const resolvedVars = [...vars.values()].map((v) => {
    let rgba = null;
    if (v.scope === 'root') {
      for (const expr of [`var(${v.name})`, `hsl(var(${v.name}))`, `rgb(var(${v.name}))`, `oklch(var(${v.name}))`]) {
        probe.style.color = '';
        probe.style.color = expr;
        if (probe.style.color) {
          rgba = toRGBA(gs(probe).color);
          break;
        }
      }
    }
    return { ...v, rgba };
  });
  probe.remove();

  const documentFonts = [...document.fonts].map((f) => ({ family: f.family.replace(/^['"]|['"]$/g, ''), weight: f.weight, style: f.style, status: f.status }));

  // ── brand assets
  const meta = (sel, attr = 'content') => document.querySelector(sel)?.getAttribute(attr) ?? null;
  const abs = (u) => {
    try {
      return u ? new URL(u, location.href).href : null;
    } catch {
      return null;
    }
  };
  const icons = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')].map((l) => ({ rel: l.rel, href: abs(l.getAttribute('href')), sizes: l.sizes?.value || l.getAttribute('sizes'), type: l.type || null, color: l.getAttribute('color') }));
  // Colours a logo SVG actually paints. Only shapes carry paint: <svg>, <g> and <defs> report a default
  // black `fill` that is never drawn, so they are skipped. Gradients are read from their <stop>s
  // (stop-color), and url(#…) fills are skipped because the stops already stand for them.
  const svgPaints = (svg) => {
    const seen = new Map();
    const add = (css) => {
      const c = css && css !== 'none' && !css.startsWith('url(') ? toRGBA(css) : null;
      if (c && c[3] > 0.5) seen.set(c.slice(0, 3).join(','), c);
    };
    for (const n of svg.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line, text, tspan, stop')) {
      if (n.closest('clipPath, mask, pattern, symbol, marker')) continue;
      const cs = gs(n);
      if (n.tagName.toLowerCase() === 'stop') add(cs.stopColor);
      else {
        add(cs.fill);
        add(cs.stroke);
      }
    }
    return [...seen.values()];
  };
  const logoScope = 'header, nav, [role=banner], [class*=logo i], [id*=logo i], [class*=brand i], a[href="/"]';
  const logos = [];
  for (const el of document.querySelectorAll(`${logoScope.split(',').map((s) => `${s.trim()} img, ${s.trim()} svg`).join(', ')}`)) {
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || r.width > 600 || r.top > 300) continue;
    const link = el.closest('a');
    const inHeader = !!el.closest('header, nav, [role=banner]');
    const homeLink = !!link && (() => { try { return new URL(link.href).pathname === '/' || link.getAttribute('href') === '/'; } catch { return false; } })();
    const named = /logo|brand/i.test(`${el.className?.baseVal ?? el.className} ${el.id} ${el.getAttribute('alt') ?? ''} ${el.closest('[class*=logo i], [class*=brand i]') ? 'logo' : ''}`);
    logos.push({
      kind: el.tagName.toLowerCase() === 'img' ? 'img' : 'inline-svg',
      src: el.tagName.toLowerCase() === 'img' ? abs(el.currentSrc || el.getAttribute('src')) : null,
      svg: el.tagName.toLowerCase() === 'svg' ? el.outerHTML.slice(0, 20000) : null,
      alt: el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? el.querySelector?.('title')?.textContent ?? null,
      width: Math.round(r.width),
      height: Math.round(r.height),
      inHeader,
      homeLink,
      named,
      fills: el.tagName.toLowerCase() === 'svg' ? svgPaints(el) : [],
    });
  }

  // ── layout
  const maxWidths = {};
  let gridMaxCols = 0;
  for (const el of all.slice(0, 4000)) {
    const cs = gs(el);
    if (cs.maxWidth !== 'none' && px(cs.maxWidth) >= 480 && px(cs.maxWidth) < 4000 && el.getBoundingClientRect().width > 0) maxWidths[px(cs.maxWidth)] = (maxWidths[px(cs.maxWidth)] ?? 0) + 1;
    if (cs.display === 'grid' && el.getBoundingClientRect().width >= innerWidth * 0.5) gridMaxCols = Math.max(gridMaxCols, cs.gridTemplateColumns.split(' ').filter((t) => /px$/.test(t)).length);
  }
  const header = document.querySelector('header, [role=banner], nav');
  const headerCs = header ? gs(header) : null;
  const menuBtn = [...document.querySelectorAll('button, [role=button]')].find((b) => /menu|navigation|hamburger/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.className} ${b.getAttribute('aria-controls') ?? ''}`));
  const vitals = {
    viewport: [innerWidth, innerHeight],
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    bodyFontSize: px(bodyCs.fontSize),
    h1: (() => { const h = document.querySelector('h1'); return h ? { size: px(gs(h).fontSize), weight: +gs(h).fontWeight } : null; })(),
    gridMaxCols,
    headerPosition: headerCs?.position ?? null,
    navLinksVisible: header ? [...header.querySelectorAll('a')].filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && gs(a).visibility === 'visible'; }).length : null,
    menuButtonVisible: menuBtn ? (() => { const r = menuBtn.getBoundingClientRect(); return r.width > 0 && r.height > 0 && gs(menuBtn).display !== 'none'; })() : null,
    contentWidthPx: (() => { const m = document.querySelector('main') ?? document.body; return Math.round(m.getBoundingClientRect().width); })(),
  };

  return {
    url: location.href,
    title: document.title,
    lang: root.lang || null,
    description: meta('meta[name=description]'),
    siteName: meta('meta[property="og:site_name"]') ?? meta('meta[name=application-name]'),
    themeColor: (() => { const t = meta('meta[name=theme-color]'); return t ? { raw: t, rgba: toRGBA(t) } : null; })(),
    colorSchemeMeta: meta('meta[name=color-scheme]'),
    rootColorScheme: rootCs.colorScheme,
    pageBg: { rgba: pageBg.rgba, defaulted: pageBg.defaulted },
    bodyText: toRGBA(bodyCs.color),
    elements,
    elementsTotal: all.length,
    vars: resolvedVars,
    fontFaces,
    documentFonts,
    unreadableSheets,
    icons,
    ogImage: abs(meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]')),
    manifest: abs(meta('link[rel=manifest]', 'href')),
    logos,
    layout: { maxWidths, headerSticky: headerCs ? ['sticky', 'fixed'].includes(headerCs.position) : null },
    vitals,
  };
}

function schemeProbeInPage() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = css;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], +(d[3] / 255).toFixed(3)];
  };
  const bg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] >= 1) return c;
    }
    return [255, 255, 255, 1];
  };
  const btn = document.querySelector('button, a[class*=btn i], a[class*=button i]');
  return { bg: bg(document.body), text: rgba(getComputedStyle(document.body).color), button: btn ? rgba(getComputedStyle(btn).backgroundColor) : null };
}

/* ───────────── node side ───────────── */

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const EXT = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/gif': 'gif', 'image/avif': 'avif' };

/** Fetch a brand asset (≤ 2 MB, images only). Returns metadata, or { error } — never throws. */
async function fetchAsset(context, url, dir, stem) {
  try {
    const res = await context.request.get(url, { timeout: 10_000, maxRedirects: 3 });
    const type = (res.headers()['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!res.ok()) return { url, error: `HTTP ${res.status()}` };
    if (!EXT[type]) return { url, error: `not an image (${type || 'no content-type'})` };
    const body = await res.body();
    if (body.length > 2_000_000) return { url, error: 'larger than 2 MB' };
    mkdirSync(dir, { recursive: true });
    const file = `${stem}-${sha(body).slice(0, 8)}.${EXT[type]}`;
    writeFileSync(path.join(dir, file), body);
    return { url, contentType: type, bytes: body.length, sha256: sha(body), savedAs: file };
  } catch (err) {
    return { url, error: String(err.message).split('\n')[0].slice(0, 120) };
  }
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(400);
}

/** Which font actually painted for a role (CDP), as opposed to the first family in the CSS stack. */
async function renderedFonts(context, page) {
  const out = {};
  let session;
  try {
    session = await context.newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument', { depth: 0 });
    const probes = { heading: 'h1, h2, h3', body: 'main p, article p, p', ui: 'button, a[class*=btn i], a[class*=button i]', mono: 'pre, code' };
    for (const [role, sel] of Object.entries(probes)) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      if (!nodeId) continue;
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      const top = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
      if (top) out[role] = { family: top.familyName, custom: !!top.isCustomFont };
    }
  } catch {
    /* CDP unavailable: leave unknown rather than guess */
  } finally {
    await session?.detach().catch(() => {});
  }
  return out;
}

/**
 * Inspect one page at three viewports (+ a dark-scheme probe). `browser` is an already launched
 * Playwright browser. Returns raw observations only.
 */
export async function inspectPage(browser, url, { assetsDir, maxElements = 1500, onWarn = () => {} } = {}) {
  const obs = { url, errors: [] };
  const newCtx = (vp, colorScheme = 'light') =>
    browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      isMobile: !!vp.mobile,
      hasTouch: !!(vp.mobile || vp.touch),
      colorScheme,
      reducedMotion: 'reduce', // freeze transitions so computed styles are the resting ones
      serviceWorkers: 'block',
    });
  const open = async (ctx, track) => {
    const page = await ctx.newPage();
    if (track) {
      // A stylesheet or font that fails to load means we would be describing a half-styled page.
      const isStyle = (r) => ['stylesheet', 'font'].includes(r.resourceType());
      page.on('requestfailed', (r) => isStyle(r) && track.push({ url: r.url(), type: r.resourceType(), reason: r.failure()?.errorText ?? 'failed' }));
      page.on('response', (res) => isStyle(res.request()) && res.status() >= 400 && track.push({ url: res.url(), type: res.request().resourceType(), reason: `HTTP ${res.status()}` }));
    }
    const res = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    obs.status = res?.status() ?? null;
    await page.addStyleTag({ content: hideCss({ builtins: true }) });
    await settle(page);
    return page;
  };

  // Desktop: the full pass.
  let ctx = await newCtx(INSPECT_VIEWPORTS[0]);
  obs.failedResources = [];
  try {
    const page = await open(ctx, obs.failedResources);
    obs.main = await page.evaluate(collectInPage, { maxElements });
    obs.rendered = await renderedFonts(ctx, page);
    obs.finalUrl = page.url();
    if (assetsDir) {
      const wanted = new Map();
      const best = [...obs.main.logos].sort((a, b) => logoScore(b) - logoScore(a))[0];
      if (best?.src) wanted.set('logo', best.src);
      if (best?.svg) {
        mkdirSync(assetsDir, { recursive: true });
        const buf = Buffer.from(best.svg);
        const file = `logo-inline-${sha(buf).slice(0, 8)}.svg`;
        writeFileSync(path.join(assetsDir, file), buf);
        obs.inlineLogoSaved = { savedAs: file, sha256: sha(buf), bytes: buf.length };
      }
      const icon = [...obs.main.icons].filter((i) => i.href).sort((a, b) => iconRank(b) - iconRank(a))[0];
      if (icon) wanted.set('favicon', icon.href);
      if (obs.main.ogImage) wanted.set('og-image', obs.main.ogImage);
      obs.fetched = {};
      for (const [stem, u] of wanted) obs.fetched[stem] = await fetchAsset(ctx, u, assetsDir, stem);
    }
  } catch (err) {
    obs.errors.push(`desktop: ${String(err.message).split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
  if (!obs.main) return obs;

  // Responsive vitals.
  obs.responsive = { desktop: obs.main.vitals };
  for (const vp of INSPECT_VIEWPORTS.slice(1)) {
    ctx = await newCtx(vp);
    try {
      const page = await open(ctx);
      obs.responsive[vp.name] = (await page.evaluate(collectInPage, { maxElements: 200 })).vitals;
    } catch (err) {
      obs.errors.push(`${vp.name}: ${String(err.message).split('\n')[0]}`);
      onWarn(`could not inspect ${vp.name} viewport of ${url}`);
    } finally {
      await ctx.close();
    }
  }

  // Dark-scheme probe (does the site respond to prefers-color-scheme at all?).
  ctx = await newCtx(INSPECT_VIEWPORTS[0], 'dark');
  try {
    const page = await open(ctx);
    obs.dark = await page.evaluate(schemeProbeInPage);
    obs.light = { bg: obs.main.pageBg.rgba, text: obs.main.bodyText };
  } catch (err) {
    obs.errors.push(`dark: ${String(err.message).split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
  return obs;
}
