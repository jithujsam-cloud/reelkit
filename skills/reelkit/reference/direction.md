# Design directions (`reelkit direction`)

Turns the real design profile (`reelkit design`) into three genuinely different marketing-media
directions, lets you compare them on the **same real screenshot**, and records the one you approve.
**Phase 2 stops there:** `shoot`, `record`, `frame` and `verify` do not read the approved direction yet
(that is Phase 3), so approving changes no existing output.

```
reelkit design --url https://your.site     # 1. inspect (→ .reelkit/design/design-profile.json)
reelkit shoot                              #    real captures are required for previews
reelkit direction profile                  # 2. what the directions will be based on
reelkit direction propose                  # 3. three candidates (→ .reelkit/design/directions/candidates.json)
reelkit direction preview                  # 4. render them from one capture (→ previews/ + compare.html)
reelkit direction show [id]                #    read one in full (--json for every adjustable path)
reelkit direction select <id>              # 5. pick one (not an approval)
reelkit direction adjust --set composition.single.deviceScale=0.7 [<id>]
reelkit direction preview                  #    previews must show exactly what you approve
reelkit direction approve                  # 6. interactive y/N, or --yes when scripted
reelkit direction status
```

## What is in a direction

Each direction defines: palette for light and dark captures (canvas, second field, text, muted, accent,
surface, border) and background kind (`solid`, `split` = two flat fields, `tint`); typography (generic
class `sans|serif|mono`, weight, tracking); composition **family per output**: single
(`stage|split|poster|bleed`), social (`copy-left|stage-top|field-split`), trio (`cascade|row|stack`) plus
device scale and bleed; depth (`none|soft|layered|hard` shadow, optional ring, corner radius); motion
(cursor, click ripple, zoom, pacing); accent use; and a plain-language `rationale`.

The proposer picks **three of four archetypes** from the profile (brand-led, minimal, editorial,
dark-stage); a dark interface gets a dark stage, a product with no brand evidence does not get a
brand-led direction. No AI model, network or randomness is involved: the same profile always produces
byte-identical candidates.

**Distinct by construction and by check.** Every pair must differ on at least 6 of 11 independent axes
(layout families, background kind, canvas tone, type weight/voice, device scale, depth, accent use,
cursor) **and** on at least 2 of the 3 composition families. A set that differs only in accent colour is
rejected. No gradients are generated: depth comes from flat fields and shadows. Nothing assumes purple,
glass or neon; Reelkit's own palette appears only if the inspected site's brand really is that colour.

## Where values come from (`basis`)

Every direction carries `basis`:

| field | meaning |
|---|---|
| `used` | profile values it was built from, with the profile's confidence |
| `choices` | stylistic decisions that are **not** observed brand facts (e.g. "warm paper stock", "serif display type", "brand colour darkened to keep text readable") |
| `fallbacks` | profile values that were missing or too uncertain, why, and what was used instead |
| `warnings` | profile-level problems (failed stylesheets, unverified dark theme, low overall confidence) |

A value is used only at profile confidence ≥ 0.5, and the brand colour only when it was **observed in
use** (a colour that was only declared in CSS is not treated as the brand). Brand fonts are recorded but
only their generic class is rendered (`embed: false`); embedding site fonts is not implemented. Text
contrast (≥ 4.5:1) and accent contrast (≥ 3:1) are enforced on every palette.

## Previews

`preview` renders every direction as **single** (1600×1000), **social** (1280×640) and **trio**
(1800×1060) from **one** passing capture (`--scene`, `--theme` to choose; default: the social scene,
then the hero scene, then the first scene with a passing desktop still). Same capture, same sizes, so
only the design differs. The trio needs passing tablet and mobile captures of that scene; otherwise it is
skipped and the reason is written to the manifest and the compare sheet; nothing is invented. With no
passing capture at all, `preview` fails and tells you to run `reelkit shoot` (and `reelkit auth` for
scenes behind login).

The screenshot is placed only by `<img>`: scaled uniformly, never recoloured, filtered or redrawn
(`productPixels: "unmodified"` in the manifest; a test shows the framed screen equals the capture at 1:1
using the existing authenticity check). Previews are scaled compositions and are **not** themselves
authenticity-checked outputs; that applies to real generated assets.

Open `.reelkit/design/directions/compare.html` (a static page, no scripts) to compare side by side.

## Approval and revision

`propose → selected → approved`. Approval is refused unless: a direction is selected; previews of
exactly the selected (and adjusted) direction exist and match the current profile; the profile has not
changed since the proposal; and you confirm (interactive prompt or `--yes`; closed stdin never approves).
A low-confidence profile additionally needs `--accept-low-confidence`.

`adjust --set path=value` edits one existing field. It is validated against the schema and for text
contrast; `id`, `archetype` and `basis` cannot be edited. The candidate itself is never rewritten:
adjustments are recorded separately (state `adjustments`), the revision increments, previews become stale,
and an earlier approval no longer applies (the previously approved file stays untouched until you approve
again). Re-running `propose` regenerates the candidates without touching `reelkit.direction.json`; the
approved direction can be re-selected as `approved` to adjust or preview it.

## Files

| file | where | contents |
|---|---|---|
| `candidates.json` | `.reelkit/design/directions/` | the three directions, profile hash, distinctness; **canonical, no timestamps** |
| `state.json` | same | status, selection, adjustments, revision, history (**has timestamps**) |
| `previews.json`, `previews/*.png`, `compare.html` | same | source capture (+ SHA-256), one entry per preview with the direction hash it shows |
| `reelkit.direction.json` | **project root** (commit it) | the approved direction + provenance; canonical, no timestamps |

All formats are versioned (`schemaVersion: 1`, `kind`) and described by `schema/direction.schema.json`.
Generated working files stay in git-ignored `.reelkit/`; nothing is written to `docs/media`.

## Troubleshooting

* *"No design profile"*: run `reelkit design --url <site>` first.
* *"No scene has a passing still capture"*: run `reelkit shoot`; for login scenes `reelkit auth`.
* *Directions look generic / list many fallbacks*: the profile is thin or low-confidence. Read
  `design-profile.md` (conflicts, "Not found", failed stylesheets) and fix reachability before approving.
* *"profile changed since proposed"*: re-run `reelkit direction propose`, then preview and select again.

## Limitations (Phase 2)

Approving does not yet change `frame`, `record` or `verify` output (Phase 3). Motion fields are recorded,
not yet applied or previewed. Fonts are generic classes only. Logos are not placed (brand assets are
only to be used once verified). Previews need real captures and are scaled, not 1:1.
