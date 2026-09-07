import { NextRequest, NextResponse } from 'next/server';
import { getProjectById, getCurrentProject } from '@/lib/project/project-manager';
import { readTrajectoryMessages } from '@/lib/trajectory/reader';

/**
 * GET /api/trajectory?node_id=<uuid>&task_id=<taskId>[&project_id=<id>]
 *
 * 只读恢复接口（P1/P2 事件溯源）：读取某节点某次任务的 .trajectory 事件日志，
 * 返回消息主干投影（messages）与可直接渲染序列（rendered），供对照/恢复/Trace 消费。
 * 无副作用；文件缺失或参数非法返回 404/400。
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const nodeId = sp.get('node_id')?.trim() || '';
  const taskId = sp.get('task_id')?.trim() || '';
  const projectId = sp.get('project_id')?.trim() || undefined;

  if (!nodeId || !taskId) {
    return NextResponse.json({ success: false, error: 'node_id and task_id are required' }, { status: 400 });
  }

  let project: { path: string } | null = null;
  try {
    project = projectId ? await getProjectById(projectId) : await getCurrentProject();
  } catch {
    project = null;
  }
  if (!project?.path) {
    return NextResponse.json({ success: false, error: 'project not found' }, { status: 404 });
  }

  const result = readTrajectoryMessages(project.path, nodeId, taskId);
  if (!result) {
    return NextResponse.json({ success: false, error: 'trajectory not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true, ...result });
}
