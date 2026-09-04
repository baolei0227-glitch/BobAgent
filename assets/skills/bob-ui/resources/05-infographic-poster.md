# 信息图海报规范（L3 按需资源 · 内嵌 widget / 落盘长图 双模式 · 对标一线 AI 信息图质量）

> 适用：用户诉求是「信息图 / infographic / 一图看懂 / 可视化总结 / 数据海报」时。
> 先按 SKILL.md「信息图场景路由」判**交付形式**：
> - **文件交付型**（要文件 / PNG / SVG / 可转发 / 竖版长图 / 手机转发）→ 走本文 **§落盘长图模式**（SVG+PNG 落盘）
> - **对话内嵌型**（仅对话展示）→ 走本文 **§对话内嵌海报模式**（widget:svg ≤680px）
> 两种模式均不受 SKILL.md 的「字号七档 / 间距五档 / 密度预算」约束（信息图海报有自己更大的排版自由），
> 但仍遵守统一视觉纪律：**主色统一品牌 Purple**、主色克制、无重叠出界。

---

# §落盘长图模式（文件交付 · SVG + PNG 双格式）

## 适用场景

用户要「图片文件 / PNG / SVG / 可转发 / 竖版长图 / 手机直接转发 / 保存到项目 / 下载」。此时 **widget:svg 渲染器（上限 680px、不落盘）无法满足**，必须走工程渲染链路产出文件。

## 技术规格

- **尺寸**：自由定，推荐竖版 9:16 手机转发比例，如 **1200×2097**（可调；按内容量伸缩高度）
- **viewBox**：与最终尺寸一致（如 `0 0 1200 2097`），四周留边 ≥40（宽 1200 档）
- **配色**：与内嵌模式完全一致——品牌 Purple `#4b3fe3`（深色环境 `#6054f1`）、浅底 `#F2F7FF`、背景 `#F7F7F8`、白卡、中性灰 `#171717/#52525b/#a1a1aa/#E4E4E7`；主色面积 ≤20%；禁渐变/禁第三色相/禁纯黑底
- **字号档位**（宽 1200 等比放大档，按比例缩放即可）：
  | 元素 | 字号 |
  |---|---|
  | 主标题（display，可两行断开上黑下紫） | 52–64 |
  | 副标题 / 主题标签 | 20–26 |
  | 分区标题 | 28–34 |
  | 关键数字（tabular 对齐） | 44–64 |
  | 正文要点 | 17–21 |
  | 来源注记 / 弱文字 | 14–16 |
- **中文字体**：`font-family="system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"`；数字 `font-feature-settings="tnum"`
- **文字不自动换行**：长句用 `<tspan x="…" dy="1.6em">` 分行或拆多行 `<text>`（渲染器不会自动折行）
- 构图沿用四段式：标题区 → 关键数字带 → 主体分区（2–4 个浅色块）→ 注记行（来源/口径）

## 产物与落盘路径

- **两份产物**（双格式交付）：
  - `homework/<主题>-infographic.png`（位图，可直接转发）
  - `homework/<主题>-infographic.svg`（矢量，可二次编辑）
- 中间渲染文件放 `homework/.ai-workspace/`（如 `infographic-render.html`），**渲染完成后删除**
- 交互过程中的校验副本放 `homework/.ai-workspace/` 或按 read_attachment 惯例处理，最终只留 PNG + SVG 两份

## 渲染链路（5 步标准流程 · 照此执行，不要临时发明）

### 步骤 1：写 SVG 源文件
用 `write_file` 把完整 SVG（viewBox 与最终尺寸一致）写入 `homework/<主题>-infographic.svg`。

### 步骤 2：包 HTML 渲染壳
用 `write_file` 写 `homework/.ai-workspace/infographic-render.html`，把 SVG 内联进固定壳（body 零边距、背景色防透明、宽度与 viewBox 一致）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: 1200px; background: #F7F7F8; }
  svg { display: block; }
</style>
</head>
<body>
  <!-- 在此粘贴完整 SVG（与 .svg 源文件一致） -->
</body>
</html>
```

### 步骤 3：Chrome 无头渲染 PNG
用 `run_command` 执行（`--window-size` 用实际宽高；Chrome 绝对路径不依赖 shell PATH）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1200,2097 --screenshot="<绝对路径>/homework/<主题>-infographic.png" "file://<绝对路径>/homework/.ai-workspace/infographic-render.html"
```

