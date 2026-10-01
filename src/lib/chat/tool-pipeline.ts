/**
 * P4a 三段化骨架 —— 工具轮宿主接管（takeover）注册表与场景激活统一执行。
 *
 * 背景：对话内核（src/app/api/chat/route.ts）的工具轮里，宿主对若干工具以 if-else 特判
 * "接管"执行（search_capabilities / load_skill 法律联动 / ask_user_questions / butler 卡片 /
 * confirm 名单 / login / 参数注入 / 结果压缩 …），其中两个"场景激活类"接管各自重复了
 * 「判定命中场景 → 会话内 sticky → 触发工具集重建」的同构代码。本文件把这类接管收敛为
 * 「注册（registerTakeover）→ 按名 + 时机匹配（takeoverFor）→ 场景激活语义统一执行
 * （applyScenarioActivation）」的注册式编排，是 DSH pre/post-execute 收敛的宿主侧第一步。
 *
 * 首批迁移（行为逐位不变）：
 *   - search_capabilities：pre-execute 全接管（在工具执行前咨询，命中即替代通用 executeTool）。
 *     能力目录检索命中 → 激活场景 + sticky → 触发重建；宿主依据 meta 携带的匹配条目生成
 *     能力清单文本，SSE 帧 / CORE_EVENT 记录仍在宿主侧（route 样板，本轮不收）。
 *   - load_skill 法律联动：post-execute 联动（工具执行成功后才咨询）。加载法律技能成功 →
 *     激活 legal + sticky → 触发重建 → 首激活时把激活提示追加到工具结果尾部。
 * 两个接管的差异收敛为数据：{ scenes: 本轮要激活的场景, sticky?, hint?, meta? }。
 *
 * P4a-2a 追加（行为逐位不变）：
 *   - args_transform：exec 前「参数注入」类 —— 文件/沙箱类工具名单在工具执行前自动注入
 *     current_node_id / node_sandbox_app_id。名单判定与注入规则在注册 handler 内，
 *     请求作用域值（nodeId / sandboxAppId）由宿主在咨询点经 ctx（ArgsTransformContext）传入。
 *   - result_compact：exec 后「结果压缩」类通用变换 —— 超长工具结果保头保尾压缩后再入模型
 *     上下文。阈值/保头保尾/提示文案由注册侧 handler 持有（compactToolResult），
 *     SSE tool_compact 帧与压缩日志仍由宿主按 compacted 标志发送（pipeline 不产 SSE）。
 * 两类均非"场景激活"，咨询点独立（takeoverOfKind 按 kind 精确过滤），不参与 applyScenarioActivation。
 *
 * P4a-3-1 追加（行为逐位不变）：
 *   - ask_user：挂起型（host-pending）首类 —— ask_user_questions 结构化提问弹窗挂起。与前三类
 *     模块级纯函数不同，挂起型需要 send(SSE) / pending 容器 / 心跳 / 回灌 / 循环 continue：
 *     handler 经 ctx（HostTakeoverContext，宿主在 handle() 调用点注入最小服务面）完成全部副作用，
 *     本文件只做注册/查询、不产 SSE。
 *
 * P4a-3-2 追加（行为逐位不变）：
 *   - tool_confirm：挂起型第二类 —— 需手动确认名单（confirmTools，运行期配置）工具执行前弹通用
 *     确认弹窗挂起。与 ask_user 的差异：判定名单不绑定固定工具名（注册条目 match 恒 true、工具名
 *     恒咨询，名单随 ctx.confirmTools 注入，handler 内判 noop）；verdict 三分 —— 'handled_continue'
 *     （denied/timeout：宿主 continue 跳过通用执行）/ 'handled_fallback'（approved：回落本轮通用
 *     执行，args 原样）/ 'noop'（名单外 或 butler 结构化卡片已覆盖）。consult 点物理位置必须
 *     保持在 butler 卡片段之后（顺序约束：butler 先判），由宿主保证。
 * P4a-3-4：login（browser.login 挂起型接管，含 exec 前 mode 注入与 exec 后 loginRequired 判定 /
 *   login_fill 代填）与 grant（bobby grantRequired → SSE grant_required 旁路）复用同一 host-pending
 *   形态（各自注册新 kind，见文件尾「P4a-3 挂起型接管注册表」）。
 *
 * 设计约束：
 *   - 纯类型 + 编排，不 import route 具体实现；ToolScene 取自 tools.ts（领域类型）。
 *   - 宿主在工具轮内注入最小服务面 TakeoverServices（闭包持有 route 局部状态），
 *     场景激活的副作用（activeScenes.add / sticky / needRebuildTools）全部经此完成。
 *   - takeoverFor 按 phase（pre/post 咨询时机）过滤、priority 降序返回首个命中 handler，
 *     由宿主事后判 kind；同 priority 保持注册顺序 —— "注册顺序即判定顺序"。
 *   - takeoverOfKind 把 kind 前置过滤：供 args_transform / result_compact 独立咨询点使用，
 *     避免与 pre/post 场景激活咨询（search_capabilities / load_skill）跨 kind 串扰。
 *   - K3-1（契约显式化，行为零变化）：route 工具轮（r16）内 9 个咨询点的物理硬顺序固化为
 *     TOOL_CONSULT_SEQUENCE（接口面盘点 §1.2「咨询点顺序（硬性，跨 kind）」的显式化，
 *     见下「K3-1 咨询链顺序契约」段）；route 咨询点旁仅加「K3 hook … (consult seq #N)」
 *     注释编号、不加运行时检查，顺序防护由 tool-pipeline.test.ts 单测承担。
 */
