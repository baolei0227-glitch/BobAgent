/**
 * 报告分享契约（Butler 收件箱「报告类」回执的对外分享）
 *
 * 单点定义三件事，供 服务端路由 `/api/butler/report` 与 前端抽屉详情区 共用：
 *   1. 哪些 kind 的正文允许对外分享（SHAREABLE_REPORT_KINDS）
 *   2. 分享链接长什么样（buildReportShareUrl）
 *   3. 下载 .md 的文件名规则（sanitizeReportFileName）
 *
 * 为什么必须同源：此处拆分之前，服务端放行 4 类 kind，而旧 UI 只在 `kind === 'web'` 时
 * 才渲染「下载 / 复制链接」按钮 —— 结果服务端能读、UI 不给入口。且真实收件箱里
 * （2026-09-25 实测）kind 分布为 daily-report=14 / calendar=12 / inspect=10，**web 为 0 条**，
 * 等于该入口从未在任何真实回执上出现过。
 *
 * 本模块必须保持纯净（不 import node/服务端依赖），否则前端组件无法引用。
 */

/** 可对外分享正文的收件箱 kind —— 即「报告类」。不含 chat / task / note(s) / calendar / todo_del / check */
export const SHAREABLE_REPORT_KINDS = ['web', 'notes-maintenance', 'info'] as const;

/** 该 kind 的正文是否可分享 / 下载 */
export function isShareableReportKind(kind: string | null | undefined): boolean {
  return !!kind && (SHAREABLE_REPORT_KINDS as readonly string[]).includes(kind);
}

/** 报告分享链接（origin 取 `window.location.origin`：主窗加载 http://localhost:<PORT>，AI 可 web_fetch） */
export function buildReportShareUrl(origin: string, id: string): string {
  return `${origin}/api/butler/report?id=${encodeURIComponent(id)}`;
}

/** 下载文件名（去路径分隔符/空白，截断 60 字，空则回落 'report'）——须与路由 Content-Disposition 一致 */
export function sanitizeReportFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}
