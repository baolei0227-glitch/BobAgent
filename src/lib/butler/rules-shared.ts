/**
 * 规则的**纯常量与类型**（无任何 Node 依赖）。
 *
 * 与 `lib/core/preferences-shared.ts` 同因：规则面板 `components/butler/ButlerRulesPanel.tsx`
 * 是客户端组件，需要词表与派生逻辑做展示；而 `rules.ts` 含 fs 读写，客户端链路无法 bundle。
 * 故把纯数据 / 纯函数抽到这里，服务端（rules.ts 转出）与客户端共用同一份定义，避免两处漂移。
 *
 * 依据：BobWork 轻量化管家方案 v6 §3.1（规则结构：本体字段 + 从属数据）与 §3.4 / §4.2。
 */
import type { RecurrenceRule } from '@/lib/calendar/recurrence';

/**
 * 时间组触发条件。**结构与既有 `RecurrenceRule` 同构**（直接别名，零漂移）——
 * Phase 0 只存放不评估；Phase 2 定时候选直接复用 `occurrencesInWindow()`。
 */
export type RuleTimeTrigger = RecurrenceRule;

/** 类型：规则 or 流程（由 steps 构成派生；v6 §3.1「类型由本字段承载，不靠目录区分」） */
export type RuleKind = 'rule' | 'flow';

/** 状态机（v6 §3.1） */
export type RuleStatus = 'draft' | 'active' | 'paused' | 'retired';

/** 单步性质：确定性 or 判断 */
export type StepKind = 'deterministic' | 'judgment';

/** 承诺级别三值（v6 §3.1 映射表；对用户可见，见 8.5） */
export type Commitment = '必做到' | '基本做到' | '会启动并尽力';

/** 一个步骤：第一版是**步骤**不是代码，每步取值必须确定、必须标 kind */
export interface RuleStep {
  kind: StepKind;
  text: string;
  /**
   * 附属判断步。v6 §3.1 的 commitment 映射区分「deterministic 为主 + **附属** judgment」（基本做到）
   * 与「**主体**含 judgment」（会启动并尽力）；不显式标注则无法可解释地派生，故补此可选布尔。
   * 缺省 false = 主体步骤。
   */
  annex?: boolean;
  /**
   * 确定性步骤与**宿主执行器**的绑定（v6 §3.1「第一版为步骤，不是代码」的落地补丁，见 Phase 1 计划 D3）。
   * 仅 kind='deterministic' 时有意义。
   *   - `'create_todo'`：建一张待办（便签待办，Phase 1）
   *   - `'create_scheduled_todo'`：建一条日程待办（挂日历、有精确时刻，Phase 2）
   *   - `'skill'`：执行一条**已固化技能**（Phase 3 §3.6）——Skills 是 Rules 动作枚举的**动态扩展**，
   *     不是平行的第二执行路径：走同一执行器，因而自动获得 hits / producedRef / output_edited 归因。
   * 无此字段的确定性步 = 只描述、不自动执行（由模型照步骤做）。
   */
  action?: 'create_todo' | 'create_scheduled_todo' | 'skill';
  /**
   * action 的**确定参数**（固化时写死，§3.3「固化必须把模糊解析成确定值」）。
   * `when`：`'occurrence'`＝用触发该次的定时实例时刻（定时候选）；否则为固化时已解析的 ISO 时刻。
   * `skillId`：`action='skill'` 时绑定的技能 id（`sk-…`），交 skill-sandbox 在宿主侧执行（不经模型）。
   */
  actionParams?: { when?: 'occurrence' | string; skillId?: string };
}

/** 触发条件两组（任一满足即进候选），**不是 AND** */
export interface RuleTrigger {
  /** 语面组：触发词（宿主侧裁决用；Phase 0 只存不评） */
  keywords: string[];
  /** 场景组（可选） */
  scenes?: string[];
  /** 时间组：结构同 RecurrenceRule；Phase 0 只存不评 */
  time?: RuleTimeTrigger | null;
}

/** 一条规则（本体；frontmatter 存字段，正文存 intent_raw 与步骤） */
export interface RuleRecord {
  /** 规则唯一标识 `r-<YYYYMMDD>-<4hex>`，永不变 */
  id: string;
  /** 人类可读名称 */
  name: string;
  kind: RuleKind;
  /** 用户原话与意图（保留原话，不替用户转译） */
  intentRaw: string;
  trigger: RuleTrigger;
  steps: RuleStep[];
  /** 派生字段（由 steps 构成决定，服务端计算后落盘，面板只读） */
  commitment: Commitment;
  /** 生效范围：global / 指定项目（作用域只由本字段表达，不由存放路径表达） */
  scope: 'global' | 'project';
  /** scope 为 project 时必填；用于项目消失后的悬挂处理 */
  scopeTarget?: string;
  /** 冲突排序依据（系统生成、用户可覆写） */
  priority: number;
  status: RuleStatus;
  /** 修订版本号；同时是并发写的乐观锁（⑨） */
  version: number;
  createdAt: string;
  /** 最近一次触发的时间与场景（Phase 0 恒为空） */
  lastHit?: string;
}

