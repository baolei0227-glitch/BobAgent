/**
 * Agent 工具系统 — 服务端工具定义与执行器
 *
 * 基于 agent_tools.py (Python) 的设计理念，用 TypeScript 实现：
 *   - ToolRegistry：工具注册表，支持分类管理、动态注册
 *   - Tool：统一工具接口（schema + 执行函数 + 元数据）
 *   - executeTool：工具执行入口，返回结果 + 耗时 + 成功状态
 *
 * 流程：用户输入 → [思考] → [调用工具] → [执行] → [思考] → ... → 最终回答
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, rename, unlink, readdir, stat, mkdir } from 'fs/promises';
import { join, resolve, relative, isAbsolute, sep, basename } from 'path';
import { homedir } from 'os';
import { getCurrentProject } from '@/lib/project/project-manager';
import type { CustomToolDef } from '@/lib/settings';
import { mcpManager, sanitizeToolName } from '@/lib/mcp/manager';
import type { McpToolInfo } from '@/lib/mcp/types';
import type { OcrProgressEvent } from '@/lib/mcp/ocr-client';
import { resolveAppRoot, SANDBOX_DIRNAME, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';
import { cleanupMdAnnotationSidecars } from '@/lib/md-annotations-cleanup';
import { writeAppFileAtomic } from '@/lib/sandbox/apps';
import { recordPipInstall } from '@/lib/python/pkg-usage';
import { getProjectRootPath, getWorkspacePath, resolvePath, truncate, SANDBOX_APPS_DIR, READ_CAPACITY, formatSize, auditLog, isReadablePath, getLocalAuthorizedRoots } from './shared';
import { butlerToolDefs } from './butler';
import { ocrToolDefs } from './ocr';
import { officeToolDefs } from './office';
import { audioToolDefs } from './audio';
import { adminToolDefs } from './admin';
import { notebookToolDefs } from './notebook';
import { nodeToolDefs } from './node';
import { skillToolDefs, SKILLS_DIR } from './skill';
import { agentPackageToolDefs, setAgentCoreToolNames } from './agent-package';
import { designToolDefs } from './design';
import { registry, SCENED_TOOLS } from './registry';
import { webToolDefs } from './web';
import { attachmentToolDefs } from './attachment';
export type { CardItem } from './cards';
export { buildCardListHtml } from './cards';
export { getLocalAuthorizedRoots } from './shared';
const execAsync = promisify(exec);

/**
 * describeToolCall — 服务端在工具「开始执行」时生成一句该步在做什么的中文动作描述，
 * 随 tool_call SSE 事件下发（方案 B：不进模型上下文、不耗 token，仅供 UI 展示）。
 * 内置/常用工具按语义映射生成；未收录的工具回退为“执行 {工具名}”。
 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const n = name.toLowerCase();
  const displayName = (() => {
    const parts = name.replace(/^mcp__[^_]+__/, '').split(/[._]/);
    const tail = parts[parts.length - 1] || name;
    return tail.replace(/_/g, ' ');
  })();
  const take = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = (args ?? {})[k];
      if (v === undefined || v === null) continue;
      const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
      const t = s.trim();
      if (t && t !== 'undefined') return t.length > 40 ? `${t.slice(0, 40)}…` : t;
    }
    return null;
  };
  const path = () => take(['path', 'file_path', 'filepath', 'filename', 'file', 'output', 'output_path', 'source', 'src', 'image_path', 'pdf_path', 'folder', 'dir']);
  const query = () => take(['query', 'keywords', 'keyword', 'question']);
  const text = () => take(['text', 'content', 'title', 'name', 'prompt', 'input']);
  const url = () => take(['url', 'link', 'href', 'target_url', 'destination']);
  const selector = () => take(['selector', 'css_selector', 'element', 'target']);
  const keyVal = () => take(['key', 'key_name']);
  const has = (...subs: string[]) => subs.some((s) => n.includes(s));

  // 文件 / 编辑
  if (has('write_file', 'create_file', 'create_code')) return `写入 ${path() ?? name}`;
  if (has('edit_code')) return `修改 ${path() ?? ''}${(() => { const b = take(['begin_line', 'line_start']); return b ? `（第${b}行起）` : ''; })()}`;
  if (has('read_file', 'read_attachment', 'read_material')) return `读取 ${path() ?? text() ?? '内容'}`;
  if (has('delete_file')) return `删除 ${path() ?? ''}`;
  if (has('rename_file', 'move_file')) {
    const oldP = path();
    const newP = take(['new_path', 'new_name', 'dest', 'destination']);
    return newP ? `重命名 ${oldP ?? ''} → ${newP}` : `重命名文件`;
  }
  if (has('list_directory', 'list_dir', 'list_files')) return `浏览目录 ${path() ?? '工作区'}`;
  if (has('search_files', 'grep', 'find_file')) return `搜索文件 ${query() ?? path() ?? ''}`;

  // OCR / 图像
  if (has('ocr_document', 'ocr')) return `OCR 识别 ${path() ?? text() ?? '文件'}`;
  if (has('crop_image')) return `裁剪图片 ${path() ?? ''}`;

  // 命令 / 脚本 / 安装
  if (has('run_command', 'execute_script', 'bash', 'shell')) return `执行命令 ${text() ?? ''}`;
  if (has('install_')) return `安装 ${text() ?? '软件包'}`;

  // 网页搜索 / 抓取（不用裸 'search' 匹配，避免误伤 intern_search / search_capabilities 等专项工具）
  if (has('web_search', 'search_web', 'search_internet', 'search_documents')) return `搜索网页 ${query() ?? text() ?? ''}`;
  if (has('web_fetch', 'fetch_url', 'fetch_page', 'fetch')) return `读取网页 ${url() ?? ''}`;

  // 浏览器操作
  if (has('navigate')) return `打开网页 ${url() ?? ''}`;
  if (has('click')) return `点击 ${selector() ?? text() ?? '目标'}`;
  if (has('type', 'insert_text', 'input')) return `输入 ${text() ?? ''}`;
  if (has('fill_form', 'fill')) return `填写表单 ${selector() ?? ''}`;
  if (has('select_option', 'select')) return `选择 ${selector() ?? text() ?? '选项'}`;
  if (has('press_key', 'press')) return `按键 ${keyVal() ?? ''}`;
  if (has('scroll')) return `滚动页面${selector() ? `到 ${selector()}` : ''}`;
  if (has('screenshot', 'capture_sandbox_preview', 'capture_preview', 'capture')) return '渲染预览截图';
  if (has('extract_text', 'get_text', 'read_page')) return '提取页面文本';
  if (has('get_html')) return '获取页面 HTML';
  if (has('wait_for_text')) return `等待文本 ${text() ?? ''}`;
  if (has('upload_file')) return `上传文件 ${path() ?? ''}`;
  if (has('export_pdf')) return '导出 PDF';
  if (has('login')) return `登录 ${take(['site_name', 'site', 'url']) ?? '站点'}`;
  if (has('handle_dialog')) return '处理页面弹窗';
  if (has('resize_viewport')) return '调整浏览器视口';
  if (has('interact_preview')) return '浏览器交互测试';

  // 待办 / 日程 / 计划（butler）
  if (has('create_sticky_note')) return `创建待办：${text() ?? ''}`;
  if (has('create_scheduled_todo', 'create_todo')) return `排程：${text() ?? ''}`;
  if (has('todo_update')) return `更新待办/日程：${text() ?? ''}`;
  if (has('todo_delete')) return `删除待办/日程`;
  if (has('query_schedule')) return '查询日程';
  if (has('query_todos', 'read_todo')) return '查询待办';
  if (has('project_plan_start')) return `创建计划：${text() ?? ''}`;
  if (has('project_plan_add_steps')) return '追加计划步骤';
  if (has('project_plan_step_status')) return '更新计划步骤状态';
  if (has('project_plan_view')) return '查看计划';

  // 技能 / 上下文 / 系统
  if (has('load_skill')) return `加载技能 ${take(['skill_name', 'skill', 'name', 'id']) ?? ''}`;
  if (has('read_skill_resource')) {
    const skillN = take(['skill_name', 'skill', 'name']);
    const res = take(['resource', 'path', 'file']);
    return `读取技能资源 ${skillN ?? ''}${res ? `：${res}` : ''}`;
  }
  if (has('ask_user_questions')) {
    // 描述直接呈现本次要问的实质内容（不再带「向用户提问」前缀，避免与工具名重复翻译）
    const qs = Array.isArray((args ?? {}).questions) ? (args as { questions: unknown[] }).questions : null;
    if (qs && qs.length > 0) {
      const texts = qs
        .map((q) => (q && typeof q === 'object' ? String((q as Record<string, unknown>).question ?? '').trim() : ''))
        .filter(Boolean);
      if (texts.length > 0) {
        const head = texts[0].length > 40 ? `${texts[0].slice(0, 40)}…` : texts[0];
        return texts.length > 1 ? `${head}（共 ${texts.length} 项）` : head;
      }
    }
    return '向用户提问';
  }
  if (has('search_capabilities')) return `激活能力：${query() ?? text() ?? ''}`;
  if (has('todo_write')) return '更新任务步骤';
  if (has('finish_task')) return '任务收尾';
  if (has('read_upstream_node')) return `读取上游节点 ${text() ?? ''}`;
  if (has('intern_search')) return `检索上游内容：${query() ?? text() ?? ''}`;

  // 兜底
  const firstArg = (() => {
    const a = (args ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      const v = a[k];
      if (v === null || v === undefined) continue;
      const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return ''; } })();
      const t = s.trim();
      if (t && t !== '{}') return t.length > 24 ? `${t.slice(0, 24)}…` : t;
    }
    return null;
  })();
  return firstArg ? `执行 ${displayName}：${firstArg}` : `执行 ${displayName}`;
}


/** 从当前项目的 .local-roots.json 读取用户授权 AI 可写（可读写）的目录 */
async function getLocalWritableRoots(): Promise<string[]> {
  try {
    const project = await getCurrentProject();
    const rootsFile = join(project.path, '.local-roots.json');
    const fs = require('fs/promises');
    const content = await fs.readFile(rootsFile, 'utf-8');
    const config = JSON.parse(content);
    // 授权即读写：roots 即为可写范围；旧 writableRoots 字段兼容并入
    return Array.from(new Set<string>([...(config.roots || []), ...(config.writableRoots || [])]));
  } catch {
    return [];
  }
}

/** 检查路径是否在可写范围内（当前项目 homework/ 工作区 + 技能 + Bob Sandbox 小程序 + 用户授权可写目录） */
async function isWritablePath(resolvedPath: string): Promise<boolean> {
  const [ws, projectRoot] = await Promise.all([getWorkspacePath(), getProjectRootPath()]);
  const homework = join(projectRoot, 'homework');
  const sandboxApps = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');
  if ([ws, homework, SKILLS_DIR, sandboxApps].some(root => resolvedPath === root || resolvedPath.startsWith(root + sep))) {
    return true;
  }
  const writableRoots = await getLocalWritableRoots();
  return writableRoots.some(root => {
    const r = resolve(root);
    return resolvedPath === r || resolvedPath.startsWith(r + sep);
  });
}

/** 动态获取可写根路径描述字符串（用于错误提示） */
async function describeWritableRoots(): Promise<string> {
  const writableRoots = await getLocalWritableRoots();
  const base = '当前项目 homework/ 目录、~/BobWork/skills/、bob-sandbox/apps/（Bob Sandbox 小程序）';
  if (writableRoots.length === 0) return base;
  return `${base}，以及用户授权可写目录：${writableRoots.join('、')}`;
}

