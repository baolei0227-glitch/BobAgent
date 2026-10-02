// K2-S1 工具面 runtime service 抽取，行为不变
// =====================================================================================
// 把 route.ts（src/app/api/chat/route.ts）中「工具面」胶水收敛为独立 service：
//   - 工具注册：registerCustomTools（每次请求刷新，确保与 settings 同步）
//     + MCP 注册快照/排除（exposeToChatNodes/excludeToolsFromModel）+ mcpManager.syncServers；
//   - 场景/画像过滤组装 computeActiveToolDefs + 强制 MCP 合并 mergeForcedMcpToolDefs；
//   - 确定性排序 buildAndSortToolDefs（缓存前缀稳定化 P4 + 来源分组）+ CacheGuard 前缀守卫。
// CacheGuard 的 module 级可变状态（原 route.ts 526-716 区域 guard 变量）随迁本文件：其本身即
// 「模块级单例语义」（进程内跨请求漂移检测 + 跨重启落盘基准），故服务内保留模块级状态，仅把
// 引用点收进 service 方法 —— 进程内共享状态与告警语义与迁移前完全一致。
// ToolRuntime 每请求 new：仅持有请求级只读快照（settings / profile / sandbox / 强制 MCP 选择）。
// 硬约束：工具 def 最终数组（tools 段）与迁移前逐字节等价（CacheGuard 指纹 / prefixSegments 不变）。
// =====================================================================================

import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  getToolDefinitions,
  getToolSource,
  getToolLayer,
  registerCustomTools,
  registerMcpTools,
  mergeForcedMcpToolDefs,
  setBuiltinBrowserToolsEnabled,
} from '@/app/api/chat/tools';
import type { ToolDefinition, ToolScene } from '@/app/api/chat/tools';
import type { AgentProfile } from '@/lib/agents/profiles';
import { NODE_MCP_TOOL_IDS, type McpServerConfig } from '@/lib/mcp/types';
import { resolveAppRoot } from '@/lib/app-root';
import type { AppSettings } from '@/lib/settings';

/** 无确认回传链路下禁用的写类工具：避免 AI 产生文件/待办/日历/笔记/脚本等副作用。
 *
 *  命名沿革：原名取自已退役的「Butler Node 模式（沙盒模式）」，Node 模式退役（P1-e）后
 *  实际生效路径已改为 route 的 `ctx.channel` 收口与 `sandbox: true` 编排链路，语义不变。
 *  该名单是「副作用工具」的单一真源，被两处消费：
 *   ① `ToolRuntime.computeActiveToolDefs`：请求体 `sandbox: true`（organize-send 编排链路）
 *      → 直接从工具面过滤掉（写接口不给，只读查询仍可用）；
 *   ② route `denyOnAggregateChannel` 收口：聚合链路（微信桥等拿不到确认回传）按
 *      `SANDBOX_BLOCKED_TOOLS.has(name) && !WECHAT_ALLOWED_WRITES.has(name)` 拒（回话说明 + 不执行）。
 *  历史教训：旧 Node 模式提示词曾声称「不写入待办、日历」，但本名单只挡文件/命令类 →
 *  提示词说「不能写」、工具面却给着写接口，模型在两份矛盾指令间摇摆（实测 ` thinking`
 *  出现 "tools list includes create_scheduled_todo… There's tension"）。
 *  2026-09-25 补上「待办 / 日历」写类；P2 再补「笔记」写类（create_note / update_notebook /
 *  write_notebook_answer / restore_note / ingest_notes / review_notes / set_note_rules /
 *  delete_notebook），令「工具面 = 声称的能力边界」成立；微信通道由 WECHAT_ALLOWED_WRITES
 *  单独放行（delete_notebook 不放行——已被管家 coreExclusions 剔除，且属破坏性操作）。
 *  （偏好 remember/update/delete_preference 与 set_model_price 同为写类，暂不拦——
 *    避免顺手改出无关行为差异；微信通道另有 WECHAT_ALLOWED_WRITES 白名单单独放行。）
 *  注：lint_notes 是只读自检（仅产出报告，不改数据），故不列入本名单。 */
