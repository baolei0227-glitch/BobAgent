---
title: Workflow Template Solution
created_at: 2026-07-30
status: draft
---

# Workflow Template Solution

## Overview

用户预定义一个"节点流水线"，保存为模板。需要时一键部署到画布，自动创建所有节点和连线。每个节点可预设：模型、思考强度、技能、工具、提示词、附件。

### Example Scenario

```
模板: "竞品分析报告"
├── [1] 信息收集 (模型: deepseek-v3, 技能: web-search, 附件: 竞品列表.xlsx)
│    提示词: "请收集 {{company}} 的公开信息..."
│    ↓
├── [2] SWOT分析 (模型: claude-4, 思考强度: high, 技能: consulting-analysis)
│    提示词: "基于上游分析结果，输出SWOT矩阵..."
│    ↓
└── [3] 报告撰写 (模型: gpt-4o, 技能: doc-page)
     提示词: "将以上分析整合为A4报告..."
```

---

## Data Structure

### Database Tables

在 `.project.db` 新增 `workflow_templates` 表：

```sql
CREATE TABLE IF NOT EXISTS workflow_templates (
  template_id  TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  category     TEXT DEFAULT '通用',
  steps_json   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wf_project
  ON workflow_templates(project_id);
```

### WorkflowStep Type

```typescript
interface WorkflowStep {
  order: number;                    // 步骤序号
  title: string;                    // 节点标题
  modelId?: string;                 // 指定模型（不填则用当前默认）
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  skills: string[];                 // 技能名称列表
  prompt: string;                   // 提示词模板（支持 {{变量}}）
  attachments?: string[];           // 附件路径（相对 materials/）
  tools?: string[];                 // 工具列表
  position: { x: number; y: number }; // 相对位置（自动计算）
}

interface WorkflowTemplate {
  template_id: string;
  project_id: string;
  name: string;
  description: string;
  category: string;
  steps: WorkflowStep[];
  created_at: string;
  updated_at: string;
}
```

### Variable System

提示词中支持 `{{变量名}}` 占位符，应用模板时由用户填入：

| Built-in Variable | Description |
|----------|------|
| `{{date}}` | 当前日期 |
| `{{project}}` | 当前项目名 |
| `{{upstream}}` | 上游节点的输出摘要（自动注入） |

用户可自定义任意变量，如 `{{company}}`、`{{industry}}`。

---

## File List

```
src/
├── lib/
│   ├── types.ts                       [+ WorkflowTemplate, WorkflowStep]
│   └── db/index.ts                    [+ workflow_templates 表 + CRUD 函数]
├── app/api/workflows/
│   ├── route.ts                       [GET 列表, POST 创建]
│   └── [template_id]/
│       ├── route.ts                   [GET 详情, PUT 更新, DELETE 删除]
│       └── apply/
│           └── route.ts               [POST 应用到画布]
└── components/canvas/
    ├── TemplatePanel.tsx              [Sidebar 中的模板列表]
    ├── TemplateEditor.tsx             [模板编辑器弹窗]
    └── TemplateApplyDialog.tsx        [变量输入 + 应用确认]
```

---

## API Design

### Template CRUD

| Method | Route | Request Body | Response |
|------|------|--------|------|
| `GET` | `/api/workflows?project_id=xxx` | - | `{ templates: WorkflowTemplate[] }` |
| `POST` | `/api/workflows` | `{ project_id, name, description, category, steps }` | `{ template: WorkflowTemplate }` |
| `GET` | `/api/workflows/:id` | - | `{ template: WorkflowTemplate }` |
| `PUT` | `/api/workflows/:id` | `{ name?, description?, category?, steps? }` | `{ template: WorkflowTemplate }` |
| `DELETE` | `/api/workflows/:id` | - | `{ success: true }` |

### Apply Template

**`POST /api/workflows/:id/apply`**

```json
// Request
{
  "project_id": "xxx",
  "variables": {
    "company": "字节跳动",
    "industry": "AI助手"
  },
  "base_position": { "x": 500, "y": 300 }  // 可选，模板放置位置
}

// Response
{
  "success": true,
  "nodes": [
    { "node_id": "uuid-1", "title": "信息收集", "position": { "x": 500, "y": 300 } },
    { "node_id": "uuid-2", "title": "SWOT分析", "position": { "x": 500, "y": 650 } },
    { "node_id": "uuid-3", "title": "报告撰写", "position": { "x": 500, "y": 1000 } }
  ],
  "edges": [
    { "edge_id": "edge-1", "from": "uuid-1", "to": "uuid-2" },
    { "edge_id": "edge-2", "from": "uuid-2", "to": "uuid-3" }
  ]
}
```

