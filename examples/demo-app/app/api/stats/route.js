import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, isValidSession } from '../../../lib/auth';

const STATS = {
  kpis: [
    { label: 'Revenue', value: '$48,290', delta: '+12.4%', up: true },
    { label: 'Replies', value: '1,284', delta: '+8.1%', up: true },
    { label: 'Meetings booked', value: '214', delta: '+23.0%', up: true },
    { label: 'Bounce rate', value: '1.9%', delta: '-0.6%', up: false },
  ],
  weekly: [32, 41, 38, 52, 61, 58, 74, 69, 83, 91, 88, 104],
  channels: [
    { name: 'Email', value: 58 },
    { name: 'LinkedIn', value: 27 },
    { name: 'Calls', value: 15 },
  ],
  activity: [
    { who: 'Maya Chen', what: 'booked a demo from', target: 'Q3 Enterprise', when: '2m' },
    { who: 'Leo Martins', what: 'replied to', target: 'Founders follow-up', when: '14m' },
    { who: 'Priya Natarajan', what: 'opened', target: 'Product launch', when: '1h' },
    { who: 'Sam Okafor', what: 'booked a demo from', target: 'Agency outreach', when: '3h' },
  ],
};

export async function GET(request) {
  const store = await cookies();
  if (!isValidSession(store.get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const delay = Number(new URL(request.url).searchParams.get('delay') ?? 900);
  await new Promise((r) => setTimeout(r, Math.min(delay, 10000)));
  return NextResponse.json(STATS);
}
