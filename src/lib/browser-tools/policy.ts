/**
 * 浏览器工具规格层 — 安全策略（纯逻辑，两个 driver 共用）
 *
 * 从 browser-mcp 的 page-script-policy.ts / net.ts 平移：
 *   - Net 白名单：导航类工具的目标域名校验（allowlist 为空 = 不限制）；
 *   - page_script 静态 lint：注入前拒绝「字面量导航」，并给出风险 warning。
 *
 * 与运行期的关系（纵深防御）：本模块只拦「字面量」意图；动态拼出的导航由
 * 页内运行时的 bb.goto 门控兜底（见 browser.ts 的 page_script 分支）。
 *
 * netMode 两档：'page' 一票否决（连 allowNav 一起拒），'hybrid' 由 allowNav 决定放行。
 * Hippo 通道显式传 'hybrid' —— 传 'page' 会让 allowNav 变成死参数、bb.goto 永远不可用。
 * 跨页面的常规做法是 browser_navigate / 标签类工具，脚本内导航属于需要显式声明的例外。
 */

export interface LintIssue {
  severity: 'error' | 'warning';
  line: number;
  code: string;
  message: string;
}

export interface PageScriptLintOptions {
  /** 是否放行页内导航（工具参数 allowNav 透传） */
  allowNav: boolean;
  /** Net 模式：page 时连 allowNav 也拒绝 */
  netMode: 'hybrid' | 'page';
  /** Net 白名单（小写域名）；空数组 = 不限制 */
  allowlist: string[];
}

export interface PageScriptLintResult {
  ok: boolean;
  issues: LintIssue[];
}

/** 应用内 Net 白名单：空 = 不限制（导航类工具的目标域名校验用） */
export const DEFAULT_NET_ALLOWLIST: string[] = [];

