# 手绘质感风格库（L3 按需资源 · 技法 / 字体 / 色板 / 图标库）

> 适用：`hand-drawn-map` 的第三步「手绘质感四件套」需要精确技法、图标路径、色板数值时读取。
> 全部为**纯 SVG**，无 JS、无外链字体文件、无外链图片。

---

## §1 纸底（Paper）

### 三档纸底（选一，不要叠加）

| 档位 | 构成 | 用途 |
|---|---|---|
| **A 素纸** | 单层暖米白 `#FAF7F2` | 最快、最干净；元素少时首选 |
| **B 点阵纸** | `#FAF7F2` + 24px 点阵 | 默认档；给"图纸感"但不抢戏 |
| **C 纸纹纸** | `#FAF7F2` + `feTurbulence` 颗粒 | 最高质感；节点多、需要"旧地图"氛围时用 |

### B 点阵实现

```svg
<defs>
  <pattern id="dotGrid" width="24" height="24" patternUnits="userSpaceOnUse">
    <circle cx="2" cy="2" r="1" fill="#E2DACE"/>
  </pattern>
</defs>
<rect x="0" y="0" width="1600" height="1000" fill="#FAF7F2"/>
<rect x="0" y="0" width="1600" height="1000" fill="url(#dotGrid)"/>
```

### C 纸纹实现（颗粒）

```svg
<defs>
  <filter id="paperGrain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" seed="7" stitchTiles="stitch" result="noise"/>
    <feColorMatrix in="noise" type="saturate" values="0" result="gray"/>
    <feComponentTransfer in="gray">
      <feFuncA type="linear" slope="0.05" intercept="0"/>
    </feComponentTransfer>
  </filter>
</defs>
<rect x="0" y="0" width="1600" height="1000" fill="#FAF7F2"/>
<rect x="0" y="0" width="1600" height="1000" filter="url(#paperGrain)"/>
```

> 颗粒只铺**一层**，`slope` 保持 0.04–0.07；超过 0.1 会显脏并压低文字对比。
> 颗粒层永远放在**所有内容之下**（第二个 rect），不要盖在文字上。

### 纸底禁忌

- ❌ 纯白 `#FFFFFF` 底（失去手绘温度）
- ❌ 任何渐变底（含径向渐变做"晕染"）
- ❌ 米黄过深（`#F5E6C8` 一类的"做旧羊皮纸"会和紫色主色打架，且显廉价）

---

## §2 抖动线条（Wobble · 手绘感的 80% 在这里）

### 硬规则

1. 所有路径 `stroke-linecap="round"` + `stroke-linejoin="round"`
2. **不用完美直线**：任何长度 > 60px 的直线必须替换为轻微弧线
3. **不用硬直角**：转角用 `Q`（二次贝塞尔）倒角
4. **笔宽只允许 3 档**：细 `2` / 中 `3.5` / 粗 `6`（1600 宽画布基准；按画布等比缩放）
5. **抖动幅度只允许 1 档**：同图内所有线条统一 `±2px`（1600 宽基准）

### 抖动直线：手工构造法

把 A→B 拆成 2 段，中点垂直于 AB 方向偏移 ±2px，用 `Q` 连接：

```
直线 A(100,200) → B(500,200)   （水平，长度 400）
拆 2 段：中点 M(300,200)
垂直方向 = 向下 = +y
抖动：第 1 段中点 (200, 202)，第 2 段中点 (400, 198)   ← 交替正负
结果：M100 200 Q200 202 300 200 Q400 198 500 200
```

### 抖动折线生成算法（可在临时脚本里实现，不要写进产物 SVG）

```js
// wobble(points, amp=2) —— points: [[x,y],...] 顶点数组
// 每条边拆 2 段，中点沿垂直方向交替 ±amp 偏移
function wobble(points, amp = 2) {
  const pt = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  let d = `M${pt(points[0])}`;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;          // 单位法向量
    const sign = i % 2 === 0 ? 1 : -1;            // 交替正负
    const a = [x1 + dx * 0.33 + nx * amp * sign, y1 + dy * 0.33 + ny * amp * sign];
    const b = [x1 + dx * 0.67 - nx * amp * sign, y1 + dy * 0.67 - ny * amp * sign];
    d += ` Q${pt(a)} ${pt([x1 + dx / 3, y1 + dy / 3])}`;
    d += ` Q${pt(b)} ${pt([x2, y2])}`;
  }
  return d;
}
// 用法：<path d="{wobble([[120,300],[520,300],[520,620]])}" fill="none" stroke="#4b3fe3" stroke-width="3.5" stroke-linecap="round"/>
```

