/**
 * /api/butler/rules — Butler 规则面板的读写接口
 *
 * 把「规则」做成**可见、可写、可改、可删**的产品对象（对齐偏好面板 /api/butler/preferences）：
 *   GET    → 列出全部规则
 *   POST   → 新建一条规则 { name, intent_raw, steps, trigger?, scope?, scope_target?, priority? }
 *   PATCH  → 更新 { id, name?, intent_raw?, steps?, trigger?, scope?, scope_target?, priority?, status?, expected_version? }
 *   DELETE → 删除 ?id=r-…
 *
 * steps 的确定性步可绑定宿主执行器：`action: 'create_todo' | 'create_scheduled_todo' | 'skill'`
 * 配 `action_params`（`when` / `skillId`）——与 MCP 工具侧共用同一白名单，`skill` 用于调用已固化技能。
 *
 * 全部经 lib/butler/rules.ts（<APP_ROOT>/butler/.rules/<id>.md）落地，与 MCP 工具侧同源，
 * 避免「工具写一份、面板写一份」导致规则分叉。
 *
 * 依据 v6 §10.2 Phase 0：只做存放与可见，不做自动执行。commitment / kind 由服务端派生，
 * 面板只读展示；status 的 pause/retire 由用户发起（免确认，v6 §5.1）。
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  listRules,
  readRule,
  createRule,
  updateRule,
  deleteRule,
  type CreateRuleInput,
} from '@/lib/butler/rules';
import type { RuleStatus, RuleStep } from '@/lib/butler/rules';
import { recordNegativeSample } from '@/lib/butler/rule-signals';
import { ruleObjectType } from '@/lib/butler/rules-shared';

/**
 * 用户「废除（retire）/ 删除」一条规则 → 落一条 `not_a_habit` 负样本。
 * 语义：这是用户的显式否决——near-miss「一次即记忆」不得再把同类习惯静默学回；
 * 用户若反悔，可在面板「被拉黑模式」里解封（append-only，可恢复）。
 */
function blockReProposal(rule: { steps: RuleStep[] }): void {
  const ot = ruleObjectType(rule);
  if (!ot) return;
  void recordNegativeSample(ot, ot, 'blocked', 'not_a_habit').catch(() => { /* 负样本写失败不阻断主操作 */ });
}