> Chrome 不可用时备选：`/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` 同样参数。
> 若 PNG 为透明底：检查 HTML 壳 body 背景色是否为 `#F7F7F8`；透明底时补一层全幅背景 `<rect>` 后重渲。

### 步骤 4：视觉校验（必做）
用 `read_attachment` 读回 PNG，让视觉模型检查：文字溢出截断 / 元素重叠 / 出界 / 配色对比。发现溢出→修改 SVG 源文件（分行、缩字号、扩卡片）→ 重走步骤 2–4 循环，直至通过。

### 步骤 5：清理并交付
`run_command` 删除中间壳文件（`infographic-render.html`），确认 `homework/` 只留 PNG + SVG 两份；正文汇报尺寸、板块结构与文件路径。

## 落盘模式自检清单

- [ ] viewBox 与最终尺寸一致，宽 >680（长图）无截断
- [ ] 品牌 Purple `#4b3fe3` 主色，面积 ≤20%，无渐变/第三色相/纯黑底
- [ ] 四段式结构齐全：标题区 / 关键数字带（≥24 放大档）/ 主体分区（≤4）/ 注记行
- [ ] 中文用中文字体栈；数字 tabular 对齐
- [ ] 视觉校验通过：无文字溢出截断、无重叠出界、留边 ≥40
- [ ] 产物双格式落盘 `homework/`（PNG + SVG），中间文件已清理

---

# §对话内嵌海报模式（widget:svg · 宽 ≤680）

## 核心心法

信息图 = **视觉叙事**，不是卡片堆叠。一张好的信息图要让读者在 5 秒内看懂主题、30 秒内读完核心信息，
然后愿意停留细看细节。对照标杆（如一线对话模型直接生成的信息图）：

| 维度 | 优秀信息图（本规范目标） | 平庸卡片式（要避免） |
|---|---|---|
| 标题 | 大号 display 标题 + 副标题/时间戳，占据视觉中心 | 小号普通标题 |
| 结构 | 2-4 个语义分区，用浅色块区分，自上而下叙事 | 平铺列表 |
| 数字 | 关键数字大号（20-36px）+ tabular 对齐，直接冲击 | 与正文同字号 |
| 图形 | 几何图标、数据条、迷你条形、装饰圆点呼应主题 | 纯文字 |
| 色彩 | 品牌 Purple ≤2 + 中性，分区浅底 + 主色点缀 | 五彩杂色 / 纯灰 |
| 留白 | 分区间明确留白，元素不拥挤 | 密不透风 |

## 技术规格（widget:svg 渲染器约束）

- `viewBox`：**4:3**（680×510）或 1:1；宽 **≤ 680**；四周留边 **≥ 20**
- 无 `<script>` / `<foreignObject>`；纯 `<svg>` 矢量
- 字号按 **viewBox 内实际像素**：主标题 30-38 / 副标题 13-15 / 分区标题 16-19 / 关键数字 24-34 / 正文要点 12-14 / 来源注记 10-11
- 中文字体：`font-family="system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"`；数字用 `font-feature-settings="tnum"` 或 `letter-spacing` 微调对齐
- 文字不自动换行：要点长句用 `<tspan x="…" dy="1.5em">` 分行，或拆成多行 `<text>`
- 图标：几何图形（圆点/圆环/圆角矩形/线条箭头）简化为 1-2 个元素，不画复杂路径

## 构图模板（自上而下叙事，四段式）

1. **标题区**（top）：主标题（大号、字重 700、负 tracking）+ 副标题行（主题标签 · 时间/口径）
2. **关键数字带**：2-4 个核心指标并排（大数字 + 单位 + 短标签），是整个信息图的"第一眼"
3. **主体分区**：2-3 个浅色块分区（背景为主色 6-12% 浅色 + 圆角），每区 = 小标题（主色、字重 600）+ 内容（图标 + 要点 / 数据条 / 迷你条形 / 简要解读）
4. **注记行**（bottom）：数据来源、口径说明（小号、次级色）

## 配色（统一品牌 Purple，不设行业色板）

