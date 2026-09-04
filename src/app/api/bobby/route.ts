/**
 * /api/bobby — BobbyNode 后端入口（观察 + 授权控制台，不承担执行）
 *
 * Bobby 定位（2026-08-25 用户确认）：
 *   Bobby 是插件，执行统一由主 Agent（ChatNode）编排调用 Bobby MCP 工具。
 *   插件启用（MCP 设置面板）即对主 Agent 开放，无独立暴露开关。
 *   画布 BobbyNode 仅用于观察状态（含实时进度）与授权管理。
 *
 * GET                                            → 查询插件状态（enabled + 实时进度 + 待授权 + 授权列表）
 * POST { action: 'grant', target }               → 授权软件
 * POST { action: 'revoke', target }              → 撤销授权
 * POST { action: 'list_grants' }                 → 列出授权
 * POST { action: 'history', limit }              → 调用历史
 * POST { action: 'status' }                      → 实时状态（同 GET，POST 形式）
 */
import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { mcpManager } from '@/lib/mcp/manager';
import { readSettingsFromFile } from '@/lib/settings-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BOBBY_SERVER_ID = 'bobby';
/** 与 mcpManager.callTool 匹配的 fullName（sanitizeToolName 保留连字符） */
const BOBBY_GRANT_FULLNAME = `mcp__${BOBBY_SERVER_ID}__grant_app`;
const BOBBY_REVOKE_FULLNAME = `mcp__${BOBBY_SERVER_ID}__revoke_grant`;
const BOBBY_LIST_GRANTS_FULLNAME = `mcp__${BOBBY_SERVER_ID}__list_grants`;
const BOBBY_LIST_HISTORY_FULLNAME = `mcp__${BOBBY_SERVER_ID}__list_history`;
const BOBBY_STATUS_FULLNAME = `mcp__${BOBBY_SERVER_ID}__get_status`;
const BOBBY_SET_TEMP_ALLOW_FULLNAME = `mcp__${BOBBY_SERVER_ID}__set_temp_allow`;
const BOBBY_ABORT_FULLNAME = `mcp__${BOBBY_SERVER_ID}__abort`;

/** 读取 bobby 服务配置 */
async function getBobbyConfig() {
  const settings = await readSettingsFromFile();
  const serverConfig = (settings.mcpServers || []).find(
    (s) => s.id === BOBBY_SERVER_ID,
  );
  return { settings, serverConfig };
}

/** 确保 MCP 连接并调工具 */
async function callBobby(fullName: string, args: Record<string, unknown> = {}) {
  const { settings, serverConfig } = await getBobbyConfig();
  if (!serverConfig || !serverConfig.enabled) {
    return { ok: false as const, error: `Bobby MCP 未启用：请在设置面板开启 ${BOBBY_SERVER_ID}` };
  }
  await mcpManager.syncServers(settings.mcpServers);
  const raw = await mcpManager.callTool(fullName, args, { redactArgs: true });
  const parsed = parseToolOutput(raw);
  if (!parsed) return { ok: false as const, error: `Bobby 调用异常：${raw.slice(0, 300)}` };
  return parsed as Record<string, unknown>;
}

