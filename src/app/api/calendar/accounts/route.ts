import { NextRequest, NextResponse } from 'next/server';
import {
  getCalendarDb,
  listCalendarAccounts,
  getCalendarAccount,
  createCalendarAccount,
  updateCalendarAccount,
  deleteCalendarAccount,
  listSyncLogs,
  addSyncLog,
  type CalendarAccountData,
} from '@/lib/db';
import { getCurrentProject } from '@/lib/project/project-manager';
import { encryptSecret } from '@/lib/secrets';

/** 无当前项目时的占位 project_id（日历与项目独立） */
const GLOBAL_PROJECT_ID = '__global__';

/** 账户更新载荷：server_url / calendar_url 允许 null（用于清空字段，落库为 NULL） */
type AccountUpdateInput = Partial<Omit<CalendarAccountData, 'project_id' | 'server_url' | 'calendar_url'>> & {
  server_url?: string | null;
  calendar_url?: string | null;
};

/** updateCalendarAccount 的入参类型（其声明不允许 null 清空，故调用处做一次精确转换） */
type AccountUpdateParam = Partial<Omit<CalendarAccountData, 'project_id'>>;

/** 获取全局日历数据库（账户与项目完全独立） */
async function getDb() {
  return await getCalendarDb();
}

/** 取当前项目 id 作为账户归属（纯展示归属）；无项目时用占位 */
async function safeProjectId(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return project.id;
  } catch {
    return GLOBAL_PROJECT_ID;
  }
}

/** GET /api/calendar/accounts → 列出账户（不含密码密文）与最近日志 */
export async function GET(req: NextRequest) {
  try {
    const db = await getDb();
    const accounts = await listCalendarAccounts(db, null);
    const safe = accounts.map((a) => ({
      account_id: a.account_id,
      provider: a.provider,
      name: a.name,
      username: a.username,
      server_url: a.server_url,
      calendar_url: a.calendar_url,
      calendar_name: a.calendar_name,
      read_only: a.read_only === 1,
      sync_token: a.sync_token,
      last_sync_at: a.last_sync_at,
      enabled: a.enabled === 1,
      has_password: !!a.password_enc,
    }));
    const logs = await listSyncLogs(db, null, undefined, 30);
    return NextResponse.json({ ok: true, accounts: safe, logs });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'List failed' }, { status: 500 });
  }
}

/** POST /api/calendar/accounts  body: { provider, name, username?, password?, server_url?, calendar_url?, read_only? } */
export async function POST(req: NextRequest) {
  try {
    const db = await getDb();
    const body = await req.json().catch(() => ({}));
    const projectId = await safeProjectId();

    const provider: string = body?.provider || 'caldav';
    if (provider !== 'caldav' && provider !== 'webcal') {
      return NextResponse.json({ ok: false, error: 'provider must be caldav | webcal' }, { status: 400 });
    }
    const name: string = body?.name?.trim() || (provider === 'webcal' ? 'WebCal Subscription' : 'iCloud Calendar');
    const username = body?.username?.trim() || null;
    const password = body?.password || null;
    const serverUrl = body?.server_url?.trim() || null;
    const calendarUrl = body?.calendar_url?.trim() || null;
    const readOnly = !!body?.read_only;

    if (provider === 'caldav') {
      if (!username || !password || !calendarUrl) {
        return NextResponse.json({ ok: false, error: 'caldav requires username + app-specific password + calendar_url' }, { status: 400 });
      }
    } else {
      if (!serverUrl) {
        return NextResponse.json({ ok: false, error: 'webcal requires server_url (.ics URL)' }, { status: 400 });
      }
    }

    const accountId = await createCalendarAccount(db, {
      project_id: projectId,
      provider: provider as 'caldav' | 'webcal',
      name,
      username,
      password_enc: password ? encryptSecret(password) : undefined,
      server_url: serverUrl || undefined,
      calendar_url: calendarUrl || undefined,
      read_only: readOnly,
    });
    await addSyncLog(db, accountId, projectId, 'info', `Account "${name}" created`);
    return NextResponse.json({ ok: true, account_id: accountId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'Create failed' }, { status: 500 });
  }
}

/** PUT /api/calendar/accounts  更新账户（body 带 account_id + 可选字段） */
export async function PUT(req: NextRequest) {
  try {
    const db = await getDb();
    const body = await req.json().catch(() => ({}));
    const accountId: string = body?.account_id;
    if (!accountId) return NextResponse.json({ ok: false, error: 'account_id required' }, { status: 400 });

    const account = await getCalendarAccount(db, accountId);
    if (!account) return NextResponse.json({ ok: false, error: 'account not found' }, { status: 404 });

    const updates: AccountUpdateInput = {};
    if (body.name !== undefined) updates.name = String(body.name).trim();
    if (body.username !== undefined) updates.username = String(body.username).trim();
    if (body.password !== undefined && body.password !== '') {
      updates.password_enc = encryptSecret(String(body.password));
    }
    if (body.server_url !== undefined) updates.server_url = body.server_url?.trim() || null;
    if (body.calendar_url !== undefined) updates.calendar_url = body.calendar_url?.trim() || null;
    if (body.read_only !== undefined) updates.read_only = !!body.read_only;
    if (body.enabled !== undefined) updates.enabled = !!body.enabled;

    await updateCalendarAccount(db, accountId, updates as AccountUpdateParam);
    await addSyncLog(db, accountId, account.project_id, 'info', 'Account updated');
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'Update failed' }, { status: 500 });
  }
}

/** DELETE /api/calendar/accounts?account_id= */
export async function DELETE(req: NextRequest) {
  try {
    const db = await getDb();
    const accountId = req.nextUrl.searchParams.get('account_id');
    if (!accountId) return NextResponse.json({ ok: false, error: 'account_id required' }, { status: 400 });
    const account = await getCalendarAccount(db, accountId);
    if (account) {
      await deleteCalendarAccount(db, accountId);
      await addSyncLog(db, accountId, account.project_id, 'info', 'Account removed');
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error && e.message ? e.message : 'Delete failed' }, { status: 500 });
  }
}

