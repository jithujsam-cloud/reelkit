import { NextResponse } from 'next/server';
import { sessionCookie } from '../../../lib/auth';

// "Mode C" auth for screenshot tools: a preview-only login route guarded by a token.
// Disabled unless DEMO_TEST_LOGIN_TOKEN is set on the server.
export async function GET(request) {
  const expected = process.env.DEMO_TEST_LOGIN_TOKEN;
  const url = new URL(request.url);
  if (!expected || url.searchParams.get('token') !== expected) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const res = NextResponse.redirect(new URL(url.searchParams.get('next') || '/dashboard', request.url));
  res.cookies.set(sessionCookie());
  return res;
}