export const SANDBOX_BLOCKED_TOOLS = new Set([
  'write_file',
  'rename_file',
  'delete_file',
  'run_command',
  'execute_script',
  'set_app_icon', // 修改程序配置属写操作，禁写（get_app_config 只读仍可用）
  'update_provider_config',
  'manage_mcp_server',
  // 待办 / 日历（提示词「不写入待办、日历」的落地：写接口不给，只读查询仍可用）
  'create_scheduled_todo',
  'todo_update',
  'todo_delete',
  'plan_schedule',
  'create_sticky_note',
  // 新建项目（应用结构写动作：落目录 + 改全局项目配置）
  'create_project',
  // 笔记写类（P2 补齐：此前散落名单外 → 在聚合链路被静默直接执行、不弹确认）
  'create_note',
  'update_notebook',
  'write_notebook_answer',
  'restore_note',
  'ingest_notes',
  'review_notes',
  'set_note_rules',
  'delete_notebook', // 破坏性：微信白名单亦不放行（管家工具面已由 coreExclusions 剔除）
]);

/** 微信通道（channel='wechat'）**放行**的写类工具白名单（C 档）。
 *
 *  背景：微信桥是聚合链路（把上游 SSE 读到流结束才聚合成一句 JSON），确认卡/弹窗永远到不了
 *  用户手里 —— 若照桌面流程登记挂起，请求会空等到 CONFIRM_TIMEOUT_MS（10 分钟）。
 *  P0 统一入口后微信里一切写入都靠管家工具，若照旧「全部写类一律拒」，微信将彻底只能问答。
 *  故按「手机端高频且低风险」挑出下列工具放行（**无确认卡，直接执行**）：
 *    - 排程三件套：建 / 改 / 删日程与待办（手机端最常用）
 *    - 便签创建
 *    - 笔记写类（P2 补齐并显式化）：create_note / update_notebook / write_notebook_answer /
 *      restore_note / ingest_notes / review_notes / set_note_rules —— 微信里「记一下 / 查笔记 /
 *      /note raw / /note ingest」都要能真正落库（P1 统一入口目标），故一并放行。
 *  仍禁：文件读写 / 命令脚本 / 程序配置（手机上既难表达又高风险）、delete_notebook（破坏性）。
 *  消费点：route 的 `ctx.channel` 判定（butler 卡片 / tool_confirm / ask_user 三处）——
 *    微信（channel='wechat'）`SANDBOX_BLOCKED_TOOLS.has(name) && !WECHAT_ALLOWED_WRITES.has(name)` 才拒；
 *    其它聚合通道（channel='panel'）保持只读：白名单仅在 wechat 下生效，写类一律拒。
 *    （注：⌘F 面板已于 P1-c 退化为纯搜索，panel 通道当前无仓内调用方，语义按「聚合即只读」保留。） */
export const WECHAT_ALLOWED_WRITES = new Set([
  'create_scheduled_todo',
  'todo_update',
  'todo_delete',
  'plan_schedule',
  'create_sticky_note',
  // 新建项目（低风险且可逆：只建目录不删改；与便签同为「创建容器」类，微信直接放行）
  'create_project',
  'create_note',
  'update_notebook',
  'write_notebook_answer',
  'restore_note',
  'ingest_notes',
  'review_notes',
  'set_note_rules',
]);

/** 桥接外部通道（聚合链路，拿不到确认卡回传）：微信与飞书共用同一写类白名单。
 *  消费点：route 的 `ctx.channel` 判定（butler 卡片 / tool_confirm / ask_user 三处）——
 *  桥接通道放行白名单内写类，其余聚合通道（channel='panel'）保持只读。 */
export function isBridgeWriteAllowed(channel: string | undefined, tool: string): boolean {
  return (channel === 'wechat' || channel === 'feishu') && WECHAT_ALLOWED_WRITES.has(tool);
}

