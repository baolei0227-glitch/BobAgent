/**
 * lib/butler/rule-exec.ts —— 规则**执行路由**（server-only，v6 §9.3 ④）
 *
 * 组成：
 *   - executeDeterministicRule：steps 全确定性时的宿主执行器（模型不得改写步骤）。
 *     支持三个确定性动作：
 *       · `'create_todo'`（Phase 1）：复用便签落盘原语（lib/butler/sticky-write.ts）建待办；
 *       · `'create_scheduled_todo'`（Phase 2）：建**日程待办**（挂日历、有精确时刻）；
 *       · `'skill'`（Phase 3 §3.6）：调用已固化技能，交 skill-sandbox 在宿主侧执行（不经模型）。
 *     前两者都**同源入日历**取得 event_id 作为 producedRef（供 `output_edited` 归因；
 *     与用户手动「加入日历」同一默认时段，见 sticky-calendar-sync）。
 *     **Skills 是 Rules 动作枚举的动态扩展，不是平行的第二执行路径**——三者共用本执行器，
 *     自动获得同口径的 hits / producedRef / output_edited 归因。
 *   - adjudicateAndExecute：把 ① 场景判定之后的 ② 候选生成 → ③ 裁决 → ④ 执行 串成一个宿主侧调用，
 *     供 /api/chat 主链路在回复前调用一次（裁决**不改本轮工具集**，只产一行状态陈述，见计划 D6）。
 *
 * 依赖：rules.ts / rule-decision.ts / rule-signals.ts / sticky-write.ts 与项目解析。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { listRules } from './rules';
import { STATE_DIR, ensureDir } from './storage';
import { atomicWriteFile, createKeyedLock } from './fs-atomic';
import { ruleObjectType, type RuleRecord } from './rules-shared';
import {
  generateCandidates,
  decide,
  type Decision,
  type ConflictResolution,
} from './rule-decision';
import {
  recordHit,
  recordOutputEdited,
  findRuleByProducedRef,
} from './rule-signals';
import { isBlocked } from './rule-nearmiss';
import { readRuleLog, listRuleLogKeys, type ConflictResolutionEntry } from './rule-logs';

/** 每会话「询问 / 修订提议」预算上限（v6 §3.2 ⑥：每会话 1–2 次；义务性通知不扣） */
export const RULE_ASK_BUDGET = 2;

/** 执行路由的上下文锚点 */
export interface RuleAnchor {
  /** 当前活动项目 id（作用域具体度判定用） */
  projectId?: string;
  /** 会话线程 id（预算计数用；缺省时不扣预算） */
  threadId?: string;
}

/**
 * ④-exec：执行一条全确定性规则。
 * 支持两个确定性动作（§3.1「第一版为步骤，不是代码」的绑定）：
 *   - `'create_todo'`：建便签待办（Phase 1）；
 *   - `'create_scheduled_todo'`：建**日程待办**（挂日历、有精确时刻，Phase 2）——时刻取自
 *     `step.actionParams.when`（`'occurrence'` = 触发该次的定时实例；否则为固化时已解析的 ISO）。
 * 事项文本 = 用户话去掉命中的触发词；定时候选无用户话时回退到 `step.text`（固化时写死）。
 */
