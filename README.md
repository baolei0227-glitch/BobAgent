# BobWork

AI 会话工作台桌面应用。基于 [Next.js 16](https://nextjs.org) + [shadcn/ui](https://ui.shadcn.com) 构建（画布为宿主自绘的单焦点会话布局，不依赖第三方画布库）。

> **视觉规范**：唯一真源为 `THEME-GUIDE.md`（Purple 单一品牌色）。旧的暖色宣纸方案 `DESIGN.md` 已废弃，归档于 `docs/DESIGN.deprecated.md`。

## 核心概念

BobWork 是一个 **AI 会话工作台**（单焦点会话布局）：

- 左侧会话树管理多项目节点，同一时刻聚焦一个会话节点，以全宽阅读面板呈现
- 节点之间用连线建立知识网络（NodeMap 关系图管理），上游节点的摘要自动注入下游上下文
- 每个节点独立配置 AI 模型、思考深度、技能
- 所有数据本地存储（`~/BobWork/`），支持多项目管理

## 快速开始

### 安装依赖

```bash
pnpm install
```

### 启动开发服务器

```bash
pnpm dev
```

启动后在浏览器中打开 <http://localhost:3000>。

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
│   │   ├── CanvasFlow.tsx     # 单焦点会话宿主（自绘画布层）
│   │   ├── ChatNode.tsx       # AI 对话节点
│   │   ├── UnifiedViewer.tsx  # 统一文件/文档查看器
│   │   ├── HtmlRenderer.tsx   # HTML/Markdown 渲染器
│   │   ├── Sidebar.tsx        # 侧边栏（项目/文件/WANTED）
│   │   ├── CalendarPanel.tsx  # 日历面板
│   │   ├── UnifiedPalette.tsx # ⌘F 统一面板（文件搜索 + WANTED 指令）
│   │   ├── WantedNoticeCenter.tsx # WANTED 通知中心（收件箱）
│   │   ├── SettingsModal.tsx  # 设置面板
│   │   ├── SkillManagerModal.tsx # 技能管理器
│   │   ├── TemplateLibraryModal.tsx # 工作流模板库
│   │   └── TemplateFillDialog.tsx # 模板填充对话框
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

### 画布与会话

- 单焦点会话宿主（同一时刻一个研究节点），节点经 NodeMap 关系图连线/导航
- 每个会话节点以全宽阅读面板呈现，链式上下文自动注入下游
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

- 预置 MCP 服务器：Filesystem / Brave Search / Context7 / Sequential Thinking / GitHub / Notion
- 自定义 MCP 服务器管理（Streamable HTTP / stdio，含 Bearer token 鉴权）
- 响应式流式 MCP 通信
- 浏览器控制走独立 MCP server（bob-browser-mcp）：见下

#### 浏览器控制（bob-browser-mcp 独立 MCP Server）

浏览器控制能力不再内嵌在 BobWork，而是由独立包 [bob-browser-mcp](../browser-mcp) 以标准 MCP Server（Streamable HTTP）形式提供，任意 MCP 客户端（Trae / Claude Code / Cursor 等）均可接入并控制真实浏览器：

```
http://127.0.0.1:<bridge-port>/mcp?token=<bridge-token>
```

- 在 设置 → MCP Servers 面板把 bob-browser-mcp 配成普通 Streamable HTTP 服务器（URL + Bearer token）即可
- 对外暴露 53 个 `browser.*` 工具（tools/list 与 tools/call 走标准 MCP 协议）
- 安装浏览器扩展：启动 bob-browser-mcp 后打开其 `http://127.0.0.1:<port>/setup` 引导页（下载 zip → 加载扩展 → 复制 token → 连接）
- 体验层（Net 白名单、登录凭证弹窗、反幻觉校验）已迁移到独立包：扩展设置页 Net tab + `net.json` 配置

### 其他

- 日历面板 + WANTED 任务总结
- 技能管理（安装/启用/禁用）
- 自定义工具注册
- Electron 桌面功能（自动更新、窗口拖拽）

## 技术栈

- **框架**: Next.js 16 (App Router)
- **画布**: 宿主自绘（单焦点会话 + 世界层绝对定位，无第三方画布库）
- **UI**: shadcn/ui (Radix UI) + Tailwind CSS v4
- **数据库**: better-sqlite3
- **MCP**: @modelcontextprotocol/sdk
- **渲染**: DOMPurify + Mermaid
- **桌面**: Electron
- **包管理**: pnpm 9+

## 数据存储

所有数据在 `~/BobWork/` 目录下，每个项目独立子文件夹：

- `nodes/` — .md 文件（frontmatter + 固定四段结构）
- `.project.db` — SQLite（边、日历、会话，隐藏文件）
- `materials/` — 项目素材
- `assets/` — 节点附件

## 发布

版本发布流程见 [RELEASES.md](./RELEASES.md)。构建前需：

1. 在 RELEASES.md 记录变更
2. 确保 package.json 版本号不与已发布版本重复
3. 运行 `scripts/package-release.sh` 生成 DMG