import type { ToolScene } from '@/app/api/chat/tools';
// P4b-1 审批策略层：type-only import（approval.ts 为纯函数模块、不 import tool-pipeline → 无循环）
import type { ApprovalStrategy } from './approval';

/**
 * 接管类型：
 *   - scenario_activate：场景激活类（search_capabilities / load_skill 法律联动，P4a-1）；
 *   - args_transform：exec 前「参数注入」类 —— 节点作用域参数注入文件/沙箱工具（P4a-2a）；
 *   - result_compact：exec 后「结果压缩」类通用变换 —— 超长工具结果保头保尾压缩（P4a-2a）；
 *   - ask_user：挂起型（host-pending）接管首类 —— ask_user_questions 结构化提问（P4a-3-1，
 *     见文件尾「P4a-3 挂起型接管注册表」）；
 *   - tool_confirm：挂起型 —— 需手动确认名单（confirmTools）工具执行前弹通用确认（P4a-3-2，
 *     判定名单为运行期配置 → 注册条目 match 恒 true、工具名恒咨询，名单经 ctx 注入后判 noop）；
 *   - butler_confirm：挂起型 —— butler 专属节点的排程 创建/改/删（identity==='butler' 且属
 *     BUTLER_CARD_TOOLS）弹结构化可编辑确认卡片（P4a-3-3，注册条目 match 恒 true、身份+名单在
 *     handler 内判 noop）；approved 且用户编辑过卡片 → 经 ctx.setExecArgs 覆盖执行参数后
 *     'handled_fallback' 回落宿主通用执行（新参数生效）。
 *   - login：挂起型（P4a-3-4，phase post）—— browser.login 工具执行返回 loginRequired →
 *     登记挂起 + SSE login_required → 前端登录窗回传凭据（POST /api/chat/login）→ 宿主直调
 *     browser.login_fill（redactArgs 脱敏）代填 → 经 ctx.setExecResult 覆盖 execResult 后
 *     'handled_fallback' 回落宿主通用落账路径（loginRequired 未命中 → 'noop'）。配套：exec 前
 *     mode='bobwork' 注入以 args_transform 形态注册（见 route 注册侧）。
 *   - grant：挂起型旁路（P4a-3-4，phase post）—— mcp__bobby__* 工具返回 grantRequired →
 *     SSE grant_required（带 target）旁路下发；不覆盖 execResult、不改变流控，命中
 *     'handled_fallback' / 未命中 'noop' 均回落宿主通用路径（原 if 分支 send 后无 continue）。
 */
export type ToolTakeoverKind =
  | 'scenario_activate'
  | 'args_transform'
  | 'result_compact'
  | 'ask_user'
  | 'tool_confirm'
  | 'butler_confirm'
  | 'login'
  | 'grant';

/** 接管咨询时机：pre = 工具执行前（可替代执行，如 search_capabilities）；post = 工具执行成功后联动（如 load_skill） */
export type ToolTakeoverPhase = 'pre' | 'post';