export async function executeDeterministicRule(input: {
  rule: RuleRecord;
  text: string;
  anchor: RuleAnchor;
  /** 定时候选：本次对应的实例时刻（ms）；语面命中不传。供 'create_scheduled_todo' 取确定时刻 */
  occurrence?: number;
}): Promise<{ ok: boolean; producedRef?: string; message: string }> {
  const { rule, text } = input;
  const actionStep = rule.steps.find(
    (s) =>
      s.kind === 'deterministic' &&
      (s.action === 'create_todo' || s.action === 'create_scheduled_todo' || s.action === 'skill'),
  );
  if (!actionStep) {
    return { ok: false, message: '这条规则没有可执行的确定性动作。' };
  }

  // 技能动作（Phase 3 §3.6）：取绑定的技能 id，交 skill-sandbox 在宿主侧执行（不经模型）。
  // 与另两个动作同一条执行路由 → 自动获得同口径 hits / producedRef 归因。
  if (actionStep.action === 'skill') {
    const skillId = actionStep.actionParams?.skillId;
    if (!skillId) return { ok: false, message: '这条技能规则没有绑定技能 id（固化时未写死）。' };
    const { runSkill } = await import('./skill-sandbox');
    return runSkill({ skillId, text, anchor: input.anchor, occurrence: input.occurrence });
  }

  const isScheduled = actionStep.action === 'create_scheduled_todo';

  // 事项文本：
  //   - 定时触发（本次带 occurrence）：用户那句话与本次事项无关（只是时间到了），
  //     事项文本取步骤写死的 step.text（§3.3：固化时已把模糊解析成确定值）；
  //   - 语面命中：取用户话并剥掉命中的触发词；为空则回退到步骤文本。仍为空则不建（不猜）。
  const isTimerRun = typeof input.occurrence === 'number' && Number.isFinite(input.occurrence);
  let item = isTimerRun ? '' : text;
  if (!isTimerRun) {
    for (const kw of rule.trigger?.keywords ?? []) {
      if (kw) item = item.split(kw).join(' ');
    }
    item = item.replace(/^[\s，,。.、:：;；-]+/, '').replace(/\s+/g, ' ').trim();
  }
  if (!item) item = (actionStep.text ?? '').trim();
  if (!item) return { ok: false, message: '没听清要记什么，再说一次。' };

  // 日程动作：先算确定时刻（全部确定性，不经模型；§3.3 硬要求 2）
  let startIso: string | undefined;
  let endIso: string | undefined;
  if (isScheduled) {
    const when = actionStep.actionParams?.when;
    if (when && when !== 'occurrence') {
      startIso = when; // 固化时已解析的确定 ISO
    } else if (typeof input.occurrence === 'number' && Number.isFinite(input.occurrence)) {
      startIso = new Date(input.occurrence).toISOString();
    } else {
      return { ok: false, message: '这条日程规则没有确定时刻（需由定时触发或固化时写死时刻）。' };
    }
    const startMs = Date.parse(startIso);
    if (!Number.isFinite(startMs)) return { ok: false, message: `规则里的时刻「${startIso}」无法解析。` };
    endIso = new Date(startMs + 3_600_000).toISOString();
  }

  // 落点：便签为项目私有 → 用当前激活项目（便签原语不接受全局落点）
  const { resolveProjectWithFallback } = await import('@/lib/project/resolve-explicit-project');
  const pr = await resolveProjectWithFallback(undefined);
  if (!pr.ok || !pr.project) return { ok: false, message: '当前没有可写入的项目，待办无处可建。请先激活一个项目。' };
  const { id: projectId, name: projectName, path: projectRoot } = pr.project;

  const { appendStickyTodoNote } = await import('./sticky-write');
  const appended = await appendStickyTodoNote({ projectRoot, projectName, content: item, title: actionStep.text || undefined });
  if (!appended.ok) return { ok: false, message: appended.message ?? '待办创建失败。' };
  if (appended.limited) {
    return { ok: true, message: `待办便签已满三张，未新建「${item}」（可先在项目里结算现有便签）。` };
  }

  // 日程动作：目标时段与既有日程冲突（hard/potential）→ 降级为「只留痕的待办」，不排入日历
  if (isScheduled && startIso && endIso) {
    try {
      const { assessEventSlot } = await import('@/lib/calendar/overlaps');
      const a = await assessEventSlot({ startIso, endIso });
      if (a.level !== 'none') {
        return { ok: true, message: `「${item}」的目标时段与既有日程冲突，已留痕为待办、未排入日历（可改期后再排）。` };
      }
    } catch { /* 评估失败不阻断；按无冲突继续 */ }
  }

  // 同源入日历：取 event_id 作为 producedRef（供 output_edited 归因）；失败则降级为便签-only
  let producedRef: string | undefined;
  try {
    const cal = await import('@/lib/sticky-calendar-sync');
    const note = appended.notes.find((n) => n.id === appended.noteId);
    if (note) {
      const res = await cal.addStickyLineToCalendar(
        projectId,
        note as unknown as import('@/app/api/sticky-notes/route').StickyNote,
        appended.pageId,
        appended.lineIndex,
        undefined,
        isScheduled ? { start_time: startIso, end_time: endIso } : undefined,
      );
      producedRef = res.eventIds[0];
      const next = appended.notes.map((n) => (n.id === appended.noteId ? (res.note as unknown as Record<string, unknown>) : n));
      await cal.writeStickyNotesFile(projectRoot, next as unknown as import('@/app/api/sticky-notes/route').StickyNote[]);
    }
  } catch { /* 入日历失败不阻断待办创建；producedRef 缺省 → hits 不带引用 */ }

  if (isScheduled) {
    const whenText = startIso ? new Date(startIso).toLocaleString('zh-CN', { hour12: false }) : '';
    return { ok: true, producedRef, message: `已创建日程待办「${item}」${whenText ? `（${whenText}）` : ''}。` };
  }
  return { ok: true, producedRef, message: `已创建待办「${item}」。` };
}