/** 动态获取可读根路径描述字符串（用于错误提示） */
async function describeReadableRoots(): Promise<string> {
  const localRoots = await getLocalAuthorizedRoots();
  const base = `BobWork 数据根 ${resolveAppRoot()}（skills/extensions/mcp/bob-sandbox/BobWorkspace 全部内容）及当前项目目录`;
  if (localRoots.length === 0) return base;
  return `${base}，以及用户授权目录：${localRoots.join('、')}`;
}

/** 生成"路径不在可读范围"的错误信息：除列出允许范围外，明确禁止 AI 继续猜测/遍历个人目录，
 *  这是阻断"逐个索要文稿/下载/桌面/相册授权"的关键。（审计日志由各调用处自行记录） */
async function readableError(inputPath: string, resolvedPath: string, opLabel = '读取'): Promise<string> {
  return `Error: 路径 "${inputPath}" 不在可读范围内。允许${opLabel}：${await describeReadableRoots()}
【规则】禁止猜测或遍历用户个人目录（如文稿/Documents、下载/Downloads、桌面/Desktop、相册/Pictures 等常见目录）来寻找文件，禁止对未授权目录反复尝试。若确认确实需要访问某个未授权的具体目录，可在回复末尾一次性声明 AUTH_REQ:/完整绝对路径（每行一条，用途在正文说明），前端会向用户展示授权请求卡片，用户批准后该目录即加入可读白名单；严禁对整个家目录/个人目录根/系统目录等超大范围发起，严禁逐个索要，严禁对无关目录发起。若用户未提供路径且当前无需访问，直接结束文件操作，向用户说明需要提供文件完整路径或放入项目目录后继续。`;
}

/** 危险命令模式：匹配即拦截（防止不可恢复的破坏性操作） */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  // 删根 / 删家目录 / 全盘递归删除
  /\brm\s+(-[rfRvfi]{2,}|--recursive|--force)\s+(\/|~|\/\*|~\*|\/\.\*|~\/\.\*)\b/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r[a-zA-Z]*|--[a-z-]*recursive[a-z-]*\s+--[a-z-]*force[a-z-]*)\s+(\/|~|\/home|\/Users|\/System|\/Library|\/private\/etc)\b/,
  /\brm\s+-[a-zA-Z]*[rfR][a-zA-Z]*\s+\/\s*$/,
  // 覆写磁盘 / 原始设备
  /\bdd\s+(if=|of=)\/dev\/(sd|hd|nvme|disk|rdisk|mem|kmem|random|urandom)\b/,
  // 格式化 / 擦除磁盘
  /\b(mkfs|newfs|fdisk|diskutil\s+erase|wipefs|blkdiscard|shred)\b/,
  // 关闭系统 / 杀所有进程
  /\b(shutdown|halt|poweroff|reboot|killall\s+(-[a-zA-Z]+\s+)?(init|launchd|systemd|Finder|Dock))\b/,
  // 直接 curl|bash 下载即执行（常见供应链攻击向量）
  /\b(curl|wget)\s+[^;&|`$()]*\|\s*(bash|sh|zsh|sudo|su)\b/,
  /\b(curl|wget)\s+[^;&|`$()]*>\s*\/tmp\/[A-Za-z0-9_.-]+\.(sh|py|rb|js)\s*;\s*(bash|sh|zsh|python|python3|node)\s+\/tmp\//,
  // 注入 sudo 提权（本地无 sudo 密码提示流程，直接失败即可）
  /\bsudo\s+(-S\s+)?(su|rm|chmod|chown|mount|umount|visudo|apt|yum|dnf|brew)\b/,
];

/** 对命令字符串做危险检查，返回 null=安全，字符串=拦截原因 */
function checkDangerousCommand(cmd: string): string | null {
  for (const re of DANGEROUS_COMMAND_PATTERNS) {
    if (re.test(cmd)) {
      return `匹配危险模式 ${re.toString()}`;
    }
  }
  return null;
}

// ============================================================
// 类型定义
// ============================================================

/** 工具分类 */
export type ToolCategory = '文件' | '系统' | '网络' | '技能' | '配置' | '记忆';

/** 工具场景标签：两层过滤的「第一层（静态按节点类型） + 第二层（动态按对话内容意图）」
 *  - general:   通用工具，任何节点/对话始终可用
 *  - coding:    AI Coding 节点（sandbox_app_id 小程序编程）才暴露
 *  - butler:   仅当对话内容涉及事务域（记忆/待办/笔记/偏好/工作报告/日历）才暴露
 *  - legal:     法律场景专用（法条检索/文书模板等），当前模型自动识别法律意图时暴露
 *  - node:      画布节点对话（nodeId 存在）才暴露——节点树/画布结构依赖工具（上游节点/祖先链/画布绘图）
 *  - audio:     对话涉及音频转写（转写/录音/语音关键词或音频附件）才暴露
 *  - skill:     对话涉及技能检索/安装（技能/能力/skill 关键词）才暴露
 *  - design:    对话涉及主题/前端界面（coding 节点自动放行）才暴露
 *  - ocr:       对话涉及图片/PDF 文字识别（OCR/扫描关键词或图片附件）才暴露 */
export type ToolScene = 'general' | 'coding' | 'legal' | 'node' | 'audio' | 'skill' | 'design' | 'ocr' | 'admin' | 'office' | 'browser' | 'company' | 'team' | 'local' | 'notebook' | 'butler';

/** OpenAI function calling 格式的工具定义 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 工具执行函数签名 */
type ToolExecutor = (args: Record<string, unknown>, ctx?: ToolExecContext) => Promise<string | EnhancedToolResult>;

/** 工具执行上下文（宿主传入，透传给工具执行器）：目前承载 OCR 过程级进度回调 */
export interface ToolExecContext {
  /** 识别过程级进度（read_attachment 扫描件/图片 OCR 走 MCP 时实时上报引擎/页码，宿主转 SSE 给前端） */
  onOcrProgress?: (p: OcrProgressEvent) => void;
}

/** 增强工具结果：给 LLM 的精简文本 + 给用户的结构化卡片 HTML（方案 B：数据驱动渲染，绕过 LLM 转述） */
export interface EnhancedToolResult {
  /** 返回给 LLM 的精简文本（保真关键字段，控制 token） */
  text: string;
  /** 宿主渲染的 ai-card 卡片 HTML（仅前端展示，不进模型上下文） */
  cardHtml: string;
}

/** 工具元数据 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: ToolCategory;
  /** 工具适用场景：默认 ['general']。仅当该场景被激活时才暴露给模型（两层过滤的核心） */
  scenes?: ToolScene[];
  execute: ToolExecutor;
  /** 最大输出长度（字符），默认 5000 */
  maxOutput: number;
  /** 执行超时（毫秒），仅对命令类工具有效 */
  timeoutMs?: number;
}

/** 工具执行结果 */
export interface ToolExecResult {
  result: string;
  durationMs: number;
  success: boolean;
  /** 方案 B：工具结果的结构化卡片 HTML（前端展示，不进 LLM 上下文） */
  cardHtml?: string;
}

/** MCP serverId → 适用场景映射（两层过滤的 MCP 动态标注）：
 *  - 未在此表中的 server = 按 server 名/工具名启发式兜底，无法判定 → ['general']（仅当 general 被激活时才暴露）
 *  - 每个 MCP 工具被注册时，会继承所属 server 的 scenes 标注，避免所有 MCP 全量注入导致 token 浪费
 *  - server 的场景粒度：通用型（如浏览器/GitHub/代码文档）标 general，领域型（如 OCR/法律）标专属场景
 */
const MCP_SERVER_SCENES: Record<string, ToolScene[]> = {
  // ---- 法律领域 ----
  'pkulaw': ['legal'],
  // ---- OCR / 视觉识别 ----
  'bob-ocr-mcp': ['ocr'],
  // ---- 音频转写 ----
  // （如有独立音频 MCP，标注 ['audio']）
  // ---- 浏览器（网页意图才注入，按需省上下文；browser 61 工具 ≈ 1.8 万 token，最大 MCP 开销）----
  'bob-browser-mcp': ['browser'],
  // ---- GitHub（编码专属：coding 节点查仓库/写代码才需要；普通对话不注入）----
  'github': ['coding'],
  // ---- Context7（编码专属：coding 节点查框架/库文档才需要；普通对话不注入）----
  'context7': ['coding'],
  // ---- Notion（记忆/知识）：butler 事务场景（记笔记/查笔记）才注入，不再常驻 ----
  'notion': ['butler'],
  // ---- 企业信息（查企业/工商/股权等企业意图才注入，不再常驻）----
  'tianyancha': ['company'],
  // ---- 飞书（日历/任务/文档 = butler 事务场景；不再作为 general 常驻）----
  'lark-feishu': ['butler'],
  'feishu': ['butler'],
  'lark': ['butler'],
  // ---- Bobby（本地软件操控 + AI 助手派发）：本地操控意图才注入（"操控/打开应用/本地软件"），不再常驻 ----
  'bobby': ['local'],
  // ---- Agent Teams（多成员团队编排）：团队/协作意图才注入，不再常驻 ----
  'team': ['team'],
  // ---- Bob Preview（真实 Chromium 预览渲染/交互测试）：前端/网页意图（design）与 coding 节点注入 ----
  'bob-preview-mcp': ['design', 'coding'],
  // ---- Bob-Mind（独立思维便签库）：通用捕获/回忆，随 general 常驻注入 ----
  'bob-mind-mcp': ['general'],
};

/** 按 MCP serverId/工具名推断适用场景（兜底：无法识别 → general） */
function inferMcpToolScenes(mcpTool: { serverId: string; serverName: string; name: string }): ToolScene[] {
  // 1) 静态映射优先
  if (MCP_SERVER_SCENES[mcpTool.serverId]) return MCP_SERVER_SCENES[mcpTool.serverId];
  // 2) server 名关键词启发式（用户自定义的 MCP，id 不在预置中）
  const low = `${mcpTool.serverId} ${mcpTool.serverName} ${mcpTool.name}`.toLowerCase();
  const scenes = new Set<ToolScene>();
  if (/legal|law|pkulaw|法条|法规|合同|律师|司法|诉讼|案由|罪名|司法解释/.test(low)) scenes.add('legal');
  if (/ocr|recognize|识别|扫描|vision|图像|图片|pdf|文字提取/.test(low)) scenes.add('ocr');
  if (/audio|transcrib|语音|录音|转写|字幕|听写/.test(low)) scenes.add('audio');
  if (/wanted|todo|notebook|calendar|remind|待办|笔记|日历|记忆|偏好|飞书|lark|feishu|notion/.test(low)) scenes.add('butler');
  if (/code|git|github|repo|sdk|context|程序|开发|前端|编程/.test(low)) scenes.add('coding');
  if (/design|theme|ui|界面|主题|样式|配色/.test(low)) scenes.add('design');
  if (/skill|技能/.test(low)) scenes.add('skill');
  // 若任何专属场景匹配 → 返回（不额外加 general，防止全量注入）
  if (scenes.size > 0) return Array.from(scenes);
  // 无法识别的 MCP → 返回空（不注入）：registerMcpTools 对空场景工具跳过注册，
  // 堵住"未知 MCP 全量注入"导致的 token 浪费。用户自定义 MCP 若需启用，可在配置中显式声明场景。
  return [];
}

