# 样式标尺：品牌 Purple 色板 · 字体 · 字号 · 间距 · 圆角 · 阴影（L3 按需资源）

> 需要精确色值 / 字体栈 / 字号间距圆角阴影档位时加载；L2 正文已给出执行流程，此处是细节速查表。
> 由原 01-color-font-palette + 02-typography-spacing-rulers 合并（消除字体重叠）。

---

## 1. 统一品牌 Purple 主题色板（BobWork 全局唯一主色，不设行业色板）

**所有 widget（chart / svg / html / mermaid / antv）主色一律品牌 Purple `#4b3fe3`，不设六大行业色板、不做行业判色。**

| 用途 | 浅色模式 | 深色模式 |
|---|---|---|
| 主色 / 强调 `--brand` / `--widget-accent` | `#4b3fe3` | `#6054f1` |
| 主色强 `--brand-strong` | `#3c2eca` | `#6f6fff` |
| 主色浅底 `--brand-soft` | `#f2f7ff` | `rgba(96, 84, 241, .16)` |
| 页面背景 `--surface` | `#f7f7f8` | `#171717` |
| 次一档背景 `--surface-muted` | `#efeff2` | `#262626` |
| 卡片底色 | `#FFFFFF` | `#303034` |
| 主文字 `--text` | `#171717` | `#e5e5e5` |
| 次级文字 `--text-muted` | `#52525b` | `#a1a1aa` |
| 边框 `--border` | `rgba(23, 23, 23, .12)` | `rgba(229, 229, 229, .12)` |
| 图表系列 1-4 | `#3c2eca / #a9aeff / #6f6fff / #22a5f7` | `#6054f1 / #6f6fff / #a9aeff / #22a5f7` |
| 图表兜底色 | `#d3d4da` | `#d3d4da` |
| 语义：成功 / 警示 / 危险 | `#1dc981 / #efaa17 / #e8463a` | 同左 |

**数据系列区分**：一律用 Purple family 深浅分层（`#4b3fe3 → #6f6fff → #a9aeff → #d3d4da`），**不引入其它色相**。

---

## 2. 字体族变量与字号梯度

### 2.1 字体族变量（渲染器已注入，直接引用）

| 变量 | 用途 | 字体栈（兜底顺序） |
|---|---|---|
| `--widget-font-display` | 标题 / KPI 数字 / Display 档 | `-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif` |
| `--widget-font-body` | 正文 / 标签 / 图表刻度 / Label 档 | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif` |
| `--widget-font-mono` | 代码 / 数据值 / 金额精确列 | `"SF Mono", "JetBrains Mono", "Cascadia Code", monospace` |

**SF Pro / PingFang SC 是默认首选**（Apple 风格核心标志），渲染器已注入，不需要额外覆盖即可获得 Apple 审美。可选增强字体（Spectral 600 衬线权威 / Cormorant Garamond 600 人文 / Space Grotesk 600 / Outfit 400 几何）——仅当需要特定气质时写在 HTML widget `<style>` 顶部覆盖 display，不做强制。**禁止 Inter / Roboto / Arial 等"非 Apple 系统字体"**。

### 2.2 字号梯度（七档，禁止 11-24px 之外的 ad-hoc 字号）

行高：正文档 **1.5**（Apple 标准），标题档 1.4。

| 档位 | px 值 | 字重 | letter-spacing | 典型用途 |
|---|---|---|---|---|
| `caption` | 11px | 400 | 0 | 轴标签、脚注、数据来源标注、估算标"约" |
| `label` | 12px | 400 | 0 | 图例、标注、表头、`.w-tag` 标签文字、KPI 的 label |
| `body-sm` | 13px | 400 | 0 | 信息图卡片内部正文、紧凑卡片摘要 |
| `body` | 14px | 400 | 0 | 正文默认档、HTML 组件正文、图内叙述文字 |
| `title` | 16px | **700** | **-0.01em** | 卡片标题、小节标题（≤ 1 行，不得超出） |
| `headline` | 20px | **700** | **-0.01em** + `tabular-nums` | KPI 数字、强调关键数据、`.w-kpi .value` 默认档 |
| `display` | 24px | **700** | **-0.02em** + `tabular-nums` | 大 KPI、数据看板总标题、大图中心数字（仅 1 处） |

Apple 风格要点：
- 标题/数字用 **700 字重 + 负 letter-spacing**（Apple 大标题标志性特征）
- KPI 数字加 `font-variant-numeric: tabular-nums` + `font-feature-settings: "tnum"`（等宽对齐）
- 正文行高 **1.5**（不是 1.6，Apple 标准更紧凑）

使用建议：HTML 组件优先复用 `.w-card / .w-title / .w-kpi / .w-tag / .w-btn` 预置类（已 token 化），不要手写完全一样的 style；需要微调时只改 `font-size` 档位，不越级。

---

## 3. 间距标尺（五档 + 2 大留白档，禁止标尺外 10/15/18/20px 随手写）

| Token | px | 典型用途 |
|---|---|---|
| `--widget-space-xs` | 4 | 图标与文字之间、标签内 padding、紧凑元素间距 |
| `--widget-space-sm` | 8 | 元素间最小间距、列表项、`.w-tag` 内距、标题下方到正文的最小间隔（8-12px） |
| `--widget-space-md` | 12 | 卡片内距（默认）、网格 gap（KPI 行/卡片网格）、`.w-card` padding |
| `--widget-space-lg` | 16 | 区块间距、宽松卡片内距、章节间分隔间距（块级元素之间） |
| `--widget-space-xl` | 24 | 大板块间距、章节头留白、KPI 行下方与图上方的呼吸间距 |
| `--widget-space-2xl` | 32 | 页面级留白（极罕用，整图 ≤ 1 处） |

垂直节奏（HTML/SVG 共用）：以 8px 为**基准节奏单位**，所有间距是 4 的倍数（4/8/12/16/24/32），禁止 5/6/7/9/10/11/13/14/15/17/18/19/20/22…。

---

## 4. 圆角标尺（Apple 风格，比上一版略大一档）

| Token | px | 用途 |
|---|---|---|
| `--widget-radius-xs` | 6 | 小标签 / 小 badge / 最小输入控件（Apple 最小不用 4px） |
| `--widget-radius-sm` | 8 | 按钮 `.w-btn` / 输入框 / 小图标容器 |
| `--widget-radius-md` | 10 | 小卡片 / SVG 节点 / `.w-kpi` 背景块 |
| `--widget-radius-lg` | 14 | 默认卡片 `.w-card` / 容器（系统默认档） |
| `--widget-radius-xl` | 20 | 大容器 / 信息图外框 / 海报型卡片 |
| `pill` | 999 | tag/徽章（全圆角） |

不要混搭：同一层级的卡片圆角一致（不要出现 8px/10px/14px 三种在一排）。

---

## 5. 阴影层级（Apple 风格：克制，层次靠背景色差 + 毛玻璃）

Apple 设计语言中，层次区分**优先靠背景色差**（如 `#FFFFFF` 卡片浮在 `#F2F2F7` 背景上），而非投影。阴影仅作辅助。

