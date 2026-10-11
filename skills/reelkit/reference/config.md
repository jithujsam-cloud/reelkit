# reelkit.config.yaml reference

Validated against `schema/reelkit.schema.json` (add `# yaml-language-server: $schema=…` for editor
autocomplete). Check with `reelkit verify --config-only`. Any string may use `${ENV_VAR}` or
`${ENV_VAR:-default}`; expanded values are redacted from all output.

## Top level

| key | default | meaning |
|---|---|---|
| `name` | | Product name (hero title, social card) |
| `tagline` | | One-liner for hero/social |
| `baseUrl` | required | Deployed URL. Scenes use paths relative to it |
| `output` | `docs/media` | Asset folder (also gets `manifest.json`) |
| `concurrency` | `3` | Parallel still captures (recordings are always sequential) |
| `headers` | `{}` | Extra headers on every request, e.g. `x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}` |
| `defaults` | | `viewports`, `theme`, `deviceScaleFactor` (2), `outputs`, `hide`, `mask`, `waitFor` applied to every scene |
| `determinism` | | `time` (frozen clock, ISO or `false`), `locale` (`en-US`), `timezone` (`UTC`), `hideBuiltins` (true), `seed` |
| `stability` | | See [stability.md](stability.md) |
| `auth` | | See [auth.md](auth.md) |
| `motion`, `gif` | | See [motion.md](motion.md) |
| `frame`, `marketing` | | See [framing.md](framing.md) |
| `readme` | | `file` (README.md), `gallery` (scene names to show) |

## Viewports

Presets: `mobile` 390×844 (touch, phone frame) · `tablet` 820×1180 (tablet frame) · `desktop` 1440×900
(browser frame) · `wide` 1920×1080 (laptop frame). All at deviceScaleFactor 2 by default. Custom:
`{ name: "square", width: 1080, height: 1080, deviceScaleFactor: 2, mobile: false, device: plain }`.

## Scenes

```yaml
scenes:
  - name: dashboard            # slug → file names: dashboard-desktop-light.png
    title: Analytics dashboard # alt text / captions
    url: /dashboard            # or an absolute URL
    auth: true                 # needs the saved session
    viewports: [desktop, tablet, mobile]
    theme: both                # light | dark | both (prefers-color-scheme)
    waitFor: { text: "Recent activity" }   # or a selector string, or { selector, timeout }
    hide: [".beta-badge"]      # display:none (on top of the built-in noise list)
    mask: [".user-email"]      # blurred (PII)
    scrollTo: "#pricing"       # selector or y offset for the still
    actions: []                # run before the still, or as the recorded flow
    outputs: [still, framed]   # still | fullpage | gif | mp4 | framed
    zoom: 1.4                  # motion only: zoom toward clicks
    stability: { timeout: 30000 }   # per-scene override
```

A scene with `gif` or `mp4` in `outputs` is a **flow** (recorded). `framed` frames whatever the scene produces.

## Actions (one key per step)

```yaml
actions:
  - click: "text=New campaign"                 # Playwright selector: CSS, text=…, role=button[name="Save"]
  - click: { selector: "#save", zoom: false }  # per-click zoom override
  - type: { into: "#name", text: "Q4 Outbound" }   # human-like typing in recordings; clear: false to append
  - type: { into: "#search", text: "${DEMO_QUERY}" }
  - press: Enter                               # or { key: "Meta+K", into: "#editor" }
  - hover: ".chart-bar:nth-child(3)"
  - select: { from: "#channel", value: "LinkedIn" }   # value or visible label
  - scroll: 600                                # px, or "#section", or top | bottom, or { by: 400 }
  - drag: { from: ".card:first-child", to: ".column-done" }
  - wait: 800                                  # ms, or { for: "#toast" } / { text: "Saved" } / { hidden: ".spinner" }
  - waitFor: { text: "Saved" }
  - goto: /settings
```

Never put real passwords in `type` steps. Use the auth modes instead.

## Output names

`{scene}-{viewport}-{theme}.png`, `…-full.png` (fullpage), `…-framed.png`; flows: `{scene}.mp4|webm|gif`
and `{scene}-framed.mp4|webm|gif` (with `-{viewport}-{theme}` when a flow has several);
marketing: `{trio}-trio-{theme}.png`, `hero-{theme}.png`, `social-preview.png`; plus `manifest.json`.
