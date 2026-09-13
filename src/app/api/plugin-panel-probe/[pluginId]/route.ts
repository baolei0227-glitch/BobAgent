import { NextResponse } from 'next/server';
import { collectPluginPanelEntries, probePluginPanel } from '@/lib/plugin-panels-server';

/**
 * 插件面板就绪探测（GET /api/plugin-panel-probe/<pluginId>）
 *
 * 面板壳挂 iframe 前调用：由宿主进程判定「面板是否真的可用」，而不是前端直连插件
 * statusPath —— 端口被残留旧进程占用时前端直连会命中旧进程并误判就绪（静默加载旧界面）。
 * 返回 { ok, reason?, port?, holderPid? }，失败原因供面板壳给出可操作提示。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pluginId: string }> },
): Promise<NextResponse> {
  const { pluginId } = await params;
  if (!pluginId) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 400 });

  try {
    const entries = await collectPluginPanelEntries();
    const entry = entries.find((e) => e.pluginId === pluginId);
    if (!entry) return NextResponse.json({ ok: false, reason: 'not-found' }, { status: 404 });

    const probe = await probePluginPanel(entry);
    return NextResponse.json({ pluginId, ...probe }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reason: 'unreachable', error: err instanceof Error ? err.message : 'Probe failed' },
      { status: 500 },
    );
  }
}
