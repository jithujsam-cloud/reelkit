# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Design intelligence Phase 0 (measurement only, no styling changes); see `docs/design/phase0-baseline.md`.
- Screen-region authenticity check: framed stills record their screen geometry, and `verify` adds an
  `authentic` check proving the framed screen is a pixel-exact copy of the raw capture (rounded clips
  masked; scaled placements refused). Older results without geometry skip it.
- Small colour utilities (`scripts/lib/color.mjs`): WCAG contrast, OKLab/OKLCH, ΔEok.
- Renderer regression baseline (`tests/frame.test.mjs`, `tests/fixtures/frame-baseline.json`):
  exact geometry and screen pixels for every device frame, background probes, locked frame defaults.
- Tests: colour utilities, authenticity (synthetic, committed assets, end-to-end verify), config.

### Added (design intelligence, Phase 1: design profile; observation only)
- `reelkit design`: inspects a site at desktop/tablet/mobile (+ a dark-scheme probe) and writes
  `.reelkit/design/design-profile.json` (+ `.md`): colours, typography, spacing, shape, surfaces,
  layout, responsive behaviour, logo/favicon/share image, each with confidence and cited evidence.
- Observed rendering outranks CSS variables, which outrank repo docs; disagreements are kept under
  `conflicts`, unknown values are `null` with a reason under `missing`, and a guard records when an
  observed colour coincides with reelkit's default purple (which is never used as a fallback).
- Failed stylesheets cap confidence at 40% with a visible warning; browser-default link blue is flagged.
- `schema/design-profile.schema.json`, `reference/design-profile.md`, `docs/design/phase1-design-profile.md`.
- Tests: `tests/design-profile.test.mjs` (schema, missing values, confidence, conflicts, guard, fixture sites).
- `discover.mjs` now exports `walk` (no behaviour change).

### Fixed
- `loadConfig()` no longer throws when called twice in one process (schema compiled once).

## [0.1.0] - 2026-10-11

### Added
- Claude Code skill (`skills/reelkit/SKILL.md`) with a mandatory visual QA step and on-demand reference docs.
- Plugin + marketplace manifests: `/plugin install reelkit --marketplace jithujsam-cloud/reelkit`.
- CLI `reelkit` with `preflight`, `discover`, `init`, `auth`, `shoot`, `record`, `frame`, `verify`, `readme`, `all`.
- Stability engine: network quiet, fonts, lazy scroll, images, skeleton/spinner detection,
  `getAnimations()` polling, pixel-diff gate, escalating retries, FAILED instead of shipping.
- Determinism: frozen clock, locale/timezone, reduced motion for stills, built-in hide list
  (consent banners, chat widgets, toasts, dev overlays), masks for PII.
- Auth modes: manual (headed login, OAuth/2FA friendly), form (env vars), token/bypass headers;
  expired-session detection with exit code 3.
- Recording: CDP screencast at 2×, synthetic cursor with ripple, human typing, zoom toward clicks,
  dead-time trim, seamless loops; MP4 + WebM + GIF under a byte budget (gifski or ffmpeg).
- Framing: browser, phone (status bar safe area), tablet, laptop; background presets; responsive trio;
  1280×640 social preview; hero; light/dark variants and `<picture>` README blocks.
- QA: automated checks, sampled frames, contact sheet, `qa-report.json` with hash-pinned visual verdicts,
  `manifest.json`.
- Route discovery for Next.js (app/pages), SvelteKit, Remix, Astro, React Router, static HTML.
- `examples/demo-app` test bed (login, dashboard, charts, skeleton, cookie banner, modal, chaos modes).
- CI: tests on Linux/macOS/Windows, `reelkit all` on the demo app, deliberate stability-break check.