### Apply Core Logic

```typescript
async function applyTemplate(templateId, projectId, variables, basePos) {
  const template = await getTemplate(templateId);

  const nodeIds: string[] = [];
  const positions: { x: number; y: number }[] = [];

  // 1. 按顺序创建节点
  for (const step of template.steps) {
    // 变量替换
    const resolvedPrompt = replaceVariables(step.prompt, variables);

    // 创建 .md 文件 + 节点
    const { node_id } = await createNode({
      title: step.title,
      modelId: step.modelId,
      thinkingLevel: step.thinkingLevel,
      skills: step.skills,
      initialMessage: resolvedPrompt,
      projectId,
    });

    nodeIds.push(node_id);
    positions.push({
      x: basePos.x + step.position.x,
      y: basePos.y + step.position.y,
    });
  }

  // 2. 创建连线（step[0] → step[1] → step[2] ...）
  for (let i = 0; i < nodeIds.length - 1; i++) {
    await createEdge({
      project_id: projectId,
      from_node_id: nodeIds[i],
      to_node_id: nodeIds[i + 1],
      edge_type: 'vertical',
    });
  }

  return { node_ids: nodeIds, positions };
}
```

### New Functions in db/index.ts

```typescript
export function createWorkflowTemplate(db, data: CreateTemplateData): WorkflowTemplate;
export function getWorkflowTemplate(db, templateId: string): WorkflowTemplate | null;
export function listWorkflowTemplates(db, projectId: string): WorkflowTemplate[];
export function updateWorkflowTemplate(db, templateId: string, data: Partial<CreateTemplateData>): WorkflowTemplate;
export function deleteWorkflowTemplate(db, templateId: string): void;
```

---

## UI Design

### TemplatePanel (Sidebar Template List)

在 Sidebar 中 Wanted 面板下方新增 Templates 分区：

```
┌─ Templates ──────────────────┐
│  ┌─────────────────────────┐ │
│  │ 竞品分析报告        ►   │ │
│  │ 3 steps · 市场研究       │ │
│  └─────────────────────────┘ │
│  ┌─────────────────────────┐ │
│  │ 合同审查             ►   │ │
│  │ 2 steps · 法律           │ │
│  └─────────────────────────┘ │
│                              │
│  [+ Create Template]         │
└──────────────────────────────┘
```

- 点击模板卡片 → 弹出 Apply 对话框
- 点击 ► → 弹出 TemplateEditor
- 点击 + → 新建模板

### TemplateEditor (Template Editor Dialog)

```
┌─ Edit Template ─────────────────────────────┐
│  Name:        [竞品分析报告                 ]│
│  Description: [用于快速生成竞品分析          ]│
│  Category:    [市场研究            ▼]        │
│                                              │
│  ── Steps ────────────────────────────────── │
│  ┌ Step 1 ──────────────────────── [×] ───┐ │
│  │ Title:    [信息收集                     ]│ │
│  │ Model:    [deepseek-v3         ▼]       │ │
│  │ Thinking: [off ▼]                       │ │
│  │ Skills:   [✓] web-search  [ ] doc-page  │ │
│  │           [ ] 咨询分析    [ ] 法律起草   │ │
│  │ Tools:    [✓] web_search  [✓] file_read │ │
│  │ Prompt:                                 │ │
│  │ ┌──────────────────────────────────────┐│ │
│  │ │ 请收集 {{company}} 的以下信息：      ││ │
│  │ │ - 产品功能与定价                     ││ │
│  │ │ - 目标市场与份额                     ││ │
│  │ │ - 最近 6 个月动态                    ││ │
│  │ └──────────────────────────────────────┘│ │
│  └─────────────────────────────────────────┘ │
│  ┌ Step 2 ──────────────────────── [×] ───┐ │
│  │ ...                                     │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  [+ Add Step]                                │
│                                              │
│  [Delete]  [Save]  [Save & Apply]            │
└──────────────────────────────────────────────┘
```

### TemplateApplyDialog (Apply Confirmation)

```
┌─ Apply Template ───────────────────────────────┐
│  竞品分析报告                                   │
│  将创建 3 个节点，自动连线                       │
│                                                 │
│  Variables:                                     │
│  ┌─────────────────────────────────────────────┐│
│  │ {{company}}:  [字节跳动                     ]││
│  │ {{industry}}: [AI助手                       ]││
│  └─────────────────────────────────────────────┘│
│                                                 │
│  Preview:                                       │
│  ┌─────────────────────────────────────────────┐│
│  │ [1] 信息收集                                 ││
│  │     └→ 请收集 字节跳动 的以下信息：...       ││
│  │ [2] SWOT分析                                 ││
│  │     └→ 基于上游分析结果...                   ││
│  │ [3] 报告撰写                                 ││
│  │     └→ 将以上分析整合为...                   ││
│  └─────────────────────────────────────────────┘│
│                                                 │
│  [Cancel]  [Apply to Canvas]                    │
└─────────────────────────────────────────────────┘
```