export async function GET() {
  try {
    const rules = await listRules();
    return NextResponse.json({ success: true, count: rules.length, rules });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/rules] 拉取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      name?: unknown;
      intent_raw?: unknown;
      steps?: unknown;
      trigger?: unknown;
      scope?: unknown;
      scope_target?: unknown;
      priority?: unknown;
      kind?: unknown;
    };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ success: false, error: 'name required' });
    }
    if (typeof body.intent_raw !== 'string' || !body.intent_raw.trim()) {
      return NextResponse.json({ success: false, error: 'intent_raw required' });
    }
    const steps = parseStepsArg(body.steps);
    if (!steps) {
      return NextResponse.json({ success: false, error: 'steps required: array of { kind: "deterministic"|"judgment", text, action?, action_params? }; action="skill" requires action_params.skillId' });
    }
    const scope = body.scope === 'project' ? 'project' : 'global';
    const input: CreateRuleInput = {
      name: body.name,
      intentRaw: body.intent_raw,
      steps,
      scope,
      ...(scope === 'project' && typeof body.scope_target === 'string' ? { scopeTarget: body.scope_target } : {}),
      ...(body.priority !== undefined ? { priority: Number(body.priority) } : {}),
      ...(body.kind === 'flow' || body.kind === 'rule' ? { kind: body.kind } : {}),
    };
    if (typeof body.trigger === 'object' && body.trigger !== null) {
      const t = body.trigger as { keywords?: unknown; scenes?: unknown };
      if (Array.isArray(t.keywords)) input.trigger = { ...input.trigger, keywords: t.keywords.map(String) };
      if (Array.isArray(t.scenes)) input.trigger = { ...input.trigger, scenes: t.scenes.map(String) };
    }
    const rule = await createRule(input);
    return NextResponse.json({ success: true, rule });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/rules] 新建失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      id?: unknown;
      name?: unknown;
      intent_raw?: unknown;
      steps?: unknown;
      trigger?: unknown;
      scope?: unknown;
      scope_target?: unknown;
      priority?: unknown;
      status?: unknown;
      kind?: unknown;
      expected_version?: unknown;
    };
    if (typeof body.id !== 'string' || !body.id) {
      return NextResponse.json({ success: false, error: 'id required' });
    }
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') return NextResponse.json({ success: false, error: 'name must be a string' });
      patch.name = body.name;
    }
    if (body.intent_raw !== undefined) {
      if (typeof body.intent_raw !== 'string') return NextResponse.json({ success: false, error: 'intent_raw must be a string' });
      patch.intentRaw = body.intent_raw;
    }
    if (body.steps !== undefined) {
      const steps = parseStepsArg(body.steps);
      if (!steps) return NextResponse.json({ success: false, error: 'steps invalid: action="skill" requires action_params.skillId' });
      patch.steps = steps;
    }
    if (body.trigger !== undefined && typeof body.trigger === 'object' && body.trigger !== null) {
      const t = body.trigger as { keywords?: unknown; scenes?: unknown; time?: unknown };
      const trigger: Record<string, unknown> = {};
      if (t.keywords !== undefined) trigger.keywords = Array.isArray(t.keywords) ? t.keywords.map(String) : [];
      if (t.scenes !== undefined) trigger.scenes = Array.isArray(t.scenes) ? t.scenes.map(String) : [];
      if (t.time !== undefined) trigger.time = t.time;
      patch.trigger = trigger;
    }
    if (body.scope !== undefined) {
      if (body.scope !== 'global' && body.scope !== 'project') return NextResponse.json({ success: false, error: 'scope must be global or project' });
      patch.scope = body.scope;
    }
    if (body.scope_target !== undefined) {
      if (typeof body.scope_target !== 'string') return NextResponse.json({ success: false, error: 'scope_target must be a string' });
      patch.scopeTarget = body.scope_target;
    }
    if (body.priority !== undefined) {
      patch.priority = Number(body.priority);
      if (!Number.isFinite(patch.priority)) return NextResponse.json({ success: false, error: 'priority must be a number' });
    }
    if (body.status !== undefined) {
      const statuses: RuleStatus[] = ['draft', 'active', 'paused', 'retired'];
      if (!statuses.includes(body.status as RuleStatus)) return NextResponse.json({ success: false, error: 'status invalid' });
      patch.status = body.status;
    }
    if (body.kind !== undefined) {
      if (body.kind !== 'rule' && body.kind !== 'flow') return NextResponse.json({ success: false, error: 'kind invalid' });
      patch.kind = body.kind;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'nothing to update' });
    }
    const expectedVersion = typeof body.expected_version === 'number' ? body.expected_version : undefined;

    const res = await updateRule(body.id, patch as Parameters<typeof updateRule>[1], expectedVersion);
    if (!res.ok) {
      if (res.conflict) return NextResponse.json({ success: false, conflict: true, error: res.error });
      return NextResponse.json({ success: false, error: res.error });
    }
    // 废除（retire）→ 记负样本：用户否决了这类习惯，near-miss 不得再学回（可解封恢复）
    if (patch.status === 'retired') blockReProposal(res.rule);
    return NextResponse.json({ success: true, rule: res.rule });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/rules] 更新失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ success: false, error: 'id required (r-<date>-<hex>)' });
    // 删除前先读原件：删除＝用户显式否决，需按对象类型落负样本，防止 near-miss 静默学回
    const existed = await readRule(id);
    const removed = await deleteRule(id);
    if (!removed) return NextResponse.json({ success: false, error: `rule ${id} not found` });
    if (existed) blockReProposal(existed);
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/rules] 删除失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

/** 合法的确定性 action 取值（与 rules.ts 的解析白名单同源）。`'skill'` = 调用已固化技能（`action_params.skillId`）。 */
const RULE_STEP_ACTIONS = ['create_todo', 'create_scheduled_todo', 'skill'] as const;

/** 校验并归一化 steps 入参；非法 → null。
 *  确定性步可带 `action`（宿主执行器）+ `action_params`（`when` / `skillId`），与 MCP 工具侧同口径。 */
function parseStepsArg(raw: unknown): RuleStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: RuleStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null;
    const o = s as { kind?: unknown; text?: unknown; annex?: unknown; action?: unknown; action_params?: unknown };
    if (o.kind !== 'deterministic' && o.kind !== 'judgment') return null;
    if (typeof o.text !== 'string' || !o.text.trim()) return null;
    const step: RuleStep = { kind: o.kind, text: o.text.trim(), ...(o.kind === 'judgment' && o.annex === true ? { annex: true } : {}) };
    if (o.kind === 'deterministic') {
      const action = RULE_STEP_ACTIONS.find((a) => a === o.action);
      if (action) step.action = action;
      const ap = o.action_params;
      if (ap && typeof ap === 'object' && !Array.isArray(ap)) {
        const when = (ap as { when?: unknown }).when;
        const skillId = (ap as { skillId?: unknown }).skillId;
        if ((typeof when === 'string' && when) || (typeof skillId === 'string' && skillId)) {
          const actionParams: NonNullable<RuleStep['actionParams']> = {};
          if (typeof when === 'string' && when) actionParams.when = when;
          if (typeof skillId === 'string' && skillId) actionParams.skillId = skillId;
          step.actionParams = actionParams;
        }
      }
      // skill 动作必须绑定技能 id，否则规则永远无法执行 → 视为非法入参
      if (step.action === 'skill' && !step.actionParams?.skillId) return null;
    }
    steps.push(step);
  }
  return steps;
}