### 手绘道路（主干道）

主干道路 = 双线 + 中间虚线，是路线图最有辨识度的元素：

```svg
<!-- 道路底（粗、浅色、实线） -->
<path d="M120 300 Q320 302 520 300 Q720 298 920 300" fill="none" stroke="#F2EDE4" stroke-width="22" stroke-linecap="round"/>
<!-- 道路面（主色、中线） -->
<path d="M120 300 Q320 302 520 300 Q720 298 920 300" fill="none" stroke="#4b3fe3" stroke-width="3.5" stroke-linecap="round"/>
<!-- 道路虚线（居中、纸色、模拟中线） -->
<path d="M120 300 Q320 302 520 300 Q720 298 920 300" fill="none" stroke="#FAF7F2" stroke-width="2" stroke-dasharray="14 12" stroke-linecap="round"/>
```

### 手绘虚线轨迹（藏宝图/次要关系）

```svg
<path d="M200 700 Q420 640 620 700" fill="none" stroke="#6B6459" stroke-width="3.5"
      stroke-linecap="round" stroke-dasharray="12 10"/>
```

### 抖动圆圈（地标底盘 / 岛屿）

```svg
<!-- 椭圆 + 轻微旋转，避免"完美圆" -->
<ellipse cx="640" cy="420" rx="150" ry="104" fill="#F2F7FF"
         stroke="#4b3fe3" stroke-opacity="0.45" stroke-width="3.5" transform="rotate(-2.5 640 420)"/>
```

---

## §3 字体栈

### 标题 / 地标名（手写感）

```
font-family="'Hanzipen SC', 'HanziPen SC', 'Yuanti SC', 'Kaiti SC', 'STKaiti', 'Bradley Hand', 'Comic Sans MS', cursive"
```

> macOS 上 `Kaiti SC / STKaiti`（楷体）必然存在，是最稳的手写感中文回退。
> `Hanzipen SC`（华文手写体）与 `Yuanti SC`（圆体）视系统安装情况生效。

### 说明 / 图例 / 注记（可读性优先）

```
font-family="system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"
```

### 数字（刻度、编号、坐标）

```
font-family="'SF Mono', 'Menlo', 'Consolas', monospace" font-feature-settings="tnum"
```

### 字号档位（1600×1000 画布基准；按画布等比缩放）

| 元素 | 字号 | 字重 |
|---|---|---|
| 地图主标题 | 54–68 | 700 |
| 副标题 / 主题标签 | 22–28 | 400 |
| 分区区名 | 32–40 | 700 |
| 地标名 | 20–26 | 600 |
| 地标说明 | 16–19 | 400 |
| 图例 / 刻度 / 注记 | 15–18 | 400 |

> **手写体只用于主标题 / 区名 / 地标名**（≥18px）。说明文字一律系统栈——手写体小字号可读性崩塌。

---

## §4 色板（暖纸 + 品牌紫）

| 用途 | 色值 | 说明 |
|---|---|---|
| **纸底** | `#FAF7F2` | 全幅背景 |
| 纸纹深 / 道路底 | `#F2EDE4` | 道路底、区块淡底 |
| 边框 / 网格点 | `#E2DACE` | 1–2px 细边、点阵 |
| **主色（品牌 Purple）** | `#4b3fe3` | 路径主线、强调地标、标题 |
| 主色（深色环境） | `#6054f1` | 深底场景替代 |
| 主色浅底 | `#F2F7FF` | 分区填充、地标底盘 |
| 墨色（正文） | `#2E2A25` | 暖墨，替代纯黑 |
| 次级文字 | `#6B6459` | 说明、图例 |
| 弱文字 | `#A8A196` | 注记、比例尺 |
| 语义绿（仅状态） | `#2F8F5B` | 已完成 / 成功 |
| 语义红（仅状态） | `#C4553B` | 风险 / 阻塞 |
| 语义橙（仅状态） | `#C98A2E` | 进行中 / 待定 |

**分配纪律**：
- 主色 `#4b3fe3` 面积 ≤ 20%（路径主线 + 强调地标描边 + 标题）
- 普通地标用**墨色描边**，只有「焦点地标」用主色 —— 焦点最多 2 个
- 语义色仅用于真实状态，不做装饰

---

## §5 地标图标库（24×24 viewBox · 线性 + 单色）

