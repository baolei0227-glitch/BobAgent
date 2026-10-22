import { NextRequest } from 'next/server';
import { extname } from 'path';
import { readAppFile } from '@/lib/sandbox/apps';
import { buildBridgeClientScript } from '@/lib/sandbox/bridge';
import { isSandboxFullTrustServer } from '@/lib/settings-server';
import { guardRequestSource } from '@/lib/http/loopback-guard';
import { buildConsoleCaptureInjection, buildPreviewInteractionPatchInjection } from '../route';

/** 常见 Web 文件扩展名 → Content-Type 映射 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

/**
 * 小程序静态文件服务：按相对路径返回小程序目录内的任意文件。
 * 与 preview 入口路由配合——入口 HTML 中注入了 <base href="/api/sandbox/preview/<id>/">，
 * 因此 <link href="css/style.css"> 等相对引用会自动解析到本路由。
 *
 * GET /api/sandbox/preview/<appId>/<path...>
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  // 只读静态资源：app 入口在 sandbox iframe（opaque origin）里加载，浏览器会把子资源判成
  // cross-site；这里只放行 GET/HEAD，写操作仍由其它沙箱路由严格拦截。
  const denied = await guardRequestSource(request, { allowCrossSiteRead: true });
  if (denied) return denied;
  try {
    const { id, path: pathSegments } = await params;

    // 拒绝访问内部目录/私有数据：历史、Layer-1 快照、回收站、Layer-2 磁盘数据、清单。
    // 静态预览只服务页面、脚本、样式、图片等资源；这些目录不属于 app 资源。
    const blockedRoot = pathSegments[0];
    if (
      blockedRoot === '.history' ||
      blockedRoot === '.state' ||
      blockedRoot === '.trash' ||
      blockedRoot === 'data' ||
      blockedRoot === 'manifest.json'
    ) {
      return new Response('Not Found', { status: 404 });
    }

    const relPath = pathSegments.join('/');
    const content = await readAppFile(id, relPath);
    if (!content) {
      return new Response('Not Found', { status: 404 });
    }

    const ext = extname(relPath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

    // HTML 预览页与入口页一致：注入 bridge + console 捕获。
    // （AI 徽标已随「放开小程序权限」移除：权限默认开放，预览页不再有任何授权入口/图标。）
    if (ext === '.html') {
      let html = content.toString('utf-8');
      try {
        // console捕获 + 交互补丁注入到 head（尽早执行）；bridge 脚本放 body 末尾
        const headPatch = buildConsoleCaptureInjection(id) + buildPreviewInteractionPatchInjection();
        html = html.includes('</head>')
          ? html.replace('</head>', headPatch + '</head>')
          : html + headPatch;
        const bodyPatch = buildBridgeClientScript(id, { fullTrust: await isSandboxFullTrustServer().catch(() => true) });
        html = html.includes('</body>')
          ? html.replace('</body>', bodyPatch + '</body>')
          : html + bodyPatch;
      } catch {
        /* 注入失败仍返回原始文件 */
      }
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          // 与入口预览页一致：只允许**回环 origin** 内嵌（宿主 UI 的 localhost 与预览的 127.0.0.1
          // 是不同 origin，方案 B 的应用内 iframe 需要这条白名单；跨站仍被拦）
          'Content-Security-Policy': "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*",
          'Referrer-Policy': 'no-referrer-when-downgrade',
        },
      });
    }

    return new Response(new Uint8Array(content), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    return new Response(`Error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
}
