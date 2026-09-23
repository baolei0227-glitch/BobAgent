/**
 * 浏览器工具规格层 — 入口
 *
 * 驱动选择 = 全局互斥开关（settings.aiBrowser），一次解析、整轮生效：
 *   - 'hippo'  → 注入内置 browser_*（HippoDriver），MCP 浏览器工具不注入
 *   - 'chrome' → 注入 mcp__bob-browser-mcp__browser_*，内置组不注入
 *   - undefined → 等价 'hippo'（默认通道）；仅显式写入 'chrome' 才走 Bob Browser
 *
 * 不做 auto 判据、不做 per-call target 参数；未选中的通道对模型完全不可见，
 * 从根上消除「在错误浏览器里执行」的歧义。
 */

export type { BrowserDriver, BrowserToolSpec, DriverCtx, DriverStatus, Envelope, ErrorPhase } from './types';
export { BROWSER_TOOL_NAMES, BROWSER_TOOL_SPECS } from './specs';
export { HippoDriver, getHippoDriver, getHippoPageUrl } from './hippo-driver';
export type { LintIssue, PageScriptLintOptions, PageScriptLintResult } from './policy';
export {
  DEFAULT_NET_ALLOWLIST,
  hostAllowed,
  lintPageScript,
  navGateError,
  renderLintIssues,
} from './policy';

/** AI 浏览器通道（互斥单选） */
export type BrowserChannel = 'hippo' | 'chrome';

/** 解析当前生效通道：缺省 = 'hippo'（默认通道）；仅显式 'chrome' 才走 Bob Browser */
export function resolveBrowserChannel(settings: { aiBrowser?: 'hippo' | 'chrome' } | null | undefined): BrowserChannel {
  return settings?.aiBrowser === 'chrome' ? 'chrome' : 'hippo';
}