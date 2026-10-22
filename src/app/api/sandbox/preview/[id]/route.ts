import { NextRequest } from 'next/server';
import { readAppEntry, readAppLocalStorage } from '@/lib/sandbox/apps';
import { buildBridgeClientScript } from '@/lib/sandbox/bridge';
import { readSettingsFromFile, isSandboxFullTrustServer } from '@/lib/settings-server';
import { guardRequestSource } from '@/lib/http/loopback-guard';
import { mintAppToken } from '@/lib/sandbox/app-token';
import { previewErrorHtml } from '@/lib/sandbox/preview-error';
import { PRESET_THEME_VARIABLES, THEME_OPTIONS } from '@/lib/settings';

/**
 * 构建当前主题的 CSS 变量注入块，插入到 iframe <head> 或内容开头。
 * 小程序可直接使用 var(--primary)、var(--background) 等，
 * 切换主题时 iframe 重新加载即自动适配。
 */
async function buildThemeStyleInjection(): Promise<string> {
  const s = await readSettingsFromFile();
  const themeId = s.theme ?? 'warm';

  // 统一单一品牌色：始终使用预设变量（历史 custom 主题已被 normalizeCustomThemes 收敛）
  const variables = PRESET_THEME_VARIABLES[themeId] ?? PRESET_THEME_VARIABLES['warm'];
  const opt = THEME_OPTIONS.find((t) => t.id === themeId);
  const dark = opt?.dark ?? false;

  const cssVars = Object.entries(variables)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');

  return `<style data-bob-theme="true">
:root {
${cssVars}
}
/* 深色主题标记：小程序可据此调整图表/Canvas 等无法用 CSS 变量的场景 */
html[data-bob-dark="${dark ? 'true' : 'false'}"] {}
</style>`;
}

/**
 * 实时 console 捕获（预览 iframe 内 override console.error/warn + error/unhandledrejection 事件），
 * 通过 postMessage 实时上报宿主（宿主预览面板右上角显示 Console 错误胶囊）。
 * 导出供静态子路径预览复用。
 */
export function buildConsoleCaptureInjection(appId: string): string {
  return `
<script data-bob-console="true">
(function () {
  var APP_ID = ${JSON.stringify(appId)};
  var buf = [];
  function flush() {
    if (!buf.length) return;
    var msgs = buf.splice(0, 20);
    try { window.parent.postMessage({ type: 'bob_console', appId: APP_ID, msgs: msgs }, '*'); } catch (e) {}
  }
  function cap(a) {
    try { return typeof a === 'string' ? a : (a && a.message) ? a.message : JSON.stringify(a); } catch (e) { return String(a); }
  }
  ['error', 'warn'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var text = Array.prototype.slice.call(arguments).map(cap).join(' ').slice(0, 500);
      buf.push({ level: level, text: text });
      flush();
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    buf.push({ level: 'error', text: ((e && e.message) || 'Uncaught error') + ' @ ' + ((e && e.filename) || '') + ':' + ((e && e.lineno) || '') });
    flush();
  });
  window.addEventListener('unhandledrejection', function (e) {
    buf.push({ level: 'error', text: 'Unhandled rejection: ' + cap(e && e.reason) });
    flush();
  });
})();
</script>`;
}

/**
 * 预览交互补丁：让 target=_blank/_top/_parent / window.open / form 提交全部在 iframe 内完成，不打开新窗口、不顶掉宿主界面
 */
