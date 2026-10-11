import { NextResponse } from 'next/server';
import { DEMO_EMAIL, DEMO_PASSWORD, sessionCookie } from '../../../lib/auth';

export async function POST(request) {
  const { email, password } = await request.json().catch(() => ({}));
  // Simulate a little server latency so the login spinner is visible.
  await new Promise((r) => setTimeout(r, 350));
  if (email !== DEMO_EMAIL || password !== DEMO_PASSWORD) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie());
  return res;
}