// ─────────────────────────────────────────────────────────────────────────────
// K3-1 咨询链顺序契约 —— hook 边界显式化（行为零变化：仅枚举 + 单测断言 + route 注释编号）。
// route.ts 工具轮（接口面盘点 §1.2 的 r16「每 tool 子流程」）内 9 个接管咨询点有物理硬顺序
// （§1.2「咨询点顺序（硬性，跨 kind）」）：
//   ask_user(pre) → search_capabilities(pre 全接管) → butler_confirm(pre) →
//   tool_confirm(pre) → [tool_call_update running] → args_transform(pre) →
//   [keepalive/bobby/team] → executeTool → grant(post) → login(post) →
//   load_skill(post 联动) → tool_result → result_compact(post)；butler 卡覆盖后跳过 tool_confirm。
// 本段把该顺序固化为可枚举常量 TOOL_CONSULT_SEQUENCE：新增/移动咨询点必须同步
//   ① 本序列（含 consultPoint 稳定名）② route.ts 咨询点旁「K3 hook … (consult seq #N)」
//   注释编号 ③ tool-pipeline.test.ts 顺序断言 —— 顺序防护由单测承担，route 不加运行时开销。
// 条目口径 = 物理咨询点（非注册条目数）：search_capabilities 与 load_skill 同 kind
// （scenario_activate）但 phase / 物理咨询点不同，分别列出（序列 #2 / #8）；args_transform
// 的两条注册条目（节点参数注入 + browser.login mode 注入）共享同一咨询点，合并为一项（#5）。
// consultPoint 取值 = 咨询点相对工具轮里程碑的物理位置稳定名：
//   before_execute_running = tool_call(pending) 帧后、running 心跳帧前（挂起/全接管 pre 段）；
//   before_execute         = running 心跳帧后、executeTool 前（参数注入）；
//   after_execute          = executeTool 成功后（post 段挂起/联动）；
//   after_tool_result      = tool_result 帧后、结果写入对话历史前（结果压缩）。
// ─────────────────────────────────────────────────────────────────────────────

/** K3-1：工具轮咨询阶段定义 —— TOOL_CONSULT_SEQUENCE 的条目形态（顺序契约声明） */
export interface ConsultStageDef {
  /** 咨询的接管 kind（与注册条目 kind 对齐；查询口径 = 注册表按 kind(+phase) 的查询函数） */
  readonly kind: ToolTakeoverKind;
  /** 咨询时机（决定挂在工具轮 pre / post 哪个区段；与 consultPoint 前缀语义一致） */
  readonly phase: ToolTakeoverPhase;
  /** 咨询点物理位置稳定名（before_execute_running / before_execute / after_execute /
   *  after_tool_result 四值之一；映射 route.ts 对应咨询行，配套该处「K3 hook」注释编号） */
  readonly consultPoint: string;
  /** 备注：物理位置 / 注册条目对应关系 / 跳过条件（可空） */
  readonly note?: string;
}

/**
 * K3-1：工具轮 9 个咨询点物理顺序（§1.2 硬顺序的显式化）。数组序 = 物理硬顺序；
 * 1-based 序号即 route.ts 咨询点旁「consult seq #N」注释编号；两处 + 单测断言必须一致。
 */
export const TOOL_CONSULT_SEQUENCE = [
  {
    kind: 'ask_user',
    phase: 'pre',
    consultPoint: 'before_execute_running',
    note: '咨询链最顶端：tool_call(pending) 帧后、running 心跳帧前；ask_user_questions 结构化提问挂起（挂起型 pre 全接管）',
  },
  {
    kind: 'scenario_activate',
    phase: 'pre',
    consultPoint: 'before_execute_running',
    note: 'search_capabilities pre-execute 全接管（能力目录检索命中即替代 executeTool）——与 #8 load_skill 同 kind 不同 phase/咨询点，故分别列出',
  },
  {
    kind: 'butler_confirm',
    phase: 'pre',
    consultPoint: 'before_execute_running',
    note: 'butler 结构化可编辑确认卡（挂起型 pre；approved 回落通用执行）——物理位置在 tool_confirm 之前，butler 先判',
  },
  {
    kind: 'tool_confirm',
    phase: 'pre',
    consultPoint: 'before_execute_running',
    note: '需手动确认名单通用确认（挂起型 pre）——butler 卡覆盖（butler_confirm approved）后跳过本点',
  },
  {
    kind: 'args_transform',
    phase: 'pre',
    consultPoint: 'before_execute',
    note: 'running 心跳帧后、executeTool 前参数注入；两注册条目（节点参数注入 + browser.login mode 注入）同一咨询点合并为一项',
  },
  {
    kind: 'grant',
    phase: 'post',
    consultPoint: 'after_execute',
    note: 'executeTool 成功后 grantRequired → SSE grant_required 旁路（mcp__bobby__*，挂起型旁路）',
  },
  {
    kind: 'login',
    phase: 'post',
    consultPoint: 'after_execute',
    note: 'executeTool 成功后 loginRequired → 挂起 + login_fill 代填（browser.login，挂起型）',
  },
  {
    kind: 'scenario_activate',
    phase: 'post',
    consultPoint: 'after_execute',
    note: 'load_skill 法律联动 post-execute 场景激活（成功 → 激活 legal + sticky + 工具重建）——与 #2 search_capabilities 同 kind 不同 phase/咨询点',
  },
  {
    kind: 'result_compact',
    phase: 'post',
    consultPoint: 'after_tool_result',
    note: 'tool_result 帧后、结果写入对话历史前压缩（通用变换：全工具命中、仅超阈值才实际压缩）',
  },
] as const satisfies readonly ConsultStageDef[];

