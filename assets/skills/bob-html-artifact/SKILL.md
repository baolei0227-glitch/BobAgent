---
name: bob-html-artifact
description: 统一的一站式 HTML 产物技能：把回答/数据/内容生成自包含单文件 .html（离线可用），**默认生成静态 HTML**（纯静态渲染，无 JS 交互），**仅当用户主动要求交互（交互/筛选/拖拽/调参/动态/点击展开/动画/主题切换等词）时才生成可交互 HTML**。覆盖静态报告与动态交互全形态，内置设计系统、多主题与设计质量标准。触发词：输出HTML、生成网页、html artifact、可视化、交互文档、报告网页、网页格式、交互式、动态网页、数据大屏、仪表盘、h5页面、单页报告、静态html、纯静态。注意：独立完整演示文稿（路演/课件/PPT）请走 slide-craft 技能，本技能仅处理报告/文档内嵌的翻页章节。
---

# HTML 产物生成器

当用户要求输出 HTML 格式、网页、可视化文档、交互文档时，生成一个**自包含的单个 `.html` 文件**。输出到 `homework/` 目录下。

**核心约束：** 所有 CSS 写在 `<style>` 标签内，所有 JS 写在 `<script>` 标签内。不使用任何 CDN 链接、框架、构建工具。文件离线可用，任何浏览器可直接打开。

## 工作流程

### 第一步：检测产物形态

根据用户请求，自动判断以下 8 种形态之一：

| 形态 | 触发信号 | 产出内容 |
|------|---------|---------|
| `spec` | 方案对比、技术选型、探索选项、头脑风暴 | 并排对比网格、优缺点徽标、流程图、风险表 |
| `code-review` | 代码审查、diff 分析、注释代码 | 差异高亮、严重程度颜色、边注 |
| `prototype` | 原型、动画、调参、组件变体 | 滑块控件、CSS 变量实时更新、动画沙箱 |
| `report` | 报告、总结、状态更新、说明文档 | TL;DR 摘要、折叠区块、时间线、指标卡片、图表 |
| `editor` | 排序、分类、编辑配置、调参 | 拖拽排序、看板、开关切换、导出按钮 |
| `data-viz` | 可视化、图表、仪表盘、数据展示 | SVG 图表、交互式 tooltip、筛选控制 |
| `diagram` | 流程图、架构图、时序图、图示 | 内联 SVG 图表、标注、交互节点 |
| `deck` | **特例**：仅当用户明确要求"翻页/分页展示"或"多章节幻灯片式报告"时使用；产物容器必须显式声明 `data-deck`（如 `<main data-deck>`）或每页用 `class="deck-slide"` | 键盘导航翻页、章节分隔、进度条 |

**意图 → 形态自动路由（静态优先，交互仅在用户明确要求时启用）：**

| 用户意图关键词 | 形态 |
|---|---|
| 筛选、交互式图表、仪表盘、数据大屏、数据可视化、分析报告带图 | `data-viz` |
| 调参、滑块、动画演示、组件变体、demo、实时预览 | `prototype` |
| 拖拽、排序、编辑、配置、看板、导出 | `editor` |
| 演示、路演、演讲、幻灯片 | **→ 转 slide-craft**（独立完整演示文稿）；仅当用户明确要"翻页/分页/章节翻页"且是文档形态时才用 `deck`（必须显式 `data-deck` 声明） |
| 点击展开、架构、流程图、时序图 | `diagram` |
| 代码审查、diff 分析 | `code-review` |
| 方案对比、技术选型、头脑风暴 | `spec` |
| 结构化报告/总结（默认形态） | `report`（默认静态渲染：折叠章节 + 表格 + 指标卡 + 静态图表；**仅当用户明确要求交互时**才注入筛选/排序/主题切换/tooltip） |
| 用户主动明确要求静态 / 未提任何交互需求（默认） | `static`（纯静态 HTML，无 JS 交互，仅保留原生 `<details>` 折叠） |

**路由规则：**
1. **默认一律生成静态 HTML**：任何请求没有明确交互要求时，产物为纯静态页面（无 JS 交互），**禁止默认注入交互能力**；
2. **只有用户主动明确要求交互**（含"交互/可交互/筛选/拖拽/调参/动态/点击展开/动画/主题切换"等词）才允许生成可交互 HTML；
3. 请求含特定「交互/动态」意图（筛选、交互、仪表盘、大屏、拖拽、调参、点击展开、动画等）→ 选对应动态形态；
4. 形态可组合（如 `data-viz` + `editor`），核心是满足交互意图而非拘泥单形态。
5. **`deck`/翻页是特例，不是默认**：普通长报告默认是"可滚动"的单页静态文档，**禁止**给长文硬加翻页键冒充交互。仅当用户明确要"翻页/分页展示"时，才用 `deck` 并显式声明 `data-deck`。