---

## Phased Implementation

### Phase 1: Data Layer (1 day)

- [ ] `lib/types.ts` 添加 `WorkflowStep`、`WorkflowTemplate`、`CreateTemplateData` 类型
- [ ] `lib/db/index.ts` 添加 `workflow_templates` 建表逻辑
- [ ] 实现 6 个 CRUD 函数：`createWorkflowTemplate`、`getWorkflowTemplate`、`listWorkflowTemplates`、`updateWorkflowTemplate`、`deleteWorkflowTemplate`
- [ ] 数据库迁移逻辑（首次启动时自动建表）

### Phase 2: API Layer (1 day)

- [ ] `app/api/workflows/route.ts` — GET 列表 / POST 创建
- [ ] `app/api/workflows/[template_id]/route.ts` — GET PUT DELETE 单个
- [ ] `app/api/workflows/[template_id]/apply/route.ts` — POST 应用模板
  - 变量替换 `replaceVariables()`
  - 顺序创建节点（调用现有 `/api/nodes` 逻辑）
  - 顺序创建连线（调用现有 `/api/edges` 逻辑）
  - 自动布局（垂直排列，间距 350px）

### Phase 3: Template List (1 day)

- [ ] `TemplatePanel.tsx` — Sidebar 中的模板列表组件
  - 从 API 加载模板列表
  - 按分类过滤
  - 点击卡片触发 Apply 对话框
  - 长按/右键 → 编辑/删除
- [ ] 集成到 `Sidebar.tsx`（Wanted 面板下方）

### Phase 4: Template Editor (2 days)

- [ ] `TemplateEditor.tsx` — 弹窗组件
  - 基本信息编辑（名称、描述、分类）
  - 步骤列表（拖拽排序、添加/删除）
  - 每步配置：title、modelId、thinkingLevel、skills、prompt
  - 模型选择器（复用现有组件）
  - 技能多选（复用现有技能列表）
  - 提示词编辑（支持 {{变量}} 高亮）
  - 保存到 API

### Phase 5: Apply Template (1 day)

- [ ] `TemplateApplyDialog.tsx`
  - 扫描模板中的 `{{变量}}`，生成输入框
  - 变量替换后展示预览
  - 调用 `POST /api/workflows/[id]/apply`
  - 成功后调用 `onTemplateApplied(nodeIds)` 刷新画布
- [ ] CanvasFlow 集成：应用后自动 fitView + 选中新节点

### Phase 6: Save as Template (1 day)

- [ ] 选中多个节点 → 右键菜单 → "Save as Template"
- [ ] 从选中节点的 .md 文件中提取配置（modelId、skills 等）
- [ ] 弹出 TemplateEditor，预填从节点提取的信息
- [ ] 用户编辑后保存

---

## Key Technical Points

### 1. Variable Replacement

```typescript
function replaceVariables(prompt: string, variables: Record<string, string>): string {
  let result = prompt
    .replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\{\{project\}\}/g, variables.project || '');

  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}
```

### 2. Auto Layout

```typescript
function calculateLayout(steps: WorkflowStep[], baseX: number, baseY: number) {
  return steps.map((step, i) => ({
    ...step,
    position: {
      x: baseX,
      y: baseY + i * 350,  // 垂直间距 350px
    },
  }));
}
```

### 3. Node Creation Reuse

`apply` API 可直接调用 `lib/node-markdown.ts` 已有的 `createNodeMarkdown()` +
`writeNodeFile()` 函数，避免重复实现。

### 4. Edge Types

模板创建的连线使用 `'vertical'` 类型，表示流程上下游关系（区别于 `'parallel'` 同级关系）。

---

## Notes

1. **项目隔离**：模板存储按 `project_id` 隔离，不同项目的模板互不可见
2. **模型有效性**：应用模板时检查预设模型是否可用，不可用则降级为默认模型
3. **技能有效性**：应用时检查技能是否存在，不存在的跳过并提示
4. **附件处理**：模板中的附件路径是相对路径，应用时复制到目标项目的 `materials/`
5. **权限**：模板 CRUD 无额外权限控制，当前为单用户模式
6. **国际化**：UI 文案使用中文（与项目保持一致）
