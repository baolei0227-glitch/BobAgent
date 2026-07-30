import { NextRequest, NextResponse } from 'next/server';
import {
  listProjects,
  getCurrentProject,
  createProject,
  switchProject,
  deleteProject,
  renameProject,
  archiveProject,
  unarchiveProject,
  getProjectStats,
  getProjectVisionModel,
  setProjectVisionModel,
  getProjectVisionApiKey,
  setProjectVisionApiKey,
  getProjectVisionBaseUrl,
  setProjectVisionBaseUrl,
  type ProjectConfig,
} from '@/lib/project/project-manager';
import { promises as fs } from 'fs';
import { join, relative, extname } from 'path';
import { statSync } from 'fs';

interface FileNode {
  name: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  extension?: string;
}

/** 递归扫描目录，返回文件树（最大深度3层，跳过隐藏文件、node_modules 和 .db） */
async function scanDirectory(dirPath: string, maxDepth = 3): Promise<FileNode[]> {
  const result: FileNode[] = [];
  if (maxDepth <= 0) return result;

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return result;
  }

  // 目录优先，然后按名称排序
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (!entry.isDirectory() && entry.name.endsWith('.db')) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const children = await scanDirectory(fullPath, maxDepth - 1);
      result.push({ name: entry.name, type: 'directory', children });
    } else {
      const ext = extname(entry.name).toLowerCase();
      result.push({ name: entry.name, type: 'file', extension: ext });
    }
  }

  return result;
}

