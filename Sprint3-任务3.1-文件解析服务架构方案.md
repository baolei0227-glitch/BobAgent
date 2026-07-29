# AiCanvas 文件解析服务架构方案

## 任务编号
Sprint3-任务3.1：解析服务架构 + vision-adapter + 图片解析

## 背景
AiCanvas 项目，Next.js 16 + React 19 + TypeScript + Electron 43，AI 调用基于 openai SDK v6（已支持多模态模型）。已完成 Sprint1/2。

## 目标
搭建文件解析架构 + 【识图分离】vision-adapter 统一视觉通道 + 图片解析验证整条链路。

---

## 一、架构设计

### 1.1 三层分离架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Renderer (UI)                           │
│  ┌─────────────┐  ┌──────────────────────┐                 │
│  │ 测试页       │  │ 画布节点附件上传      │                 │
│  │ /parse-test │  │ (触发解析流程)        │                 │
│  └──────┬──────┘  └──────────┬───────────┘                 │
│         │                    │                              │
│         │ window.api.parse   │ window.api.parse            │
└─────────┼────────────────────┼─────────────────────────────┘
          │                    │
          ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                   Electron Main Process                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    IPC Handler                        │  │
│  │  - parse:image (参数校验 + 转发)                      │  │
│  │  - parse:get-cache (参数校验 + 转发)                  │  │
│  │  - parse:clear-cache (参数校验 + 转发)                │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              lib/parse/ (业务逻辑层)                  │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │  │ vision-adapter│  │ image-parser │  │ cache.ts   │  │  │
│  │  │ (纯函数，无   │  │ (文件读取    │  │ (hash缓存  │  │  │
│  │  │ 文件系统依赖) │  │ → base64→解析)│  │ 管理)      │  │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 各层职责

| 层级 | 职责 | 可测试性 |
|------|------|---------|
| **Renderer** | UI 交互、触发解析、展示结果 | E2E / 单元 |
| **IPC Handler** | 参数校验、错误处理、转发调用 | 集成测试 |
| **lib/parse/** | 业务逻辑：文件处理、模型调用、缓存 | 单元测试（纯函数） |

---

## 二、核心模块设计

### 2.1 lib/parse/types.ts

```typescript
/** 统一解析结果类型 */
export interface ParseResult {
  file_name: string;
  file_type: 'image' | 'pdf' | 'video';
  mime_type: string;
  extracted_text: string;
  page_count?: number;
  frame_count?: number;
  parse_method: 'vision' | 'text_extract' | 'frame_extract';
  parsed_at: string;
  stats?: {
    duration_ms: number;
    input_tokens: number;
    output_tokens: number;
  };
  file_hash: string;
}

/** Vision 配置 */
export interface VisionConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  mode: 'general' | 'document' | 'screenshot' | 'chart' | 'casual';
  custom_prompt?: string;
  detail_level?: 'auto' | 'low' | 'high';
}

/** Vision 调用结果 */
export interface VisionResult {
  description: string;
  success: boolean;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
}

/** 图片输入来源 */
export type ImageInput =
  | { type: 'base64'; data: string; mimeType: string }
  | { type: 'file'; path: string };