// ===== CacheGuard：缓存前缀守卫（Reasonix "hash + pinned" 的代码级落实）=====
// 实际发送的 tools 段（loopToolDefs，已按工具名确定性排序）是跨对话共享缓存前缀
// 的最大稳定段。其字节漂移（MCP 连接抖动、browser 快照失效、注册顺序、schema 序列化
// 变化）会整段作废所有对话的前缀缓存（system+tools ≈ 6 万 tokens 全价重算）。
// 每任务发送前对真实字节算 hash 并与上次比较：漂移 → 告警输出新旧指纹供定位；
// 稳定 → 静默。零误报：tools 段除漂移外不存在合法字节变化。
//
// 跨重启落盘（2026-08-29）：tools 指纹 + 工具级指纹持久化到 .logs/cacheguard-state.json，
// 进程重启 / 应用重新构建后首次发送时与上次基准对比——发版导致的工具定义变化（正常、
// 低命中可预期）与同进程内 MCP 抖动（异常）区分记录，并精确定位到具体变化工具。
let guardPrevToolsHash: string | null = null;
let guardToolsMutationCount = 0;
/** 上一轮工具级指纹：工具名 → 该工具定义的内容 hash（漂移时精确定位到具体工具） */
let guardPrevToolFingerprint = new Map<string, string>();

/** 持久化状态文件路径（与 cacheguard.jsonl 同目录；dev/正式版经 BOBWORK_HOME 天然隔离） */
const CACHEGUARD_STATE_FILE = join(resolveAppRoot(), '.logs', 'cacheguard-state.json');
/** 跨重启基准是否已从磁盘加载 */
let guardPersistedLoaded = false;
/** 上次进程/构建持久化的 tools 段 hash（跨重启基准） */
let guardPersistedPrevHash: string | null = null;
/** 上次进程/构建持久化的工具级指纹（跨重启漂移定位） */
let guardPersistedPrevFingerprint = new Map<string, string>();

/** 懒加载持久化基准：进程启动后首次发送前读盘，损坏/缺失按无基准静默处理 */
function loadPersistedCacheGuard(): void {
  try {
    if (!existsSync(CACHEGUARD_STATE_FILE)) return;
    const raw = readFileSync(CACHEGUARD_STATE_FILE, 'utf-8');
    const data = JSON.parse(raw) as {
      prevToolsHash?: unknown;
      prevToolFingerprint?: Record<string, string>;
      mutationCount?: unknown;
    };
    if (typeof data.prevToolsHash === 'string' && data.prevToolsHash) {
      guardPersistedPrevHash = data.prevToolsHash;
      guardPersistedPrevFingerprint = new Map(
        Object.entries(data.prevToolFingerprint ?? {}).filter(
          (kv): kv is [string, string] => typeof kv[1] === 'string',
        ),
      );
      if (typeof data.mutationCount === 'number') guardToolsMutationCount = data.mutationCount;
    }
  } catch {
    // 状态文件损坏/不可读 → 视为无基准，本次调用会重建
  }
}

/** 持久化当前基准（仅在内容变化时调用：进程首个任务建基准 / 漂移后更新，稳定轮次零 IO） */
function persistCacheGuardState(hash: string, perTool: Map<string, string>): void {
  try {
    mkdirSync(dirname(CACHEGUARD_STATE_FILE), { recursive: true });
    writeFileSync(
      CACHEGUARD_STATE_FILE,
      JSON.stringify({
        prevToolsHash: hash,
        prevToolFingerprint: Object.fromEntries(perTool),
        mutationCount: guardToolsMutationCount,
        lastAt: new Date().toISOString(),
      }),
      'utf-8',
    );
  } catch {
    // 落盘失败绝不影响工具循环主链路
  }
}

/** 对比两代工具级指纹，列出新增/变化/消失的工具（供漂移定位） */
function diffToolFingerprints(prev: Map<string, string>, cur: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [name, h] of cur) {
    const old = prev.get(name);
    if (old === undefined) changed.push(`${name}:NEW(${h})`);
    else if (old !== h) changed.push(`${name}:${old}→${h}`);
  }
  for (const [name] of prev) {
    if (!cur.has(name)) changed.push(`${name}:REMOVED`);
  }
  return changed;
}

/** 判定工具是否属于「设计内动态场景激活」：ondemand 内置工具或 MCP 工具。
 *  2026-08-30 起普通对话改为「核心常驻 + 动态场景（sticky）」，ondemand/MCP 工具
 *  按意图激活/不激活导致工具集增减属预期行为——CacheGuard 应豁免此类变化，
 *  只对 core 内置 / 自定义工具的异常漂移告警，避免每会话首次激活刷屏误导诊断。
 *  2026-09-09 语义随 getToolLayer 修复扩展：SCENED_TOOLS 场景门控内置工具（butler/
 *  butler/todo 系）也归 ondemand → 一并豁免（此前默认 core 被误判异常漂移）。
 *  导出供单测回归锁定豁免边界。 */