/**
 * K3-2：咨询链契约加载期自检（顺序防护的运行时化）。
 * 校验：① 9 个物理咨询点；② phase ∈ {pre,post} 且 consultPoint ∈ 四值词表，且
 * before_* ↔ pre / after_* ↔ post 前缀一致；③ (kind, phase) 组合唯一；
 * ④ 序列 kind 集合 = 全部可注册 kind，scenario_activate 恰出现 2 次。
 * 由 route.ts 模块顶层调用一次（进程/热更加载即断言，廉价线性），
 * 与 tool-pipeline.test.ts 的编译期/单测断言互为双保险——新增/错序咨询点在此立刻暴露。
 */
export function assertConsultContract(): void {
  const KINDS: readonly ToolTakeoverKind[] = [
    'scenario_activate', 'args_transform', 'result_compact',
    'ask_user', 'tool_confirm', 'butler_confirm', 'login', 'grant',
  ];
  const PHASES: readonly string[] = ['pre', 'post'];
  const POINTS: readonly string[] = [
    'before_execute_running', 'before_execute', 'after_execute', 'after_tool_result',
  ];
  const seq: readonly ConsultStageDef[] = TOOL_CONSULT_SEQUENCE;

  if (seq.length !== 9) {
    throw new Error(`[consult] TOOL_CONSULT_SEQUENCE 长度 ${seq.length} ≠ 9（咨询点物理顺序契约）`);
  }
  const seen = new Set<string>();
  const seenKind = new Set<ToolTakeoverKind>();
  for (const s of seq) {
    if (!KINDS.includes(s.kind)) throw new Error(`[consult] 未知 kind: ${s.kind}`);
    if (!PHASES.includes(s.phase)) throw new Error(`[consult] 非法 phase: ${s.phase}`);
    if (!POINTS.includes(s.consultPoint)) throw new Error(`[consult] 非法 consultPoint: ${s.consultPoint}`);
    const prefixPhase = s.consultPoint.startsWith('before_') ? 'pre' : 'post';
    if (s.phase !== prefixPhase) throw new Error(`[consult] consultPoint/phase 前缀不一致: ${s.consultPoint} vs ${s.phase}`);
    const key = `${s.kind}:${s.phase}`;
    if (seen.has(key)) throw new Error(`[consult] (kind,phase) 重复咨询点: ${key}`);
    seen.add(key);
    seenKind.add(s.kind);
  }
  for (const k of KINDS) {
    if (!seenKind.has(k)) throw new Error(`[consult] 注册 kind 未进咨询序列: ${k}`);
  }
  const scenarioCount = seq.filter((s) => s.kind === 'scenario_activate').length;
  if (scenarioCount !== 2) {
    throw new Error(`[consult] scenario_activate 应恰好 2 个咨询点（pre/post），实际 ${scenarioCount}`);
  }
}

/** 工具接管匹配上下文（预留：未来统一执行入口 takeToolOver(match, services) 的入参形态） */
export interface ToolTakeoverMatch {
  name: string;
  args: Record<string, unknown>;
}

/** 宿主注入的最小服务面（由 route 在工具轮内构造闭包，字段语义见各注释） */
export interface TakeoverServices {
  /** 当前已激活场景集合（route 的 activeScenes；pipeline 负责把新场景 add 进去） */
  readonly activeScenes: Set<ToolScene>;
  /** 会话内 sticky 持久化：由宿主决定是否跨请求保持（无 nodeId 的会话可为 no-op），
   *  首批两个接管的原语义均为「nodeId 存在时落 chatStickyScenes」。 */
  addStickyScene(scene: ToolScene): void;
  /** 存在新激活场景时触发工具集重建（宿主置 needRebuildTools=true → 下一轮请求携带新工具） */
  requestToolRebuild(): void;
}

