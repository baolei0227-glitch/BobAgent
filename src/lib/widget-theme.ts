/**
 * Widget 主题与配色（纯函数 / 无 DOM 依赖）
 *
 * 从 WidgetRenderer 抽出，供两侧共用（唯一数据源，避免配色漂移）：
 *   - 客户端：WidgetRenderer / MermaidCodeBlock（编辑器内图表渲染）
 *   - 服务端：分享页 SSR（share-widget.ts 渲染 mermaid / widget 代码块）
 *
 * 本模块禁止引入 React、浏览器 API 或 client-only 依赖。
 */

export interface WidgetTokens {
  /** 页面/图表背景（分组灰，Apple systemGroupedBackground） */
  bg: string;
  /** 深一档背景（表头/标题条） */
  bgAlt: string;
  /** 卡片底色（Apple 卡片 = 白 bg 上的白色浮层；深色 = 提亮一档） */
  card: string;
  /** 主文字 */
  text: string;
  /** 次要文字 */
  textMuted: string;
  /** 边框 */
  border: string;
  /** 品牌/强调色 */
  accent: string;
  /** 成功/正向 */
  success: string;
  /** 警示/分支 */
  warning: string;
  /** 错误/终止 */
  danger: string;
  /** 节点填充 */
  nodeFill: string;
  /** 节点边框 */
  nodeBorder: string;
  /** 连线颜色 */
  lineColor: string;
  /** 数据图表系列色板（ECharts） */
  chartPalette: string[];
  /** 标题字体（Apple 风格无衬线） */
  titleFont: string;
  /** 正文字体 */
  sansFont: string;
}

export const WIDGET_THEME: WidgetTokens = {
  /** 卡片/图表背景 — dynamic-ui --surface */
  bg: '#f7f7f8',
  /** 深一档背景（表头/标题条）— dynamic-ui --surface-muted */
  bgAlt: '#efeff2',
  /** 卡片底色 — 白卡浮在分组灰上 */
  card: '#FFFFFF',
  /** 主文字 — dynamic-ui --text */
  text: '#171717',
  /** 次要文字 — Apple 中灰 #6e6e73（主次层级更分明，保持轻盈） */
  textMuted: '#6e6e73',
  /** 边框 — dynamic-ui --border（加深至可读，Apple 细边框质感） */
  border: 'rgba(23, 23, 23, 0.18)',
  /** 强调色 — dynamic-ui --brand（统一品牌 Purple，LLM 应按内容主题显式覆盖） */
  accent: '#4b3fe3',
  /** 成功/正向 — Apple 系统绿 #34C759 */
  success: '#34C759',
  /** 警示/分支 — Apple 系统橙 #FF9F0A */
  warning: '#FF9F0A',
  /** 错误/终止 — Apple 系统红 #FF453A */
  danger: '#FF453A',
  /** 节点填充（中性次级背景） */
  nodeFill: '#efeff2',
  /** 节点边框 */
  nodeBorder: 'rgba(23, 23, 23, 0.20)',
  /** 连线颜色 — Apple 次文字灰 #86868b（柔和克制） */
  lineColor: '#86868b',
  /** 数据图表系列色板（Apple 系统六色 + 品牌紫打头；LLM 可按内容主题在 option.color 中显式覆盖） */
  chartPalette: ['#4b3fe3', '#0071e3', '#32ADE6', '#34C759', '#FF9F0A', '#FF453A', '#AF52DE'],
  /** 标题字体（全局衬线） */
  titleFont: "'Times New Roman', Times, 'Songti SC', 'Source Han Serif SC', 'Noto Serif SC', 'SimSun', 'Liberation Serif', serif",
  /** 正文字体 */
  sansFont: "'Times New Roman', Times, 'Songti SC', 'Source Han Serif SC', 'Noto Serif SC', 'SimSun', 'Liberation Serif', serif",
};