// ============================================================
// 辅助函数
// ============================================================

/** bob-sandbox/apps/ 根目录（Bob Sandbox 小程序目录）— 定义见 shared.ts */

/**
 * 计算 filePath 相对 bob-sandbox/apps/<appId>/ 的 { appId, filename }。
 * 若路径不在小程序目录内返回 null。
 */
function sandboxAppTarget(filePath: string): { appId: string; filename: string } | null {
  try {
    const rel = relative(SANDBOX_APPS_DIR, filePath);
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') return null;
    const parts = rel.split(sep);
    if (parts.length < 2) return null; // 至少 <appId>/<filename>
    return { appId: parts[0], filename: parts.slice(1).join(sep) };
  } catch {
    return null;
  }
}

/** 读取工具参数中的 Coding 节点沙箱 appId（route.ts 工具循环注入 node_sandbox_app_id） */
function nodeSandboxAppId(args: Record<string, unknown>): string | undefined {
  const v = args.node_sandbox_app_id;
  return typeof v === 'string' && v ? v : undefined;
}

/** Coding 节点的 app 目录绝对路径（强制重定向 / 读取 fallback 用） */
function sandboxAppDir(appId: string): string {
  return join(SANDBOX_APPS_DIR, appId);
}

/**
 * Coding 节点兜底重定向的相对文件名：从原始路径提取，保留子目录结构。
 * - 剔除 homework/ 与 ./ 前缀（此类路径应落入小程序目录而非项目目录）
 * - 剥离 ../ 与 . 段防穿越（writeAppFileAtomic 另有二次穿越校验）
 * - 绝对路径（/ 开头或盘符）整条不可用，退化取文件名
 * - 限深 ≤4 段，防止异常路径生成过深目录
 */
function codingFallbackFilename(rawPath: string): string {
  let p = String(rawPath ?? '').replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return basename(p);
  p = p.split('/').filter((s) => s !== '..' && s !== '.').join('/');
  if (p.startsWith('homework/')) p = p.slice('homework/'.length);
  const parts = p.split('/').filter(Boolean);
  return parts.slice(0, 4).join('/');
}

/** 应跳过的目录名 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build',
  '.cache', '__pycache__', '.venv', 'venv', '.DS_Store',
]);

/**
 * glob 模式转正则 — 对应 Python 的 fnmatch 但更强大
 *
 * 支持：* (任意字符), ? (单字符), ** (递归目录)
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]?';
      i++;
    } else if ('.+^${}()|[]\\'.includes(c)) {
      regex += '\\' + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp('^' + regex + '$');
}

// ============================================================
// 工具实现
// ============================================================

// ----- homework/ 文件归属隔离 -----
// 每个节点只能读写自己在 homework/ 下创建的文件；其他节点的文件需通过 read_upstream_node 获取

/** 读取 homework/.ownership.json（映射：相对路径 → nodeId） */
async function readOwnershipManifest(projectRoot: string): Promise<Record<string, string>> {
  try {
    const manifestPath = join(projectRoot, 'homework', '.ownership.json');
    const raw = await readFile(manifestPath, 'utf-8');
    return JSON.parse(raw);
  } catch { return {}; }
}

/** 写入 homework/.ownership.json（合并更新）。
 *  原子写（临时文件 + rename）：多个并行节点同时写清册时，避免 read-modify-write
 *  互相覆盖而丢失条目（否则归属丢失会导致并行节点的输出串入他人卡片）。 */
async function writeOwnershipManifest(projectRoot: string, entries: Record<string, string>): Promise<void> {
  const manifestPath = join(projectRoot, 'homework', '.ownership.json');
  const existing = await readOwnershipManifest(projectRoot);
  const merged = { ...existing, ...entries };
  const tmpPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  await rename(tmpPath, manifestPath);
}

/** 判断路径是否在 homework/ 下（基于已解析的绝对路径） */
function isUnderHomework(resolvedPath: string, projectRoot: string): boolean {
  const homeworkDir = resolve(join(projectRoot, 'homework'));
  return resolvedPath === homeworkDir || resolvedPath.startsWith(homeworkDir + sep);
}

/** 获取文件相对 homework/ 的相对路径（不在 homework 下时返回 null） */
function getHomeworkRelativePath(resolvedPath: string, projectRoot: string): string | null {
  const homeworkDir = resolve(join(projectRoot, 'homework'));
  if (!isUnderHomework(resolvedPath, projectRoot)) return null;
  return resolvedPath.slice(homeworkDir.length + 1).replace(/\\/g, '/');
}

/**
 * Coding 节点兜底解析：目标文件已强制落 bob-sandbox/apps/<appId>/，旧路径不存在时查 app 目录同名文件。
 * 普通节点产物直接写 homework/ 根（归属靠 .ownership.json 清册追踪，无 per-node 目录重定向）。
 * 返回解析后的绝对路径；app 目录无同名文件时原样返回。
 */
async function resolvePathWithNodeFallback(inputPath: string, sandboxAppId?: string): Promise<string> {
  const resolved = await resolvePath(inputPath);
  if (sandboxAppId) {
    const appFile = join(sandboxAppDir(sandboxAppId), codingFallbackFilename(inputPath));
    const appExists = await stat(appFile).then(() => true).catch(() => false);
    if (appExists) return appFile;
  }
  return resolved;
}

/** 将 docx 内部 XML 转换为可读纯文本（保留段落换行、表格行/单元格分隔） */
function docxXmlToText(xml: string): string {
  let s = xml
    // 域代码（如目录 TOC 的 instrText）不展示文本，先剔除
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    // 特殊内联元素 → 可见字符
    .replace(/<w:tab[^>]*\/?>/g, '\t')
    .replace(/<w:br[^>]*\/?>/g, '\n')
    .replace(/<w:cr[^>]*\/?>/g, '\n')
    // 段落 / 表格行 / 单元格边界 → 换行与制表
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t');
  // 移除其余所有标签（<w:t> 等开闭标签删除，其内文本保留）
  s = s.replace(/<[^>]+>/g, '');
  // XML 实体解码
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00A0');
  // 清理：按行 trim、去连续空行
  const lines = s.split('\n').map((l) => l.replace(/[\t ]+$/g, '').replace(/^[\t ]+/, ''));
  const out: string[] = [];
  for (const l of lines) {
    if (l.trim() === '' && out.length > 0 && out[out.length - 1] === '') continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** 从 .docx 提取纯文本：解出 word/document.xml 及页眉/页脚，还原为可读文本。
 *  DOCX 本质是 zip 压缩包，read_file 若按 UTF-8 读取只会得到乱码，docx 必须走本函数。 */
async function extractDocxText(filePath: string): Promise<string> {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(filePath);
  const entryNames = zip.getEntries().map((e) => e.entryName);
  const xmlNames = [
    'word/document.xml',
    ...entryNames.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)),
  ];
  const parts: string[] = [];
  for (const name of xmlNames) {
    const entry = zip.getEntry(name);
    if (!entry) continue;
    const text = docxXmlToText(entry.getData().toString('utf-8'));
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

/** 读取文件内容 */
async function toolReadFile(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  if (!path) return 'Error: path required';

  try {
    let filePath = await resolvePath(path);
    if (!(await isReadablePath(filePath))) {
      auditLog({ tool: 'read_file', blocked: true, reason: 'readable-path', path, resolved: filePath });
      return await readableError(path, filePath, '读取');
    }
    // homework/ 文件归属隔离：仅允许文件创建节点读取
    const currentNodeId = args.current_node_id as string | undefined;
    if (currentNodeId) {
      const projectRoot = await getProjectRootPath();
      const relPath = getHomeworkRelativePath(filePath, projectRoot);
      if (relPath) {
        const manifest = await readOwnershipManifest(projectRoot);
        const ownerNodeId = manifest[relPath];
        // 有归属记录且不属于当前节点 → 拒绝读取
        if (ownerNodeId && ownerNodeId !== currentNodeId) {
          auditLog({ tool: 'read_file', blocked: true, reason: 'ownership', path, resolved: filePath, owner: ownerNodeId, requester: currentNodeId });
          return `Error: 文件 "${path}" 属于其他节点（${ownerNodeId}），当前节点无权读取。如需获取上游节点的内容，请使用 read_upstream_node 工具。`;
        }
      }
    }
    auditLog({ tool: 'read_file', path, resolved: filePath });
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (e0) {
      // Coding 节点兼容：write 已强制落 bob-sandbox/apps/<appId>/，裸文件名优先从 app 目录读取。
      // 普通节点产物直接写 homework/ 根，无需 per-node fallback。
      const readErr = e0 as NodeJS.ErrnoException;
      if (readErr?.code === 'ENOENT') {
        const codingAppId = nodeSandboxAppId(args);
        if (codingAppId) {
          filePath = join(sandboxAppDir(codingAppId), codingFallbackFilename(path));
          content = await readFile(filePath, 'utf-8');
        } else {
          throw e0;
        }
      } else {
        throw e0;
      }
    }
    // DOCX 是 zip 压缩包，UTF-8 读取只会得到乱码 → 解 word/document.xml 提取纯文本
    if (/\.docx$/i.test(filePath)) {
      try {
        content = await extractDocxText(filePath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return msg.includes('ENOENT')
          ? `File not found: ${path}`
          : `Read failed: DOCX 文本提取失败（${msg}）。docx 为二进制压缩格式，若需检查模板占位符请用 scan_docx_templates。`;
      }
    }
    // 截断标注放头部而非尾部：外层 executeTool 会按模型 maxOutput 二次截断，
    // 标注在尾部会被切掉，导致模型静默拿到截断内容而误判文件全貌。
    if (content.length > READ_CAPACITY) {
      return `⚠️ 文件过大，仅返回前 ${READ_CAPACITY} 字符（全文 ${content.length} 字符）。如需了解后续内容，请勿据此判断文件全貌。\n\n${content.slice(0, READ_CAPACITY)}`;
    }
    return content;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) return `File not found: ${path}`;
    if (msg.includes('EISDIR')) return `Path is a directory: ${path}`;
    return `Read failed: ${msg}`;
  }
}

/** 列出目录内容 */
async function toolListDirectory(args: Record<string, unknown>): Promise<string> {
  const inputPath = (args.path as string) || '.';
  const dirPath = await resolvePath(inputPath);

  if (!(await isReadablePath(dirPath))) {
    auditLog({ tool: 'list_directory', blocked: true, reason: 'readable-path', path: inputPath, resolved: dirPath });
    return await readableError(inputPath, dirPath, '读取');
  }
  auditLog({ tool: 'list_directory', path: inputPath, resolved: dirPath });

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const lines: string[] = [];

    for (const entry of entries.sort((a, b) => {
      // 目录优先，然后按名称排序
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })) {
      const suffix = entry.isDirectory() ? '/' : '';
      let size = '';
      if (entry.isFile()) {
        try {
          const s = await stat(join(dirPath, entry.name));
          size = ` (${formatSize(s.size)})`;
        } catch { /* ignore */ }
      }
      lines.push(`  ${entry.name}${suffix}${size}`);
    }

    return lines.length > 0 ? lines.join('\n') : '(empty directory)';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) {
      return `Directory not found: ${args.path ?? '.'}`;
    }
    if (msg.includes('ENOTDIR')) return `Path is not a directory: ${args.path ?? '.'}`;
    return `Directory read failed: ${msg}`;
  }
}