| Token | 值（浅色） | 用途 |
|---|---|---|
| `--widget-shadow-sm` | `0 1px 2px rgba(0,0,0,.04)` | 默认卡片（仅当背景色差不足以区分时使用） |
| `--widget-shadow-md` | `0 2px 8px rgba(0,0,0,.06)` | 悬浮状态 / 可点击卡片 hover / 推荐项强调 |
| `--widget-shadow-lg` | `0 4px 16px rgba(0,0,0,.08)` | 弹出层 / 浮层（极罕用在静态图） |

深色模式下阴影透明度减半：`rgba(0,0,0,.02)` / `.03` / `.04`，避免黑底上"浮起"的塑料感。

**`.w-card` 默认白卡已注入**——`background: var(--widget-card)`（浅色 `#FFFFFF`，浮在分组灰 `var(--widget-bg)` 上）+ `1px solid var(--widget-border)` + `box-shadow: var(--widget-shadow-sm)`，渲染器已内置，**直接引用不要再写**。需要强调时加 `box-shadow: var(--widget-shadow-md)` 或 `backdrop-filter: blur(20px) saturate(1.8)`（frosted glass 毛玻璃效果）。

---

## 6. 执行要求与禁忌（强制 · 统一品牌 Purple）

- **必须显式给出色值**：
  - ECharts → `option.color: ["#4b3fe3","#6f6fff","#a9aeff",…]`（Purple 图表系列）
  - SVG → fill/stroke 直接写色（焦点节点 brand-soft 浅底 + Purple 描边，例：`fill="#f2f7ff" stroke="#4b3fe3"`）
  - HTML widget → 片段顶部 `<style>` 定义 `--accent`（`#4b3fe3`）、`--bg-secondary`、`--text-primary`、`--text-secondary` 等变量（推荐），或直接写色值
- 渲染器默认色板（chartPalette）已对齐 Purple 图表系列，**只在你未指定时兜底**——你应按 Purple 一套主动写色
- **主色面积 ≤ 15%**：主色只出现在标题、标签、线条、焦点节点上，不铺大色块
- **深色模式处理**：主色换成深色档 `#6054f1`，保证可读、无荧光感
- **dynamic-ui Purple Token 速查**（BobWork 统一品牌色，与宿主 `--brand/--surface/--chart-series-*` 完全同值）：
  - `--brand` `#4b3fe3`（深 `#6054f1`）/ `--brand-strong` `#3c2eca` / `--brand-soft` `#f2f7ff`
  - `--surface` `#f7f7f8`（深 `#171717`）/ `--surface-muted` `#efeff2`（深 `#262626`）
  - `--text` `#171717`（深 `#e5e5e5`）/ `--text-muted` `#52525b`（深 `#a1a1aa`）
  - `--chart-series-1..4` `#3c2eca / #a9aeff / #6f6fff / #22a5f7` + `--chart-other` `#d3d4da`
  - 语义色（跨主题固定）：`--success` `#1dc981` / `--warning` `#efaa17` / `--danger` `#e8463a`
- **禁忌清单**：
  1. ❌ 写死其它品牌主色 / 行业色（金融深蓝 `#1B4D7E`、法律墨蓝 `#1A2845`、医疗青绿、教育暖橙、艺术品红、奢华金等一律禁止）——widget 必须走 `--accent` / `var(--brand)` 引用或直接写 `#4b3fe3`，**不引入新色相** ❌ 蓝紫渐变（dynamic-ui 扁平原则禁渐变；Apple systemBlue `#007AFF` / systemPurple `#AF52DE` 仅作语义色可用，不作主色）
  2. ❌ 禁止"奶油米白底 + 高对比衬线 + 赤陶橙点缀"（典型 AI 海报审美）
  3. ❌ 禁止"近黑底 + 酸性霓虹绿 / 朱红"（赛博朋克审美，除非用户明确要求并注明是有意识选择）
  4. ❌ 禁止报纸风 + 密集 3 列以上小字号排版
  5. ❌ 禁止荧光色作大面积
  6. ❌ 禁止语义色（绿涨红跌）只因为标签带"成功/失败"字样就上色——只有数据本身是状态/风险语义时才用
  7. ❌ 禁止 Inter / Roboto / Arial 等"非 Apple 系统字体"——用 SF Pro / PingFang SC（渲染器默认已注入）
