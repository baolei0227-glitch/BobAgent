/**
 * 宿主工具直通（服务端）—— 小程序桥 hostTool / listHostTools 的落地层。
 *
 * 为什么单独抽一层 + 为什么必须**静态** import：
 *   放开小程序权限（2026-10-10）后，小程序可通过 `BobWork.host(name, args)` 调用宿主工具
 *   注册表里的任意工具（与画布 AI 同权）。最初实现是在路由处理函数里
 *   `await import('@/app/api/chat/tools')`，实测会让 dev server 整体挂死：
 *   hostTool 请求永不返回，随后同进程**所有**路由（含 /api/sandbox、/api/tools）一起超时。
 *   改为静态 import 后与 /api/tools 同款依赖图，编译一次、请求正常。
 *   （/api/tools 路由本身也是静态 import 该注册表，可作对照。）
 *
 * 2026-10-10 评估 A5/A4 追加「信任分级 + 并发闸」：
 *   - `origin='built'`（宿主自己建/改的小程序）：全量工具（除下面 NEVER 名单）。
 *   - `origin='imported'`（用户导入的第三方 ZIP）：只给只读工具，且只能读它自己目录里的文件。
 *   - NEVER 名单（两种来源都禁）：循环控制类（team_run/finish_task/todo_write/ask_user_questions）
 *     与改宿主配置类（update_provider_config / manage_mcp_server / manage_quick_launch / set_app_icon）。
 *   - 同一 appId 的 hostTool 并发上限 4，防一个页面把 run_command 刷满。
 */

import { executeTool, listAllToolDefs } from '@/app/api/chat/tools';

export type AppOrigin = 'built' | 'imported';

export interface HostToolAccessInput {
  origin: AppOrigin;
  appId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface HostToolAccessDecision {
  allowed: boolean;
  reason?: string;
}

/** 两种来源都禁止：循环控制 / 编排 / 改宿主配置 */
export const NEVER_BRIDGE_TOOLS: readonly string[] = [
  // 对话循环控制类：由宿主接管，从桥里调用没有语义（team_run 还会真跑一次多智能体任务）
  'team_run', 'finish_task', 'todo_write', 'ask_user_questions', 'search_capabilities',
  // 改宿主全局配置类：小程序无权改（等价提权）
  'update_provider_config', 'manage_mcp_server', 'manage_quick_launch', 'set_app_icon',
];

/** 导入的小程序（第三方代码）唯一允许的工具：只读，且路径必须落在它自己的目录内 */
export const IMPORTED_ALLOWED_TOOLS: readonly string[] = [
  'read_file', 'list_directory', 'search_files',
];

/** 需要限定「只能操作自己」的工具：参数里的 appId 必须等于调用者 */
const SELF_ONLY_APPID_TOOLS: readonly string[] = ['sandbox_rollback', 'sandbox_export'];

function argString(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = args?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** 纯函数：判断某个 app 是否可以调用某工具（不碰磁盘，便于单测） */
export function evaluateHostToolAccess(input: HostToolAccessInput): HostToolAccessDecision {
  const { origin, appId, name, args } = input;
  if (!name) return { allowed: false, reason: 'tool name is required' };

  if (NEVER_BRIDGE_TOOLS.includes(name)) {
    return {
      allowed: false,
      reason: `tool "${name}" is not available to mini-programs (host loop-control / host configuration)`,
    };
  }

  // 限定「只能操作自己」的工具：appId 参数必须是自己
  if (SELF_ONLY_APPID_TOOLS.includes(name)) {
    const target = argString(args, ['appId', 'app_id']);
    if (target && target !== appId) {
      return { allowed: false, reason: `tool "${name}" may only target the calling mini-program` };
    }
  }

  if (origin === 'built') return { allowed: true };

  // ── imported：只读 + 只能读自己目录 ──
  if (!IMPORTED_ALLOWED_TOOLS.includes(name)) {
    return {
      allowed: false,
      reason: `imported mini-programs may only use read-only tools (${IMPORTED_ALLOWED_TOOLS.join(', ')}); "${name}" is blocked`,
    };
  }
  const path = argString(args, ['path', 'file', 'dir']);
  if (!path) {
    return { allowed: false, reason: `tool "${name}" requires an explicit path for imported mini-programs` };
  }
  const ownPrefix = `bob-sandbox/apps/${appId}`;
  const normalized = path.replace(/^\.?\//, '');
  if (!(normalized === ownPrefix || normalized.startsWith(ownPrefix + '/'))) {
    return { allowed: false, reason: `imported mini-programs may only read inside ${ownPrefix}/` };
  }
  return { allowed: true };
}

export interface HostToolRunResult {
  success: boolean;
  result: string;
  durationMs: number;
}

/** 每个小程序同时进行的 hostTool 调用上限（防并发刷满 CPU / 磁盘） */
const MAX_CONCURRENT_PER_APP = 4;
const inFlight = new Map<string, number>();

export interface RunHostToolContext {
  appId: string;
  origin: AppOrigin;
}

/** 执行一个宿主工具（名 + 参数对象）；未知工具名返回 success:false + 可用清单提示，不抛错 */
export async function runHostTool(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: RunHostToolContext,
): Promise<HostToolRunResult> {
  const safeArgs = args ?? {};
  const decision = evaluateHostToolAccess({ origin: ctx.origin, appId: ctx.appId, name, args: safeArgs });
  if (!decision.allowed) {
    return { success: false, result: `BLOCKED: ${decision.reason}`, durationMs: 0 };
  }

  const current = inFlight.get(ctx.appId) ?? 0;
  if (current >= MAX_CONCURRENT_PER_APP) {
    return {
      success: false,
      result: `BLOCKED: too many concurrent host-tool calls from this mini-program (max ${MAX_CONCURRENT_PER_APP})`,
      durationMs: 0,
    };
  }
  inFlight.set(ctx.appId, current + 1);
  try {
    const r = await executeTool(name, JSON.stringify(safeArgs));
    return { success: r.success, result: r.result, durationMs: r.durationMs };
  } finally {
    const left = (inFlight.get(ctx.appId) ?? 1) - 1;
    if (left <= 0) inFlight.delete(ctx.appId);
    else inFlight.set(ctx.appId, left);
  }
}

/** 全量宿主工具清单（name / description / category / scenes），供小程序自建工具面板 */
export function listHostTools(): ReturnType<typeof listAllToolDefs> {
  return listAllToolDefs();
}
