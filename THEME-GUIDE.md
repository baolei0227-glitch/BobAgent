# BobWork 主题设计指南（统一 Purple）

> 本文档是 **BobWork** 界面主题系统的设计规范，供开发者与 AI 共同参考。
> AI 可通过 `get_current_theme` 工具获取当前生效主题的实时变量值；`get_app_config` 可获取主题摘要。
> 产品名统一为 BobWork（本项目目录名 BobAgent 仅表示仓库位置，不代表产品名）。

---

## 一、主题策略总览（单一品牌色）

BobWork 采用**彻底单一品牌色**策略：默认主题 **Purple**（对齐 dynamic-ui 默认紫色主题），App / 小程序 / Widget 同读同一组 CSS Token。

- **三层 Token 模型**：Neutral（中性表面/文字/边框）、Brand（品牌色，主题唯一可变源）、Semantic（语义色固定）、Chart（图表系列，由 Brand 派生）
- **旧多主题预设已移除**：graphite / mist / heritage / abyss / cyber / apple 等 6 套预设与相关装饰样式已从 `globals.css` 删除
- **AI 换肤（`design_theme`）已移除**：不再支持模型生成自定义主题；`normalizeCustomThemes` 强制收敛 `theme='warm'` 并清空历史 `customThemes`
- **主题 id 保留 `warm`**：为兼容历史已保存设置，内部 id 不变；展示名（THEME_OPTIONS label）为 `Purple`
- **深色档**：主界面为浅色；小程序 iframe 支持 `html[data-bob-dark="true"]` 深色档，品牌/中性色按 dynamic-ui 暗色值切换

---

## 二、CSS 变量体系架构

所有主题共用同一套 CSS 变量命名，通过 `:root:not([data-theme]), [data-theme="warm"]` 选择器生效。变量分块：

| 层级 | 变量前缀 | 用途 |
|------|----------|------|
| shadcn 基底 | `--background` `--foreground` `--card` `--primary` 等 | 兼容 shadcn/ui 组件库的标准变量（19 个） |
| 纸张色系 | `--paper*` | 节点卡片、弹窗、侧边栏的背景层次（4 个） |
| 文字色系 | `--ink*` | 正文、标题、辅助文字的对比度层次（4 个） |
| 边框色系 | `--line*` | 分割线、卡片边框（2 个） |
| 主色系 | `--primary*` | 主色的强化、弱化变体（3 个） |
| 统一 Token · Brand | `--brand*` | 品牌色及浅底/文字（6 个） |
| 统一 Token · Neutral | `--surface*` `--text*` `--border` | 中性表面/文字/边框（5 个） |
| 统一 Token · Chart | `--chart-series-*` `--chart-other` | 数据图表系列色（5 个） |
| 状态色系 | `--info` `--success` `--warn` `--danger` `--purple` `--teal` 及 `-soft` | 语义状态指示（12 个） |
| 输入控件 | `--input-*` | 输入框专用背景和边框（2 个） |
| 画布背景 | `--canvas-bg` | 画布底色（区别于全局 `--background`）（1 个） |

> 合计约 60+ 个变量，覆盖界面全部可定制色值；`--primary`/`--border` 等旧别名与统一 Token 同值，存量组件零改动。

---

## 三、统一主题 Purple 关键色值

### 3.1 亮色档（主界面默认）

| Token | 值 | 用途 |
|------|------|------|
| `--brand` / `--primary` | `#4b3fe3` | 主色：按钮、标签、选中态、主图表系列 |
| `--brand-strong` / `--primary-strong` | `#3c2eca` | 主色加深：hover、按下态 |
| `--brand-soft` / `--primary-soft` | `#f2f7ff` | 品牌浅底：选中底色、高亮背景 |
| `--brand-soft-strong` | `#e5eaff` | 更强品牌浅底（非卡片强调） |
| `--brand-text` | `#1a1759` | 品牌浅底之上的文字 |
| `--brand-on` | `#ffffff` | 实心品牌底之上的文字 |
| `--surface` / `--paper` / `--card` | `#f7f7f8` | 卡片、图表面板、标签表面 |
| `--surface-muted` / `--paper-soft` | `#efeff2` | 嵌套/次级表面 |
| `--text` / `--ink` / `--foreground` | `#171717` | 主文本 |
| `--text-muted` / `--ink-muted` / `--muted-foreground` | `#52525b` | 次级文本、坐标轴、图例 |
| `--border` / `--line` | `rgba(23, 23, 23, 0.12)` | 分割线与卡片描边 |
| `--canvas-bg` / `--background` | `#f7f7f8` | 全局/画布背景 |

