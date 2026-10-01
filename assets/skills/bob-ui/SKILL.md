---
name: bob-ui
description: 在对话回答中嵌入可视化内容（widget 语法），是制图方案唯一入口。五种类型：widget:svg（流程图/示意图）、widget:html（交互组件/富卡片）、widget:mermaid（标准图表）、widget:antv（AntV 云端数据图表）、widget:chart（ECharts 本地兜底）。当回答需要图表、流程图、架构图、数据可视化、交互组件、对比卡片时使用。触发关键词：图表、流程图、架构图、可视化、柱状图、折线图、饼图、时序图、示意图、对比图、信息图、信息卡片、数据看板、长图、竖版海报、图片文件交付、infographic、chart、graph、diagram、dashboard、mockup、wireframe、UI设计、线框图、界面图、原型图、标注图、画图、draw chart。
version: 2.7.0
---

# bob-ui · 回答内嵌可视化（L2 规则层 · 必读）

回答需要可视化时，用 **widget 代码块** 嵌入正文（可与 Markdown 混排）。五类按需选择，可多张相邻。

> **先写后查**：先用本文件规则直接产出；仅需精确色值 / 示例代码 / 完整清单时，按需 `read_skill_resource(skill_name="bob-ui", resource="<文件名>")` 读 L3 核对（索引见文末）——**不要一开始就读多个资源文件**（每个约 1-3K tokens，膨胀上下文）。L2 仅含规则与流程，精确数值 / 组件类 / 示例 / 自检清单全部在 L3 按需加载。

---

## 类型选择（第一步：内容 → widget 类型路由）

| 内容类型 | widget 类型 |
|---|---|
| 流程图 / 时序图 / 状态图 / 甘特图 / 思维导图 / 标准饼图 | `widget:mermaid`（标准 ```` ```mermaid ```` 也会被自动识别） |
| 柱状图 / 折线图 / 饼图 / 散点图 / 雷达图 / 桑基图 / 漏斗图 等数据图 | `widget:antv`（云端生成，审美优先）或 `widget:chart`（本地 ECharts 兜底） |
| 自定义示意图 / 架构图 / 工艺线 / 标注图 | `widget:svg` |
| 方案对比卡 / KPI 卡片 / 数据看板 / 一图看懂 / 富交互组件 | `widget:html` |

判断口诀：「有流程→mermaid，有数据→antv/chart，有构图→svg，有卡片→html」。

---

## 各类型最小规则（核心硬规则 · 完整矩阵见 L3 `00-widget-matrix.md`）

| widget | 核心硬规则（必守，其余自由发挥） |
|---|---|
| `widget:mermaid` | 焦点节点唯一着色（形状优先：起点跑道形、决策菱形） |
| `widget:antv` | 合法 JSON `{tool,args}`；失败自动回退 `widget:chart` |
| `widget:chart` | 必写 `option.color` 品牌 Purple 系列 + `tooltip` |
| `widget:svg` | `viewBox` ≤680px、四周留边 ≥20px；无 `<script>`/`<foreignObject>` |
| `widget:html` | 块内首行 `<style>` 写 `--accent`（品牌 Purple）；复用 `.w-*` 类，勿手写等价 inline style |

---

## 统一视觉纪律（6 步强制，按序执行）

> **信息图海报豁免**：命中 L3 `05-infographic-poster.md`（widget:svg 海报叙事型信息图）时，第 2/3/4 步以 05 规范的放大档位与分区结构为准，其余纪律照常执行。

0. **主色统一品牌 Purple**：所有 widget 主色/强调色一律 `#4b3fe3`（深色 `#6054f1`），**不设行业色板、不做行业判色**；数据系列区分用 Purple family 深浅分层（`#4b3fe3 / #6f6fff / #a9aeff / #d3d4da`）；完整色板+字体配对见 L3 `01-style-rulers.md`
1. **显式写色（必写，漏写=不合格）**：chart→`option.color`；svg→fill/stroke 写 hex；html→块内第一行 `<style>` 至少写 `--accent`（品牌 Purple，见步骤 0）、`--bg-secondary`、`--text-primary`、`--text-secondary` 四变量
2. **主色面积 ≤15%**：主色只出现在标题/标签/线条/焦点节点，不铺大色块背景；大面积用品牌 Purple 浅底（brand-soft `#F2F7FF`）或中性白/灰
3. **取标尺**：字号七档 11/12/13/14/16/20/24、间距五档 4/8/12/16/24、圆角 4/6/8/12/16/999；禁标尺外随手写；完整数值表（含禁止值清单）见 L3 `01-style-rulers.md`
4. **密度预算**：焦点 ≤1；主节点/主系列 2-5（超→分组/Top N 归并/拆图）；含义色 ≤2（不含中性）；交互概念 ≤1；细则见 L3 `02-density-layout.md`
5. **布局用 5 模式**：KPI 行/卡片网格/图文混排/对比并排/流程步骤，对号入座；栅格必须用 `repeat(auto-fit, minmax(140px, 1fr))` 响应式；模板见 L3 `02-density-layout.md` §5
6. **输出前自检**：合规项（焦点唯一→无重叠出界→颜色合规→字号间距合规→数据带单位/来源→系列≤5→viewBox≤680→复用 .w-*→层级≤3→布局对齐一致）+ **美感**（第一眼有焦点→标题有版面感→数字是第一眼→去掉边框仍分层→有装饰细节→留白充足；原则见 L3 `06-aesthetic-design.md`）+ **数据图**（chart/antv/svg：选型对→轴含 0→网格浅灰→色板选型对→CVD 安全→直接标注→来源注明；清单见 L3 `07-dataviz-principles.md`）；完整清单见 L3 `04-quality-checklist.md`（含 §4 美感自检）

