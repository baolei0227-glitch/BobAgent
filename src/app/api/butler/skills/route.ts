/**
 * /api/butler/skills — Butler 技能账本的读写接口（Phase 3 §3b-3 只读 → §3d 补治理写口）
 *
 * 与 `/api/butler/rules` 同构（纯增量，不改既有契约）：
 *   GET  → 列出全部技能（含 lifecycle / 版本 / 来源 / 适用条件 / 权限声明），
 *          并**附加**成败信号 `signals`（修订评估 + 成功/失败/被否计数），供治理面一次取全。
 *   POST → 两类动作，用 `action` 分流：
 *           · 治理：`{ id, action: 'retire' | 'unquarantine', expected_version? }`；
 *           · 内容修订：`{ id, action: 'revise', revision_kind?: 'param'|'flow', note?, name?, description?,
 *                          when?, steps?, grants?, effects?, expected_version? }`（→ version++ 并追加 revision）。
 *
 * 内容写口口径：**新建**技能仍走 skill_draft 草案卡审固（AI 起草 → 用户确认）；
 * 本路由的 `revise` 只用于**修订已固化技能**（用户显式改参数 / 改流程），不放宽执行边界。
 */
import { NextRequest, NextResponse } from 'next/server';
import { listSkills, setSkillLifecycle, reviseSkill } from '@/lib/butler/skills';
import type { ReviseSkillPatch, SkillGrants, SkillLifecycle, SkillStep, SkillWhen } from '@/lib/butler/skills';
import { evaluateSkillRevision, skillRunStats, type SkillRunStats } from '@/lib/butler/rule-signals';

/** 单条技能的成败信号（读 `.logs` 汇总，不冗余存正文） */
interface SkillSignal {
  /** 修订评估（与规则同判据：最近窗口否定率超阈值 → 建议修订） */
  revision: { active: boolean; ratio: number; shouldPropose: boolean };
  /** 运行统计：成功 / 失败 / 被否 + 连续失败数 */
  runs: SkillRunStats;
}

export async function GET() {
  try {
    const skills = await listSkills();
    const signals: Record<string, SkillSignal> = {};
    await Promise.all(
      skills.map(async (s) => {
        const [revision, runs] = await Promise.all([
          evaluateSkillRevision(s.id, s.version),
          skillRunStats(s.id),
        ]);
        signals[s.id] = { revision, runs };
      }),
    );
    return NextResponse.json({ success: true, count: skills.length, skills, signals });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/skills] 拉取失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      id?: unknown;
      action?: unknown;
      expected_version?: unknown;
      revision_kind?: unknown;
      note?: unknown;
      name?: unknown;
      description?: unknown;
      when?: unknown;
      steps?: unknown;
      grants?: unknown;
      effects?: unknown;
    };
    if (typeof body.id !== 'string' || !body.id) {
      return NextResponse.json({ success: false, error: 'id required (sk-<date>-<hex>)' });
    }
    const expectedVersion = typeof body.expected_version === 'number' ? body.expected_version : undefined;

    // 内容修订写口：用户显式改参数 / 改流程 → version++ 并追加一条 revision
    if (body.action === 'revise') {
      const patch: ReviseSkillPatch = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string') return NextResponse.json({ success: false, error: 'name must be a string' });
        patch.name = body.name;
      }
      if (body.description !== undefined) {
        if (typeof body.description !== 'string') return NextResponse.json({ success: false, error: 'description must be a string' });
        patch.description = body.description;
      }
      if (body.when !== undefined) {
        if (typeof body.when !== 'object' || body.when === null || Array.isArray(body.when)) {
          return NextResponse.json({ success: false, error: 'when must be an object' });
        }
        patch.when = body.when as Partial<SkillWhen>;
      }
      if (body.steps !== undefined) {
        const steps = parseSkillStepsArg(body.steps);
        if (!steps) return NextResponse.json({ success: false, error: 'steps invalid: array of { primitive, text?, params? }' });
        patch.steps = steps;
      }
      if (body.grants !== undefined) {
        if (typeof body.grants !== 'object' || body.grants === null || Array.isArray(body.grants)) {
          return NextResponse.json({ success: false, error: 'grants must be an object' });
        }
        patch.grants = body.grants as SkillGrants;
      }
      if (body.effects !== undefined) {
        if (!Array.isArray(body.effects)) return NextResponse.json({ success: false, error: 'effects must be a string array' });
        patch.effects = body.effects.map(String);
      }
      if (Object.keys(patch).length === 0) {
        return NextResponse.json({ success: false, error: 'nothing to revise' });
      }
      const kind = body.revision_kind === 'flow' ? 'flow' : 'param';
      const note = typeof body.note === 'string' ? body.note : '';
      const revised = await reviseSkill(body.id, patch, kind, note, expectedVersion);
      if (!revised.ok) {
        if (revised.conflict) return NextResponse.json({ success: false, conflict: true, error: revised.error });
        return NextResponse.json({ success: false, error: revised.error });
      }
      return NextResponse.json({ success: true, skill: revised.skill });
    }

    // 治理动作（生命周期切换，不 bump version）
    if (body.action !== 'retire' && body.action !== 'unquarantine') {
      return NextResponse.json({ success: false, error: "action must be 'retire' | 'unquarantine' | 'revise'" });
    }
    const lifecycle: SkillLifecycle = body.action === 'retire' ? 'retired' : 'active';

    const res = await setSkillLifecycle(body.id, lifecycle, expectedVersion);
    if (!res.ok) {
      if (res.conflict) return NextResponse.json({ success: false, conflict: true, error: res.error });
      return NextResponse.json({ success: false, error: res.error });
    }
    return NextResponse.json({ success: true, skill: res.skill });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/skills] 写口失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}

/** 校验并归一化 steps 入参（技能形态：`{ primitive, text?, params? }`）；非法 → null */
function parseSkillStepsArg(raw: unknown): SkillStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: SkillStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null;
    const o = s as { primitive?: unknown; text?: unknown; params?: unknown };
    if (typeof o.primitive !== 'string' || !o.primitive.trim()) return null;
    const step: SkillStep = { primitive: o.primitive.trim() };
    if (typeof o.text === 'string' && o.text.trim()) step.text = o.text.trim();
    if (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) if (typeof v === 'string') params[k] = v;
      if (Object.keys(params).length > 0) step.params = params;
    }
    steps.push(step);
  }
  return steps;
}