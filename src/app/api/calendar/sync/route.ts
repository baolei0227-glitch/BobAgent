import { NextRequest, NextResponse } from 'next/server';
import { syncAccount, syncAllAccounts } from '@/lib/calendar/sync-runner';

/** POST /api/calendar/sync  body: { account_id? } → 手动触发同步（全部或单个账户） */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId: string | undefined = body?.account_id;
    if (accountId) {
      const result = await syncAccount(accountId);
      return NextResponse.json({ ok: true, result });
    }
    const results = await syncAllAccounts();
    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Sync failed' }, { status: 500 });
  }
}