- **主色/强调色一律品牌 Purple `#4b3fe3`**（标题、关键数字、分区标题、图标圆点、引用条竖线）；深色环境用 `#6054f1`
- 浅底 = brand-soft `#F2F7FF`；页面背景 = surface `#F7F7F8`；卡片白 `#FFFFFF`
- 中性灰层级：正文 `#171717` / 次级 `#52525b` / 弱文字 `#a1a1aa` / 边框 `#E4E4E7`
- 系列色（数据条/折线等分类用）：Purple family `#4b3fe3 / #6f6fff / #a9aeff / #d3d4da`，**不引入其它色相**
- 语义色（绿/红/橙）仅真实状态/风险数据使用；❌ 蓝紫渐变 ❌ 纯黑底 ❌ 荧光色

## 自检（输出前）

**合规项**：
- [ ] 主题一眼可见（大标题）；核心数字一眼可见
- [ ] 分区 ≤4，色块区分清晰，分区间距 ≥12
- [ ] **主色为品牌 Purple `#4b3fe3`**；主色面积 ≤ 20%（标题/数字/图标/描边，不铺满背景）
- [ ] 所有元素在 viewBox 内，无重叠、无出界、留边 ≥20
- [ ] 字号按上面档位；正文 ≥12；来源注记 10-11
- [ ] 图标几何简洁，与主题呼应
- [ ] 中文内容用中文字体栈；无 script/foreignObject

**审美项（对照 06-aesthetic-design.md）**：
- [ ] 第一眼能说出"先看什么"——有唯一视觉焦点（大标题/大数字/主结论）
- [ ] 标题有排版张力：大标题（可两行断开、上下对比色）或 大标题 + 右上标签胶囊
- [ ] 关键数字 ≥24 且同排基线对齐、tabular；数字带是第一眼
- [ ] 有装饰细节 ≥2 处（序号徽标 / 数据条 / 圆点引导线 / 标签胶囊 / 分区色块）
- [ ] 去掉边框后层级仍成立（靠大小/对比/留白，不靠线）
- [ ] 留白充足，无拥挤感（分区间距 ≥12、卡内边距 ≥12、四周 ≥20）

---

## 完整示例（品牌 Purple · 4:3 · 680×510 · 杂志式排版）

