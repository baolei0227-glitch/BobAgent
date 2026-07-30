# BobAgent 版本发布记录

> 每次构建前请先在此文档记录变更，并确认版本号未与已发布版本重复。
> 构建命令：`pnpm package:release:both`
> 上传命令：通过 GitHub API 上传 DMG 和 latest-mac.yml 到对应 Release

---

## v1.0.14 (2026-07-30)

- HtmlRenderer 重写为 unified-renderer：基于 Unified.js 生态，支持 GFM、代码高亮、安全过滤
- 节点内 AI 回复改为显示完整内容 + Markdown 渲染（替换摘要卡片）
- 扫描件 PDF OCR 错误处理重写：每级降级记录失败原因，AI 不再拿到无意义错误
- 便签 textarea 选中文字修复：onPointerDown stopPropagation 阻止画布拖拽
- 清理旧版 CSS：移除 .code-block / .inline-code / .md-table 等废弃样式

---

## v1.0.13 (2026-07-30)

- 统一悬浮面板：所有文档标签页集中到右侧单一面板，支持拖拽和折叠
- read_attachment 工具描述补充 PDF 支持，修复扫描件 OCR 识别失败
- WANTED 任务归纳：移除 response_format json_object 兼容更多模型，增强 JSON 提取
- TextEditPopup 标题栏新增齿轮图标，预设提示词编辑器从设置移至弹窗内
- 便签编辑面板选中文字修复：移除 onPointerDown 阻止，恢复原生选择
- handleAskQuestion 提问按钮豁免 mousedown 清理，修复点击后选区丢失

---

## v1.0.12 (2026-07-30)

- HtmlReader 悬浮窗口：文档在画布上独立浮动，支持拖拽、折叠/展开
- 便签平滑展开/收缩动效：从图标位置缩放展开为完整编辑框
- 便签 textarea Enter 自动编号
- .md 渲染修复：引用（blockquote）和代码块解析
- handleAskQuestion 提级到系统层级，全局提取文字发送到活跃节点
- 节点名称仅首次生成时自动更新
- HtmlReader 折叠按钮改为 ChevronsRight，折叠画布悬浮区域

---

## v1.0.11 (2026-07-30)

- extEditPopup 和 handleAskQuestion 提级到系统层级
- 用户消息排版修复（whitespace-pre-line + min-w）
- 节点标题引用标签显示在输入框上方
- 节点名称限制仅首次生成时更新
- HtmlReader 通用 .md 模式支持

---

## v1.0.10 (2026-07-30)

- WANTED 去除独立折叠区块，直接嵌入侧边栏
- todo.md 按主题层级分类（最多三级），时间/地点为事项信息
- 选择文字默认单选，提示可全选，点击一键全选
- 选中文字添加到节点引用（通过自定义事件跨组件通信）
- 节点弹窗三指滑动不再触发画布拖拽

---

## v1.0.9 (2026-07-29)

- 节点复制按钮移到文字右下角，扩大触发区域
- 编辑/提问按钮提示简化
- WANTED 目录移至与 projects 同级
- 节点便签图标无内容时也可打开编辑
- HtmlReader 折叠按钮折叠整个页面

---

## v1.0.8 (2026-07-29)

- fix: FileViewer 支持 tabbed 模式，修复侧边栏文件无法在标签面板中打开
- fix: MarkdownReader 自动刷新，节点对话完成后实时更新文档内容
- .md 文档优化：去除 Notes，保留 Stick Notes 并自动编号
- 节点右上角显示便签图标，点击可查看/编辑
- 项目新增 homework 文件夹存放项目创建的文档

---

## v1.0.7 (2026-07-29)

- MarkdownReader 替换为 HtmlRenderer，AI 可直接输出 HTML 标签
- System prompt 更新：告知 AI 可使用 HTML/Markdown 排版
- 侧边栏文件与节点文档共用标签页面板，不再单独弹出
- 移除顶部 BOBAGENT 标题栏，保留上方无形拖拽区域
- WANTED 优化：执行后自动清空输入框，移除底部编号记录
- 日历：修复关闭按钮 z-index 被遮挡问题
- 日历底部新增今日待办事项列表（可点击切换状态）
- 新增 read_calendar 工具，AI 可通过节点查询日历待办
- 建立版本发布记录机制（RELEASES.md + 构建脚本版本冲突检查）

---

## v1.0.6 (2026-07-29)

- feat: 自动后台下载更新，下载完成后提示用户安装
- 启动时自动检查更新，静默处理错误
- 更新状态融合进侧边栏"检查更新"按钮，移除顶部浮窗通知
- 界面优化：顶部可拖拽窗口、日历按钮移至 WANTED 标题栏、WANTED 全部大写
- 更新 user-guide skill 为 BobAgent 当前程序指南

---

## v1.0.5 (2026-07-29)

- fix: 修复 WebkitAppRegion CSS 属性类型错误

---

## v1.0.4 (2026-07-29)

- feat: 启动后自动检查更新 + 弹窗通知

---

## v1.0.3 (2026-07-29)

- fix: FileViewer 二进制文件支持用系统默认程序打开
- Sidebar 版本号动态读取

---

## v1.0.2 (2026-07-29)

- fix: 修复私有仓库自动更新认证（token 注入 app-update.yml）

---

## v1.0.1 (2026-07-29)

- 优化 MarkdownReader 和 DMG 安装界面

---

## v1.0.0 (2026-07-29)

- 初始正式发布
- feat: Wanted 任务归纳优化
- 打包体积缩减 42%（874MB → 510MB）