/** 搜索匹配模式的文件 — 改进版：支持 glob 语法 */
async function toolSearchFiles(args: Record<string, unknown>): Promise<string> {
  const pattern = args.pattern as string;
  if (!pattern) return 'Error: pattern required';

  const inputPath = (args.path as string) || '.';
  const searchDir = await resolvePath(inputPath);
  if (!(await isReadablePath(searchDir))) {
    auditLog({ tool: 'search_files', blocked: true, reason: 'readable-path', path: inputPath, resolved: searchDir, pattern });
    return await readableError(inputPath, searchDir, '读取');
  }
  auditLog({ tool: 'search_files', path: inputPath, resolved: searchDir, pattern });

  const maxResults = 50;
  const maxDepth = 8;
  const results: string[] = [];
  const regex = globToRegex(pattern);
  const workspaceRoot = await getWorkspacePath();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length >= maxResults) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(workspaceRoot, fullPath);

      if (entry.isFile() && regex.test(entry.name)) {
        results.push(relPath || fullPath);
        if (results.length >= maxResults) return;
      }

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  try {
    await walk(searchDir, 0);

    if (results.length === 0) {
      return `No files matching "${pattern}"`;
    }

    let output = results.join('\n');
    if (results.length >= maxResults) {
      output += `\n... ${maxResults}+ results (truncated)`;
    }
    return output;
  } catch (e) {
    return `Search failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 个人敏感目录读取拦截：检测命令中是否引用 ~/Downloads、~/Desktop、~/Documents、
 * ~/Pictures、~/Library 等个人目录（读取侧会触发 macOS TCC 系统弹窗，且违背
 * "禁读个人目录"规则）。用户授权目录内的路径放行；其余命中直接拦截，
 * 避免 AI 用 shell 绕过 read_file 的权限门控。
 */
async function checkPersonalDirRead(cmd: string): Promise<string | null> {
  const PERSONAL_MARKERS = ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Movies', 'Library', '.ssh', '.aws', '.gnupg', 'Keychains'];
  const matches = cmd.match(/(?:~|\/Users\/[^\/\s"']+)\/([^\/\s"']+)/g);
  if (!matches) return null;
  const home = homedir();
  const localRoots = await getLocalAuthorizedRoots();
  const authorized = localRoots.map((r) => resolve(r));
  for (const tok of matches) {
    const cleaned = tok.replace(/^[\s;|&()"'`]+/, '');
    const resolved = cleaned.startsWith('~') ? join(home, cleaned.slice(1)) : cleaned;
    if (authorized.some((r) => resolved === r || resolved.startsWith(r + sep))) continue;
    const firstSeg = cleaned.split('/')[1] ?? '';
    if (PERSONAL_MARKERS.some((m) => firstSeg === m)) return resolved;
  }
  return null;
}

async function toolRunCommand(args: Record<string, unknown>): Promise<string> {
  const cmd = args.cmd as string;
  if (!cmd) return 'Error: cmd required';

  // 危险命令黑名单拦截
  const danger = checkDangerousCommand(cmd);
  if (danger) {
    auditLog({ tool: 'run_command', blocked: true, reason: 'dangerous', reasonDetail: danger, cmd: truncate(cmd, 500) });
    return `BLOCKED: 命令已拒绝（${danger}）。\n如果这是合法操作，请在终端手动执行，或调整脚本降低危险级别。`;
  }
  // 个人目录读取拦截（防 shell 绕过 read_file 权限门控触发系统 TCC 弹窗）
  const personalPath = await checkPersonalDirRead(cmd);
  if (personalPath) {
    auditLog({ tool: 'run_command', blocked: true, reason: 'personal-dir', reasonDetail: personalPath, cmd: truncate(cmd, 500) });
    return `BLOCKED: 命令涉及访问个人目录 "${personalPath}"（下载/桌面/文稿/图片/Library 等）。读取个人目录须用户先授权，禁止通过 shell 访问。附件已在项目 attachments/ 内，请用 read_attachment 读取；产出请写入项目 homework/。`;
  }
  auditLog({ tool: 'run_command', cmd: truncate(cmd, 500) });

  // 执行超时：安装类命令（pip/npm/brew/cargo 等 install）放宽到 180s——
  // 下载依赖 + 编译通常远超 30s（如 pip install matplotlib），固定 30s 会被误杀；
  // 其余命令维持 30s 防挂起。
  const INSTALL_RE = /(^|[\s|&;])(pip|pip3|pipx|python3? -m pip|npm|pnpm|yarn|brew|bun|cargo|gem|go)\s+(install|add|update|upgrade|i|-i|remove|rm)\b/i;
  const isInstall = INSTALL_RE.test(cmd);
  const timeout = isInstall ? 180_000 : 30_000;
  // pip 安装自动禁用下载缓存（--no-cache-dir）：pip 默认永久缓存所有下载过的 wheel 且从不自动清理，
  // 大包（opencv/numpy 等 100MB 级）会无限累积磁盘（曾实测 835MB）。禁用后装完即走；
  // npm 等无 --no-cache-dir 语义，不处理。
  let execCmd = cmd;
  if (isInstall && /(pip|pipx)/i.test(execCmd)) {
    execCmd = execCmd.replace(/(pip3?|pipx|python3? -m pip)\s+(install|add)\b/i, '$1 $2 --no-cache-dir');
  }

  try {
    const { stdout, stderr } = await execAsync(execCmd, {
      cwd: await getWorkspacePath(),
      timeout,
      maxBuffer: 1024 * 1024,
    });

    // pip 安装成功后记账：写入「安装日期 + 最近使用追踪」，供超过30天未使用的包自动清理
    if (isInstall && /(pip|pipx)/i.test(execCmd)) {
      recordPipInstall(execCmd);
    }

    let output = stdout;
    if (stderr) {
      output += `\n[stderr]\n${stderr}`;
    }
    if (!output.trim()) {
      output = '(no output)';
    }
    return truncate(output, READ_CAPACITY);
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; message?: string };

    if (err.killed) {
      return `Command timed out (${timeout / 1000}s)`;
    }

    let output = err.stdout || '';
    if (err.stderr) output += `\n[stderr]\n${err.stderr}`;
    if (!output.trim()) {
      output = `Execution failed: ${err.message || String(e)}`;
    }
    return truncate(output, READ_CAPACITY);
  }
}

/** 自主编码解决问题 — 写脚本并执行 */
async function toolExecuteScript(args: Record<string, unknown>): Promise<string> {
  const language = (args.language as string) || 'python';
  const script = args.script as string;
  if (!script) return 'Error: script content is required';

  // Shell 脚本也做危险命令扫描（shell 内部可能嵌套 rm -rf 等）
  if (language === 'bash' || language === 'shell' || language === 'sh') {
    const danger = checkDangerousCommand(script);
    if (danger) {
      auditLog({ tool: 'execute_script', blocked: true, reason: 'dangerous', reasonDetail: danger, language, script: truncate(script, 500) });
      return `BLOCKED: Shell 脚本中检测到危险模式（${danger}），已拒绝执行。`;
    }
    // 个人目录读取拦截（与 run_command 一致）
    const personalPath = await checkPersonalDirRead(script);
    if (personalPath) {
      auditLog({ tool: 'execute_script', blocked: true, reason: 'personal-dir', reasonDetail: personalPath, language, script: truncate(script, 500) });
      return `BLOCKED: Shell 脚本涉及访问个人目录 "${personalPath}"（下载/桌面/文稿/图片/Library 等）。读取个人目录须用户先授权，禁止通过脚本访问；产出请写入项目 homework/。`;
    }
  }
  auditLog({ tool: 'execute_script', language, scriptBytes: script.length });

  // 选择解释器和文件扩展名
  const isPython = language === 'python' || language === 'py';
  const ext = isPython ? '.py' : '.sh';
  const interpreter = isPython ? 'python3' : 'bash';
  const tmpFileName = `.bobwork_script_${Date.now()}${ext}`;
  const tmpPath = join(await getWorkspacePath(), tmpFileName);
  const SCRIPT_TIMEOUT = 30_000;

  try {
    // 写入脚本文件
    await writeFile(tmpPath, script, 'utf-8');
    if (isPython) {
      try { await execAsync(`chmod +x "${tmpPath}"`); } catch { /* ignore */ }
    }

    const cmd = `${interpreter} "${tmpPath}"`;

    // 注入项目真实 homework 绝对路径：脚本 CWD 是 .ai-workspace（见 getWorkspacePath），
    // 脚本内若用相对路径 "homework/xxx" 写交付文件会错落到 .ai-workspace/homework/xxx
    // （输出扫描跳过 .ai-workspace → 用户看不到）。暴露环境变量供脚本拼绝对路径，
    // 工具描述已要求 AI 通过 BOB_PROJECT_HOMEWORK 定位项目 homework。
    const projectHomework = join(await getProjectRootPath(), 'homework');
    // 普通节点：脚本产物直接写 homework/ 根（归属靠 .ownership.json 清册追踪）。
    // Coding 节点：脚本产物直接落 bob-sandbox/apps/<appId>/（小程序全部存全局沙箱，不落 homework）。
    const codingAppId = nodeSandboxAppId(args);
    const nodeHomework = codingAppId ? sandboxAppDir(codingAppId) : projectHomework;
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: await getWorkspacePath(),
      env: { ...process.env, BOB_PROJECT_HOMEWORK: projectHomework, BOB_NODE_HOMEWORK: nodeHomework },
      timeout: SCRIPT_TIMEOUT,
      maxBuffer: 1024 * 1024,
    });

    let output = stdout;
    if (stderr) {
      output += output ? `\n[stderr]\n${stderr}` : `[stderr]\n${stderr}`;
    }
    if (!output.trim()) {
      output = '(script executed with no output)';
    }
    return truncate(output, 8000);
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; message?: string };

    if (err.killed) {
      return `Script timed out (${SCRIPT_TIMEOUT / 1000}s)`;
    }

    let output = err.stdout || '';
    if (err.stderr) output += output ? `\n[stderr]\n${err.stderr}` : `[stderr]\n${err.stderr}`;
    if (!output.trim()) {
      output = `Script execution failed: ${err.message || String(e)}`;
    }
    return truncate(output, 8000);
  } finally {
    // 清理临时脚本文件
    try { await unlink(tmpPath); } catch { /* ignore */ }
  }
}