export function isDynamicSceneTool(name: string): boolean {
  return getToolSource(name) === 'mcp' || getToolLayer(name) === 'ondemand';
}

/** 工具集变化是否全部来自动态场景激活（是 → 豁免告警；否 → 存在异常漂移） */
export function isAllDynamicSceneChange(changed: string[]): boolean {
  return changed.length > 0 && changed.every((c) => isDynamicSceneTool(c.split(':')[0]));
}

/** 漂移事件落盘（离线复盘）：追加写入 .logs/cacheguard.jsonl 供事后审计 */
function appendCacheGuardEvent(ev: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(CACHEGUARD_STATE_FILE), { recursive: true });
    appendFileSync(
      join(dirname(CACHEGUARD_STATE_FILE), 'cacheguard.jsonl'),
      JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n',
      'utf-8',
    );
  } catch {
    // 日志失败绝不影响工具循环主链路
  }
}

function guardToolsPrefix(tools: unknown[]): string {
  // 懒加载跨重启基准（进程启动后首次发送时读盘一次）
  if (!guardPersistedLoaded) {
    guardPersistedLoaded = true;
    loadPersistedCacheGuard();
  }
  // 工具级指纹：按工具名稳定排序后，为每个工具定义单独计算 hash（用于漂移定位）
  const ordered = (tools as { function?: { name?: string } }[])
    .map((t) => ({ name: t?.function?.name ?? '?', def: t }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const perTool = new Map<string, string>();
  for (const { name, def } of ordered) {
    perTool.set(name, createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 8));
  }
  const hash = createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 12);
  const totalBytes = Buffer.byteLength(JSON.stringify(tools));
  // 每次发送前记录 hash 指纹（诊断漂移：稳定时也应能观察到 hash 是否恒定）
  console.log(
    `[CacheGuard] tools hash=${hash} n=${ordered.length} bytes=${totalBytes} at=${new Date().toISOString()}`,
  );

  // ① 跨重启/跨构建漂移：仅进程首个任务（guardPrevToolsHash 为空）与上次持久化基准对比。
  //    发版导致工具定义变化属正常，本次任务低命中可预期；记录变化工具供确认
  //    是无害改动还是意外回归。
  if (guardPrevToolsHash === null && guardPersistedPrevHash !== null && guardPersistedPrevHash !== hash) {
    const changed = diffToolFingerprints(guardPersistedPrevFingerprint, perTool);
    // 动态场景豁免：仅 ondemand/MCP 工具增减（上次基准可能含已激活场景，本次首任务未激活）→ 预期，不告警
    if (isAllDynamicSceneChange(changed)) {
      console.log(`[CacheGuard] 跨重启动态场景变化（预期，非漂移）：${changed.join(', ')}`);
    } else {
      guardToolsMutationCount++;
      console.warn(
        `[CacheGuard] 跨重启/构建 tools 段漂移（第 ${guardToolsMutationCount} 次）：${guardPersistedPrevHash} → ${hash}。` +
          `变化工具: ${changed.join(', ') || '（工具级指纹未变，疑似顺序/嵌套结构变化）'}。` +
          `本次任务前缀缓存已失效（低命中率可预期），新基准已建立。`,
      );
      appendCacheGuardEvent({
        kind: 'cross-restart-drift',
        mutationCount: guardToolsMutationCount,
        from: guardPersistedPrevHash,
        to: hash,
        toolCount: ordered.length,
        bytes: totalBytes,
        changed,
      });
    }
  }

  // ② 进程内漂移：同一进程内工具段字节漂移（MCP 连接抖动 / browser 快照 / schema 序列化等异常）
  if (guardPrevToolsHash !== null && guardPrevToolsHash !== hash) {
    const changed = diffToolFingerprints(guardPrevToolFingerprint, perTool);
    // 动态场景豁免：普通对话按意图激活/未激活 ondemand/MCP 工具 → 预期，不告警
    if (isAllDynamicSceneChange(changed)) {
      console.log(`[CacheGuard] 动态场景工具集变化（预期，非漂移）：${changed.join(', ')}`);
    } else {
      guardToolsMutationCount++;
      console.warn(
        `[CacheGuard] tools 段前缀漂移（第 ${guardToolsMutationCount} 次）：${guardPrevToolsHash} → ${hash}。` +
          `变化工具: ${changed.join(', ') || '（工具级指纹未变，疑似顺序/嵌套结构变化）'}。` +
          `请检查 MCP 连接抖动 / browser 快照 / 注册顺序 / schema 序列化。`,
      );
      appendCacheGuardEvent({
        kind: 'tools-prefix-drift',
        mutationCount: guardToolsMutationCount,
        from: guardPrevToolsHash,
        to: hash,
        toolCount: ordered.length,
        bytes: totalBytes,
        changed,
      });
    }
  }

  guardPrevToolsHash = hash;
  guardPrevToolFingerprint = perTool;
  // 基准变化才落盘（进程首个任务建基准 / 漂移后更新），稳定轮次零 IO
  if (guardPersistedPrevHash !== hash) {
    persistCacheGuardState(hash, perTool);
    guardPersistedPrevHash = hash;
    guardPersistedPrevFingerprint = perTool;
  }
  return hash;
}