/** 新建规则的输入（id / version / createdAt / commitment / kind 自动生成，不进表单） */
export interface CreateRuleInput {
  name: string;
  intentRaw: string;
  steps: RuleStep[];
  trigger?: Partial<RuleTrigger>;
  scope?: 'global' | 'project';
  scopeTarget?: string;
  /** 未传时由 steps 派生 */
  kind?: RuleKind;
  /** 未传时系统生成（默认 50） */
  priority?: number;
}

/**
 * commitment 派生（纯函数，v6 §3.1 映射表）：
 *   - 全 deterministic                     → 必做到
 *   - 有判断步，但**全部**为附属（annex）  → 基本做到
 *   - 含**主体**判断步                     → 会启动并尽力
 */
export function deriveCommitment(steps: RuleStep[]): Commitment {
  const hasJudgment = steps.some((s) => s.kind === 'judgment');
  if (!hasJudgment) return '必做到';
  const hasPrimaryJudgment = steps.some((s) => s.kind === 'judgment' && s.annex !== true);
  return hasPrimaryJudgment ? '会启动并尽力' : '基本做到';
}

/** kind 派生：含主体判断步 → 流程；否则 → 规则 */
export function deriveKind(steps: RuleStep[]): RuleKind {
  return deriveCommitment(steps) === '会启动并尽力' ? 'flow' : 'rule';
}

/** 系统生成的默认优先级（用户不填数字是常态，不是缺陷） */
export const DEFAULT_RULE_PRIORITY = 50;

/** 承诺级别英文显示名（存储值仍是中文三值，仅展示层映射，对齐记忆面板 TYPE_LABELS 的先例） */
export const COMMITMENT_LABELS: Record<Commitment, string> = {
  必做到: 'Guaranteed',
  基本做到: 'Mostly reliable',
  会启动并尽力: 'Best-effort',
};

/** 类型英文显示名 */
export const KIND_LABELS: Record<RuleKind, string> = {
  rule: 'Rule',
  flow: 'Flow',
};

/** 状态英文显示名 */
export const STATUS_LABELS: Record<RuleStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  paused: 'Paused',
  retired: 'Retired',
};

// ==================== 生命周期阈值与判据（v6 §3.2 / §3.4） ====================
// 放 shared 的原因：总览页要在客户端显示「样本不足 K，该机制未启用」这类文案，
// 判据必须与宿主同源，避免两处阈值漂移。

/** 修订判据窗口：最近 K=5 次命中（样本不足 K 不启用） */
export const REVISION_WINDOW = 5;
/** 修订判据阈值：窗口内 user_dismissed 比例 > 40% 时提议修订（严格大于） */
export const REVISION_THRESHOLD = 0.4;

/**
 * 修订判据（纯函数，v6 §3.1）：
 *   - active       样本量是否够（hitCount >= REVISION_WINDOW）
 *   - ratio        否定占比（hitCount 为 0 时为 0）
 *   - shouldPropose active 且 ratio > REVISION_THRESHOLD
 */
export function evaluateRevision(
  hitCount: number,
  dismissedCount: number,
): { active: boolean; ratio: number; shouldPropose: boolean } {
  const hits = Number.isFinite(hitCount) && hitCount > 0 ? hitCount : 0;
  const dismissed = Number.isFinite(dismissedCount) && dismissedCount > 0 ? dismissedCount : 0;
  const ratio = hits === 0 ? 0 : Math.min(dismissed / hits, 1);
  const active = hits >= REVISION_WINDOW;
  return { active, ratio, shouldPropose: active && ratio > REVISION_THRESHOLD };
}

/** near-miss 限流：同一模式累计询问上限 2 次（v6 §3.4；「问过即计数」，与「被否」分离） */
export const NEAR_MISS_ASK_LIMIT = 2;

/** 提议固化的重复行为阈值：同一对象类型累计 N 次即提议（v6 §3.4 / D10；数值待实测） */
export const NEAR_MISS_BEHAVIOR_N = 3;

/**
 * near-miss 模式键：**只由对象类型构成**（v6 §3.4 Q13）。
 * 对象类型是**有限枚举**，措辞是无限集——弱触发词只作产生候选的信号，**不进模式键**。
 * 从既有 butler 工具面派生：**代码里的映射、不落盘**，不构成新增存储。
 */
export type ObjectType = 'todo' | 'schedule' | 'note' | 'meeting' | 'project';

/**
 * 一条规则覆盖的对象类型（按确定性动作派生；派生不出 → null）。
 * 供「用户否决某条规则的结果」（signal_mismatch）落到对应的对象类型模式键上。
 */
export function ruleObjectType(rule: { steps: RuleStep[] }): ObjectType | null {
  for (const s of rule.steps) {
    if (s.action === 'create_todo') return 'todo';
    if (s.action === 'create_scheduled_todo') return 'schedule';
  }
  return null;
}