### 第二步：生成 HTML

按检测到的形态，生成单个 `.html` 文件到 `homework/` 目录。

**文件命名规则：** `homework/{主题-kebab-case}.html`

**必须满足的约束：**

| 约束 | 原因 |
|------|------|
| 所有 CSS 在 `<style>` 标签中 | 无外部样式表，文件离线可用 |
| 所有 JS 在 `<script>` 标签中 | 无 CDN 引入，纯原生 JS |
| 必须包含 `<title>` | 浏览器标签页标识 |
| 必须包含 `<meta charset="utf-8">` | 跨平台一致渲染 |
| 必须包含 `<meta name="viewport">` | 移动端/平板响应式 |
| `<html lang="zh-CN">` 语言声明（与内容语言一致） | 屏幕阅读器/浏览器正确解析（WCAG 3.1） |
| 可选：`<meta name="description">` + data-URI favicon + OG 分享标签 | 分享/收藏/标签页体验 |
| 使用语义化 HTML | `<header>`, `<main>`, `<section>`, `<footer>` |
| SVG 内联，不用 `<img src>` | 无外部文件引用 |
| 文件不超过 500KB | 避免生成时间过长 |
| 直接生成 HTML，不要先生成 Markdown 再转换 | Markdown 转 HTML 丢失形态特定的布局和交互 |

## 设计系统（Birchline · Apple 风格 · 对齐 dynamic-ui Purple）

使用以下 CSS 变量和设计令牌，确保一致的视觉效果。**Apple 风格要点**：中性色对齐 dynamic-ui Neutral、SF Pro 默认首选、圆角略大一档、字重 700 + 负 letter-spacing、层次靠背景色差（不铺边框/投影堆砌）。**配色对齐 BobWork 统一主题（dynamic-ui 默认紫色）**：默认（`:root`）与暗色（`.theme-dark`）两档即「上述一套主题色」——`--accent` ≈ `--brand #4b3fe3`、图表系列 ≈ `--chart-series-1..4`、语义色 `--success/--warning/--danger` 固定；行业主题（`.theme-legal/.theme-education`）仅作内容驱动的可选增强。

### 主题预设