/** scenario_activate 判定结果：本轮要激活的场景集合（激活副作用由 pipeline 统一执行） */
export interface ScenarioActivateDecision<M = unknown> {
  /** 本轮要激活的场景（可含已激活的；pipeline 内部去重计算 newlyActivated） */
  scenes: readonly ToolScene[];
  /** 是否做会话内 sticky；默认 true（首批两个接管原语义均为 sticky） */
  sticky?: boolean;
  /** 激活提示文本：仅当本轮确实新增激活了场景时由 applyScenarioActivation 返回（宿主决定追加位置） */
  hint?: string;
  /** 宿主附加数据（如 search_capabilities 的匹配条目），pipeline 原样透传，route 侧自行收窄 */
  meta?: M;
}

/** args_transform 请求作用域上下文：宿主在 exec 前 args 准备点把要注入的节点作用域值随咨询传入。
 *  handler 注册于模块级、不持有请求状态，值必须经 ctx 注入（与 applyScenarioActivation 依赖
 *  TakeoverServices 同构）；字段语义由注册侧 handler 自解释，pipeline 只透传。 */
export interface ArgsTransformContext {
  /** 当前节点 id（注入 current_node_id；无节点会话为 undefined —— JSON 序列化自动省略该键） */
  readonly currentNodeId: string | undefined;
  /** Coding 节点沙箱 appId（truthy 时注入 node_sandbox_app_id；非沙箱会话为 undefined 不注入） */
  readonly sandboxAppId: string | undefined;
  /** 当前 Agent 身份（注入按身份剔除的技能清单 __disallowed_skills，见 route.ts __skill_gate__）；
   *  省略该键 = 该调用点不做身份级能力过滤 */
  readonly agentId?: string;
}

/** result_compact 执行结果：压缩后的文本 + 是否实际发生压缩（宿主据此发 SSE tool_compact 帧与日志） */
export interface CompactResult {
  text: string;
  compacted: boolean;
}

/** 注册式接管条目（骨架：kind + phase + name + priority 决定匹配；各 kind 走各自 handler 字段产出数据） */
export interface ToolTakeover {
  readonly kind: ToolTakeoverKind;
  /** 咨询时机（决定在工具轮 pre/post 哪个咨询点被命中；场景激活咨询用 takeoverFor，
   *  args_transform / result_compact 独立咨询点用 takeoverOfKind 按 kind 精确过滤） */
  readonly phase: ToolTakeoverPhase;
  /** 被接管的工具名（同时作为注册去重键） */
  readonly name: string;
  /** 同名条目多个时的判定优先级：越大越先；相同则保持注册顺序（默认 0） */
  readonly priority?: number;
  /** 复杂匹配可覆写；缺省按 name 全等比较 */
  match?(name: string): boolean;
  /** scenario_activate 判定：返回本轮要激活的场景等数据；null = 本次不接管（如技能名不在法律名单） */
  handleScenario?(name: string, args: Record<string, unknown>): ScenarioActivateDecision | null;
  /** args_transform（P4a-2a）：exec 前「参数注入」——宿主在工具执行前 args 准备点咨询；
   *  命中返回注入后的参数字符串；null = 本次不接管（原样执行）。请求作用域值经 ctx 传入。
   *  与迁移前 if 内联同语义：JSON 解析/回写失败 → null（原样传递）。 */
  transformArgs?(name: string, args: string, ctx: ArgsTransformContext): string | null;
  /** result_compact（P4a-2a）：exec 后「结果压缩」——宿主在结果写入对话历史前咨询；
   *  命中返回 { 压缩后文本, 是否压缩 }；null = 不接管（原文入上下文）。
   *  阈值/保头保尾/提示文案由注册侧 handler 持有（route 的 compactToolResult）；
   *  SSE tool_compact 帧与压缩日志由宿主按 compacted 标志发送（pipeline 不产 SSE）。 */
  compactResult?(name: string, result: string): CompactResult | null;
}

/** 注册表（模块级私有）：去重键 = kind + name，重复注册以新替旧（dev 热更安全） */
const registeredTakeovers: ToolTakeover[] = [];

/** 注册一个接管条目；同 kind + 同 name 已存在时先移除旧条目再追加（保持注册序稳定） */
export function registerTakeover(handler: ToolTakeover): void {
  const idx = registeredTakeovers.findIndex(
    (h) => h.kind === handler.kind && h.name === handler.name,
  );
  if (idx >= 0) registeredTakeovers.splice(idx, 1);
  registeredTakeovers.push(handler);
}

function matchesTakeover(h: ToolTakeover, name: string): boolean {
  return h.match ? h.match(name) : h.name === name;
}