/** 写入文件内容 */
async function toolWriteFile(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  const content = args.content as string;
  if (!path) return 'Error: path required';
  if (content === undefined) return 'Error: content required';

  try {
    const { writeFile, mkdir } = await import('fs/promises');
    let filePath = await resolvePath(path);
    if (!(await isWritablePath(filePath))) {
      return `Error: 路径 "${path}" 不在可写范围内。允许写入：${await describeWritableRoots()}`;
    }
    // 小程序目录内文件：走原子写入（版本回滚 + manifest 同步），避免宿主一致性校验误判重置
    // Coding 节点（node_sandbox_app_id）：任何非小程序目录写入一律强制落 bob-sandbox/apps/<appId>/，
    // 保证小程序产物全部在全局沙箱目录，不散落项目 homework/（用户硬性要求）。
    const codingAppId = nodeSandboxAppId(args);
    const sandboxTarget = sandboxAppTarget(filePath) ?? (codingAppId ? { appId: codingAppId, filename: codingFallbackFilename(path) } : null);
    if (sandboxTarget) {
      const ok = await writeAppFileAtomic(sandboxTarget.appId, sandboxTarget.filename, content);
      if (!ok) {
        return `Write failed: 原子写入小程序文件失败（appId=${sandboxTarget.appId}, file=${sandboxTarget.filename}）`;
      }
      return `Written: bob-sandbox/apps/${sandboxTarget.appId}/${sandboxTarget.filename} (${content.length} chars)`;
    }
    // 普通节点：产物写 homework/，根级文件由 resolvePath 自动路由到 <kind>/ 子目录，归属由 .ownership.json 清册追踪。
    const currentNodeId = args.current_node_id as string | undefined;
    let relForManifest: string | null = null;
    if (currentNodeId) {
      const projectRoot = await getProjectRootPath();
      const relPath = getHomeworkRelativePath(filePath, projectRoot);
      if (relPath) {
        relForManifest = relPath;
      }
    }
    const dir = filePath.substring(0, filePath.lastIndexOf(sep));
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    // 记录 homework/ 文件归属（当前节点写入 → 当前节点拥有）
    if (relForManifest && currentNodeId) {
      try {
        const projectRoot = await getProjectRootPath();
        await writeOwnershipManifest(projectRoot, { [relForManifest]: currentNodeId });
      } catch { /* 归属登记失败不影响写入 */ }
    }
    return `Written: ${path} (${content.length} chars)`;
  } catch (e) {
    return `Write failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 代码局部编辑（SearchReplace 式）：在文件中精确替换第一处 search → replace。
 * 与 write_file 同链路（sandbox 目录走原子写入 + .history 版本快照），避免大文件整文件重写。
 */
async function toolEditCode(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? '');
  const search = String(args.search ?? '');
  const replace = String(args.replace ?? '');
  if (!path) return 'Error: path required';
  if (!search) return 'Error: search required (the exact existing text to replace)';
  try {
    const { readFile, writeFile, mkdir } = await import('fs/promises');
    const filePath = await resolvePath(path);
    if (!(await isWritablePath(filePath))) {
      return `Error: 路径 "${path}" 不在可写范围内。允许写入：${await describeWritableRoots()}`;
    }
    const codingAppId = nodeSandboxAppId(args);
    // 读取：优先原路径；Coding 节点用裸文件名时 fallback 到 app 目录同名文件
    let current = await readFile(filePath, 'utf-8').catch(() => null);
    if (current === null && codingAppId) {
      const appFile = join(sandboxAppDir(codingAppId), codingFallbackFilename(path));
      current = await readFile(appFile, 'utf-8').catch(() => null);
    }
    if (current === null) return `Error: 文件不存在：${path}（如需新建请用 write_file）`;
    const idx = current.indexOf(search);
    if (idx === -1) {
      const snippet = current.slice(0, 600).replace(/\s+/g, ' ');
      return `Error: search 片段未在 ${path} 中找到。search 必须与文件现有内容逐字一致（含缩进/换行）。文件开头预览：\n${snippet.slice(0, 500)}…`;
    }
    const updated = current.slice(0, idx) + replace + current.slice(idx + search.length);
    if (updated === current) return 'No change: search 与 replace 相同';
    // 与 write_file 同链路：sandbox 目录走原子写入（自动备份 .history 版本）；
    // Coding 节点任何非小程序目录路径也强制落 bob-sandbox/apps/<appId>/（不落 homework）
    const sandboxTarget = sandboxAppTarget(filePath) ?? (codingAppId ? { appId: codingAppId, filename: codingFallbackFilename(path) } : null);
    if (sandboxTarget) {
      const ok = await writeAppFileAtomic(sandboxTarget.appId, sandboxTarget.filename, updated);
      if (!ok) return `Edit failed: 原子写入小程序文件失败（appId=${sandboxTarget.appId}）`;
    } else {
      const dir = filePath.substring(0, filePath.lastIndexOf(sep));
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, updated, 'utf-8');
    }
    return `Edited: ${path} (replaced ${search.length} → ${replace.length} chars, 1 occurrence)`;
  } catch (e) {
    return `Edit failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 重命名/移动文件 */
async function toolRenameFile(args: Record<string, unknown>): Promise<string> {
  const source = args.source as string;
  const target = args.target as string;
  if (!source) return 'Error: source path required';
  if (!target) return 'Error: target path required';

  try {
    const currentNodeId = args.current_node_id as string | undefined;
    const codingAppId = nodeSandboxAppId(args);
    // 源路径 Coding 兜底：AI 常用写入前的旧路径操作，实际文件在 bob-sandbox/apps/<appId>/，自动对齐。
    // 普通节点产物直接写 homework/ 根，无 per-node 重定向。
    const sourcePath = await resolvePathWithNodeFallback(source, codingAppId);
    let targetPath = await resolvePath(target);
    if (!(await isReadablePath(sourcePath))) {
      auditLog({ tool: 'rename_file', blocked: true, reason: 'readable-path', path: source, resolved: sourcePath });
      return await readableError(source, sourcePath, '操作');
    }
    if (!(await isWritablePath(sourcePath))) {
      return `Error: 源路径 "${source}" 不在可写范围内。允许操作：${await describeWritableRoots()}`;
    }
    // Coding 节点目标一律落 bob-sandbox/apps/<appId>/；普通节点目标直接写 homework/ 根（归属清册追踪）。
    if (codingAppId) {
      targetPath = join(sandboxAppDir(codingAppId), codingFallbackFilename(target));
    }
    if (!(await isWritablePath(targetPath))) {
      return `Error: 目标路径 "${target}" 不在可写范围内。允许操作：${await describeWritableRoots()}`;
    }
    await rename(sourcePath, targetPath);
    // 归属转移：rename 后目标文件继承当前节点归属（若在 homework/ 下）；
    // 源路径已不存在，删除其旧归属条目，避免 stale 映射影响其他节点分类。
    if (currentNodeId) {
      try {
        const projectRoot = await getProjectRootPath();
        const srcRel = getHomeworkRelativePath(sourcePath, projectRoot);
        const tgtRel = getHomeworkRelativePath(targetPath, projectRoot);
        if (srcRel || tgtRel) {
          const manifest = await readOwnershipManifest(projectRoot);
          if (srcRel) delete manifest[srcRel];
          if (tgtRel) manifest[tgtRel] = currentNodeId;
          const tmpPath = join(projectRoot, 'homework', `.ownership.json.${process.pid}.${Date.now()}.tmp`);
          await writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
          await rename(tmpPath, join(projectRoot, 'homework', '.ownership.json'));
        }
      } catch { /* 归属登记失败不影响 rename 本身 */ }
    }
    return `Renamed: ${source} → ${target}`;
  } catch (e) {
    return `Rename failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 删除文件 */
async function toolDeleteFile(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  if (!path) return 'Error: path required';

  try {
    const currentNodeId = args.current_node_id as string | undefined;
    const codingAppId = nodeSandboxAppId(args);
    // Coding 兜底：AI 常用旧路径删除，实际文件在 bob-sandbox/apps/<appId>/（普通节点产物直接写 homework/ 根）
    const filePath = await resolvePathWithNodeFallback(path, codingAppId);
    if (!(await isWritablePath(filePath))) {
      return `Error: 路径 "${path}" 不在可写范围内。允许操作：${await describeWritableRoots()}`;
    }
    await unlink(filePath);
    // 联动清理：AI 删除文档时同步清理 md-annotations 对应 sidecar（文档曾在 DocEditor 打开过的场景）
    await cleanupMdAnnotationSidecars({ targets: [{ abs: filePath }] }).catch(() => {});
    // 清理 homework/ 归属清册残留条目：删除后若之后新建同名文件，避免被误判为原归属节点
    if (currentNodeId) {
      try {
        const projectRoot = await getProjectRootPath();
        const relPath = getHomeworkRelativePath(filePath, projectRoot);
        if (relPath) {
          const manifest = await readOwnershipManifest(projectRoot);
          if (manifest[relPath] !== undefined) {
            delete manifest[relPath];
            const tmpPath = join(projectRoot, 'homework', `.ownership.json.${process.pid}.${Date.now()}.tmp`);
            await writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
            await rename(tmpPath, join(projectRoot, 'homework', '.ownership.json'));
          }
        }
      } catch { /* 清册清理失败不影响删除本身 */ }
    }
    return `Deleted: ${path}`;
  } catch (e) {
    return `Delete failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============================================================
// 构建工具注册表
// ============================================================

/** 工具定义：name + schema + executor + 元数据 */
const toolDefs: Tool[] = [
  {
    name: 'finish_task',
    description: 'Signal full task completion — immediately ends the turn and delivers results. Call ONLY after all required steps succeeded and the final answer/deliverable is produced; never prematurely or instead of finishing the work.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished (audit log).',
        },
      },
      required: ['summary'],
    },
    category: '系统',
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const summary = typeof args.summary === 'string' ? args.summary : 'Task completed';
      // This tool acts as a signal; the actual ending logic is handled in route.ts
      return `Task finished. Summary: ${summary}`;
    },
    maxOutput: 100,
  },
  {
    name: 'todo_write',
    description: 'Publish the full task step list with current statuses (REPLACEMENT semantics — each call resends the FULL snapshot; do not diff/patch). First call of a multi-step task creates the track (goal + steps pending); every step boundary (in_progress/completed/failed) resends the latest list. MANDATORY for multi-step tasks; skip trivial chats. Status: pending → in_progress → completed (or failed). activeForm is a one-line "currently doing X" shown ONLY while in_progress. Report real progress; never estimate it.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Static description of the step, shown at all times. Imperative or noun-phrase, e.g. "Extract user ID from profile page".' },
              activeForm: { type: 'string', description: 'Dynamic copy shown ONLY when this step is in_progress. Verb-led, present-continuous, e.g. "Extracting user ID from profile page". Leave empty if same as content.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: 'Lifecycle state of this step.' },
            },
            required: ['content', 'status'],
          },
          description: 'Full todo list snapshot. Each item: { content, activeForm?, status }. Replaces the previous list entirely on every call.',
        },
        goal: {
          type: 'string',
          description: 'The ultimate goal or deliverable of the task, shown at the top of the steps panel. Set on the FIRST (track-creating) call only; may be omitted on later heartbeats.',
        },
      },
      required: ['todos'],
    },
    category: '系统',
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      if (todos.length === 0) return 'Todo list cleared.';
      const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal : '';
      const lines = todos.map((t, i) => {
        const content = (t as { content?: unknown }).content;
        const status = (t as { status?: unknown }).status;
        const c = typeof content === 'string' ? content : '(no content)';
        const s = typeof status === 'string' ? status : 'pending';
        return `${i + 1}. [${s}] ${c}`;
      });
      const done = todos.filter((t) => (t as { status?: unknown }).status === 'completed').length;
      return `${goal ? `Goal: ${goal}\n` : ''}Todo snapshot: ${done}/${todos.length} done\n${lines.join('\n')}`;
    },
    maxOutput: 500,
  },
  {
    name: 'read_file',
    description: 'Read file content (source code, configs, documents). Relative paths resolve from the workspace root; "homework/…" and "attachments/…" map to the project root; absolute and ~/ paths supported. .docx files are auto-extracted to plain text (paragraphs/tables preserved), so generated Word files can be read directly to verify.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path: relative to workspace root ("src/main.ts"), "homework/<file>" or "attachments/…" for project-root paths, or absolute / ~/ path.',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolReadFile,
    maxOutput: 8000,
  },
  {
    name: 'write_file',
    description: 'Write or create a file (parent dirs auto-created) for code/config/docs. Deliverables MUST use a path starting with "homework/" (e.g. "homework/报告.html") to land in the project homework/ folder and show as an output card; paths not starting with "homework/" or "attachments/" are scratch files in the temporary workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path. "homework/<filename>" for final deliverables (project homework/ folder, shown as output card); other relative paths are scratch in the temporary workspace; absolute and ~/ paths supported.',
        },
        content: {
          type: 'string',
          description: 'Full file content to write.',
        },
      },
      required: ['path', 'content'],
    },
    category: '文件',
    execute: toolWriteFile,
    maxOutput: 500,
  },
  {
    name: 'edit_code',
    description: 'Replace the FIRST exact occurrence of "search" with "replace" (must match verbatim, incl. indentation/newlines; on not-found the error shows the file head to help craft the search). Prefer over write_file for small iterative edits on existing files — avoids rewriting the whole file and burning tokens. Mini-app files are written atomically with an automatic .history snapshot (recoverable via sandbox_rollback).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (same rules as write_file: homework/, attachments/, bob-sandbox/apps/<appId>/, absolute or ~/ path).',
        },
        search: {
          type: 'string',
          description: 'The exact existing text to find and replace (first occurrence only). Must match file content verbatim.',
        },
        replace: {
          type: 'string',
          description: 'The replacement text.',
        },
      },
      required: ['path', 'search', 'replace'],
    },
    category: '文件',
    execute: toolEditCode,
    maxOutput: 800,
  },
  ...adminToolDefs,
  {
    name: 'list_directory',
    description: 'List directory contents including files and subdirectories. Directories first, then files with sizes shown. Use for exploring project structure, finding files etc.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path, defaults to workspace root. Supports relative, absolute and ~/ paths. Use "homework/" to list the project homework/ folder (e.g. "homework/").',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolListDirectory,
    maxOutput: 5000,
  },
  {
    name: 'search_files',
      description: 'Search for files matching a pattern. Supports glob: * matches any chars, ? matches single char, ** matches recursively. Skips node_modules, .git etc.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern. e.g. "*.ts" matches TypeScript files, "*.py" matches Python files, "test*" matches files starting with test.',
        },
        path: {
          type: 'string',
          description: 'Search root directory, defaults to workspace root. Use "homework/" to search the project homework/ folder.',
        },
      },
      required: ['pattern'],
    },
    category: '文件',
    execute: toolSearchFiles,
    maxOutput: 3000,
  },
  {
    name: 'rename_file',
    description: 'Rename or move a file. Both source and target paths must be within project directories.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Source file path to rename/move. Use "homework/" prefix for files in the project homework/ folder.',
        },
        target: {
          type: 'string',
          description: 'Target file path. If different directory, the file will be moved. Use "homework/" prefix to keep deliverables in the project homework/ folder.',
        },
      },
      required: ['source', 'target'],
    },
    category: '文件',
    execute: toolRenameFile,
    maxOutput: 200,
  },
  {
    name: 'delete_file',
    description: 'Delete a file. Use with caution - this operation cannot be undone.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to delete. Use "homework/" prefix for files in the project homework/ folder.',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolDeleteFile,
    maxOutput: 200,
  },
  {
    name: 'run_command',
    description: 'Execute a shell command and return output (tests, builds, git, process inspection). Runs in the workspace root. Timeout: install commands (pip/npm/brew/cargo…) get 180s, others 30s. Files generated land in the workspace root unless the path is absolute or "homework/"-prefixed (project deliverables should use "homework/…").',
    parameters: {
      type: 'object',
      properties: {
        cmd: {
          type: 'string',
          description: 'Command to execute. e.g. "ls -la", "git status", "npm test", "python script.py"',
        },
      },
      required: ['cmd'],
    },
    category: '系统',
    execute: toolRunCommand,
    maxOutput: 5000,
    timeoutMs: 30_000,
  },
  {
    name: 'execute_script',
    description: 'Write and execute a Python/Shell script (30s timeout) for data processing / automation / analysis that single tools cannot do. IMPORTANT PATH RULE: script CWD = homework/.ai-workspace/ (hidden temp area, NOT the project root) — a relative "homework/xxx" path inside the script lands there and is invisible to the UI. To write a visible deliverable or read project homework files, use the absolute env BOB_PROJECT_HOMEWORK (Python: os.environ["BOB_PROJECT_HOMEWORK"]; Shell: "$BOB_PROJECT_HOMEWORK") and print "OutputFile: homework/<filename>" so the file is shown to the user.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'shell'],
          description: 'Script language: python=Python3, shell=Bash.',
        },
        script: {
          type: 'string',
          description: 'Full script content to execute. Python: use print() for output. Shell: use echo or stdout.',
        },
      },
      required: ['language', 'script'],
    },
    category: '系统',
    execute: toolExecuteScript,
    maxOutput: 8000,
    timeoutMs: 30_000,
  },
  ...webToolDefs,
  ...attachmentToolDefs,
  ...ocrToolDefs,
  ...nodeToolDefs,

  ...notebookToolDefs,


  ...officeToolDefs,
  ...audioToolDefs,
  ...skillToolDefs,
  ...designToolDefs,
  {
    name: 'ask_user_questions',
    description: 'Pause to ask the user structured questions and wait for their answers before continuing — use whenever you need info/clarification/a decision to proceed. The host pops up a form; the answers return to you as the tool result. Prefer over free-text questions.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'List of questions to ask the user. Each question offers several options and optionally allows a custom free-text answer.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable unique id for this question, e.g. "q1".' },
              question: { type: 'string', description: 'The question text shown to the user.' },
              options: {
                type: 'array',
                description: 'Selectable options (usually 2-4). Keep them concise and mutually exclusive.',
                items: { type: 'string' },
              },
              allowCustom: {
                type: 'boolean',
                description: 'Whether the user may also type a custom answer. Default true.',
              },
            },
            required: ['id', 'question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    category: '系统',
    execute: async () =>
      'This tool is handled by the host (it pauses to ask the user and returns their answers). It should not be executed directly.',
    maxOutput: 2000,
  },
  {
    name: 'search_capabilities',
    description: 'Search the on-demand capability catalog (browser, company lookup, team orchestration, local app control, legal, audio, OCR, memory/todo, theme, skills…). Use when unsure a capability exists or which intent activates it — the host activates the match (its tools become available next rounds) and returns the result.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What capability do you need? Natural language, e.g. "查企业信息", "抓取网页", "转写录音".',
        },
      },
      required: ['query'],
    },
    category: '系统',
    execute: async () =>
      'This tool is handled by the host (it activates the matched on-demand capability and its tools become available in the following rounds). It should not be executed directly.',
    maxOutput: 3000,
  },
  ...butlerToolDefs,
  ...agentPackageToolDefs,
];