/** 缓存记录 */
export interface ParseCacheRecord {
  hash: string;
  result: ParseResult;
  cached_at: string;
}
```

### 2.2 lib/parse/vision-adapter.ts

**设计原则**：
- 只依赖 base64 和 config，不依赖任何文件系统或画布逻辑
- 统一封装多模型调用，上层无需关心具体 SDK
- 提供默认 prompt 库（参考 vision-bridge-guide.md）

**核心函数**：

```typescript
export async function describeImage(
  input: ImageInput,
  config: VisionConfig
): Promise<VisionResult>
```

**默认 Prompt 库**：

| mode | Prompt | 使用场景 |
|------|--------|---------|
| `general` | "请详细描述这张图片的内容。" | 通用图片描述 |
| `document` | "请识别并转录这张文档图片中的所有文字，保持原始格式。" | 文字识别/截图 |
| `screenshot` | "请描述这张截图中显示的内容，包括窗口、按钮、文字等UI元素。" | 界面截图分析 |
| `chart` | "请描述这张图表中展示的数据和趋势，包括坐标轴标签和数值。" | 图表分析 |
| `casual` | "请简单描述这张图片里有什么。" | 快速预览 |

**模型支持**：
- `gpt-4o`（默认）→ OpenAI SDK
- `claude-3.5-sonnet` → Anthropic SDK（后续扩展）
- `qwen-vl` → 阿里云通义 SDK（后续扩展）

### 2.3 lib/parse/image-parser.ts

**职责**：文件读取 → 计算 hash → 缓存查询 → 调用 vision-adapter → 写缓存 → 返回 ParseResult

**核心函数**：

```typescript
export async function parseImage(
  filePath: string,
  projectPath: string,
  config: VisionConfig
): Promise<ParseResult>
```

**处理流程**：
1. 读取图片文件 → 转换为 base64
2. 计算文件 hash（SHA-256）
3. 查询缓存 → 命中则直接返回
4. 未命中 → 调用 vision-adapter.describeImage()
5. 生成 ParseResult → 写入缓存 → 返回

### 2.4 lib/parse/cache.ts

**职责**：管理解析结果缓存，基于文件 hash 复用

**核心函数**：

```typescript
export async function getCache(hash: string, projectPath: string): Promise<ParseCacheRecord | null>
export async function setCache(hash: string, result: ParseResult, projectPath: string): Promise<void>
export async function clearCache(projectPath: string): Promise<void>
```

**存储方式**：在项目目录下新建 `.cache/parse/`，文件名格式：`{hash}.json`

### 2.5 lib/parse/attachments.ts

**职责**：附件文件复制、重名处理

**核心函数**：

```typescript
export async function copyAttachment(
  sourcePath: string,
  projectPath: string
): Promise<string>
```

**重名处理**：目标文件名重复时自动加序号，如 `image.png` → `image (1).png` → `image (2).png`

---

## 三、项目设置扩展

### 3.1 新增配置字段

在 `projects.json` 的项目配置中新增：

```typescript
interface ProjectConfig {
  // ... 现有字段
  analysis_model: string;   // 主分析模型，默认 'gpt-4o-mini'
  vision_model: string;     // 识图模型，默认 'gpt-4o'
}
```

### 3.2 视觉模型选择

在设置弹窗中新增「视觉模型」选择区域：
- 下拉框形式
- 从已配置的模型中筛选 `category === 'vision'` 的模型
- 默认值从项目配置读取

### 3.3 配置读写

在 [project-manager.ts](file:///Users/baolei/Desktop/AiCanvas/projects/src/lib/project/project-manager.ts) 中增加：
- `getProjectVisionModel(projectId)` → 返回当前视觉模型
- `setProjectVisionModel(projectId, modelId)` → 保存视觉模型配置

---

## 四、Electron IPC 通信

### 4.1 Preload 暴露接口

在 `preload.ts` 中暴露：

```typescript
contextBridge.exposeInMainWorld('api', {
  parse: {
    image: (filePath: string, mode?: VisionConfig['mode']) => 
      ipcRenderer.invoke('parse:image', filePath, mode),
    getCache: (hash: string) => ipcRenderer.invoke('parse:get-cache', hash),
    clearCache: () => ipcRenderer.invoke('parse:clear-cache'),
  },
});
```

### 4.2 Main Process Handler

在 `electron/main.ts` 中注册：

| Channel | 参数 | 返回 | 说明 |
|---------|------|------|------|
| `parse:image` | `filePath: string`, `mode?: string` | `ParseResult` | 解析图片 |
| `parse:get-cache` | `hash: string` | `ParseCacheRecord \| null` | 查询缓存 |
| `parse:clear-cache` | 无 | `void` | 清除缓存 |

---

## 五、测试页设计

### 5.1 路由位置

`src/app/parse-test/page.tsx`

### 5.2 功能

- 文件选择器（仅选图片）
- 解析按钮
- 结果展示区域（文本 + 元数据）
- 缓存命中提示
- 模式切换（general/document/screenshot/chart/casual）

### 5.3 交互流程

```
用户选图 → 点击解析 → IPC invoke('parse:image') → 展示 ParseResult
```

---

## 六、缓存机制

### 6.1 Hash 计算

使用 SHA-256 对文件内容计算 hash，确保相同文件生成相同 hash。

### 6.2 缓存结构

```
项目目录/
├── attachments/
│   └── {文件名}        # 复制后的附件文件
└── .cache/
    └── parse/
        └── {hash}.json # 缓存记录
