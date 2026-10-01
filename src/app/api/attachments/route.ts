import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { join, extname, basename, resolve } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';
import { getAttachmentType } from '@/lib/files/attachment-type';

export const maxDuration = 60;

const MAX_SIZE = 500 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const project = await getCurrentProject();
    const projectPath = project.path;

    // 优先尝试 JSON（Turbopack 兼容），回退到 FormData
    const contentType = request.headers.get('content-type') || '';

    let nodeId: string;
    let nodeTitle = "";
    let fileName: string;
    let fileType: string;
    let buffer: Buffer;

    // 特殊动作：从本地路径复制文件到节点附件目录
    if (contentType.includes('application/json')) {
      const body = await request.json();
      if (body.action === 'add_from_local' && body.sourcePath) {
        return await addFromLocal(body, projectPath);
      }
      nodeId = body.nodeId;
      nodeTitle = body.nodeTitle || '';
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

    // 用短 UUID + 标题命名文件夹，便于辨认
    const shortId = nodeId.slice(0, 4);
    const safeTitle = nodeTitle
      ? nodeTitle.replace(/[\/:*?"<>|]/g, '_').slice(0, 30).trim()
      : '';
    const assetFolderName = safeTitle ? `${shortId}_${safeTitle}` : nodeId;

    if (buffer.length > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    // 所有附件统一存放在 materials/ 下（附件即项目资料），目录名保留「短 id + 标题」便于辨认
    const attachmentsDir = join(projectPath, 'materials', assetFolderName);
    await fs.mkdir(attachmentsDir, { recursive: true });

    const safeName = basename(fileName).replace(/[\\/:*?"<>|\n\r\t]/g, '_');
    const ext = extname(safeName);
    const base = safeName.slice(0, safeName.length - ext.length);

    // 冲突时加数字后缀，如 name.ext -> name (1).ext
    let destName = safeName;
    let counter = 1;
    while (true) {
      try {
        await fs.access(join(attachmentsDir, destName));
        destName = `${base} (${counter})${ext}`;
        counter++;
      } catch {
        break;
      }
    }
    const filePath = join(attachmentsDir, destName);

    await fs.writeFile(filePath, buffer);

    const type = getAttachmentType(fileType, fileName);
    const relativePath = `materials/${assetFolderName}/${destName}`;

    let dataUrl: string | undefined;
    if (buffer.length < 2 * 1024 * 1024) {
      const base64 = buffer.toString('base64');
      dataUrl = `data:${fileType};base64,${base64}`;
    }

    return NextResponse.json({
      success: true,
      attachment: {
        id: destName,
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
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.m4v': 'video/x-m4v',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
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

/** 从本地路径复制文件到节点附件目录 */
async function addFromLocal(
  body: { sourcePath: string; nodeId: string; nodeTitle?: string },
  projectPath: string,
) {
  const { sourcePath, nodeId, nodeTitle = '' } = body;

  if (!nodeId) {
    return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
  }

  const resolvedSource = resolve(sourcePath);

  // 校验源文件存在且是文件
  let sourceStat;
  try {
    sourceStat = await fs.stat(resolvedSource);
    if (!sourceStat.isFile()) {
      return NextResponse.json({ error: 'Source path is not a file' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Source file not found' }, { status: 404 });
  }

  if (sourceStat.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
  }

  const shortId = nodeId.slice(0, 4);
  const safeTitle = nodeTitle
    ? nodeTitle.replace(/[\/:*?"<>|]/g, '_').slice(0, 30).trim()
    : '';
  const assetFolderName = safeTitle ? `${shortId}_${safeTitle}` : nodeId;

  const attachmentsDir = join(projectPath, 'materials', assetFolderName);
  await fs.mkdir(attachmentsDir, { recursive: true });

  const originalName = basename(resolvedSource);
  const safeName = originalName.replace(/[\\/:*?"<>|\n\r\t]/g, '_');
  const ext = extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);

  // 冲突时加数字后缀
  let destName = safeName;
  let counter = 1;
  while (true) {
    try {
      await fs.access(join(attachmentsDir, destName));
      destName = `${base} (${counter})${ext}`;
      counter++;
    } catch {
      break;
    }
  }

  const destPath = join(attachmentsDir, destName);
  await fs.copyFile(resolvedSource, destPath);

  const fileType = extToMimeType(ext);
  const type = getAttachmentType(fileType, originalName);
  const relativePath = `materials/${assetFolderName}/${destName}`;

  // 小图片生成 dataUrl
  let dataUrl: string | undefined;
  if (sourceStat.size < 2 * 1024 * 1024) {
    try {
      const buffer = await fs.readFile(destPath);
      const base64 = buffer.toString('base64');
      dataUrl = `data:${fileType};base64,${base64}`;
    } catch { /* ignore */ }
  }

  return NextResponse.json({
    success: true,
    attachment: {
      id: destName,
      name: originalName,
      type,
      mimeType: fileType,
      size: sourceStat.size,
      path: relativePath,
      dataUrl,
    },
  });
}

/** 扩展名转 mimeType（本地复制时文件无 type 信息） */
function extToMimeType(ext: string): string {
  const map: Record<string, string> = {
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
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.py': 'text/x-python',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}
