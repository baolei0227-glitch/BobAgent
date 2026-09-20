# 构图模板库（L3 按需资源 · T1–T5 · 含完整示例）

> 适用：`hand-drawn-map` 第二步完成「构图模板路由」后，需要具体坐标算法与完整示例时读取。
> 所有坐标基于 **1600 × 1000** 画布；换尺寸时按比例缩放，或按下表的安全区重新算。

**通用安全区（1600×1000）**

| 区域 | 范围 |
|---|---|
| 内层图框 | `x 34–1566`，`y 34–966` |
| 标题区 | `y 60–186`（标题基线 118，副标题基线 158，分隔线 186） |
| 主体区 | `x 120–1518`，`y 206–806` |
| 注记区 | `y 826–934`（图例 / 比例尺 / 落款） |

---

## T1 路径式（路线图 / 旅程图 / 阶段推进）

**形态**：一条横向主干道贯穿全图，地标坐在道路上，名称上下交替。
**地标数**：5–8（2–3 个阶段分区，每区 2–3 个地标）。

### 坐标算法

```
主体宽 W = 1398（120 → 1518）
分区数 K = 3           → 分区宽 = W / K = 466
第 i 区（i=0,1,2）：
  x_left  = 120 + i * 466
  x_right = x_left + 466
  区名基线 y = 252，x = x_left + 28
地标 x：每区 2 个 → 区中心 ± 117
  x = x_left + 117, x_left + 349
地标 y = 560（道路基线，全图统一）
地标名称：自左向右交替「上方 / 下方」
  上方 → 名称基线 y = 476，说明基线 y = 500
  下方 → 名称基线 y = 648，说明基线 y = 672
起点 x = 140，终点 x = 1500（两端各留 96 的呼吸位）
起点/终点标签：落在道路**下方**基线 y = 620（不要放 y = 500——那行会与相邻「上方」地标的说明文字排成一行，读起来像一串连读文字）
```

### 完整示例（直接可渲染 · 6 地标 / 3 分区）

