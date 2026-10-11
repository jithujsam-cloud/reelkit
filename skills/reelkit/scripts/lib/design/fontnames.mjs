// Font-name helpers shared by the page analysis and the source scanner. Pure; no I/O.

// next/font rewrites a family to a build-time alias: "__Inter_5e0a8e", and its metric-matched
// fallback "__Inter_Fallback_5e0a8e". The alias is an implementation detail; the family is "Inter".
const GENERATED = /^__(.+?)_([0-9a-f]{6,8})$/i;

/** → { family, generated, fallback } for a single family name (quotes allowed). */
export function normalizeFontFamily(raw) {
  const name = String(raw).trim().replace(/^['"`]|['"`]$/g, '');
  const m = name.match(GENERATED);
  if (!m) return { family: name, generated: false, fallback: false };
  const fallback = /_Fallback$/i.test(m[1]);
  return { family: m[1].replace(/_Fallback$/i, '').replace(/_/g, ' '), generated: true, fallback };
}

const ACRONYMS = new Set(['ibm', 'dm', 'pt', 'eb']);

/** "@fontsource/playfair-display" / "@fontsource-variable/inter-tight" → "Playfair Display" / "Inter Tight". */
export function fontsourceFamily(pkgName) {
  const m = String(pkgName).match(/^@fontsource(?:-variable)?\/(.+)$/);
  if (!m) return null;
  return m[1]
    .split('-')
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}
