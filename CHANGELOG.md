# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
