# 各类型完整示例：HTML 组件 · Mermaid 着色 · ECharts/antv 数据图（L3 按需资源）

> 写具体 widget 需要完整 CSS 定义、着色层次表、示例代码或 antv 工具清单时加载。
> 由原 04a-html-components + 04b-mermaid-coloring + 04c-data-charts 合并（按 widget 类型聚合，一次读取即可对照）。
> 写 widget 时同时受审美原则约束（见 06-aesthetic-design.md）：标题有版面感、留白充足、主色只做 1-2 处强调。

---

## 1. HTML 组件类 + 完整示例（widget:html 专用 · Apple 风格）

> L2 矩阵要求「复用 .w-* 类 / 主题变量写 widget 块内第一行」；此处是完整 CSS 定义与标准示例代码。

### 1.1 .w-* 预置组件类（渲染器已注入，直接引用）

HTML widget 里直接用下面的 class；渲染器已注入以下 CSS，模型不得手写完全等价的 style。

```css
/* —— 容器/卡片（Apple 风格：白卡浮在分组灰上，极淡边框+阴影形成层次） —— */
.w-card {
  background: var(--widget-card);   /* 白（浅色）/ 提亮一档（深色）——渲染器已注入 */
  border: 1px solid var(--widget-border);
  border-radius: var(--widget-radius-lg);          /* 14px */
  padding: var(--widget-space-md) var(--widget-space-lg); /* 12 16 */
  box-shadow: var(--widget-shadow-sm);
}

/* —— 标题（700 字重 + 负 letter-spacing，Apple 标志性特征） —— */
.w-title {
  font: 700 15px/1.4 var(--widget-font-display);
  letter-spacing: -0.01em;
  color: var(--widget-text);
  margin: 0 0 var(--widget-space-sm);               /* 下留 8px */
}

/* —— 标签徽标（语义色跟随变量，不再硬编码） —— */
.w-tag {
  display: inline-block;
  font: 400 12px/1 var(--widget-font-body);
  padding: 3px 8px;
  border-radius: 999px;                               /* pill */
  background: var(--widget-bg-alt);
  color: var(--widget-muted);
}
/* 语义变体：加 class="w-tag w-tag--success" 等 */
.w-tag--success { background: color-mix(in srgb, var(--widget-success) 12%, transparent);
                  color: var(--widget-success); }
.w-tag--warning { background: color-mix(in srgb, var(--widget-warning) 12%, transparent);
                  color: var(--widget-warning); }
.w-tag--danger  { background: color-mix(in srgb, var(--widget-danger) 12%, transparent);
                  color: var(--widget-danger);  }
.w-tag--accent  { background: color-mix(in srgb, var(--widget-accent) 12%, transparent);
                  color: var(--widget-accent); }

/* —— 按钮（Apple 按压反馈 active:scale） —— */
.w-btn {
  font: 500 14px var(--widget-font-body);
  padding: 6px 14px;
  border-radius: var(--widget-radius-sm);            /* 8px */
  border: none;
  background: var(--widget-bg-alt);
  color: var(--widget-text);
  cursor: pointer;
  transition: filter .15s ease, transform .1s ease;
}
.w-btn:hover { filter: brightness(0.95); }
.w-btn:active { transform: scale(0.96); }
.w-btn--primary {
  background: var(--widget-accent);
  color: #fff;
}
.w-btn--primary:hover { filter: brightness(1.05); }

/* —— KPI（tabular-nums 等宽数字 + 700 字重 + 负 tracking） —— */
.w-kpi { text-align: center; }
.w-kpi .value {
  font: 700 20px var(--widget-font-display);
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  color: var(--widget-accent);
}
.w-kpi .label { font: 400 12px var(--widget-font-body); color: var(--widget-muted); }
/* 对齐变体：<div class="w-kpi w-kpi--left"> */
.w-kpi--left  { text-align: left; }
.w-kpi--right { text-align: right; }
```

### 1.2 HTML widget 完整示例（数据型信息图 · Apple 风格标准写法）