/** 按 name + phase 返回首个命中 handler（priority 降序；同 priority 保持注册顺序 = 判定顺序） */
export function takeoverFor(name: string, phase: ToolTakeoverPhase): ToolTakeover | null {
  const sorted = [...registeredTakeovers].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
  for (const h of sorted) {
    if (h.phase !== phase) continue;
    if (matchesTakeover(h, name)) return h;
  }
  return null;
}

/** 按 name + kind（+ 可选 phase）精确返回首个命中 handler（priority 降序；同 priority 保持注册序）。
 *  与 takeoverFor 的区别：takeoverFor 只按 name + phase 过滤、首个命中即返回，宿主须事后判 kind，
 *  跨 kind 的同名同 phase 条目会互相顶掉；本函数把 kind 前置过滤，供 args_transform / result_compact
 *  等独立咨询点使用，避免与 pre/post 场景激活咨询（search_capabilities / load_skill）串扰。 */
export function takeoverOfKind(
  name: string,
  kind: ToolTakeoverKind,
  phase?: ToolTakeoverPhase,
): ToolTakeover | null {
  const sorted = [...registeredTakeovers].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
  for (const h of sorted) {
    if (h.kind !== kind) continue;
    if (phase !== undefined && h.phase !== phase) continue;
    if (matchesTakeover(h, name)) return h;
  }
  return null;
}

/** applyScenarioActivation 的执行结果 */
export interface ScenarioActivationResult {
  /** 本轮新激活（此前不在 activeScenes）的场景，顺序与 decision.scenes 一致 */
  newlyActivated: ToolScene[];
  /** 是否有新激活（newlyActivated.length > 0，等价旧代码 justActivated 语义） */
  activated: boolean;
  /** 激活提示文本（decision.hint 且本轮确有新激活时非 null，否则 null） */
  hint: string | null;
}

/**
 * 统一执行一次 scenario_activate 接管：
 *   ① 把 decision.scenes 中尚未激活的场景加入 activeScenes（幂等，已激活的跳过）；
 *   ② sticky !== false 时逐场景 addStickyScene（宿主决定是否持久化）；
 *   ③ 存在新激活场景 → requestToolRebuild()（触发工具集重建注入新工具）。
 * 语义与迁移前的两个 if-else 接管逐位一致：激活场景集合 / sticky 时机与范围 /
 * needRebuildTools 触发条件（= 存在新增激活场景）均保持原样。
 */
