/**
 * 技能的**纯常量与类型**（无任何 Node 依赖）——与 `rules-shared.ts` 同因：
 * 治理面 `components/butler/ButlerRulesPanel.tsx` 是客户端组件，需要词表与派生逻辑做展示；
 * 而 `skills.ts` 含 fs 读写，客户端链路无法 bundle。故把纯数据 / 纯函数抽到这里，
 * 服务端（skills.ts 转出）与客户端共用同一份定义，避免两处漂移。
 *
 * 依据：Butler Phase 3 实现计划 §3.4（技能账本 frontmatter 五要素 + 安全声明）。
 *
 * **概念边界（勿混用）**：Skills 是**程序化可执行能力**（AI 起草、用户审固的编排），
 * 与 Memories（`butler/preferences.md`，不可执行）、Rules（`.rules/<id>.md`，声明式可执行）分账。
 * **Skills 不是「第二层记忆」**——详见《Butler分层记忆方案》§七。
 */
import type { ObjectType } from './rules-shared';

/** 技能来源：AI 起草 / 用户手写 */
export type SkillOrigin = 'ai' | 'user';

/** 技能生命周期：active（可匹配）/ quarantine（连续失败被隔离，可解封）/ retired（停用） */
export type SkillLifecycle = 'active' | 'quarantine' | 'retired';

/**
 * 执行形态：
 *   - `compose`：**受审原语编排**（逐步调用已审计的动作原语），3c 支持；
 *   - `script` ：任意代码，需要真沙箱，3c **暂不支持**（计划 §四 D2）。
 */
export type SkillRuntime = 'compose' | 'script';

/**
 * 技能适用条件（**必须显式**，不靠语义相似硬撞；计划 §3.4 ①）。
 * 复用 Rules 的判据（`generateCandidates` 的语面 / 场景）并在其上加「对象类型 + 前置校验」（D3）。
 */
export interface SkillWhen {
  /** 语面组：触发词（宿主侧裁决用） */
  keywords: string[];
  /** 场景组（可选） */
  scenes?: string[];
  /** 对象类型（可选；复用 near-miss 的有限枚举） */
  objectTypes?: ObjectType[];
  /** 前置校验：宿主侧可判定的布尔条件（如「项目已激活」）；3c 起解释执行 */
  preconditions?: string[];
}

/**
 * 技能权限声明（**默认空 = 最小权限**）。
 * 未声明的能力一律拒绝；把 `grants` 与可调用原语面求交集是 3c 的静态拦截口径。
 */
export interface SkillGrants {
  /** 允许写入的路径白名单（相对项目根 / butler 根）；空 / 缺省 = 不可写 */
  fs?: string[];
  /** 是否允许网络请求；缺省 = 否 */
  net?: boolean;
  /** 是否允许起子进程；缺省 = 否 */
  process?: boolean;
}

/** 一步编排动作：调用一个受审原语（`compose` 形态的最小单元） */
export interface SkillStep {
  /** 受审原语 id（如 'create_todo' / 'create_scheduled_todo'；3c 起扩展） */
  primitive: string;
  /** 原语参数（可含占位符，如 '{{item}}'——固化时已确定，执行时替换） */
  params?: Record<string, string>;
  /** 该步说明（给人看） */
  text?: string;
}

/** 一次修正记录：用户的修正是**改参数**还是**改流程**（计划 §3.4 ④） */
export interface SkillRevision {
  at: string;
  /** 修正类型：param（改参数，不改流程）/ flow（改流程，version + 1 并留 diff） */
  kind: 'param' | 'flow';
  note: string;
  /** 改前版本号 */
  fromVersion: number;
}

/** 一条技能（本体；frontmatter 存字段，正文存 description） */
export interface SkillRecord {
  /** 技能唯一标识 `sk-<YYYYMMDD>-<4hex>`，永不变 */
  id: string;
  /** 人类可读名称 */
  name: string;
  /** 一句话：这技能**要干什么**（卡片展示项①） */
  description: string;
  /** 适用条件：什么时候会被自动调用（卡片展示项②） */
  when: SkillWhen;
  runtime: SkillRuntime;
  /** compose 编排步骤（runtime='compose' 时有效） */
  steps: SkillStep[];
  /** 权限声明（卡片展示项③） */
  grants: SkillGrants;
  /** 副作用声明（给人看：写文件 / 进日历 / 发消息；卡片展示项④） */
  effects?: string[];
  origin: SkillOrigin;
  lifecycle: SkillLifecycle;
  /** 修订版本号；改流程（kind='flow'）时 + 1，同时是并发写的乐观锁 */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 修正历史（新到旧） */
  revisions: SkillRevision[];
}

/** 新建技能的输入（id / version / 时间戳 / origin 由调用方或系统给定） */
export interface CreateSkillInput {
  name: string;
  description: string;
  when: SkillWhen;
  /** 未传默认 'compose' */
  runtime?: SkillRuntime;
  steps?: SkillStep[];
  grants?: SkillGrants;
  effects?: string[];
  /** 未传默认 'ai' */
  origin?: SkillOrigin;
}

/** 技能隔离阈值：连续失败达到 N 次 → 自动 quarantine（不再自动匹配，可在面板解封；Phase 3 §3.8） */
export const SKILL_FAIL_QUARANTINE = 3;

// ==================== 展示词表（英文显示名，UI 文案一律英文） ====================

/** 生命周期英文显示名 */
export const LIFECYCLE_LABELS: Record<SkillLifecycle, string> = {
  active: 'Active',
  quarantine: 'Quarantined',
  retired: 'Retired',
};

/** 来源英文显示名 */
export const ORIGIN_LABELS: Record<SkillOrigin, string> = {
  ai: 'AI-drafted',
  user: 'User',
};

/** 执行形态英文显示名 */
export const RUNTIME_LABELS: Record<SkillRuntime, string> = {
  compose: 'Composed',
  script: 'Script',
};

// ==================== 纯函数 ====================

/** 归一化权限声明：缺省 / 非法一律收敛为**空声明**（最小权限） */
export function normalizeGrants(raw?: SkillGrants | null): SkillGrants {
  const out: SkillGrants = {};
  if (!raw || typeof raw !== 'object') return out;
  if (Array.isArray(raw.fs)) {
    const fs = raw.fs.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim());
    if (fs.length > 0) out.fs = fs;
  }
  if (raw.net === true) out.net = true;
  if (raw.process === true) out.process = true;
  return out;
}

/** 权限是否为空（空 = 无额外权限，卡片上直接显示 "No extra permissions"） */
export function isGrantsEmpty(grants?: SkillGrants | null): boolean {
  const g = normalizeGrants(grants);
  return !g.fs && !g.net && !g.process;
}

/**
 * 副作用的**人类可读描述**（由 grants 派生；卡片展示项④）。
 * 刻意只描述「会产生什么副作用」，不解释实现——与弹窗极简化口径一致。
 */
export function describeEffects(grants?: SkillGrants | null): string[] {
  const g = normalizeGrants(grants);
  const out: string[] = [];
  if (g.fs && g.fs.length > 0) out.push(`Writes files (${g.fs.join(', ')})`);
  if (g.net) out.push('Makes network requests');
  if (g.process) out.push('Runs subprocesses');
  return out.length > 0 ? out : ['No side effects declared'];
}