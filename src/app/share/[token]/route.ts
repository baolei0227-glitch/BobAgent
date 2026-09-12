/**
 * 分享阅读页 — GET /share/<token>
 *
 * 局域网分享：任何人拿到链接都能在浏览器打开阅读 md 文档。
 * 服务端渲染纯 HTML（无客户端 JS/React），安全性：只读渲染 + sanitize。
 */
import { readFile } from 'fs/promises';
import { dirname } from 'path';
import { createRenderer } from 'unified-renderer';
import { getShareLink } from '@/lib/share-links';
import { expandEmbeds } from '@/lib/md-embed';

/** 创建渲染器：GFM + sanitize + 标题锚点 + 代码高亮（与编辑器预览一致的管线） */
const renderer = createRenderer({
  format: 'markdown',
  gfm: true,
  sanitize: true,
  slug: true,
  highlight: true,
  allowDangerousHtml: true,
});

/** 简单转义 HTML（title 插入时用） */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildPage(title: string, html: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · BobWork Share</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Times New Roman", Times, "Songti SC", "Source Han Serif SC", "Noto Serif SC", "SimSun", "Liberation Serif", serif;
    font-size: 15px; line-height: 1.75; color: #1f2328;
    background: #f6f7f9;
  }
  .page { max-width: 820px; margin: 0 auto; padding: 40px 24px 80px; }
  .paper {
    background: #fff; border: 1px solid #e6e8eb; border-radius: 12px;
    padding: 40px 48px; box-shadow: 0 1px 2px rgba(0,0,0,.03);
  }
  .paper h1 { font-size: 26px; line-height: 1.35; margin: 0 0 16px; border-bottom: 1px solid #eceef0; padding-bottom: 16px; }
  .paper h2 { font-size: 20px; margin: 28px 0 12px; }
  .paper h3 { font-size: 17px; margin: 24px 0 10px; }
  .paper p { margin: 10px 0; }
  .paper ul, .paper ol { margin: 10px 0; padding-left: 24px; }
  .paper a { color: #3b6df5; text-decoration: none; }
  .paper a:hover { text-decoration: underline; }
  .paper code { background: #f0f1f3; border-radius: 4px; padding: 1px 5px; font-size: 13px; }
  .paper pre { background: #f6f8fa; border: 1px solid #e6e8eb; border-radius: 8px; padding: 14px 16px; overflow-x: auto; }
  .paper pre code { background: transparent; padding: 0; }
  .paper blockquote { margin: 12px 0; padding: 4px 16px; border-left: 4px solid #d0d7de; color: #57606a; }
  .paper table { border-collapse: collapse; margin: 14px 0; width: 100%; }
  .paper th, .paper td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
  .paper th { background: #f6f8fa; font-weight: 600; }
  .paper img { max-width: 100%; border-radius: 8px; }
  .paper hr { border: none; border-top: 1px solid #e6e8eb; margin: 24px 0; }
  .paper :is(h1,h2,h3,h4) a { color: inherit; }
  .footer { margin-top: 24px; text-align: center; font-size: 12px; color: #8b949e; }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; }
    body { background: #16181d; color: #e6e8ec; }
    .paper { background: #1c1f26; border-color: #2d3139; }
    .paper h1 { border-color: #2d3139; }
    .paper code { background: #262a32; }
    .paper pre { background: #16181d; border-color: #2d3139; }
    .paper blockquote { border-color: #3d434e; color: #9aa4b2; }
    .paper th { background: #262a32; }
    .paper th, .paper td { border-color: #33373f; }
    .paper a { color: #7c9cf5; }
  }
</style>
</head>
<body>
  <div class="page">
    <div class="paper">${html}</div>
    <div class="footer">Shared via BobWork · read-only</div>
  </div>
</body>
</html>`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  try {
    const entry = await getShareLink(token);
    if (!entry) {
      return new Response('Not found: 分享链接无效或已删除', { status: 404 });
    }
    const md = await readFile(entry.path, 'utf-8');
    // 展开嵌入（![[其他文档]] → 递归渲染其内容，分享页可读本地文件；相对路径以本文档所在目录为基准）
    const expanded = await expandEmbeds(md, 0, undefined, dirname(entry.path));
    const { html } = renderer.markdownSync(expanded);
    const page = buildPage(entry.title, html);
    return new Response(page, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(`Error: ${escapeHtml(msg)}`, { status: 500 });
  }
}
