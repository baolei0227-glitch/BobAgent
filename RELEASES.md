# BobAgent 版本发布记录

> 每次构建前请先在此文档记录变更，并确认版本号未与已发布版本重复。
> 构建命令：`pnpm package:release:both`
> 上传命令：通过 GitHub API 上传 DMG 和 latest-mac.yml 到对应 Release

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
