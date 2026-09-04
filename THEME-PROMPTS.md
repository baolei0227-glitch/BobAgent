# 主题设计提示词模板

> 本文档收录与主题系统相关的 AI 提示词模板，供开发者和 AI 共同参考。
> 对应的完整设计规范见 [THEME-GUIDE.md](./THEME-GUIDE.md)。

---

## 一、系统提示词注入（已内置）

以下提示词已内置于 `src/app/api/chat/route.ts` 的 `BASE_SYSTEM_PROMPT` 和 sandbox 编码注入中，无需手动添加。

### 1.1 界面主题感知指令

注入位置：`BASE_SYSTEM_PROMPT` → 工具使用说明之后

```
界面主题感知（重要）：
- 当用户询问当前主题/配色、或你需要生成与当前界面配色一致的前端代码/小程序时，必须先调用 get_current_theme 工具获取当前生效的完整 CSS 变量集（含主色、背景、纸张、文字、边框、状态色等 44 个变量值 + 设计指南），再基于返回的真实色值编写代码
- 不要凭记忆猜测当前主题色值——用户可能已通过 AI 对话切换为自定义主题，实际色值可能与预设不同
- 完整主题设计规范文档位于项目根目录 THEME-GUIDE.md，需要了解变量体系架构、派生规则、预设主题详情时可 read_file 读取
```

### 1.2 小程序 UI 默认规范

注入位置：sandbox 编码上下文（当节点类型为 coding 时）

```
=== 小程序 UI 默认规范（无需用户要求即可主动应用） ===
以下规范保证小程序在 BobAgent 预览中风格一致且专业，按优先级执行：
1. 布局：外层卡片式容器，圆角 12px、柔和阴影 box-shadow: 0 4px 20px rgba(0,0,0,0.08)、内容区 padding 20-28px；viewport 移动端优先，容器 max-width 440px 水平居中；分组模块分区，标题字重 600 + 下边框 1px
2. 配色（CSS 变量自适应）：小程序预览环境已自动注入当前主题的 44 个 CSS 变量到 :root，直接使用 var(--primary)、var(--background)、var(--paper)、var(--ink)、var(--ink-muted)、var(--border)、var(--danger)、var(--success) 等即可自动适配所有主题（含自定义主题），无需写死色值。映射关系：主色 var(--primary) / 背景 var(--background) / 卡片 var(--paper) / 正文 var(--ink) 或 var(--foreground) / 辅助文字 var(--ink-muted) 或 var(--muted-foreground) / 边框 var(--border) 或 var(--line) / 危险 var(--danger) / 成功 var(--success) / 警告 var(--warn) / 信息 var(--info)
   - Canvas/SVG/Chart 等无法用 CSS 变量的场景：调用 BobAgent.request('getTheme') 获取 keyColors 对象，用 JS 读取色值后传给图表库
   - 深色判断：html[data-bob-dark="true"] 选择器可检测当前是否深色主题
3. 字体：正文 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Serif SC", serif；数字、金额、百分比一律 font-variant-numeric: tabular-nums；标题/正文/辅助三级字号（20px / 14px / 12px）
4. 交互：
   - 计算器类：实时计算（input 事件触发，不阻塞）
   - 按钮三态：hover 亮度 +10%、active 缩放 0.98、focus 2px var(--primary) 半透明环
   - 输入错误：边框改为 var(--danger) + 行内小字提示，禁止使用 alert() 弹窗
   - 空态：结果区域无数据时给灰色引导文案，不要显示 NaN、undefined、0
5. 重点突出：金额/结果数字 28-40px + 字重 700 + var(--primary)；对应标签弱化（12px / opacity 0.65）
如果用户明确要求其他配色/风格，以用户需求为准覆盖以上默认规范。
```

---

## 二、用户对话提示词模板

以下模板供用户在对话中直接使用，引导 AI 执行主题相关任务。

### 2.1 查询当前主题

