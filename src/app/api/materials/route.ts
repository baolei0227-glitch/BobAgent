import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, extname, basename } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';
import { randomUUID } from 'crypto';

const MAX_SIZE = 500 * 1024 * 1024;

interface MaterialFile {
  id: string;
  name: string;
  path: string;
  size: number;
  extension: string;
  type: 'image' | 'text' | 'pdf' | 'file';
  uploadedAt: string;
}

async function listMaterials(projectPath: string): Promise<MaterialFile[]> {
  const materialsPath = join(projectPath, 'materials');
  await fs.mkdir(materialsPath, { recursive: true });

  const entries = await fs.readdir(materialsPath, { withFileTypes: true });
  const files: MaterialFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = join(materialsPath, entry.name);
    const stat = await fs.stat(filePath);
    const ext = extname(entry.name).toLowerCase();
    const idMatch = entry.name.match(/^([a-f0-9-]+)_/);

    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];
    const textExts = ['.md', '.txt', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.cpp', '.go', '.yaml', '.yml'];
    let fileType: MaterialFile['type'] = 'file';
    if (imageExts.includes(ext)) fileType = 'image';
    else if (ext === '.pdf') fileType = 'pdf';
    else if (textExts.includes(ext)) fileType = 'text';

    files.push({
      id: idMatch ? idMatch[1] : entry.name,
      name: entry.name.replace(/^[a-f0-9-]+_/, ''),
      path: `materials/${entry.name}`,
      size: stat.size,
      extension: ext,
      type: fileType,
      uploadedAt: stat.mtime.toISOString(),
    });
  }

  return files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'list';

    const project = await getCurrentProject();
    const projectPath = project.path;

    if (action === 'list') {
      const files = await listMaterials(projectPath);
      return NextResponse.json({ success: true, files });
    }

    if (action === 'read') {
      const filePath = searchParams.get('path');
      if (!filePath) {
        return NextResponse.json({ error: 'path is required' }, { status: 400 });
      }
      const fullPath = join(projectPath, filePath);
      if (!fullPath.startsWith(join(projectPath, 'materials'))) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
      }

      const content = await fs.readFile(fullPath);
      const ext = extname(fullPath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
        '.json': 'application/json', '.csv': 'text/csv',
      };
      const mimeType = mimeMap[ext] || 'application/octet-stream';

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

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    const materialsPath = join(projectPath, 'materials');
    await fs.mkdir(materialsPath, { recursive: true });

    const fileId = randomUUID();
    const safeName = basename(file.name).replace(/[\\/:*?"<>|\n\r\t]/g, '_');
    const fileName = `${fileId}_${safeName}`;
    const filePath = join(materialsPath, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    const ext = extname(file.name).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];
    const textExts = ['.md', '.txt', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.cpp', '.go', '.yaml', '.yml'];
    let fileType: string = 'file';
    if (imageExts.includes(ext)) fileType = 'image';
    else if (ext === '.pdf') fileType = 'pdf';
    else if (textExts.includes(ext)) fileType = 'text';

    const stat = await fs.stat(filePath);

    return NextResponse.json({
      success: true,
      file: {
        id: fileId,
        name: file.name,
        path: `materials/${fileName}`,
        size: stat.size,
        extension: ext,
        type: fileType,
        uploadedAt: stat.mtime.toISOString(),
      },
    });
  } catch (e) {
    console.error('Materials upload failed:', e);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
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

    const fullPath = join(projectPath, filePath);
    if (!fullPath.startsWith(join(projectPath, 'materials'))) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
    }

    await fs.unlink(fullPath);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