````markdown
```widget:html
<style>
  /* 顶部 <style> 仅在 widget:html 内生效；正文里 <style> 会被安全过滤移除 */
  :root {
    /* 统一 Purple 主题（示例）— 对齐 BobWork 统一品牌色，主色固定 Purple，不设行业色板 */
    --accent: #4b3fe3;
    --bg-secondary: #f7f7f8;
    --text-primary: #171717;
    --text-secondary: #52525b;
    --success: #1dc981;
    --warning: #efaa17;
  }
</style>
<div class="w-card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:12px;">
  <div class="w-kpi"><div class="label">总营收</div><div class="value">¥128万</div></div>
  <div class="w-kpi"><div class="label">同比</div><div class="value" style="color:var(--success);">+18%</div></div>
  <div class="w-kpi"><div class="label">客单价</div><div class="value" style="color:var(--warning);">¥320</div></div>
</div>
```

```widget:chart
{"option":{
  "color":["#4b3fe3","#6f6fff","#a9aeff"],
  "tooltip":{},
  "legend":{},
  "xAxis":{"type":"category","data":["Q1","Q2","Q3","Q4"]},
  "yAxis":{"type":"value"},
  "series":[
    {"type":"bar","name":"营收(万)","data":[22,30,34,42]},
    {"type":"bar","name":"成本(万)","data":[18,24,26,30]}
  ]
}}
```
````

要点：
1. 品牌 Purple 主题变量写在 **widget:html 顶部 `<style>`**（正文里 `<style>` 会被过滤，只有 widget 沙箱里允许）
2. KPI 行用 `.w-kpi`、容器用 `.w-card`、对比色直接写 inline `style="color:…"`
3. 数据图用独立的 `widget:chart` 块，**显式写 `option.color`**（dynamic-ui Purple 图表系列优先），不依赖渲染器兜底
4. `.w-card` 默认白卡（浅色 `#FFFFFF` / 深色提亮档）+ 极淡边框阴影——**【渲染器已注入，直接引用**，不要写死背景色】；层次靠"卡片白、页面分组灰"形成（Apple 风格核心）
5. 数字用 `tabular-nums`（`.w-kpi .value` 已内置），确保等宽对齐

---

## 2. Mermaid 节点焦点着色规范（widget:mermaid 专用）

> L2 矩阵要求「焦点节点唯一着色（形状优先）」；此处是完整着色层次表 + 品牌 Purple 示例。

### 2.1 着色层次（3 档，默认 + 焦点 + 语义终态）

| 层次 | 形状约定 | 浅色模式填充 | 描边 | 深色模式（自动映射） |
|---|---|---|---|---|
| 默认节点（90% 节点） | 圆角矩形 | `#F7F7F8` / `var(--widget-bg)` | `rgba(23,23,23,.12)` | `#171717` / `rgba(229,229,229,.18)` |
| **唯一焦点节点**（强调） | 跑道形 = 起点；菱形 = 决策；其他焦点用任意形状 + class | **品牌 Purple 浅底 `#F2F7FF`**（brand-soft） | **品牌 Purple `#4b3fe3`** | **Purple 深色档 `#6054f1`** |
| 语义终态（仅成功/失败语义时） | 圆角矩形 | 成功 `#D1FADF` / 失败 `#FEE2E2` | 成功 `#16A34A` / 失败 `#DC2626` | 成功降饱和提亮 `#5EC28E` / 失败 `#E27272` |
| 关键路径连线 | 实线箭头 | —— | 品牌 Purple `#4b3fe3` + 线宽 2px | Purple 深色档 `#6054f1` + 线宽 2px |

> 不设行业色板：mermaid 焦点节点与连线一律用品牌 Purple，不引入其它色相。

### 2.2 示例（品牌 Purple · 焦点节点）

