import { NextRequest, NextResponse } from 'next/server';
import { getCurrentProject, getProjectById } from '@/lib/project/project-manager';
import { readProjectPlans, summarizePlan } from '@/lib/project/plans';

/**
 * GET /api/projects/plans
 * 项目计划树（.butler/plans.json）的只读派生视图 —— 供界面「计划面板」按项目展示。
 *
 * 只读边界：本接口不落任何写动作（计划的创建/推进/收尾仍由管家工具完成）。
 *
 * Query:
 *   project_id      项目 id（缺省 = 当前项目）
 *   include_closed  1 / true 时带出终态计划（done / abandoned）；缺省只列进行中
 *   stalled_days    停滞判定阈值（天，缺省 14，clamp 1–365）
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const includeClosed = ['1', 'true'].includes((searchParams.get('include_closed') || '').toLowerCase());
    const stalledRaw = Number.parseInt(searchParams.get('stalled_days') || '', 10);
    const stalledDays = Number.isFinite(stalledRaw) ? Math.min(Math.max(stalledRaw, 1), 365) : 14;

    const project = projectId ? await getProjectById(projectId) : await getCurrentProject();

    const all = await readProjectPlans(project.path);
    const shown = includeClosed ? all : all.filter((p) => p.status === 'active');

    const plans = shown.map((plan) => {
      const s = summarizePlan(plan);
      return {
        id: plan.id,
        title: plan.title,
        goal: plan.goal ?? null,
        status: plan.status,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        progress: {
          steps: s.steps,
          done: s.done,
          percent: s.steps > 0 ? Math.round((s.done / s.steps) * 100) : 0,
        },
        overdue: s.overdue,
        nextDue: s.nextDue,
        stalled: plan.status === 'active' && s.updatedDaysAgo !== null && s.updatedDaysAgo >= stalledDays,
        // 完整树：里程碑 → 步骤（界面渲染细节用；与落盘结构一致）
        milestones: plan.milestones,
      };
    });

    const totals = {
      plans: all.length,
      openPlans: all.filter((p) => p.status === 'active').length,
      shown: plans.length,
      steps: plans.reduce((n, p) => n + p.progress.steps, 0),
      doneSteps: plans.reduce((n, p) => n + p.progress.done, 0),
      overdueSteps: plans.reduce((n, p) => n + p.overdue.length, 0),
    };

    return NextResponse.json({
      project: { id: project.id, name: project.name },
      today: new Date().toISOString().slice(0, 10),
      include_closed: includeClosed,
      stalled_days: stalledDays,
      totals,
      plans,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === 'NO_PROJECT') {
      return NextResponse.json({ error: 'NO_PROJECT' }, { status: 404 });
    }
    if (msg.startsWith('项目不存在')) {
      return NextResponse.json({ error: 'PROJECT_NOT_FOUND', message: msg }, { status: 404 });
    }
    console.error('[projects/plans] 读取失败:', error);
    return NextResponse.json({ error: msg || '读取项目计划失败' }, { status: 500 });
  }
}
