/**
 * lib/butler/skill-sandbox.ts —— 技能的**执行与权限边界**（server-only，Phase 3 §3.7）
 *
 * 定位：`rule-exec.executeDeterministicRule` 遇到 `action='skill'` 时把控制权交给本模块。
 * **Skills 是 Rules 动作枚举的动态扩展，不是平行的第二执行路径**——本模块只负责
 * 「静态拦截 + 受审原语编排」，真正的落盘/入日历仍复用 `executeDeterministicRule`
 * （构造合成单步 RuleRecord），因此自动继承既有的 hits / producedRef / output_edited 归因。
 *
 * 三条边界（§3.7）：
 *   1. **权限声明驱动**：技能未声明的能力一律拒绝（默认最小权限）——`checkGrantsCover`。
 *   2. **静态拦截**：只允许调用**受审原语白名单**（`AUDITED_PRIMITIVES`）；未受审 → 拒。
 *      复用 `runtime/tools.ts` 分层思路，把技能的 `grants` 与可调用原语面求交集。
 *   3. **运行时护栏**：步骤数上限（`MAX_SKILL_STEPS`）与执行超时（`SKILL_RUN_TIMEOUT_MS`）。
 *
 * 3c 只做 `compose`（受审原语编排）；`script`（任意代码）需要真沙箱，延后（计划 §四 D2）。
 * **执行不经模型**：这是「确定性执行不经模型」硬约束在 Skills 上的落点；技能一经用户审固即
 * 确定性资产，故运行时**不再弹确认**（重复打扰与既定偏好相悖）。
 */
import { readSkill, writeSkill } from './skills';
import { normalizeGrants, SKILL_FAIL_QUARANTINE, type SkillGrants, type SkillRecord } from './skills-shared';
import { countConsecutiveSkillFailures, recordSkillRun } from './rule-signals';
import type { RuleRecord, RuleStep } from './rules-shared';
import type { RuleAnchor } from './rule-exec';

/** 技能可申请的能力标签（与 `SkillGrants` 字段一一对应） */
export type SkillCapability = 'fs' | 'net' | 'process';

/**
 * 受审原语白名单（静态拦截的第一道）。
 * 每项声明它需要的能力 → 与技能 `grants` 求交集；未声明的能力一律拒。
 * 3c 只放两个已审计的确定性动作——它们都在项目便签 / 日历的既有受审路径内，不额外要权限。
 * 扩展新原语 = 在此登记 + 声明其能力需求（与「扩大可组合的原语面」同义）。
 */
const AUDITED_PRIMITIVES: Record<string, { caps: SkillCapability[] }> = {
  create_todo: { caps: [] },
  create_scheduled_todo: { caps: [] },
};

/** 运行时护栏：单次技能执行最多步骤数 */
export const MAX_SKILL_STEPS = 10;
/** 运行时护栏：单次技能执行超时（毫秒） */
export const SKILL_RUN_TIMEOUT_MS = 30_000;

/** 一步的执行计划（静态拦截通过后产出；与 `SkillStep` 同形，供 buildStepRule 消费） */
export interface SkillStepPlan {
  primitive: string;
  text?: string;
  params?: Record<string, string>;
}

/** 技能执行结果（与 `executeDeterministicRule` 同形，便于调用方统一处理） */
export interface SkillRunResult {
  ok: boolean;
  producedRef?: string;
  message: string;
}

/** 静态拦截结论：通过 → 步骤计划；否则 → 拒绝理由（中文，直接回给用户） */
export type SkillPlan = { ok: true; plans: SkillStepPlan[] } | { ok: false; message: string };

/**
 * 权限覆盖校验（纯函数）：技能声明的 `grants` 是否覆盖所需能力。
 * **未声明即拒绝**（默认最小权限）：`fs` 需非空路径白名单；`net` / `process` 需显式 true。
 */
export function checkGrantsCover(
  grants: SkillGrants | undefined | null,
  required: SkillCapability[],
): boolean {
  const g = normalizeGrants(grants);
  return required.every((cap) => {
    if (cap === 'fs') return !!g.fs && g.fs.length > 0;
    if (cap === 'net') return g.net === true;
    if (cap === 'process') return g.process === true;
    return false;
  });
}

/**
 * 静态拦截（纯函数）：执行前把技能收敛成一个「只含受审原语」的步骤计划。
 *   - 非 compose（script）→ 拒（3c 不支持）；
 *   - 无步骤 / 步骤数超上限 → 拒；
 *   - 任一步调用未受审原语 → 拒；
 *   - 所需能力未被 `grants` 覆盖 → 拒。
 */
export function planSkill(skill: SkillRecord): SkillPlan {
  if (skill.runtime !== 'compose') {
    return { ok: false, message: `技能「${skill.name}」是 script 形态，当前版本不支持执行（仅支持 compose 编排）。` };
  }
  const steps = skill.steps ?? [];
  if (steps.length === 0) {
    return { ok: false, message: `技能「${skill.name}」没有可执行的步骤。` };
  }
  if (steps.length > MAX_SKILL_STEPS) {
    return { ok: false, message: `技能「${skill.name}」步骤数超上限（${steps.length} > ${MAX_SKILL_STEPS}），已拒绝执行。` };
  }

  const required: SkillCapability[] = [];
  for (const s of steps) {
    const def = AUDITED_PRIMITIVES[s.primitive];
    if (!def) {
      return { ok: false, message: `技能调用了未受审的原语「${s.primitive}」，已拒绝执行。` };
    }
    required.push(...def.caps);
  }
  const uniq = Array.from(new Set(required));
  if (!checkGrantsCover(skill.grants, uniq)) {
    return { ok: false, message: `技能声明的能力不足（需要 ${uniq.join(' / ')}，但 grants 未覆盖），已拒绝执行。` };
  }
  return { ok: true, plans: steps.map((s) => ({ primitive: s.primitive, text: s.text, params: s.params })) };
}

