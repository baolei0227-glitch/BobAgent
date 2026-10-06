# 项目上下文

### 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4

## 目录结构

```
├── public/                 # 静态资源
├── scripts/                # 构建与启动脚本
├── src/
│   ├── app/
│   │   ├── api/chat/route.ts  # SSE 流式 AI 对话 API
│   │   ├── globals.css        # 全局样式
│   │   ├── layout.tsx         # 根布局 (dark 模式)
│   │   └── page.tsx           # 主页 (CanvasFlow)
│   ├── components/
│   │   ├── canvas/
│   │   │   ├── ChatNodeKernel.tsx # AI 会话节点统一内核（所有 agent 共用）
│   │   │   ├── node-host.ts       # 单焦点宿主节点注入通道（NodeHostContext）
│   │   │   └── CanvasFlow.tsx     # 单焦点会话宿主（自绘画布层，无第三方画布库）
│   │   └── ui/                  # Shadcn UI 组件库
│   ├── hooks/                   # 自定义 Hooks
│   ├── lib/
│   │   ├── types.ts             # 共享类型定义
│   │   └── utils.ts             # 通用工具函数 (cn)
│   └── server.ts                # 自定义服务端入口
├── next.config.ts
├── package.json
└── tsconfig.json
```

### 核心依赖

- 画布: 宿主自绘（单焦点会话 + 世界层绝对定位）；关系图由 NodeMap（力导向自布局）承担
- `coze-coding-dev-sdk`: LLM SDK，用于后端 AI 流式对话
- `lucide-react`: 图标库

- 项目文件（如 app 目录、pages 目录、components 等）默认初始化到 `src/` 目录下。

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。
**常用命令**：
- 安装依赖：`pnpm add <package>`
- 安装开发依赖：`pnpm add -D <package>`
- 安装所有依赖：`pnpm install`
- 移除依赖：`pnpm remove <package>`

## 开发规范

### 编码规范

- 默认按 TypeScript `strict` 心智写代码；优先复用当前作用域已声明的变量、函数、类型和导入，禁止引用未声明标识符或拼错变量名。
- 禁止隐式 `any` 和 `as any`；函数参数、返回值、解构项、事件对象、`catch` 错误在使用前应有明确类型或先完成类型收窄，并清理未使用的变量和导入。

### next.config 配置规范

- 配置的路径不要写死绝对路径，必须使用 path.resolve(__dirname, ...)、import.meta.dirname 或 process.cwd() 动态拼接。

### Hydration 问题防范

1. 严禁在 JSX 渲染逻辑中直接使用 typeof window、Date.now()、Math.random() 等动态数据。**必须使用 'use client' 并配合 useEffect + useState 确保动态内容仅在客户端挂载后渲染**；同时严禁非法 HTML 嵌套（如 <p> 嵌套 <div>）。
2. **禁止使用 head 标签**，优先使用 metadata，详见文档：https://nextjs.org/docs/app/api-reference/functions/generate-metadata
   1. 三方 CSS、字体等资源可在 `globals.css` 中顶部通过 `@import` 引入或使用 next/font
   2. preload, preconnect, dns-prefetch 通过 ReactDOM 的 preload、preconnect、dns-prefetch 方法引入
   3. json-ld 可阅读 https://nextjs.org/docs/app/guides/json-ld

## UI 设计与组件规范 (UI & Styling Standards)

- 模板默认预装核心组件库 `shadcn/ui`，位于`src/components/ui/`目录下
- Next.js 项目**必须默认**采用 shadcn/ui 组件、风格和规范，**除非用户指定用其他的组件和规范。**

## 术语与命名（易混项）

- **两个「Bobby」同名不同物**（2026-10-06 起因：一次排障把两者混为一谈）：
  - **管家通知助理的显示名**：`NOTIFY_TITLE`（`src/lib/butler/storage.ts`），会话线程 `butler-notify`，
    落盘目录 `butler/Bobby/`，头像 `bell`；就是 Butler 抽屉里跟你对话的那个联系人。姓名被钉死
    （人设弹窗只让改性格/风格/称呼）。系统提示词里的「你是 Bobby」是同一件事。
  - **本地软件操控插件**：`src/app/api/bobby/route.ts`（观察 + 授权控制台）、画布 `BobbyNode`、
    `src/components/bobby/BobbyAuthHost.tsx`（授权弹窗 / 系统权限 / 急停）、MCP server id `bobby`
    （工具场景 `local`，见 `src/app/api/chat/tools/index.ts`）。
  - 只共享一个词：改任一处都不要顺手动另一处；grep `Bobby` 时先辨身份。
- **管家「身份」与「会话」是两层**：身份恒为 `identity='butler'`（市场包名 Butler）；一个身份下有多条
  会话（联系人），各自有 `persona`（`.state/threads/<threadId>.json`）：`butler-notify` / `butler-search`
  （小微）/ `butler-recorder`（Recorder）。说"管家"时先明确是哪条会话。
