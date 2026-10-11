# Design inspection (`reelkit design inspect`)

Describes the site's real visual identity as it renders today. It writes two files, by default to
`.reelkit/design/` (git-ignored):

- `design-profile.json`: machine-readable, validated against `schema/design-profile.schema.json`.
- `design-profile.md`: the same content for people, with evidence grouped by route.

It is read-only with respect to everything else: it does not change capture styles, defaults, framing,
committed media or verification results, and nothing in the capture pipeline reads the profile yet.

```bash
reelkit design inspect                    # every configured route, light + dark, desktop + mobile
reelkit design inspect --only home,pricing
reelkit design inspect --source ./web     # where to look for CSS/tokens/docs (default: project root)
reelkit design inspect --no-source        # rendered site only
reelkit design inspect --out ./profile --json
```

Exit code 2 when no page could be rendered (the profile is still written, marked `not rendered`).

## What is inspected

**Rendered site (primary).** For each route (scene actions are not run), in light and dark colour
scheme, at desktop and mobile widths: computed styles of the body, headings, primary-styled buttons,
links, active navigation items, surfaces (cards, panels, sidebars) and inputs; CSS custom properties
and their computed values; radii, shadows, borders and spacing; loaded web fonts; logo (SVG colours are
read from shapes and gradient stops; the SVG is saved under `assets/`); favicon, `theme-color`, web
manifest and `og:image`; navigation layout, content width and horizontal overflow; and a colour census
of the stabilised screenshot.

**Source and docs (secondary).** A static scan, never executed: `DESIGN.md`, `BRAND.md`, style guides
and similar Markdown; CSS custom properties (light and dark scopes); Tailwind config and token JSON;
`components.json` (shadcn); `package.json` design-system and `@fontsource` dependencies; `next/font`
imports; web manifests. `node_modules`, build output, `.reelkit` and Reelkit's own files are skipped.

## How findings are decided

Every finding carries `value`, `basis`, `confidence` (0-1), `level` and `sources`:

| basis | meaning |
|---|---|
| `observed` | measured on the rendered site (possibly also declared) |
| `declared` | found only in source or docs; confidence capped at 0.6 |
| `inferred` | a heuristic reading of observed facts (style, density, base unit), with `because` |
| `unknown` | no evidence: `value` is `null` and `reason` says why |

Evidence weights: rendered role 3, rendered CSS variable 2.5, logo 2, meta/manifest 1.5, screenshot
pixels 1, source CSS / tokens / docs 1 each. Colours within ΔEok 0.05 (0.012 for neutrals) are the same
colour. Confidence is the winner's weight against the runner-up, discounted when it rests on one kind of
evidence (or, for fonts, one route).

Rules that keep the profile honest:

- The rendered site wins over documentation. A declared value that differs from what renders is
  recorded under `conflicts` with both values, the file, and ΔE; it is never silently dropped.
- Nothing is invented. A greyscale site gets `primary: null` ("monochrome"), not a default colour; a
  missing logo, font or dark theme is listed under `unverified`. Reelkit's own palette never appears
  unless the inspected site uses it.
- Font status distinguishes a loaded web font, a web font that did not load (a fallback renders), a
  generic system stack, and a local font that depends on the viewer's machine.
- Dark mode: `supported` (prefers-color-scheme changes the page), `default` (dark without asking),
  `unverified` (dark rules exist behind a class toggle that was not exercised) or `none`.
- Protected routes are inspected with the saved session (`reelkit auth`); without one they are reported
  as `auth required` and skipped, never logged into.
- Output is deterministic: no timestamps, sorted evidence; re-running on an unchanged site gives a
  byte-identical JSON file.

## Limits

Cross-origin stylesheets cannot be read (only their computed effect is seen). Pages behind interactions
(modals, tabs, scene actions) are not visited. Class-toggled themes are detected but not switched.
Pixel shares come from one desktop screenshot per route and theme. The profile describes; it does not
yet steer rendering.
