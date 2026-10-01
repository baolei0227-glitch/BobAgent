/**
 * /api/butler/skills — Butler 技能账本的读写接口（Phase 3 §3b-3 只读 → §3d 补治理写口）
 *
 * 与 `/api/butler/rules` 同构（纯增量，不改既有契约）：
 *   GET  → 列出全部技能（含 lifecycle / 版本 / 来源 / 适用条件 / 权限声明），
 *          并**附加**成败信号 `signals`（修订评估 + 成功/失败/被否计数），供治理面一次取全。
 *   POST → 治理动作 `{ id, action: 'retire' | 'unquarantine', expected_version? }`。
 *
 * **注意**：技能的唯一「内容」写路径仍是 skill_draft 草案卡审固（approved 后回落 toolSkillDraft）；
 * 本路由只承载**生命周期治理**（停用 / 解封），不提供内容编辑口。
 */
import { NextRequest, NextResponse } from 'next/server';
import { listSkills, setSkillLifecycle } from '@/lib/butler/skills';
import type { SkillLifecycle } from '@/lib/butler/skills';
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
    const body = (await request.json()) as { id?: unknown; action?: unknown; expected_version?: unknown };
    if (typeof body.id !== 'string' || !body.id) {
      return NextResponse.json({ success: false, error: 'id required (sk-<date>-<hex>)' });
    }
    if (body.action !== 'retire' && body.action !== 'unquarantine') {
      return NextResponse.json({ success: false, error: "action must be 'retire' or 'unquarantine'" });
    }
    const lifecycle: SkillLifecycle = body.action === 'retire' ? 'retired' : 'active';
    const expectedVersion = typeof body.expected_version === 'number' ? body.expected_version : undefined;

    const res = await setSkillLifecycle(body.id, lifecycle, expectedVersion);
    if (!res.ok) {
      if (res.conflict) return NextResponse.json({ success: false, conflict: true, error: res.error });
      return NextResponse.json({ success: false, error: res.error });
    }
    return NextResponse.json({ success: true, skill: res.skill });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/skills] 治理动作失败:', msg);
    return NextResponse.json({ success: false, error: msg });
  }
}