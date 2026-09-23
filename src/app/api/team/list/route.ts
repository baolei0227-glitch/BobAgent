/**
 * GET /api/team/list — 团队清单（工作台左侧列表）
 *
 * 走引擎的 team_overview：单次调用回全部团队的标量（名称/目标/状态/计数/草案有无），
 * 不逐个拉 team_status 全量面板 —— 清单不渲染成员/邮箱/事件流，全量拉会让响应随
 * 「团队数 × 明细体积」线性膨胀。工作台凭 status + planDraft 判断哪些草案还能恢复。
 */
import type { TeamSummary } from '@/lib/types';
import { ensureTeamReady, listTeamOverviews } from '@/lib/chat/team-client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ready = await ensureTeamReady();
    if (!ready.ok) {
      return Response.json({ teams: [], error: ready.error }, { status: 503 });
    }

    const teams: TeamSummary[] = await listTeamOverviews();
    return Response.json({ teams });
  } catch (e) {
    return Response.json({ teams: [], error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}