export function buildPreviewInteractionPatchInjection(): string {
  return `<script data-bob-interaction="true">(function(){
  // 会跳出 iframe 的 target 值集合：_blank/_new 开新窗口、_top/_parent 导航上层窗口（会把整个程序界面顶掉）
  function isTopTarget(t){ return t === '_blank' || t === '_new' || t === '_top' || t === '_parent'; }
  function patchTargets(root){
    try {
      var links = root.querySelectorAll('a[target="_blank"],a[target="_new"],a[target="_top"],a[target="_parent"]');
      for (var i=0;i<links.length;i++) links[i].setAttribute('target','_self');
      var forms = root.querySelectorAll('form[target="_blank"],form[target="_new"],form[target="_top"],form[target="_parent"]');
      for (var j=0;j<forms.length;j++) forms[j].setAttribute('target','_self');
    } catch(e) {}
  }
  patchTargets(document.documentElement || document);
  document.addEventListener('click', function(e){
    var el = e.target;
    while (el && el !== document.body) {
      if (el.tagName === 'A') {
        var t = el.getAttribute && el.getAttribute('target');
        if (t && isTopTarget(t)) el.setAttribute('target','_self');
        break;
      }
      el = el.parentElement;
    }
  }, true);
  document.addEventListener('submit', function(e){
    var f = e.target;
    if (f && f.tagName === 'FORM') {
      var t = f.getAttribute && f.getAttribute('target');
      if (t && isTopTarget(t)) f.setAttribute('target','_self');
    }
  }, true);
  var _origOpen = window.open;
  window.open = function(url, target, features) {
    if (!url || typeof url !== 'string') return null;
    try {
      if (!target || target === '_blank' || target === '_new' || target === '_self') {
        window.location.href = url;
        return window;
      }
      window.location.href = url;
      return window;
    } catch(err) {
      try { return _origOpen(url, '_self', features || ''); } catch(_){ return null; }
    }
  };
  try {
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(function(muts){
        for (var k=0;k<muts.length;k++) {
          var m = muts[k];
          if (m.addedNodes && m.addedNodes.length) {
            for (var n=0;n<m.addedNodes.length;n++) {
              var node = m.addedNodes[n];
              if (node && node.nodeType === 1) patchTargets(node);
            }
          }
        }
      });
      mo.observe(document.documentElement || document.body || document, { childList: true, subtree: true });
    }
  } catch(_) {}
  var bases = document.getElementsByTagName('base');
  for (var bi=0;bi<bases.length;bi++){
    var bt = bases[bi].getAttribute('target');
    if (bt && isTopTarget(bt)) bases[bi].setAttribute('target','_self');
  }
})();</script>`;
}

