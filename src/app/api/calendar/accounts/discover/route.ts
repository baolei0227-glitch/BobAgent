import { NextRequest, NextResponse } from 'next/server';
import { discoverCalendars } from '@/lib/calendar/sync';

/** POST /api/calendar/accounts/discover  body: { username, password, principal_url } → 探测 iCloud 日历列表 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const username: string = body?.username;
    const password: string = body?.password;
    const principalUrl: string = body?.principal_url || 'https://caldav.icloud.com';
    if (!username || !password) {
      return NextResponse.json({ ok: false, error: 'username + password required' }, { status: 400 });
    }
    const calendars = await discoverCalendars(principalUrl, username, password);
    return NextResponse.json({ ok: true, calendars });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'Discover failed' }, { status: 500 });
  }
}