````markdown
```widget:svg
<svg viewBox="0 0 680 510" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif">
  <!-- 背景 -->
  <rect x="0" y="0" width="680" height="510" rx="14" fill="#F7F7F8"/>

  <!-- 标题区：杂志式两行断开（上黑下紫）+ 右上标签胶囊 -->
  <text x="36" y="54" font-size="30" font-weight="700" letter-spacing="-0.6" fill="#171717">2026 中国智能家居市场</text>
  <text x="36" y="88" font-size="30" font-weight="700" letter-spacing="-0.6" fill="#4b3fe3">规模与趋势一览</text>
  <rect x="472" y="32" width="172" height="27" rx="13.5" fill="#F2F7FF" stroke="#4b3fe3" stroke-opacity="0.35"/>
  <text x="492" y="50" font-size="12" fill="#4b3fe3">数据可视化 · 2026H1</text>
  <line x1="36" y1="110" x2="644" y2="110" stroke="#E4E4E7" stroke-width="1.5"/>

  <!-- 关键数字带（第一眼）：3 个大数字，tabular 对齐 + 圆环装饰 -->
  <g>
    <rect x="36" y="128" width="190" height="96" rx="12" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1"/>
    <circle cx="52" cy="146" r="6" fill="#F2F7FF"/><circle cx="52" cy="146" r="2.5" fill="#4b3fe3"/>
    <text x="52" y="186" font-size="34" font-weight="700" fill="#4b3fe3" font-feature-settings="tnum">1,286</text>
    <text x="196" y="186" font-size="13" fill="#52525b">亿元</text>
    <text x="52" y="210" font-size="12" fill="#171717">市场规模（2025）</text>

    <rect x="240" y="128" width="190" height="96" rx="12" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1"/>
    <circle cx="256" cy="146" r="6" fill="#F2F7FF"/><circle cx="256" cy="146" r="2.5" fill="#4b3fe3"/>
    <text x="256" y="186" font-size="34" font-weight="700" fill="#4b3fe3" font-feature-settings="tnum">+18.4%</text>
    <text x="256" y="210" font-size="12" fill="#171717">同比增速 · 出货 4.2 亿台</text>

    <rect x="444" y="128" width="200" height="96" rx="12" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1"/>
    <circle cx="460" cy="146" r="6" fill="#F2F7FF"/><circle cx="460" cy="146" r="2.5" fill="#4b3fe3"/>
    <text x="460" y="186" font-size="34" font-weight="700" fill="#4b3fe3" font-feature-settings="tnum">62%</text>
    <text x="460" y="210" font-size="12" fill="#171717">城镇家庭智能设备渗透率</text>
  </g>

  <!-- 不对称分区：左 = 核心结论（大），右 = 增长驱动（小） -->
  <rect x="36" y="240" width="394" height="204" rx="12" fill="#F2F7FF"/>
  <rect x="52" y="266" width="3" height="18" rx="1.5" fill="#4b3fe3"/>
  <text x="66" y="281" font-size="16" font-weight="600" fill="#4b3fe3">核心结论</text>
  <text x="52" y="318" font-size="15" fill="#171717">智能家居进入「全家智能」阶段</text>
  <text x="52" y="344" font-size="15" fill="#171717">套系购买占比升至 41%，客单价上探</text>
  <text x="52" y="370" font-size="15" font-weight="600" fill="#4b3fe3">套系化是 2026 年最大增长引擎</text>
  <text x="52" y="402" font-size="12" fill="#171717">套系购买占比</text>
  <rect x="52" y="412" width="250" height="10" rx="5" fill="#FFFFFF"/>
  <rect x="52" y="412" width="102" height="10" rx="5" fill="#4b3fe3"/>
  <text x="312" y="421" font-size="12" font-weight="600" fill="#4b3fe3" font-feature-settings="tnum">41%</text>

  <rect x="444" y="240" width="200" height="204" rx="12" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1"/>
  <text x="462" y="272" font-size="16" font-weight="600" fill="#171717">增长驱动</text>
  <g font-size="12" fill="#171717">
    <circle cx="472" cy="300" r="9" fill="#F2F7FF" stroke="#4b3fe3" stroke-opacity="0.5"/><text x="469" y="304" font-size="9" fill="#4b3fe3" text-anchor="middle">01</text>
    <text x="490" y="304">全屋智能方案普及</text>
    <circle cx="472" cy="326" r="9" fill="#F2F7FF" stroke="#4b3fe3" stroke-opacity="0.5"/><text x="469" y="330" font-size="9" fill="#4b3fe3" text-anchor="middle">02</text>
    <text x="490" y="330">大模型语音交互放量</text>
    <circle cx="472" cy="352" r="9" fill="#F2F7FF" stroke="#4b3fe3" stroke-opacity="0.5"/><text x="469" y="356" font-size="9" fill="#4b3fe3" text-anchor="middle">03</text>
    <text x="490" y="356">政策补贴覆盖安防/适老</text>
  </g>
  <text x="462" y="418" font-size="10" fill="#a1a1aa">行业年度报告（2026）</text>

  <!-- 底部注记 -->
  <line x1="36" y1="462" x2="644" y2="462" stroke="#E4E4E7" stroke-width="1.5"/>
  <text x="36" y="486" font-size="11" fill="#a1a1aa">来源：行业公开数据整理 · 金额为人民币口径 · 渗透率统计范围为城镇家庭</text>
</svg>
```
````

要点（对齐 06-aesthetic-design.md）：
1. **标题有排版张力**：两行断开、上黑下紫对比色 + 右上标签胶囊（副信息剥离出标题行）
2. **第一眼 = 关键数字带**：34px tabular 大数字 + 圆环装饰，三个数字基线对齐
3. **不对称布局**：左大（核心结论，15px 结论句 + 主色强调句 + 数据条）右小（要点 + 序号徽标），打破"卡片网格"同质化
4. **装饰细节**：圆环圆点（数字带）、紫竖线（分区标题）、序号徽标 01/02/03、数据条、标签胶囊——共 4 处且都极简
5. **主色 ≤20%**：只落在标题第二行/数字/竖线/强调句/数据条/徽标描边，正文全中性灰
6. 分区浅紫底 `#F2F7FF` + 白卡（带 1px 淡边）形成灰→紫浅→白的三层层次，无渐变无第 3 色相
