// Demo-only auth. Credentials are public on purpose: this app exists to be screenshotted.
export const DEMO_EMAIL = 'demo@reelkit.dev';
export const DEMO_PASSWORD = 'reelkit-demo';
export const SESSION_COOKIE = 'pulse_session';
export const SESSION_VALUE = 'demo-session-v1';

export function isValidSession(value) {
  return value === SESSION_VALUE;
}

export function sessionCookie(value = SESSION_VALUE) {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  };
}