// ==================== ② 候选 → ③ 裁决 → ④ 执行（宿主侧一次调用） ====================

export interface AdjudicateInput {
  /** 本轮用户话 */
  text: string;
  anchor: RuleAnchor;
  /** 命中场景标签（写入 hits，便于日志可读） */
  scene?: string;
  /** 定时候选：宿主侧已判定的到期实例（rule-timer.dueTimerRules 产出；Phase 1 传空） */
  timerHits?: { ruleId: string; occurrence: number }[];
}

export interface AdjudicateResult {
  /** 待注入本轮上下文的一行状态陈述（§8.3）；无 → 不动 */
  notice?: string;
  decision: Decision;
  /** 本次确定性执行产出的外部引用（如日历 event_id）；无确定性执行 / 执行失败时缺省 */
  producedRef?: string;
}

/** 读该候选对上的历史冲突消解记录（全部；decide 内部取最近一条） */
async function readResolutions(): Promise<ConflictResolution[]> {
  const keys = await listRuleLogKeys('conflict-resolution');
  const out: ConflictResolution[] = [];
  for (const key of keys) {
    const entries = await readRuleLog<ConflictResolutionEntry>('conflict-resolution', key);
    for (const e of entries) out.push({ key, inputFeature: e.inputFeature, chosen: e.chosen, versions: e.versions, at: e.at });
  }
  return out;
}

/** 预算文件按 threadId 分片，故用**分键锁**：不同会话互不阻塞，同一会话串行。
 *  （2026-10-02 评审 P2-⑭：此前是**无锁**读-改-写，同毫秒并发会互相覆盖 → 预算可被绕过。） */
const withBudgetLock = createKeyedLock<string>();

/** 预算目录：`<butler>/.state/rule-budget`（每个会话一个文件） */
function budgetDir(): string {
  return join(STATE_DIR, 'rule-budget');
}

/**
 * 只读：列出各会话已消耗的「主动冒头预算」（落 `.state/rule-budget/<threadId>.json`）。
 * 供记忆台的证据视图展示「这个会话还能主动问几次」——**不改行为**。
 */
export async function listRuleBudgets(): Promise<{ threadId: string; asks: number }[]> {
  let names: string[];
  try {
    names = await fs.readdir(budgetDir());
  } catch {
    return [];
  }
  const out: { threadId: string; asks: number }[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(join(budgetDir(), n), 'utf-8');
      const v = JSON.parse(raw) as { asks?: unknown };
      const asks = typeof v?.asks === 'number' && Number.isFinite(v.asks) ? v.asks : 0;
      out.push({ threadId: n.slice(0, -'.json'.length), asks });
    } catch { /* 坏文件跳过（脏数据不阻断视图） */ }
  }
  return out.sort((a, b) => b.asks - a.asks);
}

/** 会话预算：消耗一次（threadId 缺省 → 不落盘、视为有额度） */
async function consumeBudget(threadId: string | undefined): Promise<boolean> {
  if (!threadId) return true;
  const dir = budgetDir();
  // 锁键取 sanitize 后的文件名主干：两个不同 threadId 若 sanitize 成同名文件，也必须串行
  const key = sanitize(threadId);
  const file = join(dir, `${key}.json`);
  return withBudgetLock(key, async () => {
    let asks = 0;
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const v = JSON.parse(raw) as { asks?: unknown };
      if (typeof v?.asks === 'number' && Number.isFinite(v.asks)) asks = v.asks;
    } catch { /* 无文件 → 从 0 计 */ }
    if (asks >= RULE_ASK_BUDGET) return false;
    await ensureDir(dir);
    await atomicWriteFile(file, JSON.stringify({ asks: asks + 1 }));
    return true;
  });
}

