# Stability engine

A still is taken only after **all** gates pass in one attempt. Up to `stability.retries` (3) attempts,
each with a longer budget (`timeout` × 1, 1.5, 2) and a growing pause; the last attempt reloads the page
and replays the scene's actions. If every attempt fails, the asset is **FAILED** with the gate and the
reason, and no file is written.

| gate | passes when | typical fix when it fails |
|---|---|---|
| `network` | no in-flight requests (except websockets/SSE, requests older than 10 s, `ignoreRequests`) for `networkQuietMs` (500) | add analytics or polling URLs to `stability.ignoreRequests` |
| `fonts` | `document.fonts.ready`, no font still loading | self-host fonts or check the font CDN is reachable |
| `lazy` | page scrolled to the bottom in viewport steps (triggers lazy images), then back | `scrollLazy: false` for infinite feeds |
| `images` | every visible `<img>` complete with `naturalWidth > 0` | broken URLs are reported, so fix or `hide` them |
| `busy` | no visible skeleton/spinner: `aria-busy=true`, `role=progressbar`, classes with skeleton/shimmer/spinner, animated `*loading*`/`*loader*` elements, plus `busySelectors` | make sure data loads for this account; add custom loaders to `busySelectors` |
| `animations` | `document.getAnimations()` has nothing running; finite ones are awaited, infinite ones fail after 2.5 s | `hide` decorative loops or list them in `allowInfinite` |
| `pixels` | two consecutive screenshots `diffInterval` (400 ms) apart differ by ≤ `diffThreshold` (0.05 % of pixels), `consecutiveMatches` (2) times in a row | something JS-driven keeps changing (tickers, carousels, video): `hide` it, pause it, or raise the threshold slightly |

Determinism applied to every capture: clock frozen to `determinism.time` (time still flows from that
instant, so timers run), fixed locale and timezone, `prefers-reduced-motion: reduce` for stills,
caret and scrollbars hidden, service workers blocked, and the built-in hide list (cookie/consent
banners, chat launchers, toasts, Next/Vite/Astro/Vercel dev overlays) plus your `hide`/`mask`.

Tuning per scene: `stability: { timeout: 30000, allowInfinite: [".hero-orb"] }`.