```
当前系统用的是什么主题？主色和背景色是什么？
```

**AI 行为**：调用 `get_current_theme` 工具，返回主题名称、关键色值、完整 CSS 变量集。

### 2.2 创建自定义主题

```
帮我创建一个深色主题，名叫"深海金"，主色用金色 #ffd700，背景用深海蓝 #0a1929
```

```
做一个护眼的浅色主题，主色用鼠尾草绿，整体偏暖灰
```

```
创建一个赛博朋克风格的深色主题，主色用霓虹粉
```

**AI 行为**：调用 `design_theme` 工具，提供关键色 → 自动派生 44 个 CSS 变量 → 写入 `.settings.json` → 立即生效。

### 2.3 切换主题

```
切换到石墨钢蓝主题
```

```
切回默认的暖橙主题
```

```
切换到我之前创建的"深海金"主题
```

**AI 行为**：调用 `set_app_config` 修改 `theme` 字段（预设主题）或 `customThemeId`（自定义主题）。

### 2.4 列出所有可用主题

```
现在有哪些主题可以用？
```

**AI 行为**：调用 `get_app_config`，返回 `customThemes` 列表 + 当前选中项。

### 2.5 修改已有自定义主题

```
把"深海金"的主色改得更亮一些
```

```
在"晨雾"主题基础上，把背景色调得更冷一点
```

**AI 行为**：读取当前自定义主题变量 → 修改指定色值 → 重新派生关联变量 → 保存。

---

## 三、小程序编码提示词模板

### 3.1 基础模板（自动适配主题）

```
做一个房贷计算器小程序
```

**AI 行为**：自动使用 `var(--primary)` 等 CSS 变量编写代码，无需用户指定配色。

### 3.2 指定配色覆盖

```
做一个汇率转换器，配色用紫色系，不要跟系统主题走
```

**AI 行为**：用户明确要求其他配色，覆盖默认 CSS 变量规范，使用用户指定的紫色系。

### 3.3 深色模式适配

```
做一个天气展示卡片，需要同时适配深色和浅色主题
```

**AI 行为**：
- CSS 中使用 `var(--xxx)` 自动适配
- 额外用 `html[data-bob-dark="true"]` 选择器处理需要差异化的场景
- Canvas/Chart 中调用 `BobAgent.request('getTheme')` 获取 `dark` 字段做分支

### 3.4 图表类小程序

```
做一个收支统计图表，用饼图展示各类支出占比
```

**AI 行为**：
- CSS 部分用 `var(--xxx)` 适配主题
- Chart.js / Canvas 部分调用 `BobAgent.request('getTheme')` 获取 `keyColors`
- 用 `keyColors.primary`、`keyColors.text`、`keyColors.border` 等设置图表配色

```js
// AI 生成的代码示例
const theme = await BobAgent.request('getTheme');
const colors = theme.keyColors;

new Chart(ctx, {
  type: 'pie',
  data: {
    labels: ['餐饮', '交通', '住房'],
    datasets: [{
      data: [3000, 800, 5000],
      backgroundColor: [colors.primary, colors.text, colors.border],
      borderColor: colors.background,
    }]
  },
  options: {
    plugins: {
      legend: { labels: { color: colors.text } }
    }
  }
});
```

---

## 四、主题开发提示词模板

### 4.1 创建完整自定义主题

```
创建一个"森林晨曦"主题，要求：
- 浅色主题
- 主色用深森林绿 #2d5a3d
- 背景用晨曦米白 #f5f3ee
- 卡片底色用柔和的奶白
- 整体感觉自然、沉稳、护眼
```

**AI 行为**：调用 `design_theme`，传入 `name`、`dark: false`、`colors: { primary, background, surface }`，其余 40+ 变量自动派生。

### 4.2 基于预设主题微调

```
在墨韵朱砂主题的基础上，把主色调得更鲜艳一些，接近正红
```