```svg
<svg viewBox="0 0 1600 1000" xmlns="http://www.w3.org/2000/svg"
     font-family="system-ui, -apple-system, 'PingFang SC', sans-serif">
  <!-- ===== 纸底 ===== -->
  <rect x="0" y="0" width="1600" height="1000" fill="#FAF7F2"/>
  <defs>
    <pattern id="dotGrid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="#E2DACE"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="1600" height="1000" fill="url(#dotGrid)"/>

  <!-- ===== 图框 ===== -->
  <rect x="24" y="24" width="1552" height="952" rx="6" fill="none"
        stroke="#E2DACE" stroke-width="2" transform="rotate(-0.3 800 500)"/>
  <rect x="34" y="34" width="1532" height="932" rx="4" fill="none"
        stroke="#A8A196" stroke-width="1.2" transform="rotate(-0.3 800 500)"/>

  <!-- ===== 标题区 ===== -->
  <text x="120" y="118" font-size="60" font-weight="700" fill="#2E2A25"
        font-family="'Kaiti SC','STKaiti',cursive">产品演进地图</text>
  <text x="120" y="158" font-size="24" fill="#6B6459">从需求洞察到生态开放的六站旅程 · 2024–2027</text>
  <path d="M120 186 Q800 184 1480 186" fill="none" stroke="#E2DACE" stroke-width="2" stroke-linecap="round"/>

  <!-- ===== 阶段分区（3 带） ===== -->
  <g>
    <rect x="120" y="206" width="466" height="600" rx="14" fill="#F2F7FF"
          stroke="#4b3fe3" stroke-opacity="0.18" stroke-width="1.5"/>
    <rect x="586" y="206" width="466" height="600" rx="14" fill="#F2F7FF"
          stroke="#4b3fe3" stroke-opacity="0.18" stroke-width="1.5"/>
    <rect x="1052" y="206" width="466" height="600" rx="14" fill="#F2F7FF"
          stroke="#4b3fe3" stroke-opacity="0.18" stroke-width="1.5"/>
  </g>
  <text x="148" y="252" font-size="34" font-weight="700" fill="#4b3fe3"
        font-family="'Kaiti SC','STKaiti',cursive">探索期</text>
  <text x="614" y="252" font-size="34" font-weight="700" fill="#4b3fe3"
        font-family="'Kaiti SC','STKaiti',cursive">构建期</text>
  <text x="1080" y="252" font-size="34" font-weight="700" fill="#4b3fe3"
        font-family="'Kaiti SC','STKaiti',cursive">增长期</text>

  <!-- ===== 主干道（底壳 + 路面 + 中线） ===== -->
  <path d="M140 560 Q330 534 520 560 Q710 586 900 560 Q1090 534 1280 560 Q1400 570 1500 560"
        fill="none" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round"/>
  <path d="M140 560 Q330 534 520 560 Q710 586 900 560 Q1090 534 1280 560 Q1400 570 1500 560"
        fill="none" stroke="#4b3fe3" stroke-width="3.5" stroke-linecap="round"/>

  <!-- ===== 起点 / 终点 ===== -->
  <circle cx="140" cy="560" r="12" fill="#FAF7F2" stroke="#2E2A25" stroke-width="3.5"/>
  <text x="140" y="620" font-size="18" fill="#6B6459" text-anchor="middle"
        font-family="'Kaiti SC','STKaiti',cursive">起点</text>
  <g transform="translate(1500,560)">
    <line x1="0" y1="-34" x2="0" y2="34" stroke="#2E2A25" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M0 -32 L34 -22 L0 -12 Z" fill="#4b3fe3"/>
  </g>
  <text x="1500" y="620" font-size="18" fill="#6B6459" text-anchor="middle"
        font-family="'Kaiti SC','STKaiti',cursive">终点</text>

  <!-- ===== 地标 L1（上） ===== -->
  <g transform="translate(237,560)">
    <ellipse cx="0" cy="0" rx="46" ry="34" fill="#FAF7F2" stroke="#2E2A25" stroke-width="3.5" transform="rotate(-3)"/>
    <g transform="translate(-18,-19.5) scale(1.5)" fill="none" stroke="#2E2A25" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3 L18 12 H6 Z"/><path d="M12 11 L20 20 H4 Z"/><line x1="12" y1="20" x2="12" y2="23"/>
    </g>
    <circle cx="36" cy="-28" r="14" fill="#2E2A25"/>
    <text x="36" y="-23" font-size="15" font-weight="700" fill="#FAF7F2" text-anchor="middle"
          font-family="'SF Mono','Menlo',monospace">1</text>
    <text x="0" y="-84" font-size="22" font-weight="600" fill="#2E2A25" text-anchor="middle"
          font-family="'Kaiti SC','STKaiti',cursive">需求洞察</text>
    <text x="0" y="-60" font-size="16" fill="#6B6459" text-anchor="middle">用户访谈 42 场</text>
  </g>

  <!-- ===== 地标 L2（下） ===== -->
  <g transform="translate(469,560)">
    <ellipse cx="0" cy="0" rx="46" ry="34" fill="#FAF7F2" stroke="#2E2A25" stroke-width="3.5" transform="rotate(2)"/>
    <g transform="translate(-18,-21) scale(1.5)" fill="none" stroke="#2E2A25" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="9" width="18" height="11" rx="1.5"/><path d="M3 13 H21"/>
      <rect x="10.5" y="11.5" width="3" height="4" rx="0.8"/>
    </g>
    <circle cx="36" cy="-28" r="14" fill="#2E2A25"/>
    <text x="36" y="-23" font-size="15" font-weight="700" fill="#FAF7F2" text-anchor="middle"
          font-family="'SF Mono','Menlo',monospace">2</text>
    <text x="0" y="88" font-size="22" font-weight="600" fill="#2E2A25" text-anchor="middle"
          font-family="'Kaiti SC','STKaiti',cursive">方案设计</text>
    <text x="0" y="112" font-size="16" fill="#6B6459" text-anchor="middle">3 轮设计评审</text>
  </g>

  <!-- ===== 地标 L3（上 · 焦点地标，主色） ===== -->
  <g transform="translate(703,560)">
    <ellipse cx="0" cy="0" rx="52" ry="38" fill="#F2F7FF" stroke="#4b3fe3" stroke-width="4" transform="rotate(-3)"/>
    <g transform="translate(-20.4,-20.4) scale(1.7)" fill="none" stroke="#4b3fe3" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="M13 2 L5 14 H11 L10 22 L19 9 H12 Z"/>
    </g>
    <circle cx="42" cy="-32" r="15" fill="#4b3fe3"/>
    <text x="42" y="-27" font-size="16" font-weight="700" fill="#FAF7F2" text-anchor="middle"
          font-family="'SF Mono','Menlo',monospace">3</text>
    <text x="0" y="-90" font-size="24" font-weight="700" fill="#4b3fe3" text-anchor="middle"
          font-family="'Kaiti SC','STKaiti',cursive">MVP 上线</text>
    <text x="0" y="-64" font-size="16" fill="#6B6459" text-anchor="middle">首版全量发布</text>
  </g>

  <!-- ===== 地标 L4（下） ===== -->
  <g transform="translate(935,560)">
    <ellipse cx="0" cy="0" rx="46" ry="34" fill="#FAF7F2" stroke="#2E2A25" stroke-width="3.5" transform="rotate(3)"/>
    <g transform="translate(-18,-18) scale(1.5)" fill="none" stroke="#2E2A25" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
      <line x1="2" y1="7" x2="22" y2="7"/><path d="M3 17 A9 9 0 0 1 21 17"/>
    </g>
    <circle cx="36" cy="-28" r="14" fill="#2E2A25"/>
    <text x="36" y="-23" font-size="15" font-weight="700" fill="#FAF7F2" text-anchor="middle"
          font-family="'SF Mono','Menlo',monospace">4</text>
    <text x="0" y="88" font-size="22" font-weight="600" fill="#2E2A25" text-anchor="middle"
          font-family="'Kaiti SC','STKaiti',cursive">增长验证</text>
    <text x="0" y="112" font-size="16" fill="#6B6459" text-anchor="middle">留存 38%</text>
  </g>

  <!-- ===== 地标 L5（上） ===== -->
  <g transform="translate(1169,560)">
    <ellipse cx="0" cy="0" rx="46" ry="34" fill="#FAF7F2" stroke="#2E2A25" stroke-width="3.5" transform="rotate(-2)"/>
    <g transform="translate(-18,-19.5) scale(1.5)" fill="none" stroke="#2E2A25" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3 L18 12 H6 Z"/><path d="M12 11 L20 20 H4 Z"/><line x1="12" y1="20" x2="12" y2="23"/>
    </g>
    <circle cx="36" cy="-28" r="14" fill="#2E2A25"/>
    <text x="36" y="-23" font-size="15" font-weight="700" fill="#FAF7F2" text-anchor="middle"
          font-family="'SF Mono','Menlo',monospace">5</text>
    <text x="0" y="-84" font-size="22" font-weight="600" fill="#2E2A25" text-anchor="middle"
          font-family="'Kaiti SC','STKaiti',cursive">规模化</text>
    <text x="0" y="-60" font-size="16" fill="#6B6459" text-anchor="middle">覆盖 12 个行业</text>
  </g>

  <!-- ===== 地标 L6（下） ===== -->
  <g transform="translate(1401,560)">
    <ellipse cx="0" cy="0" rx="46" ry="34" fill="#FAF7F2" stroke="#2E2A25" stroke-width="3.5" transform="rotate(2.5)"/>
    <g transform="translate(-18,-21) scale(1.5)" fill="none" stroke="#2E2A25" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 18 A4 4 0 0 1 7 10 A5 5 0 0 1 17 10 A4 4 0 0 1 17 18 Z"/>
    </g>
    <circle cx="36" cy="-28" r="14" fill="#2E2A25"/>
    <text x="36" y="-23" font-size="15" font-weight="700" fill="#FAF7F2" text-anchor="middle"
          font-family="'SF Mono','Menlo',monospace">6</text>
    <text x="0" y="88" font-size="22" font-weight="600" fill="#2E2A25" text-anchor="middle"
          font-family="'Kaiti SC','STKaiti',cursive">生态开放</text>
    <text x="0" y="112" font-size="16" fill="#6B6459" text-anchor="middle">开放 API 平台</text>
  </g>

  <!-- ===== 图例 ===== -->
  <g transform="translate(150,858)">
    <rect x="-16" y="-26" width="320" height="106" rx="10" fill="#FAF7F2"
          stroke="#E2DACE" stroke-width="1.5"/>
    <text x="0" y="-4" font-size="17" font-weight="700" fill="#2E2A25"
          font-family="'Kaiti SC','STKaiti',cursive">图例</text>
    <path d="M0 20 Q22 22 44 20" fill="none" stroke="#4b3fe3" stroke-width="3.5" stroke-linecap="round"/>
    <text x="58" y="25" font-size="15" fill="#6B6459">主干路径（推进方向）</text>
    <ellipse cx="20" cy="48" rx="20" ry="13" fill="#F2F7FF" stroke="#4b3fe3" stroke-width="2.5"/>
    <text x="58" y="53" font-size="15" fill="#6B6459">焦点地标（关键节点）</text>
    <ellipse cx="20" cy="74" rx="20" ry="13" fill="#FAF7F2" stroke="#2E2A25" stroke-width="2.5"/>
    <text x="58" y="79" font-size="15" fill="#6B6459">普通地标</text>
  </g>

  <!-- ===== 指北针 ===== -->
  <g transform="translate(1450,858)" opacity="0.85">
    <circle cx="0" cy="0" r="30" fill="none" stroke="#A8A196" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="0" cy="0" r="22" fill="none" stroke="#E2DACE" stroke-width="1.5"/>
    <path d="M0 -24 L5 0 L0 24 L-5 0 Z" fill="#4b3fe3"/>
    <path d="M-24 0 L0 -5 L24 0 L0 5 Z" fill="none" stroke="#A8A196" stroke-width="2.5" stroke-linejoin="round"/>
    <text x="0" y="-36" font-size="16" font-weight="700" fill="#6B6459" text-anchor="middle"
          font-family="'Kaiti SC','STKaiti',cursive">N</text>
  </g>

  <!-- ===== 注记 ===== -->
  <text x="1518" y="950" font-size="15" fill="#A8A196" text-anchor="end">示意图 · 位置为叙事顺序，非真实地理</text>
</svg>
```