```css
:root {
  /* ============= 中性层：dynamic-ui Neutral（浅色，永不报错） ============= */
  --bg-primary: #ffffff;              /* 卡片纯白 */
  --bg-secondary: #f7f7f8;            /* 页面背景 ≈ --surface */
  --bg-tertiary:  #efeff2;            /* 嵌套表面/代码块 ≈ --surface-muted */
  --text-primary: #171717;            /* ≈ --text */
  --text-secondary: #52525b;          /* ≈ --text-muted */
  --text-tertiary:  #71717a;          /* 辅助文字 */
  --border: rgba(23,23,23,0.12);      /* ≈ --border */
  --border-light: rgba(23,23,23,0.08);

  /* ============= 语义层：dynamic-ui Purple（BobWork 统一品牌色，一套） ============= */
  --accent: #4b3fe3;                  /* ≈ --brand（统一主色） */
  --accent-hover: #3c2eca;            /* ≈ --brand-strong */
  --accent-light: color-mix(in srgb, var(--accent) 12%, transparent);
  --accent-text: #ffffff;             /* ≈ --brand-on */
  --success: #1dc981;                 /* dynamic-ui 语义色（跨主题固定） */
  --success-bg: color-mix(in srgb, #1dc981 12%, transparent);
  --warning: #efaa17;
  --warning-bg: color-mix(in srgb, #efaa17 12%, transparent);
  --danger:  #e8463a;
  --danger-bg:  color-mix(in srgb, #e8463a 12%, transparent);
  --info:    #22a5f7;                 /* ≈ --chart-series-4 */
  --info-bg: color-mix(in srgb, #22a5f7 12%, transparent);

  /* ============= 图表系列：dynamic-ui Chart（紫色 family 阶梯，data-viz 用） ============= */
  --chart-series-1: #3c2eca;
  --chart-series-2: #a9aeff;
  --chart-series-3: #6f6fff;
  --chart-series-4: #22a5f7;
  --chart-other: #d3d4da;

  /* ============= 排版（Apple 风格 7 档） ============= */
  --font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  --font-sans:    -apple-system, BlinkMacSystemFont, 'SF Pro Text',    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  --font-mono: 'SF Mono', 'JetBrains Mono', 'Cascadia Code', monospace;
  --radius-xs:  6px;    /* Apple 最小不用 4px */
  --radius-sm:  8px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;
  --radius-sm-legacy: var(--radius-sm);  /* 向下兼容旧名称 --radius-sm */
  --radius:       var(--radius-md);      /* 向下兼容旧名称 --radius */
  --shadow:    0 1px 2px rgba(0,0,0,.04);
  --shadow-lg: 0 4px 16px rgba(0,0,0,.08);
}

/* 暗色主题（dynamic-ui Neutral/Brand 暗色档 · 深色模式标准档） */
.theme-dark {
  --bg-primary: #171717;              /* ≈ --surface 暗 */
  --bg-secondary: #262626;            /* ≈ --surface-muted 暗 */
  --bg-tertiary:  #303034;
  --text-primary: #e5e5e5;            /* ≈ --text 暗 */
  --text-secondary: #a1a1aa;          /* ≈ --text-muted 暗 */
  --text-tertiary:  #7c7c85;
  --border: rgba(229,229,229,0.12);
  --border-light: rgba(229,229,229,0.08);
  --accent: #6054f1;                  /* ≈ --brand 暗 */
  --accent-hover: #4b3fe3;
  --accent-light: color-mix(in srgb, #6054f1 16%, transparent);
  --accent-text: #ffffff;
  --success: #1dc981; --success-bg: color-mix(in srgb, #1dc981 16%, transparent);
  --warning: #efaa17; --warning-bg: color-mix(in srgb, #efaa17 16%, transparent);
  --danger:  #e8463a; --danger-bg:  color-mix(in srgb, #e8463a 16%, transparent);
  --info:    #22a5f7; --info-bg:    color-mix(in srgb, #22a5f7 16%, transparent);
  --chart-series-1: #4b3fe3;
  --chart-series-2: #a9aeff;
  --chart-series-3: #6f6fff;
  --chart-series-4: #22a5f7;
  --chart-other: #d3d4da;
}

/* 法律墨蓝主题（法律/权威/政务）——中性层对齐 dynamic-ui，只换 accent + 行业专属背景 */
.theme-legal {
  /* 保留法律米色系背景气质（文字层走 dynamic-ui text 档） */
  --bg-primary: #F5F2EC;
  --bg-secondary: #E8E2D7;
  --bg-tertiary:  #D6CDBA;
  --text-primary: #0D1526;
  --text-secondary: #5E6B85;
  --text-tertiary:  #98A4BA;
  --border: rgba(23,23,23,0.12);
  --border-light: rgba(23,23,23,0.08);
  --accent: #1A2845;
  --accent-hover: #142039;
  --accent-light: #D9DEE8;
  --accent-text: #ffffff;
  --success: #1dc981; --success-bg: color-mix(in srgb, #1dc981 12%, transparent);
  --warning: #efaa17; --warning-bg: color-mix(in srgb, #efaa17 12%, transparent);
  --danger:  #e8463a; --danger-bg:  color-mix(in srgb, #e8463a 12%, transparent);
  --info:    #22a5f7; --info-bg:    color-mix(in srgb, #22a5f7 12%, transparent);
}

/* 教育暖橙主题（教育/成长/温馨）——中性层对齐 dynamic-ui，只换 accent + 行业专属背景 */
.theme-education {
  --bg-primary: #FBF6EF;
  --bg-secondary: #F4E8D5;
  --bg-tertiary:  #E8D5BC;
  --text-primary: #2D1810;
  --text-secondary: #7A5C48;
  --text-tertiary:  #B8A595;
  --border: rgba(23,23,23,0.12);
  --border-light: rgba(23,23,23,0.08);
  --accent: #FF9500;                  /* 教育暖橙（行业 accent，保留） */
  --accent-hover: #E08600;
  --accent-light: color-mix(in srgb, #FF9500 12%, transparent);
  --accent-text: #ffffff;
  --success: #1dc981; --success-bg: color-mix(in srgb, #1dc981 12%, transparent);
  --warning: #efaa17; --warning-bg: color-mix(in srgb, #efaa17 12%, transparent);
  --danger:  #e8463a; --danger-bg:  color-mix(in srgb, #e8463a 12%, transparent);
  --info:    #22a5f7; --info-bg:    color-mix(in srgb, #22a5f7 12%, transparent);
}
```

### 字体配对策略（Apple 风格：SF Pro 默认首选 + 行业字体可选增强）