**AI 行为**：读取 `ink` 预设主题变量 → 修改 `--primary` → 重新派生 `--primary-soft`、`--primary-strong` → 创建为自定义主题。

### 4.3 创建深色主题

```
创建一个"暗夜矿洞"深色主题：
- 主色用矿物蓝 #4a9eff
- 背景用极深的岩石黑 #0d1117
- 卡片用稍浅的深灰 #161b22
- 文字用冷白
```

**AI 行为**：调用 `design_theme`，传入 `dark: true` + 关键色，派生时使用深色主题的回退默认值。

---

## 五、AI 工具调用链路

### 5.1 查询 → 编码链路

```
用户："做一个跟当前界面配色一致的计算器"
  ↓
AI 调用 get_current_theme → 获取 themeId、keyColors、variables
  ↓
AI 生成 HTML/CSS（使用 var(--primary) 等 CSS 变量）
  ↓
sandbox iframe 加载时自动注入当前主题变量
  ↓
小程序自动适配当前主题
```

### 5.2 创建主题 → 切换 → 编码链路

```
用户："创建一个紫色系深色主题，然后用这个配色做一个时钟小程序"
  ↓
AI 调用 design_theme → 创建自定义主题 → 立即生效
  ↓
theme-changed 事件派发 → sandbox iframe 准备刷新
  ↓
AI 生成 HTML/CSS（使用 var(--primary) 等 CSS 变量）
  ↓
sandbox iframe 加载 → 注入新主题变量
  ↓
小程序自动适配新创建的紫色深色主题
```

---

## 六、变量映射速查卡

供 AI 编码时快速查找变量与场景的对应关系。

| 场景 | CSS 变量 | 说明 |
|------|----------|------|
| 按钮背景 | `var(--primary)` | 主色 |
| 按钮 hover | `var(--primary-strong)` | 主色加深 |
| 选中/高亮背景 | `var(--primary-soft)` | 主色 10% 透明 |
| 全局背景 | `var(--background)` | body 底色 |
| 画布背景 | `var(--canvas-bg)` | 画布区域底色 |
| 卡片底色 | `var(--paper)` | 节点卡片 |
| 侧边栏底色 | `var(--paper-soft)` | 二级面板 |
| 正文文字 | `var(--ink)` / `var(--foreground)` | 标准文字 |
| 标题文字 | `var(--ink-strong)` | 加深文字 |
| 辅助文字 | `var(--ink-muted)` / `var(--muted-foreground)` | 说明、时间戳 |
| 占位符 | `var(--ink-faint)` | 极弱文字 |
| 边框 | `var(--border)` / `var(--line)` | 卡片边框 |
| 内部分割线 | `var(--line-soft)` | 浅色分隔 |
| 成功 | `var(--success)` | 绿色 |
| 警告 | `var(--warn)` | 橙色 |
| 危险/错误 | `var(--danger)` | 红色 |
| 信息 | `var(--info)` | 蓝色 |
| AI 标记 | `var(--purple)` | 紫色 |
| 输入框背景 | `var(--input-bg)` | — |
| 输入框边框 | `var(--input-border)` | — |
| 焦点环 | `var(--ring)` | 键盘导航高亮 |
| 次要按钮 | `var(--secondary)` | 次要操作 |
| 弱化背景 | `var(--muted)` | 禁用态 |

### Canvas/Chart 取色

```js
const theme = await BobAgent.request('getTheme');
const { primary, background, surface, text, border, muted } = theme.keyColors;
// primary  → 主色（按钮、强调）
// background → 背景色
// surface  → 卡片色
// text     → 文字色
// border   → 边框色
// muted    → 辅助文字色
```

### 深色主题检测

```css
/* CSS */
html[data-bob-dark="true"] .my-chart-bg {
  background: var(--paper);
}
```

```js
// JS
const isDark = document.documentElement.dataset.bobDark === 'true';
```