````markdown
```widget:mermaid
flowchart TD
    S([开始]):::focus --> A{判断条件}:::decision
    A -->|是| B[执行步骤]
    A -->|否| Z([异常结束]):::fail
    B --> C([完成]):::success

    classDef focus fill:#F2F7FF,stroke:#4b3fe3,stroke-width:2px;
    classDef decision fill:#F2F7FF,stroke:#4b3fe3,stroke-dasharray:5 3;
    classDef success fill:#D1FADF,stroke:#16A34A,color:#0A3622;
    classDef fail fill:#FEE2E2,stroke:#DC2626,color:#450A0A;
```
````

**密度预算仍有效**：不允许起止、决策、分支全上 accent 色。焦点节点 ≤ 1（通常是起点或关键决策），成功/失败终态只有语义明确时才上色。

---

## 3. ECharts 默认注入 + antv 工具清单（widget:chart / widget:antv 专用）

> L2 矩阵要求「chart 必写 option.color、antv 用 generate_*_chart」；此处是 ECharts 默认注入样式明细和 antv 云端图表生成器完整清单。

### 3.1 ECharts / widget:chart 默认注入样式

渲染器在渲染 `widget:chart` 时会强制注入以下默认样式（可用你写的 option 覆盖）：

| 项 | 默认注入值 | 覆盖建议 |
|---|---|---|
| `grid.left / right / top / bottom` | 自适应留白；top 预留 legend 空间 | 一般不用改 |
| `splitLine.lineStyle.color` | 浅 `rgba(23,23,23,.06)` / 深 `rgba(229,229,229,.06)` | 可整体 `splitLine:{show:false}` 或换成虚线 |
| `xAxis.axisLabel / yAxis.axisLabel` | 12px，`--widget-muted` 色 | 需要强调时改 color，但不能小于 11px |
| `legend` | 顶部、圆角矩形 icon、12px muted 文字 | 放在顶部或右，不放下部 |
| `tooltip` | 背景 `--widget-bg-alt`、边框 `--widget-border`、圆角 8px、12px、无投影 | 一般不用改；格式器用字符串模板 `"{b}: {d}%"` |
| `series.bar.maxBarWidth` | ≤ 40px | 细柱观感更现代 |
| `series.line.lineWidth / symbol` | 2px / symbol size 6 | 强调系列可 3px |
| `animationDuration` | 300ms | — |
| **`color`（系列色）** | **chartPalette dynamic-ui Purple 兜底：`['#4b3fe3','#6f6fff','#a9aeff','#22a5f7','#27d2bf','#3c2eca','#d3d4da']`** | **必须在 option.color 里显式写 Purple family 系列色，不要依赖兜底组**（统一品牌 Purple，不设行业色板） |

强制要求：
- **`option.color` 必须显式给出**（即使你打算用默认的那组，也要手写出来，表示你是有意识选色不是忘了选）
- **焦点系列**（需要强调的那个系列）：仅 series-1 用 accent 色，其余用中性灰/蓝/辅助色，**不得单点上色给非焦点系列**
- 数据 ≤ 8 系列/节点；> 8 → 归并「Top N + 其他」

### 3.2 widget:antv 可用工具清单（云端图表生成器）

`tool` 取值（均为 `generate_*_chart` / 图类型，云端生成、审美优先；名称不在此列会失败并自动回退 `widget:chart`，不用手动双写）：

```text
generate_line_chart / generate_bar_chart / generate_column_chart / generate_pie_chart / generate_scatter_chart / generate_radar_chart / generate_sankey_chart / generate_funnel_chart / generate_area_chart / generate_histogram_chart / generate_boxplot_chart / generate_violin_chart / generate_treemap_chart / generate_venn_chart / generate_word_cloud_chart / generate_liquid_chart / generate_mind_map / generate_organization_chart / generate_network_graph / generate_flow_diagram / generate_fishbone_diagram / generate_dual_axes_chart
```

`args` 必含 `data`（每条含分类/时间 + value，多系列加 `group`）；可选 `title / theme / width / height / axisXTitle / axisYTitle`。顶层结构为合法 JSON `{ "tool": "...", "args": {...} }`。