**最低成品线（硬性 · 不达标返工）**：
- 渲染器默认 token 只是"能显示保底"，不是合格线：只输出默认灰底、无品牌 Purple 主色强调 = 未完成，重画
- `widget:svg` 非单一灰色填充：线条/文字/焦点至少两层对比色 + 留白 ≥20px + 元素不贴边
- 页面不允许"整块底色无卡片无分区"的平面感；`widget:html` 不得只输出裸 `<div>`+黑字（须用 `.w-card` 组织层次）

> **创造力授权**：以上纪律与成品线是**底线**，不是模板。守住底线（品牌 Purple、焦点唯一、无重叠出界、成品线达标）的前提下，**大胆发挥版面、叙事、构图的创造力**——不逐条机械套用，细节为叙事服务。参考 L3 `06-aesthetic-design.md` §7 高级布局（杂志式 / 锚点式 / 数字带 / Z 型）与 §6 装饰工具箱。

**禁忌（高频 5 条 · 完整清单见 L3 `01-style-rulers.md` §6；用户明确要求才可用并注明"有意识选择"）**：❌ 写死宿主主色 `#4B3FE3`（须消费 `var(--brand)`）❌ 蓝紫渐变（禁渐变）❌ 奶油米白底+衬线+赤陶橙（AI 海报风）❌ 近黑底+酸性霓虹绿/朱红 ❌ 非 Apple 系统字体（Inter/Roboto/Arial）

**BobWork 统一 Token**：渲染器注入 `var(--widget-*)` 与 `.w-card/.w-kpi/.w-tag/.w-btn` 组件类，消费变量、不写死色值；完整 token 表见 L3 `01-style-rulers.md`

---

## 信息图场景路由

用户诉求含「信息图 / infographic / 一图看懂 / 可视化总结 / 数据海报」时，先判断**交付形式**：

- **文件交付型**（用户要「图片文件 / PNG / SVG / 可转发 / 竖版长图 / 手机转发 / 保存到项目」）→ 走 **bob-ui 长图落盘模式**（L3 `05-infographic-poster.md` §落盘长图模式）：手写 SVG → 渲染为 PNG 文件落盘 `homework/`，双格式交付（PNG + SVG）。**不受 widget:svg ≤680px 限制**，可自由定竖版长图尺寸（如 1200×2097）。
- **对话内嵌型**（无文件诉求，仅对话中展示）→ 走海报叙事型或数据指标型：
  - **海报叙事型**（主题叙事 + 关键数字 + 分区解读）→ `widget:svg` 信息图海报（4:3 或 1:1，宽 ≤680；不受字号/密度档位约束；规范与完整示例见 L3 `05-infographic-poster.md`）
  - **数据指标型**（纯 KPI + 图表，轻量）→ `widget:html` KPI/富卡片 + `widget:chart` 混排（示例见 L3 `03-widget-examples.md`）
  - **纯数据图表**（柱/折/饼等，无叙事）→ `widget:antv` 或 `widget:chart`（按类型矩阵）
- 口诀：要"**文件/长图/转发**"→ 落盘模式；要"对话里看图"→ svg 海报；要"指标/数据/对比数值"→ 数据型组件

---

## L3 按需资源索引（命中关键词才读；`read_skill_resource(skill_name="bob-ui", resource="<文件名>")`，大文件可用 `section` 参数只读某一段，如 `section="字号梯度"`）

| 资源文件 | 触发关键词 |
|---|---|
| `00-widget-matrix.md` | 各类型完整规则 / 结构格式 / 尺寸组件 |
| `01-style-rulers.md` | 精确色值 / 字体栈 / 字号间距圆角阴影档位 / 深色变体 |
| `02-density-layout.md` | 布局模式 / 栅格 / 密度预算 / 对齐 |
| `03-widget-examples.md` | widget:html .w-* 类 / widget:mermaid 着色 / widget:chart option.color / antv 工具清单 |
| `04-quality-checklist.md` | 自检 / QA pass / 踩坑对照 |
| `05-infographic-poster.md` | 信息图海报 / 一图看懂 / 完整示例 |
| `06-aesthetic-design.md` | 审美 / 视觉焦点 / 留白 / 排版张力 |
| `07-dataviz-principles.md` | 数据图 / 色板 / 色盲安全 / 坐标轴 |

---

## 适用边界

- **适合**：架构图、流程对比、卡片布局、数据图表、概念关系图、KPI 总览、方案对比、数据看板、一图看懂、信息图长图文件交付（落盘模式）
- **不适合**：纯文本回答（勿强塞 widget）、超复杂大型应用前端页面（改走编程节点）
- **落盘长图 ≠ widget**：文件交付型信息图走 L3 `05-infographic-poster.md` §落盘长图模式的工程渲染链路（SVG→PNG 落盘），不要输出 `widget:svg`（渲染器上限 680px 放不下长图，也无法落盘）
