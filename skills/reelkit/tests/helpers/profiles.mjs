// Synthetic design profiles for unit tests: built through the real profile pipeline from hand-made
// observations, so they are exactly as valid as a profile from a real site.
import { parseHex } from '../../scripts/lib/color.mjs';
import { profileFromObservations } from '../../scripts/lib/design/index.mjs';

export const rgba = (hex, a = 1) => [...parseHex(hex), a];
const FONT = (family = 'Inter, sans-serif', size = 16) => ({ family, size, weight: 400, lineHeight: 24, letterSpacing: 0, transform: 'none' });
export const el = (role, over = {}) => ({ tag: 'div', role, textLen: role === 'text' ? 40 : 0, color: null, bg: null, parentBg: rgba('#ffffff'), borderColor: null, borderWidth: 0, radius: 0, shadow: null, pad: [0, 0, 0, 0], gap: null, margin: [0, 0], font: FONT(), rect: [0, 0, 200, 40], ...over });

const VIT = { viewport: [1440, 900], overflowX: false, bodyFontSize: 16, h1: null, gridMaxCols: 0, headerPosition: null, navLinksVisible: null, menuButtonVisible: null, contentWidthPx: 1000 };

function observation(elements, main = {}, extra = {}) {
  const bg = main.pageBg?.rgba ?? rgba('#ffffff');
  return {
    url: 'http://t.test/', finalUrl: 'http://t.test/', errors: [],
    main: { url: 'http://t.test/', title: 'Test site', lang: 'en', description: null, siteName: null, themeColor: null, pageBg: { rgba: bg, defaulted: false }, bodyText: rgba('#111111'), elements, elementsTotal: elements.length, vars: [], fontFaces: [], documentFonts: [], unreadableSheets: 0, unreadableHrefs: [], darkClassRules: 0, rootDarkMarker: false, themeToggle: false, icons: [], ogImage: null, manifest: null, logos: [], layout: { maxWidths: {}, headerSticky: null }, vitals: { ...VIT }, ...main },
    responsive: { desktop: { ...VIT }, mobile: { ...VIT, viewport: [390, 844] } },
    dark: { bg, text: rgba('#111111'), button: null },
    light: { bg, text: rgba('#111111') },
    ...extra,
  };
}

const text = (hex = '#111111', family, n = 8) => Array.from({ length: n }, () => el('text', { color: rgba(hex), ...(family ? { font: FONT(family) } : {}) }));
const buttons = (hex, n = 8) => Array.from({ length: n }, () => el('button', { bg: rgba(hex), color: rgba('#ffffff'), textLen: 8, pad: [12, 24, 12, 24], radius: 8, rect: [0, 0, 120, 44] }));
const cards = (bg, parent, n = 4) => Array.from({ length: n }, () => el('card', { bg: rgba(bg), parentBg: rgba(parent), borderColor: rgba('#e5e7eb'), borderWidth: 1, radius: 12, rect: [0, 0, 400, 120] }));
const headings = (family) => [1, 2, 3].flatMap((level) => [el('heading', { level, textLen: 20, font: FONT(family, 48 - level * 8) }), el('heading', { level, textLen: 20, font: FONT(family, 48 - level * 8) })]);

const make = (elements, main, extra) => profileFromObservations([observation(elements, main, extra)], { url: 'http://t.test/' });

/** Named profiles covering the situations directions must handle. */
export const PROFILES = {
  /** Strong chromatic brand, light UI, serif headings. */
  green: () => make([...text('#23301f', 'Inter, sans-serif'), ...headings("Georgia, serif"), ...buttons('#1f7a4d'), ...cards('#ffffff', '#f7f4ec')], { pageBg: { rgba: rgba('#f7f4ec'), defaulted: false } }),
  /** Warm coral brand, sans headings. */
  coral: () => make([...text('#2a1b18'), ...headings('Inter, sans-serif'), ...buttons('#e8604c'), ...cards('#ffffff', '#fff8f5')], { pageBg: { rgba: rgba('#fff8f5'), defaulted: false } }),
  /** A brand that really is Reelkit's default purple. */
  purple: () => make([...text('#e9e9f5'), ...headings('Inter, sans-serif'), ...buttons('#7c5cff'), ...cards('#151526', '#0b0b14')], { pageBg: { rgba: rgba('#0b0b14'), defaulted: false } }),
  /** Monochrome: black buttons on white. */
  mono: () => make([...text('#111111', 'Times New Roman, serif'), ...headings('Times New Roman, serif'), ...buttons('#111111')], {}),
  /** Dark interface. */
  dark: () => make([...text('#e6e8ee'), ...headings('Inter, sans-serif'), ...buttons('#3b82f6'), ...cards('#1a1d27', '#0f1117')], { pageBg: { rgba: rgba('#0f1117'), defaulted: false } }),
  /** Almost nothing observed. */
  sparse: () => make([el('text', { color: rgba('#222222') })], {}),
  /** A stylesheet failed: every value is capped at 40%. */
  brokenCss: () => make([...text('#111111'), ...buttons('#0b6bcb')], {}, { failedResources: [{ url: 'http://t.test/brand.css', type: 'stylesheet', reason: 'HTTP 404' }] }),
  /** Brand colour only declared in CSS, never seen rendering. */
  declaredOnly: () => make([...text('#111111'), ...headings('Inter, sans-serif')], { vars: [{ name: '--primary', scope: 'root', raw: '#0a7f5a', rgba: rgba('#0a7f5a') }] }),
  /** Very light brand (yellow) and very dark brand (navy): contrast has to be engineered. */
  yellow: () => make([...text('#222222'), ...headings('Inter, sans-serif'), ...buttons('#ffe14d')], {}),
  navy: () => make([...text('#222222'), ...headings('Inter, sans-serif'), ...buttons('#0b1b3a')], {}),
};
