/**
 * GET /api/team/<teamId> — 团队详情（工作台主视图一次拉全）
 *
 * withResults: true —— 面板只回成员产出摘要，全文在任务表，须额外走 result_collect。
 * 全量拉取（打开工作台、刷新页面）才带全文与最近 50 条事件；增量靠 /stream。
 */
import type { NextRequest } from 'next/server';
import { buildTeamDetail, ensureTeamReady } from '@/lib/chat/team-client';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ready = await ensureTeamReady();
    if (!ready.ok) {
      return Response.json({ error: ready.error }, { status: 503 });
    }
    const detail = await buildTeamDetail(id, { withResults: true });
    return Response.json(detail);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