/** 深色主题：dynamic-ui Neutral/Brand 暗色档 */
export const WIDGET_DARK_THEME: WidgetTokens = {
  bg: '#171717',
  bgAlt: '#262626',
  /** 卡片底色 — 深色下比 bgAlt 再提亮一档（#262626 → #303034），避免与 .w-tag/表头背景同色隐形 */
  card: '#303034',
  text: '#e5e5e5',
  /** 次要文字 — Apple 深色次文字 #98989d */
  textMuted: '#98989d',
  border: 'rgba(229, 229, 229, 0.2)',
  accent: '#6054f1',
  /** 深色语义色 — Apple 系统深色档（跨主题固定） */
  success: '#30D158',
  warning: '#FFD60A',
  danger: '#FF453A',
  nodeFill: '#262626',
  nodeBorder: 'rgba(229, 229, 229, 0.20)',
  /** 连线颜色 — Apple 深色次文字灰 #98989d */
  lineColor: '#98989d',
  /** 数据图表系列色板（Apple 系统深色六色 + 品牌紫打头） */
  chartPalette: ['#6054f1', '#0A84FF', '#64D2FF', '#30D158', '#FFD60A', '#FF453A', '#BF5AF2'],
  titleFont: WIDGET_THEME.titleFont,
  sansFont: WIDGET_THEME.sansFont,
};

/** 统一取色入口 */
export function getWidgetTokens(dark: boolean): WidgetTokens {
  return dark ? WIDGET_DARK_THEME : WIDGET_THEME;
}