export async function GET() {
  try {
    const { serverConfig } = await getBobbyConfig();
    // 默认关闭：仅当配置显式 enabled === true 才算启用（未配置 / 字段缺失 / 未勾选 → 一律关闭）
    const enabled = serverConfig ? serverConfig.enabled === true : false;
    // 连接正常时附加实时状态
    let status: Record<string, unknown> = {};
    if (enabled) {
      const s = await callBobby(BOBBY_STATUS_FULLNAME).catch(() => null);
      if (s && s.ok) status = s;
    }
    return NextResponse.json({ ok: true, enabled, ...status });
  } catch (e) {
    console.error('GET /api/bobby error:', e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      target?: string;
      limit?: number;
      durationMs?: number;
      dryRun?: boolean;
    };
    const action = body.action ?? '';

    if (action === 'grant' || action === 'revoke') {
      const target = typeof body.target === 'string' ? body.target.trim() : '';
      if (!target) return NextResponse.json({ ok: false, error: `${action} 需要 target` });
      const fullName = action === 'grant' ? BOBBY_GRANT_FULLNAME : BOBBY_REVOKE_FULLNAME;
      const result = await callBobby(fullName, { target });
      return NextResponse.json(result);
    }

    if (action === 'list_grants') {
      return NextResponse.json(await callBobby(BOBBY_LIST_GRANTS_FULLNAME));
    }

    if (action === 'history') {
      const result = await callBobby(
        BOBBY_LIST_HISTORY_FULLNAME,
        typeof body.limit === 'number' ? { limit: body.limit } : {},
      );
      return NextResponse.json(result);
    }

    if (action === 'status') {
      return NextResponse.json(await callBobby(BOBBY_STATUS_FULLNAME));
    }

    if (action === 'temp_allow') {
      // 本次任务临时放行：target 省略 = 放行全部；durationMs=0 = 取消
      const result = await callBobby(BOBBY_SET_TEMP_ALLOW_FULLNAME, {
        ...(typeof body.target === 'string' && body.target.trim() ? { target: body.target.trim() } : {}),
        ...(typeof body.durationMs === 'number' ? { durationMs: body.durationMs } : {}),
      });
      return NextResponse.json(result);
    }

    if (action === 'abort') {
      // 急停：用户按 ESC / 点停止按钮 → 中止当前与后续操作
      return NextResponse.json(await callBobby(BOBBY_ABORT_FULLNAME));
    }

    if (action === 'permissions') {
      // 系统授权状态检测（辅助功能 + 屏幕录制）——BobbyNode 授权引导面板
      return NextResponse.json(await callBobby('mcp__bobby__check_permissions'));
    }

    if (action === 'open_permissions') {
      // 跳转系统设置对应授权页（辅助功能 / 屏幕录制）——一键引导
      const page = body.target === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
      const url = `x-apple.systempreferences:com.apple.preference.security?${page}`;
      await new Promise<void>((resolve) => {
        exec(`open "${url}"`, () => resolve());
      });
      return NextResponse.json({ ok: true, detail: `已打开系统设置：${page === 'Privacy_ScreenCapture' ? '屏幕录制' : '辅助功能'}（勾选宿主应用后完全重启 BobWork 生效）` });
    }

    if (action === 'revoke_permissions') {
      // 关闭 Bobby：自动撤销系统授权（辅助功能/屏幕录制，按宿主 bundle id）+ 清空软件授权（grants.json）
      // body: { target: 宿主应用名（默认 BobWork）, dryRun?: true 仅预览不执行 }
      const appName = typeof body.target === 'string' && body.target.trim() ? body.target.trim() : 'BobWork';
      const dryRun = body.dryRun === true;
      const revoked: string[] = [];
      // 1. 系统授权：osascript 取宿主 bundle id → tccutil reset 精确撤销
      if (!dryRun) {
        try {
          const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
            exec(`osascript -e 'id of app "${appName}"'`, { timeout: 8000 }, (err, out) => (err ? reject(err) : resolve({ stdout: out ?? '' })));
          });
          const bundleId = stdout.trim();
          if (bundleId) {
            for (const svc of ['Accessibility', 'ScreenCapture']) {
              await new Promise<void>((resolve) => exec(`tccutil reset ${svc} ${bundleId}`, () => resolve()));
              revoked.push(`${svc} (${bundleId})`);
            }
          }
        } catch { /* 宿主应用未运行/无法取 bundle id → 跳过系统撤销，仅清软件授权 */ }
        // 2. 软件授权：逐项撤销 grants.json
        try {
          const grants = await callBobby(BOBBY_LIST_GRANTS_FULLNAME);
          const list = (grants.grants ?? []) as Array<{ target: string }>;
          for (const g of list) {
            await callBobby(BOBBY_REVOKE_FULLNAME, { target: g.target });
          }
          revoked.push(`软件授权清空（${list.length} 项）`);
        } catch { /* bobby 未连接时忽略 */ }
      }
      return NextResponse.json({
        ok: true,
        revoked,
        dryRun,
        detail: dryRun
          ? `[预览] 将撤销：${revoked.join('、')}`
          : `已撤销：${revoked.length > 0 ? revoked.join('、') : '无（宿主未运行或已清空）'}`,
      });
    }

    return NextResponse.json({ ok: false, error: `未知 action: ${action}` });
  } catch (e) {
    console.error('POST /api/bobby error:', e);
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
        return { ok: true, output: outer.content[0].text };
      }
    }
    return outer;
  } catch {
    return null;
  }
}
