/**
 * 一次性旧画布便签清扫（Bob-Mind 拆分后的宿主遗留清理，2026-09-05）
 *
 * 背景：画布便签（node_type='note'，历史 'sticky'）已随 Bob-Mind 拆分从宿主移除。
 * 老项目 notes-memory/ 里仍存有这类 .md 与关联边。本清扫幂等：
 *   - 把命中 .md 备份进项目 .trash/nodes/（可经节点回收站恢复），再删除原文件
 *   - 同步删除其数据库关联边（deleteEdgesByNode）
 * 不动 notes-memory 中其它类型节点（AI chat/agent/annotation/homework 等）。
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { initDb, deleteEdgesByNode } from '@/lib/db';
import { PROJECT_DB_FILENAME } from '@/lib/app-root';
import { parseNodeMarkdown } from '@/lib/node-markdown';
import { listProjects } from '@/lib/project/project-manager';

/** 历史便签节点类型（frontmatter node_type）——本清扫的目标 */
const LEGACY_TYPES = new Set(['note', 'sticky']);

export async function purgeLegacyCanvasThoughts(): Promise<{ scannedProjects: number; purged: number }> {
  let scannedProjects = 0;
  let purged = 0;
  try {
    const { projects } = await listProjects();
    for (const p of projects) {
      if (!p || p.trashed) continue; // 垃圾桶项目不动
      try {
        purged += await purgeProject(join(p.path, 'notes-memory'), p.id, p.path);
        scannedProjects++;
      } catch (e) {
        console.warn('[purge] 项目便签清扫失败:', p.id, e instanceof Error ? e.message : String(e));
      }
    }
  } catch (e) {
    console.warn('[purge] 列项目失败:', e instanceof Error ? e.message : String(e));
  }
  if (purged > 0) console.info(`[purge] 旧画布便签清扫完成：命中并归档 ${purged} 个`);
  return { scannedProjects, purged };
}

async function purgeProject(nodesDir: string, projectId: string, projectPath: string): Promise<number> {
  let files: string[];
  try {
    files = await fs.readdir(nodesDir);
  } catch {
    return 0; // 无目录 = 无遗留
  }
  const targets = files.filter((f) => f.endsWith('.md') && f !== 'example_node.md');
  if (targets.length === 0) return 0;

  let purged = 0;
  for (const file of targets) {
    const abs = join(nodesDir, file);
    let raw = '';
    try {
      raw = await fs.readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    let nodeId = '';
    try {
      const parsed = parseNodeMarkdown(raw);
      const t = parsed.frontmatter.node_type;
      if (!LEGACY_TYPES.has(t ?? '')) continue; // 非旧画布便签，跳过
      nodeId = parsed.frontmatter.node_id || file.replace(/\.md$/, '');
    } catch {
      continue;
    }
    // 回收站备份后删除原文件
    try {
      const trashDir = join(projectPath, '.trash', 'nodes');
      await fs.mkdir(trashDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      await fs.writeFile(join(trashDir, `${nodeId}-${stamp}.md`), raw, 'utf-8');
    } catch (e) {
      console.warn('[purge] 回收站备份失败（不影响删除）:', e instanceof Error ? e.message : String(e));
    }
    await fs.unlink(abs).catch(() => {});
    // 删除数据库关联边
    try {
      const db = await initDb(join(projectPath, PROJECT_DB_FILENAME));
      await deleteEdgesByNode(db, projectId, nodeId);
    } catch (e) {
      console.warn('[purge] 删除关联边失败:', nodeId, e instanceof Error ? e.message : String(e));
    }
    purged++;
  }
  return purged;
}
