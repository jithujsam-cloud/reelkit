# Architecture

reelkit is a Claude Code skill plus a Node CLI. The skill (`skills/reelkit/SKILL.md`) tells Claude
*what to do and when to look*; the CLI does the deterministic work. Claude is the final quality gate:
nothing is "done" until Claude has opened every asset and recorded a verdict.

```
skills/reelkit/
  SKILL.md                 workflow Claude follows (short)
  reference/*.md           detail loaded on demand (config, auth, stability, QA rubric, motion, framing)
  scripts/reelkit.mjs      single CLI entry: init auth discover shoot record frame verify readme all
  scripts/lib/             engine modules (one concern per file)
  templates/               device frames + backgrounds as HTML/CSS (no trademarked artwork)
  schema/                  JSON Schema for reelkit.config.yaml
```

## Pipeline

```
config.yaml ──► expand scenes × viewports × themes ──► shots
shots(still) ──► browser context (locale, tz, clock, reducedMotion, storageState, headers)
            ──► goto ──► auth check ──► actions ──► STABILITY ENGINE ──► screenshot ──► manifest
shots(motion) ─► CDP screencast (2x) + synthetic cursor/zoom ──► timestamped frames
            ──► ffmpeg (hold-capped durations = dead-time trim) ──► mp4 / webm ──► gifski (budget loop)
frame ──► HTML templates rendered by Chromium ──► framed png, trio, social, hero (light + dark)
verify ──► programmatic checks + sampled frames ──► Claude reviews ──► qa-report.json verdicts
readme ──► <!-- reelkit:start --> … <!-- reelkit:end --> block
```

## Stability engine (no mid-animation frames)

A still is captured only when, within one attempt, all gates pass in order:

1. **Network quiet**: zero in-flight requests (ignoring websockets/SSE and configured patterns) for 500ms.
2. **Fonts**: `document.fonts.ready` and no font in `loading` state.
3. **Lazy content**: scroll the page in viewport steps to trigger lazy loading, then back to the target position.
4. **Images**: every `<img>` is `complete` with `naturalWidth > 0` (broken images fail with their URL).
5. **Busy indicators**: no visible element matching skeleton/spinner selectors or heuristics (`aria-busy`, class names containing skeleton/shimmer/spinner/loading).
6. **Animations**: `document.getAnimations()` has nothing running (finite animations are awaited; infinite ones fail unless allowlisted or hidden).
7. **Pixels**: consecutive screenshots ~400ms apart differ by less than the threshold, N times in a row.

Up to 3 attempts with escalating waits; after that the asset is marked `FAILED` with the gate that failed.

## Why CDP screencast instead of Playwright's recordVideo

`recordVideo` encodes VP8 at ~1 Mbit/s, which smears 2x text. We pull screencast frames (JPEG q≈92) with
their timestamps and assemble them ourselves, which also gives dead-time trimming for free: identical
frames are never emitted, and each frame's on-screen duration is capped (`maxHold`).

## Naming

All names derive from `scripts/lib/brand.mjs` (`NAME = 'reelkit'`): CLI name, `.reelkit/` work dir,
`REELKIT_*` env vars, README markers. Rename the project by changing that one constant (plus the
folder name and manifests).
