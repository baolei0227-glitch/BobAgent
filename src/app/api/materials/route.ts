import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, extname, basename } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';

const MAX_SIZE = 500 * 1024 * 1024;

interface MaterialTreeNode {
  name: string;
  type: 'file' | 'directory';
  children?: MaterialTreeNode[];
  size?: number;
  extension?: string;
  mimeType?: string;
  path: string;
  uploadedAt?: string;
}

function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.csv': 'text/csv',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

async function scanMaterialsTree(dirPath: string, prefix: string, maxDepth: number): Promise<MaterialTreeNode[]> {
  if (maxDepth <= 0) return [];

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: MaterialTreeNode[] = [];

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const fullPath = join(dirPath, entry.name);
    const relPath = prefix ? prefix + '/' + entry.name : entry.name;

    if (entry.isDirectory()) {
      const children = await scanMaterialsTree(fullPath, relPath, maxDepth - 1);
      nodes.push({
        name: entry.name,
        type: 'directory',
        path: relPath,
        children: children.length > 0 ? children : [],
      });
    } else {
      const stat = await fs.stat(fullPath);
      const ext = extname(entry.name).toLowerCase();
      const displayName = entry.name.replace(/^[a-f0-9-]+_/, '');

      nodes.push({
        name: displayName,
        type: 'file',
        path: relPath,
        size: stat.size,
        extension: ext,
        mimeType: getMimeType(ext),
        uploadedAt: stat.mtime.toISOString(),
      });
    }
  }

  return nodes;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'list';

    const project = await getCurrentProject();
    const projectPath = project.path;

    if (action === 'list') {
      const materialsPath = join(projectPath, 'materials');
      await fs.mkdir(materialsPath, { recursive: true });
      const tree = await scanMaterialsTree(materialsPath, '', 3);
      return NextResponse.json({ success: true, tree });
    }

    if (action === 'read') {
      const filePath = searchParams.get('path');
      if (!filePath) {
        return NextResponse.json({ error: 'path is required' }, { status: 400 });
      }
      const fullPath = join(projectPath, 'materials', filePath);
      if (!fullPath.startsWith(join(projectPath, 'materials'))) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
      }

      const content = await fs.readFile(fullPath);
      const ext = extname(fullPath).toLowerCase();
      const mimeType = getMimeType(ext);

      return new NextResponse(content, {
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const project = await getCurrentProject();
    const projectPath = project.path;
    const materialsPath = join(projectPath, 'materials');
    await fs.mkdir(materialsPath, { recursive: true });

    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const body = await request.json();
      const action = body.action;

      if (action === 'create_folder') {
        const folderPath = body.folderPath || '';
        if (!folderPath.trim()) {
          return NextResponse.json({ error: 'folderPath is required' }, { status: 400 });
        }
        const safeName = folderPath.replace(/\.\./g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!safeName) {
          return NextResponse.json({ error: 'Invalid folder name' }, { status: 400 });
        }
        const targetPath = join(materialsPath, safeName);
        await fs.mkdir(targetPath, { recursive: true });
        return NextResponse.json({ success: true, path: safeName });
      }

      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    const folder = (formData.get('folder') as string) || '';
    let targetDir = materialsPath;
    if (folder) {
      const safeFolder = folder.replace(/\.\./g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
      targetDir = join(materialsPath, safeFolder);
      await fs.mkdir(targetDir, { recursive: true });
    }

    const fileName = basename(file.name).replace(/[\\/:*?"<>|\n\r\t]/g, '_');
    const filePath = join(targetDir, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    const ext = extname(file.name).toLowerCase();
    const stat = await fs.stat(filePath);

    const relPath = folder ? folder + '/' + fileName : fileName;

    return NextResponse.json({
      success: true,
      file: {
        name: file.name,
        path: relPath,
        size: stat.size,
        extension: ext,
        uploadedAt: stat.mtime.toISOString(),
      },
    });
  } catch (e) {
    console.error('Materials operation failed:', e);
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const project = await getCurrentProject();
    const projectPath = project.path;

    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    const fullPath = join(projectPath, 'materials', filePath);
    if (!fullPath.startsWith(join(projectPath, 'materials'))) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
    }

    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      await fs.rm(fullPath, { recursive: true });
    } else {
      await fs.unlink(fullPath);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
