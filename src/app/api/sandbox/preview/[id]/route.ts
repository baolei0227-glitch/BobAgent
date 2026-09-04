import { NextRequest } from 'next/server';
import { readAppEntry } from '@/lib/sandbox/apps';
import { buildBridgeClientScript } from '@/lib/sandbox/bridge';
import { readSettingsFromFile } from '@/lib/settings-server';
import { PRESET_THEME_VARIABLES, THEME_OPTIONS, getSandboxChatPermission } from '@/lib/settings';

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

/** 构建 AI 状态徽章（固定在小程序预览右上角）。
 *  - 绿色圆点：当前小程序已获 AI 调用授权；
 *  - 灰色圆点：未授权，点击触发 chatRequestPermission 弹窗申请；
 *  - 监听宿主广播的权限变更事件（bob_chat_permission_changed）实时更新颜色。
 * 小程序代码无需改动，宿主统一兜底。
 * 导出供静态子路径预览（mockup.html 等）复用，保证任意预览页都有授权入口。 */
export function buildAiBadgeInjection(appId: string, granted: boolean): string {
  const grantedStr = String(granted);
  return `
<style data-bob-aibadge="true">
#bob-ai-badge {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 2147483646;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 8px;
  border-radius: 999px;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  border: 1px solid var(--border, #e5e5e5);
  background: var(--paper, #ffffff);
  backdrop-filter: blur(8px);
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
  transition: opacity 0.2s ease, transform 0.15s ease;
  opacity: 0;
  animation: bobAiBadgeFadeIn 0.4s ease 0.15s forwards;
}
@keyframes bobAiBadgeFadeIn { to { opacity: 1; } }
#bob-ai-badge:hover { transform: translateY(-1px); }
#bob-ai-badge:active { transform: translateY(0); }
#bob-ai-badge[data-granted="true"] {
  color: var(--success, oklch(0.58 0.18 150));
  border-color: color-mix(in oklab, var(--success, oklch(0.58 0.18 150)) 40%, var(--border, #e5e5e5));
}
#bob-ai-badge[data-granted="false"] {
  color: var(--muted-foreground, #6b6b6b);
}
#bob-ai-badge-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--muted-foreground, #9a9a9a);
  box-shadow: 0 0 0 0 rgba(0,0,0,0);
}
#bob-ai-badge[data-granted="true"] #bob-ai-badge-dot {
  background: var(--success, oklch(0.58 0.18 150));
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--success, oklch(0.58 0.18 150)) 18%, transparent);
}
#bob-ai-badge-label {
  font-weight: 600;
  letter-spacing: 0.01em;
}
</style>
<div id="bob-ai-badge" data-granted="${grantedStr}" title="AI model access">
  <span id="bob-ai-badge-dot"></span>
  <span id="bob-ai-badge-label">AI</span>
</div>
<script data-bob-aibadge="true">
(function () {
  var APP_ID = ${JSON.stringify(appId)};
  var grantedInit = ${grantedStr};
  var badge = document.getElementById('bob-ai-badge');
  if (!badge) return;

  function setGranted(g) {
    badge.setAttribute('data-granted', String(g));
    badge.title = g ? 'AI model access: granted' : 'AI model access: denied (click to request)';
  }
  setGranted(grantedInit);

  // 点击反馈：未授权→发起授权请求；已授权→提示去左侧面板关闭；失败→提示降级路径
  var label = document.getElementById('bob-ai-badge-label');
  var hintTimer = null;
  function flash(text, ms) {
    if (!label) return;
    var orig = label.textContent;
    label.textContent = text;
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { label.textContent = orig; }, ms || 1600);
  }

  badge.addEventListener('click', function () {
    var current = badge.getAttribute('data-granted') === 'true';
    if (current) {
      // 已授权：点击提示去左侧 Sandbox 面板关闭（避免误触撤销）
      flash('AI on · toggle off in left panel', 2200);
      return;
    }
    // 未授权：即时反馈 + 调宿主 chatRequestPermission 弹窗申请
    flash('Requesting…', 2000);
    window.BobWork && window.BobWork.request &&
      window.BobWork.request('chatRequestPermission', {}).then(function (res) {
        if (res && res.granted) {
          setGranted(true);
          flash('Granted', 1400);
        } else {
          flash('Not granted · use left panel', 2400);
        }
      }).catch(function () {
        flash('Request failed · use left panel', 2400);
      });
  });

  // 监听宿主广播：面板授权 chip 变更时实时同步
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'bob_chat_permission_changed') return;
    if (msg.appId !== APP_ID) return;
    setGranted(!!msg.granted);
  });

  // 额外兜底：加载后再次查询（防止授权状态异步变更）
  if (window.BobWork && window.BobWork.request) {
    setTimeout(function () {
      window.BobWork.request('chatGetPermission', {}).then(function (res) {
        if (res && typeof res.granted === 'boolean') setGranted(res.granted);
      }).catch(function () {});
    }, 500);
  }
})();
</script>`;
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
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const entry = await readAppEntry(id);
    if (!entry) {
      return new Response('App not found', { status: 404 });
    }
    const clientScript = buildBridgeClientScript(id);
    const themeStyle = await buildThemeStyleInjection();
    let html = entry.content;

    // ── Host origin meta (for iframe bridge targetOrigin tightening, P0#1) ──
    // Dev server / electron: request.url gives concrete origin; fall back to
    // 'self' style only when missing (postMessage tolerant on file://).
    const hostOrigin = (_request.url && new URL(_request.url).origin) || 'null';
    const hostOriginMeta = `<meta name="bob-host-origin" content="${hostOrigin}" />`;

    // ── AI badge 注入（根据 manifest.aiBadge，默认 true）──
    const showAiBadge = entry.app.aiBadge !== false;
    let aiBadgeInjection = '';
    if (showAiBadge) {
      const granted = await getSandboxChatPermission(id).then((g) => !!g).catch(() => false);
      aiBadgeInjection = buildAiBadgeInjection(id, granted);
    }

    // ── P1#7: robust head injection (case-insensitive / attribute tolerant strings) ──
    function injectIntoHead(markup: string, injection: string): string {
      const headMatch = markup.match(/<head\b([^>]*)>/i);
      if (!headMatch) return injection + markup;
      const insertAt = headMatch.index! + headMatch[0].length;
      return markup.slice(0, insertAt) + injection + markup.slice(insertAt);
    }
    function injectIntoBodyStart(markup: string, injection: string): string {
      const bodyMatch = markup.match(/<body\b([^>]*)>/i);
      if (!bodyMatch) return injection + markup;
      const insertAt = bodyMatch.index! + bodyMatch[0].length;
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
    html = injectIntoHead(html, baseTag + hostOriginMeta + themeStyle + buildConsoleCaptureInjection(id) + buildPreviewInteractionPatchInjection());

    // 注入 AI badge：放在 <body> 最前（在小程序内容之前，保证渲染顺序）
    if (showAiBadge && aiBadgeInjection) {
      html = injectIntoBodyStart(html, aiBadgeInjection);
    }

    // 注入 bridge 脚本：优先放 </body> 前
    html = injectBeforeBodyEnd(html, clientScript);

    // ── Security headers ──
    // 小程序是 BobWork 原生功能组件，CSP 完全放开：
    // 允许同源/https/http 资源、内联脚本/样式、eval、data/blob URI。
    // frame-ancestors 保留 'self' 防止外部页面嵌套。
    const cspDirectives = [
      "frame-ancestors 'self'",
      "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: http: https:",
    ].join('; ');

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': cspDirectives,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer-when-downgrade',
      },
    });
  } catch (e) {
    return new Response(`Error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
}
