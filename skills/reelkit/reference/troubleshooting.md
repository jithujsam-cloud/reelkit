# Troubleshooting

Every error ends with a `fix:` line. Exit codes: `1` usage/config, `2` assets FAILED, `3` auth expired.

| symptom | cause | fix |
|---|---|---|
| `Chromium for Playwright is not installed` | first run offline, or a pinned browser build missing | `npx playwright install chromium` (Linux CI: `--with-deps`) or `REELKIT_CHROMIUM=/path/to/chrome` |
| `ffmpeg not found` | needed for GIF/MP4 only | macOS `brew install ffmpeg` · Debian/Ubuntu `sudo apt install ffmpeg` · Windows `winget install Gyan.FFmpeg` |
| gifski missing | optional | bundled via npm on macOS/Linux/Windows; otherwise ffmpeg's palette encoder is used |
| `animations: infinite animation … on div.x` | decorative loop (orb, marquee, pulsing dot) | `hide: [".x"]` or `stability.allowInfinite: [".x"]` |
| `busy: loading indicator still visible` | data never loads for this account, or a static element with a skeleton/spinner class | check the account has data; if the element is decorative, `hide` it |
| `network: still loading … e.g. https://…/poll` | polling/analytics | `stability.ignoreRequests: ["/poll", "segment.io"]` |
| `pixels: page kept changing` | carousel, ticker, video, live counters | `hide` it or pause it with an action; raise `diffThreshold` a little |
| `waitFor … never became visible` | wrong selector/text, or a login wall | check the page in a browser; exit 3 means the session expired |
| exit code 3 | session expired | `reelkit auth` (form/token modes refresh by themselves) |
| `Manual login needs a visible browser window` | CI/SSH | use `auth.mode: form` or `token` |
| GIF over budget | long or busy flow | fewer steps, `gif.width: 800`, `gif.fps: 12`, or embed the MP4 |
| choppy recording | heavy page, slow machine | close other apps; keep `keepBackdropBlur: false`; shorter viewport |
| text looks blurry in a frame | captured at deviceScaleFactor 1 | keep the default `deviceScaleFactor: 2` |

Useful files: `.reelkit/results.json` (per-asset capture details), `.reelkit/qa-report.json`,
`.reelkit/contact-sheet.png`, `.reelkit/video/*.timeline.json`.
