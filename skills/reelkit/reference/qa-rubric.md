# Visual QA rubric

Open every image `reelkit verify` lists (stills, framed images, and sampled video frames) with the Read
tool. An asset passes only if **every** item holds. When in doubt, fail it and fix it.

1. **Fully loaded.** Real data everywhere. No skeleton bars, shimmer, spinners, "Loading…", empty chart
   axes or placeholder avatars.
2. **Settled.** Nothing half-faded, mid-slide, mid-expand or mid-count-up. Charts fully drawn.
3. **No noise.** No cookie/consent banner, chat bubble, toast/snackbar, dev overlay, "new version"
   prompt, or modal that the scene did not intend.
4. **No broken media.** No broken-image icons, missing icons, or alt text showing instead of images.
5. **Fits the viewport.** No horizontal overflow, clipped or overlapping text, cut-off buttons, or a
   desktop layout squeezed into mobile.
6. **No PII or filler.** No real emails, names, phone numbers, API keys or tokens (unless they are
   obviously demo data); no "lorem ipsum", "test test", "asdf".
7. **Meaningful.** Shows the product doing something (not an empty state, 404, error toast or login
   page) unless that is the point of the scene.
8. **Crisp.** Text sharp, not blurry, smeared or upscaled; no compression blocks or GIF ghosting.

For videos also check across the sampled frames: the cursor lands on what it clicks, the click
visibly does something, typing is legible, the end state shows the result, and the loop point is not
jarring.

## Recording verdicts

```
reelkit verify --mark "<file or glob>=pass"
reelkit verify --mark "<file>=fail" --note "skeleton still visible in the Revenue card"
```
A fail needs a note that says exactly what is wrong and where. Fix → re-capture with
`--only <scene>` → `reelkit verify` → review again. Verdicts are tied to the file's SHA-256, so any
re-captured file returns to "needs review" unless its bytes are identical.
