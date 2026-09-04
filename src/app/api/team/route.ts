/**
 * /api/team — Agent Teams（bob-team-mcp）转发入口
 *
 * 与 /api/bobby 同构：BobWork 前端经此 route 转调 bob-team-mcp 的 MCP 工具
 * （mcpManager 通道复用，插件无需开放额外端口）。
 *
 * GET                                          → 插件启用状态 + 团队列表
 * POST { action: 'status'|'plan'|'approve'|'discard'|'archive'|'send'|'reply'
 *             |'messages'|'tasks'|'add_task'|'add_member'|'remove_member'
 *             |'collect'|'quality'|'resume', team_id?, ...args } → 转调对应工具
 */

import { NextResponse } from 'next/server';
import { mcpManager } from '@/lib/mcp/manager';
import { readSettingsFromFile } from '@/lib/settings-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEAM_SERVER_ID = 'team';

/** action → MCP 工具名（全名：mcp__team__<tool>） */
const ACTION_TO_TOOL: Record<string, string> = {
  create: 'team_create',
  list: 'team_list',
  status: 'team_status',
  plan: 'team_plan',
  approve: 'team_approve',
  discard: 'team_discard',
  archive: 'team_archive',
  send: 'msg_send',
  reply: 'msg_reply',
  messages: 'msg_list',
  tasks: 'task_status',
  add_task: 'task_add',
  add_member: 'team_add_member',
  remove_member: 'team_remove_member',
  collect: 'result_collect',
  quality: 'quality_plan',
  resume: 'quality_resume',
};

async function getTeamConfig() {
  const settings = await readSettingsFromFile();
  const serverConfig = (settings.mcpServers || []).find((s) => s.id === TEAM_SERVER_ID);
  return { settings, serverConfig };
}

/** 确保 MCP 连接并调团队工具 */
async function callTeam(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string } & Record<string, unknown>> {
  const { settings, serverConfig } = await getTeamConfig();
  if (!serverConfig || !serverConfig.enabled) {
    return { ok: false, error: `Agent Teams MCP 未启用：请在设置面板开启 ${TEAM_SERVER_ID}` };
  }
  await mcpManager.syncServers(settings.mcpServers);
  const raw = await mcpManager.callTool(`mcp__${TEAM_SERVER_ID}__${tool}`, args);
  const parsed = parseToolOutput(raw);
  if (!parsed) return { ok: false, error: `Agent Teams 调用异常：${raw.slice(0, 300)}` };
  return { ok: true, ...(parsed as Record<string, unknown>) };
}

export async function GET() {
  try {
    const { serverConfig } = await getTeamConfig();
    const enabled = serverConfig ? serverConfig.enabled === true : false;
    let teams: string[] = [];
    if (enabled) {
      const r = await callTeam('team_list').catch(() => null);
      if (r && r.ok && Array.isArray(r.teams)) teams = r.teams as string[];
    }
    return NextResponse.json({ ok: true, enabled, teams });
  } catch (e) {
    console.error('GET /api/team error:', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      team_id?: string;
      [k: string]: unknown;
    };
    const action = body.action ?? '';
    const tool = ACTION_TO_TOOL[action];
    if (!tool) return NextResponse.json({ ok: false, error: `未知 action: ${action}` });

    const args: Record<string, unknown> = { ...body };
    delete args.action;
    if (args.team_id === undefined) delete args.team_id;

    const result = await callTeam(tool, args);
    return NextResponse.json(result);
  } catch (e) {
    console.error('POST /api/team error:', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** 从 MCP 工具返回中解析 JSON（兼容裸 JSON / 包裹对象两种形态） */
function parseToolOutput(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const outer = JSON.parse(trimmed);
    if (Array.isArray(outer.content) && outer.content[0]?.type === 'text' && typeof outer.content[0].text === 'string') {
      try {
        return JSON.parse(outer.content[0].text);
      } catch {
        return { output: outer.content[0].text };
      }
    }
    return outer;
  } catch {
    return null;
  }
}
