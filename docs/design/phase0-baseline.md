# Design intelligence, Phase 0: renderer baseline and authenticity

Phase 0 adds measurement and regression protection only. It changes **no** defaults, presets,
layouts or output styling. Everything below was measured on the repository at commit `69410df`.

## Inventory at the start of Phase 0

| Area | State |
|---|---|
| Tests | `tests/stability.test.mjs` (8, fixtures for every stability gate), `tests/readme.test.mjs` (4, marker insertion). No renderer or framing tests. |
| CI | `npm test` in `skills/reelkit` on Linux/macOS/Windows; dogfood job runs `reelkit all --ci --no-readme` on the demo app plus a deliberate stability break. |
| Committed assets | 33 in `docs/media/`: 12 raw stills, 12 framed stills, 2 trios, 1 social card, MP4/WebM/GIF raw + framed. |
| Frame defaults | `scripts/lib/config.mjs:37`: `background: aurora`, `backgroundDark: midnight`, `accent: #7c5cff`, `padding: 72`, `radius: 12`, `shadow: true`. Presets in `templates/backgrounds.json`. |

## How design decisions reach pixels today

```
config.frame (or the defaults above)
  └─ frame.mjs  background(cfg, theme)  → preset CSS + "dark" flag
  └─ frame.mjs  baseOpts()              → { background, darkBg, accent, padding, radius, shadow, layout }
  └─ frame.mjs  spec()                  → device type from the viewport, image URL, chrome theme, URL label,
                                           phone status-bar colour sampled from the capture's top edge
  └─ templates/frame.html window.render → DOM, then Chromium screenshot at the capture's deviceScaleFactor
```

## What the baseline locks (`tests/frame.test.mjs`)

Synthetic, deterministic captures (a high-frequency pattern that exposes any offset or resampling)
go through the real renderer with the real built-in defaults:

* **Defaults:** the six `frame` defaults and the SHA-256 of `templates/backgrounds.json`.
* **Geometry, exact:** canvas size and screen rectangle (device px) for browser (desktop), tablet,
  phone (mobile), laptop (wide) and plain (custom viewport), in light and dark; canvas size of the
  trio (2700×1590) and social card (1280×640).
* **Screen pixels, exact:** the framed screen region must be a pixel-identical copy of the capture.
* **Background:** colour probes at canvas corners, within ΔEok 0.02 (≈ one just-noticeable
  difference), so presets cannot drift silently.

Deliberately **not** asserted: whole-image equality. The browser URL bar, headings and social copy
use the platform UI font, which legitimately differs between Linux, macOS and Windows runners.

Re-recording after an intentional renderer change: `REELKIT_UPDATE_BASELINE=1 npm test` (rewrites
`tests/fixtures/frame-baseline.json`; review the diff). Two consecutive re-recordings were
byte-identical.

**Established on the machine that produced the committed assets:** re-rendering the 12 framed
stills, both trios and the social card from the committed raw stills produced byte-identical files
(0 differing pixels each). This was a one-off check, not a CI assertion, for the font reason above.

## Screen-region authenticity

`scripts/lib/authenticity.mjs` compares the framed image's screen region with the raw capture.
`frame.mjs` now records the geometry (`screen.rect`, `screen.clips`, `screen.src`) in
`.reelkit/results.json`, and `verify` adds an `authentic` check. Results written before this change
have no geometry and simply skip the check.

Thresholds: a pixel differs when ΔEok > 0.02; at most 0.1 % may differ and the mean ΔEok must be
≤ 0.002. In practice the comparison is exact: all 12 committed framed stills have **0** differing
pixels (`tests/authenticity.test.mjs`).

### Effect of each rendering step

| Step | Effect on the comparison | Handling |
|---|---|---|
| Scaling | Stills: the screen is laid out at the viewport's CSS size and rendered at the capture's DSF, so it is 1:1. | Required. Fractional rectangles are refused as "unsupported", never approximated. |
| Cropping | The image is `object-fit: cover; object-position: top`; the screen always shows the capture's top-left region. | `screen.src = {0,0}`; the region must fit inside the raw capture or the check fails with a reason. |
| Phone status bar | The top 50 CSS px of the phone screen is reelkit's status bar, not the app. The viewport below it is 794 px tall, so the bottom 50 CSS px of the capture are cropped. | Only the `.viewport` area is compared; the status bar is composition, not product pixels. |
| Rounded corners | Viewport corners and the clipping parent's corners. On phones the parent's 51 px arc starts at the status bar and still clips the viewport's top two device rows. | The template reports every rounded clip; pixels outside any clip, plus a 1.5 px anti-aliasing band, are masked (364 px per desktop frame, 2,444 per tablet, 4,966 per phone). |
| Colour management | Chromium runs with `--force-color-profile=srgb`; a profile change shifts every pixel. | Detected (unit test: a ±6 level shift fails). |
| Hero | Rendered at DSF 2; 1:1 only when the source capture is also 2x. | Geometry recorded only in that case. |
| Trio, social card | Devices are scaled with CSS transforms (fractional factors), and only one screen is reported. | Not checked in Phase 0. |
| Video | See below. | Not checked in Phase 0. |

### Why video is not checked yet

The framed video is several lossy, rescaling steps away from the raw recording:

1. Screencast frames are JPEG (q92) at device scale.
2. The master is H.264 (CRF 10/12), downscaled to ≤ 1920 px wide (e.g. DSF 1.333 for desktop), with
   optional zoompan (time-varying crop and scale) and a loop crossfade.
3. The framed composite places the master at a **fractional** offset (e.g. y = 154.67 px at
   DSF 1.333, rounded by `px()`), scales it to the screen rectangle, crops phones to the viewport
   aspect, and re-encodes at CRF 12.
4. Deliverables are downscaled again (2112 → 1920 px, ×0.909) and re-encoded (CRF 22), and GIFs are
   palette-quantised and dithered.

Measured on the committed `new-campaign.mp4` vs `new-campaign-framed.mp4`: at the best integer
alignment the mean channel difference is 20-26 levels, which is mostly geometric error (the
transform chain is not recorded), not tampering. A valid check would need: the composite transform
recorded per framed video, comparison of framed master vs raw master (before the final downscale) at
identical frame indices, and tolerances calibrated on known-good encoding noise vs known tampering.
This is deferred rather than shipped with thresholds that cannot tell the two apart.

## Findings (not fixed in Phase 0 unless noted)

* **Fixed (bug, no output change):** `loadConfig()` threw on a second call in the same process
  (Ajv recompiled a schema with a fixed `$id`). The CLI never hit it; library use and tests did.
* **Pre-existing styling bug:** in a single `wide` (laptop) frame the laptop base (`margin: 0 -7%`)
  is wider than the canvas padding and is clipped at both canvas edges. The baseline records current
  behaviour; fixing it is a styling change for a later phase. The dogfood kit does not use `wide`.
* **Dogfood blind spot:** the demo app's own accent (`#7c5cff` / `#22d3ee`) matches the default
  `aurora` palette, so the committed README media cannot reveal brand mismatches.
* **Leak into captures:** `frame.accent` colours the cursor click ripple inside recordings
  (`record.mjs`, `cursor.mjs`). Unchanged in Phase 0; relevant to later phases.

## Colour utilities

`scripts/lib/color.mjs`: hex parsing, sRGB transfer function, WCAG luminance and contrast, OKLab /
OKLCH and ΔEok. Tested against published reference values (`tests/color.test.mjs`). ΔEok
(Euclidean OKLab distance) is used instead of CIEDE2000 for simplicity; it is sufficient for
thresholding.
