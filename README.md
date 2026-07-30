# BobAgent

AI 知识画布桌面应用。基于 [Next.js 16](https://nextjs.org) + [React Flow](https://reactflow.dev) + [shadcn/ui](https://ui.shadcn.com) 构建。

## 核心概念

BobAgent 是一个**无限画布 + AI 对话节点**系统：
- 在可无限缩放、平移的画布上创建 AI 对话节点
- 节点之间用连线建立知识网络，上游节点的摘要自动注入下游上下文
- 每个节点独立配置 AI 模型、思考深度、技能
- 所有数据本地存储（`~/BobAgent/`），支持多项目管理

## 快速开始

### 安装依赖

```bash
pnpm install
```

### 启动开发服务器

```bash
pnpm dev
```

启动后在浏览器中打开 [http://localhost:3000](http://localhost:3000)。

### 构建生产版本

```bash
pnpm build
```

### 构建 Electron 桌面应用

```bash
cd scripts && bash build-electron.sh
```

## 项目结构

```
src/
├── app/                        # Next.js App Router
│   ├── api/                    # API 路由
│   │   ├── chat/              # AI 对话接口
│   │   ├── nodes/             # 节点 CRUD
│   │   ├── edges/             # 连线 CRUD
│   │   ├── projects/          # 项目管理（含归档）
│   │   ├── skills/            # 技能安装/管理
│   │   ├── text/              # 文本编辑/预设
│   │   ├── calendar/          # 日历事件
│   │   ├── materials/         # 素材文件管理
│   │   ├── attachments/       # 附件上传/解析
│   │   └── workflow/          # 工作流模板
│   ├── globals.css            # 全局样式
│   └── layout.tsx             # 根布局
├── components/
│   ├── canvas/                # 画布核心组件
│   │   ├── CanvasFlow.tsx     # 主画布（React Flow）
│   │   ├── AiChatNode.tsx     # AI 对话节点
│   │   ├── HtmlReader.tsx     # Markdown 阅读器
│   │   ├── HtmlRenderer.tsx   # HTML/Markdown 渲染器
│   │   ├── Sidebar.tsx        # 侧边栏（项目/文件/WANTED）
│   │   ├── CalendarPanel.tsx  # 日历面板
│   │   ├── TaskPanel.tsx      # WANTED 任务面板
│   │   ├── SettingsModal.tsx  # 设置面板
│   │   ├── SkillManagerModal.tsx # 技能管理器
│   │   ├── ProjectArchiveDialog.tsx # 项目归档确认
│   │   ├── TextEditPopup.tsx  # 文本编辑弹窗
│   │   ├── TextSelectionActions.tsx # 选中文字按钮组
│   │   ├── TemplateEditor.tsx # 工作流模板编辑器
│   │   └── TemplateApplyDialog.tsx # 模板应用对话框
│   └── ui/                    # shadcn/ui 基础组件
├── lib/                       # 核心库
│   ├── db/                    # SQLite 数据库操作
│   ├── node/                  # 节点工具
│   │   └── context-assembler.ts # 上游上下文注入
│   ├── edge/                  # 连线工具
│   │   └── cycle-detector.ts  # 循环检测
│   ├── mcp/                   # MCP 协议支持
│   │   ├── manager.ts         # MCP 客户端管理
│   │   └── types.ts           # MCP 类型定义（含7个预置）
│   ├── parse/                 # 附件解析
│   │   ├── vision-adapter.ts  # 视觉模型适配
│   │   ├── image-parser.ts    # 图片解析
│   │   └── cache.ts           # 解析缓存
│   ├── project/               # 项目管理
│   │   └── project-manager.ts # 项目 CRUD + 归档
│   ├── skills/                # 技能系统
│   ├── node-markdown.ts       # .md 文件读写
│   ├── settings.ts            # 设置管理
│   └── types.ts               # 核心类型定义
├── hooks/                     # React Hooks
├── electron/                  # Electron 主进程
└── scripts/                   # 构建/发布脚本
```

## 核心功能

### 画布交互
- 无限缩放/平移画布（仅空白区域触发，防误触机制）
- React Flow 节点拖拽、连线、框选
- 工作流模板的创建、保存与应用

### AI 对话
- 多供应商支持（DeepSeek / GLM / Moonshot / Qwen / OpenAI / Doubao）
- 流式回复 + 工具调用
- 视觉模型 Bridge（图片 → 文字描述）
- 自动模式 + 思考深度调节

### 节点关联
- 节点连线建立知识网络
- 上游上下文自动注入（拓扑排序，50000 字符上限）
- 循环检测 + 重复连线检测
- 边断开/删除（软删除 + 硬删除）

### 项目管理
- 多项目独立存储
- 项目归档/取消归档
- 活跃/归档分组显示
- Wi-Fi 欢迎引导

### 阅读与编辑
- Markdown 阅读器（摘要 / 对话记录 / 批注 / 便签）
- 文本选中后系统级编辑按钮（铅笔/发送/复制）
- TextEditPopup + 批注（mark 标签）
- HtmlRenderer 安全渲染（DOMPurify）

### MCP 集成
- 7 个预置 MCP 服务器：Filesystem / Brave Search / Context7 / Sequential Thinking / Playwright / GitHub / Notion
- 自定义 MCP 服务器管理
- 响应式流式 MCP 通信

### 其他
- 日历面板 + WANTED 任务总结
- 技能管理（安装/启用/禁用）
- 自定义工具注册
- Electron 桌面功能（自动更新、窗口拖拽）

## 技术栈

- **框架**: Next.js 16 (App Router)
- **画布**: @xyflow/react (React Flow)
- **UI**: shadcn/ui (Radix UI) + Tailwind CSS v4
- **数据库**: better-sqlite3
- **MCP**: @modelcontextprotocol/sdk
- **渲染**: DOMPurify + Mermaid
- **桌面**: Electron
- **包管理**: pnpm 9+

## 数据存储

所有数据在 `~/BobAgent/` 目录下，每个项目独立子文件夹：
- `nodes/` — .md 文件（frontmatter + 固定四段结构）
- `project.db` — SQLite（边、日历、会话）
- `materials/` — 项目素材
- `assets/` — 节点附件

## 发布

版本发布流程见 [RELEASES.md](./RELEASES.md)。构建前需：
1. 在 RELEASES.md 记录变更
2. 确保 package.json 版本号不与已发布版本重复
3. 运行 `scripts/package-release.sh` 生成 DMG
