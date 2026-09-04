# ImageGen 智能定位编辑方案（Detect All Edit Design）

> 状态：**已落地**（VLM 全景识别 + 点击选中 + 内嵌 #chip + mask/坐标注入）
> 决策记录（用户确认）：只保留全景识别 **Detect All**（无需指令，一键扫描全部可编辑目标，上限 15）· 识别结果相互覆盖 · 原 Auto-Locate（按指令定位）已移除
> 关联模块：ImageGen 节点 / ImageAiEditor / /api/ai-edit/image / vision-adapter

---

## 1. 背景与目标

ImageGen 节点当前仅支持**手工绘制遮罩**（Rect / Brush / Eraser）来指定编辑区域。当用户指令包含位置指代（如「把背景换成夜晚」「去掉左边的人」「改掉招牌上的字」）时，用户必须自己判断并手动圈选目标区域，效率低且不精确。

**目标**：引入两阶段编辑——先用**视觉模型（VLM）全景识别图中全部可编辑目标并叠加可点击高亮框**，用户点击选中目标后**自动在输入框生成 #chip 引用**，再让**生图模型只重绘所选区域**，替代手工圈选流程，提升定位精度与可控性。

---

## 2. 整体架构

```
当前图
   │
   ▼ ① VLM 全景检测（新增 API，复用 Vision Model 配置，无需指令）
   │   输出结构化坐标 [{ object, attributes, bbox:[x1,y1,x2,y2], confidence }]，最多 15 个，显著性降序
   ▼ ② 规则一：bbox 面积 < 原图 1% 时自动外扩
   ▼ ③ 用户点击高亮框选中 → 输入框生成 #chip 引用
   ▼ ④ 规则二：object/attributes 拼入 instruction 增强
   ▼ ⑤ 生图模型局部编辑（复用 /api/ai-edit/image）
   │     有 mask 通道模型：body.mask（bbox 合成）
   │     doubao 无 mask 通道：body.regions 坐标注入 prompt
   ▼ ⑥ 结果回填：Album 版本记录 + 自动保存 homework/Image
```

| 环节 | 类型 | 说明 |
|---|---|---|
| ① VLM 全景检测 | **新增** | 复用 `settings.vision` 配置 + 全景识别 prompt（无指令） |
| ② 最小区域外扩 | **新增** | 服务端 bbox 校验与膨胀 |
| ③ 点击选中 → #chip | **新增** | 图上点击高亮框 = 选中，输入框自动追加内嵌 chip |
| ④ Prompt 语义补充 | **新增** | object/attributes 拼入生图 instruction |
| ⑤ 生图模型局部编辑 | **复用** | `/api/ai-edit/image`：mask 通道 + doubao 坐标注入 |
| ⑥ 结果回填 | **复用** | Album 版本 + 自动保存 homework/Image |

---

## 3. 关键设计决策

### 3.1 VLM 通道：复用现有 vision-adapter + buildVisionCandidates

- 复用 `settings.vision`（当前已配置 glm-4.6v-flash），**零新增配置项**
- 天然获得 failover：主视觉模型失败 → 自动尝试聊天池内视觉模型（见 `buildVisionCandidates`，tools.ts）
- 新增**定位专用 prompt**（与现有 `VISION_PROMPTS` 并列），要求输出严格 JSON bbox

### 3.2 Mask 生成方式：bbox → canvas 绘制（选定）

| 方案 | 说明 | 结论 |
|---|---|---|
| A. bbox 坐标 → 画 mask | glm-4.6v-flash 可输出坐标，服务端画 PNG，与现有 mask 语义完全兼容 | ✅ 选定 |
| B. VLM 直接出分割图 | 更精确但 glm-4.6v-flash 不支持，需换模型 | 暂不选 |

### 3.3 触发方式：Detect All 按钮（已确认，唯一入口）