### 3.2 图表系列（Chart，紫色 family 阶梯）

| Token | 值 | 用途 |
|------|------|------|
| `--chart-series-1` | `#3c2eca` | 第一个数据源（最重阶梯） |
| `--chart-series-2` | `#a9aeff` | 第二个数据源（高对比浅阶梯） |
| `--chart-series-3` | `#6f6fff` | 第三个数据源（中间阶梯） |
| `--chart-series-4` | `#22a5f7` | 第四个数据源（品牌邻近色相） |
| `--chart-other` | `#d3d4da` | 聚合剩余项（其他、长尾） |

> 规则：≤4 系列 + 1 聚合色；5 个及以上改为「Top N + 其他」归并，不增加颜色。

### 3.3 语义色（跨主题固定）

| Token | 值 | 用途 |
|------|------|------|
| `--success` | `#1dc981` | 正向结果、完成、已通过 |
| `--warning` / `--warn` | `#efaa17` | 注意、权衡、待处理 |
| `--danger` | `#e8463a` | 失败、阻断、高风险 |
| `--info` | `#22a5f7` | 信息提示（≈ series-4 蓝） |
| `--purple` | `#6f6fff` | 特殊标记（品牌 family） |
| `--teal` | `#27d2bf` | 次级强调（dynamic-ui accent） |

各语义色配 `-soft` 弱化变体（约 10% 透明度），用于背景高亮。

### 3.4 暗色档（小程序 `html[data-bob-dark="true"]`）

| Token | 值 | 对应亮色 |
|------|------|------|
| `--brand` | `#6054f1` | `#4b3fe3` |
| `--surface` | `#171717` | `#f7f7f8` |
| `--surface-muted` | `#262626` | `#efeff2` |
| `--text` | `#e5e5e5` | `#171717` |
| `--text-muted` | `#a1a1aa` | `#52525b` |
| `--border` | `rgba(229, 229, 229, 0.12)` | `rgba(23, 23, 23, 0.12)` |

图表系列与语义色跨主题不变；`--chart-series-1` 暗色档为 `#4b3fe3`。

---

## 四、Sandbox 小程序主题适配

### 4.1 CSS 变量自动注入

小程序预览 iframe 加载时，服务端（`/api/sandbox/preview/<id>`）自动将当前主题的完整 CSS 变量（`PRESET_THEME_VARIABLES.warm`）注入 iframe 的 `:root`，小程序无需任何额外代码即可使用 `var(--brand)` 等。

**工作流程**：
1. 主题变更 → 派发 `theme-changed` 事件
2. CanvasFlow 监听到事件 → 递增 `sandboxRefreshTick` → iframe 重新加载（或 postMessage 实时推送变量）
3. 服务端读取当前主题变量 → 生成 `<style data-bob-theme>` 注入 iframe `<head>`
4. 小程序中 `var(--brand)` 等自动使用统一 Purple 色值

### 4.2 小程序编码规范

| 场景 | 方式 |
|------|------|
| CSS / 内联样式 | 直接用 `var(--brand)`、`var(--surface)`、`var(--text)` 等统一 Token（兼容 `var(--primary)`/`var(--paper)`/`var(--ink)` 旧别名） |
| Canvas / SVG / Chart | 调用 `BobWork.request('getTheme')` 获取 `keyColors`/`variables` 对象，JS 读取色值 |
| 深色档检测 | CSS: `html[data-bob-dark="true"]`；JS: `document.documentElement.dataset.bobDark` |

### 4.3 getTheme Bridge Action

```js
const theme = await BobWork.request('getTheme');
// 返回: { themeId, themeName, dark, keyColors: { primary, background, surface, text, border, muted }, variables }
// themeName = 'Purple'（统一主题）
```

### 4.4 变量映射速查

| 小程序场景 | CSS 变量 |
|------------|----------|
| 主色（按钮、链接、选中态） | `var(--brand)` / `var(--primary)` |
| 主色 hover | `var(--brand-strong)` / `var(--primary-strong)` |
| 选中底色 / 高亮背景 | `var(--brand-soft)` / `var(--primary-soft)` |
| 全局/画布背景 | `var(--background)` / `var(--canvas-bg)` |
| 卡片底色 | `var(--surface)` / `var(--paper)` |
| 正文文字 | `var(--text)` / `var(--ink)` / `var(--foreground)` |
| 辅助文字 | `var(--text-muted)` / `var(--ink-muted)` |
| 边框 | `var(--border)` / `var(--line)` |
| 危险/错误 | `var(--danger)` |
| 成功 | `var(--success)` |
| 警告 | `var(--warn)` / `var(--warning)` |
| 信息 | `var(--info)` |
| 图表系列 | `var(--chart-series-1..4)` / `var(--chart-other)` |