/**
 * Mini-app preview: returns the entry HTML loaded directly by the sandbox iframe.
 * Injects the postMessage bridge + BobStorage helpers before </body>,
 * with the current appId baked in so storage is automatically namespaced.
 * Also injects current theme CSS variables so mini-apps can use var(--primary) etc.
 * GET /api/sandbox/preview/<appId>
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // 来源闸：预览入口是只读 GET，允许宿主（localhost）内嵌 127.0.0.1 预览页的 cross-site 导航；
  // 写操作/其它沙箱路由仍按 loopback-guard 的严格规则拒绝。
  const denied = await guardRequestSource(request, { allowCrossSiteRead: true });
  if (denied) {
    // 预览页会被直接当成文档显示；JSON/技术错误不能暴露给非程序员。
    if ((request.headers.get('accept') || '').includes('text/html')) {
      return friendlyPreviewError(
        denied.status,
        'This mini-app didn\'t open',
        'The preview service rejected the request. Please try again.',
      );
    }
    return denied;
  }
  try {
    const { id } = await params;
    const entry = await readAppEntry(id);
    if (!entry) {
      return friendlyPreviewError(
        404,
        'Mini-app not found',
        'It may have been deleted, or it is still being created. Go back and try again.',
      );
    }
    // 放开小程序权限（2026-10-10）：完全信任开关透传给桥脚本 → 不再有任何人工确认弹窗
    const fullTrust = await isSandboxFullTrustServer().catch(() => true);
    const clientScript = buildBridgeClientScript(id, { fullTrust });
    const themeStyle = await buildThemeStyleInjection();
    let html = entry.content;

    // ── Host origin meta (for iframe bridge targetOrigin tightening, P0#1) ──
    // Dev server / electron: request.url gives concrete origin; fall back to
    // 'self' style only when missing (postMessage tolerant on file://).
    const hostOrigin = (request.url && new URL(request.url).origin) || 'null';
    const hostOriginMeta = `<meta name="bob-host-origin" content="${hostOrigin}" />`;
    // 身份令牌（2026-10-10）：桥/流式路由只认这个令牌解出的 appId，不再信任自报的 _appId
    const appToken = await mintAppToken(id).catch(() => '');
    const appTokenMeta = appToken ? `<meta name="bob-app-token" content="${appToken}" />` : '';
    // Layer-1 持久化快照：应用内 iframe 的 localStorage 不可用，桥从这里同步读、通过宿主异步写回。
    // 必须在 app 自己的脚本之前注入；standalone（Hippo）会忽略它并继续用 localStorage。
    const localSnapshot = await readAppLocalStorage(id).catch(() => ({} as Record<string, string>));
    const localSnapshotScript = `<script data-bob-local-storage="true">window.__BOB_LOCAL_SNAPSHOT__=${JSON.stringify(localSnapshot).replace(/</g, '\\u003c')};</script>`;

    // ── P1#7: robust head injection (case-insensitive / attribute tolerant strings) ──
    function injectIntoHead(markup: string, injection: string): string {
      const headMatch = markup.match(/<head\b([^>]*)>/i);
      if (!headMatch) return injection + markup;
      const insertAt = headMatch.index! + headMatch[0].length;
      return markup.slice(0, insertAt) + injection + markup.slice(insertAt);
    }
    function injectBeforeBodyEnd(markup: string, injection: string): string {
      const endBodyMatch = markup.match(/<\/body\s*>/i);
      if (!endBodyMatch) return markup + injection;
      return markup.slice(0, endBodyMatch.index!) + injection + markup.slice(endBodyMatch.index!);
    }

    // 注入 <base> + 主题 CSS 变量 + host-origin meta 到 <head>；同时注入实时 console 捕获 + 交互补丁（尽早 override console/window.open）
    // <base> 使小程序内相对路径（css/style.css、js/app.js）正确解析到 /api/sandbox/preview/<id>/ 下
    const baseTag = `<base href="/api/sandbox/preview/${id}/" />`;
    // 没有自带 <title> 时补一个（Hippo 标签栏/窗口标题可辨识；2026-10-10 评估 P0-4）
    const hasTitle = /<title\b[^>]*>[\s\S]*?<\/title>/i.test(html);
    const titleTag = hasTitle
      ? ''
      : `<title>${String(entry.app.name || id).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string))} · BobWork</title>`;
    html = injectIntoHead(html, baseTag + titleTag + localSnapshotScript + hostOriginMeta + appTokenMeta + themeStyle + buildConsoleCaptureInjection(id) + buildPreviewInteractionPatchInjection());

    // 注入 bridge 脚本：优先放 </body> 前
    html = injectBeforeBodyEnd(html, clientScript);

    // ── Security headers ──
    // 小程序是 BobWork 原生功能组件，CSP 完全放开：
    // 允许同源/https/http 资源、内联脚本/样式、eval、data/blob URI。
    // frame-ancestors 保留 'self' 防止外部页面嵌套。
    // frame-ancestors 必须包含宿主 UI 的 origin（方案 B 的应用内 iframe 预览）：
    // 宿主演 localhost、预览跑 127.0.0.1，'self' 不足以放行。只放开回环名字，跨站仍不能内嵌。
    const cspDirectives = [
      "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*",
      "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: http: https:",
    ].join('; ');

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // 不设 X-Frame-Options：它会把跨 origin 的宿主内嵌一并拦掉（frame-ancestors 已做同样的事，
        // 且能精确到回环 origin 白名单）
        'Content-Security-Policy': cspDirectives,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer-when-downgrade',
      },
    });
  } catch (e) {
    console.error('[sandbox preview] failed to render app:', e);
    return friendlyPreviewError(
      500,
      'This mini-app didn\'t open',
      'The preview service hit a problem. Please try again.',
    );
  }
}

/** 预览失败统一返回人话 HTML（不把 JSON/堆栈当页面给用户看）。 */
function friendlyPreviewError(status: number, title: string, message: string): Response {
  return new Response(previewErrorHtml(title, message), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