---

## T2 时间线地图（里程碑 / 版本 / 演进）

**形态**：T1 的变体——主干道下方增加一条**时间刻度轴**，地标上方加**旗标**。

### 与 T1 的差异（其余复用 T1 坐标）

| 构件 | 参数 |
|---|---|
| 时间轴 | `y = 760`，从 `x 140` 到 `x 1500`，笔宽 3，`stroke-linecap="round"` |
| 刻度 | 每站一条竖线：`y1 = 752, y2 = 768`，笔宽 3 |
| 刻度标签 | 基线 `y = 796`，字号 16，`text-anchor="middle"`，颜色 `#A8A196` |
| 分区带高度 | 缩到 `y 206 → 700`（给时间轴让位） |
| 地标 y | 缩到 `460`；上方名称基线 `y = 376`，说明 `y = 400`；下方名称 `y = 548`，说明 `y = 572` |
| 旗标 | 地标顶部加旗：`translate(x, y-40)`，旗面 `#4b3fe3` |

**时间轴构件**

```svg
<path d="M140 760 Q800 758 1500 760" fill="none" stroke="#6B6459" stroke-width="3" stroke-linecap="round"/>
<g stroke="#6B6459" stroke-width="3" stroke-linecap="round">
  <line x1="237" y1="752" x2="237" y2="768"/>
  <line x1="469" y1="752" x2="469" y2="768"/>
  <line x1="703" y1="752" x2="703" y2="768"/>
  <line x1="935" y1="752" x2="935" y2="768"/>
  <line x1="1169" y1="752" x2="1169" y2="768"/>
  <line x1="1401" y1="752" x2="1401" y2="768"/>
</g>
<g font-size="16" fill="#A8A196" text-anchor="middle">
  <text x="237" y="796">2024 Q1</text>
  <text x="469" y="796">2024 Q3</text>
  <text x="703" y="796">2025 Q1</text>
  <text x="935" y="796">2025 Q3</text>
  <text x="1169" y="796">2026 Q2</text>
  <text x="1401" y="796">2027 Q1</text>
</g>
```

