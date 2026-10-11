# Design intelligence, Phase 1: design profile

Phase 1 adds **observation only**: `reelkit design` produces `design-profile.json` / `.md`. It does not
propose visual directions (Phase 2), and it changes no renderer styling, config default, CLI behaviour
of existing commands, or committed media. Format and rules: `skills/reelkit/reference/design-profile.md`.

## Base

Built on the Phase 0 branch (`ccr-8a0a7a3f-07ztcy`, merged into this branch) because it reuses
`scripts/lib/color.mjs`. Phase 0 had not been merged into `main` when this work started.

## Layout

```
scripts/lib/design/
  inspect.mjs     browser pass: computed styles, CSS vars, fonts (incl. CDP-painted font), logo/icons, 3 viewports + dark probe
  analyze.mjs     pure: observations → facts (clustering, roles, spacing unit, radius, surface style, responsive notes)
  claims.mjs      pure-ish: repo docs / tailwind / token files / css → colour & font claims with file:line
  css-color.mjs   hex/rgb/hsl/oklch/bare-HSL parsing for claims
  profile.mjs     facts + claims → profile; confidence, conflicts, missing, guards; validateProfile()
  render-md.mjs   profile → design-profile.md
  index.mjs       orchestration (runDesign) and profileFromObservations()
schema/design-profile.schema.json
```

## Findings made while building it

* **Unstyled pages look like brands.** Inspecting github.com from a sandbox whose proxy blocked its CSS
  CDN yielded "primary #0000ee, high confidence" (the browser's default link blue). Fixed in this phase:
  failed stylesheets/fonts are recorded, cap confidence at 40% with a warning, and the default link
  blues are flagged. Test: `tests/fixtures/design/brokencss`.
* **Role names collide.** `--brand-accent` matched "brand" before "accent" and was reported as a
  conflicting primary. Accent now wins when both words appear (unit-tested).
* **Rendered font ≠ intended font.** Chromium paints a fallback when the site's system font is not
  installed (Georgia → Liberation Serif here). The profile records the requested family, keeps the
  painted one in `value.rendered`, and only raises a conflict when a *web* font was requested but not
  painted.
* Carried over from Phase 0 and still open: laptop base clipping in `wide` frames, demo app palette
  equals Reelkit's default (the new `purple` fixture and guard make that visible), `frame.accent` colours
  the recording click ripple, video authenticity.

## Known limitations

See the "What it does not see" section of the reference and the `limitations` array in every profile.