/** 常驻内核工具名集合：无场景标注且未在 SCENED_TOOLS 表 = core 层（coreExclusions 只对这类工具生效） */
const agentCoreToolNames = new Set(
  toolDefs
    .filter((d) => !(d.scenes && d.scenes.length > 0) && !SCENED_TOOLS[d.name])
    .map((d) => d.name),
);
setAgentCoreToolNames(agentCoreToolNames);

/** 装配：将全部内置工具注册进全局注册表（实例定义见 registry.ts） */
registry.registerAll(toolDefs);

/** 记录内置工具名称，用于区分自定义工具 */
const builtInToolNames = new Set(toolDefs.map((t) => t.name));

/** 已注册的自定义工具名称集合 */
let registeredCustomNames = new Set<string>();

/** 工具来源判定（缓存分组排序用）：builtin=内置（静态 toolDefs，发版才变）/ custom=用户自定义 / mcp=动态 MCP */
export type ToolSource = 'builtin' | 'custom' | 'mcp';

/** 内置工具分层：core=常驻（每轮注入，字节稳定，占前缀缓存锚点）/ ondemand=按需（场景激活才注入，省上下文）
 *  分层动机（2026-08-30 量化）：内置 51 个工具 ≈ 18.4k token，普通对话固定全量注入；
 *  其中仅 ~20 个高频核心（文件/网络/材料/技能链）≈ 6.5k，其余 30 个低频场景工具 ≈ 11.9k
 *  是「上下文固定税」的大头 → 改为场景激活才注入，配合排序分层保护前缀缓存。 */
export type ToolLayer = 'core' | 'ondemand';

/** 内置工具分层标注（静态表；未列出的内置工具默认 core，保证新增工具不意外丢失） */
const BUILTIN_LAYER: Record<string, ToolLayer> = {
  // ---- ondemand（按需激活；含场景标注见 SCENED_TOOLS / 自身 scenes）----
  read_notebook: 'ondemand',
  read_note: 'ondemand',
  read_note_history: 'ondemand',
  restore_note: 'ondemand',
  create_sticky_note: 'ondemand', remember_preference: 'ondemand',
  intern_search: 'ondemand', manage_mcp_server: 'ondemand', manage_quick_launch: 'ondemand',
  fill_docx_templates: 'ondemand', ocr_document: 'ondemand',
  update_notebook: 'ondemand',
  sandbox_rollback: 'ondemand', update_provider_config: 'ondemand',
  check_mcp_gaps: 'ondemand', crop_image: 'ondemand',
  update_preference: 'ondemand',
  transcribe_audio: 'ondemand', read_todo: 'ondemand',
  read_upstream_node: 'ondemand', delete_notebook: 'ondemand',
  write_notebook_answer: 'ondemand', create_note: 'ondemand',
  set_app_icon: 'ondemand', test_model: 'ondemand',
  list_configured_models: 'ondemand', sandbox_export: 'ondemand',
  scan_docx_templates: 'ondemand', read_manifest: 'ondemand',
  get_app_config: 'ondemand', get_current_theme: 'ondemand',
  delete_preference: 'ondemand', draw: 'ondemand',
};

/** 查询内置工具分层（供排序/过滤用）：
 *  判定顺序：BUILTIN_LAYER 显式标注优先；其次若工具在 SCENED_TOOLS 有场景门控
 *  （专属工具，场景激活才注入）→ 归 ondemand；否则默认 core（通用工具每轮常驻）。
 *  2026-09-09 修复：此前 SCENED_TOOLS 门控但未显式标 ondemand 的内置工具（butler/
 *  todo 系如 query_todos、create_scheduled_todo、project_plan_* 等）被默认归 core，
 *  落入「常驻锚点段」——它们随画像/场景切换增减时既破坏 core 段前缀连续性（缓存整段失效），
 *  又被 CacheGuard 豁免判定误判为异常漂移。现按「场景门控即动态」统一归 ondemand：core 段
 *  只剩真正每轮常驻的通用工具，锚点字节更稳；场景工具增减只影响尾段。 */
export function getToolLayer(name: string): ToolLayer {
  const explicit = BUILTIN_LAYER[name];
  if (explicit) return explicit;
  if (name in SCENED_TOOLS) return 'ondemand';
  return 'core';
}

/** 判定工具来源：route.ts 排序按来源分段（内置最前、MCP 最后），
 *  隔离 MCP 变更对内置段缓存的影响（前缀分桶：尾部变化只作废尾部桶）。 */
export function getToolSource(name: string): ToolSource {
  if (builtInToolNames.has(name)) return 'builtin';
  if (registeredCustomNames.has(name)) return 'custom';
  return 'mcp';
}

