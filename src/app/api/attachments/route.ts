import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, extname, basename } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';
import { randomUUID } from 'crypto';

export const maxDuration = 60;

const MAX_SIZE = 500 * 1024 * 1024;

function getAttachmentType(mimeType: string, filename: string): 'image' | 'text' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('text/') || ['.md', '.txt', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.py', '.java', '.cpp', '.c', '.go', '.rs', '.yaml', '.yml'].includes(extname(filename).toLowerCase())) {
    return 'text';
  }
  return 'file';
}

export async function POST(request: NextRequest) {
  try {
    const project = await getCurrentProject();
    const projectPath = project.path;

    // 优先尝试 JSON（Turbopack 兼容），回退到 FormData
    const contentType = request.headers.get('content-type') || '';
    let nodeId: string;
    let fileName: string;
    let fileType: string;
    let buffer: Buffer;

    if (contentType.includes('application/json')) {
      const body = await request.json();
      nodeId = body.nodeId;
      fileName = body.fileName;
      fileType = body.fileType || 'application/octet-stream';
      buffer = Buffer.from(body.data, 'base64');
    } else {
      const formData = await request.formData();
      nodeId = formData.get('nodeId') as string;
      const file = formData.get('file') as File | null;
      if (!file) {
        return NextResponse.json({ error: 'file is required' }, { status: 400 });
      }
      fileName = file.name;
      fileType = file.type || 'application/octet-stream';
      buffer = Buffer.from(await file.arrayBuffer());
    }

    if (!nodeId || !fileName) {
      return NextResponse.json({ error: 'nodeId and fileName are required' }, { status: 400 });
    }

    if (buffer.length > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    const assetsDir = join(projectPath, 'assets', nodeId);
    await fs.mkdir(assetsDir, { recursive: true });

    const fileId = randomUUID();
    const safeName = basename(fileName).replace(/[\\/:*?"<>|\n\r\t]/g, '_');
    const destName = `${fileId}_${safeName}`;
    const filePath = join(assetsDir, destName);

    await fs.writeFile(filePath, buffer);

    const type = getAttachmentType(fileType, fileName);
    const relativePath = `assets/${nodeId}/${destName}`;

    let dataUrl: string | undefined;
    if (buffer.length < 2 * 1024 * 1024) {
      const base64 = buffer.toString('base64');
      dataUrl = `data:${fileType};base64,${base64}`;
    }

    return NextResponse.json({
      success: true,
      attachment: {
        id: fileId,
        name: fileName,
        type,
        mimeType: fileType,
        size: buffer.length,
        path: relativePath,
        dataUrl,
      },
    });
  } catch (e) {
    console.error('附件上传失败:', e);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const project = await getCurrentProject();
    const projectPath = project.path;

    const { searchParams } = new URL(request.url);
    const path = searchParams.get('path');

    if (!path) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }

    const filePath = join(projectPath, path);

    const content = await fs.readFile(filePath);
    const ext = extname(filePath).toLowerCase();

    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
    };

    const mimeType = mimeMap[ext] || 'application/octet-stream';

    return new NextResponse(content, {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