/** 替换步骤参数里的占位符：`{{item}}` / `{{text}}` → 本次触发文本；未知占位符原样保留 */
function resolveParams(params: Record<string, string> | undefined, text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    out[k] = v.replace(/\{\{\s*(item|text)\s*\}\}/g, text);
  }
  return out;
}

/**
 * 构造**合成单步规则**（从不落盘）——把一步受审原语包成 `executeDeterministicRule` 认识的形态，
 * 从而复用既有执行器与归因，不在本模块重复实现落盘 / 入日历。
 */
function buildStepRule(skill: SkillRecord, step: SkillStepPlan, when?: string): RuleRecord {
  const actionParams: RuleStep['actionParams'] = {};
  if (when) actionParams.when = when;
  return {
    id: skill.id,
    name: skill.name,
    kind: 'rule',
    intentRaw: skill.description,
    trigger: { keywords: [] },
    steps: [
      {
        kind: 'deterministic',
        text: step.text ?? '',
        action: step.primitive as RuleStep['action'],
        actionParams,
      },
    ],
    commitment: '必做到',
    scope: 'global',
    priority: 0,
    status: 'active',
    version: skill.version,
    createdAt: skill.createdAt,
  };
}

/**
 * 运行失败落账 + 连续失败达阈值即自动隔离（Phase 3 §3.8）。
 * 返回本次是否触发隔离与当前连续失败数（供回执追加提示）。
 */
async function recordFailureAndMaybeQuarantine(
  skill: SkillRecord,
  reason: string,
): Promise<{ quarantined: boolean; count: number }> {
  await recordSkillRun(skill.id, skill.version, false, undefined, reason);
  const count = await countConsecutiveSkillFailures(skill.id);
  if (count >= SKILL_FAIL_QUARANTINE) {
    await writeSkill({ ...skill, lifecycle: 'quarantine', updatedAt: new Date().toISOString() });
    return { quarantined: true, count };
  }
  return { quarantined: false, count };
}

/**
 * 执行一条技能（compose 编排，宿主侧，不经模型）。
 * 逐步入参：`params.item`（替换占位符后）> `step.text`（固化确定值）> 本次触发原话。
 * 任一步失败即整体失败（不静默吞错）；超时护栏见 `SKILL_RUN_TIMEOUT_MS`。
 */
export async function runSkill(input: {
  skillId: string;
  text: string;
  anchor: RuleAnchor;
  /** 定时候选：本次实例时刻（ms）；语面命中不传。透传给执行器取确定时刻 */
  occurrence?: number;
}): Promise<SkillRunResult> {
  const skill = await readSkill(input.skillId);
  if (!skill) return { ok: false, message: `找不到技能「${input.skillId}」。` };
  if (skill.lifecycle !== 'active') {
    return { ok: false, message: `技能「${skill.name}」当前为 ${skill.lifecycle} 状态，不自动执行。` };
  }
  const plan = planSkill(skill);
  if (!plan.ok) return { ok: false, message: plan.message };

  const { executeDeterministicRule } = await import('./rule-exec');
  const run = async (): Promise<SkillRunResult> => {
    const refs: string[] = [];
    const notes: string[] = [];
    for (const step of plan.plans) {
      const params = resolveParams(step.params, input.text);
      // 执行文本（item）解析优先级：params.item > step.text（固化确定值）> 本次触发原话。
      // 中间一支传空串是有意为之：让执行器回退到 step.text（固化时写死的确定值）。
      const stepText = params.item !== undefined ? params.item : step.text ? '' : input.text;

      const res = await executeDeterministicRule({
        rule: buildStepRule(skill, step, params.when),
        text: stepText,
        anchor: input.anchor,
        occurrence: input.occurrence,
      });
      if (!res.ok) {
        const q = await recordFailureAndMaybeQuarantine(skill, res.message);
        const tail = q.quarantined ? `（连续失败 ${q.count} 次，已自动隔离，可在面板解封）` : '';
        return { ok: false, message: `技能「${skill.name}」第 ${notes.length + 1} 步失败：${res.message}${tail}` };
      }
      if (res.producedRef) refs.push(res.producedRef);
      notes.push(res.message);
    }
    await recordSkillRun(skill.id, skill.version, true, refs[0]);
    return { ok: true, producedRef: refs[0], message: `已按技能「${skill.name}」执行：${notes.join(' ')}` };
  };

  // 运行时护栏：超时竞速（超时不吞 Promise，仅回报失败）
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SkillRunResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, message: `技能「${skill.name}」执行超时（> ${Math.round(SKILL_RUN_TIMEOUT_MS / 1000)}s）。` }),
      SKILL_RUN_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}