/** 工具定义排序（缓存前缀稳定化 P4 + 来源分组）：
 *  按「工具来源 + 内置分层」分段——core 内置（静态，发版才变）最前、ondemand 内置随后、
 *  自定义居中、MCP（连接状态/schema 变化最频繁）最后；MCP 段内按「settings 配置顺序的 serverId」
 *  分组（同一 server 的工具连续成块，组内按工具名排序），避免任一 server 变化整段作废 MCP 段缓存。
 *  提取为模块级函数：search_capabilities 中途激活场景后需重建 loopToolDefs，与此处共用同一确定性排序。 */
function buildAndSortToolDefs(defs: ToolDefinition[], mcpServers: McpServerConfig[]): ToolDefinition[] {
  const mcpServerOrder = new Map<string, number>();
  (mcpServers || []).forEach((s, i) => {
    if (!mcpServerOrder.has(s.id)) mcpServerOrder.set(s.id, i);
  });
  const toolSourceRank = (name: string): number => {
    const src = getToolSource(name);
    // builtin 段内再按 layer 分层：core（常驻，字节稳定）最前，ondemand（按场景动态）随后。
    // 前缀缓存语义：core 段永远稳定；ondemand 段只在场景首次激活时变化（sticky 后不再变），
    // 变化点之后的字节该轮 miss，但 core 段 + 已激活的 ondemand 段仍命中 —— 最大化缓存复用。
    if (src === 'builtin') return getToolLayer(name) === 'core' ? 0 : 1;
    return src === 'custom' ? 2 : 3;
  };
  // MCP server 稳定序：settings 数组下标在前（已配置、新 server 追加尾部），未配置的按 id 兜底在后
  const mcpBucketKey = (name: string): string => {
    const srv = name.split('__')[1] ?? '';
    const idx = mcpServerOrder.get(srv);
    return idx !== undefined ? `0:${String(idx).padStart(6, '0')}` : `1:${srv}`;
  };
  const sorted = [...defs].sort((a, b) => {
    const na = (a as { function?: { name?: string } })?.function?.name ?? '';
    const nb = (b as { function?: { name?: string } })?.function?.name ?? '';
    const ra = toolSourceRank(na);
    const rb = toolSourceRank(nb);
    if (ra !== rb) return ra - rb;
    if (ra === 2) {
      const ka = mcpBucketKey(na);
      const kb = mcpBucketKey(nb);
      if (ka !== kb) return ka < kb ? -1 : 1;
    }
    return na.localeCompare(nb);
  });
  // CacheGuard：发送前对真实 tools 字节做稳定性守卫（漂移即告警，见函数注释）
  guardToolsPrefix(sorted);
  return sorted;
}

/** ToolRuntime 构造入参：请求级只读快照（语义与迁移前 route 内胶水一致） */
export interface ToolRuntimeOptions {
  /** settings 快照（readSettingsFromFile 结果；每请求读取一次，与迁移前语义一致） */
  settings: AppSettings;
  /** 请求解析出的 Agent 画像（resolveAgentProfile 结果） */
  profile: AgentProfile;
  /** 无确认回传链路（sandbox:true 编排链路）：过滤写类工具（SANDBOX_BLOCKED_TOOLS） */
  sandbox: boolean;
  /** 节点"强制使用"MCP（复选框）：仅对 Store 中全局 enabled 的 server 生效；缺省/空 = 跟随全局 */
  enabledMcpIds?: string[];
}