> ⚠️ 时间轴落到 `y 760–796` 后，图例必须从 `y 858` 上移到注记区右侧，或改竖排放在右侧分区外。

---

## T3 藏宝图式（目标达成 / 闯关 / 叙事信息图）

**形态**：中心岛屿 + 环绕虚线航线 + 起点船锚 + 终点 ✕ 标记；节点沿航线散布，纸底用 C 档纸纹。

### 坐标算法（环形航线）

```
中心 C = (800, 520)
航线椭圆：rx = 480，ry = 260
第 i 站（i = 0..N-1，N 为地标数）：
  θ = -90° + i * 360° / N        （从正上方开始，顺时针）
  x = 800 + 480 * cos θ
  y = 520 + 260 * sin θ
标签落在航线外侧：沿同一 θ 方向再推 110px
  lx = 800 + (480 + 110) * cos θ
  ly = 520 + (260 + 90) * sin θ
label 对齐：cos θ > 0.2 → text-anchor="start"；cos θ < -0.2 → "end"；否则 "middle"
```

**关键构件**

```svg
<!-- 航线（主色虚线，起点断口留出船锚位） -->
<ellipse cx="800" cy="520" rx="480" ry="260" fill="none" stroke="#4b3fe3"
         stroke-width="3.5" stroke-dasharray="16 14" stroke-linecap="round" transform="rotate(-4 800 520)"/>

<!-- 终点 ✕ 标记 -->
<g transform="translate(800,260)">
  <path d="M-22 -22 L22 22 M22 -22 L-22 22" stroke="#C4553B" stroke-width="7" stroke-linecap="round"/>
  <text x="0" y="-46" font-size="22" font-weight="700" fill="#C4553B" text-anchor="middle"
        font-family="'Kaiti SC','STKaiti',cursive">目标达成</text>
</g>

<!-- 起点船锚 -->
<g transform="translate(800,780) scale(1.4)" fill="none" stroke="#2E2A25" stroke-width="3.5"
   stroke-linecap="round" stroke-linejoin="round">
  <line x1="0" y1="1" x2="0" y2="17"/><circle cx="0" cy="0" r="2.2"/>
  <path d="M-7 8 H7"/><path d="M-7 8 C-7 14 -4 16 0 16 C4 16 7 14 7 8"/>
</g>

<!-- 中心岛屿（叙事主题区） -->
<ellipse cx="800" cy="520" rx="210" ry="120" fill="#F2EDE4"
         stroke="#A8A196" stroke-width="3.5" transform="rotate(-2 800 520)"/>
```

