import { NextRequest } from 'next/server';
import { guardRequestSource } from '@/lib/http/loopback-guard';
import {
  listApps,
  createApp,
  updateAppEntry,
  duplicateApp,
  updateAppMeta,
  writeAppLocalStorage,
  listAppHistory,
  restoreAppHistory,
  listTrash,
  restoreApp,
  purgeTrashItem,
  sanitizeAppId,
} from '@/lib/sandbox/apps';
import { deleteAppCascade, listGhostAppDirs } from '@/lib/sandbox/app-lifecycle';
import { SANDBOX_TEMPLATE_LIST } from '@/lib/sandbox/templates';

/**
 * Bob Sandbox 小程序管理接口：
 *   GET    → 小程序列表（附带可用模板 + 回收站 + 幽灵目录）
 *   POST   { action:'create' | 'update' | 'restore' | 'purge', … }
 *   DELETE { id } → 删除小程序（进回收站 + 清授权表 + 解绑节点，见 deleteAppCascade）
 */
export async function GET(request: NextRequest) {
  const denied = await guardRequestSource(request);
  if (denied) return denied;
  try {
    const [apps, trash, ghosts] = await Promise.all([
      listApps(),
      listTrash(),
      listGhostAppDirs(),
    ]);
    // 模板只回 DTO（id/label/description/entry）：完整模板含源码与 promptSeed，实测每次列表 51KB
    // 而客户端只用这 4 个字段（2026-10-10 评估 P2-14）。
    const templates = SANDBOX_TEMPLATE_LIST.map((t) => ({
      id: t.id, label: t.label, description: t.description, entry: t.entry,
    }));
    return Response.json({ success: true, apps, templates, trash, ghosts });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = await guardRequestSource(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => null);
    const action = body?.action;
    if (action === 'create') {
      const app = await createApp(String(body?.name ?? ''), body?.template);
      return Response.json({ success: true, app });
    }
    if (action === 'update') {
      const { id, content } = body;
      // 2026-10-10：id 白名单（原先直传 join(root,id,manifest.entry)，可越界写）
      const safeId = sanitizeAppId(id);
      if (!safeId || typeof content !== 'string') {
        return Response.json({ success: false, error: 'id and content are required' }, { status: 400 });
      }
      const ok = await updateAppEntry(safeId, content);
      return Response.json({ success: ok });
    }
    if (action === 'duplicate') {
      const app = await duplicateApp(
        String(body?.id ?? ''),
        typeof body?.name === 'string' ? body.name : undefined,
      );
      return app
        ? Response.json({ success: true, app })
        : Response.json({ success: false, error: 'duplicate failed' }, { status: 400 });
    }
    if (action === 'update_meta') {
      const app = await updateAppMeta(String(body?.id ?? ''), {
        ...(typeof body?.name === 'string' ? { name: body.name } : {}),
        ...(typeof body?.description === 'string' ? { description: body.description } : {}),
        ...(typeof body?.icon === 'string' ? { icon: body.icon } : {}),
      });
      return app
        ? Response.json({ success: true, app })
        : Response.json({ success: false, error: 'update_meta failed' }, { status: 400 });
    }
    if (action === 'save_local_storage') {
      const entries = (Array.isArray(body?.entries) ? body.entries : []) as Array<{ key: string; value: string | null }>;
      const ok = await writeAppLocalStorage(String(body?.id ?? ''), entries);
      return ok
        ? Response.json({ success: true })
        : Response.json({ success: false, error: 'save_local_storage failed' }, { status: 400 });
    }
    if (action === 'history') {
      const entries = await listAppHistory(String(body?.id ?? ''));
      return Response.json({ success: true, entries });
    }
    if (action === 'restore_version') {
      const ok = await restoreAppHistory(
        String(body?.id ?? ''),
        String(body?.file ?? ''),
        String(body?.stamp ?? ''),
      );
      return Response.json({ success: ok }, { status: ok ? 200 : 400 });
    }
    if (action === 'restore') {
      const res = await restoreApp(body?.trashId);
      return Response.json({ success: res.ok, appId: res.appId, error: res.reason }, { status: res.ok ? 200 : 400 });
    }
    if (action === 'purge') {
      const ok = await purgeTrashItem(body?.trashId);
      return Response.json({ success: ok }, { status: ok ? 200 : 400 });
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
  const denied = await guardRequestSource(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => null);
    const safeId = sanitizeAppId(body?.id);
    if (!safeId) {
      return Response.json({ success: false, error: '小程序 id 非法' }, { status: 400 });
    }
    // 级联：进回收站 + 清授权表 + 解绑引用它的画布节点（节点保留，仅清 sandbox_app_id）
    const result = await deleteAppCascade(safeId);
    if (!result.ok) {
      return Response.json({ success: false, error: result.reason || 'delete failed' }, { status: 400 });
    }
    return Response.json({
      success: true,
      trashId: result.trashId,
      nodesUnbound: result.nodesUnbound,
      permissionsCleared: result.permissionsCleared,
    });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