**SF Pro Display / SF Pro Text / PingFang SC 是默认首选**（已在上方 `--font-display/--font-sans` 中注入，渲染 `:root` 自动生效），它们就是 Apple 风格的标志——不用手写任何行业字体即能获得标准审美。

**行业配对字体（Space Grotesk / Fraunces / Cormorant Garamond / Spectral 等）** 为**可选增强**：仅当内容需要特定行业气质（如法律权威衬线、奢华手写感）时，在 HTML 文件 `<style>` 顶部覆盖：
```css
:root { --font-display: 'Fraunces', -apple-system, ...; }
```
不做强制要求。**禁止 Inter / Roboto / Arial / Segoe UI** 等"非 Apple 系统字体"出现在字体栈中。

### 主题选择（强制第一步）

**开始写 HTML 前，先判断内容主题并选择一个匹配的主题**：内置默认兜底亮色已对齐 dynamic-ui Purple（中性层安全、accent=`#4b3fe3` 统一品牌色），当内容本身是"科技/通用/数据/仪表盘"时可以直接用默认（无需覆盖）；行业专属内容按下方映射换 accent 色相并替换 `--accent/--accent-hover/--accent-light`（中性层保持 dynamic-ui 不换，保证跨行业统一视觉基底）：

| 内容主题 | 色相方向（默认 Purple 统一品牌色优先，行业色仅作内容区分） |
|---|---|
| 通用 / 数据 / 科技 | `#4b3fe3`（Purple 统一品牌色，默认即用）或金融深蓝 `#1B4D7E` |
| 健康 / 医疗 / 自然 | 医疗青绿 `#2D9B8F` 或 systemGreen 系 `#34C759` |
| 教育 / 学习 / 成长 | 教育暖橙 `#FF9500`（行业 accent） |
| 法律 / 权威 / 政务 | 法律墨蓝 `#1A2845` |
| 艺术 / 时尚 / 创意 | 艺术品红 `#E8463A` 或 Apple systemPurple `#AF52DE` |
| 奢华 / 高端 | 奢华金 `#C5A572`（深色底） |
| 海洋 / 水域 / 环保 | 海洋青绿 `#22a5f7`（chart-series-4）或 `#2D9B8F` |

执行要求：
- **套用主题 = 覆盖 `--accent/--accent-hover/--accent-light` + 可选覆盖 `--bg-*` 行业背景**（中性层保持 Apple，跨文档一致性更强）
- 产物结构建议把主题做成**可切换能力**：定义 `.theme-*` 类 + 右上角主题选择器（JS 切换 body class），默认带「自动 / 亮 / 暗」三档——自动档跟随系统 `prefers-color-scheme`（`matchMedia` 监听），手动选择后以选择为准；静态产物（无 JS）至少提供亮色默认 + `@media (prefers-color-scheme: dark)` 自动暗色

### 通用样式（Apple 风格：700 字重 + 负 tracking + 行高 1.5 + 按钮按压反馈 + tabular-nums）

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-font-smoothing: antialiased; }
body {
  font-family: var(--font-sans);
  color: var(--text-primary);
  background: var(--bg-secondary);        /* 外层用 Apple 二级背景，卡片放纯白 → 自然色差层次 */
  line-height: 1.5;                       /* Apple 标准 1.5 不是 1.6 */
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 20px;
}
h1, h2, h3, h4, h5, h6 { font-family: var(--font-display); font-weight: 700; letter-spacing: -0.02em; }
h1 { font-size: 1.75rem; margin-bottom: 0.5rem; letter-spacing: -0.02em; }
h2 { font-size: 1.3rem;  margin: 1.5rem 0 0.75rem; padding-bottom: 0.25rem;
     border-bottom: 1px solid var(--border); letter-spacing: -0.01em; }
h3 { font-size: 1.1rem;  margin: 1.25rem 0 0.5rem; letter-spacing: -0.01em; }
p  { margin: 0.5rem 0; }
code {
  font-family: var(--font-mono);
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  font-size: 0.875em;
  font-variant-numeric: tabular-nums;
}
pre {
  background: var(--bg-tertiary);
  border: none;                            /* Apple 风格：去边框，靠色差分层 */
  border-radius: var(--radius-md);
  padding: 14px 16px;
  overflow-x: auto;
  margin: 0.75rem 0;
}
pre code { background: none; padding: 0; }
table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
th { background: var(--bg-secondary); font-weight: 600; }