/**
 * 动态注册自定义工具到注册表。
 * 每次调用会先清除上一次注册的自定义工具，再注册新的。
 * 在 route.ts 每次请求前调用。
 */
export function registerCustomTools(customTools: CustomToolDef[]): void {
  // 清除上一次的自定义工具
  for (const name of registeredCustomNames) {
    registry.unregister(name);
  }
  registeredCustomNames = new Set();

  // 注册新的自定义工具
  for (const ct of customTools) {
    if (!ct.enabled || !ct.name || !ct.endpoint) continue;
    // 不允许覆盖内置工具
    if (builtInToolNames.has(ct.name)) continue;

    const tool: Tool = {
      name: ct.name,
      description: ct.description || 'Custom tool',
      parameters: ct.parameters || { type: 'object', properties: {}, required: [] },
      category: '网络',
      maxOutput: ct.maxOutput || 5000,
      timeoutMs: ct.timeoutMs || 30000,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const controller = new AbortController();
        const timeout = ct.timeoutMs || 30000;
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const method = ct.method || 'POST';
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...ct.headers,
          };
          const res = await fetch(ct.endpoint, {
            method,
            headers,
            body: method === 'POST' ? JSON.stringify(args) : undefined,
            signal: controller.signal,
          });
          const text = await res.text();
          if (!res.ok) {
            return `HTTP ${res.status}: ${text.slice(0, 2000)}`;
          }
          return text;
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') {
            return `Error: Request timed out after ${timeout}ms`;
          }
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          clearTimeout(timer);
        }
      },
    };
    registry.register(tool);
    registeredCustomNames.add(ct.name);
  }
}

/** 已注册的 MCP 工具名称集合 */
let registeredMcpNames = new Set<string>();

/** bob-browser-mcp 工具定义快照（缓存稳定性加固）：
 *  首次成功发现 browser.* 工具后锁存；此后无论桥在线/离线，都从快照注册同一套工具定义，
 *  保证工具集字节稳定 → 前缀缓存不因桥连接状态漂移。
 *  桥升级新增工具/进程重启时，下次成功发现自动更新快照（低频事件，可接受一次缓存失效）。
 *  offlineStreak：连续 N 次请求发现不到 browser 工具 → 清空快照（桥长期离线 / 用户显式禁用），
 *  避免禁用后工具永久残留。 */
let browserMcpSnapshot: McpToolInfo[] | null = null;
let browserOfflineStreak = 0;
const BROWSER_SNAPSHOT_MAX_STREAK = 10;

/**
 * 方案3：把 browser.screenshot(describe:true) 的返回翻译成文字描述。
 * 用 BobWork 已配置的视觉模型（Vision Model + 多候选 failover）分析截图 dataUrl，
 * 把描述附到结果、并剥离巨大的 base64 文本（避免撑爆上下文与 MCP 输出限制）。
 * 截图"即拍即懂"——读图不依赖落盘文件。视觉配置缺失/失败时保留原结果并注明。
 */
