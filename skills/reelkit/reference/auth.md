# Auth

Scenes with `auth: true` load the saved session in `.reelkit/auth.json` (Playwright storageState, written
0600, git-ignored). Before every capture run reelkit opens `auth.checkUrl` (or the first auth scene) and
confirms it is still signed in. A session counts as **expired** when the page answers 401/403,
redirects to `auth.loginUrl`, shows `auth.loggedOutSelector` (default: a password field), or lacks
`auth.loggedInSelector`. Then reelkit exits with code 3 and asks for `reelkit auth`, instead of
capturing a login screen. The same checks run again right before each frame is taken.

**Claude never types a real password.** Secrets only come from the user's own login or from env vars.

## Mode A: manual (default)

```yaml
auth: { mode: manual, loginUrl: /login, checkUrl: /dashboard }
```
The user runs `reelkit auth` in their own terminal. A real browser window opens at the login page;
they sign in however they normally do (password, Google/GitHub OAuth, magic link from their inbox,
2FA, SSO). reelkit saves the session once the page has left the login URL for 1.5 s. Needs a display:
in CI or SSH, use mode B or C.

## Mode B: form + env vars

```yaml
auth:
  mode: form
  loginUrl: /login
  form: { email: "#email", password: "#password", submit: "button[type=submit]" }
  # emailEnv / passwordEnv default to REELKIT_EMAIL / REELKIT_PASSWORD
```
`.env` (git-ignored): `REELKIT_EMAIL=demo@example.com` and `REELKIT_PASSWORD=…`. Use a dedicated demo
account with realistic data. In CI, store them as repository secrets. form mode re-authenticates by
itself when the saved session expires.

## Mode C: token / preview login / protection bypass

```yaml
auth:
  mode: token
  token:
    url: /api/test-login?token=${PREVIEW_LOGIN_TOKEN}&next=/dashboard   # a preview-only route you control
    headers: { x-preview-auth: "${PREVIEW_HEADER}" }                    # optional
    cookies: [{ name: session, value: "${SESSION_COOKIE}" }]            # optional, set directly
```
Guard such routes so they only exist on preview deployments.

### Vercel deployment protection
Create a Protection Bypass for Automation secret in the Vercel project, then:
```yaml
headers:
  x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}
  x-vercel-set-bypass-cookie: "true"
```
`headers` apply to every request in every mode (Netlify/Cloudflare Access service tokens work the same way).

## Commands
- `reelkit auth` signs in with the configured mode (`--mode form` to override).
- `reelkit auth --check` only verifies the saved session (exit 3 if invalid).
- Delete `.reelkit/auth.json` to sign out.
