import { NextResponse } from 'next/server';
import { collectPluginPanelEntries } from '@/lib/plugin-panels-server';

/** GET /api/plugin-panels — 宿主「插件面板注册表」清单（enabled 实例 + 出厂面板声明） */
export async function GET(): Promise<NextResponse> {
  try {
    const entries = await collectPluginPanelEntries();
    return NextResponse.json({ entries });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to list plugin panels' }, { status: 500 });
  }
}