/**
 * 工具面 runtime service（K2-S1 抽取，行为不变）：每请求 new。
 * 生命周期：注册（register）→ 组装（assemble，可多轮重建调用）。
 * 方法与迁移前语义逐一对齐：
 *  - register()        == route 原位 registerCustomTools + mcpManager.syncServers + registerMcpTools（快照/排除）
 *  - assemble(scenes)  == route 原位 computeActiveToolDefs() → buildAndSortToolDefs()（含 CacheGuard 守卫）
 */
export class ToolRuntime {
  private readonly settings: AppSettings;
  private readonly profile: AgentProfile;
  private readonly sandbox: boolean;
  /** 节点"强制使用"MCP 解析结果：仅对全局 enabled 的 server 生效，语义=无视场景/画像过滤保留 */
  private readonly mcpForceIds: Set<string>;

  constructor(opts: ToolRuntimeOptions) {
    this.settings = opts.settings;
    this.profile = opts.profile;
    this.sandbox = opts.sandbox;
    // 节点"强制勾选"MCP（复选框）：仅对 Store 中全局 enabled 的 server 生效，语义=无视场景/画像过滤保留。
    // 再与 NODE_MCP_TOOL_IDS 交叉校验：节点下拉只列 MCP 类服务，Plugins 类（Teams/Notes/Preview/Browser/Bobby）
    // 不在其中——勾选不得成为绕过场景门控的旁路（如 team 会绕开「Multi-agent mode」开关直接拉起多智能体）。
    this.mcpForceIds = Array.isArray(opts.enabledMcpIds) && opts.enabledMcpIds.length > 0
      ? new Set(
          (this.settings.mcpServers || [])
            .filter((s) => s.enabled !== false && NODE_MCP_TOOL_IDS.has(s.id) && opts.enabledMcpIds!.includes(s.id))
            .map((s) => s.id),
        )
      : new Set<string>();
  }

  /** 注册自定义工具（每次请求都刷新，确保与 settings 同步）+ 同步并注册 MCP 工具（快照/排除）。
   *  与迁移前 route 原位一致：注册顺序、排除集合计算、失败日志均未改动。 */
  async register(): Promise<void> {
    registerCustomTools(this.settings.customTools || []);

    // AI 浏览器通道（全局互斥开关，settings.aiBrowser）：
    //   'chrome' → 注销内置组，浏览器能力只走 mcp__bob-browser-mcp__browser_*；
    //   否则     → 注册内置 browser_*（HippoDriver），并在下方把 bob-browser-mcp 整个排除。
    // 缺省（undefined）= 'hippo'（默认通道）：Hippo 为默认，仅显式关开关才回退 Bob Browser。
    // 二者互斥：任一时刻只有一组浏览器工具进模型上下文。
    const hippoChannel = this.settings.aiBrowser !== 'chrome';
    setBuiltinBrowserToolsEnabled(hippoChannel);

    // 专属服务不注入普通 chat 节点：exposeToChatNodes === false 的 MCP 仅限专属节点经专用路由调用
    const excludedMcpIds = new Set(
      (this.settings.mcpServers || [])
        .filter((s) => s.exposeToChatNodes === false)
        .map((s) => s.id),
    );
    // AI Browser 开关打开时，Bob Browser 通道对模型不可见（含快照缓存里的 browser.* 一并跳过）
    if (hippoChannel) excludedMcpIds.add('bob-browser-mcp');
    // 工具级排除：excludeToolsFromModel 中的工具不注入模型上下文（如授权管理类，防自我授权）
    const excludedMcpToolNames = new Set(
      (this.settings.mcpServers || []).flatMap((s) => s.excludeToolsFromModel ?? []),
    );
    // 仍应在线（enabled）且对 chat 可见的 server：MCP 工具快照兜底的「白名单」——
    // 不在名单里的 server 一律清空快照并跳过回退，保证用户禁用/删除服务立刻生效
    // （2026-10-02：快照兜底由「仅 browser」推广到全部 server 后新增的护栏）。
    const expectedMcpIds = new Set(
      (this.settings.mcpServers || [])
        .filter((s) => s.enabled !== false && !excludedMcpIds.has(s.id))
        .map((s) => s.id),
    );

    // 同步 MCP 服务器配置并注册 MCP 工具（始终跟随全局 enabled，不再做节点级启停覆盖）：
    // 与 skill 对齐——Store 中 enabled 的 MCP 自动注入候选，节点复选框不再决定"是否可用"。
    const { mcpManager } = await import('@/lib/mcp/manager');
    await mcpManager.syncServers(this.settings.mcpServers || []);
    await registerMcpTools({
      excludeServerIds: excludedMcpIds,
      excludeToolNames: excludedMcpToolNames,
      expectedServerIds: expectedMcpIds,
    }).catch((e) => console.error('[MCP] 工具注册失败:', e));
  }

