import { NextRequest, NextResponse } from 'next/server';
import { getCurrentProject, getProjectById } from '@/lib/project/project-manager';
import { collectProjectActivity, ACTIVITY_KINDS, type ActivityKind } from '@/lib/project/activity';

/**
 * GET /api/projects/activity
 * 项目流水账：按日期分组的只读派生聚合。
 *
 * Query:
 *   project_id  项目 id（缺省 = 当前项目）
 *   order       asc | desc（缺省 desc）
 *   kind        逗号分隔的类型过滤（project,task,attachment,document,lifecycle）
 *   cursor      偏移游标（上一页的 nextCursor，缺省 0）
 *   limit       每页条数（缺省 100，上限 500）
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const order = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
    const kindParam = searchParams.get('kind');
    const cursor = Number.parseInt(searchParams.get('cursor') || '0', 10);
    const limit = Number.parseInt(searchParams.get('limit') || '', 10);

    const kinds = kindParam
      ? (kindParam.split(',').map((k) => k.trim()).filter((k): k is ActivityKind => (ACTIVITY_KINDS as string[]).includes(k)))
      : undefined;

    const project = projectId ? await getProjectById(projectId) : await getCurrentProject();

    const result = await collectProjectActivity(project, {
      order,
      kinds,
      cursor: Number.isFinite(cursor) ? cursor : 0,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return NextResponse.json({ project_id: project.id, order, ...result });
  } catch (error) {
    if (error instanceof Error && error.message === 'NO_PROJECT') {
      return NextResponse.json({ error: 'NO_PROJECT' }, { status: 404 });
    }
    console.error('[projects/activity] 聚合失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取项目日志失败' },
      { status: 500 },
    );
  }
}