- 编辑器工具栏新增 **Detect All 按钮**（ScanSearch 图标），**无需输入指令**，随时可点
- 点击 → 调 VLM 全景识别 → 原图叠加**全部可编辑目标的高亮框**（细线半透明，hover 弹出标签）
- 识别结果**相互覆盖**：再次 Detect All 会替换当前 regions 数据集
- 用户可**点击选中 / 删除单个区域 / 一键清除**，满意后再生成
- 绝不静默执行——用户点击选中后才会把区域纳入编辑，避免 VLM 识别错误直接产出错误结果

### 3.4 区域选择：hover 弹出标签 + 点击插入内嵌 #chip（已确认）

VLM 识别后，图上叠加**可点击高亮框（无常显标签）**；鼠标悬停高亮框时**弹出标签气泡**显示区域信息；点击高亮框在输入框光标处插入**内嵌 #chip 标签**（仿飞书/微博 @提及，可夹在文字中间）：

```
VLM 识别 → 图上叠加可点击高亮框（无标签）
鼠标悬停「car」高亮框 → 弹出标签气泡：#car · 40×40 · 0.92（移开即消失）
点击「car」高亮框 → 变为选中态（实线高亮）→ 输入框光标处插入内嵌 chip [#car]
再点「background」→ 光标处插入 [#background]
继续输入：请帮我将 [#car] 替换为 Bycycle，同时将 [#background] 更换为荒无人烟的沙漠
生成 → 解析内嵌 chip 的 region id → 对应 bbox 合成 mask → 生图模型仅重绘引用区域
```