async function describeScreenshotResult(raw: string): Promise<string> {
  // 提取结果 JSON 里的 dataUrl（兼容带/不带空格、单双引号变体）
  const dataUrlMatch = raw.match(/["']?dataUrl["']?\s*:\s*["'](data:image\/[^"']+)["']/);
  if (!dataUrlMatch) {
    // 正则未提取到图片数据：可能是调用失败或字段格式异常。
    // 结果若明显含截图内容（base64/data:image/ok 标记）则给明确提示，避免静默返回导致模型误判"无描述"
    if (raw.length > 300 && /base64|data:image|"ok"\s*:\s*true/i.test(raw)) {
      return raw +
        '\n\n[vision] 未能从截图结果中提取图片数据（dataUrl 字段格式异常），截图未翻译。' +
        '请改用 browser.snapshot 分页定位元素（结果 truncated 时用 offset 继续取）或 browser.extract_text 读取页面文字。';
    }
    return raw; // 调用本身失败（无截图数据）→ 原样返回
  }
  const dataUrl = dataUrlMatch[1];
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return raw;
  const base64 = dataUrl.slice(comma + 1);
  const mimeType = /^data:([^;]+);/.exec(dataUrl)?.[1] ?? 'image/png';
  // 截图视觉解读统一走 bob-ocr-mcp（ocr.image_understand screenshot 模式，复用插件 vision 配置）
  try {
    const { ocrImageUnderstandViaMcp } = await import('@/lib/mcp/ocr-client');
    const { writeFile, unlink } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
    const tmpPath = join(tmpdir(), `bobwork-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    try {
      await writeFile(tmpPath, Buffer.from(base64, 'base64'));
      const r = await ocrImageUnderstandViaMcp(tmpPath, { mode: 'screenshot' });
      if (r) {
        const trimmed = raw.replace(/"dataUrl"\s*:\s*"[^"]*"/, '"dataUrl": "(omitted — translated by vision model)"');
        return `${trimmed}\n\n[截图视觉解读] ${r.understanding}\n[vision] model=${r.model} (bob-ocr-mcp)`;
      }
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
    return raw + '\n\n[vision] bob-ocr-mcp 视觉模型不可用，截图未翻译（请确认 OCR 插件常驻服务在线且已配置 vision）。';
  } catch (e) {
    return raw + `\n\n[vision] 截图视觉解读失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * bob-preview-mcp 截图结果后处理：把 PNG base64 存盘到 .sandbox/captures/ 并做视觉描述。
 * 闭环：capture_preview / interact_preview 返回 { pngBase64, ... } → 存盘（用户可查看 AI 所见画面）
 *      → 经 bob-ocr-mcp 视觉模型描述渲染效果 → 返回文本带存盘路径 + 描述，供主模型自检。
 * 视觉模型不可用/失败时仍返回存盘路径（截图本身已产出），不阻断。
 */
async function describePreviewCapture(raw: string): Promise<string> {
  // 提取结果 JSON 里的 pngBase64 字段（data URL 或裸 base64）
  let pngBase64 = '';
  try {
    const parsed = JSON.parse(raw) as { pngBase64?: string; url?: string; execResult?: string; logs?: string };
    pngBase64 = String(parsed.pngBase64 ?? '').trim();
  } catch {
    return raw; // 非 JSON（调用失败）→ 原样返回
  }
  if (!pngBase64) return raw;
  const dataUrl = /^data:image\/[^;]+;base64,/.test(pngBase64) ? pngBase64 : `data:image/png;base64,${pngBase64}`;
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  if (!base64) return raw;

  const capturesDir = join(resolveAppRoot(), SANDBOX_DIRNAME, 'captures');
  await mkdir(capturesDir, { recursive: true });
  const ts = Date.now();
  const filename = `cdp-${ts}-${Math.random().toString(36).slice(2, 7)}.png`;
  const savePath = join(capturesDir, filename);
  try {
    await writeFile(savePath, Buffer.from(base64, 'base64'));
  } catch (e) {
    return raw + `\n\n[preview] 截图存盘失败：${e instanceof Error ? e.message : String(e)}`;
  }
  // 存盘后顺带清理历史截图（保留最近 20 张，超过 7 天的删除），避免 captures 目录无限堆积
  await pruneCaptureDir(capturesDir).catch(() => {});

  // 视觉描述（复用 bob-ocr-mcp vision 配置）；失败不阻断，附存盘路径即可
  try {
    const { ocrImageUnderstandViaMcp } = await import('@/lib/mcp/ocr-client');
    const r = await ocrImageUnderstandViaMcp(savePath, { mode: 'screenshot' });
    if (r) {
      return `${raw}\n\n[截图已保存] ${savePath}\n[视觉描述] ${r.understanding}\n[vision] model=${r.model} (bob-ocr-mcp)`;
    }
    return `${raw}\n\n[截图已保存] ${savePath}\n[vision] bob-ocr-mcp 视觉模型不可用，截图未自动描述（请确认 OCR 插件常驻服务在线且已配置 vision）。`;
  } catch (e) {
    return `${raw}\n\n[截图已保存] ${savePath}\n[vision] 视觉描述失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** captures 目录保留上限（张） */
const CAPTURES_KEEP_MAX = 20;
/** captures 目录截图保留时长（ms，超过即删） */
const CAPTURES_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 清理预览截图目录：只保留最近 CAPTURES_KEEP_MAX 张，且删除超过 CAPTURES_KEEP_MS 的旧图。
 * 在每次 preview 截图存盘后调用（顺带清理），避免 .sandbox/captures/ 无限堆积。
 * 按文件 mtime 排序，仅删 .png 文件，失败静默（不影响截图主流程）。
 */
async function pruneCaptureDir(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const pngs = entries.filter((n) => n.toLowerCase().endsWith('.png'));
  const stats = await Promise.all(
    pngs.map(async (n) => {
      try {
        const st = await stat(join(dir, n));
        return { name: n, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const files = stats.filter((s): s is { name: string; mtimeMs: number } => s !== null);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // 新的在前

  const now = Date.now();
  const toRemove = new Set<string>();
  // 超过保留时长的
  for (const f of files) {
    if (now - f.mtimeMs > CAPTURES_KEEP_MS) toRemove.add(f.name);
  }
  // 超过数量上限的（保留最新的）
  for (let i = CAPTURES_KEEP_MAX; i < files.length; i++) {
    toRemove.add(files[i]!.name);
  }
  for (const name of toRemove) {
    await unlink(join(dir, name)).catch(() => {});
  }
}

/** Schema 内 description / enum 字符串的截断上限（字符数）。工具用途关键信息通常在前半段，截断不影响调用正确性。 */
const SCHEMA_DESC_MAX = 160;
const SCHEMA_ENUM_MAX = 120;
/** MCP 工具级（顶层）description 截断上限（字符）。MCP 工具描述来自远端且常冗长（browser.*、pkulaw 等可达数百上千字符），
 *  关键语义集中在前段；参数级说明已由 trimMcpSchema 截到 SCHEMA_DESC_MAX。仅作用于注入侧，实际调用不受影响。 */
const MCP_TOOL_DESC_MAX = 500;

/**
 * 精简 MCP 工具的 JSON Schema，降低每轮注入给模型的 token 量：
 *  - 递归截断超长的 description（参数说明）
 *  - 截断 enum 中超长的字符串项
 *  - 保留 type / required / properties / items / 组合关键字结构不变（不破坏模型调用正确性）
 * 仅作用于注入侧的 schema；实际 callTool 调用仍用原始工具名与参数，不受影响。
 */
function trimMcpSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(trimMcpSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'description' && typeof v === 'string' && v.length > SCHEMA_DESC_MAX) {
      out[k] = v.slice(0, SCHEMA_DESC_MAX) + '…';
    } else if (k === 'enum' && Array.isArray(v)) {
      out[k] = v.map((e) => (typeof e === 'string' && e.length > SCHEMA_ENUM_MAX ? e.slice(0, SCHEMA_ENUM_MAX) + '…' : e));
    } else if (
      k === 'properties' || k === 'items' || k === 'definitions' || k === '$defs' ||
      k === 'allOf' || k === 'anyOf' || k === 'oneOf' || k === 'additionalProperties'
    ) {
      out[k] = trimMcpSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 注册 MCP 工具到注册表。
 * 从 mcpManager 发现的工具动态构造 Tool 对象。
 *
 * @param opts.excludeServerIds 不注入的 server id 集合（如 exposeToChatNodes=false 的专属服务，
 *   仅限专属节点经专用路由调用；连接不受影响，只是普通 chat 节点看不到这些工具）。
 * @param opts.excludeToolNames 不注入的工具名集合（按 MCP 工具原始名精确匹配，如授权管理类工具，
 *   仅专属节点经专用路由调用，防止模型自我授权绕过用户确认）。
 */
export async function registerMcpTools(opts?: { excludeServerIds?: Set<string>; excludeToolNames?: Set<string> }): Promise<number> {
  // 清除上一次的 MCP 工具
  for (const name of registeredMcpNames) {
    registry.unregister(name);
  }
  registeredMcpNames = new Set();

  // 实时发现已连接 MCP 的工具；无连接时为空数组
  const liveTools = mcpManager.hasConnections() ? await mcpManager.discoverTools() : [];

  // 快照锁存：browser.* 工具一旦成功发现即更新快照并清零离线计数；
  // 发现不到时（桥离线/被禁用）继续用快照注册（字节稳定），连续超阈值才清空快照收敛。
  const isBrowserTool = (t: McpToolInfo): boolean =>
    /browser/i.test(t.serverId) || /browser/i.test(t.serverName);
  const liveBrowser = liveTools.filter(isBrowserTool);
  if (liveBrowser.length > 0) {
    browserMcpSnapshot = liveBrowser;
    browserOfflineStreak = 0;
  } else if (browserMcpSnapshot) {
    browserOfflineStreak++;
    if (browserOfflineStreak >= BROWSER_SNAPSHOT_MAX_STREAK) {
      browserMcpSnapshot = null;
      browserOfflineStreak = 0;
    }
  }

  // 工具集 = 实时非 browser 工具 + browser 快照（若有）。
  // 桥离线时 liveBrowser 为空但快照仍在 → browser.* 继续以相同字节注册（缓存不漂移）；
  // 从未连上过（快照空）→ 不注册 browser 工具（保持现状）。
  const mcpTools = browserMcpSnapshot
    ? [...liveTools.filter((t) => !isBrowserTool(t)), ...browserMcpSnapshot]
    : liveTools;

  for (const mcpTool of mcpTools) {
    // 专属服务不注入：exposeToChatNodes=false 的 MCP 工具仅限专用路由调用
    if (opts?.excludeServerIds?.has(mcpTool.serverId)) continue;
    // 工具级排除：授权管理类工具不注入模型上下文（防模型自我授权绕过用户确认），
    // 仅专属节点经专用路由（如 /api/bobby）可调用
    if (opts?.excludeToolNames?.has(mcpTool.name)) continue;
    // 敏感工具不注册给模型：browser.login_fill 仅服务端内部使用（登录弹窗凭据回填），
    // 模型不应获得任何写凭据的入口（模型本就不该持有用户账号密码）。
    if (/^browser\.login_fill$/.test(mcpTool.name)) continue;
    // 与内置工具重复的 MCP 工具不注册：ocr.recognize 与内置 ocr_document 功能重复
    // （ocr_document 内部经 bob-ocr-mcp 走同一识别管线，且带 quality/勾稽/upgrade 增值与
    // 本地 OCR 兜底），保留内置即可，避免模型在两个识别工具间误选。
    if (/^ocr\.recognize$/.test(mcpTool.name)) continue;
    // 浏览器类 MCP 工具需要更大的输出限制
    const isBrowser = /browser/i.test(mcpTool.serverId) || /browser/i.test(mcpTool.serverName);
    const maxOutput = isBrowser ? 200000 : 10000;

    // 按 serverId/工具名推断场景标注，避免所有 MCP 工具被当作通用工具全量注入
    const scenes = inferMcpToolScenes(mcpTool);
    // 未知场景（inferMcpToolScenes 返回空）→ 跳过注册，不注入模型（堵住隐性全量）
    if (scenes.length === 0) {
      console.warn(`[MCP] 未知工具场景，跳过注入：${mcpTool.serverId}/${mcpTool.name}`);
      continue;
    }

    const tool: Tool = {
      name: mcpTool.fullName,
      description: (() => {
        const d = `[MCP: ${mcpTool.serverName}] ${mcpTool.description}`;
        return d.length > MCP_TOOL_DESC_MAX ? d.slice(0, MCP_TOOL_DESC_MAX) + '…' : d;
      })(),
      parameters: (trimMcpSchema(mcpTool.inputSchema) as Record<string, unknown>) || { type: 'object', properties: {}, required: [] },
      category: '网络',
      scenes,
      maxOutput,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const raw = await mcpManager.callTool(mcpTool.fullName, args);
        // 方案3：browser.screenshot(describe:true) → 视觉模型翻译截图并附描述（剥离巨大 dataUrl）
        if (/browser\.screenshot$/.test(mcpTool.name) && args?.describe === true) {
          return describeScreenshotResult(raw);
        }
        // bob-preview-mcp：截图闭环 → 存盘 .sandbox/captures/ + 视觉描述渲染效果
        if (mcpTool.serverId === 'bob-preview-mcp' && /^(capture_preview|interact_preview)$/.test(mcpTool.name)) {
          return describePreviewCapture(raw);
        }
        // browser.detect_login 命中登录墙 → 结果追加强制指令，引导模型立即调用 browser.login
        // （BobWork 会在应用内弹出登录窗，用户输入账号密码后自动代填），避免模型停在检测结果上
        // 去请求用户手动登录或自行臆断"自动登录不可用"。
        if (/browser\.detect_login$/.test(mcpTool.name)) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.needsLogin === true) {
              return (
                raw +
                '\n\n[LOGIN REQUIRED] 当前页面需要登录才能继续。你必须立即调用 browser.login 发起登录——' +
                'BobWork 会在应用内弹出登录窗，用户输入账号密码后自动代填并提交，无需用户手动登录。' +
                '禁止停下来请求用户手动登录，禁止断言"自动登录不可用/组件缺失"。'
              );
            }
          } catch {
            // 非 JSON 保持原样
          }
        }
        return raw;
      },
    };
    registry.register(tool);
    registeredMcpNames.add(mcpTool.fullName);
  }

  return mcpTools.length;
}

// ============================================================
// 导出接口（保持与 route.ts 兼容）
// ============================================================

/** OpenAI API 格式的工具列表（内置 + 已注册的自定义/MCP 工具） */
/** 获取工具定义。activeScenes 为当前对话激活的场景集合；
 *  未传时返回全部工具（向后兼容，用于 /api/tools 等管理用途）。 */
export function getToolDefinitions(activeScenes?: Set<ToolScene>): ToolDefinition[] {
  return registry.toApiFormat(activeScenes);
}

/**
 * 节点"强制使用"MCP：在已按场景/画像过滤出的工具定义基础上，把指定 server（仅限
 * Store 中已启用且已注册进 registry 的）的工具无视场景过滤并入本轮定义。
 * - 与 skill 复选框"强制注入"对齐：勾选 = 该节点恒定保留，不再依赖场景关键词命中
 * - base 中已含的工具按名去重，并入结果仍由上游 buildAndSortToolDefs 统一排序
 * - forceServerIds 为原始 serverId（如 'pkulaw'），内部按 sanitizeToolName 对齐工具名前缀
 */
export function mergeForcedMcpToolDefs(base: ToolDefinition[], forceServerIds: string[]): ToolDefinition[] {
  if (!forceServerIds || forceServerIds.length === 0) return base;
  const prefixes = forceServerIds.map((id) => `mcp__${sanitizeToolName(id)}__`);
  const extras: ToolDefinition[] = [];
  const inBase = new Set(base.map((b) => b.function?.name).filter(Boolean));
  for (const t of registry.listAll()) {
    if (!prefixes.some((p) => t.name.startsWith(p))) continue;
    if (inBase.has(t.name)) continue;
    extras.push({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    });
  }
  return extras.length > 0 ? [...base, ...extras] : base;
}

/** 全量工具清单（含分类与场景标注），供工具管理界面（/api/tools）展示 */
export function listAllToolDefs(): Array<{ name: string; description: string; category: ToolCategory; scenes: ToolScene[] }> {
  return registry.listAll().map((t) => ({
    name: t.name,
    description: t.description,
    category: t.category,
    // 场景标注：工具自身 scenes 优先，其次静态映射表；均无 = 通用工具
    scenes: t.scenes ?? SCENED_TOOLS[t.name] ?? [],
  }));
}

/** 仅内置工具的静态列表（向后兼容） */
export const TOOL_DEFINITIONS: ToolDefinition[] = registry.toApiFormat();

/**
 * 根据工具名称执行工具
 *
 * 对应 Python 版 ToolCallLoop 中的工具执行逻辑：
 *   1. 解析参数 JSON
 *   2. 从注册表查找工具
 *   3. 执行并记录耗时
 *   4. 判断成功/失败
 */
export async function executeTool(
  toolName: string,
  argumentsJson: string,
  /** 请求级动态输出上限（按模型 contextWindow 计算，见 context-limits.toolOutputMaxForContext）；
   * 未传时用工具定义 maxOutput。外层统一截断，小模型自动收缩、1M 模型自动放大 */
  maxOutputOverride?: number,
  /** 工具执行上下文（OCR 过程级进度回调等），透传给工具执行器 */
  ctx?: ToolExecContext,
): Promise<ToolExecResult> {
  const start = Date.now();

  // 解析参数
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return {
      result: 'Argument JSON parse failed',
      durationMs: 0,
      success: false,
    };
  }

  // 查找工具
  const tool = registry.get(toolName);
  if (!tool) {
    return {
      result: `Unknown tool: ${toolName}. Available: ${registry.listAll().map((t) => t.name).join(', ')}`,
      durationMs: 0,
      success: false,
    };
  }

  // 执行工具
  try {
    const rawResult = await tool.execute(args, ctx);
    // 方案 B：支持 EnhancedToolResult（LLM 文本 + 展示卡片分离）
    const rawText = typeof rawResult === 'string' ? rawResult : rawResult.text;
    const cardHtml = typeof rawResult === 'string' ? undefined : rawResult.cardHtml;
    const limit = maxOutputOverride ?? tool.maxOutput;
    // 截断标注放头部而非尾部：长内容时模型易忽略尾部英文标注；
    // 头部显式标注让模型明确感知"输出被截断"，避免静默基于残缺内容决策。
    const result =
      rawText.length > limit
        ? `⚠️ 内容过长，仅返回前 ${limit} 字符（全文 ${rawText.length} 字符）。请勿据此判断完整内容。\n\n${rawText.slice(0, limit)}`
        : rawText;
    const durationMs = Date.now() - start;

    // 成功判断：不以错误前缀开头
    const errorPrefixes = [
      'Error:', 'Read failed:', 'Write failed:', 'Directory read failed:',
      'Search failed:', 'Execution failed:', 'Argument', 'Unknown tool:',
      'Command timed out', 'File not found', 'Directory not found', 'Path is',
    ];
    const success = !errorPrefixes.some((p) => result.startsWith(p));

    return { result, durationMs, success, cardHtml };
  } catch (e) {
    return {
      result: `Tool execution error: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - start,
      success: false,
    };
  }
}

/** 获取工具列表摘要（调试用） */
export function getToolSummary(): string {
  const categories = new Map<ToolCategory, string[]>();
  for (const tool of registry.listAll()) {
    const list = categories.get(tool.category) || [];
    list.push(tool.name);
    categories.set(tool.category, list);
  }

  const parts: string[] = [];
  for (const [cat, names] of categories) {
    parts.push(`[${cat}] ${names.join(', ')}`);
  }
  return `${registry.count()} tools: ${parts.join(' | ')}`;
}