> 用法：外层容器先 `translate(x, y)` 到地标中心，图标再包一层 `translate(-12*s, -12*s) scale(s)`。
> **居中公式必须用 `-12*s`**：`translate(-12,-12) scale(s)` 会让图标整体偏移 `(12s-12, 12s-12)`（s=1.9 时偏了 10.8px），是常见翻车点。
> 默认 `s = 1.9`（图标约 45.6px，配 `rx52 ry38` 底盘约 44% 宽度）；`stroke` 用墨色或主色，`fill="none"`，`stroke-width="1.8"`（24 基准，缩放后视觉一致）。
> **视觉重心微调**：部分图标在 24×24 框内重心不在正中（树的树干偏下、宝箱/云整体偏下），需按内容 bbox 中心调 `ty = -bbox_center_y * s`，否则会显得"沉底"。
> 常用档位：普通地标 `rx46 ry34` + `s=1.5`（`translate(-18,-18)`）；焦点地标 `rx52 ry38` + `s=1.9`（`translate(-22.8,-22.8)`）。

| 图标 | SVG |
|---|---|
| 山 | `<path d="M2 20 L9 7 L13 13 L16 9 L22 20 Z"/>` |
| 树 | `<path d="M12 3 L18 12 H6 Z"/><path d="M12 11 L20 20 H4 Z"/><line x1="12" y1="20" x2="12" y2="23"/>` |
| 房子 | `<path d="M4 11 L12 4 L20 11"/><path d="M6 11 V20 H18 V11"/>` |
| 塔 / 城堡 | `<path d="M7 21 V9 H17 V21 Z"/><path d="M7 9 L12 4 L17 9"/><rect x="10.5" y="14" width="3" height="7"/>` |
| 旗 | `<line x1="6" y1="3" x2="6" y2="21"/><path d="M6 4 H18 L15 8 L18 12 H6 Z"/>` |
| 星 | `<polygon points="12,3 14.6,9.3 21,9.9 16.2,14.2 17.6,20.5 12,17.1 6.4,20.5 7.8,14.2 3,9.9 9.4,9.3"/>` |
| 船锚 | `<line x1="12" y1="5" x2="12" y2="21"/><circle cx="12" cy="4" r="2.2"/><path d="M5 12 H19"/><path d="M5 12 C5 18 8 20 12 20 C16 20 19 18 19 12"/>` |
| 宝箱 | `<rect x="3" y="9" width="18" height="11" rx="1.5"/><path d="M3 13 H21"/><rect x="10.5" y="11.5" width="3" height="4" rx="0.8"/>` |
| 桥 | `<line x1="2" y1="7" x2="22" y2="7"/><path d="M3 17 A9 9 0 0 1 21 17"/>` |
| 山洞 | `<path d="M2 21 Q12 3 22 21"/><path d="M8.5 21 A3.5 3.5 0 0 1 15.5 21"/>` |
| 云 | `<path d="M7 18 A4 4 0 0 1 7 10 A5 5 0 0 1 17 10 A4 4 0 0 1 17 18 Z"/>` |
| 圆点 | `<circle cx="12" cy="12" r="5"/>` |
| 图钉 | `<path d="M12 21 L12 12"/><circle cx="12" cy="8" r="5"/>` |
| 闪电 | `<path d="M13 2 L5 14 H11 L10 22 L19 9 H12 Z"/>` |
| 灯泡 | `<circle cx="12" cy="9" r="6"/><path d="M9.5 15 H14.5"/><path d="M10 18 H14"/><path d="M10.5 21 H13.5"/>` |

### 地标完整构件（底盘 + 图标 + 名称 + 编号）

```svg
<g transform="translate(520, 300)">
  <!-- 底盘：椭圆 + 微旋转（手绘感） -->
  <ellipse cx="0" cy="0" rx="52" ry="38" fill="#F2F7FF" stroke="#4b3fe3" stroke-width="3.5" transform="rotate(-3)"/>
  <!-- 图标：居中公式 translate(-12*s,-12*s) scale(s)，s=1.9 -->
  <g transform="translate(-22.8,-22.8) scale(1.9)" fill="none" stroke="#4b3fe3" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 11 L12 4 L20 11"/><path d="M6 11 V20 H18 V11"/>
  </g>
  <!-- 编号徽标（右上角，压在底盘边缘上，主色实心圆） -->
  <circle cx="38" cy="-28" r="13" fill="#4b3fe3"/>
  <text x="38" y="-23" font-size="14" font-weight="700" fill="#FAF7F2" text-anchor="middle"
        font-family="'SF Mono','Menlo',monospace">1</text>
  <!-- 名称（下方） -->
  <text x="0" y="58" font-size="22" font-weight="600" fill="#2E2A25" text-anchor="middle"
        font-family="'Kaiti SC','STKaiti',cursive">需求洞察</text>
  <!-- 说明（名称下方，系统栈） -->
  <text x="0" y="82" font-size="16" fill="#6B6459" text-anchor="middle"
        font-family="system-ui, -apple-system, 'PingFang SC', sans-serif">用户访谈 · 42 场</text>
</g>
```