---

## 五、AI 工具接口

### 5.1 `get_app_config`（配置摘要）

返回当前配置摘要，其中主题字段恒为 `warm`（`customThemes` 为空数组——自定义主题已移除）：

```json
{
  "theme": {
    "current": "warm",
    "customThemeId": null,
    "customThemes": []
  }
}
```

### 5.2 `get_current_theme`（完整设计规范）

返回当前生效主题的完整 CSS 变量集 + 设计指南摘要。**所有色值动态读取 `PRESET_THEME_VARIABLES.warm`**，无需硬编码：

```json
{
  "themeId": "warm",
  "themeName": "Purple",
  "dark": false,
  "source": "preset",
  "keyColors": {
    "primary": "#4b3fe3",
    "background": "#f7f7f8",
    "surface": "#f7f7f8",
    "text": "#171717",
    "border": "rgba(23, 23, 23, 0.12)",
    "muted": "#52525b"
  },
  "variablesCount": 61,
  "variables": { "--brand": "#4b3fe3", "--surface": "#f7f7f8", "...": "..." },
  "designGuide": {
    "主色(--primary)": "#4b3fe3 — 按钮、标签、链接、选中态",
    "背景(--background/--canvas-bg)": "#f7f7f8 — 全局/画布背景",
    "卡片/纸张(--paper/--card)": "#f7f7f8 — 节点卡片、弹窗、侧边栏",
    "主文字(--foreground/--ink)": "#171717 — 正文文字",
    "弱化文字(--muted-foreground/--ink-muted)": "#52525b — 辅助、说明文字",
    "边框(--border/--line)": "rgba(23, 23, 23, 0.12) — 分割线、卡片边框",
    "信息蓝(--info)": "#22a5f7 — 信息提示",
    "成功绿(--success)": "#1dc981 — 成功状态",
    "警示橙(--warn)": "#efaa17 — 警告提示",
    "危险红(--danger)": "#e8463a — 错误、删除"
  }
}
```

> 不再提供 `design_theme` 工具（AI 换肤已随单品牌策略移除）。

---

## 六、设计规范速查

### 6.1 关键变量 → 使用场景

| 需要做什么 | 用哪个变量 |
|------------|-----------|
| 按钮背景 | `--brand` / `--primary` |
| 按钮 hover | `--brand-strong` / `--primary-strong` |
| 选中行/标签背景 | `--brand-soft` / `--primary-soft` |
| 卡片底色 | `--surface` / `--paper` |
| 侧边栏底色 | `--surface-muted` / `--paper-soft` |
| 全局画布背景 | `--canvas-bg` |
| 正文文字 | `--text` / `--ink` / `--foreground` |
| 标题文字 | `--ink-strong` |
| 辅助/说明文字 | `--text-muted` / `--ink-muted` |
| 占位符文字 | `--ink-faint` |
| 卡片边框 | `--border` / `--line` |
| 内部分割线 | `--line-soft` |
| 图表数据系列 | `--chart-series-1..4`（聚合用 `--chart-other`） |
| 成功提示 | `--success` + `--success-soft` 背景 |
| 警告提示 | `--warn` + `--warn-soft` 背景 |
| 错误/删除 | `--danger` + `--danger-soft` 背景 |
| 信息提示 | `--info` + `--info-soft` 背景 |
| AI 专属标记 | `--purple` + `--purple-soft` 背景 |
| 输入框背景/边框 | `--input-bg` / `--input-border` |

### 6.2 设计原则（对齐 dynamic-ui）

- **无缝融入宿主**：不制造独立视觉外壳，与宿主页面融为一体
- **扁平克制**：不使用渐变、噪点、投影堆叠；大面积表面保持中性，颜色只出现在数据标记、焦点边框、标签等小面积元素上
- **颜色即含义**：每个有彩色都必须能被命名；普通流程默认"中性表面 + 中性连线 + 一个品牌色焦点"
- **卡片中性**：卡片类表面保持中性，禁止用品牌色/语义色作卡片底色；品牌浅底只用于非卡片节点、徽标与图表填充
- **焦点表达**：位置 > 标签 > 单一强调色，不单靠颜色
- **语义色克制**：`--success/--warning/--danger` 仅在真实状态/风险语义下使用

### 6.3 颜色格式说明

- `#hex`：标准十六进制色值（当前主题统一使用 hex / rgba）
- `rgba(r, g, b, a)`：RGBA 色值（边框等半透明层）
- 主题变量随 `PRESET_THEME_VARIABLES` 与 `globals.css` 同步维护，两者必须保持一致
