import { NextRequest } from 'next/server';
import { basename } from 'path';
import { getCurrentProject, getProjectById, listProjects } from '@/lib/project/project-manager';
import {
  openUsageDb,
  queryUsageSummary,
  listRecentUsage,
  listCostCurrencies,
  resetUsageLedger,
  type UsageSummary,
  type UsageLogRow,
  type UsageWindow,
} from '@/lib/usage';

export const runtime = 'nodejs';

type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'year' | 'all';
type Scope = 'project' | 'all';

function dayStartISO(offsetDays: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}

/** 自然月起点（本地时区）；offsetMonths 为月份偏移，-11 = 含当月在内的 12 个月窗口起点 */
function monthStartISO(offsetMonths = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // 先归到 1 号再偏移，避免 31 号在小月溢出到下个月
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMonths);
  return d.toISOString();
}

function rangeWindow(range: RangeKey): { from?: string; to?: string } {
  switch (range) {
    case 'today':
      return { from: dayStartISO(0) };
    case 'yesterday':
      return { from: dayStartISO(-1), to: dayStartISO(0) };
    case '7d':
      return { from: new Date(Date.now() - 7 * 86_400_000).toISOString() };
    case '30d':
      return { from: new Date(Date.now() - 30 * 86_400_000).toISOString() };
    case 'month':
      return { from: monthStartISO() };
    // Year 视图：含当月在内的近 12 个自然月（月度趋势图的上限）
    case 'year':
      return { from: monthStartISO(-11) };
    default:
      return {};
  }
}

/**
 * GET /api/usage?range=today|yesterday|7d|30d|month|year|all&scope=project|all&projectId=xxx
 *
 * 用量聚合（全局账本 .usage.db）：
 *  - scope=project（默认）：只统计指定/当前激活项目
 *  - scope=all：跨项目汇总 + 最近任务附项目名
 * 无可用项目（project 作用域）→ empty 响应（面板展示提示，不报错）。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const range = (searchParams.get('range') as RangeKey) || '7d';
  const scope: Scope = searchParams.get('scope') === 'all' ? 'all' : 'project';
  const projectIdParam = searchParams.get('projectId') || undefined;

  // project 作用域需要解析当前/指定项目；无项目 → 空态（不视为错误）
  let project: { id: string; path: string } | null = null;
  if (scope === 'project') {
    try {
      project = projectIdParam
        ? await getProjectById(projectIdParam)
        : await getCurrentProject();
    } catch {
      return Response.json({
        meta: { empty: true, reason: 'no_project', scope, range },
        summary: null,
        recent: [],
      });
    }
  }

  const window: UsageWindow = { ...rangeWindow(range) };
  if (project) window.projectId = project.id;

  try {
    const db = await openUsageDb();
    const summary: UsageSummary = queryUsageSummary(db, window);
    // 最近任务只列模型任务：Web 工具按次计费的流水单独在 webTools 里汇总
    const recent: UsageLogRow[] = listRecentUsage(db, { ...window, excludeSources: ['web'] }, 8);
    // 窗口内币种一致时才给出统一成本符号（混币种无法合并展示 → 面板回落 $）
    const currencies = listCostCurrencies(db, window);
    const costCurrency = currencies.length === 1 ? currencies[0] : undefined;

    // all 作用域：为最近任务附带项目名（project 作用域无需）
    let projectNameById: Map<string, string> | null = null;
    if (scope === 'all') {
      const { projects } = await listProjects();
      projectNameById = new Map(projects.map((p) => [p.id, p.name]));
    }
    const recentRows =
      scope === 'all'
        ? recent.map((r) => ({
            ...r,
            projectName: r.project_id ? (projectNameById?.get(r.project_id) ?? null) : null,
          }))
        : recent;

    return Response.json({
      meta: {
        // 只有 Web 工具调用（无 token 任务）时不算空账本
        empty: summary.totals.tasks === 0 && summary.webTools.length === 0,
        scope,
        projectId: project?.id ?? null,
        projectName: project ? basename(project.path) : undefined,
        costCurrency,
        range,
        window,
      },
      summary,
      recent: recentRows,
    });
  } catch (err) {
    console.warn('[usage] 查询失败:', err);
    return Response.json(
      { error: 'usage query failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** DELETE /api/usage —— 清零全部用量记录（全局账本 + 各项目本地，防迁移再导回） */
export async function DELETE() {
  try {
    await resetUsageLedger();
    return Response.json({ ok: true });
  } catch (err) {
    console.warn('[usage] 清零失败:', err);
    return Response.json(
      { error: 'usage reset failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