const NAV_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\blocation\s*\.\s*href\s*=/, what: 'location.href = …' },
  { re: /\blocation\s*\.\s*assign\s*\(/, what: 'location.assign(…)' },
  { re: /\blocation\s*\.\s*replace\s*\(/, what: 'location.replace(…)' },
  { re: /\blocation\s*\.\s*reload\s*\(/, what: 'location.reload()' },
  { re: /\bwindow\s*\.\s*open\s*\(/, what: 'window.open(…)' },
  { re: /\bdocument\s*\.\s*location\s*=/, what: 'document.location = …' },
  { re: /\bhistory\s*\.\s*(?:go|back|forward)\s*\(/, what: 'history.go/back/forward()' },
];

const WARNING_RULES: Array<{ re: RegExp; code: string; message: string }> = [
  {
    re: /\bfetch\s*\(|\bXMLHttpRequest\b/,
    code: 'risky-network',
    message:
      'fetch/XHR runs with the page origin (cookies included); results returned to the model may contain sensitive data',
  },
  {
    re: /\.innerHTML\s*=|\.outerHTML\s*=\s|document\.write\s*\(/,
    code: 'html-injection',
    message: 'writing raw HTML can execute arbitrary scripts on the page',
  },
  {
    re: /\bwhile\s*\(\s*(true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/,
    code: 'infinite-loop-risk',
    message:
      'bare infinite loop freezes the main thread; poll with bb.waitFor(cond, { timeoutMs }) instead',
  },
  {
    re: /\bdebugger\b/,
    code: 'debugger-stmt',
    message: '"debugger" pauses execution if DevTools is attached',
  },
  {
    re: /\blocalStorage\s*\.\s*clear\s*\(|\bindexedDB\s*\.\s*deleteDatabase\s*\(/,
    code: 'destructive-storage',
    message: 'this wipes site-local storage for the whole origin — confirm that is intended',
  },
];

/** 归一化 host：去协议 / 路径 / 端口，返回小写域名 */
export function normHost(host: string): string {
  return String(host || '')
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .split(/[/?#:]/)[0];
}

/** 目标 host 是否命中白名单（allowlist 为空 = 不限制） */
export function hostAllowed(url: string, allowlist: string[] = DEFAULT_NET_ALLOWLIST): boolean {
  if (!allowlist.length) return true;
  const h = normHost(url);
  if (!h) return false;
  return allowlist.some((d) => h === d || h.endsWith('.' + d));
}

/** 导航类工具的目标域名校验：通过返回 null，被拦返回原因 */
export function navGateError(
  url: string,
  name = 'browser_navigate',
  allowlist: string[] = DEFAULT_NET_ALLOWLIST,
): string | null {
  if (!allowlist.length) return null;
  if (!hostAllowed(url, allowlist)) {
    return `domain is not in the Net allowlist: "${url}" — add it to the allowlist first (tool "${name}")`;
  }
  return null;
}

export function lintPageScript(code: string, opts: PageScriptLintOptions): PageScriptLintResult {
  const issues: LintIssue[] = [];
  const lines = code.split('\n');

  // 先扫描导航意图：只有命中导航才报错；不含导航的脚本在任何模式下都放行。
  const navHits: Array<{ line: number; what: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of NAV_PATTERNS) {
      if (p.re.test(lines[i])) navHits.push({ line: i + 1, what: p.what });
    }
    if (/\bbb\.goto\s*\(/.test(lines[i])) navHits.push({ line: i + 1, what: 'bb.goto(…)' });
  }

  if (opts.netMode === 'page') {
    for (const h of navHits) {
      issues.push({
        severity: 'error',
        line: h.line,
        code: 'net-page-mode',
        message: `"${h.what}" navigates away; browser mode is page-only (Net OFF): navigation inside page_script is not allowed even with allowNav=true`,
      });
    }
  } else if (!opts.allowNav) {
    for (const h of navHits) {
      issues.push({
        severity: 'error',
        line: h.line,
        code: 'nav-denied',
        message: `"${h.what}" navigates away; either remove it or set allowNav=true on the tool call`,
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (!opts.allowNav) continue;
    if (!/\bbb\.goto\s*\(/.test(lines[i])) continue;
    let m: RegExpExecArray | null;
    const urlLit = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;
    while ((m = urlLit.exec(lines[i])) !== null) {
      const v = m[2].trim();
      if (/^https?:\/\//i.test(v) && !hostAllowed(v, opts.allowlist)) {
        issues.push({
          severity: 'error',
          line: i + 1,
          code: 'url-not-allowlisted',
          message: `goto target "${v.slice(0, 120)}" is not in the Net allowlist — add the domain first`,
        });
      }
    }
  }

  const hasBbGotoCall = /\bbb\.goto\s*\(/.test(code);
  if (opts.allowNav && hasBbGotoCall) {
    const dynamicGoto = lines.some((l) => /\bbb\.goto\s*\(/.test(l) && !/(["'])https?:\/\//i.test(l));
    if (dynamicGoto && opts.allowlist.length) {
      issues.push({
        severity: 'warning',
        line: 0,
        code: 'dynamic-nav-unverifiable',
        message:
          'bb.goto called with a non-literal URL — static allowlist verification is impossible; ensure the target domain is trusted',
      });
    }
  }

  for (const w of WARNING_RULES) {
    for (let i = 0; i < lines.length; i++) {
      if (w.re.test(lines[i])) {
        issues.push({ severity: 'warning', line: i + 1, code: w.code, message: w.message });
      }
    }
  }

  if (code.includes('</scr' + 'ipt>')) {
    issues.push({
      severity: 'warning',
      line: 0,
      code: 'closing-script-tag',
      message: 'script contains a closing-script-tag-like sequence; harmless here but review embedding context',
    });
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** lint issue → 一行人类可读文本（回传给模型） */
export function renderLintIssues(issues: LintIssue[]): string[] {
  return issues.map((i) => `L${i.line} [${i.severity}] ${i.code}: ${i.message}`);
}