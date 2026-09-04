/**
 * /api/mcp/status — 返回全部 MCP 服务器的插件运行态（connected / error / missing deps）
 *
 * GET — 先按当前 settings 同步插件装配（挂载新增/重启变更/卸载移除），再返回状态列表。
 * 供设置页 UI 为每个 server 展示连接状态与失败原因（含依赖缺失）。
 */

import { NextResponse } from 'next/server';
import { mcpManager } from '@/lib/mcp/manager';
import { readSettingsFromFile } from '@/lib/settings-server';

export async function GET() {
  try {
    const settings = await readSettingsFromFile();
    await mcpManager.syncServers(settings.mcpServers || []);
    return NextResponse.json({ statuses: mcpManager.getPluginStatuses() });
  } catch (e: any) {
    console.error('GET /api/mcp/status error:', e);
    return NextResponse.json(
      { statuses: [], error: e?.message || 'Failed to load MCP status' },
      { status: 500 },
    );
  }
}
