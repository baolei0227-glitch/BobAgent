import { NextRequest, NextResponse } from 'next/server';
import { join } from 'path';
import { promises as fs } from 'fs';
import { PROJECT_DB_FILENAME } from '@/lib/app-root';
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
import { findNodeFileById, parseNodeMarkdown } from '@/lib/node-markdown';
import { markStaleCascade } from '@/lib/nodes/stale';

/** 获取数据库实例（基于当前项目路径） */
async function getDb() {
  const project = await getCurrentProject();
  if (!project) throw new Error('项目不存在');
  const dbPath = join(project.path, PROJECT_DB_FILENAME);
  return initDb(dbPath);
}

/** 断边/上游变更后级联标记下游 stale（含原因链，见 lib/nodes/stale.ts） */
async function markDownstreamStale(
  edge: { from_node_id: string; to_node_id: string },
  projectPath: string,
  projectId: string,
): Promise<void> {
  await markStaleCascade(
    [{
      nodeId: edge.to_node_id,
      upstreamId: edge.from_node_id,
      upstreamTitle: await nodeTitle(edge.from_node_id, projectPath),
      cause: 'edge-disconnected',
    }],
    { path: projectPath, id: projectId },
  );
}

/** 取节点标题（写进失效原因链，便于模型读懂）；读不到则用 id 兜底 */
async function nodeTitle(nodeId: string, projectPath: string): Promise<string> {
  try {
    const filePath = await findNodeFileById(nodeId, projectPath);
    if (!filePath) return nodeId;
    const node = parseNodeMarkdown(await fs.readFile(filePath, 'utf-8'));
    return node.frontmatter.title || nodeId;
  } catch {
    return nodeId;
  }
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

      // R-8: 未锁定节点不得建立出边（成果块是唯一向下传播的东西）
      // 例外：edge_type='bobby' 是「执行关联边」（Bobby 插件观察/授权节点），
      // 由主 Agent 调用对应插件工具时自动建立，非成果块传播，不适用锁定约束。
      const isBobbyEdge = edge_type === 'bobby';
      if (!isBobbyEdge) {
        const project = await getCurrentProject();
        const fromFile = await findNodeFileById(from, project.path);
        if (!fromFile) {
          return NextResponse.json(
            { success: false, error: '上游节点不存在: ' + from },
            { status: 400 },
          );
        }
        const fromContent = await fs.readFile(fromFile, 'utf-8');
        const fromNode = parseNodeMarkdown(fromContent);
        if (fromNode.frontmatter.outcome_status !== 'locked') {
          return NextResponse.json(
            { success: false, error: 'R-8 上游节点成果块尚未锁定，无法建立出边（请先锁定上游节点）' },
            { status: 400 },
          );
        }
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
      const project = await getCurrentProject();
      // 断开前查一下边信息，用于标记下游 stale
      const projectId = await getCurrentProjectId();
      const allEdges = await listActiveEdges(db, projectId);
      const target = allEdges.find((r) => r.edge_id === edge_id);
      await disconnectEdge(db, edge_id);

      // 标记下游节点为 stale（上游已断开，成果块不再可用；级联到更深下游并写下原因链）
      if (target && project) {
        await markDownstreamStale(target, project.path, projectId);
      }

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
      const project = await getCurrentProject();
      const projectId = await getCurrentProjectId();
      const allEdges = await listActiveEdges(db, projectId);
      const target = allEdges.find((r) => r.edge_id === edge_id);
      await deleteEdge(db, edge_id);

      // 标记下游节点为 stale（级联 + 原因链）
      if (target && project) {
        await markDownstreamStale(target, project.path, projectId);
      }

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
      const project = await getCurrentProject();
      const projectId = await getCurrentProjectId();
      const rows = await listActiveEdges(db, projectId);
      const target = rows.find(
        (r) => r.from_node_id === from && r.to_node_id === to,
      );

      if (target) {
        await disconnectEdge(db, target.edge_id);
        // 标记下游节点为 stale（级联 + 原因链）
        await markDownstreamStale(target, project.path, projectId);
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
