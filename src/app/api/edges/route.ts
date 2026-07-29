import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import {
  initDb,
  createEdge,
  deleteEdge,
  disconnectEdge,
  reconnectEdge,
  listActiveEdges,
  listEdges,
  type EdgeRow,
} from '@/lib/db';
import { wouldCreateCycle, type EdgeInfo } from '@/lib/edge/cycle-detector';
import { getCurrentProject } from '@/lib/project/project-manager';

/** 获取数据库实例（基于当前项目路径） */
async function getDb() {
  const project = await getCurrentProject();
  const dbPath = join(project.path, 'project.db');
  return await initDb(dbPath);
}

/** 获取当前项目 ID（作为 edges 表的 project_id） */
async function getCurrentProjectId(): Promise<string> {
  const project = await getCurrentProject();
  return project.id;
}

/** 将 EdgeRow 转换为前端使用的格式 */
function edgeRowToFrontend(row: EdgeRow) {
  return {
    edge_id: row.edge_id,
    from: row.from_node_id,
    to: row.to_node_id,
    edge_type: row.edge_type,
    disconnected: row.disconnected_at !== null,
    created_at: row.created_at,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const includeDisconnected = searchParams.get('include_disconnected') === 'true';

    const db = await getDb();
    const projectId = await getCurrentProjectId();
    const rows = includeDisconnected
      ? await listEdges(db, projectId)
      : await listActiveEdges(db, projectId);

    return NextResponse.json({
      success: true,
      edges: rows.map(edgeRowToFrontend),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'create') {
      const { from, to, edge_type } = body;

      if (!from || !to) {
        return NextResponse.json(
          { success: false, error: '缺少 from 或 to 参数' },
          { status: 400 },
        );
      }

      // 防环检测
      const db = await getDb();
      const projectId = await getCurrentProjectId();
      const existingRows = await listActiveEdges(db, projectId);
      const existingEdges: EdgeInfo[] = existingRows.map((r) => ({
        from: r.from_node_id,
        to: r.to_node_id,
      }));

      if (wouldCreateCycle(existingEdges, from, to)) {
        return NextResponse.json(
          { success: false, error: '创建此连线会形成循环依赖' },
          { status: 400 },
        );
      }

      // 检查是否已存在相同连线
      const duplicate = existingRows.find(
        (r) => r.from_node_id === from && r.to_node_id === to,
      );
      if (duplicate) {
        return NextResponse.json({
          success: true,
          edge: edgeRowToFrontend(duplicate),
          message: '连线已存在',
        });
      }

      const edgeId = await createEdge(db, {
        project_id: projectId,
        from_node_id: from,
        to_node_id: to,
        edge_type: edge_type || 'parallel',
      });

      const rows = await listActiveEdges(db, projectId);
      const created = rows.find((r) => r.edge_id === edgeId);

      return NextResponse.json({
        success: true,
        edge: created ? edgeRowToFrontend(created) : null,
      });
    }

    if (action === 'delete') {
      // 软删除：标记 disconnected_at，保留连线记录（用于断线显示）
      const { edge_id } = body;
      if (!edge_id) {
        return NextResponse.json(
          { success: false, error: '缺少 edge_id 参数' },
          { status: 400 },
        );
      }

      const db = await getDb();
      await disconnectEdge(db, edge_id);

      return NextResponse.json({ success: true, disconnected: true });
    }

    if (action === 'reconnect') {
      // 重连：清除 disconnected_at，恢复为活跃连线
      const { edge_id } = body;
      if (!edge_id) {
        return NextResponse.json(
          { success: false, error: '缺少 edge_id 参数' },
          { status: 400 },
        );
      }

      const db = await getDb();
      await reconnectEdge(db, edge_id);

      return NextResponse.json({ success: true, reconnected: true });
    }

    if (action === 'hard_delete') {
      // 硬删除：从数据库彻底移除连线记录
      const { edge_id } = body;
      if (!edge_id) {
        return NextResponse.json(
          { success: false, error: '缺少 edge_id 参数' },
          { status: 400 },
        );
      }

      const db = await getDb();
      await deleteEdge(db, edge_id);

      return NextResponse.json({ success: true });
    }

    if (action === 'delete_by_nodes') {
      const { from, to } = body;
      if (!from || !to) {
        return NextResponse.json(
          { success: false, error: '缺少 from 或 to 参数' },
          { status: 400 },
        );
      }

      const db = await getDb();
      const projectId = await getCurrentProjectId();
      const rows = await listActiveEdges(db, projectId);
      const target = rows.find(
        (r) => r.from_node_id === from && r.to_node_id === to,
      );

      if (target) {
        await disconnectEdge(db, target.edge_id);
      }

      return NextResponse.json({ success: true, disconnected: true });
    }

    return NextResponse.json(
      { success: false, error: `未知 action: ${action}` },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