> 中央岛屿是**主题区**（放地图标题 + 一句话核心结论）；地标一律在航线外侧，不压岛。

---

## T4 群岛式（知识地图 / 概念全貌 / 主题分组）

**形态**：每个分区 = 一座**岛屿**（不规则闭合曲线），岛内放地标，岛间用**桥 / 航线**连接。

### 坐标算法（2×2 或 2×3 网格）

```
2×3 网格：列宽 = 1398 / 3 = 466，行高 = 600 / 2 = 300
第 (r, c) 座岛（r=0,1；c=0,1,2）：
  中心 cx = 120 + 466 * c + 233
  中心 cy = 206 + 300 * r + 150
  岛：椭圆 rx = 190，ry = 118，rotate(-3 + 6 * 随机符号)
岛名：基线 cy - 68，字号 32，居中
岛内地标：≤ 3 个，纵向均分 → 基线 cy - 8 / cy + 26 / cy + 60，字号 18，居中
```

**岛屿构件（椭圆 + 微旋转，替代"完美圆"）**

```svg
<ellipse cx="353" cy="356" rx="190" ry="118" fill="#F2F7FF" stroke="#4b3fe3"
         stroke-width="3.5" stroke-opacity="0.5" transform="rotate(-3 353 356)"/>
```

**桥（岛间连接）**

