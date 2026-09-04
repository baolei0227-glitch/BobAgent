import { NextRequest } from 'next/server';
import { listApps, createApp, removeApp, updateAppEntry } from '@/lib/sandbox/apps';
import { SANDBOX_TEMPLATE_LIST } from '@/lib/sandbox/templates';

/**
 * Bob Sandbox 小程序管理接口：
 *   GET    → 小程序列表（附带可用模板）
 *   POST   { action:'create', name, template } → 新建小程序
 *   DELETE { id } → 删除小程序
 */
export async function GET() {
  try {
    const apps = await listApps();
    return Response.json({ success: true, apps, templates: SANDBOX_TEMPLATE_LIST });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const action = body?.action;
    if (action === 'create') {
      const app = await createApp(String(body?.name ?? ''), body?.template);
      return Response.json({ success: true, app });
    }
    if (action === 'update') {
      const { id, content } = body;
      if (!id || typeof content !== 'string') {
        return Response.json({ success: false, error: 'id and content are required' }, { status: 400 });
      }
      const ok = await updateAppEntry(String(id), content);
      return Response.json({ success: ok });
    }
    return Response.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const id = String(body?.id ?? '');
    if (!id) return Response.json({ success: false, error: 'id 缺失' }, { status: 400 });
    await removeApp(id);
    return Response.json({ success: true });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
