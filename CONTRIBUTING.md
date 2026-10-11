# Contributing to reelkit

Thanks for helping. reelkit's promise is "never ship a bad frame", so every change must keep that true
on the demo app.

## Setup

```bash
git clone https://github.com/jithujsam-cloud/reelkit && cd reelkit
npm --prefix skills/reelkit ci          # CLI dependencies
npx --prefix skills/reelkit playwright install chromium
npm run demo:install && npm run demo:build
npm run demo:start &                    # http://localhost:3000 (demo@reelkit.dev / reelkit-demo)
cp .env.example .env
```

## Before you open a PR

```bash
npm test                                # stability fixtures + README marker tests
npm run media                           # reelkit all on the demo app; must end with 0 FAILED
```
Then open `.reelkit/contact-sheet.png` and the changed images yourself. If your change alters what
assets look like, commit the regenerated `docs/media/` and say so in the PR.

To prove the stability engine still refuses broken pages, the demo has switches:
`/dashboard?chaos=1` (slow skeleton + 2.5 s animation, must be waited for) and
`/dashboard?chaos=forever` (never resolves, must be FAILED). CI checks both.

## Layout

| path | what |
|---|---|
| `skills/reelkit/SKILL.md` | the workflow Claude follows (keep it under ~400 lines; detail goes in `reference/`) |
| `skills/reelkit/scripts/lib/` | one concern per module: `stability`, `shoot`, `record`, `frame`, `verify`, `auth`, … |
| `skills/reelkit/templates/` | device frames and backgrounds (HTML/CSS; no trademarked artwork) |
| `skills/reelkit/schema/` | JSON Schema for the config; update it with any new option |
| `examples/demo-app/` | the test bed |

## Principles

- Plain ESM JavaScript, no build step, Node ≥ 18.17, Windows/macOS/Linux (no bash-only scripts).
- Every error a user can hit says what happened **and** the one-line fix (`ReelkitError(message, fix)`).
- No telemetry and no network calls except to the target site and package registries.
- Never log secrets: values expanded from env vars are redacted automatically. Keep it that way.
- Rename-ability: the project name comes from `scripts/lib/brand.mjs`.

## Releasing

Bump `version` in `.claude-plugin/plugin.json` and `skills/reelkit/package.json`, add a CHANGELOG entry,
tag `vX.Y.Z`.
