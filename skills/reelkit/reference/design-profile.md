# Design profile (`reelkit design`)

```
reelkit design --url https://example.com [--pages /pricing,/about] [--root .] [--out dir] [--json]
```

Inspects the live site as an anonymous visitor and writes two files to `.reelkit/design/`
(or `--out`):

| File | Purpose |
|---|---|
| `design-profile.md` | Human-readable identity: colour roles, type, spacing, shape, surfaces, layout, responsive behaviour, brand assets, then **Conflicts**, **Not found**, limitations. |
| `design-profile.json` | The same data as tokens with confidence and evidence. Validated against `schema/design-profile.schema.json` before it is written. |
| `design-profile.run.json` | Run metadata only: when it ran, reelkit version, pages, and SHA-256 of the two files above. The only output that changes between runs of an unchanged site. |
| `assets/` | Logo (inline SVG or image), favicon and og:image, when they could be downloaded (≤ 2 MB, images only). |

The command never edits `reelkit.config.yaml`, never reads `frame.*` from it (only `baseUrl`, when
`--url` is omitted), and never writes to `docs/media`.

## Evidence and precedence

1. **Rendered** (`kind: rendered`): computed styles of up to 1500 visible elements, measured by
   Chromium. Colours are normalised by the browser, so `oklch()`, `color-mix()` and CSS-variable chains
   arrive as sRGB. This always wins.
2. **CSS variables** the site serves (`css-variable`): `:root`/`html`/`body` custom properties, resolved
   the way the page would use them (including shadcn-style bare HSL channels).
3. **Repo files** (`repo-file`): design docs (`DESIGN.md`, `brand*.md`, …), `tailwind.config.*`,
   `tokens.json`/`theme.json`, and `.css` files under `--root` (default: the current directory), plus
   font declarations: `@fontsource/*` and `@fontsource-variable/*` dependencies in `package.json`, and
   `next/font/google` imports (a `variable: '--font-heading'` or const name hints the role). Those
   carry role `any` unless a hint or a "mono" name says otherwise: they can **corroborate** an observed
   font but never contradict it (a project may install fonts it does not use on the page).
   `components.json` (shadcn/ui) is recorded as a design-system signal under `site.designSystems`.
   Heuristic and line-based; each claim keeps its file and line.
4. **Markup** (`markup`): `<link rel=icon>`, `og:image`, `theme-color`.

A lower source never overrides a higher one. If it agrees it is cited and raises confidence; if it
disagrees the profile keeps the rendered value and records the disagreement in `conflicts`
(`resolution: observed-kept`). A value that is only declared, never seen rendering, is kept with
`basis: declared-only` and confidence ≤ 0.35 (`resolution: declared-used`).

## Token shape

Every leaf under `tokens.*` and `assets.*` is:

```json
{ "value": {...} | null, "confidence": 0.0-1.0, "level": "high|medium|low|none",
  "sources": ["e3","e9"], "basis": "...", "notes": ["..."], "reason": "only when value is null" }
```

* `level`: ≥ 0.75 high, ≥ 0.5 medium, > 0 low, 0 none.
* `sources` are ids into the top-level `evidence` list (`kind`, `where`, `detail`).
* `value: null` always has a `reason`, confidence 0, and an entry in `missing[]`.

### Confidence

`0.5 + 0.35 × share` (share of the role's evidence that agrees), capped at 0.55 when fewer than 3
elements support it, `+0.10` per independent agreeing source (max `+0.15`), `−0.15` per conflict.
Declared-only values cap at 0.35. If any stylesheet failed to load during inspection, every observed
value caps at 0.40 and `summary.warnings` says so. The exact link-blue defaults (`#0000ee`, `#551a8b`)
cap at 0.30.

## Guards

* Reelkit's own palette (`#7c5cff`, `#22d3ee`) is **never** a fallback: with no evidence, `primary` is `null`.
* If an *observed* colour coincides with that palette, `guards.reelkitDefaults.matches` records it
  (`observedOnSite: true`) and the `.md` adds a heads-up: the value is real, but a project using it
  cannot reveal brand mismatches. A match that was only declared is flagged `observedOnSite: false`.
* `guards.fallbacksUsed` is always `false` (the schema enforces it).

## Dark themes

`tokens.schemes.prefersDark.value` keeps `responds` (does `prefers-color-scheme: dark` change the page?)
and adds `status`:

| status | meaning |
|---|---|
| `verified` | it responds (dark colours are recorded), or nothing suggests a dark theme exists |
| `unverified` | it does not respond, but dark rules sit behind a class/attribute (`html.dark`, `[data-theme=dark]`, Tailwind `dark:`), a theme-toggle control exists, or unreadable cross-origin CSS (other than font hosts) could hide them. `toggle` says which; confidence drops to 0.35 and a limitation is added. Dark colours are **not** recorded and "no dark theme" must not be assumed. |

The inspection does not click toggles or add classes; that is deliberate for now.

## Pages that are not the site

* `401`/`403`, or a redirect to a login/SSO URL, marks a page **skipped** (`site.skipped`, plus a
  limitation). A login form is never reported as the site's design. If every page is skipped the command
  fails ("Every page needs login").
* Any other HTTP error (404, 500, …) fails the inspection instead of profiling the error page.
* An unreachable host fails with a `fix:` line. Nothing is written in any of these cases.

## Generated font names

`next/font` rewrites families to build-time aliases (`__Inter_5e0a8e`, with a metric fallback
`__Inter_Fallback_5e0a8e`). The profile reports the family (`value.family: "Inter"`), keeps the alias in
`value.cssFamily` with `generated: true`, ignores the fallback entry when choosing the first family, and
treats an alias as a web font (it can never be a system font).

## Determinism

`design-profile.json` and `design-profile.md` contain no timestamps, absolute paths or counters: for an
unchanged site, repeated runs write byte-identical files (asset file names are content hashes). The
time of each run lives only in `design-profile.run.json`, whose `profileSha256` lets you check that two
runs produced the same profile. `generator.generatedAt` is therefore optional in the schema (profiles
written by earlier versions that include it still validate).

## What it does not see

Pages behind login, hover/focus/active states, animations and modals, other pages unless named in
`--pages` (max 5), and the *intent* behind a role: "primary" means "the colour the site uses most on
buttons and links". Fonts: the profile records the family the CSS asks for; if that font is not
installed on the inspecting machine the note says so (the rendered fallback is in `value.rendered`).
Cross-origin stylesheets cannot be read for variables or `@font-face` rules; that is stated in the
limitations when it happens.