```svg
<!-- 双线 + 横向枕木 -->
<path d="M543 356 Q640 336 753 356" fill="none" stroke="#2E2A25" stroke-width="3.5" stroke-linecap="round"/>
<path d="M543 372 Q640 352 753 372" fill="none" stroke="#2E2A25" stroke-width="3.5" stroke-linecap="round"/>
<g stroke="#A8A196" stroke-width="2" stroke-linecap="round">
  <line x1="588" y1="344" x2="588" y2="364"/><line x1="640" y1="341" x2="640" y2="361"/>
  <line x1="692" y1="344" x2="692" y2="364"/>
</g>
```

---

## T5 城市地图式（业务全景 / 系统关系）

**形态**：网格**街区**（淡色矩形块）+ **主干道**（宽白路 + 主色中线）+ **地标建筑**（塔 / 房子 / 城堡图标）。

### 坐标算法

```
街区网格：3 行 × 4 列，留出道路间距
  街区宽 = 300，高 = 170，横向间距 = 100（即道路），纵向间距 = 90
  街区 (r, c)：x = 120 + c * 400，y = 206 + r * 260
道路走"井"字：横 4 条（y = 176 + r*260 上侧）/ 竖 3 条（x = 420 + c*400）
地标建筑：贴在街区右下角，用 §5 图标库的 塔 / 房子 / 城堡
```

**街区 + 道路构件**

```svg
<!-- 街区 -->
<rect x="120" y="206" width="300" height="170" rx="12" fill="#F2EDE4"
      stroke="#E2DACE" stroke-width="1.5"/>
<text x="140" y="236" font-size="22" font-weight="600" fill="#2E2A25"
      font-family="'Kaiti SC','STKaiti',cursive">订单域</text>

<!-- 主干道（竖向） -->
<path d="M460 186 Q462 500 460 820" fill="none" stroke="#FFFFFF" stroke-width="34" stroke-linecap="round"/>
<path d="M460 186 Q462 500 460 820" fill="none" stroke="#4b3fe3" stroke-width="3.5"
      stroke-linecap="round" stroke-dasharray="18 14"/>
```

---

## 模板速查

| 模板 | 地标数 | 画布建议 | 必备构件 | 最怕 |
|---|---|---|---|---|
| T1 路径式 | 5–8 | 1600×1000 | 主干道 / 分区带 / 图例 / 指北针 | 地标标签互相压 |
| T2 时间线地图 | 5–8 | 1600×1000 | 主干道 + 时间轴 + 旗标 | 时间轴与图例抢位 |
| T3 藏宝图式 | 5–7 | 1200×1200 或 1600×1000 | 航线 / 起点终点标记 / 中心岛 | 环形标签出界 |
| T4 群岛式 | 4–6 岛（每岛 ≤3） | 1200×1200 | 岛屿 / 桥 / 岛名 | 岛间桥穿岛而过 |
| T5 城市地图式 | 6–12 | 1600×1000 | 街区 / 主干道 / 建筑图标 | 街区变"卡片网格"（退化成看板） |

> **T5 退化警告**：街区画成规整的圆角卡片阵列时，整张图会退化成「数据看板」而不是「地图」。
> 破解：街区大小**不等宽**（关键域更大）、道路**有弧度**、建筑图标**高低错落**、至少一条路**斜穿**。
