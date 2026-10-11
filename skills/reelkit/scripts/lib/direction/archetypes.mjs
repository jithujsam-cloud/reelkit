// Four direction archetypes. Each is a pure function of the profile inputs and returns a complete
// direction. They differ in composition, not just colour: layout family per output, background kind,
// type weight/voice, device scale, depth and accent use are all different by construction (distinct.mjs
// enforces it). Which three are proposed depends on the profile (fit()).
import { BLACK, INK, PAPER, WHITE, contrast, ensureContrast, lightness, mix, paletteOn, readable } from './palette.mjs';

class Basis {
  constructor() {
    this.used = [];
    this.choices = [];
    this.fallbacks = [];
    this.warnings = [];
  }
  use(path, value, confidence) {
    this.used.push({ path, value, confidence: Math.round(confidence * 100) / 100 });
  }
  choice(path, why) {
    this.choices.push({ path, why });
  }
  fallback(path, reason, used) {
    this.fallbacks.push({ path, reason, used });
  }
  done(extraWarnings = []) {
    return { used: this.used, choices: this.choices, fallbacks: this.fallbacks, warnings: [...this.warnings, ...extraWarnings] };
  }
}

const radiusFor = (I, b, fallback = 12) => {
  if (I.radius !== null) {
    b.use('tokens.shape.radius', I.radius, 0.7);
    return I.radius;
  }
  b.fallback('depth.radius', 'the profile has no reliable corner radius', `${fallback}px`);
  return fallback;
};

function typeFor(I, b, { voice, weight, tracking, forceVoice }) {
  const brandFont = I.heading.family ? { family: I.heading.family, confidence: Math.round(I.heading.confidence * 100) / 100, embed: false } : null;
  let v = forceVoice ?? I.heading.voice ?? voice;
  if (forceVoice && I.heading.voice && I.heading.voice !== forceVoice) b.choice('typography.voice', `${forceVoice} display type is a stylistic choice; the site's heading font (${I.heading.family}) reads as ${I.heading.voice}`);
  else if (!forceVoice && I.heading.voice) b.use('tokens.typography.heading', `${I.heading.family} → ${I.heading.voice}`, I.heading.confidence);
  else if (!forceVoice) b.fallback('typography.voice', 'no reliable heading font in the profile', 'generic sans');
  if (forceVoice && !I.heading.voice) b.choice('typography.voice', `${forceVoice} display type is a stylistic choice (no reliable heading font in the profile)`);
  if (brandFont) b.choice('typography.brandFont', `only the generic ${v} class is rendered; "${brandFont.family}" is recorded but not embedded (embed:false)`);
  return { voice: v, weight, tracking, case: 'none', brandFont };
}

const motionFor = (b, m) => ({ ...m });

