/**
 * /api/mcp/test — 测试单个 MCP 服务器连接
 *
 * POST — 接收单个 McpServerConfig，尝试连接并列出工具，返回结果
 */

import { NextResponse } from 'next/server';
import { mcpManager } from '@/lib/mcp/manager';
import { resolveBundledMcpPlaceholders } from '@/lib/settings-server';
import type { McpServerConfig } from '@/lib/mcp/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const config = body.config as McpServerConfig;

    if (!config || !config.id || !config.transport) {
      return NextResponse.json(
        { success: false, error: 'Invalid config' },
        { status: 400 },
      );
    }

    // 本地内置能力（legacy 配置兜底）：settings 旧副本若残留 builtin 配置仍按内置处理。
    if (config.builtin) {
      return NextResponse.json({
        success: true,
        toolsCount: 0,
        builtin: true,
        note: 'Built-in capability: no MCP connection required',
      });
    }

    if (config.transport === 'stdio' && !config.command) {
      return NextResponse.json(
        { success: false, error: 'Command is required for stdio transport' },
        { status: 400 },
      );
    }

    if (config.transport === 'streamable-http' && !config.url) {
      return NextResponse.json(
        { success: false, error: 'URL is required for streamable-http transport' },
        { status: 400 },
      );
    }

    // 前端直传的 config（未保存的预设）可能仍带 {BUNDLED}: 占位符，
    // 必须先解析为绝对路径，否则 spawn 找不到插件入口 → Connection closed
    const [resolved] = resolveBundledMcpPlaceholders([config]);

    const result = await mcpManager.testConnection(resolved);

    return NextResponse.json(result);
  } catch (e: any) {
    console.error('POST /api/mcp/test error:', e);
    return NextResponse.json(
      { success: false, toolsCount: 0, error: e?.message || 'Test failed' },
      { status: 500 },
    );
  }
}