- **hover 弹出标签**：鼠标悬停高亮框时弹出气泡（区域名 `#label`、bbox 尺寸、confidence），移开即消失——避免常显标签遮挡图片
- **点击插入内嵌 chip**：点击高亮框 = 选中该区域（实线高亮态）→ 输入框光标处插入可点击的 `#car` chip（内嵌在文本流中）；再次点击同一区域 = 取消选中并移除对应 chip（toggle 语义，双向同步）
- **chip 可删除**：点击 chip 上的 × 或 Backspace → 移除引用；文本流中的 chip 与图上高亮框选中态双向一致
- **# 与 @ 分工**：`#xx` = 识别区域引用（→ 合成 mask）；`@xx` = 附件图片引用（→ references）。两种可混合使用
- **多区域可混用**：可同时插入多个 chip（如「把 [#car] 和 [#background] 调暗」）
- **无弹窗依赖**：选择发生在图片上，不经过 mention 弹窗，交互更直观（所见即所得）

### 3.5 降级策略（三层兜底）

| 场景 | 处理 |
|---|---|
| VLM 未配置 / 调用失败 | 跳过识别，直接整图编辑（等同现状），提示用户配置视觉模型 |
| VLM 返回坐标无效 / 超出边界 | 同上，整图编辑 |
| 无显著可编辑目标（regions 为空） | 前端提示「无目标 → 整图编辑」 |
| 生图模型不支持 mask（doubao SeedEdit 走 i2i 无 mask 通道） | 坐标转注入 prompt（`body.regions` → `applyRegionBoxes` 已实现），提示模型按坐标区域操作 |

---

## 4. 两条补充规则（VLM 定位质量保障）

### 4.1 规则一：最小区域外扩（环节 ②）

**背景**：mask 透明区域是生图模型唯一允许改动的像素集合。区域过小时存在三方面问题：

1. **编辑信息不足 → 重绘细节丢失**：区域过小（如 30×30 像素），模型能生成的有效细节极少，重绘结果模糊失真
2. **边缘羽化 → 编辑范围漂移**：多数 edits 模型对 mask 边缘做羽化，小 mask 的羽化带占比大，实际重绘范围会膨胀到区域外
3. **VLM 定位误差被相对放大**：bbox 像素误差是绝对的，目标越小误差占比越大，切错目标风险越高

**规则**：服务端在 VLM 返回 bbox 之后、绘制 mask 之前增加校验：

```
bbox 面积 < 原图面积 × 1% 时：
    → 按 bbox 宽高的 20~30% 向四周外扩 padding
    → 外扩后仍受图片边界裁剪，且记录 original bbox 供前端展示

示例：原图 1024×1024，bbox [500, 500, 540, 540]（40×40 = 0.15%）
    → 外扩 30% → [492, 492, 548, 548]（56×56）
```

前端高亮框仍显示 VLM 原始 bbox，实际生效 mask 为外扩后区域——用户看到高亮框即可感知实际编辑范围。

### 4.2 规则二：Prompt 语义补充（环节 ① + ④）

**背景**：mask 区域小 → 生图模型在该区域内可用信息少，仅靠坐标不足以理解「在画什么」。

**VLM 定位 prompt 升级**（vision-adapter 新增 `locate` 模式）——要求输出结构化描述而非裸坐标：

```json
{
  "regions": [
    {
      "object": "red vintage car",
      "attributes": "red body, chrome bumper",
      "bbox": [120, 340, 420, 620],
      "confidence": 0.9
    }
  ]
}
```

**生图 prompt 组装**（locate 成功后，传给 /api/ai-edit/image 的 instruction 自动增强）：

```
原始指令：把车换成蓝色
增强后：把车换成蓝色。目标区域内的对象：red vintage car（red body, chrome bumper）
```

---

## 5. 前端交互设计（ImageAiEditor.tsx + ImageGenPromptBar.tsx）

### 5.1 编辑器工具栏（ImageAiEditor）

Rect / Brush / Eraser 旁新增：

- **Auto-Locate 按钮**（Sparkles 图标）：请求 VLM 定位
- 定位结果以**可编辑高亮框**叠加在图上（每个 region 一个框 + 物体标签）
- 高亮框可**拖动 / 缩放 / 删除**，用户可微调或重新定位
- **过小警告**：高亮框面积过小时提示「区域过小，建议扩大」，引导用户确认

坐标换算需注意：前端图片有缩放（`object-fit: contain`），需按自然尺寸比例换算，与现有 `buildMask` 的 `sx/sy` 换算逻辑一致。

### 5.2 区域 hover 标签 + 内嵌 #chip 输入框（ImageAiEditor + ImageGenPromptBar，核心新增）

**数据模型**：新增 `RegionRef` 类型，与 `AttachmentImage` 并列：

```ts
interface RegionRef {
  id: string;          // 如 'region-car-xxx'
  label: string;       // 如 'car'（# chip 显示名）
  object: string;      // VLM 完整描述：'red vintage car'
  attributes: string;  // 特征描述
  bbox: [number, number, number, number]; // 自然尺寸坐标
  confidence: number;
}
```

**识别结果持久化**：

- `regions` 存入节点数据（`ImageGenNodeData.regions`），随节点**自动持久化**（与 prompt / versions 同机制）——切换节点、刷新、重启后识别框仍在，**无需重复识别**
- 同时记录图片标识 `regionsImageKey`（识别时对应的图片）：图片变化（新生成 / 切换 Album 版本 / 上传新图）时，旧识别结果**自动清除**（坐标已不匹配新图），需重新 Auto-Locate

**可点击高亮框 + hover 标签（编辑器内）**：

- VLM 定位结果以**可点击高亮框**叠加在图上（半透明框，**无常显标签**，避免遮挡图片）
- **hover 弹出标签**：鼠标悬停高亮框 → 弹出气泡显示 `#label · W×H · confidence`，移开即消失
- **点击选中**：点击高亮框 → 选中态（实线高亮 + 高亮色边框）；再次点击 → 取消选中（toggle）
- 选中/取消通过回调上报 Prompt Bar：`onRegionsChange(selected: RegionRef[])`

**内嵌 #chip 输入框（Prompt Bar，输入框升级）**：

- 输入框从 textarea 升级为 **contentEditable 富文本**（仿飞书/微博 @提及），#car 以**可点击 chip** 内嵌在文本流中，可夹在文字中间（如「请帮我将 [#car] 替换为 Bycycle」）
- **插入**：点击图上高亮框 → 光标处插入 `<span data-region="region-car-xxx">#car</span>` chip
- **删除**：点击 chip 上的 × 或 Backspace → 移除 chip 并同步取消图上选中态
- **视觉**：chip 使用品牌色胶囊样式（高亮背景 + 圆角 + 文字），与普通文本明显区分
- **IME 兼容**：contentEditable 需处理中文输入法 composition 事件（沿用现有 `isComposingRef` 方案），避免输入中断

**chip 解析（生成时）**：

- 从 contentEditable DOM 中收集所有 `[data-region]` chip → 得到 `refRegionIds`（而非从文本正则解析——chip 是结构化元素，无需解析 # 语法）
- 文本自然语言部分描述「怎么改」，chip 对应的 region bbox 合成 mask
- 删除 chip（DOM 移除）→ 同步移除该区域引用（DOM ↔ refRegionIds 双向一致）

**# 与 @ 分工**：

```
#xx chip = 识别区域引用 → 合成 mask（编辑区域）
@xx      = 附件图片引用 → references（参考风格/内容）
两种可混合使用：请帮我将 [#car] 替换为 Bycycle，风格参考 @photo1
```

**生成时数据流**：

```
contentEditable DOM → 收集 [data-region] chip → refRegionIds → 对应 RegionRef 的 bbox 列表
  → 合成 mask（服务端或前端 canvas，透明=编辑区）
  → 传入 /api/ai-edit/image body.mask（复用现有通道）
```

`ImageGenPromptCtx` 增加 `regions?: RegionRef[]`，`ImageGenApiRef.runGenerate` 内部把引用的 region bbox 合成为 mask。

---

## 6. 后端 API 设计

### 新增 `POST /api/imagegen/detect-all`（原 /api/imagegen/locate 改造）

```json
// 请求（无需指令）
{
  "image": "data:image/png;base64,...",
  "width": 1024,
  "height": 1024
}

// 响应
{
  "success": true,
  "regions": [
    { "object": "background", "attributes": "...", "bbox": [0, 0, 1024, 400], "confidence": 0.92 }
  ],
  "model": "glm-4.6v-flash"
}
```

实现要点：

- 复用 `resolveVisionConfig()` 取视觉模型
- 调用 `describeImage()`（`detectAll` 模式 prompt：无指令、覆盖人物/物体/文字块/背景区域、最多 15 个、显著性降序、要求 JSON 输出）
- **规则一**：校验坐标范围 + 最小区域外扩
- 异常返回 `success: false`（VLM 未配置 / 解析失败 / 坐标非法）

---

## 7. 文件改动清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `src/app/api/imagegen/detect-all/route.ts` | 新增 | VLM 全景识别 API（无指令、上限 15、含规则一外扩）；原 locate/route.ts 已删除 |
| `src/lib/parse/vision-adapter.ts` | 修改 | `locate` 模式 → `detectAll` 模式 prompt（全景检测，结构化 bbox 输出） |
| `src/lib/parse/types.ts` | 修改 | `ParseMode` 增加 `detectAll` |
| `src/components/canvas/viewers/ImageAiEditor.tsx` | 修改 | Detect All 按钮 + 可点击高亮框 + hover 标签气泡 + 点击选中/toggle + `body.regions` 坐标下发（doubao 注入用） |
| `src/components/canvas/ImageGenNode.tsx` | 修改 | `handleDetectAll`（无指令校验）+ regions/regionsImageKey 持久化 + 图片变化失效 |
| `src/components/canvas/ImageGenPromptBar.tsx` | 修改 | 输入框 textarea → contentEditable 富文本 + 内嵌 #chip 插入/删除 + DOM↔regionId 双向同步 |
| `src/app/api/ai-edit/image/route.ts` | 修改 | 规则二 instruction 增强 + `regions` 字段 + doubao `applyRegionBoxes` 坐标注入 |

---

## 8. 风险与边界

1. **glm-4.6v-flash 是轻量模型**：bbox 输出可能不够精确（尤其「左边第二个人」这类复杂指代）——已通过「点击选中确认」模式兜底
2. **多目标指代**：VLM 可能返回多个 region，UI 通过点击高亮框逐个选中（点击即选中）
3. **坐标比例**：前端 `object-fit: contain` 缩放需按自然尺寸换算（与 buildMask 的 sx/sy 一致）
4. **doubao 无 mask 通道**：坐标注入 prompt 模板已实现（`applyRegionBoxes`，后端 doubao 分支）
5. **极小目标**：规则一外扩解决；外扩后仍小于最小可编辑像素时提示用户
6. **高亮框遮挡**：多个高亮框密集时可能互相遮挡——高亮框半透明 + hover 放大标签，点击命中按 z-order 最上层优先
7. **contentEditable IME 风险**：输入框改造为富文本后，中文输入法 composition 事件需沿用 `isComposingRef` 方案严格处理，防止输入中断/光标错位（项目已有 textarea IME 修复经验可复用）
8. **全景识别上限**：上限 15 个区域，超出部分按显著性截断；识别结果相互覆盖，避免多轮叠加混乱

---

## 9. Token 成本分析

**结论：不节省生图模型成本，反而增加一次 VLM 调用成本。** 方案价值在精度与可控性，不在省钱。

| 计费维度 | 无 mask 整图编辑 | 有 mask 局部编辑 |
|---|---|---|
| 输出图片尺寸 | 1024×1024 | 1024×1024（不变） |
| 文本 token | N | N + mask 参数（图片参数，几乎不占文本 token） |
| 生图成本 | 基准 | 基本相同 |
| VLM 定位调用 | 0 | +1 次视觉调用（新增成本） |

原因：图像编辑模型按**输出分辨率**计费，mask 只指示「重绘哪里」，输出画布仍是完整分辨率，局部编辑与整图编辑价格一致。

**唯一间接省钱场景**：用户反复生成多张直到满意时，精确 mask 一次命中率高，可减少失败重试次数。

---

## 10. 待落地清单

- [x] `src/app/api/imagegen/detect-all/route.ts`（无指令、上限 15、规则一外扩；原 locate 路由已删除）
- [x] `src/lib/parse/vision-adapter.ts` `locate` → `detectAll` prompt（全景检测）；`ParseMode` 增加 `detectAll`
- [x] `ImageAiEditor.tsx` Detect All 按钮 + 可点击高亮框 + hover 标签气泡 + 点击选中 toggle + `body.regions` 坐标下发
- [x] `ImageGenPromptBar.tsx` 输入框 textarea → contentEditable 富文本 + 内嵌 #chip 插入/删除 + DOM↔regionId 双向同步 + IME 兼容
- [x] `ImageGenNode.tsx` handleDetectAll（无指令）+ handleToggleRegion / handleClearRegions + 图片变化失效（regionsImageKey）+ `types.ts` RegionRef / regions / selectedRegions
- [x] 规则二 instruction 增强接入（detectAll prompt 让 VLM 回传 object/attributes，前端生成时拼入指令）
- [x] doubao 无 mask 通道的坐标注入 prompt 模板（`/api/ai-edit/image` 新增 `regions` 字段，doubao 分支 `applyRegionBoxes` 将 bbox+语义注入 prompt）
- [x] Detect All API 端到端验证（隔离目录 + 本机 glm-4.6v-flash 实测返回 regions）
- [ ] 前端 UI 实操验证（点击高亮框 → #chip 引用 → 生成，多区域混选）
