/**
 * 预览失败时的友好 HTML 页。
 *
 * 为什么不是 JSON：预览页会被直接当成文档显示在 iframe / Hippo 里，
 * 非程序员不该看到 `{"success":false,...}`、堆栈或技术细节。
 * 这里只给一句人话 + 重试；具体错误由宿主预览浮层或服务端日志承接。
 */

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

export function previewErrorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="bob-preview-error" content="true" />
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 24px; background: #faf8f3; color: #3a342c;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .card {
      width: 100%; max-width: 420px; padding: 28px 24px; border-radius: 14px;
      background: #fff; border: 1px solid #e8e0d0; box-shadow: 0 6px 24px rgba(0,0,0,.06);
      text-align: center;
    }
    .icon {
      width: 40px; height: 40px; margin: 0 auto 12px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: #fbf1de; color: #a97a1f; font-size: 20px;
    }
    h1 { margin: 0 0 8px; font-size: 17px; font-weight: 600; }
    p { margin: 0 0 18px; font-size: 13px; line-height: 1.6; color: #7d7263; }
    a.retry {
      display: inline-block; padding: 9px 16px; border-radius: 9px;
      background: #6b8e4e; color: #fff; font-size: 13px; font-weight: 600;
      text-decoration: none;
    }
    .hint { margin-top: 12px; font-size: 11px; color: #9a8f7f; }
  </style>
</head>
<body>
  <main class="card" role="alert">
    <div class="icon" aria-hidden="true">!</div>
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
    <a class="retry" href="">Try again</a>
    <div class="hint">If it keeps happening, go back and ask AI to check this mini-app.</div>
  </main>
</body>
</html>`;
}
