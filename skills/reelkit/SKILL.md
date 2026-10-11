---
name: reelkit
description: Turn a deployed web app into a README-ready media kit: verified screenshots at phone/tablet/desktop sizes, device-framed mockups, a responsive trio, a GitHub social preview, and smooth demo GIF/MP4 recordings with a synthetic cursor, including pages behind login. Use when the user wants screenshots for a README, a demo GIF or product video, product mockups, a social preview/OG image, "showcase my app", "record a walkthrough", "update the README images", or marketing images of their web app. Every frame is checked for stability (no half-loaded pages, skeletons, spinners, cookie banners or mid-animation frames) and then visually reviewed before it ships.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/reelkit.mjs *) Read
license: MIT
---

# reelkit

You produce a media kit for the user's web app and you are its last line of quality control.
The CLI does capture, stability checks, encoding and framing; **you** decide what to shoot,
look at every result, and refuse to ship anything that fails the rubric.

Run the CLI as `node "${CLAUDE_SKILL_DIR}/scripts/reelkit.mjs" <command>` from the user's project
root (written `reelkit <command>` below). The first run installs its own dependencies into the skill folder.
Every error ends with a `fix:` line: follow it before improvising.

## Hard rules

- **Never type real passwords or secrets yourself**, never put them in the config, never echo them.
  Credentials come only from the user's own manual login (`reelkit auth`) or from env vars in `.env`
  (`REELKIT_EMAIL`, `REELKIT_PASSWORD`, tokens). If a login is needed, ask the user to run auth.
- Never read, print or commit `.reelkit/auth.json` or `.env`. `reelkit init`/`auth` add both to `.gitignore`.
- Never ship an asset whose QA status is not PASS. Never skip the visual review (step 6).
- Show the drafted config to the user and get approval before the first shoot.
- If a command exits with code 3 (session expired), do not work around it: ask the user to run `reelkit auth`.

## Workflow

### 1. Preflight

```
reelkit preflight
```
Checks Node ≥ 18.17, installs Playwright Chromium if missing, finds ffmpeg and gifski (bundled
gifski is used if none is installed; ffmpeg's palette encoder is the fallback). If something is missing, tell
the user the one-line install command it prints. ffmpeg is only required for GIF/MP4.

### 2. Discover and draft the config

1. `reelkit discover` lists routes (Next app/pages router, SvelteKit, Remix, Astro, React Router, plain HTML),
   flags dynamic routes (need an example URL) and routes that probably need login.
2. Ask the user for the **deployed URL** (or a local one such as `http://localhost:3000`) if you don't have it.
3. `reelkit init --url <url> --name "<Product>"` writes `reelkit.config.yaml`. Then edit it:
   - pick 3–6 scenes that sell the product (landing, the main dashboard, one or two key screens);
   - add a `waitFor` that only appears when real data is on screen (e.g. `{ text: "Recent activity" }`);
   - add `mask` for anything personal (emails, names, API keys) and `hide` for anything distracting;
   - add one **flow** scene (`outputs: [mp4, gif, framed]`) with `actions` that show the core job-to-be-done
     in 3–6 steps. Keep flows under ~15 s.
   - set `marketing.hero` (a flow scene gives a GIF hero), `marketing.trio` (a scene shot at
     desktop+tablet+mobile) and `marketing.social`.
   Read [reference/config.md](reference/config.md) for every field and the action syntax.
4. `reelkit verify --config-only` to validate, then **show the config to the user and wait for approval**.

### 3. Auth (only if any scene has `auth: true`)

Pick the mode with the user ([reference/auth.md](reference/auth.md)):
- **manual** (default, works with OAuth, magic links, 2FA): the user runs `reelkit auth` in their own terminal
  and signs in in the window that opens. You cannot do this step for them.
- **form**: user puts `REELKIT_EMAIL` / `REELKIT_PASSWORD` in `.env`; `reelkit auth` fills the login form.
- **token**: a preview-only login URL or deployment-protection bypass header, from env vars.

`reelkit auth --check` verifies the saved session. Capture commands re-check it and stop with exit code 3
instead of photographing a login page.

### 4. Capture

```
reelkit shoot            # stills: every frame passes the stability engine first
reelkit record           # flows: MP4 + WebM + GIF with cursor, typing, optional zoom
reelkit frame            # device frames, trio, social preview, hero (light + dark)
```
Use `--only <scene>` to iterate on one scene. A shot that never stabilises is marked **FAILED** with the
gate that failed (network, fonts, images, busy, animations, pixels) and no file is written; see
[reference/stability.md](reference/stability.md) for what each gate means and how to fix it.

### 5. Automated QA

```
reelkit verify
```
Runs automated checks (capture status, blank-image detection, codec/decode checks, GIF budget), extracts
sample frames from every video (first, middle, last, and before/after each click), writes
`.reelkit/qa-report.json`, `docs/media/manifest.json` and `.reelkit/contact-sheet.png`, and prints the list
of files that need your review.

### 6. Visual QA (mandatory, never skipped)

Open **every** listed image with the Read tool: every still, every framed image, and every sampled video
frame. Score each against [reference/qa-rubric.md](reference/qa-rubric.md):

1. fully loaded, real data; no skeletons, spinners or placeholder blocks
2. no half-faded or mid-transition elements
3. no cookie banner, chat bubble, toast or unintended modal
4. no broken images or missing icons
5. no overflow, clipped text or horizontal scroll at that viewport
6. no visible PII and no lorem ipsum
7. meaningful content (not an empty state, unless intended)
8. crisp text

Record each verdict (globs allowed):
```
reelkit verify --mark dashboard-desktop-light.png=pass
reelkit verify --mark "new-campaign*.gif=fail" --note "toast covers the Create button at 6.1s"
```
For any fail: fix the cause (longer `waitFor`, add a `hide`/`mask` selector, `scrollTo`, a `wait` step,
`stability.busySelectors`, or `motion.zoom: false`), re-capture with `--only <scene>`, run `reelkit verify`
again, and re-review. Verdicts are pinned to each file's hash, so a re-captured file needs a fresh look.
Finish with `reelkit verify --strict`, which fails unless every asset has a visual PASS.

### 7. Deliver

1. `reelkit readme` prints a Markdown/HTML block (hero, `<picture>` light/dark variants, gallery).
   With the user's OK, `reelkit readme --write` inserts it between `<!-- reelkit:start -->` and
   `<!-- reelkit:end -->` in README.md (it never touches anything outside the markers; it adds the markers
   at the end if they don't exist).
2. Final report to the user:
   - the contact sheet: Read `.reelkit/contact-sheet.png` and tell the user its path;
   - a QA table: every asset with size, dimensions, automated checks, your visual verdict, and any retries
     (from `.reelkit/qa-report.json`);
   - anything you could not fix, and why.
3. Suggest `docs/media/social-preview.png` for GitHub → Settings → Social preview.

`reelkit all` runs preflight → session check → shoot → record → frame → verify (→ readme if markers exist).
Use it for re-runs and CI; it does not replace your visual review.

## When things go wrong

See [reference/troubleshooting.md](reference/troubleshooting.md). Common cases: a scene keeps failing the
`animations` gate (an infinite decorative animation: `hide` it or add it to `stability.allowInfinite`),
`busy` (a skeleton that never resolves: check the data really loads for this account), GIF over budget
(shorten the flow, lower `gif.width`/`gif.fps`, or embed the MP4), and `waitFor never became visible`.
Motion details (cursor, zoom, dead-time trim, loops) live in [reference/motion.md](reference/motion.md);
frames, backgrounds and marketing images in [reference/framing.md](reference/framing.md).