---

## §6 地图装饰件（让"示意图"变成"地图"的关键）

> 至少用 **2 件**；这四件是读者判断"这是地图"的视觉证据。

### 6.1 指北针（Compass Rose）

```svg
<g transform="translate(1500, 120)" opacity="0.85">
  <circle cx="0" cy="0" r="30" fill="none" stroke="#A8A196" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="0" cy="0" r="22" fill="none" stroke="#E2DACE" stroke-width="1.5"/>
  <path d="M0 -24 L5 0 L0 24 L-5 0 Z" fill="#4b3fe3"/>
  <path d="M-24 0 L0 -5 L24 0 L0 5 Z" fill="none" stroke="#A8A196" stroke-width="2.5" stroke-linejoin="round"/>
  <text x="0" y="-36" font-size="16" font-weight="700" fill="#6B6459" text-anchor="middle"
        font-family="'Kaiti SC','STKaiti',cursive">N</text>
</g>
```

### 6.2 比例尺（Scale Bar · 装饰性，不代表真实距离）

```svg
<g transform="translate(120, 900)">
  <path d="M0 0 H180" stroke="#6B6459" stroke-width="3" stroke-linecap="round"/>
  <path d="M0 -7 V7 M45 -7 V7 M90 -7 V7 M135 -7 V7 M180 -7 V7" stroke="#6B6459" stroke-width="3" stroke-linecap="round"/>
  <rect x="0" y="-6" width="45" height="12" fill="#2E2A25"/>
  <rect x="90" y="-6" width="45" height="12" fill="#2E2A25"/>
  <text x="0" y="28" font-size="15" fill="#A8A196" font-family="system-ui, -apple-system, 'PingFang SC', sans-serif">示意刻度 · 非真实距离</text>
</g>
```

> ⚠️ 比例尺必须注明「非真实距离」，否则误导。

### 6.3 图例（Legend · **必做**）

```svg
<g transform="translate(120, 780)" font-family="system-ui, -apple-system, 'PingFang SC', sans-serif">
  <rect x="-16" y="-28" width="300" height="112" rx="10" fill="#FAF7F2" stroke="#E2DACE" stroke-width="1.5"/>
  <text x="0" y="-6" font-size="17" font-weight="700" fill="#2E2A25"
        font-family="'Kaiti SC','STKaiti',cursive">图例</text>
  <path d="M0 18 Q22 20 44 18" fill="none" stroke="#4b3fe3" stroke-width="3.5" stroke-linecap="round"/>
  <text x="58" y="23" font-size="15" fill="#6B6459">主干路径（推进方向）</text>
  <path d="M0 44 Q22 46 44 44" fill="none" stroke="#6B6459" stroke-width="3" stroke-linecap="round" stroke-dasharray="10 8"/>
  <text x="58" y="49" font-size="15" fill="#6B6459">次要关系 / 支线</text>
  <g transform="translate(6,62)"><circle cx="6" cy="6" r="6" fill="#4b3fe3"/></g>
  <text x="58" y="75" font-size="15" fill="#6B6459">焦点地标</text>
</g>
```

### 6.4 纸边图框（双层内缩 + 微旋转）

```svg
<!-- 外层：淡纸边 -->
<rect x="24" y="24" width="1552" height="952" rx="6" fill="none" stroke="#E2DACE" stroke-width="2" transform="rotate(-0.3 800 500)"/>
<!-- 内层：细墨线 -->
<rect x="34" y="34" width="1532" height="932" rx="4" fill="none" stroke="#A8A196" stroke-width="1.2" transform="rotate(-0.3 800 500)"/>
```

---

## §7 手绘感自检（本资源专属）

- [ ] 纸底只有 1 层（素纸 / 点阵 / 纸纹 三选一）
- [ ] 所有 `stroke-linecap="round"`；无完美长直线；无硬直角
- [ ] 笔宽只用 3 档；抖动幅度全图统一
- [ ] 手写体只出现在标题/区名/地标名，且 ≥18px
- [ ] 主色 ≤ 20%，普通地标用墨色描边
- [ ] 装饰件 ≥ 2 件（指北针 / 比例尺 / 图例 / 图框）
- [ ] 比例尺已注明「非真实距离」
- [ ] 图例存在且覆盖：路径含义 / 分区含义 / 地标类型