export function applyScenarioActivation(
  decision: ScenarioActivateDecision,
  services: TakeoverServices,
): ScenarioActivationResult {
  const newlyActivated: ToolScene[] = [];
  for (const scene of decision.scenes) {
    if (!services.activeScenes.has(scene)) {
      services.activeScenes.add(scene);
      newlyActivated.push(scene);
    }
  }
  if (decision.sticky !== false) {
    for (const scene of decision.scenes) services.addStickyScene(scene);
  }
  const activated = newlyActivated.length > 0;
  if (activated) services.requestToolRebuild();
  return { newlyActivated, activated, hint: activated ? (decision.hint ?? null) : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// P4a-3 挂起型接管（host-pending）注册表 —— 独立于前三类纯函数接管。
// 与 scenario_activate / args_transform / result_compact（模块级纯函数、请求无关）不同，
// 挂起型接管需要 send(SSE) / pending 容器 / 心跳 / 回灌 / 循环控制：handler 允许携带宿主
// 服务 —— 由宿主在 handle() 调用点注入 ctx（HostTakeoverContext）完成全部副作用。handler
// 本身仍注册于模块级、不持 route 闭包（多请求并发安全）；本文件只做注册/查询与裁决类型
// 定义，不产 SSE。
// 本轮迁移 ask_user（ask_user_questions 结构化提问，P4a-3-1）与 tool_confirm（需手动确认名单
// 通用确认，P4a-3-2，注册条目 match 恒 true 恒咨询、名单经 ctx 注入判 noop）；P4a-3-3 迁移
// butler_confirm（butler 结构化可编辑确认卡片）；P4a-3-4 迁移 login（browser.login 挂起型接管）
// 与 grant（bobby grantRequired SSE 旁路）。均走同一形态、各自注册新 kind，同一 consult/dispatch 模式。
// ─────────────────────────────────────────────────────────────────────────────

/** 挂起型接管执行裁决：宿主（route 工具轮 consult 点）据此决定本工具调用的后续流控 */
export type HostTakeoverVerdict =
  /** 已由宿主完全接管处理 → 跳过通用执行路径（等价迁移前 if 分支的 continue） */
  | 'handled_continue'
  /** 宿主交互已完成、需回落到本轮通用执行路径（保留：确认类"通过后真正执行"等后续场景用） */
  | 'handled_fallback'
  /** 本次未接管（名单/参数不符）→ 照常走通用执行 */
  | 'noop';

/**
 * 挂起型接管上下文：宿主在 handle() 调用点注入的最小服务面（route 闭包构造，字段语义见各注释）。
 * SSE 载荷 / pending 容器登记 / 心跳 / 回灌文本均由 handler 经此完成（本文件不产 SSE）。
 */
export interface HostTakeoverContext {
  /** 被接管的工具名（= handler.name；SSE 心跳 / tool_result / eventLog 载荷复用） */
  readonly name: string;
  /** 本次调用已解析修复、去重检查通过的参数（handler 只读） */
  readonly args: Record<string, unknown>;
  /** 当前节点 id（SSE 顶层 nodeId 字段 + 挂起容器登记；无节点会话为 undefined） */
  readonly nodeId: string | undefined;
  /** SSE 下发（宿主 send 闭包：同步入事件日志 + enqueue；载荷含顶层 nodeId 由 handler 自行组织） */
  send(payload: Record<string, unknown>): void;
  /** P0 轨迹 spanId / 开始时间（挂起期 20s tool_call_update(running) 心跳 + tool_result 载荷复用） */
  readonly spanId: string;
  readonly startAt: number;
  /** 结果落账：按宿主原 if 分支同序写入 allToolCalls + 对话历史 + eventLog.TOOL_RESULT
   *  （round / taskId / tool_call_id / pageUrl 等请求态在宿主闭包内绑定；本类为 done 成功回灌） */
  commitToolResult(resultText: string): void;
  // ── 以下为确认类挂起型接管（tool_confirm，P4a-3-2 / butler_confirm，P4a-3-3）注入的请求
  //    作用域/可选能力（均选填，ask_user 等既有挂起型不读即不注入，向后兼容不破坏既有 kind API）──
  /** 宿主身份标识（route 会话 identity：'butler' / 普通 agent 等；确认类 handler 据此判定
   *  butler 结构化卡片覆盖 —— tool_confirm 对 butler 卡已覆盖的排程工具不重复弹通用确认） */
  readonly identity?: string;
  /** 当前生效的「需手动确认名单」（route 的 settingsForTools.confirmTools ?? DEFAULT_CONFIRM_TOOLS；
   *  名单为运行期配置、模块级 handler 无法持有 → 随咨询注入；名单外工具 handler 判 'noop'） */
  readonly confirmTools?: readonly string[];
  /** 当前生效的工具审批策略（P4b-1，route 读 settingsForTools.approval?.defaultStrategy ??
   *  'allow_scope' 在 tool_confirm 咨询点随 ctx 注入；handler 在名单判定后走 decideToolApproval：
   *  'request' → 原挂起确认；'allow' → noop 通用执行；'deny' → SSE tool_result(error) + 落账 +
   *  continue）。未注入（undefined）= 兜底按现网 allow_scope 语义（名单外一律放行）——
   *  向后兼容不破坏既有 kind API。butler 结构化卡覆盖判定仍在 handler 内先于本策略执行。 */
  readonly approvalStrategy?: ApprovalStrategy;
  /** 调用通道（route 请求体 channel 透传）。**非 undefined = 聚合链路**（微信桥 / ⌘F 面板 /chat 都经
   *  /api/core/node-chat 把上游 SSE 读到流结束才聚合成一句 JSON 返回，**确认回传永远到不了挂起项**）：
   *  确认类 handler 据此改为「回话说明 + 不执行」，不登记挂起（否则空等到 CONFIRM_TIMEOUT_MS 十分钟）；
   *  写类工具亦据此拒绝，避免默认 allow_scope 档下名单外写工具被静默执行（微信另按
   *  WECHAT_ALLOWED_WRITES 白名单放行排程三件套 + 便签，panel 保持只读）。
   *  缺省 undefined = 桌面流式通道（Butler 抽屉），确认卡链路完整，行为不变。 */
  readonly channel?: 'wechat' | 'feishu' | 'panel';
  /** exec 前原始参数字符串（tc.function.arguments；确认类挂起登记 createPendingConfirm 第二参，
   *  与 ctx.args 的已解析对象解耦；butler 卡编辑后亦可能已更新） */
  readonly execArgs?: string;
  /** 宿主侧可变执行参数写入通道（butler_confirm，P4a-3-3）：approved 且用户编辑过卡片时，
   *  handler 把编辑后的完整参数字符串（JSON，由 edited.toolArgs 序列化）经此交回宿主 —— 宿主
   *  须同步更新本轮实际执行将用的参数串与解析对象（route 闭包内 let parsedArgs/execArgs），随后
   *  handler 以 'handled_fallback' 回落通用执行时即用新参数。只读挂起型（ask_user / tool_confirm
   *  不回灌编辑参数）不注入即不读。 */
  readonly setExecArgs?: (raw: string) => void;
  /** 结果落账（error 变体）：按宿主原 if 分支同序写入 allToolCalls（success:false / phase:'error'，
   *  与 commitToolResult 不同：不含 pageUrl 字段）+ 对话历史 + eventLog.TOOL_RESULT。
   *  供确认类接管（tool_confirm / butler_confirm）的 denied/timeout 分支使用。 */
  readonly commitToolError?: (resultText: string) => void;
  // ── 以下为 post 挂起型接管（login，P4a-3-4 / grant，P4a-3-4）注入的字段（均选填，pre 挂起型
  //    不读即不注入，向后兼容不破坏既有 kind API）──
  /** 工具执行成功后的结果文本（executeTool 的 execResult.result；post 咨询点在 exec 成功后注入）。
   *  login 据此判定 loginRequired（JSON.loginRequired truthy）、grant 据此判定 grantRequired。 */
  readonly result?: string;
  /** 当前页面 URL（route 的 lastPageUrl 请求态，post 注入）：login_required 载荷 siteName/url 兜底
   *  （siteName: loginReq.siteName || toolDisplaySiteName(pageUrl)；url: loginReq.url || pageUrl || ''）。 */
  readonly pageUrl?: string;
  /** 宿主侧可变执行结果写回通道（login，P4a-3-4）：browser.login_fill 代填 / 失败 / 超时三分支构造的
   *  新 execResult 经此交回宿主 —— 宿主在 handle() 返回后覆盖本轮 execResult（let），随后照常落入
   *  通用落账路径（等价迁移前分支体对 execResult 的直接改写：result/durationMs/success 语义一致）。
   *  只读挂起型（ask_user / tool_confirm / butler_confirm）不注入即不读。 */
  readonly setExecResult?: (result: {
    result: string;
    durationMs: number;
    success: boolean;
    cardHtml?: string;
  }) => void;
}

/** 挂起型接管条目：kind + name 构成注册去重键；handle 产出执行裁决 */
export interface HostTakeover {
  readonly kind: ToolTakeoverKind;
  /** 咨询时机（挂起型均为工具轮内咨询点；ask_user 为 pre —— 工具执行前全接管） */
  readonly phase: ToolTakeoverPhase;
  /** 被接管的工具名（同时作为注册去重键的 name 侧） */
  readonly name: string;
  /** 同名条目多个时的判定优先级：越大越先；相同则保持注册顺序（默认 0） */
  readonly priority?: number;
  /** 复杂匹配可覆写；缺省按 name 全等比较 */
  match?(name: string): boolean;
  handle(ctx: HostTakeoverContext): HostTakeoverVerdict | Promise<HostTakeoverVerdict>;
}

/** 挂起型注册表（模块级私有）：去重键 = kind + name，重复注册以新替旧（dev 热更安全） */
const registeredHostTakeovers: HostTakeover[] = [];

/** 注册一个挂起型接管条目；同 kind + 同 name 已存在时先移除旧条目再追加（保持注册序稳定） */
export function registerHostTakeover(handler: HostTakeover): void {
  const idx = registeredHostTakeovers.findIndex(
    (h) => h.kind === handler.kind && h.name === handler.name,
  );
  if (idx >= 0) registeredHostTakeovers.splice(idx, 1);
  registeredHostTakeovers.push(handler);
}

/**
 * 按 name + kind（+ 可选 phase）返回首个命中挂起型 handler（priority 降序；同 priority 保持
 * 注册顺序）。kind 前置过滤：butler_confirm / tool_confirm / login / grant 各自注册独立 kind，
 * 同工具名跨 kind 条目互不顶替（consult 点按家族精确查询，不等同 takeoverFor 的"事后判 kind"）。
 */
export function hostTakeoverFor(
  name: string,
  kind: ToolTakeoverKind,
  phase?: ToolTakeoverPhase,
): HostTakeover | null {
  const sorted = [...registeredHostTakeovers].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
  for (const h of sorted) {
    if (h.kind !== kind) continue;
    if (phase !== undefined && h.phase !== phase) continue;
    if (matchesTakeover(h, name)) return h;
  }
  return null;
}
