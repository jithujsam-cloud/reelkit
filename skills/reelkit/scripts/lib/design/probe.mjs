// In-page design probe. Runs inside the browser via page.evaluate and returns raw measurements only
// (no interpretation). Every colour is normalised to [r, g, b, a] by painting it on a 1×1 canvas, so
// modern formats (oklch(), color(), color-mix()) are handled by the browser itself.

export function designProbe({ maxElements = 4000 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgbaCache = new Map();
  const rgba = (css) => {
    if (!css || css === 'none') return null;
    if (rgbaCache.has(css)) return rgbaCache.get(css);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css; // invalid values leave the previous style in place
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const out = [d[0], d[1], d[2], +(d[3] / 255).toFixed(3)];
    rgbaCache.set(css, out);
    return out;
  };
  const opaque = (c) => c && c[3] >= 0.95;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    return r;
  };
  const text = (el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const firstFamily = (stack) => (stack || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
  };

  // ---- Custom properties: where they are declared (same-origin sheets) and their computed values
  const declarations = [];
  let crossOriginSheets = 0;
  let darkSelectorRules = 0;
  const darkSel = /(^|[\s,])(\.dark|\.theme-dark|\[data-theme=["']?dark|\[data-mode=["']?dark|\[data-color-mode=["']?dark|html\.dark|:root\.dark)/i;
  const walk = (rules, media) => {
    for (const rule of rules) {
      if (rule.cssRules && rule.media) walk(rule.cssRules, rule.media.mediaText);
      else if (rule.cssRules && !rule.style) walk(rule.cssRules, media);
      if (!rule.style || !rule.selectorText) continue;
      if (darkSel.test(rule.selectorText)) darkSelectorRules++;
      for (let i = 0; i < rule.style.length; i++) {
        const name = rule.style[i];
        if (name.startsWith('--') && declarations.length < 800) {
          declarations.push({ name, selector: rule.selectorText.slice(0, 80), media: media || null, value: rule.style.getPropertyValue(name).trim().slice(0, 120) });
        }
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, null);
    } catch {
      crossOriginSheets++;
    }
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const varNames = [...new Set(declarations.map((d) => d.name))].sort();
  const vars = {};
  for (const name of varNames) {
    const value = rootStyle.getPropertyValue(name).trim();
    if (!value) continue;
    const c = /^(#|rgb|hsl|oklch|oklab|lab|lch|color\(|hwb)/i.test(value) ? rgba(value) : null;
    vars[name] = { value: value.slice(0, 120), ...(c ? { rgba: c } : {}) };
  }

  // ---- Page basics
  const bodyStyle = getComputedStyle(document.body);
  const htmlBg = rgba(rootStyle.backgroundColor);
  const bodyBg = rgba(bodyStyle.backgroundColor);
  const page = {
    background: opaque(bodyBg) ? bodyBg : opaque(htmlBg) ? htmlBg : null,
    backgroundFrom: opaque(bodyBg) ? 'body' : opaque(htmlBg) ? 'html' : 'browser default (transparent)',
    color: rgba(bodyStyle.color),
    font: bodyStyle.fontFamily,
    fontSize: parseFloat(bodyStyle.fontSize),
    lineHeight: bodyStyle.lineHeight,
    colorScheme: rootStyle.colorScheme || 'normal',
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
  };

  // ---- Walk visible elements once and collect role evidence + distributions
  const counts = { radius: {}, shadow: {}, border: {}, spacing: {}, textColor: {}, fontFamily: {} };
  const bump = (bucket, key, w = 1) => {
    if (key === null || key === undefined || key === '') return;
    bucket[key] = (bucket[key] || 0) + w;
  };
  const buttons = [];
  const links = [];
  const surfaces = [];
  const headings = [];
  const active = [];
  const inputs = [];
  const monos = new Set();
  const all = document.body.querySelectorAll('*');
  let n = 0;
  for (const el of all) {
    if (++n > maxElements) break;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK'].includes(el.tagName)) continue;
    const r = visible(el);
    if (!r) continue;
    const st = getComputedStyle(el);
    const area = Math.min(r.width, vw) * Math.min(r.height, vh);
    const bg = rgba(st.backgroundColor);
    const radius = parseFloat(st.borderTopLeftRadius) || 0;
    if (radius > 0 && bg && bg[3] > 0.05) bump(counts.radius, Math.round(radius));
    if (st.boxShadow && st.boxShadow !== 'none') bump(counts.shadow, st.boxShadow.slice(0, 160));
    const bw = parseFloat(st.borderTopWidth) || 0;
    if (bw >= 1 && st.borderTopStyle !== 'none') {
      const bc = rgba(st.borderTopColor);
      if (bc && bc[3] > 0.05) bump(counts.border, `${bc.slice(0, 3).join(',')}|${bw}`);
    }
    for (const p of ['paddingTop', 'paddingLeft', 'rowGap', 'columnGap', 'marginBottom']) {
      const v = parseFloat(st[p]);
      if (v > 0 && v <= 160) bump(counts.spacing, Math.round(v));
    }
    const ownText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (ownText) {
      const tc = rgba(st.color);
      if (tc) bump(counts.textColor, tc.slice(0, 3).join(','), Math.min(area, 20000));
      bump(counts.fontFamily, firstFamily(st.fontFamily), 1);
      if (/mono|code|consol|courier|menlo/i.test(st.fontFamily) || ['CODE', 'PRE', 'KBD', 'SAMP'].includes(el.tagName)) monos.add(firstFamily(st.fontFamily));
    }
    const tag = el.tagName;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/^H[1-3]$/.test(tag)) {
      headings.push({ level: +tag[1], family: st.fontFamily, size: parseFloat(st.fontSize), weight: +st.fontWeight || 400, lineHeight: st.lineHeight, letterSpacing: st.letterSpacing, color: rgba(st.color) });
    }
    const isButtonish = tag === 'BUTTON' || el.getAttribute('role') === 'button' || (tag === 'A' && bg && bg[3] > 0.5) || (tag === 'INPUT' && /submit|button/.test(el.type));
    if (isButtonish && bg && bg[3] > 0.5 && r.width < vw * 0.6) {
      buttons.push({
        el: describe(el),
        bg,
        color: rgba(st.color),
        radius,
        area: Math.round(area),
        hint: /primary|cta|brand|accent/i.test(cls) || el.type === 'submit',
        label: text(el),
      });
    }
    if (tag === 'A' && (!bg || bg[3] < 0.1)) links.push({ color: rgba(st.color), el: describe(el) });
    // Whole class tokens only: "status-active" is a badge, not the active navigation item.
    if ((el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') || el.getAttribute('aria-selected') === 'true' || ['active', 'is-active', 'selected', 'is-selected', 'current'].some((t) => el.classList.contains(t))) {
      active.push({ el: describe(el), color: rgba(st.color), bg: bg && bg[3] > 0.1 ? bg : null });
    }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) inputs.push({ bg, border: rgba(st.borderTopColor), radius });
    if (bg && bg[3] > 0.9 && area > vw * vh * 0.01 && !['HTML', 'BODY', 'BUTTON', 'A'].includes(tag)) {
      surfaces.push({ el: describe(el), bg, radius, shadow: st.boxShadow !== 'none', border: bw >= 1, area: Math.round(area) });
    }
  }

  // ---- Fonts actually loaded by the page
  const fonts = [];
  for (const f of document.fonts) {
    fonts.push({ family: f.family.replace(/^["']|["']$/g, ''), weight: String(f.weight), style: f.style, status: f.status });
  }

  // ---- Brand assets
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return null;
    }
  };
  const icons = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')].map((l) => ({ rel: l.rel, href: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes') || null, color: l.getAttribute('color') || null }));
  const themeColor = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({ content: m.content, media: m.getAttribute('media') || null, rgba: rgba(m.content) }));
  const manifest = document.querySelector('link[rel="manifest"]');
  const og = document.querySelector('meta[property="og:image"]');
  const logos = [];
  const logoCandidates = new Set([
    ...document.querySelectorAll('[class*="logo" i], [id*="logo" i], [aria-label*="logo" i], img[alt*="logo" i]'),
    ...[...document.querySelectorAll('header a[href="/"], nav a[href="/"], a[href="/"]')].slice(0, 3),
  ]);
  for (const cand of logoCandidates) {
    if (logos.length >= 4) break;
    const r = visible(cand);
    if (!r || r.width > vw * 0.5 || r.height > 200) continue;
    const svg = cand.tagName === 'svg' ? cand : cand.querySelector('svg');
    const img = cand.tagName === 'IMG' ? cand : cand.querySelector('img');
    if (svg) {
      const colors = new Set();
      // Only paint-carrying shapes: the <svg> root and <g> report a default black fill that is not drawn.
      for (const node of svg.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line, text, stop, use')) {
        const st = getComputedStyle(node);
        // <stop> carries its colour in stop-color; its computed fill is a meaningless default.
        for (const v of node.tagName.toLowerCase() === 'stop' ? [st.stopColor] : [st.fill, st.stroke]) {
          if (!v || v === 'none' || v.startsWith('url(')) continue;
          const c = rgba(v);
          if (c && c[3] > 0.5) colors.add(c.slice(0, 3).join(','));
        }
      }
      logos.push({ kind: 'svg', el: describe(cand), width: Math.round(r.width), height: Math.round(r.height), colors: [...colors], markup: svg.outerHTML.length < 20000 ? svg.outerHTML : null, label: text(cand) });
    } else if (img) {
      logos.push({ kind: 'img', el: describe(cand), width: Math.round(r.width), height: Math.round(r.height), src: abs(img.currentSrc || img.src), alt: img.alt || null });
    }
  }

  // ---- Layout signals
  const aside = [...document.querySelectorAll('aside, nav, [class*="sidebar" i]')].map(visible).filter(Boolean).find((r) => r.height > vh * 0.6 && r.width < vw * 0.35 && r.left < 4);
  const topNav = [...document.querySelectorAll('header, nav, aside, [class*="sidebar" i], [class*="topbar" i]')].map(visible).filter(Boolean).find((r) => r.top < 10 && r.width > vw * 0.6 && r.height < 140);
  let maxContent = 0;
  for (const el of document.querySelectorAll('main, main > *, body > div > *, section, article')) {
    const r = visible(el);
    if (r && r.width < vw - 1 && r.width > maxContent) maxContent = r.width;
  }

  return {
    url: location.href,
    title: document.title,
    page,
    vars,
    declarations,
    crossOriginSheets,
    darkSelectorRules,
    counts,
    headings: headings.slice(0, 12),
    buttons: buttons.sort((a, b) => b.hint - a.hint || b.area - a.area).slice(0, 8),
    links: links.slice(0, 40),
    active: active.slice(0, 8),
    surfaces: surfaces.sort((a, b) => b.area - a.area).slice(0, 12),
    inputs: inputs.slice(0, 6),
    monoFamilies: [...monos].sort(),
    fonts,
    assets: { icons, themeColor, manifest: manifest ? abs(manifest.getAttribute('href')) : null, ogImage: og ? abs(og.content) : null, logos },
    layout: {
      viewport: [vw, vh],
      scrollWidth: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth > vw + 1,
      sidebar: aside ? Math.round(aside.width) : null,
      topNav: !!topNav,
      maxContentWidth: Math.round(maxContent) || null,
    },
  };
}
