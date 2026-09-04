import { NextRequest, NextResponse } from 'next/server';
import { listProjects } from '@/lib/project/project-manager';
import { promises as fs } from 'fs';
import { extname, join } from 'path';

/**
 * 项目文件静态代理（GET /api/project-files/<projectId>/<path...>）
 *
 * 用途：HtmlViewer 用 srcDoc 预览 HTML 时没有真实 URL，相对路径资源（<script src="./x.js">、
 * <link href="./style.css">）会解析到宿主应用地址导致加载失败。此端点把项目文件映射到
 * URL 路径，srcDoc 注入 <base href="/api/project-files/<projectId>/<目录>/"> 后，相对引用
 * 即可正确解析并通过本端点按正确 MIME 加载（JS/CSS 才会被浏览器执行）。
 * 同时相对链接（<a href="page2.html">）也可在本端点下真实跳转。
 *
 * 安全：join 后必须仍位于项目根内（防目录穿越）；仅 GET 只读，不落盘。
 */

/** 按扩展名给出浏览器可识别的 Content-Type（octet-stream 会导致 <script> 被拒绝执行） */
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; path: string[] }> },
): Promise<NextResponse> {
  const { projectId, path: segments } = await params;
  if (!projectId || !segments || segments.length === 0) {
    return new NextResponse('Missing path', { status: 400 });
  }

  const filePath = segments.map((s) => decodeURIComponent(s)).join('/');
  const { projects } = await listProjects();
  const project = projects.find((p: { id: string }) => p.id === projectId);
  if (!project) return new NextResponse('Project not found', { status: 404 });

  const fullPath = join(project.path, filePath);
  // 防目录穿越：解析后必须仍在项目根内
  if (!fullPath.startsWith(project.path)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  try {
    const [st, buf] = await Promise.all([fs.stat(fullPath), fs.readFile(fullPath)]);
    if (!st.isFile()) return new NextResponse('Not a file', { status: 404 });
    const ext = extname(fullPath).toLowerCase();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': String(st.size),
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new NextResponse('File not found', { status: 404 });
  }
}