function sanitize(key: string): string {
  return (key || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'default';
}

/** 判断该规则是否含「主体判断步」（→ 由模型执行，不走确定性执行器；§3.4 第 4 点） */
function hasPrimaryJudgment(rule: RuleRecord): boolean {
  return rule.steps.some((s) => s.kind === 'judgment' && s.annex !== true);
}

/**
 * ② 候选生成 → ③ 宿主侧裁决 → ④ 执行/询问/静默。
 * 硬约束（计划 D6）：**不改本轮工具集**，只返回一行状态陈述（由调用方注入上下文）。
 */
export async function adjudicateAndExecute(input: AdjudicateInput): Promise<AdjudicateResult> {
  const { text, anchor, scene = 'butler', timerHits = [] } = input;
  const all = await listRules();
  const rules = all.filter((r) => r.status === 'active');
  if (rules.length === 0) return { decision: { kind: 'silent' } };

  const occurrenceOf = new Map(timerHits.map((h) => [h.ruleId, h.occurrence]));
  const candidates = generateCandidates({ text, rules, now: new Date(), timerHits: timerHits.map((h) => h.ruleId) });
  if (candidates.length === 0) return { decision: { kind: 'silent' } };

  const resolutions = await readResolutions();
  const decision = decide({ candidates, rules, resolutions, activeProjectId: anchor.projectId });

  switch (decision.kind) {
    case 'silent':
      return { decision };
    case 'need_user': {
      const byId = new Map(rules.map((r) => [r.id, r]));
      const names = decision.options.map((id) => `${byId.get(id)?.name ?? id}（${id}）`).join(' / ');
      return {
        decision,
        notice: `有两条规则同时命中且优先级相同：${names}。请用一句话问用户这次按哪条办；用户选定后，调 rule_resolve_conflict（rule_a=${decision.options[0]}，rule_b=${decision.options[1]}，chosen=用户选的那条 id）记录本次裁决，再执行该条。`,
      };
    }
    case 'ask': {
      const rule = rules.find((r) => r.id === decision.ruleId);
      // 拉黑 / 预算约束：该规则覆盖的对象类型被 signal_mismatch 拉黑，或超预算 → 静默（不打扰）
      const ot = rule ? ruleObjectType(rule) : null;
      if (ot && (await isBlocked(ot, 'signal_mismatch'))) return { decision: { kind: 'silent' } };
      if (!(await consumeBudget(anchor.threadId))) return { decision: { kind: 'silent' } };
      return { decision, notice: `用户这句话疑似适用规则「${rule?.name ?? decision.ruleId}」（近似匹配，未确认）。可用一句话询问是否按它办。` };
    }
    case 'execute': {
      const rule = rules.find((r) => r.id === decision.ruleId);
      if (!rule) return { decision: { kind: 'silent' } };
      // 定时候选：本次实例时刻（语面命中为 undefined）——落 hits 供幂等去重，并交执行器取确定时刻
      const occurrence = occurrenceOf.get(rule.id);
      // 含主体判断步：交模型执行，并按 §8.5 说一次 commitment（不进确定性执行器）
      if (hasPrimaryJudgment(rule)) {
        await recordHit(rule.id, rule.version, scene, undefined, occurrence);
        return {
          decision,
          notice: `规则「${rule.name}」（承诺：${rule.commitment}）本轮适用。请按它的步骤执行，并在回复里说明承诺级别。`,
        };
      }
      const res = await executeDeterministicRule({ rule, text, anchor, occurrence });
      if (!res.ok) {
        return { decision, notice: `规则「${rule.name}」命中但未执行：${res.message}` };
      }
      await recordHit(rule.id, rule.version, scene, res.producedRef, occurrence);
      return { decision, producedRef: res.producedRef, notice: `已按规则「${rule.name}」自动执行：${res.message}不要再重复创建同一件事。` };
    }
  }
}

/** 供 tools 层复用：改动一个由规则产出的待办时，归因并落 output_edited */
export async function attributeOutputEdited(
  ref: string,
  before: string,
  after: string,
): Promise<void> {
  try {
    const ruleId = await findRuleByProducedRef(ref);
    if (!ruleId) return;
    const all = await listRules();
    const rule = all.find((r) => r.id === ruleId);
    if (!rule) return;
    await recordOutputEdited(ruleId, rule.version, ref, before, after);
  } catch { /* 归因失败不影响主流程 */ }
}