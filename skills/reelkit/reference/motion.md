# Motion: GIF / MP4 / WebM

Flows are recorded with a CDP screencast at the viewport's device scale (2× by default). Frames arrive only
when pixels change; each frame's on-screen time is the gap to the next one, capped at `motion.maxHold`
(0.7 s). That cap **is** the dead-time trim: waiting for a network response or a slow API becomes at most
0.7 s of video. The first frame is held `startHold` (0.8 s) and the final state `endHold` (1.6 s).

```yaml
motion:
  fps: 30              # master frame rate
  cursor: true         # synthetic cursor: eased, slightly curved glide, press state, click ripple
  cursorSpeed: 1       # >1 faster
  zoom: false          # true = 1.5×, or a factor; per scene `zoom:` or per click `{ selector, zoom }`
  maxHold: 0.7
  startHold: 0.8
  endHold: 1.6
  loop: true           # crossfade the final state into the first frame (seamless GIF loop)
  typingDelay: [45, 120]   # ms per key (seeded jitter); typing is re-timed to this in post
  keepBackdropBlur: false  # see below
gif:
  width: 960           # 800–1000 reads well in READMEs
  fps: 15
  quality: 90
  maxBytes: 5000000    # budget
  encoder: auto        # auto | gifski | ffmpeg
```

* Before recording starts, the page must pass the full stability engine, so the first frame is clean.
  After the last action it settles again before the end hold.
* **Zoom** eases in toward each click (~0.55 s), holds, and eases out before the next action. It runs in
  post with ffmpeg on the full-resolution frames, so zoomed text stays sharp.
* **GIF budget**: tries `width × fps × quality` and steps down (85 %, 72 % of the width, 640, 560, 480 px; 12,
  10, 8 fps) until the file fits `maxBytes`. If it never fits, the GIF is marked FAILED with a warning:
  shorten the flow or embed the MP4.
* **Encoder**: gifski (bundled via npm, or a system install) gives the best quality. With `auto`, zoomed
  clips use ffmpeg's palette encoder instead, because gifski's frame-to-frame pixel reuse leaves faint
  ghost trails when every pixel moves.
* **Backdrop blur**: headless Chromium renders `backdrop-filter` in software; at 2× it drops the frame rate
  to about 3 fps while a blurred modal is open. reelkit disables it during recordings (stills keep it). The
  dimmed overlay still shows.
* Outputs: `{scene}.mp4` (H.264, yuv420p, faststart, ≤1920 px wide), `{scene}.webm` (VP9), `{scene}.gif`,
  and framed versions when `framed` is in `outputs`.
* Debugging: `.reelkit/video/{scene}.timeline.json` has raw frame times and events;
  `.reelkit/frames/{scene}/` has the captured frames.

GitHub READMEs autoplay GIFs but not MP4 links. For long demos, put the GIF in the README and link it to the MP4.
