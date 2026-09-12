import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { extname, join } from 'path';
import { readSettingsFromFile } from '@/lib/settings-server';
import { resolveStaticPanelDir } from '@/lib/plugin-panels-server';

/**
 * 插件面板静态代理（GET /api/plugin-panel/<pluginId>/<path...>）
 *
 * 服务 mode=static 的插件面板：宿主把插件随包静态目录映射为 URL，iframe 直接加载，
 * 不依赖插件自起端口（零端口占用、无 --serve 孤儿进程问题）。
 * 安全与缓存策略对齐 /api/project-files：逐段 decode → join → 前缀校验防目录穿越；
 * 仅 GET 只读。
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
  '.wasm': 'application/wasm',
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pluginId: string; path: string[] }> },
): Promise<NextResponse> {
  const { pluginId, path: segments } = await params;
  if (!pluginId || !segments || segments.length === 0) {
    return new NextResponse('Missing path', { status: 400 });
  }

  // 静态代理只服务「启用中且声明 mode=static 面板」的插件
  const settings = await readSettingsFromFile();
  const cfg = settings.mcpServers?.find((c) => c.id === pluginId && c.enabled);
  if (!cfg) return new NextResponse('Plugin panel not found', { status: 404 });
  const rootDir = resolveStaticPanelDir(cfg);
  if (!rootDir) return new NextResponse('Plugin has no static panel', { status: 404 });

  const filePath = segments.map((s) => decodeURIComponent(s)).join('/');
  const fullPath = join(rootDir, filePath);
  if (!fullPath.startsWith(rootDir)) {
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
