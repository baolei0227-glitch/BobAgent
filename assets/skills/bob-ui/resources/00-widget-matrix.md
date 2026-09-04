# 各类型最小规则 · 完整矩阵（L3 按需资源）

> L2 常驻只保留「每类型一条核心硬规则」；此处是完整结构 / 格式 / 配色 / 数据 / 尺寸规则，写对应 widget 需要逐条对照时参考。

## widget:mermaid

- **结构 / 格式**：flowchart / sequence / class / state / gantt / pie / mindmap / gitGraph；节点与参与者用中文
- **配色（显式必写）**：焦点节点唯一着色（形状优先：起点=跑道形、决策=菱形，再 accent 浅填充+描边）；成功/失败终态仅语义明确才用绿/红
- 细节见 `03-widget-examples.md`

## widget:antv

- **结构 / 格式**：合法 JSON `{tool,args}`，tool 取 `generate_*_chart`（22 种清单见 `03-widget-examples.md`）
- **配色**：云端自动（审美优先）
- **数据 / 节点**：`args` 必含 `data`（分类/时间+value，多系列加 group）；可选 title/theme/width/height/轴标题
- **失败处理**：自动回退 `widget:chart`，不双写
- 细节见 `03-widget-examples.md`

## widget:chart

- **结构 / 格式**：顶层只放 `option`（合法 JSON，无注释/尾逗号；formatter 用 `"{b}: {d}%"`）
- **配色（显式必写）**：必写 `option.color` 品牌 Purple 系列
- **数据 / 节点**：系列/节点 ≤8（超→Top N+其他）；必填 `tooltip`，多系列加 `legend:{}`，类目轴 `type:"category"`
- 细节见 `03-widget-examples.md`

## widget:svg

- **结构 / 格式**：`viewBox` 精确裁剪；无 `<script>`/`<foreignObject>`
- **配色**：默认中性；唯一焦点才用主色（浅=主色 10% 填充+主色描边；深=主色深色变体）
- **数据 / 节点**：信息图海报：标题/数字/分区可放大、允许几何图标与数据条（见 `05-infographic-poster.md`）
- **尺寸 / 组件**：宽度 ≤680px；四周留边 ≥20px。**例外**：信息图**落盘长图模式**（用户要文件/长图/转发）不受 680 限制，自由定尺寸（如 1200×2097），按 `05-infographic-poster.md` §落盘长图模式渲染为 PNG/SVG 文件落盘，不输出 widget。
- 细节见 `04-quality-checklist.md`、`05-infographic-poster.md`

## widget:html

- **结构 / 格式**：只输出内容片段（无 `<html>/<body>/<head>`）；正文 `<style>` 会被移除→主题变量写在块内第一行 `<style>`（必写）
- **配色（显式必写）**：首行 `<style>` 必写 `--accent`（品牌 Purple）+ `--bg-secondary` 等变量；主题/系列色按步骤 1 显式写
- **尺寸 / 组件**：必复用 `.w-*` 类（.w-card/.w-title/.w-tag/.w-btn/.w-kpi），勿手写等价 inline style；默认「白卡灰底」
- 细节见 `03-widget-examples.md`