/** GET: 获取项目列表或当前项目 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');

    // PDF 等二进制文件的代理流
    if (action === 'file_proxy') {
      const projectId = searchParams.get('project_id');
      const filePath = searchParams.get('file_path');
      if (!projectId || !filePath) {
        return new NextResponse('Missing params', { status: 400 });
      }
      const { projects } = await listProjects();
      const project = projects.find((p: ProjectConfig) => p.id === projectId);
      if (!project) {
        return new NextResponse('Project not found', { status: 404 });
      }
      const fullPath = join(project.path, filePath);
      if (!fullPath.startsWith(project.path)) {
        return new NextResponse('Forbidden', { status: 403 });
      }

      try {
        const stat = await fs.stat(fullPath);
        const buffer = await fs.readFile(fullPath);
        const ext = extname(fullPath).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.pdf': 'application/pdf',
        };
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            'Content-Type': mimeMap[ext] || 'application/octet-stream',
            'Content-Length': String(stat.size),
            'Cache-Control': 'public, max-age=3600',
          },
        });
      } catch {
        return new NextResponse('File not found', { status: 404 });
      }
    }

    if (action === 'current') {
      const current = await getCurrentProject();
      return NextResponse.json({ success: true, project: current });
    }

    if (action === 'stats') {
      const projectId = searchParams.get('project_id');
      if (!projectId) {
        return NextResponse.json({ success: false, error: 'project_id is required' }, { status: 400 });
      }
      const stats = await getProjectStats(projectId);
      return NextResponse.json({ success: true, stats });
    }

    // 默认返回项目列表（含分组）
    const result = await listProjects();
    return NextResponse.json({
      success: true,
      projects: result.projects,
      active_projects: result.active_projects,
      archived_projects: result.archived_projects,
      current_id: result.currentId,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** POST: 创建/切换/删除/重命名项目 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'create') {
      const { name } = body;
      if (!name || !name.trim()) {
        return NextResponse.json(
          { success: false, error: 'name is required' },
          { status: 400 },
        );
      }
      const project = await createProject(name.trim());
      return NextResponse.json({ success: true, project });
    }

    if (action === 'switch') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      const project = await switchProject(project_id);
      return NextResponse.json({ success: true, project });
    }

    if (action === 'delete') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      await deleteProject(project_id);
      return NextResponse.json({ success: true });
    }

    if (action === 'rename') {
      const { project_id, new_name } = body;
      if (!project_id || !new_name || !new_name.trim()) {
        return NextResponse.json(
          { success: false, error: 'project_id 和 new_name 不能为空' },
          { status: 400 },
        );
      }
      const project = await renameProject(project_id, new_name.trim());
      return NextResponse.json({ success: true, project });
    }

    if (action === 'archive') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json({ success: false, error: 'project_id is required' }, { status: 400 });
      }
      const project = await archiveProject(project_id);
      return NextResponse.json({ success: true, project });
    }

    if (action === 'unarchive') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json({ success: false, error: 'project_id is required' }, { status: 400 });
      }
      const project = await unarchiveProject(project_id);
      return NextResponse.json({ success: true, project });
    }

    if (action === 'get_vision_config') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      const model = await getProjectVisionModel(project_id);
      const apiKey = await getProjectVisionApiKey(project_id);
      const baseUrl = await getProjectVisionBaseUrl(project_id);
      return NextResponse.json({ success: true, model, api_key: apiKey, base_url: baseUrl });
    }

    if (action === 'set_vision_config') {
      const { project_id, model, api_key, base_url } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      if (model) {
        await setProjectVisionModel(project_id, model);
      }
      if (api_key !== undefined) {
        await setProjectVisionApiKey(project_id, api_key);
      }
      if (base_url !== undefined) {
        await setProjectVisionBaseUrl(project_id, base_url);
      }
      return NextResponse.json({ success: true });
    }

    if (action === 'list_files') {
      const { project_id } = body;
      if (!project_id) {
        return NextResponse.json(
          { success: false, error: 'project_id is required' },
          { status: 400 },
        );
      }
      const { projects } = await listProjects();
      const project = projects.find((p: ProjectConfig) => p.id === project_id);
      if (!project) {
        return NextResponse.json(
          { success: false, error: 'Project not found' },
          { status: 404 },
        );
      }
      const tree = await scanDirectory(project.path);
      return NextResponse.json({ success: true, files: tree, project_path: project.path });
    }

    if (action === 'read_file') {
      const { project_id, file_path } = body;
      if (!project_id || !file_path) {
        return NextResponse.json(
          { success: false, error: 'project_id and file_path are required' },
          { status: 400 },
        );
      }
      const { projects } = await listProjects();
      const project = projects.find((p: ProjectConfig) => p.id === project_id);
      if (!project) {
        return NextResponse.json(
          { success: false, error: 'Project not found' },
          { status: 404 },
        );
      }
      const fullPath = join(project.path, file_path);
      if (!fullPath.startsWith(project.path)) {
        return NextResponse.json(
          { success: false, error: 'Invalid file path' },
          { status: 403 },
        );
      }

      const ext = extname(fullPath).toLowerCase();
      const textExts = new Set([
        '.md', '.txt', '.json', '.csv', '.xml', '.html', '.css',
        '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c',
        '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log',
        '.env', '.sh', '.bash', '.zsh',
      ]);
      const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

      try {
        if (textExts.has(ext)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          const stat = await fs.stat(fullPath);
          return NextResponse.json({
            success: true,
            type: 'text',
            content,
            size: stat.size,
            extension: ext,
            name: file_path.split('/').pop() || file_path,
            full_path: fullPath,
          });
        }

        if (imageExts.has(ext)) {
          const buffer = await fs.readFile(fullPath);
          const base64 = buffer.toString('base64');
          const mimeMap: Record<string, string> = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
            '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
          };
          return NextResponse.json({
            success: true,
            type: 'image',
            content: `data:${mimeMap[ext] || 'application/octet-stream'};base64,${base64}`,
            size: buffer.length,
            extension: ext,
            name: file_path.split('/').pop() || file_path,
            full_path: fullPath,
          });
        }

        // 其他二进制文件
        const stat = await fs.stat(fullPath);
        return NextResponse.json({
          success: true,
          type: 'binary',
          size: stat.size,
          extension: ext,
          name: file_path.split('/').pop() || file_path,
          full_path: fullPath,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('ENOENT')) {
          return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
        }
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
      }
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
