/**
 * GET /api/team/list — 团队清单（工作台左侧列表）
 *
 * 只回概览计数，不回成员/任务明细：列表视图不渲染明细，逐个团队拉全量会让响应随团队数线性膨胀。
 * 单团队读取失败（如引擎正在装载）不应让整个清单失败，故用 allSettled 逐个兜底。
 */
import type { TeamDetail, TeamSummary } from '@/lib/types';
import { buildTeamDetail, ensureTeamReady, listTeamIds, summarizeTeam } from '@/lib/chat/team-client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ready = await ensureTeamReady();
    if (!ready.ok) {
      return Response.json({ teams: [], error: ready.error }, { status: 503 });
    }

    const ids = await listTeamIds();
    const settled = await Promise.allSettled(ids.map((id) => buildTeamDetail(id)));
    const teams: TeamSummary[] = settled
      .filter((r): r is PromiseFulfilledResult<TeamDetail> => r.status === 'fulfilled')
      .map((r) => summarizeTeam(r.value))
      // 最近有动静的排前面
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return Response.json({ teams });
  } catch (e) {
    return Response.json({ teams: [], error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
