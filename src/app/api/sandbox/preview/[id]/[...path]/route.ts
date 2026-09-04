import { NextRequest } from 'next/server';
import { extname } from 'path';
import { readAppFile, readAppEntry } from '@/lib/sandbox/apps';
import { buildBridgeClientScript } from '@/lib/sandbox/bridge';
import { getSandboxChatPermission } from '@/lib/settings';
import { buildAiBadgeInjection, buildConsoleCaptureInjection, buildPreviewInteractionPatchInjection } from '../route';

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
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  try {
    const { id, path: pathSegments } = await params;

    // 拒绝访问内部 .history/ 目录
    if (pathSegments[0] === '.history') {
      return new Response('Not Found', { status: 404 });
    }

    const relPath = pathSegments.join('/');
    const content = await readAppFile(id, relPath);
    if (!content) {
      return new Response('Not Found', { status: 404 });
    }

    const ext = extname(relPath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

    // HTML 预览页与入口页一致：注入 AI 徽标 + bridge + console 捕获。
    // 让 mockup.html 等子路径原型页也有「首次使用模型授权」入口（右上角灰点 AI 徽标，点击弹授权窗），
    // 否则用户打开原型预览时完全看不到模型授权入口。
    if (ext === '.html') {
      let html = content.toString('utf-8');
      try {
        const entry = await readAppEntry(id);
        const showAiBadge = entry ? entry.app.aiBadge !== false : true;
        let badgeInjection = '';
        if (showAiBadge) {
          const level = await getSandboxChatPermission(id);
          badgeInjection = buildAiBadgeInjection(id, level !== 'none');
        }
        if (badgeInjection) {
          const bodyMatch = html.match(/<body\b([^>]*)>/i);
          if (bodyMatch && bodyMatch.index != null) {
            const at = bodyMatch.index + bodyMatch[0].length;
            html = html.slice(0, at) + badgeInjection + html.slice(at);
          } else {
            html = badgeInjection + html;
          }
        }
        // console捕获 + 交互补丁注入到 head（尽早执行）；bridge 脚本放 body 末尾
        const headPatch = buildConsoleCaptureInjection(id) + buildPreviewInteractionPatchInjection();
        html = html.includes('</head>')
          ? html.replace('</head>', headPatch + '</head>')
          : html + headPatch;
        const bodyPatch = buildBridgeClientScript(id);
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