  /** 按当前 activeScenes 计算最终工具定义并做确定性排序 + CacheGuard 守卫。
   *  供两处使用：① 请求首轮初始化；② 场景中途激活（search_capabilities / load_skill 法律技能）后重建，
   *  否则 needRebuildTools 只重排序旧 toolDefs，新激活场景的工具（如 pkulaw）永远不会注入。
   *  返回 { toolDefs, loopToolDefs }：toolDefs 为过滤/合并后的全集（供 MCP 工具计数等），
   *  loopToolDefs 为实际发送 tools 段（已确定性排序 + CacheGuard 守卫）。 */
  assemble(activeScenes: Set<ToolScene>): { toolDefs: ToolDefinition[]; loopToolDefs: ToolDefinition[] } {
    const toolDefs = this.computeActiveToolDefs(activeScenes);
    const loopToolDefs = buildAndSortToolDefs(toolDefs, this.settings.mcpServers || []);
    return { toolDefs, loopToolDefs };
  }

  /** 场景/画像两层过滤组装（computeActiveToolDefs，逻辑原样随迁 route.ts）：
   *  L1 静态（节点类型：coding/butler/node）+ L2 动态（对话意图）场景已由调用方合并进 activeScenes；
   *  此处按 activeScenes / profile 画像（scenes=fixed 用固定场景子集、coreExclusions 剔除）过滤，
   *  再兜底校验工具名（OpenAI API ^[a-zA-Z0-9_-]+$），最后并入节点"强制使用"MCP（mergeForcedMcpToolDefs）。 */
  private computeActiveToolDefs(activeScenes: Set<ToolScene>): ToolDefinition[] {
    const base = this.sandbox
      ? getToolDefinitions(activeScenes).filter((t) => !SANDBOX_BLOCKED_TOOLS.has((t as { name?: string }).name as string))
      : this.profile.scenes === 'fixed'
        ? getToolDefinitions(new Set<ToolScene>(this.profile.fixedScenes))
        : getToolDefinitions(activeScenes);
    // 兜底校验：工具名必须匹配 ^[a-zA-Z0-9_-]+$（OpenAI API 要求）。
    // MCP 工具名/自定义工具名可能在动态注册时产生非法字符，这里过滤掉避免 400。
    const valid = base.filter((t) => {
      const name = (t as { function?: { name?: string }; name?: string })?.function?.name ?? (t as { name?: string })?.name ?? '';
      const ok = typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name);
      if (!ok) console.warn(`[chat] 过滤非法工具名: ${JSON.stringify(name)}`);
      return ok;
    });
    // 常驻内核按画像剔除（profile.coreExclusions）：无场景标注的内核工具（文件/命令/网页等）
    // 默认对所有 agent 可见，场景门控管不到——专职画像在此按工具名剔除（如 Kar 不背文件/联网）。
    const excluded = this.profile.coreExclusions?.length ? new Set(this.profile.coreExclusions) : null;
    const trimmed = excluded
      ? valid.filter((t) => {
          const n = (t as { function?: { name?: string }; name?: string })?.function?.name ?? (t as { name?: string })?.name ?? '';
          return !excluded.has(n);
        })
      : valid;
    // 节点"强制使用"MCP：无视场景/画像过滤，把勾选的 MCP server 工具恒定并入本轮
    return this.mcpForceIds.size > 0 ? mergeForcedMcpToolDefs(trimmed, Array.from(this.mcpForceIds)) : trimmed;
  }
}
