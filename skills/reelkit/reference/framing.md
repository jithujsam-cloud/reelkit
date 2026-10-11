# Framing and marketing images

Frames are HTML/CSS (`templates/frame.html`) rendered by Chromium, so they look the same everywhere
and stay free of trademarked device artwork.

| viewport | default frame |
|---|---|
| mobile | phone: rounded slab, side buttons, camera pill, status bar safe area (colour sampled from the page) |
| tablet | tablet: even bezel, camera dot |
| desktop | browser window: traffic-light dots, URL bar (`frame.url`), light/dark chrome following the theme |
| wide | laptop: lid + base |
| custom | set `device: phone | tablet | laptop | browser | none` on the viewport |

```yaml
frame:
  background: aurora       # aurora | sunset | ocean | mesh | midnight | slate | paper | transparent | "#hex" | any CSS background
  backgroundDark: midnight # used for dark-theme assets
  accent: "#7c5cff"        # cursor ripple, social card accent
  padding: 72              # CSS px around the device
  radius: 12               # browser/plain corner radius
  shadow: true
  url: app.example.com     # browser URL bar text ('none' to hide; default: real host + path)
marketing:
  hero: new-campaign       # motion scene → framed GIF hero; still scene → hero-{light,dark}.png with name + tagline
  trio: dashboard          # needs desktop (or wide), tablet and mobile shots of this scene
  social: { scene: dashboard, title: "Pulse", subtitle: "Outbound analytics that books meetings" }
```

Outputs: `{shot}-framed.png` (same pixel density as the capture), `{trio}-trio-{light,dark}.png`,
`social-preview.png` (exactly 1280×640: upload it in GitHub → Settings → Social preview),
`hero-{light,dark}.png`, and `{flow}-framed.{mp4,webm,gif}`.

Light/dark pairs drop straight into GitHub's `<picture>`:
```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/dashboard-desktop-dark-framed.png">
  <img src="docs/media/dashboard-desktop-light-framed.png" alt="Dashboard">
</picture>
```
`reelkit readme` writes these blocks for you.
