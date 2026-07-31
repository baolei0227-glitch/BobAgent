# BobAgent 版本发布记录

> 每次构建前请先在此文档记录变更，并确认版本号未与已发布版本重复。
> 构建命令：`pnpm package:release:both`
> 上传命令：通过 GitHub API 上传 DMG 和 latest-mac.yml 到对应 Release

---

## v0.50.1 (2026-07-31)

- 节点关系重构：横向连线 = child（子节点/上下文注入），纵向连线 = sibling（暂留，无上下文）
  - 移除拖拽自动转换 sibling→child 逻辑
  - fetchUpstreamContext 只收集 child 边
- 修复鼠标在对话框中显示小手图标（React Flow selectable cursor 覆盖）
- 修复选中文字后高亮丢失（mouseup 同步保存 Range，挂载后恢复）
- 修复复制按钮取不到文本（改用 selectedText prop 代替 Range.toString）
- 复制按钮移至工具栏第一位

---

## v0.50.0 (2026-07-31)

> 版本号重置，从此版本起算

- 更新通知集成到侧边栏齿轮图标：移除浮层进度条和弹窗
  - 检查中：齿轮左侧旋转图标
  - 下载中：齿轮左侧显示百分比
  - 下载完成：齿轮变为下载箭头图标
  - 设置菜单"检查更新"按钮承载全部状态信息

---

## v1.0.23 (2026-07-31)

- Skill 安装功能：SkillManagerModal 新增"安装"标签页，支持 GitHub URL / 本地路径导入
  - 安装到 ~/BobAgent/skills/，带"用户"标签，支持卸载
- 项目归档：支持将项目归档/取消归档，侧边栏分组显示活跃/归档项目
  - 归档确认弹窗显示节点数、数据库大小等统计信息
- TextEditPopup 批注修复：mark 标签 class 属性加入 DOMPurify 白名单，批注正常显示
- 新增 HtmlReader、MermaidRenderer 组件
- 扩展 API 路由：text/todo/vision-diag/workflows 等端点

---

## v1.0.22 (2026-07-31)

- 安全加固（5 项）
  - 读路径白名单：read_file / list_directory / search_files 限制在 sandbox/skills/projects 内
  - 附件路径防穿越：../ 穿越项目目录被拒绝
  - 危险命令拦截：rm -rf /、dd of=/dev/*、mkfs、sudo、curl|bash 等模式自动拒绝
  - settings.json API Key 加密：AES-256-GCM + 硬件指纹派生密钥，换机器无法解密
  - 工具执行审计日志：~/BobAgent/logs/tool-audit.log
- MCP 预置新增 Playwright、GitHub、Notion
  - 启用高风险 MCP 弹确认对话框，保存时二次确认
  - 新用户默认 7 个预置，老用户按 id 去重合并
- 更新体验
  - UpdateNotification 正式挂载（之前定义了但从未 import）
  - 下载完成自动弹模态对话框 + Release Notes
  - Sidebar 齿轮红点角标 + 设置菜单内红点
  - 清除更新缓存菜单项
- 系统通知（macOS 通知中心）
  - 对话出错 / 回答完成（窗口非前台）时弹通知

---

## v1.0.21 (2026-07-30)

- 完整 MCP (Model Context Protocol) 生态接入
  - 新增 src/lib/mcp/ 模块：单例客户端管理器，支持 stdio 和 streamable-http 两种传输
  - 预置 4 个推荐 MCP 服务器：Context7（远程，默认开）、Sequential Thinking（本地，默认开）、Brave Search（需 Key，默认关）、Filesystem（默认关）
  - MCP 工具名 mcp__<serverId>__<toolName> 命名空间隔离，不与内置工具冲突
  - 连接跨请求持久化复用，新对话自动 syncServers 同步配置
- 自定义 Tool/Function Calling：用户可在设置里注册 HTTP 工具（名称、描述、Endpoint、参数 Schema），AI 对话时自动调用
  - settings.ts 新增 CustomToolDef 接口和 updateCustomTools
  - tools.ts 新增 registerCustomTools，execute 通过 fetch 调用用户配置的 endpoint
- SettingsModal 新增 Custom Tools 和 MCP Servers 两个分区（Home 概览 + Add 完整编辑器）
- next.config.ts serverExternalPackages 新增 @modelcontextprotocol/sdk

---

## v1.0.20 (2026-07-30)

- HtmlReader 去段落化重写：改用 HtmlRenderer 一条通道统一渲染（1195→480 行，-60%）
  - 移除 splitSections / parseConversationRounds / 折叠编辑 / 逐段保存逻辑
  - 节点 .md 和文件树 .md 渲染逻辑完全统一
- HtmlRenderer 代码块复制按钮：hover 显示"复制"按钮，点击写入剪贴板
- 节点输入框仅在选中时显示（未选中只展示对话记录）
- FileViewer PDF 区域填满修复（flex-col 布局）
- HtmlReader 日志前缀修复（MarkdownReader → HtmlReader）

---

## v1.0.19 (2026-07-30)

- 修复 OCR 路径条件 bug：pageCount=0 时不进入 OCR，错误提示"视觉模型未配置"
  - 改为基于文本提取结果判断是否需要 OCR（两种方法均失败就尝试 OCR）
  - 不再依赖 pageCount 判断，避免提取器异常时跳过 OCR

---

## v1.0.18 (2026-07-30)

- /api/vision-diag 诊断端点，返回服务端实际读取的视觉配置和解析结果
- OCR 失败时输出详细视觉配置状态 JSON

---

## v1.0.17 (2026-07-30)

- Vision Bridge 自动处理图片附件，通过视觉模型转换为文字描述
- HtmlReader 折叠功能 + 面板右上角小按钮

---

## v1.0.16 (2026-07-30)

- 视觉模型 OCR 增加详细诊断日志（OCR-PDF + resolveVisionConfig 输出）

---

## v1.0.15 (2026-07-30)

- 视觉模型三级解析：主模型 → 辅助模型 → 从聊天模型自动匹配，不再推荐未安装模型
- SettingsModal 支持主/辅双视觉模型配置（Provider + Key + Model 选择）
- 图片读取硬编码兜底替换为 resolveVisionConfig，统一三级降级逻辑
- 表格溢出优化：.table-wrapper 独立横向滚动，不影响气泡
- 附件标签调小（图标、间距、字号全面缩减）
- 选中文字按钮组改为单圆角矩形 + 细竖杠分隔
- TextEditPopup 整体缩小（480→400px，720→560px）
- 折叠面板按钮移至右上角
- 节点仅标题栏可拖拽（Messages + Input 区添加 nodrag）
- 便签缩小态移入标题栏内，不再遮挡标题

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