```

### 6.3 缓存策略

- **读取时**：先查缓存，命中直接返回，不调 vision-adapter
- **写入时**：解析成功后立即写入缓存
- **清除时**：提供清除接口，用于调试或强制重新解析

---

## 七、与现有系统的集成

### 7.1 模型配置复用

复用现有的 `PROVIDER_PRESETS` 体系和模型获取 API（`/api/models`），视觉模型通过 `category === 'vision'` 识别。

### 7.2 与 read_attachment 的关系

- **并存，独立通道**：新解析架构服务于 IPC 主动解析（测试页、Markdown 阅读器），read_attachment 服务于 AI 工具调用
- 后续可考虑将 read_attachment 中的图片处理迁移到新架构

### 7.3 与 Attachments API 的关系

现有 [attachments/route.ts](file:///Users/baolei/Desktop/AiCanvas/projects/src/app/api/attachments/route.ts) 处理文件上传到 `assets/`，新架构的附件存储在 `attachments/`，两者独立，按需选择。

---

## 八、开发顺序

### Phase 1：基础类型与 vision-adapter

1. 创建 `lib/parse/types.ts` — 定义 ParseResult、VisionConfig 等类型
2. 创建 `lib/parse/vision-adapter.ts` — 实现 describeImage 核心函数
3. 编写单元测试 — 验证 vision-adapter 的纯函数行为

### Phase 2：图片解析与缓存

4. 创建 `lib/parse/image-parser.ts` — 文件读取、hash 计算、缓存查询/写入
5. 创建 `lib/parse/cache.ts` — 缓存管理
6. 创建 `lib/parse/attachments.ts` — 文件复制、重名处理

### Phase 3：项目配置扩展

7. 修改 `project-manager.ts` — 增加 analysis_model / vision_model 字段及读写方法
8. 修改 `SettingsModal.tsx` — 增加视觉模型选择下拉框

### Phase 4：Electron IPC

9. 修改 `preload.ts` — 暴露 parse API
10. 修改 `electron/main.ts` — 注册 IPC handler

### Phase 5：测试页与验证

11. 创建 `src/app/parse-test/page.tsx` — 测试页
12. 构建应用并验证全链路

---

## 九、验收标准

| 序号 | 验收项 | 验证方法 |
|------|--------|---------|
| 1 | 含文字截图/照片能返回完整文本转录 | 在测试页上传截图，查看提取结果 |
| 2 | 同一图片第二次解析命中缓存，不调 vision-adapter | 连续解析同一张图片，第二次应快速返回，日志无 API 调用记录 |
| 3 | 图片文件被复制进 attachments/ | 检查项目目录下的 attachments/ 文件夹 |
| 4 | 项目设置中有两个独立模型选项 | 在设置弹窗中查看 analysis_model 和 vision_model |
| 5 | 改 vision_model 后解析走新模型 | 修改视觉模型配置，重新解析，验证调用的模型正确 |
| 6 | lib/parse/、vision-adapter.ts、IPC handler 三层分离可独立测试 | 分别运行各层单元测试 |

---

## 十、注意事项

1. **vision-adapter 纯函数原则**：不得依赖文件系统、数据库或画布逻辑，只接受 base64 和 config 参数
2. **Token 统计**：记录每次 vision 调用的 token 消耗，便于后续成本核算
3. **错误处理**：IPC handler 必须捕获所有异常并返回结构化错误，避免主进程崩溃
4. **性能优化**：大图先压缩再传 base64，避免内存溢出
5. **安全性**：IPC 参数校验必须严格，防止路径遍历攻击
6. **本任务不做 PDF/视频**：ParseResult 留好字段，但本任务只实现图片解析