export const ARCHETYPES = [
  {
    id: 'brand-led',
    name: 'Brand-led',
    fit(I) {
      if (I.brand.kind === 'chromatic') return 0.9;
      if (I.brand.kind === 'neutral') return 0.55;
      return 0.2;
    },
    build(I) {
      const b = new Basis();
      let base = I.brand.hex;
      if (I.brand.hex) b.use('tokens.colors.primary', I.brand.hex, I.brand.confidence);
      else {
        b.fallback('palette.canvas', I.brand.reason, `neutral ink ${INK}`);
        base = INK;
      }
      if (I.brand.kind === 'neutral') b.choice('palette.canvas', 'the brand is monochrome, so the canvas is its ink colour rather than a hue');
      let lightCanvas = lightness(base) > 0.8 ? mix(base, INK, 0.3) : base;
      if (lightCanvas !== base) b.choice('palette.canvas', 'the brand colour is very light, so the canvas is darkened to keep text readable');
      // Mid-tone brands (e.g. #7c5cff) can fail 4.5:1 against both white and ink; darken just enough.
      if (Math.max(contrast(WHITE, lightCanvas), contrast(INK, lightCanvas)) < 4.5) {
        const original = lightCanvas;
        for (let t = 0.05; t <= 0.6 && contrast(WHITE, lightCanvas) < 4.5; t += 0.05) lightCanvas = mix(original, BLACK, t);
        b.choice('palette.canvas', `the brand colour ${original} cannot carry readable text as-is (best contrast ${Math.max(contrast(WHITE, original), contrast(INK, original)).toFixed(1)}:1), so it is darkened to ${lightCanvas}`);
      }
      const darkCanvas = mix(lightCanvas, BLACK, 0.45);
      const second = (c) => mix(c, lightness(c) > 0.5 ? BLACK : WHITE, 0.12);
      const light = paletteOn(lightCanvas, { canvas2: second(lightCanvas) });
      const dark = paletteOn(darkCanvas, { canvas2: second(darkCanvas) });
      const radius = radiusFor(I, b);
      return {
        id: 'brand-led',
        name: 'Brand-led',
        archetype: 'brand-led',
        rationale: I.brand.hex
          ? `The product's own ${I.brand.kind === 'neutral' ? 'ink' : 'brand'} colour ${I.brand.hex} (confidence ${Math.round(I.brand.confidence * 100)}%) fills the canvas in two flat fields, with copy on the left and the product bleeding in from the right. Assets read as the product's own at a glance. No gradients: depth comes from one soft layered shadow.`
          : `The profile has no reliable brand colour (${I.brand.reason}), so this direction stages the product on a neutral ink canvas with copy left and the product bleeding in from the right. Treat it as a layout study until a brand colour is established.`,
        basis: b.done(),
        palette: { light, dark, background: { kind: 'split' }, accentUse: 'field' },
        typography: typeFor(I, b, { voice: 'sans', weight: 800, tracking: -0.03 }),
        composition: { single: { family: 'split', deviceScale: 0.66, heading: true, bleed: 0.1, rulePx: 6 }, social: { family: 'field-split', deviceScale: 0.56, rulePx: 6 }, trio: { family: 'row' } },
        devices: { chrome: 'auto' },
        depth: { shadow: 'layered', ring: null, radius },
        motion: motionFor(b, { cursor: 'arrow', ripple: { style: 'ring', color: 'brand' }, zoom: 'standard', pacing: 'standard' }),
      };
    },
  },
  {
    id: 'minimal',
    name: 'Restrained minimal',
    fit(I) {
      return 0.7 + (['flat', 'bordered'].includes(I.surfaceStyle) ? 0.15 : 0);
    },
    build(I) {
      const b = new Basis();
      const lightBase = I.background.hex && lightness(I.background.hex) > 0.85 ? I.background.hex : PAPER;
      const darkBase = I.background.hex && lightness(I.background.hex) < 0.3 ? I.background.hex : '#111317';
      if (I.background.hex) b.use('tokens.colors.background', I.background.hex, 0.7);
      else b.fallback('palette.canvas', 'no reliable page background in the profile', `neutral ${PAPER} / #111317`);
      if (!I.background.hex || lightness(I.background.hex) <= 0.85) b.choice('palette.light.canvas', 'the product background is not a light neutral, so the light canvas is neutral paper to keep the product the focus');
      let accent = null;
      if (I.brand.hex) {
        b.use('tokens.colors.primary', I.brand.hex, I.brand.confidence);
        accent = I.brand.hex;
      } else b.fallback('palette.accent', I.brand.reason, 'text colour (no accent hue)');
      const text = I.text.hex && contrast(I.text.hex, lightBase) >= 7 ? I.text.hex : INK;
      if (I.text.hex) b.use('tokens.colors.text', I.text.hex, 0.7);
      const light = paletteOn(lightBase, { accent, text });
      const dark = paletteOn(darkBase, { accent, text: WHITE });
      const radius = radiusFor(I, b);
      return {
        id: 'minimal',
        name: 'Restrained minimal',
        archetype: 'minimal',
        rationale: `Gets out of the product's way: a flat canvas taken from the product's own background, a centred stage, a hairline ring instead of a shadow, and the accent used only as a small tag. ${I.surfaceStyle ? `The product's own surfaces are ${I.surfaceStyle}, and this direction matches that restraint.` : 'The product surface style is not established, so restraint is the safe default.'}`,
        basis: b.done(),
        palette: { light, dark, background: { kind: 'solid' }, accentUse: 'tag' },
        typography: typeFor(I, b, { voice: 'sans', weight: 600, tracking: -0.02 }),
        composition: { single: { family: 'stage', deviceScale: 0.62, heading: true }, social: { family: 'copy-left', deviceScale: 0.67 }, trio: { family: 'cascade' } },
        devices: { chrome: 'auto' },
        depth: { shadow: 'none', ring: { px: 1, color: light.border }, radius },
        motion: motionFor(b, { cursor: 'dot', ripple: { style: 'pulse', color: 'ink' }, zoom: 'none', pacing: 'calm' }),
      };
    },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    fit(I) {
      return 0.6 + (I.heading.voice === 'serif' ? 0.2 : 0) + (I.brand.kind === 'neutral' ? 0.1 : 0);
    },
    build(I) {
      const b = new Basis();
      const paperLight = mix(PAPER, '#f0e8da', 0.55);
      b.choice('palette.canvas', 'warm paper stock is an editorial stylistic choice, not an observed brand value');
      let accent = null;
      if (I.brand.hex) {
        b.use('tokens.colors.primary', I.brand.hex, I.brand.confidence);
        accent = I.brand.hex;
      } else b.fallback('palette.accent', I.brand.reason, 'ink (rule and frame drawn in the text colour)');
      const tint = (c) => (accent ? mix(c, accent, 0.03) : c);
      const light = paletteOn(tint(paperLight), { accent, text: INK });
      const dark = paletteOn(tint('#16140f'), { accent, text: '#f3eee4' });
      const radius = I.radius !== null ? Math.min(I.radius, 6) : 4;
      b.choice('depth.radius', 'editorial layouts use squarer corners than the product');
      const t = typeFor(I, b, { voice: 'serif', weight: 500, tracking: -0.02, forceVoice: 'serif' });
      return {
        id: 'editorial',
        name: 'Editorial',
        archetype: 'editorial',
        rationale: `A poster-style layout: an oversized serif headline top-left, a short accent rule, and the product set lower-right inside an offset frame with a flat print-style shadow. It suits a product with something to say and gives the screenshot room to be read. ${accent ? `The accent (${accent}) appears only as the rule and the frame.` : 'No reliable accent colour, so the rule and frame use the text colour.'}`,
        basis: b.done(),
        palette: { light, dark, background: { kind: 'tint' }, accentUse: 'rule' },
        typography: t,
        composition: { single: { family: 'poster', deviceScale: 0.56, heading: true, rulePx: 3 }, social: { family: 'stage-top', deviceScale: 0.86 }, trio: { family: 'stack' } },
        devices: { chrome: 'auto' },
        depth: { shadow: 'hard', ring: null, radius },
        motion: motionFor(b, { cursor: 'arrow', ripple: { style: 'ring', color: 'ink' }, zoom: 'subtle', pacing: 'calm' }),
      };
    },
  },
  {
    id: 'dark-stage',
    name: 'Dark stage',
    fit(I) {
      if (I.background.dark === true) return 0.85;
      return 0.4;
    },
    build(I) {
      const b = new Basis();
      let canvas = '#0e1013';
      if (I.background.hex && lightness(I.background.hex) < 0.3) {
        canvas = mix(I.background.hex, BLACK, 0.25);
        b.use('tokens.colors.background', I.background.hex, 0.7);
      } else b.choice('palette.canvas', 'a near-black stage is a stylistic choice that makes the product pop; it is not an observed brand value');
      let accent = null;
      if (I.brand.hex) {
        b.use('tokens.colors.primary', I.brand.hex, I.brand.confidence);
        accent = ensureContrast(I.brand.hex, canvas, 4.5);
        if (accent !== I.brand.hex) b.choice('palette.accent', `the brand colour was lightened to ${accent} to stay readable on the dark stage`);
      } else b.fallback('palette.accent', I.brand.reason, 'white');
      const pal = paletteOn(canvas, { accent: accent ?? WHITE, text: '#f4f5f7' });
      const radius = radiusFor(I, b);
      return {
        id: 'dark-stage',
        name: 'Dark stage',
        archetype: 'dark-stage',
        rationale: `${I.background.dark === true ? 'The product itself is a dark interface, so a dark stage lets it sit in its native context with no jarring brightness change.' : 'A dark stage makes a light interface the brightest thing in the frame.'} The product is shown large and bleeds off the bottom edge; the accent is a highlight, not a field.`,
        basis: b.done(),
        palette: { light: pal, dark: pal, background: { kind: 'solid' }, accentUse: 'highlight' },
        typography: typeFor(I, b, { voice: 'sans', weight: 700, tracking: -0.02 }),
        composition: { single: { family: 'bleed', deviceScale: 0.9, heading: false }, social: { family: 'stage-top', deviceScale: 0.8 }, trio: { family: 'row' } },
        devices: { chrome: 'dark' },
        depth: { shadow: 'soft', ring: null, radius },
        motion: motionFor(b, { cursor: 'ring', ripple: { style: 'pulse', color: 'brand' }, zoom: 'standard', pacing: 'brisk' }),
      };
    },
  },
];

export { readable };