/* —— Apple 风格组件：卡片 / 按钮 / KPI / 标签（bob-vis 体系对齐） —— */
.card {
  background: var(--bg-primary);
  border: none;
  border-radius: var(--radius-lg);        /* 14px */
  padding: 12px 16px;
  /* 无 border 无 shadow，靠 background 与外层 #f7f7f8（--bg-secondary）的色差形成层次（Apple 核心） */
}
.btn {
  font: 500 14px var(--font-sans);
  padding: 6px 14px;
  border-radius: var(--radius-sm);        /* 8px */
  border: none;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  transition: filter .15s ease, transform .1s ease;
}
.btn:hover  { filter: brightness(0.95); }
.btn:active { transform: scale(0.96); }   /* Apple 按压反馈 */
.btn--primary { background: var(--accent); color: #fff; }
.btn--primary:hover { filter: brightness(1.05); }
.tag {
  display: inline-block;
  font: 400 12px/1 var(--font-sans);
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.tag--success { background: var(--success-bg); color: var(--success); }
.tag--warning { background: var(--warning-bg); color: var(--warning); }
.tag--danger  { background: var(--danger-bg);  color: var(--danger);  }
.tag--accent  { background: var(--accent-light); color: var(--accent); }
.kpi { text-align: center; }
.kpi .value {
  font: 700 20px var(--font-display);
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  color: var(--accent);
}
.kpi .label { font: 400 12px var(--font-sans); color: var(--text-secondary); }

/* —— 键盘可达性：所有可交互元素必须有可见焦点环（禁止裸删 outline） —— */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* —— 深色自动跟随：主题切换器提供「自动 / 亮 / 暗」三态，自动态监听系统偏好 ——
   JS 侧：const mq = matchMedia('(prefers-color-scheme: dark)');
          body.theme-auto 时按 mq.matches 切换 .theme-dark / 移除，并监听 mq.change */
@media (prefers-color-scheme: dark) {
  body.theme-auto { background: #171717; color: #e5e5e5; }
  body.theme-auto .card { background: #262626; }
}

/* —— 打印导出（报告/文书/存档场景必加）：隐藏交互控件、强制浅色、避免卡片裁断 —— */
@media print {
  body { background: #fff !important; color: #000 !important; max-width: none; padding: 0; }
  .no-print, button, .btn, input, select, textarea, [data-no-print] { display: none !important; }
  .card, section, table, pre { break-inside: avoid; }
  a[href]::after { content: " (" attr(href) ")"; font-size: .8em; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
```

## 设计质量标准（务必遵守 · Apple 风格）

避免千篇一律的「AI 味」模板感（通用紫色渐变 + 圆角卡片堆砌 + 居中大标题 + 无意义装饰），做到：

- **字体层级**：标题档 700 字重 + 负 letter-spacing；数据/代码统一用 `font-variant-numeric: tabular-nums`（等宽对齐，Apple 数据界面细节指纹）
- **留白与密度**：信息分组清晰，卡片间距一致，避免满屏堆砌、避免元素全等大；层次区分优先靠**背景色差**而非投影/边框
- **对比与可读性**：正文对比度 ≥ 4.5:1；语义色（成功/警告/错误）全文档用途一致；颜色统一使用 dynamic-ui Purple 一套 Token（中性/品牌/图表/语义，见「主题预设」）或行业 accent（强调层）
- **无障碍（WCAG 基础，与视觉同权）**：见下方「无障碍必检清单」——`<html lang>`、表单 label、图标按钮 aria-label、可见焦点环、表格 caption/scope、SVG 图表 `role="img"`+`aria-label`、heading 层级连续、关键信息不依赖 JS 渲染（渐进增强）
- **视觉锚点**：每屏有 1 个主视觉焦点（大数字、图表或色块），不平均用力
- **响应式**：小屏优先可用（表格横向滚动、控件换行、图表缩放）；栅格一律 `repeat(auto-fit, minmax(140px, 1fr))`；**390px 宽无横向溢出、200% 浏览器缩放布局不崩**（断点按内容实际断点设置，不套固定 768/480）
- **克制**：最多 2-3 个强调色；动画服务信息层级而非炫技；不用 emoji 充当装饰

**禁忌清单（默认禁用；用户明确要求才可用，并注明"有意识选择"）**：
1. ❌ 写死其它品牌主色（默认已统一为 BobWork 品牌 Purple `#4b3fe3`，必须走 `--accent` 引用，不要引入新的主色相）❌ 蓝紫渐变（dynamic-ui 扁平原则禁渐变；Apple systemBlue `#007AFF`/systemPurple `#AF52DE` 仅作语义色可用，不作主色）
2. ❌ 奶油米白底 + 高对比衬线 + 赤陶橙点缀（典型 AI 海报审美）
3. ❌ 近黑底 + 酸性霓虹绿 / 朱红（赛博朋克审美，除非用户明确要求并注明是有意识选择）
4. ❌ 报纸风 + 密集 3 列以上小字号排版
5. ❌ 荧光色作大面积
6. ❌ 语义色（绿涨红跌）只因为标签带"成功/失败"字样就上色——只有数据本身是状态/风险语义时才用
7. ❌ Inter / Roboto / Arial / Segoe UI 等"非 Apple 系统字体"——用 SF Pro / PingFang SC（`:root` 已默认注入）

## 无障碍必检清单（WCAG 基础 · 与设计质量同权，静态与交互产物都查）

1. `<html lang>` 与内容语言一致（中文内容 `lang="zh-CN"`）
2. 每个 `input/select/textarea` 必须有 `<label>` 或 `aria-label`（禁止只有 placeholder）
3. 图标按钮必须有 `aria-label` 或 `title`（如 deck 翻页、主题切换、导出、复制）
4. 所有可交互元素有可见 `:focus-visible` 焦点环（禁止裸删 outline）
5. 键盘可达：Tab 顺序自然、Enter/Escape 可操作；deck 支持方向键翻页；弹层打开时焦点移入
6. 表格：`<caption>` 一句话描述 + `<th scope="col/row">`（纯装饰列除外）
7. 内联 SVG 图表：容器 `role="img"` + `aria-label` 一句话摘要；关键数据同时在表格/正文中可见（图表不是唯一信息载体）
8. heading 层级连续不跳级（h1→h2→h3）
9. 语义色不止靠颜色传达：状态同时用文字/图标/符号表达
10. **渐进增强**：关键结论、数据、导航在无 JS 时仍完整可见——JS 只做增强（筛选/动效/交互），**禁止核心内容由 JS 渲染、禁用 JS 即空白**

## 8 种形态的生成模式

### spec（方案对比/规范分析）

- 使用并排卡片网格（`grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`）
- 每个方案一个卡片，包含标题、优缺点列表、适用场景
- 用 SVG 绘制决策流程图
- 风险矩阵表（概率 × 影响）
- 结论区使用 `--success-bg` 背景高亮推荐方案

### code-review（代码审查）

- 文件路径作为 section 标题
- 代码块使用深色背景，行号左侧显示
- 严重标记：`--danger` 红色（必须修改）、`--warning` 橙色（建议修改）、`--info` 蓝色（可选）
- 问题列表用编号，每条关联到代码中的行号
- 点击问题可跳转到对应代码区域（锚点）

### prototype（原型/交互演示）

- 控制面板在顶部（滑块、开关、下拉选择）
- 预览区域在下方，JS 监听 input 事件实时更新
- CSS 动画演示使用 `@keyframes`
- 多个变体并排展示，带标签
- 每个控件旁显示当前值

### report（报告/文档）——静态报告（默认形态）

**默认静态渲染（无 JS 交互，除非用户明确要求交互）：**
- 可折叠章节用原生 `<details>` + `<summary>`（无需 JS，离线可用）
- 数据表格、指标卡、SVG 图表均为静态渲染
- 章节锚点导航用原生锚点链接（目录点击跳转）
- **仅当用户主动要求交互**时，才注入 JS 交互（主题切换、筛选联动、图表 tooltip、排序等）

**状态驱动架构（仅交互版 report 使用，参考 GitHub 单文件应用范式：DATA + RENDERERS + FILTERS）：**
```js
// 1) 数据集中声明
const DATA = [...];
// 2) 全局状态（筛选/排序/主题/搜索……）
let state = { filter: 'all', sort: 'asc', theme: 'light', q: '' };
// 3) 控件只改 state，再由 render() 全量重绘
function render(){ /* 依据 state 重绘图表/表格/卡片 */ }
document.querySelectorAll('[data-filter]').forEach(btn => {
  btn.addEventListener('click', () => { state.filter = btn.dataset.filter; render(); });
});
```
- 禁止把数据写死在 DOM 里、控件无实际效果；每个控件改变 state 后必须触发可见的界面变化。

**其余内容规范：**
- **首屏信息架构（所有形态通用）**：首屏必须让读者一眼回答三问——① 这是什么 ② 为什么重要 ③ 应该带走什么结论；report 用 TL;DR 摘要卡，data-viz 用总览指标，prototype/editor 用一句话用途说明
- 顶部 TL;DR 摘要卡片（`--info-bg` 背景，左侧 `--info` 色条）
- 时间线用纯 CSS（左边框 + 圆点 + 日期标签）
- 关键指标用大数字卡片（grid 布局，突出显示）
- 表格用于数据对比
- SVG 图表嵌入（柱状图、折线图用内联 SVG）
- 底部附注/来源
- **打印适配（报告/文书必加）**：`@media print` 隐藏交互控件（按钮/筛选/主题切换器）、强制浅色、`break-inside: avoid` 防卡片/表格裁断（参考上方「通用样式」打印块）

### static（纯静态文档）——默认形态

- 无 `<script>` 标签、无 JS 交互；仅 `details/summary`（无 JS 的原生折叠）可保留
- 所有内容静态渲染：SVG 静态图表、纯文本、表格
- **默认产物即为此形态**；命中关键词：静态、纯静态、无交互、不要动效、不要 JS、纯文本页面，或用户未提任何交互需求

**翻页章节分隔（可选，仅 `deck` 形态）：** 只有当产物是 `deck`（已显式声明 `data-deck`）时，才按章节组织并加翻页分隔。普通报告**不要**加章节分隔符、**不要**做翻页——保持可滚动单页应用。

```html
<!-- ===== 章节标题 ===== -->
```

结构约定：
- 分隔符**之前**的内容（标题 + TL;DR + KPI 总览）为首屏总览页
- 每个 `<!-- ===== 标题 ===== -->` 之后到下一个分隔符之前为独立一页
- 分隔符注释本身不渲染，仅作章节切分标记；**同一份文件双形态兼容**：在节点预览中点「PPT 翻页」即按章节逐页展示（翻页按钮/圆点/页码），不点则常规滚动阅读
- 分隔符统一用 5 个等号（`=====`）便于识别；单章节或无章节的报告不必加分隔符

### editor（编辑器/配置工具）

- 使用原生 HTML5 拖拽 API（`draggable`）
- 看板列用 flexbox 水平排列
- 开关切换用 CSS 伪元素模拟
- 导出按钮触发 `Blob` 下载
- 拖拽时高亮放置区域

### data-viz（数据可视化）

- 柱状图：SVG `<rect>` 元素，高度绑定数据
- 折线图：SVG `<polyline>`，points 属性绑定数据
- 饼图：SVG `<circle>` + `stroke-dasharray` 模拟扇区
- 多系列对比：填充/描边色依次用 `--chart-series-1..4`（≤4 系列），聚合剩余项用 `--chart-other`
- 交互 tooltip：JS `mouseenter`/`mouseleave` 切换显示
- 筛选控件：下拉选择触发重新渲染
- 数据表格配合图表

### diagram（图表/流程图）

- 完全使用内联 SVG 绘制
- 流程图：圆角矩形 + 箭头连接线 + 文字标签
- 架构图：分层盒子 + 组件标签
- 时序图：垂直生命线 + 水平箭头
- 交互：点击节点展开/收起详情（JS 控制）
- 使用 `<defs>` 定义箭头标记、渐变等

### deck（幻灯片）——仅显式声明时使用

**前置要求：必须显式声明翻页结构**，否则 HtmlViewer 不会启用翻页，产物将退化为普通滚动页：
- 容器声明 `data-deck`（如 `<main data-deck>`），或每页 `class="deck-slide"`（≥2 页）
- 普通交互式 HTML 产物禁止出现 `.slide` 类名（会误触发翻页劫持）

- 容器 16:9 比例锁定（`padding-bottom: 56.25%`）
- 键盘导航：← → 切换幻灯片、Home/End 跳首尾
- 底部进度条（当前页/总页数）
- 幻灯片类型：标题页、内容页（标题+要点）、图片页、代码页
- 过渡动画用 CSS `transition` 或 `transform`
- 每张幻灯片一个 `<section class="deck-slide">`，通过 CSS display 控制显隐

## 复杂交互能力（原生 JS，仍为单文件）

单文件约束下可实现的全部交互模式，按需组合：

- **状态管理**：全局 `const state = {...}` + `render()` 重绘函数；交互只改 state 后调用 render()
- **视图切换/路由**：hash 路由（`location.hash` + `hashchange` 监听），按 hash 渲染不同 section，支持深链（刷新保持状态——法律报告复核场景实用）
- **筛选/联动**：下拉/日期/多选控件绑定 change → 过滤数据 → 重绘图表与表格
- **拖拽**：HTML5 `draggable` 或 Pointer Events（dragstart/dragover/drop）
- **动态图表**：SVG 元素由 JS 按数据生成（`<rect>/<polyline>/<circle>`），支持交互 tooltip 与 CSS transition 动画
- **Canvas 动画/生成艺术**：原生 Canvas 2D API 实现粒子、流场、数据动画（不引入 p5.js 等库，保持离线单文件）
- **键盘交互**：`keydown` 监听（deck 翻页、快捷键）
- **导出**：`Blob` + `URL.createObjectURL` 下载 CSV/JSON/文本

**禁止：** 引入 CDN/框架/构建工具；JS 报错白屏（关键交互逻辑用 try/catch 包裹并给出降级提示）。

**「真交互」必选清单（仅当用户主动要求交互的产物必须满足，否则视为不合格重做）：**
- 至少实现 **3 种以上真实操作**：筛选联动 / 排序 / 搜索 / 图表 hover tooltip / 拖拽 / 主题切换 / 增删改 / 折叠
- 每个控件必须有**可见反馈**：点击/切换后内容、图表、数字或状态必须实际变化——禁止"按钮存在但无效果"
- 存在输入类控件（`input/select/textarea/button`）时必须绑定事件处理器
- 数据与渲染分离：数据集中 `const DATA`，`render()` 全量重绘，禁止写死静态 DOM 冒充交互
- 判定标准：`interact_preview` 冒烟测试中点击任一控件后截图，前后视觉描述必须有可感知差异

## 生成后验证清单

生成文件后，逐项检查：

1. 文件是否保存到 `homework/` 目录
2. 是否包含 `<html>`, `<head>`, `<body>` 完整结构
3. `<title>` 是否存在且有意义
4. `<meta charset="utf-8">` 是否存在
5. `<meta name="viewport">` 是否存在
6. 是否没有任何外部 URL 引用（`src=`、`href=` 指向外部）
7. 文件是否使用语义化标签（非纯 `<div>` 堆砌）
8. SVG 是否内联（非 `<img src="">` 引用）
9. 文件大小是否控制在合理范围（< 500KB）
10. 默认静态性：默认产物为纯静态页面（无 JS 交互，仅原生 `<details>` 折叠）；**仅当用户主动要求交互（"交互/筛选/拖拽/动态"等词）时才生成可交互 HTML**，且必须满足「真交互」必选清单（≥3 种真实操作 + 控件有反馈 + 状态驱动渲染），**无任何交互控件（input/select/textarea/button/事件监听）的交互版即判不合格重做**
11. 交互是否可运行（仅交互版检查）：关键 JS 路径无语法错误，控件点击/筛选有实际反馈
12. 翻页分隔仅 `deck` 形态（显式 `data-deck` 声明）使用；普通报告禁止加章节分隔符/翻页键
13. 设计质量自查：字体层级、留白、对比度、主视觉焦点符合上方「设计质量标准」
14. **自动截图验证（静态渲染）**：调用 `capture_preview` 工具（传文件路径），真实 Chromium 自动截图并用视觉模型检查渲染效果
15. **交互冒烟验证（仅当产物含交互时必做）**：调用 `interact_preview` 工具（传文件路径 + 一段脚本：如 `document.querySelector('button,select,input,details summary').click()` 或切换筛选/主题），工具会先执行脚本再截图并对比视觉描述。**前后必须有可感知差异**（内容/图表/状态变化）；无差异说明控件无效果或未绑定事件，判定不合格并修复后重测
16. **无障碍检查（全部产物）**：对照「无障碍必检清单」——`<html lang>`、input 有 label/aria-label、图标按钮有 aria-label/title、`:focus-visible` 焦点环存在、表格 caption/scope、SVG 图表 role="img"+aria-label、heading 不跳级、核心内容不依赖 JS 渲染
17. **打印适配（报告/文书/存档形态）**：`@media print` 块存在——隐藏交互控件、强制浅色、卡片/表格不裁断
18. **响应式抽查**：390px 窄屏无横向溢出（表格/图表缩放或滚动容器正确）；200% 浏览器缩放布局不崩

**❌ 禁止调用 `browser.navigate` 打开 `file://` 协议验证**——WebBridge 不支持 `file://`，会导致 60s 超时卡死。唯一自动验证方式是 `capture_preview`（静态渲染）与 `interact_preview`（交互冒烟）两个工具。

## 完成输出

生成完成后，告知用户：
1. 文件绝对路径
2. 产物形态 + 关键特性摘要
3. 使用 `open` (macOS) 命令可直接在浏览器打开
4. 告知用户：该文件已保存到 homework 目录，可在左侧文件树中查看和打开
