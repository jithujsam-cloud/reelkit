// design-profile.json → design-profile.md. Deterministic, and it states uncertainty as prominently
// as it states values.
const pct = (c) => `${Math.round(c * 100)}%`;
const badge = (t) => `${t.level} (${pct(t.confidence)})`;
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');

export function renderMarkdown(p) {
  const { colors: c, typography: t, spacing: s, shape: sh, surfaces: sf, layout: l, responsive: r, schemes } = p.tokens;
  const ev = new Map(p.evidence.map((e) => [e.id, e]));
  const cite = (tok) => (tok.sources.length ? tok.sources.join(', ') : '—');
  const out = [];
  const name = p.site.name || p.site.title || p.site.url;
  out.push(`# Design profile: ${name}`, '');
  out.push(`Source: ${p.site.url} · reelkit ${p.generator.version}`);
  out.push(`Overall confidence in the core tokens: **${p.summary.level} (${pct(p.summary.overallConfidence)})** · ${p.summary.conflicts} conflict(s) · ${p.summary.missing} value(s) not found`, '');
  for (const w of p.summary.warnings ?? []) out.push(`> **Warning:** ${w}`, '');
  out.push('> Everything here was measured from the rendered site unless a row says otherwise. Values that could not be established are listed under **Not found**, not filled in. Machine-readable twin: `design-profile.json` (evidence ids like `e3` refer to its `evidence` list).', '');

  out.push('## Colour', '');
  const crow = (label, tok) => [label, tok.value ? `\`${tok.value.hex}\` (oklch ${tok.value.oklch.l} ${tok.value.oklch.c} ${tok.value.oklch.h})` : '—', tok.value ? badge(tok) : 'not found', [tok.basis, ...(tok.notes ?? []), tok.reason].filter(Boolean).join('; ')];
  out.push(table(['Role', 'Value', 'Confidence', 'Notes'], [crow('Background', c.background), crow('Text', c.text), crow('Muted text', c.textMuted), crow('Primary', c.primary), crow('Accent', c.accent), crow('Surface', c.surface), crow('Border', c.border), crow('Danger', c.danger), crow('Success', c.success), crow('Warning', c.warning)]), '');
  if (c.palette.value?.length) out.push(`Observed palette (by weighted use): ${c.palette.value.map((x) => `\`${x.hex}\` ${pct(x.share)}`).join(' · ')}`, '');
  const pd = schemes.prefersDark.value;
  if (pd) {
    out.push(
      pd.responds
        ? `Dark scheme: the page responds to \`prefers-color-scheme: dark\` (background \`${pd.background}\`, text \`${pd.text}\`).`
        : pd.status === 'unverified'
          ? `Dark scheme: **unverified**. ${schemes.prefersDark.notes[0]}`
          : 'Dark scheme: none found (the page ignores `prefers-color-scheme`, and no class-based dark rules or theme toggle were detected).',
      '',
    );
  }

  out.push('## Typography', '');
  const frow = (label, tok) => [label, tok.value ? `${tok.value.family ?? 'generic stack'}${tok.value.generated ? ` (\`${tok.value.cssFamily}\`)` : ''}` : '—', tok.value ? tok.value.origin : '', tok.value ? badge(tok) : 'not found', [...(tok.notes ?? []), tok.reason].filter(Boolean).join('; ')];
  out.push(table(['Role', 'Family', 'Origin', 'Confidence', 'Notes'], [frow('Headings', t.heading), frow('Body', t.body), frow('Buttons / UI', t.ui), frow('Monospace', t.mono)]), '');
  if (t.base.value) out.push(`Body text: ${t.base.value.size}px, weight ${t.base.value.weight}${t.base.value.lineHeightRatio ? `, line-height ${t.base.value.lineHeightRatio}` : ''} (${badge(t.base)}).`);
  if (t.headings.value) out.push('', table(['Level', 'Size', 'Weight', 'Line height', 'Letter spacing'], Object.entries(t.headings.value).map(([k, h]) => [k, `${h.size}px`, h.weight, h.lineHeight ? `${h.lineHeight}px` : 'normal', h.letterSpacing ? `${h.letterSpacing}px` : '0'])));
  out.push('', t.scale.value ? `Heading scale ratio ≈ ${t.scale.value.ratio} across ${t.scale.value.levels} levels (${badge(t.scale)}).` : `Type scale: not estimated (${t.scale.reason}).`);
  if (t.buttonCase.value) out.push(`Button text-transform: \`${t.buttonCase.value}\`.`);
  out.push('');

  out.push('## Spacing, shape and surfaces', '');
  for (const d of p.site.designSystems ?? []) out.push(`- Design system signal: **${d.name}**${d.style ? `, style \`${d.style}\`` : ''}${d.baseColor ? `, base colour \`${d.baseColor}\`` : ''}${d.css ? `, stylesheet \`${d.css}\`` : ''} (from the project's components.json).`);
  out.push(s.unit.value ? `- Spacing base unit: **${s.unit.value}px** (${badge(s.unit)}); common values ${s.scale.value.map((x) => `${x.value}`).join(', ')}px.` : `- Spacing base unit: not established (${s.unit.reason}).`);
  const rad = (k, tok) => (tok.value === null ? `${k}: —` : `${k}: ${tok.value === 'pill' ? 'pill' : `${tok.value}px`}`);
  out.push(`- Corner radius: ${[rad('buttons', sh.radiusButton), rad('cards', sh.radiusCard), rad('inputs', sh.radiusInput)].join(' · ')}`);
  out.push(sf.style.value ? `- Surface style: **${sf.style.value.kind}** (${sf.style.value.n} cards: ${pct(sf.style.value.shadowShare)} shadowed, ${pct(sf.style.value.borderShare)} bordered, ${pct(sf.style.value.fillShare)} filled; ${badge(sf.style)}).` : `- Surface style: not established (${sf.style.reason}).`);
  out.push(sf.shadows.value ? `- Shadows: ${sf.shadows.value.map((x) => `\`${x.css}\` ×${x.count}`).join('; ')}` : `- Shadows: none observed.`);
  out.push('');

  out.push('## Layout and responsive behaviour', '');
  out.push(l.maxContentWidth.value ? `- Max content width: ${l.maxContentWidth.value}px (${badge(l.maxContentWidth)}).` : `- Max content width: not found (${l.maxContentWidth.reason}).`);
  out.push(l.headerSticky.value === null ? '- Header: not found.' : `- Header is ${l.headerSticky.value ? 'sticky/fixed' : 'static'}.`);
  out.push(l.gridColumns.value ? `- Widest CSS grid on desktop: ${l.gridColumns.value} columns.` : `- CSS grid: ${l.gridColumns.reason}.`);
  if (r.viewports.value) {
    out.push('', table(['Viewport', 'Body px', 'H1 px', 'Grid cols', 'Header links', 'Menu button', 'Overflows x'], r.viewports.value.map((v) => [`${v.name} ${v.viewport[0]}px`, v.bodyFontSize ?? '—', v.h1?.size ?? '—', v.gridMaxCols || '—', v.navLinksVisible ?? '—', v.menuButtonVisible === null ? '—' : v.menuButtonVisible ? 'yes' : 'no', v.overflowX ? 'YES' : 'no'])));
    out.push('', r.behaviors.value?.length ? r.behaviors.value.map((n) => `- ${n.detail}`).join('\n') : '- No notable responsive differences detected (this does not prove the layout is not responsive).');
  } else out.push(`- Responsive: ${r.viewports.reason}.`);
  out.push('');

  out.push('## Logo and brand assets', '');
  const a = p.assets;
  out.push(a.logo.value ? `- Logo (${badge(a.logo)}): ${a.logo.value.kind}${a.logo.value.src ? ` ${a.logo.value.src}` : ''}${a.logo.value.savedAs ? `, saved as \`${a.logo.value.savedAs}\`` : ''}, ${a.logo.value.width}×${a.logo.value.height}px.` : `- Logo: not found (${a.logo.reason}).`);
  out.push(a.favicon.value ? `- Favicon (${badge(a.favicon)}): ${a.favicon.value.href}` : `- Favicon: not found (${a.favicon.reason}).`);
  out.push(a.ogImage.value ? `- Share image (${badge(a.ogImage)}): ${a.ogImage.value.href}` : `- Share image: not found (${a.ogImage.reason}).`);
  out.push(a.themeColor.value ? `- theme-color meta: \`${a.themeColor.value.hex}\`` : '- theme-color meta: none.', '');

  out.push('## Conflicts between sources', '');
  if (!p.conflicts.length) out.push('None detected. (Either the sources agree, or only one source exists.)');
  else {
    out.push('The rendered site always wins; the other value is kept here so nothing is hidden.', '');
    out.push(table(['Token', 'Rendered / observed', 'Claimed', 'Source', 'ΔE'], p.conflicts.map((x) => [x.path.replace('tokens.', ''), x.observed?.value ?? '— (not observed)', x.claimed.value, `${x.claimed.via ?? ''} @ ${ev.get(x.claimed.evidence)?.where ?? ''}`, x.deltaE ?? ''])));
  }
  out.push('');

  out.push('## Not found', '');
  out.push(p.missing.length ? p.missing.map((m) => `- \`${m.path}\`: ${m.reason}`).join('\n') : 'Every token was established.', '');

  if (p.guards.reelkitDefaults.matches.length) {
    out.push('## Heads-up: matches Reelkit’s default palette', '');
    for (const m of p.guards.reelkitDefaults.matches) out.push(`- \`${m.path}\` = \`${m.hex}\` ≈ Reelkit default \`${m.reelkitDefault}\` (${m.defaultSource}). ${m.note}`);
    out.push('');
  }

  out.push('## Method and limitations', '');
  out.push(`Evidence priority: rendered computed styles > CSS variables served by the site > repo docs/config. Confidence is scored from how many sampled elements agree, capped when support is thin, raised when an independent source agrees and lowered per conflict (${p.evidence.length} evidence items in the JSON).`, '');
  out.push(p.limitations.map((x) => `- ${x}`).join('\n'), '');
  out.push(`Evidence index: ${['rendered', 'css-variable', 'repo-file', 'markup'].map((k) => `${p.evidence.filter((e) => e.kind === k).length} ${k}`).join(', ')}.`, '');
  return out.join('\n');
}
