// Turns a design profile into the facts directions are allowed to use, and says plainly which ones
// are missing or too uncertain. A value is "usable" at confidence >= 0.5 (medium or better) and, for
// the brand colour, only when it was actually observed in use. Anything else is reported, never guessed.
import { oklabToOklch, parseHex, rgbToOklab } from '../color.mjs';
import { lightness } from './palette.mjs';

export const USABLE_CONFIDENCE = 0.5;

const SERIF = /(georgia|times|garamond|playfair|lora\b|merriweather|fraunces|serif(?!.*sans)|cormorant|baskerville|crimson|bitter|spectral|newsreader|literata)/i;
const MONO = /(mono|code|courier|consolas|menlo|plex mono|jetbrains)/i;

/** Generic class of a family name. Only a class is ever used; font files are never embedded by default. */
export function fontVoice(family) {
  if (!family) return null;
  if (MONO.test(family)) return 'mono';
  if (/sans/i.test(family)) return 'sans';
  return SERIF.test(family) ? 'serif' : 'sans';
}

const tok = (t) => (t && t.value !== null && t.value !== undefined ? t : null);
const usable = (t) => !!tok(t) && t.confidence >= USABLE_CONFIDENCE;

export function readInputs(profile) {
  const T = profile.tokens;
  const C = T.colors;
  const warnings = [...(profile.summary.warnings ?? [])];
  const hex = (t) => (usable(t) ? t.value.hex : null);

  const primary = tok(C.primary);
  const observedUse = primary && ['interactive', 'neutral-interactive'].includes(primary.basis);
  const brandHex = primary && observedUse && usable(primary) ? primary.value.hex : null;
  const chroma = brandHex ? oklabToOklch(rgbToOklab(parseHex(brandHex)))[1] : 0;
  const brand = {
    hex: brandHex,
    kind: brandHex ? (chroma >= 0.06 ? 'chromatic' : 'neutral') : null,
    confidence: primary?.confidence ?? 0,
    basis: primary?.basis ?? null,
    reason: brandHex ? null : !primary ? (C.primary.reason ?? 'no brand colour in the profile') : !observedUse ? `the profile's brand colour is ${primary.basis ?? 'unverified'}, not observed in use` : `brand colour confidence ${primary.confidence} is below ${USABLE_CONFIDENCE}`,
  };
  const background = hex(C.background);
  const text = hex(C.text);
  const heading = tok(T.typography.heading);
  const body = tok(T.typography.body);
  const radiusTok = tok(T.shape.radiusCard) ?? tok(T.shape.radiusButton);
  const radius = radiusTok && usable(radiusTok) ? (radiusTok.value === 'pill' ? 16 : Math.min(24, Math.max(0, Number(radiusTok.value) || 0))) : null;
  const dark = tok(T.schemes.prefersDark);
  const overall = profile.summary.overallConfidence;
  if (overall < USABLE_CONFIDENCE) warnings.push(`overall profile confidence is ${overall}; directions use neutral fallbacks where values are uncertain`);
  if (dark?.value?.status === 'unverified') warnings.push('the site has a dark theme this inspection could not verify');
  return {
    brand,
    background: { hex: background, dark: background ? lightness(background) < 0.4 : null },
    text: { hex: text },
    surface: { hex: hex(C.surface) },
    heading: { family: heading && usable(heading) ? heading.value.family : null, confidence: heading?.confidence ?? 0, voice: heading && usable(heading) ? fontVoice(heading.value.family) : null },
    body: { family: body && usable(body) ? body.value.family : null, voice: body && usable(body) ? fontVoice(body.value.family) : null },
    radius,
    surfaceStyle: usable(T.surfaces.style) ? T.surfaces.style.value.kind : null,
    siteName: profile.site.name || profile.site.title || null,
    quality: overall < USABLE_CONFIDENCE || (profile.summary.warnings ?? []).length > 0 ? 'low' : 'ok',
    overall,
    warnings,
  };
}
