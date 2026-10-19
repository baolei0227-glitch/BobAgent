/** sanitize 白名单结构（允许额外放行的标签 / 属性 / 协议） */
export interface SanitizeWhitelist {
    tags?: string[];
    attributes?: Record<string, string[]>;
    /** 放行的 URL 协议（按属性名分组），例如 `{ src: ['data'] }` 允许 img src 用 data: URL */
    protocols?: Record<string, string[]>;
}
/** createRenderer 配置项 */
export interface RendererOptions {
    /** 输入格式：'markdown'（默认）| 'html' */
    format?: 'markdown' | 'html';
    /** 启用 GFM 支持（表格、删除线、任务列表等） */
    gfm?: boolean;
    /** 启用 XSS 安全过滤（默认 true） */
    sanitize?: boolean;
    /** 为标题自动生成 slug 锚点（默认 false） */
    slug?: boolean;
    /** 代码块语法高亮（默认 false） */
    highlight?: boolean;
    /** 允许原始 HTML 透传（配合 sanitize 过滤危险标签） */
    allowDangerousHtml?: boolean;
    /** sanitize 额外放行的标签 / 属性 */
    sanitizeWhitelist?: SanitizeWhitelist;
}
export interface RenderResult {
    html: string;
}
export interface Renderer {
    markdownSync: (content: string) => RenderResult;
}
/**
 * 创建渲染器。markdownSync 同步返回 { html }。
 */
export declare function createRenderer(options?: RendererOptions): Renderer;
export declare function renderHtmlSync(content: string, options?: RendererOptions): RenderResult;
declare const _default: {
    createRenderer: typeof createRenderer;
    renderHtmlSync: typeof renderHtmlSync;
};
export default _default;