/** 注入 HTML widget 的主题 CSS（CSS 变量 + 基础组件样式）— Apple 风格，支持深浅色 */
export function buildWidgetHtmlCss(t: WidgetTokens): string {
  const dark = t.bg === '#171717';
  return `
:root {
  --widget-bg: ${t.bg};
  --widget-bg-alt: ${t.bgAlt};
  --widget-card: ${t.card};
  --widget-text: ${t.text};
  --widget-muted: ${t.textMuted};
  --widget-border: ${t.border};
  --widget-accent: ${t.accent};
  --widget-success: ${t.success};
  --widget-warning: ${t.warning};
  --widget-danger: ${t.danger};
  /* Apple 风格圆角标尺（比 v3 略大一档） */
  --widget-radius-xs: 6px; --widget-radius-sm: 8px; --widget-radius-md: 10px;
  --widget-radius-lg: 14px; --widget-radius-xl: 20px;
  --widget-space-xs: 4px; --widget-space-sm: 8px; --widget-space-md: 12px;
  --widget-space-lg: 16px; --widget-space-xl: 24px; --widget-space-2xl: 32px;
  /* Apple 风格阴影：更克制，层次靠背景色差 + 毛玻璃 */
  --widget-shadow-sm: 0 1px 2px rgba(0,0,0,${dark ? '.02' : '.04'});
  --widget-shadow-md: 0 2px 8px rgba(0,0,0,${dark ? '.03' : '.06'});
  --widget-shadow-lg: 0 4px 16px rgba(0,0,0,${dark ? '.04' : '.08'});
  --widget-font-display: ${t.titleFont};
  --widget-font-body: ${t.sansFont};
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 12px;
  background: transparent;
  color: var(--widget-text);
  font-family: var(--widget-font-body);
  font-size: 14px; line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
/* Apple 风格组件类 */
.w-card {
  background: var(--widget-card);
  border: 1px solid var(--widget-border);
  border-radius: var(--widget-radius-lg);
  padding: var(--widget-space-md) var(--widget-space-lg);
  box-shadow: var(--widget-shadow-sm);
}
.w-card h1, .w-card h2, .w-card h3, h1, h2, h3 {
  font-family: var(--widget-font-display);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.w-title {
  font: 700 15px/1.4 var(--widget-font-display);
  letter-spacing: -0.01em;
  color: var(--widget-text);
  margin: 0 0 var(--widget-space-sm);
}
/* 数据表格 */
table.w-table, table {
  width: 100%; border-collapse: collapse; font-size: 14px;
}
table.w-table th, table th {
  background: var(--widget-bg-alt);
  border: 1px solid var(--widget-border);
  padding: var(--widget-space-sm) var(--widget-space-md); text-align: left; font-weight: 600;
}
table.w-table td, table td {
  border: 1px solid var(--widget-border);
  padding: var(--widget-space-sm) var(--widget-space-md);
}
/* 标签/徽章 — 语义色跟随变量，不再硬编码 */
.w-tag {
  display: inline-block;
  font: 400 12px/1 var(--widget-font-body);
  padding: 3px var(--widget-space-sm);
  border-radius: 999px;
  background: var(--widget-bg-alt);
  color: var(--widget-muted);
}
/* 语义变体：空格类（class="w-tag success"）与双横线类（class="w-tag--success"）兼容 */
.w-tag.success,     .w-tag--success     { background: color-mix(in srgb, var(--widget-success) 12%, transparent); color: var(--widget-success); }
.w-tag.warning,     .w-tag--warning     { background: color-mix(in srgb, var(--widget-warning) 12%, transparent); color: var(--widget-warning); }
.w-tag.danger,      .w-tag--danger      { background: color-mix(in srgb, var(--widget-danger) 12%, transparent); color: var(--widget-danger); }
.w-tag.accent,      .w-tag--accent      { background: color-mix(in srgb, var(--widget-accent) 12%, transparent); color: var(--widget-accent); }
/* 按钮 — Apple 按压反馈 */
.w-btn {
  font: 500 14px var(--widget-font-body);
  padding: 6px 14px;
  border-radius: var(--widget-radius-sm);
  border: none;
  background: var(--widget-bg-alt);
  color: var(--widget-text);
  cursor: pointer;
  transition: filter .15s ease, transform .1s ease;
}
.w-btn:hover { filter: brightness(0.95); }
.w-btn:active { transform: scale(0.96); }
.w-btn.primary, .w-btn--primary { background: var(--widget-accent); color: #fff; }
.w-btn.primary:hover, .w-btn--primary:hover { filter: brightness(1.05); }
/* KPI — tabular-nums 等宽数字 */
.w-kpi { text-align: center; }
.w-kpi .value {
  font: 700 20px var(--widget-font-display);
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  color: var(--widget-accent);
}
.w-kpi .label { font: 400 12px var(--widget-font-body); color: var(--widget-muted); }
/* 对齐变体：class="w-kpi w-kpi--left"（渲染器补全，与文档 04a 对齐） */
.w-kpi--left  { text-align: left; }
.w-kpi--right { text-align: right; }
/* 分割线 */
hr { border: none; border-top: 1px solid var(--widget-border); margin: var(--widget-space-sm) 0; }
/* 链接 */
a { color: var(--widget-accent); text-decoration: none; }
a:hover { text-decoration: underline; }
/* 代码 */
code { background: var(--widget-bg-alt); padding: 2px 6px; border-radius: var(--widget-radius-xs); font-size: 12px; font-variant-numeric: tabular-nums; }
`;
}

/** 兼容导出：浅色 HTML 主题 CSS */
export const WIDGET_HTML_THEME_CSS = buildWidgetHtmlCss(WIDGET_THEME);

/** Mermaid themeVariables（映射到同一套 token 色板）— 按主题动态生成 */
export function buildMermaidTheme(t: WidgetTokens) {
  const dark = t.bg === '#171717';
  return {
    fontFamily: t.sansFont,
    // 节点白卡 + 可读边框（Apple 细边框质感）
    primaryColor: dark ? '#262626' : '#FFFFFF',
    primaryBorderColor: dark ? 'rgba(229, 229, 229, 0.22)' : 'rgba(23, 23, 23, 0.18)',
    primaryTextColor: t.text,
    secondaryColor: dark ? '#303034' : '#F5F5F7',
    secondaryBorderColor: dark ? 'rgba(229, 229, 229, 0.18)' : 'rgba(23, 23, 23, 0.14)',
    secondaryTextColor: t.text,
    tertiaryColor: dark ? '#262626' : '#FFFFFF',
    // 连线 — Apple 次文字灰，柔和克制
    lineColor: dark ? '#98989d' : '#86868b',
    textColor: t.text,
    mainBkg: dark ? '#171717' : '#FFFFFF',
    edgeLabelBackground: t.bg,
    // 子图分区 — Apple 淡蓝 tint 底 + 加深描边（强化结构分区感）
    clusterBkg: dark ? '#1E2A3A' : '#E9F2FF',
    clusterBorder: dark ? 'rgba(229, 229, 229, 0.22)' : 'rgba(23, 23, 23, 0.16)',
    noteBkgColor: dark ? '#303034' : '#FFF9E6',
    noteBorderColor: dark ? 'rgba(229, 229, 229, 0.12)' : 'rgba(255, 149, 0, 0.35)',
    actorBkg: dark ? '#262626' : '#F5F5F7',
    actorBorder: dark ? 'rgba(229, 229, 229, 0.18)' : 'rgba(23, 23, 23, 0.14)',
    actorTextColor: t.text,
    labelBoxBkgColor: t.bg,
    labelTextColor: t.textMuted,
    signalColor: t.accent,
    signalTextColor: t.text,
    taskBkgColor: dark ? '#262626' : '#F5F5F7',
    taskBorderColor: dark ? 'rgba(229, 229, 229, 0.18)' : 'rgba(23, 23, 23, 0.14)',
    todayLineColor: t.warning,
    sectionBkgColor: dark ? '#303034' : '#F5F5F7',
    sectionBkgColor2: t.bg,
    pie1: t.accent,
    pie2: t.success,
    pie3: t.warning,
    pie4: t.chartPalette[3],
    pie5: t.chartPalette[4],
    pieTitleTextSize: '13px',
    titleColor: t.text,
    edgeLabelColor: t.text,
  };
}

/** 兼容导出：浅色 Mermaid themeVariables */
export const WIDGET_MERMAID_THEME = buildMermaidTheme(WIDGET_THEME);

/** beautiful-mermaid 渲染配色（dynamic-ui Token 映射）— 按 token 生成；MermaidCodeBlock（UnifiedViewer）共享 */
export function getMermaidRenderColors(t: WidgetTokens) {
  const dark = t.bg === '#171717';
  return {
    bg: t.bg,
    fg: t.text,
    // 连线/箭头 — Apple 次文字灰，柔和克制
    line: dark ? '#98989d' : '#86868b',
    accent: t.accent,
    muted: t.textMuted,
    // 节点填充 — 白卡浮于 tint 分区底上（Apple 层级感）
    surface: dark ? '#262626' : '#FFFFFF',
    // 边框 — 加深至可读（Apple 细边框质感）
    border: dark ? 'rgba(229, 229, 229, 0.22)' : 'rgba(23, 23, 23, 0.18)',
    font: t.sansFont,
  } as const;
}

/** 兼容导出：浅色 beautiful-mermaid 配色 */
export const MERMAID_RENDER_COLORS = getMermaidRenderColors(WIDGET_THEME);

/** 把 CSS 选择器作用域化到 <scope> 容器：:root/body → .<scope>，其余选择器前缀 .<scope>（逗号列表逐项处理） */
export function scopeCss(css: string, scope: string): string {
  return css.replace(/(^|})\s*([^{}]+)\{/g, (_m, pre: string, selBlock: string) => {
    const scoped = selBlock
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (s === ':root' || s === 'body') return `.${scope}`;
        if (s === '*') return `.${scope} *`;
        if (s.startsWith('@')) return s; // @media/@keyframes 等原样保留
        return `.${scope} ${s}`;
      })
      .join(',\n');
    return `${pre} ${scoped} {`;
  });
}
