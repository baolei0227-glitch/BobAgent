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

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { readFile, writeFile, rename, unlink, readdir, stat, mkdir, access } from 'fs/promises';
import { join, resolve, relative, isAbsolute, sep, extname, basename, dirname } from 'path';
import { homedir } from 'os';
import { getCurrentProject } from '@/lib/project/project-manager';
import { initDb, createEdge } from '@/lib/db';
import { findNodeFileById, parseNodeMarkdown, createNodeMarkdown, writeNodeFile, generateNodeId, appendConversation, updateNodeFile } from '@/lib/node-markdown';
import { readSettingsFromFile } from '@/lib/settings-server';
import { logEgressUpload } from '@/lib/egress-audit';
import type { AppSettings, CustomToolDef } from '@/lib/settings';
import type { ProviderConfig, SelectedModel } from '@/lib/types';
import { PROVIDER_PRESETS, sanitizeBaseUrl } from '@/lib/types';
import type { TodoTask } from '@/lib/wanted/todo';
import { mcpManager, sanitizeToolName } from '@/lib/mcp/manager';
import type { McpToolInfo } from '@/lib/mcp/types';
import type { OcrProgressEvent } from '@/lib/mcp/ocr-client';
import { resolveAppRoot, PROJECT_DB_FILENAME, SANDBOX_DIRNAME, BOB_SANDBOX_DIRNAME, LOGS_DIRNAME } from '@/lib/app-root';
import { cleanupMdAnnotationSidecars } from '@/lib/md-annotations-cleanup';
import { writeAppFileAtomic } from '@/lib/sandbox/apps';
import { recordPipInstall } from '@/lib/python/pkg-usage';
import { resolveDocxTemplateScript } from '@/lib/docx-template-mcp';
import {
  USER_AGENTS_DIR,
  ALLOWED_AGENT_SCENES,
  listInstalledPackages,
  listMarketSource,
  manifestToProfile,
  type AgentPackageManifest,
} from '@/lib/agents/market-server';
import { AGENT_PROFILES } from '@/lib/agents/profiles';
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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

  // 待办 / 日程 / 计划（planner）
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


/** 技能目录（用户级，支持 BOBWORK_HOME 覆盖） */
const SKILLS_DIR = join(resolveAppRoot(), 'skills');

/** 内建技能根目录（应用打包自带）—— 优先使用，找不到再回退用户目录 SKILLS_DIR */
let _builtinSkillsRoot: string | undefined;
function getBuiltinSkillsRoot(): string {
  if (_builtinSkillsRoot !== undefined) return _builtinSkillsRoot;
  // 在 src/app/api/chat/tools.ts 中向上回溯到 projects/ 再找 assets/skills
  try {
    const candidates = [
      join(process.cwd(), 'assets', 'skills'),
      join(process.cwd(), 'projects', 'assets', 'skills'),
    ];
    // 基于当前文件路径推断（编译后 dist 中位置不同，以 cwd 为准更稳）
    for (const c of candidates) {
      try {
        const fs = require('fs');
        if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
          _builtinSkillsRoot = c;
          return _builtinSkillsRoot;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  _builtinSkillsRoot = '';
  return _builtinSkillsRoot;
}

/** 解析 skill 内的脚本路径：优先 builtin 内置目录，其次用户目录 ~/BobWork/skills/<skill>/scripts/<file> */
function resolveSkillScript(skillName: string, scriptFile: string): string | null {
  const builtinRoot = getBuiltinSkillsRoot();
  const candidates: string[] = [];
  if (builtinRoot) candidates.push(join(builtinRoot, skillName, 'scripts', scriptFile));
  candidates.push(join(SKILLS_DIR, skillName, 'scripts', scriptFile));
  const fs = require('fs');
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/**
 * 解析 skill 内的 L3 资源路径：<skill_root>/<skillName>/resources/<resourceFile>
 *  - resourceFile 为空时返回 skill 的 resources/ 目录路径（用于列目录）
 *  - 优先 builtin 内置目录，其次用户目录
 *  - 强制防穿越：resourceFile 不得含 ".."、不得绝对路径、不得含 path.sep 以外的分隔符
 */
function resolveSkillResource(skillName: string, resourceFile: string | undefined): { path: string; isDir: boolean } | null {
  const safeName = (skillName || '').trim();
  if (!safeName) return null;
  // skillName 本身也防穿越：只允许字母/数字/-/_/.，避免 skillName 里带路径
  if (!/^[\w.\-]+$/.test(safeName)) return null;

  let target: string | undefined;
  if (resourceFile && resourceFile.trim().length > 0) {
    let rf = resourceFile.trim();
    // 硬穿越防护
    if (isAbsolute(rf) || rf.includes('..')) return null;
    // 规范化：用 / 分隔符统一后再 join，保证不允许用反斜杠拼接 Windows 风格
    rf = rf.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rf) return null;
    const parts = rf.split('/');
    if (parts.some((p) => p === '..' || p === '.')) return null;
    target = join('resources', ...parts);
  } else {
    target = 'resources';
  }

  const builtinRoot = getBuiltinSkillsRoot();
  const candidates: string[] = [];
  if (builtinRoot) candidates.push(join(builtinRoot, safeName, target));
  candidates.push(join(SKILLS_DIR, safeName, target));
  const fs = require('fs');
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isDirectory()) return { path: c, isDir: true };
      if (st.isFile()) return { path: c, isDir: false };
    } catch { /* continue */ }
  }
  return null;
}

/**
 * 当前项目 AI 工作区：<项目>/homework/.ai-workspace/
 * 脚本执行、临时生成物等中间产物隔离在项目内，保持项目独立性。
 * 无激活项目时回退到 ~/BobWork/.sandbox 兜底。
 */
async function getWorkspacePath(): Promise<string> {
  try {
    const project = await getCurrentProject();
    const ws = join(project.path, 'homework', '.ai-workspace');
    try { require('fs').mkdirSync(join(ws, 'scripts'), { recursive: true }); } catch {}
    return ws;
  } catch {
    const sandbox = join(homedir(), 'BobWork', SANDBOX_DIRNAME);
    try { require('fs').mkdirSync(sandbox, { recursive: true }); } catch {}
    return sandbox;
  }
}

/** 当前项目根路径（无激活项目时回退 ~/BobWork/.sandbox 兜底） */
async function getProjectRootPath(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return project.path;
  } catch {
    return join(homedir(), 'BobWork', SANDBOX_DIRNAME);
  }
}

/** 从当前项目的 .local-roots.json 读取用户授权给 AI 的目录 */
export async function getLocalAuthorizedRoots(): Promise<string[]> {
  try {
    const project = await getCurrentProject();
    const rootsFile = join(project.path, '.local-roots.json');
    const fs = require('fs/promises');
    const content = await fs.readFile(rootsFile, 'utf-8');
    const config = JSON.parse(content);
    return (config.roots || []) as string[];
  } catch {
    return [];
  }
}

/** 确保可写目录存在 */
try { require('fs').mkdirSync(SKILLS_DIR, { recursive: true }); } catch {}

/** 工具审计日志路径：~/BobWork/.logs/tool-audit.log（自动清理 30 天前的行） */
const AUDIT_LOG_DIR = join(homedir(), 'BobWork', LOGS_DIRNAME);
const AUDIT_LOG_PATH = join(AUDIT_LOG_DIR, 'tool-audit.log');
const AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
let auditLastPruneTs = 0; // 上次执行清理的时间（每天最多清一次，避免频繁 IO）
try { require('fs').mkdirSync(AUDIT_LOG_DIR, { recursive: true }); } catch {}

function auditLog(entry: unknown): void {
  try {
    const fs = require('fs');
    const now = Date.now();
    // 每天最多清理一次过期行
    if (now - auditLastPruneTs > 86_400_000) {
      auditLastPruneTs = now;
      try {
        const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf-8');
        const cutoff = now - AUDIT_MAX_AGE_MS;
        const kept = raw.split('\n').filter((line: string) => {
          if (!line.trim()) return false;
          try {
            const t = new Date((JSON.parse(line).t as string) || '').getTime();
            return Number.isNaN(t) || t >= cutoff; // 解析失败保留，时间有效且未过期保留
          } catch {
            return false; // 解析失败的行丢弃
          }
        });
        if (kept.length > 0) {
          fs.writeFileSync(AUDIT_LOG_PATH, kept.join('\n') + '\n', 'utf-8');
        } else {
          fs.writeFileSync(AUDIT_LOG_PATH, '', 'utf-8');
        }
      } catch {}
    }
    const line = JSON.stringify({ t: new Date().toISOString(), ...(entry as Record<string, unknown>) }) + '\n';
    fs.appendFileSync(AUDIT_LOG_PATH, line, 'utf-8');
  } catch {}
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

/** 检查路径是否在可读范围内（AI 侧文件操作工具统一限制：当前项目 + 技能 + Bob Sandbox 小程序 + 用户授权目录） */
async function isReadablePath(resolvedPath: string): Promise<boolean> {
  const [projectRoot, localRoots] = await Promise.all([getProjectRootPath(), getLocalAuthorizedRoots()]);
  // 画布便签（sticky-notes/）为纯用户私有数据：不写入节点 .md、不接入搜索，AI 一律不可读
  const privateNotes = resolve(join(projectRoot, 'sticky-notes'));
  if (resolvedPath.startsWith(privateNotes + sep)) return false;
  const sandboxApps = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');
  const allRoots = [projectRoot, SKILLS_DIR, sandboxApps, ...localRoots];
  return allRoots.some(root => {
    const r = resolve(root);
    return resolvedPath === r || resolvedPath.startsWith(r + sep);
  });
}

/** 动态获取可读根路径描述字符串（用于错误提示） */
async function describeReadableRoots(): Promise<string> {
  const localRoots = await getLocalAuthorizedRoots();
  const base = '当前项目目录、~/BobWork/skills/、bob-sandbox/apps/（Bob Sandbox 小程序）';
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
 *  - wanted:    仅当对话内容涉及记忆/wanted（如查待办/笔记/偏好/工作报告/日历）才暴露
 *  - legal:     法律场景专用（法条检索/文书模板等），当前模型自动识别法律意图时暴露
 *  - node:      画布节点对话（nodeId 存在）才暴露——节点树/画布结构依赖工具（上游节点/祖先链/画布绘图）
 *  - audio:     对话涉及音频转写（转写/录音/语音关键词或音频附件）才暴露
 *  - skill:     对话涉及技能检索/安装（技能/能力/skill 关键词）才暴露
 *  - design:    对话涉及主题/前端界面（coding 节点自动放行）才暴露
 *  - ocr:       对话涉及图片/PDF 文字识别（OCR/扫描关键词或图片附件）才暴露 */
export type ToolScene = 'general' | 'coding' | 'wanted' | 'legal' | 'node' | 'audio' | 'skill' | 'design' | 'ocr' | 'admin' | 'office' | 'browser' | 'company' | 'team' | 'local' | 'notebook' | 'planner';

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

// ============================================================
// 工具注册表
// ============================================================

/** 专属工具 → 适用场景映射（两层过滤的静态标注）：
 *  - 未在此表中的工具 = 通用工具（任何场景可用）
 *  - coding:    AI Coding 节点（sandbox_app_id）才暴露
 *  - wanted:    对话内容涉及记忆/wanted 意图才暴露
 *  - legal:     法律意图才暴露
 *  - node:      画布节点对话（nodeId 存在）才暴露——节点树/画布结构依赖工具
 *  - audio/skill/design/ocr: 均按 L2 动态意图检测放行（见 route.ts activeScenes） */
const SCENED_TOOLS: Record<string, ToolScene[]> = {
  // ---- wanted 连通（记忆/待办/偏好/工作报告/日历）----
  read_todo: ['wanted'],
  remember_preference: ['wanted'],
  // ---- notebook（bob-notes 插件域 = Kar 专职子 agent 独有）----
  // 2026-09-06 试点收归：笔记能力不再随 wanted 注入普通对话（chat/sandbox/planner 均不含 notebook 场景），
  // 笔记诉求引导到 Kar（知识库）节点或 /note 指令——主 agent 不背负插件能力，子 agent 按业务方向专职。
  // 注：维护回路（read_raw_inbox / ingest_notes / review_notes / lint_notes / read_note_rules / set_note_rules）本就在 notebook 场景。
  read_notebook: ['notebook'],
  read_note: ['notebook'],
  read_note_history: ['notebook'],
  restore_note: ['notebook'],
  update_notebook: ['notebook'],
  delete_notebook: ['notebook'],
  create_note: ['notebook'],
  // 2026-09-06 追加收归：write_notebook_answer（答案/决策回填知识库）同样只归 notebook 场景——
  // 写读笔记相关工具在普通对话（General Chat / sandbox / planner 等不含 notebook 场景者）一律不再注入，
  // 沉淀知识库的入口统一为 Kar（知识库）节点或 /note 指令。
  write_notebook_answer: ['notebook'],
  // 注意：read_preferences 保持通用——系统提示条件式指示「任务涉及输出格式/引用规范等偏好时调用」，
  //   触发由模型自主判断（如用户说"用表格输出"无偏好字样），门控会阻断偏好遵循链路
  delete_preference: ['wanted'],
  update_preference: ['wanted'],
  // 便签（画布/记忆类）：按 wanted 意图触发（记忆/备忘/便签关键词）；planner 专项固定画像放行
  create_sticky_note: ['wanted', 'planner'],
  // ---- planner（日程安排专家）----
  query_schedule: ['planner', 'wanted'],
  query_todos: ['planner', 'wanted'],
  create_scheduled_todo: ['planner', 'wanted'],
  // ---- planner 计划树状态机（项目规划：里程碑 → 步骤 → 状态推进）----
  project_plan_start: ['planner'],
  project_plan_view: ['planner'],
  project_plan_add_steps: ['planner'],
  project_plan_step_status: ['planner'],

  // ---- 节点树/画布结构依赖（画布节点对话 nodeId 存在才暴露）----
  read_upstream_node: ['node'],
  read_manifest: ['node'],
  intern_search: ['node'],
  draw: ['node'],
  // ---- 音频转写（转写/录音/语音关键词或音频附件才暴露）----
  transcribe_audio: ['audio'],
  // ---- 主题设计（coding 节点自动放行，普通对话按主题/前端关键词放行）----
  get_current_theme: ['design'],
  // ---- OCR 文字识别（OCR/扫描关键词或图片/PDF 附件才暴露）----
  ocr_document: ['ocr'],
  // 图像 ROI 裁剪：OCR/图片处理流程配套（手写字段栏、印章、签名、日期裁剪）
  crop_image: ['ocr'],
  // ---- office 文档（Word 模板批量填充/占位符扫描：文档/模板/Word 意图才暴露）----
  fill_docx_templates: ['office'],
  scan_docx_templates: ['office'],
  // ---- admin 管理（配置/模型/沙盒运维：用户明确提及管理类操作才暴露，低频）----
  manage_mcp_server: ['admin'],
  manage_quick_launch: ['admin'],
  check_mcp_gaps: ['admin'],
  update_provider_config: ['admin'],
  list_configured_models: ['admin'],
  test_model: ['admin'],
  get_app_config: ['admin'],
  set_app_icon: ['admin'],
  sandbox_rollback: ['admin'],
  sandbox_export: ['admin'],
};

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
  // ---- Notion（记忆/知识）：wanted 场景（记笔记/查笔记）才注入，不再常驻 ----
  'notion': ['wanted'],
  // ---- 企业信息（查企业/工商/股权等企业意图才注入，不再常驻）----
  'tianyancha': ['company'],
  // ---- 飞书（日历/任务/文档 = wanted；不再作为 general 常驻）----
  'lark-feishu': ['wanted'],
  'feishu': ['wanted'],
  'lark': ['wanted'],
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
  if (/wanted|todo|notebook|calendar|remind|待办|笔记|日历|记忆|偏好|飞书|lark|feishu|notion/.test(low)) scenes.add('wanted');
  if (/code|git|github|repo|sdk|context|程序|开发|前端|编程/.test(low)) scenes.add('coding');
  if (/design|theme|ui|界面|主题|样式|配色/.test(low)) scenes.add('design');
  if (/skill|技能/.test(low)) scenes.add('skill');
  // 若任何专属场景匹配 → 返回（不额外加 general，防止全量注入）
  if (scenes.size > 0) return Array.from(scenes);
  // 无法识别的 MCP → 返回空（不注入）：registerMcpTools 对空场景工具跳过注册，
  // 堵住"未知 MCP 全量注入"导致的 token 浪费。用户自定义 MCP 若需启用，可在配置中显式声明场景。
  return [];
}

/**
 * 工具注册表。管理 agent 可用的所有工具。
 *
 * 对应 Python 版 ToolRegistry：
 *   - register(tool): 注册单个工具
 *   - get(name): 按名称查找
 *   - toApiFormat(): 批量转换为 OpenAI API 格式
 *   - byCategory(cat): 按分类筛选
 */
class ToolRegistry {
  private _tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  unregister(name: string): boolean {
    return this._tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  listAll(): Tool[] {
    return Array.from(this._tools.values());
  }

  byCategory(category: ToolCategory): Tool[] {
    return this.listAll().filter((t) => t.category === category);
  }

  toApiFormat(activeScenes?: Set<ToolScene>): ToolDefinition[] {
    return this.listAll()
      // 确定性顺序（按工具名排序）：消除 MCP 异步连接/注册顺序抖动，
      // 保证每轮工具定义前缀一字不差 → 命中网关前缀缓存（dsh 方案核心）
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((t) => {
        // 场景过滤：工具标注了 scenes 时，仅当任一场景被激活才暴露；未标注 = 通用工具
        if (!activeScenes || activeScenes.size === 0) return true;
        const scenes = t.scenes ?? SCENED_TOOLS[t.name];
        if (!scenes || scenes.length === 0) return true;
        return scenes.some((s) => activeScenes.has(s));
      })
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  count(): number {
    return this._tools.size;
  }
}

function getProviderBaseUrl(type: string): string {
  const bases: Record<string, string> = {
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    agentplan: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    codingplan: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    deepseek: 'https://api.deepseek.com/v1',
    openai: 'https://api.openai.com/v1',
    moonshot: 'https://api.moonshot.cn/v1',
  };
  return bases[type] || '';
}

/** read_todo 工具 —（已合并，DB shim）。从 events 表按 scope='all' 查询，
 *  兼容 filter (all/recent/week/today) + category 过滤，输出 Markdown 字符串。
 *  Note: 精细的时间/逾期/状态/关键词查询请走 ⌘F 面板 /todo check 命令（复用 schedule 查询管线）。
 */
async function toolReadTodo(args: Record<string, unknown>): Promise<string> {
  const filter = (args.filter as string) || 'all'; // all | recent | week | today
  const category = (args.category as string) || '';

  try {
    const project = await getCurrentProject();
    const db = await initDb(join(project.path, PROJECT_DB_FILENAME));

    const now = new Date();
    let rangeStart: Date | null = null;
    let rangeEnd: Date | null = null;
    if (filter === 'today') {
      rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      rangeEnd = new Date(rangeStart.getTime() + 86400_000);
    } else if (filter === 'week' || filter === 'recent') {
      rangeStart = new Date(now.getTime() - 7 * 86400_000);
      rangeEnd = new Date(now.getTime() + 60 * 86400_000);
    }

    // 基础条件：scope='all'，即 (project_id = current OR scope = 'global')
    const GLOBAL_PROJECT_ID = '__global__';
    const conds: string[] = [`(project_id = ? OR scope = 'global')`];
    const params: any[] = [project.id];

    // 时间过滤：只对有 start_time 的事件生效；无时间项始终返回（通过 OR start_time IS NULL 引入）
    if (rangeStart && rangeEnd) {
      conds.push(`(start_time IS NULL OR (datetime(start_time) < datetime(?) AND (end_time IS NULL OR datetime(end_time) >= datetime(?))))`);
      params.push(rangeEnd.toISOString(), rangeStart.toISOString());
    }

    // category 过滤：匹配 category_path_json 中任意一级节点包含目标关键词
    if (category) {
      const esc = category.replace(/[\\%_]/g, (c) => '\\' + c);
      conds.push(`category_path_json LIKE ? ESCAPE '\\'`);
      params.push(`%${esc}%`);
    }

    const rows = db.prepare(`
      SELECT * FROM events
      WHERE ${conds.join(' AND ')}
      ORDER BY COALESCE(start_time, '9999') ASC, created_at ASC
      LIMIT 500
    `).all(...params) as import('@/lib/db/index').EventRow[];

    if (rows.length === 0) {
      const filterDesc = filter === 'today' ? 'today' : filter === 'week' ? 'this week' : 'recorded';
      const catDesc = category ? ` in category "${category}"` : '';
      return `No tasks found for ${filterDesc}${catDesc}. (read_todo merged into events DB; use /todo check in the ⌘F panel for finer status/overdue/keyword filters.)`;
    }

    // 渲染为 Markdown：按分类树分组（事件条目格式）
    const lines: string[] = [
      '# TODO 待办记录 (merged: events DB)',
      `> ${rows.length} item(s) · filter=${filter}${category ? ` · category=${category}` : ''}`,
      '',
    ];

    const { ensureCategoryPath, insertLines } = await import('@/lib/wanted/category-tree');
    const UNCATEGORIZED = ['其他'];

    for (const row of rows) {
      let cat: string[] = [];
      try {
        const c = JSON.parse(row.category_path_json || '[]');
        if (Array.isArray(c)) cat = c;
      } catch { /* ignore */ }
      if (cat.length === 0) cat = UNCATEGORIZED;

      const insertAt = ensureCategoryPath(lines, cat);
      const priorityEmoji = row.priority === 'high' ? '🔴' : row.priority === 'low' ? '🟢' : '🟡';
      const check = row.status === 'done' ? 'x' : row.status === 'cancelled' ? 'x' : ' ';
      const entry = [`- [${check}] ${priorityEmoji} ${row.title}`];
      if (row.start_time) {
        const fmt = (iso: string) => {
          const d = new Date(iso);
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          const hh = String(d.getHours()).padStart(2, '0');
          const mi = String(d.getMinutes()).padStart(2, '0');
          return `${mm}/${dd} ${hh}:${mi}`;
        };
        const tstr = row.all_day === 1
          ? '全天'
          : (row.end_time ? `${fmt(row.start_time)} - ${fmt(row.end_time)}` : fmt(row.start_time));
        entry.push(`  - 时间: ${tstr}`);
      } else {
        entry.push('  - 时间: 无时间');
      }
      entry.push(`  - 优先级: ${row.priority || 'normal'}`);
      entry.push(`  - status: ${row.status}`);
      entry.push(`  - scope: ${row.scope}`);
      if (row.location) entry.push(`  - 地点: ${row.location}`);
      if (row.description) entry.push(`  - 描述: ${row.description.replace(/\n/g, ' ').slice(0, 300)}`);
      entry.push('');
      insertLines(lines, insertAt, entry);
    }

    const out = lines.join('\n');
    return out.length > 5000 ? (out.slice(0, 4997) + '...') : out;
  } catch (e) {
    return `Error reading TODO (DB shim): ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_notebook 工具 — 读取 Karpathy 式个人 wiki（索引优先 + 关键词，无向量检索）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_query（插件数据层）。 */
async function toolReadNotebook(args: Record<string, unknown>): Promise<string> {
  const mode = (args.mode as string) || 'index'; // index | full
  const query = (args.query as string) || ''; // 关键词（标题 + 标签 + 正文）
  const tag = (args.tag as string) || ''; // 标签精确匹配；逗号分隔多项 = AND

  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const queryArgs: Record<string, unknown> = {};
    if (query.trim()) queryArgs.q = query.trim();
    if (tag.trim()) queryArgs.tag = tag.trim();
    // 有词/标签检索时后端按 full 返回（命中候选才读正文，IO 可控），
    // 使 index 模式命中条目也能带摘要片段；纯浏览（无词）才用 index（零正文 IO）
    queryArgs.mode = mode === 'full' || query.trim() || tag.trim() ? 'full' : 'index';
    const r = await callNotes('query', queryArgs);
    if (!r.ok) return `Error reading Wiki: ${r.error}`;
    const data = r.data || {};
    const entries = Array.isArray(data.entries) ? (data.entries as Array<Record<string, unknown>>) : [];
    const total = typeof data.total === 'number' ? data.total : entries.length;
    const groups = Array.isArray(data.groups) ? (data.groups as Array<{ name?: string; tags?: Array<{ tag?: string; count?: number }> }>) : [];

    if (total === 0) {
      return 'Wiki is empty. No notes have been compiled yet. Use /note or /clip in the WANTED panel to drop material — it will be compiled into the wiki.';
    }

    if (mode === 'index') {
      // 检索场景：返回命中分布（基于命中结果重新计数）
      const labelOf: Record<string, string> = { type: '类型', topics: '主题' };
      const indexText = groups.length === 0
        ? '（暂无标签）'
        : groups.map((g) => {
            const items = (g.tags || []).map((t) => `${t.tag ?? ''}（${t.count ?? 0} 条）`).join('  ');
            return `【${labelOf[g.name ?? ''] ?? g.name}】${items}`;
          }).join('\n');
      let out = `Wiki 索引（共 ${total} 条笔记，命中 ${entries.length} 条）：\n${indexText}`;
      if (query.trim() || tag.trim()) {
        out += `\n\n命中条目：\n${renderNoteLines(entries, false, true)}`;
      }
      return out.length > 5000 ? truncate(out, 5000) : out;
    }

    // full 模式：命中 ≤3 条 → 完整正文；多条 → 只给标题+摘要+id（省 token，需要全文用 read_note id）
    if (entries.length === 0) {
      return `No notes found${query ? ` matching "${query}"` : ''}${tag ? ` with tag "${tag}"` : ''}. Use read_notebook (default index mode) to browse the index.`;
    }
    const out =
      entries.length <= 3
        ? renderNoteLines(entries, true)
        : `命中 ${entries.length} 条（内容较多，仅列摘要；需要某条完整正文请用 read_note <id>）：\n${renderNoteLines(entries, false, true)}`;
    return out.length > 5000 ? truncate(out, 5000) : out;
  } catch (e) {
    return `Error reading Wiki: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_note 工具 — 按 id 读单条 wiki 笔记完整正文（read_notebook 命中多条只给摘要时，用它精读确认）。
 *  经宿主 callNotes('get') 转发 bob-notes-mcp notes_get（插件数据层）。 */
async function toolReadNote(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id required（笔记 id 必填，read_notebook 命中条目会带 id）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('get', { id });
    if (!r.ok) return `Error reading note: ${r.error}`;
    const entry = ((r.data || {}).entry || {}) as Record<string, unknown>;
    const title = String(entry.title ?? '');
    const tagsArr = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
    const tags = tagsArr.length > 0 ? `[${tagsArr.join(' · ')}] ` : '';
    const d = entry.date ? `（${entry.date}）` : '';
    const body = String(entry.content ?? '').trim();
    // 关联展示（🔗）：让 AI 精读时看到这篇连着谁（出链+反链），支持顺链理解/追问
    const linkedRaw = (entry.linked ?? null) as { out?: Array<{ id?: string; title: string; resolved: boolean }>; in?: Array<{ id?: string; title: string; resolved: boolean }> } | null;
    const linkedParts: string[] = [];
    if (linkedRaw) {
      const out = Array.isArray(linkedRaw.out) ? linkedRaw.out : [];
      const inRefs = Array.isArray(linkedRaw.in) ? linkedRaw.in : [];
      if (out.length > 0) linkedParts.push(`关联出链：${out.map((l) => l.title).join(' / ')}`);
      if (inRefs.length > 0) linkedParts.push(`被这些笔记关联：${inRefs.map((l) => l.title).join(' / ')}`);
    }
    const head = `- 💡 ${tags}${title}${d}`;
    const linkLine = linkedParts.length > 0 ? `\n🔗 ${linkedParts.join('；')}` : '';
    if (!body) return `${head}${linkLine}`;
    return `${head}${linkLine}\n${body}`;
  } catch (e) {
    return `Error reading note: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_note_history 工具 — 查看某条 wiki 笔记的历史版本列表（正文每次被覆盖前自动快照）。
 *  经宿主 callNotes('history') 转发 bob-notes-mcp notes_history。供模型判断"是否被改坏需回滚"。 */
async function toolReadNoteHistory(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id required（笔记 id 必填）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('history', { id });
    if (!r.ok) return `Error reading history: ${r.error}`;
    const data = (r.data || {}) as { snapshots?: Array<{ time: number }>; title?: string };
    const snaps = Array.isArray(data.snapshots) ? data.snapshots : [];
    if (snaps.length === 0) return `笔记「${data.title || id}」暂无历史版本（从未被覆盖）。`;
    const lines = snaps.map((s, i) => {
      const t = new Date(s.time);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${i + 1}. ${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())} (time=${s.time})`;
    });
    return `「${data.title || id}」历史版本（共 ${snaps.length} 个，最新的在前）：\n${lines.join('\n')}\n需要回滚时用 restore_note <id> <time>。`;
  } catch (e) {
    return `Error reading history: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** restore_note 工具 — 把笔记回滚到某历史版本（正文回滚；类型/标签/链接保留当前；回滚本身也留档可反悔）。
 *  仅当用户明确要求恢复旧版本时调用；id 用 read_note 的 w-xxx，time 用 read_note_history 返回的 time 值。 */
async function toolRestoreNote(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const time = Number(args.time);
  if (!id) return 'Error: id required（笔记 id 必填）';
  if (!Number.isFinite(time) || time <= 0) return 'Error: time required（历史版本 time，用 read_note_history 查看）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('restore', { id, time });
    if (!r.ok) return `恢复失败: ${r.error}`;
    const data = (r.data || {}) as { reply?: string };
    return data.reply || '已恢复到该历史版本。';
  } catch (e) {
    return `恢复失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 把 notes_query 返回的条目渲染为模型可读文本（展示层，非笔记实现）
 *  digest=true 时只列标题+标签+摘要（省 token 的浏览形态，供 read_note <id> 精读前筛选） */
function renderNoteLines(
  entries: Array<Record<string, unknown>>,
  withBody: boolean,
  digest = false,
): string {
  if (entries.length === 0) return '（无匹配条目）';
  return entries
    .map((e) => {
      const id = String(e.id ?? '');
      const title = String(e.title ?? '');
      const tagsArr = Array.isArray(e.tags) ? (e.tags as string[]) : [];
      const tags = tagsArr.length > 0 ? `[${tagsArr.join(' · ')}] ` : '';
      const d = e.date ? `（${e.date}）` : '';
      const head = `- 💡 ${tags}${title}${d}`;
      if (digest) {
        const body = String(e.content ?? '').replace(/\s+/g, ' ').trim();
        const excerpt = body ? `\n  ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}` : '';
        return `${head}\n  id: ${id}${excerpt}`;
      }
      const body = withBody ? String(e.content ?? '') : '';
      return body ? `${head}\n  ${body}` : head;
    })
    .join('\n\n');
}

/** update_notebook 工具 — 按 id 修改一条 wiki 笔记（只改传入字段，title/tags/content 未传则保留）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_update（插件数据层）。 */
async function toolUpdateNotebook(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id required（笔记 id 必填，可用 read_notebook full 模式或 /note check 查看）';
  const patch: { title?: string; content?: string; tags?: string[] } = {};
  if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
  if (typeof args.content === 'string' && args.content.trim()) patch.content = args.content.trim();
  if (Array.isArray(args.tags)) {
    const tags = args.tags.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 5);
    if (tags.length > 0) patch.tags = tags;
  }
  if (patch.title === undefined && patch.content === undefined && patch.tags === undefined) {
    return 'Error: title / content / tags required（至少提供新标题 title、新内容 content 或新标签 tags 之一）';
  }
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('update', { id, ...patch });
    if (!r.ok) return `修改笔记失败: ${r.error}`;
    const data = r.data || {};
    const entry = (data.entry || {}) as Record<string, unknown>;
    const title = String(entry.title ?? '');
    const tagsArr = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
    const tagStr = tagsArr.length > 0 ? `[${tagsArr.join('/')}] ` : '';
    const date = entry.date ? String(entry.date) : '';
    const body = patch.content || String(entry.content ?? '');
    return `已修改笔记「${title}」${tagStr}（${date || '无日期'}）：\n${body}`;
  } catch (e) {
    return `修改笔记失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** delete_notebook 工具 — 按 id 删除一条 wiki 笔记（不可恢复）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_delete（插件数据层）。 */
async function toolDeleteNotebook(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return 'Error: id required（笔记 id 必填，可用 read_notebook full 模式或 /note check 查看）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('delete', { id });
    if (!r.ok) return `删除笔记失败: ${r.error}`;
    const data = r.data || {};
    const title = String(data.title ?? '');
    const remain = typeof data.remaining === 'number' ? data.remaining : '';
    return `已删除笔记「${title}」${remain !== '' ? `（剩余 ${remain} 条）` : ''}。`;
  } catch (e) {
    return `删除笔记失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** write_notebook_answer 工具 — 答案回填：把 AI 问答/分析的产出沉淀为 wiki 笔记（Karpathy 知识复利）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_backfill（插件数据层）。 */
async function toolWriteNotebookAnswer(args: Record<string, unknown>): Promise<string> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!title && !content) return 'Error: title / content required（回填需要标题 title 或内容 content 至少一个）';
  const tags = Array.isArray(args.tags) ? args.tags.filter((s): s is string => typeof s === 'string') : [];
  const links = Array.isArray(args.links) ? args.links.filter((s): s is string => typeof s === 'string') : [];
  const type = (['concept', 'source', 'note', 'todo'].includes(String(args.type)) ? args.type : 'note') as string;
  const mergeInto = typeof args.merge_into === 'string' ? args.merge_into.trim() : '';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('backfill', { title, content, tags, links, type, ...(mergeInto ? { merge_into: mergeInto } : {}) });
    if (!r.ok) return `回填失败: ${r.error}`;
    const data = r.data || {};
    const entry = (data.entry || {}) as Record<string, unknown>;
    if (!entry || !(entry.id || entry.title)) {
      return String(data.reply || '回填完成');
    }
    const et = String(entry.title ?? '');
    const tagsArr = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];
    const body = String(entry.content ?? '');
    const actionNote = data.merged ? '（已归并更新既有笔记，未新建）' : '';
    return `${data.reply ?? '已回填'}${actionNote}\n标题：${et}\n标签：[${tagsArr.join(' · ') || '无'}]\n内容：\n${body}`;
  } catch (e) {
    return `回填失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** create_note 工具 — 用户主动记笔记（Karpathy raw-first）：内容作为素材投放 raw/ 并触发一次编译，
 *  由插件大脑决定标题/结构/标签并把同主题内容归并入既有笔记（更正/新知识自动更新原条目）。
 *  与 /note 语义等价；不再由人/对话模型直写 wiki 层。 */
async function toolCreateNote(args: Record<string, unknown>): Promise<string> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!title && !content) return 'Error: title / content required（内容必填）';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const add = await callNotes('add_raw', { text: content, ...(title ? { title } : {}) });
    if (!add.ok) return `投放失败: ${add.error}`;
    const raw = (add.data || {}).raw as { id?: string; title?: string } | undefined;
    const ing = await callNotes('ingest', {});
    if (!ing.ok) return `素材已投放，但编译失败: ${ing.error}`;
    const d = ing.data || {};
    const entries = Array.isArray(d.entries) ? (d.entries as Array<Record<string, unknown>>) : [];
    const compiled = typeof d.compiled === 'number' ? d.compiled : 0;
    const label = raw?.title ?? title ?? content.slice(0, 20);
    if (compiled === 0) {
      return `已投放素材「${label}」，暂未生成新笔记（同主题可能已归并入既有条目，或待 ingest）。`;
    }
    const lines = entries.map((e, i) => `${i + 1}. ${String(e.title ?? '')}`).join('\n');
    return `已投放并编译「${label}」：${compiled} 条素材 → ${entries.length} 条笔记。同主题会自动归并入既有笔记——更正/新知识投喂后，大脑会把内容并入那篇原条目。\n${lines}`;
  } catch (e) {
    return `记录失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** ingest_notes 工具 — 编译 pending raw → wiki（Karpathy ingest 回路；note 节点独享）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_ingest，实际编译由插件大脑模型执行。 */
async function toolIngestNotes(args: Record<string, unknown>): Promise<string> {
  try {
    const idsRaw = args.ids;
    const ids = Array.isArray(idsRaw) ? idsRaw.map((s) => String(s)).filter(Boolean) : undefined;
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('ingest', ids && ids.length > 0 ? { ids } : {});
    if (!r.ok) return `编译失败: ${r.error}`;
    const data = r.data || {};
    const entries = Array.isArray(data.entries) ? (data.entries as Array<Record<string, unknown>>) : [];
    const compiled = typeof data.compiled === 'number' ? data.compiled : 0;
    if (compiled === 0) return String(data.reply || '没有待编译的素材');
    const lines = entries.map((e, i) => {
      const tags = Array.isArray(e.tags) && (e.tags as string[]).length ? ` [${(e.tags as string[]).join(' · ')}]` : '';
      return `${i + 1}. ${String(e.title ?? '')}${tags}`;
    });
    return `已编译 ${compiled} 条素材 → ${entries.length} 条笔记：\n${lines.join('\n')}`;
  } catch (e) {
    return `编译失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_raw_inbox 工具 — 列出 raw/ 素材箱清单（id/title/source/status/createdAt + 正文预览）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_raw_list（插件数据层）。
 *  用途：对话里先浏览素材 → 判断哪些待编译、哪些内容与既有 wiki 重复（可归并而非新建）。 */
async function toolReadRawInbox(args: Record<string, unknown>): Promise<string> {
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const statusArg = typeof args.status === 'string' ? args.status.trim() : '';
    const status = statusArg === 'compiled' || statusArg === 'uncompiled' ? statusArg : 'all';
    const r = await callNotes('raw_list', { status });
    if (!r.ok) return `读取素材箱失败: ${r.error}`;
    const d = (r.data || {}) as {
      total?: number; matched?: number; pending?: number;
      items?: Array<{ id?: string; title?: string; source?: string; status?: string; createdAt?: string; preview?: string }>;
    };
    const items = Array.isArray(d.items) ? d.items : [];
    if (items.length === 0) {
      const hint = status === 'all' ? '素材箱是空的。用 /clip 或 /note 投放素材后再来。' : `没有 ${status} 状态的素材。`;
      return hint;
    }
    const lines = items.map((it, i) => {
      const state = it.status === 'compiled' ? '✓已编译' : '· 待编译';
      const src = it.source ? ` 来源:${it.source}` : '';
      const time = it.createdAt ? `  ${(it.createdAt || '').slice(0, 10)}` : '';
      return `${i + 1}. [${it.id}] ${state} ${String(it.title || '').slice(0, 60)}${src}${time}\n   ${String(it.preview || '').slice(0, 90)}`;
    });
    return `Raw 素材箱（共 ${d.total ?? 0} 条，待编译 ${d.pending ?? 0}，命中 ${d.matched ?? items.length}）\n` + lines.join('\n');
  } catch (e) {
    return `读取素材箱失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** review_notes 工具 — 回看打捞：最久未回看笔记由插件大脑判断 rescue（置顶/重写）或 sink（下沉，不删除）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_review。 */
async function toolReviewNotes(): Promise<string> {
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('review', {});
    if (!r.ok) return `回看失败: ${r.error}`;
    const d = (r.data || {}) as { reply?: string; reviewed?: number; rescued?: number; sunk?: number };
    return String(d.reply || `回看完成：${d.reviewed ?? 0} 篇，rescue ${d.rescued ?? 0} / sink ${d.sunk ?? 0}`);
  } catch (e) {
    return `回看失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** lint_notes 工具 — 知识库自检：断链/孤立/重复标题（确定性）+ 跨笔记矛盾检测（插件大脑）。
 *  经宿主 /api/notebook 语义转发 bob-notes-mcp notes_lint。 */
async function toolLintNotes(): Promise<string> {
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('lint', {});
    if (!r.ok) return `自检失败: ${r.error}`;
    const d = (r.data || {}) as { reply?: string; issues?: unknown[] };
    const issues = Array.isArray(d.issues) ? (d.issues as string[]) : [];
    if (issues.length === 0) return String(d.reply || '自检通过：无断链、无孤立笔记、无重复标题、无表述矛盾。');
    return `发现 ${issues.length} 个问题：\n${issues.map((s) => `· ${s}`).join('\n')}`;
  } catch (e) {
    return `自检失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_note_rules 工具 — 读取知识库整理规则（SCHEMA.md，用户偏好宪章；note 节点独享）。
 *  大脑的 ingest/review 每次调用前都会读取并遵守它。 */
async function toolReadNoteRules(): Promise<string> {
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('schema_get', {});
    if (!r.ok) return `读取整理规则失败: ${r.error}`;
    const content = String((r.data || {}).content ?? '');
    if (!content) return '整理规则为空。';
    const truncated = content.length > 4000 ? `${content.slice(0, 4000)}\n…（截断）` : content;
    return `当前知识库整理规则（SCHEMA.md，大脑 ingest/review 每次调用前都会遵守）：\n${truncated}`;
  } catch (e) {
    return `读取整理规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** set_note_rules 工具 — 追加（默认）或覆写知识库整理规则（用户表达整理偏好时调用，note 节点独享） */
async function toolSetNoteRules(args: Record<string, unknown>): Promise<string> {
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content) return 'Error: content required（需要规则/偏好内容）';
  const append = args.append === true || args.append === 'true';
  try {
    const { callNotes } = await import('@/lib/mcp/notes-bridge');
    const r = await callNotes('schema_set', { content, ...(append ? { append: true } : {}) });
    if (!r.ok) return `保存整理规则失败: ${r.error}`;
    const data = r.data || {};
    const note = String(data.note || '');
    if (append) {
      return note
        ? `⚠️ ${note}`
        : `✅ 已把这条整理偏好记入 SCHEMA.md（大脑下次 ingest/review 起遵守）：\n「${content}」`;
    }
    return `✅ 整理规则已保存。`;
  } catch (e) {
    return `保存整理规则失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** remember_preference 工具 — 记录用户偏好/习惯（仅用户显式要求记住时调用，带类型元数据） */
async function toolRememberPreference(args: Record<string, unknown>): Promise<string> {
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content) return 'Error: content is required（偏好内容必填，例如「用户习惯用表格输出」）';
  const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : undefined;
  try {
    const { addPreference } = await import('@/lib/wanted/preferences');
    const res = await addPreference(content, type ? { type } : undefined);
    if (res.added) {
      return `已记住用户偏好（类型：${type || '通用'}，共 ${res.total} 条）：「${content}」。此后所有节点每轮对话都会参考该偏好。`;
    }
    return `该偏好此前已记录：「${content}」（共 ${res.total} 条，未重复添加）。`;
  } catch (e) {
    return `记住偏好失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** read_preferences 工具 — 列出用户偏好（带序号/类型/时间，支持按类型过滤） */
async function toolReadPreferences(args: Record<string, unknown>): Promise<string> {
  const typeFilter = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : '';
  try {
    const { listPreferences } = await import('@/lib/wanted/preferences');
    const prefs = typeFilter
      ? (await listPreferences()).filter((p) => p.type === typeFilter)
      : await listPreferences();
    if (prefs.length === 0) {
      return typeFilter
        ? `没有类型为「${typeFilter}」的用户偏好。可先 read_preferences 查看全部，或让用户说「记住：……」来新增。`
        : '暂无已记录的用户偏好。当用户明确说「记住 / 以后都这样」时，调用 remember_preference 记录。';
    }
    const list = prefs.map((p) => {
      const meta = [p.type && p.type !== '通用' ? p.type : '', p.createdAt ? `记录于 ${p.createdAt}` : '', p.source && p.source !== 'chat' ? `来源 ${p.source}` : ''].filter(Boolean).join('，');
      return `${p.index}. ${p.content}${meta ? `（${meta}）` : ''}`;
    }).join('\n');
    const scope = typeFilter ? `类型「${typeFilter}」` : '全部';
    return `已记录 ${prefs.length} 条用户偏好（${scope}，全局长期记忆，所有节点每轮参考）：\n${list}\n\n删除：调用 delete_preference（传 index 序号）。`;
  } catch (e) {
    return `读取偏好失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** delete_preference 工具 — 按序号删除一条用户偏好（手动遗忘） */
async function toolDeletePreference(args: Record<string, unknown>): Promise<string> {
  const raw = typeof args.index === 'number' ? args.index : parseInt(String(args.index ?? ''), 10);
  const index = Number.isFinite(raw) ? Math.floor(raw) : 0;
  if (index < 1) return 'Error: index required（偏好序号必填，1-based，可用 read_preferences 查看）';
  try {
    const { removePreference } = await import('@/lib/wanted/preferences');
    const res = await removePreference(index);
    if (res.removed) return `已删除第 ${index} 条用户偏好，剩余 ${res.remaining} 条。`;
    return `删除失败：第 ${index} 条不存在（当前共 ${res.remaining} 条）。可用 read_preferences 查看有效序号。`;
  } catch (e) {
    return `删除偏好失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** update_preference 工具 — 按序号原子修改一条偏好（只改传入字段，元数据保留） */
async function toolUpdatePreference(args: Record<string, unknown>): Promise<string> {
  const raw = typeof args.index === 'number' ? args.index : parseInt(String(args.index ?? ''), 10);
  const index = Number.isFinite(raw) ? Math.floor(raw) : 0;
  if (index < 1) return 'Error: index required（偏好序号必填，1-based，可用 read_preferences 查看）';
  const patch: { content?: string; type?: string } = {};
  if (typeof args.content === 'string' && args.content.trim()) patch.content = args.content.trim();
  if (typeof args.type === 'string' && args.type.trim()) patch.type = args.type.trim();
  if (patch.content === undefined && patch.type === undefined) {
    return 'Error: content or type required（至少提供新内容 content 或新类型 type 之一）';
  }
  try {
    const { updatePreference } = await import('@/lib/wanted/preferences');
    const res = await updatePreference(index, patch);
    if (!res.updated || !res.preference) {
      return `修改失败：${res.error ?? '未知错误'}`;
    }
    const p = res.preference;
    return `已修改第 ${index} 条偏好：\n内容：${p.content}\n类型：${p.type}（记录于 ${p.createdAt}，来源 ${p.source}）\n剩余 ${res.remaining} 条。`;
  } catch (e) {
    return `修改偏好失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}



// ============================================================
// 辅助函数
// ============================================================

/**
 * 路径解析 — 对应 Python 版 Path.expanduser() + resolve()
 *
 * 支持：
 *   - ~ 展开为用户主目录
 *   - 相对路径基于当前项目 AI 工作区（homework/.ai-workspace/）
 *   - 绝对路径直接使用
 */
async function resolvePath(inputPath: string): Promise<string> {
  // 展开 ~ 为用户主目录（对应 Python 的 Path.expanduser()）
  let p = inputPath;
  if (p === '~') {
    p = homedir();
  } else if (p.startsWith('~/')) {
    p = join(homedir(), p.slice(2));
  }

  if (isAbsolute(p)) {
    return resolve(p);
  }

  // homework/、attachments/、materials/ 路径应从项目根解析，而非 .ai-workspace 工作区
  const normalized = p.replace(/\\/g, '/');
  if (normalized.startsWith('homework/') || normalized === 'homework') {
    const projectRoot = await getProjectRootPath();
    const relInHomework = normalized === 'homework' ? '' : normalized.slice('homework/'.length);
    // 存储平铺：homework/ 所有产物直接落在根目录，不生成 kind 子文件夹；
    // 侧边栏按文件类别标签分组展示（见 projects scanHomeworkByKind）。
    return resolve(join(projectRoot, 'homework', relInHomework));
  }
  if (normalized.startsWith('attachments/') || normalized === 'attachments') {
    return resolve(join(await getProjectRootPath(), p));
  }
  if (normalized.startsWith('materials/') || normalized === 'materials') {
    return resolve(join(await getProjectRootPath(), p));
  }
  // .sandbox/ 路径映射到 BobWork 根目录下的隐藏沙盒目录（captures 等临时产物）
  if (normalized.startsWith('.sandbox/') || normalized === '.sandbox') {
    return resolve(join(resolveAppRoot(), p));
  }
  // bob-sandbox/ 路径映射到 BobWork 根目录下的小程序专用目录
  if (normalized.startsWith('bob-sandbox/') || normalized === 'bob-sandbox') {
    return resolve(join(resolveAppRoot(), p));
  }

  return resolve(join(await getWorkspacePath(), p));
}

/** bob-sandbox/apps/ 根目录（Bob Sandbox 小程序目录） */
const SANDBOX_APPS_DIR = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');

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

/** 截断输出，附加字符计数 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n...(truncated, ${text.length} chars total)`;
}

/** 读取类工具内部返回上限（read_file / read_attachment / read_material / run_command 等）。
 * 等于 1M 上下文模型的动态输出上限（context-limits.toolOutputMaxForContext ×15%），
 * 让 1M 模型下能一次读到更多内容；最终按请求模型的外层 maxOutput 二次截断（见 executeTool），
 * 小模型自动收缩到 8000，无需在内部硬编码模型差异。
 */
const READ_CAPACITY = 150000;

/** 扫描件 PDF OCR 单次返回上限：超过时按页边界截断，提示模型用 pages 参数续读。
 *  与 READ_CAPACITY 对齐（1M 上下文工具输出上限 15 万字符），不再用旧的 5 万死值。 */
const OCR_MAX_LENGTH = 150000;

/** 附件/文档文本的通用分片返回：从 offset 处截取单次上限，头部标注实际区间；发生截断时给出续读 offset。
 *  读取类工具的内层上限按 1M 模型设定，外层仍会按模型上下文二次截断——
 *  因此只要触发截断就提示模型携带 offset 续读，避免长文档后半内容拿不到。 */
function chunkedAttachmentReturn(
  path: string,
  size: number,
  typeLabel: string,
  fullText: string,
  offset: number,
  cap = READ_CAPACITY,
): string {
  const total = fullText.length;
  if (total === 0) return `Attachment: ${path} (${formatSize(size)}, ${typeLabel}, empty)\n\n(文件内容为空)`;
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.min(total, start + cap);
  const part = fullText.slice(start, end);
  const header = `Attachment: ${path} (${formatSize(size)}, ${typeLabel}, chars ${start}-${end} of ${total})`;
  if (end >= total) return `${header}\n\n${part}`;
  return `${header}\n\n${part}\n\n...(本段 ${part.length} 字符，共 ${total} 字符；继续读取后半部分请再次调用本工具并携带 offset="${end}")`;
}

/** mammoth 无内置 TS 类型：仅声明 read_attachment 用到的 convertToHtml */
interface MammothLike {
  convertToHtml: (
    input: { path?: string; buffer?: Buffer },
    options?: Record<string, unknown>,
  ) => Promise<{ value: string; messages: unknown[] }>;
}

/** 把「已用 \n（段落/行尾）与 \u0001（单元格分隔）标记过的 XML/HTML」收敛成紧凑文本行 */
function collapseMarkedLines(marked: string): string {
  const s = marked
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
  const lines: string[] = [];
  for (const raw of s.split('\n')) {
    const cells = raw.split('\u0001').map((c) => c.replace(/\s+/g, ' ').trim());
    // 去掉行尾空列与行首空列标记，避免悬挂分隔符
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    const line = cells.join(' | ').replace(/^\s*\|\s*/, '').trim();
    if (line.length > 0) lines.push(line);
  }
  return lines.join('\n');
}

/** docx → 结构化文本：mammoth HTML（保留段落/标题/有序列表编号/表格行列）→ 紧凑文本 */
function docxHtmlToText(html: string): string {
  let s = html;
  // 有序列表编号（支持 start 属性），避免列表退化为无编号的 "- "
  s = s.replace(/<ol([^>]*)>([\s\S]*?)<\/ol>/gi, (_m, attrs: string, inner: string) => {
    const start = Number((/start="(\d+)"/i.exec(String(attrs)) ?? [])[1] ?? 1);
    let n = start;
    const numbered = inner.replace(/<li([^>]*)>([\s\S]*?)<\/li>/gi, (_lm, _la: string, body: string) => `${n++}. ${body}`);
    return `\n${numbered}`;
  });
  s = s.replace(/<table[^>]*>/gi, '\n');
  s = s.replace(/<\/table>/gi, '\n');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/td>|<\/th>/gi, '\u0001');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/h([1-6])>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/div>/gi, '\n');
  return collapseMarkedLines(s);
}

/** docx 兜底（无 mammoth 时）：直接解 document.xml 做轻量结构提取 */
function docxXmlFallbackText(xml: string): string {
  return collapseMarkedLines(
    xml
      .replace(/<w:tab\/>/g, '\u0001')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:tc>/g, '\u0001')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:p>/g, '\n'),
  );
}

/**
 * 单页密集阈值：页转录字符数超过该值时，视为"接近单页转录上限（max_tokens 8192）"，
 * 页内数据可能被视觉模型静默截断（无应用层截断标记）。此时在页首标注警示。
 */
const OCR_DENSE_PAGE_THRESHOLD = 6000;

/** OCR 页块：index 为 1-based 页码 */
interface OcrPageBlock {
  index: number;
  text: string;
}

/**
 * 解析 read_attachment 的 pages 参数：'1-5'、'3'、'6,8-10' → 页码数组（1-based）。
 * 返回 null 表示"未指定/非法 → 读取全部页"。
 */
function parsePageRange(spec: string | undefined, maxPage: number): number[] | null {
  if (!spec || !spec.trim()) return null;
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null; // 非法格式 → 忽略参数
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let p = a; p <= Math.min(b, maxPage); p++) {
      if (p >= 1 && !out.includes(p)) out.push(p);
    }
  }
  return out.length > 0 ? out.sort((x, y) => x - y) : null;
}

/** 解析 read_attachment 的 frame_range 参数：'0-2'、'1'、'0,2-3' → 帧索引数组（0-based，用于视频帧段分片）。
 *  返回 null 表示"未指定/非法 → 分析全部帧"。 */
function parseFrameRange(spec: string | undefined, maxFrame: number): number[] | null {
  if (!spec || !spec.trim()) return null;
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null; // 非法格式 → 忽略参数
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let p = a; p <= Math.min(b, maxFrame); p++) {
      if (p >= 0 && !out.includes(p)) out.push(p);
    }
  }
  return out.length > 0 ? out.sort((x, y) => x - y) : null;
}

/**
 * 从合并的 OCR 文本中按 [Page N] 块切分为页数组（用于命中缓存的全文重新分页）。
 * 无 [Page N] 标记时返回空数组（调用方原样返回）。
 */
function splitOcrTextToPages(text: string): OcrPageBlock[] {
  const re = /\[Page (\d+)\]\n?/g;
  const pages: OcrPageBlock[] = [];
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  let lastPage = -1;
  while ((m = re.exec(text)) !== null) {
    if (lastPage > 0) {
      pages.push({ index: lastPage, text: text.slice(lastIndex, m.index).trim() });
    }
    lastPage = parseInt(m[1], 10);
    lastIndex = m.index + m[0].length;
  }
  if (lastPage > 0) pages.push({ index: lastPage, text: text.slice(lastIndex).trim() });
  return pages;
}

/**
 * 组装扫描件 OCR 的 read_attachment 返回：
 * 1. 按 pages 参数筛选页（未指定则读全部）；
 * 2. 超过 OCR_MAX_LENGTH 时按页边界截断，并在**头部**标注已返回的页码区间与续读方式
 *    （头部而非尾部：外层 maxOutput 会二次截断，标注放尾部会被切掉）。
 */
function buildOcrAttachmentOutput(
  path: string,
  fileSize: number,
  meta: string,
  pages: OcrPageBlock[],
  opts: { pagesArg?: string; totalPages?: number; rendered?: number },
): string {
  const maxPage = opts.totalPages && opts.totalPages > 0
    ? opts.totalPages
    : Math.max(0, ...pages.map((p) => p.index));
  const wanted = parsePageRange(opts.pagesArg, maxPage);
  const ordered = (wanted ? pages.filter((p) => wanted.includes(p.index)) : pages)
    .slice()
    .sort((a, b) => a.index - b.index);

  let body = '';
  let truncatedAt = -1; // 首个放不下的页号（1-based），其之前的内容已包含
  for (const p of ordered) {
    const pageText = p.text.trim();
    // 单页密集警示：转录字符接近单页上限时，页内数据可能被视觉模型静默截断
    const denseNote = pageText.length > OCR_DENSE_PAGE_THRESHOLD
      ? `⚠ 本页内容密集（约 ${pageText.length} 字符，接近单页转录上限），转录可能不完整，建议分页复核。\n`
      : '';
    const block = `[Page ${p.index}]\n${denseNote}${pageText}`;
    if (body.length + block.length + 2 > OCR_MAX_LENGTH) {
      truncatedAt = p.index;
      break;
    }
    body += (body ? '\n\n' : '') + block;
  }

  const firstShown = ordered.length > 0 ? ordered[0].index : 1;
  const shownCount = truncatedAt > 0 ? Math.max(0, truncatedAt - firstShown) : ordered.length;
  const header = `Attachment: ${path} (${formatSize(fileSize)}, ${meta}, ${shownCount}/${opts.rendered ?? maxPage} pages)`;

  if (truncatedAt > 0) {
    // 续读提示放头部，确保外层 maxOutput 截断后仍可见
    const lastShown = truncatedAt - 1;
    return (
      `${header}\n` +
      `⚠ INCOMPLETE: pages ${firstShown}-${lastShown} of ${maxPage} (truncated)\n` +
      `⚠ 内容已截断：单次读取上限 ${OCR_MAX_LENGTH} 字符，本次返回第 ${firstShown}-${lastShown} 页（共 ${maxPage} 页）。` +
      `如需继续，调用 read_attachment(path="${path}", pages="${truncatedAt}-${maxPage}") 读取剩余页。\n\n${body}`
    );
  }

  return `${header}\n\n${body}`;
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
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

/** 网页搜索 — 多 provider 降级：Coze SDK → Bing HTTP → DuckDuckGo Lite
 *  方案 B：返回 EnhancedToolResult，text 供 LLM 引用，cardHtml 由宿主渲染为搜索结果卡 */
async function toolWebSearch(args: Record<string, unknown>): Promise<string | EnhancedToolResult> {
  const query = args.query as string;
  if (!query) return 'Error: query required';
  // 安全提取 URL 域名，无效 URL 不抛异常
  const hostOf = (u?: string): string | undefined => {
    if (!u) return undefined;
    try { return new URL(u).hostname; } catch { return undefined; }
  };

  // Provider 1: Coze SDK（需要配置 API Key）
  try {
    const { SearchClient, Config } = await import('coze-coding-dev-sdk');
    const config = new Config();
    if (config.apiKey) {
      const client = new SearchClient(config);
      const response = await client.webSearch(query, 5, true);

      if (response.web_items && response.web_items.length > 0) {
        const items: CardItem[] = response.web_items.map((it) => ({
          title: it.title || 'Untitled',
          badge: 'Web',
          meta: hostOf(it.url),
          body: it.snippet,
          url: it.url,
          btnText: '访问',
        }));
        const parts: string[] = [];
        if (response.summary) parts.push(`Summary: ${response.summary}`);
        parts.push('Search results:');
        for (const it of response.web_items) {
          parts.push(`- ${it.title}${it.url ? ` (${it.url})` : ''}: ${it.snippet}`);
        }
        return { text: parts.join('\n'), cardHtml: buildCardListHtml(items) };
      }
      if (response.summary) {
        return { text: `Summary: ${response.summary}`, cardHtml: '' };
      }
    }
  } catch {
    // SDK 不可用，降级到本地搜索
  }

  // Provider 2 & 3 & 4: 本地 HTTP 抓取（无需 API Key）
  // 百度优先（中文搜索质量最好），Bing 次之，DDG 兜底
  const providers = [
    { name: 'Baidu', search: searchBaiduHttp },
    { name: 'Bing', search: searchBingHttp },
    { name: 'DuckDuckGo', search: searchDuckDuckGoLite },
  ];
  const errors: string[] = [];

  for (const { name, search } of providers) {
    try {
      // 字典/攻略类无关站直接过滤；若该 provider 过滤后无结果则尝试下一个（避免把无关垃圾当有效结果返回）
      const results = filterJunkSearchResults(await search(query, 5));
      if (results.length > 0) {
        const items: CardItem[] = results.map((r) => ({
          title: r.title || 'Untitled',
          badge: name,
          meta: hostOf(r.url),
          body: r.snippet,
          url: r.url,
          btnText: '访问',
        }));
        const parts: string[] = ['Search results:'];
        for (const r of results) {
          parts.push(`- ${r.title}${r.url ? ` (${r.url})` : ''}: ${r.snippet}`);
        }
        return { text: parts.join('\n'), cardHtml: buildCardListHtml(items) };
      }
      errors.push(`${name}: no results`);
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return `Search failed after trying ${providers.length} providers:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\nCheck network and retry.`;
}

/** web_fetch 工具：抓取指定 URL 的文本内容（HTML 自动清洗为纯文本） */
async function toolWebFetch(args: Record<string, unknown>): Promise<string> {
  const url = (args.url as string || '').trim();
  if (!url) return 'Error: url 必填';
  if (!/^https?:\/\//i.test(url)) return 'Error: 请输入合法的 http(s):// URL';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;

    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    const isTextLike =
      ctype.includes('text/') || ctype.includes('html') || ctype.includes('xml') ||
      ctype.includes('json') || ctype.includes('javascript') || ctype.includes('csv') ||
      ctype.includes('markdown');
    if (!isTextLike) {
      return `URL: ${url}\nContent-Type: ${ctype || '未知'}\n（非文本内容，无法直接读取网页正文）`;
    }

    // charset 感知解码：GBK/GB2312 等中文旧站（法院/政府官网常见）直接 utf-8 解码会乱码。
    // 探测顺序：BOM → Content-Type charset → <meta charset>；不可用回退 utf-8。
    const raw = await resp.arrayBuffer();
    const bytes = new Uint8Array(raw);
    let charset = '';
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = 'utf-8';
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = 'utf-16be';
    const headerCharset = ctype.match(/charset=["']?([\w-]+)/i);
    if (!charset && headerCharset) charset = headerCharset[1];
    if (!charset) {
      try {
        const head = new TextDecoder('utf-8').decode(bytes.slice(0, 2048));
        const metaCharset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
        if (metaCharset) charset = metaCharset[1];
      } catch {
        /* 头部探测失败按默认处理 */
      }
    }
    let text: string;
    try {
      // gb2312/gb18030 与 gbk 同族，统一映射到 TextDecoder 的 gbk；不支持时回退 utf-8
      const norm = /^gb2312$|^gb18030$/i.test(charset) ? 'gbk' : (charset || 'utf-8');
      text = new TextDecoder(norm).decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }
    // 二进制/乱码防护：仅保留可见字符比例高的内容
    let visible = 0;
    for (let i = 0; i < Math.min(text.length, 2000); i++) {
      const c = text.charCodeAt(i);
      if ((c >= 32 && c <= 126) || c >= 128 || c === 10 || c === 9) visible++;
    }
    if (visible < Math.min(text.length, 2000) * 0.5) {
      return `URL: ${url}\nContent-Type: ${ctype}\n（内容疑似二进制，无法直接读取）`;
    }

    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';
    const clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
    const body = truncate(clean, 6000);
    return `URL: ${url}\n标题: ${title || '(未识别)'}\n\n${body || '(未提取到正文，可能为 JS 动态渲染页面)'}`;
  } catch (e) {
    return `Error: 抓取失败 ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---- 本地搜索 Provider ----

interface LocalSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** Bing HTTP 抓取 */
async function searchBingHttp(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': SEARCH_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const results: LocalSearchResult[] = [];
  const blockRegex = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) && results.length < maxResults) {
    const block = match[1];
    // 从 <h2> 内提取链接
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const rawUrl = linkMatch[1];
    const title = stripHtml(linkMatch[2]).trim();
    if (!title || rawUrl.startsWith('javascript:')) continue;

    // 摘要：优先 b_caption 内的 <p>
    let snippet = '';
    const snippetMatch =
      block.match(/<div[^>]*class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (snippetMatch) {
      snippet = decodeHtmlEntities(stripHtml(snippetMatch[1])).trim();
    }

    results.push({ title, url: rawUrl, snippet });
  }

  return results;
}

/** 无关结果过滤：纯字词典/攻略站对检索无权威价值，剔除避免污染（百科类正常引用不误杀） */
function filterJunkSearchResults(results: LocalSearchResult[]): LocalSearchResult[] {
  const junkHost = /(^|\.)(gxdq|hgcha|chagushici|hanyuguoxue)\.com$|^jingyan\.baidu\.com$/i;
  return results.filter((r) => {
    try {
      const host = new URL(r.url).hostname.replace(/^www\./i, '');
      return !junkHost.test(host);
    } catch {
      return true; // 无法解析的 URL 保留（可能是跳转链）
    }
  });
}

/** 百度搜索 HTTP 抓取 */
async function searchBaiduHttp(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': SEARCH_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const results: LocalSearchResult[] = [];
  // 百度结果标题在 <h3> > <a> 中，href 为跳转链；h3 的 data-tools JSON / mu 属性携带真实目标 URL。
  // 解析成功则用真实 URL 替代跳转链 → 模型可直接据域名判断权威性，web_fetch 也免二次跳转。
  const h3Regex = /<h3([^>]*)>[\s\S]*?<a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = h3Regex.exec(html)) && results.length < maxResults) {
    const attrs = match[1] || '';
    const rawUrl = match[2];
    const title = decodeHtmlEntities(stripHtml(match[3])).trim();
    if (!title) continue;

    // 真实目标 URL：优先 h3 上 data-tools JSON 的 url（当前百度），其次 mu 属性（历史版式）
    let realUrl = rawUrl;
    const dt = attrs.match(/data-tools='([^']+)'/) || attrs.match(/data-tools="([^"]+)"/);
    if (dt) {
      try {
        const j = JSON.parse(decodeHtmlEntities(dt[1]));
        if (j && typeof j.url === 'string' && /^https?:\/\//i.test(j.url)) realUrl = j.url;
      } catch {
        /* 解析失败保留跳转链 */
      }
    }
    if (realUrl === rawUrl) {
      const mu = attrs.match(/\bmu="(https?:\/\/[^"]+)"/);
      if (mu) realUrl = mu[1];
    }

    // 摘要：取本结果标题到下一个 <h3> 之间的正文区，依次尝试常见摘要容器 class
    const tail = html.slice(h3Regex.lastIndex).replace(/<script[\s\S]*?<\/script>/gi, ' ');
    const nextH3 = tail.search(/<h3[^>]*>/i);
    const win = (nextH3 > -1 ? tail.slice(0, nextH3) : tail).slice(0, 2000);
    let snippet = '';
    for (const sm of [
      win.match(/<span[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i),
      win.match(/class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\//i),
      win.match(/<div[^>]*class="c-span-last[^"]*"[^>]*>([\s\S]*?)<\/div>/i),
    ]) {
      if (sm && sm[1]) {
        snippet = decodeHtmlEntities(stripHtml(sm[1])).trim().replace(/\s+/g, ' ');
        if (snippet) break;
      }
    }

    results.push({ title, url: realUrl, snippet });
  }

  return results;
}

/** DuckDuckGo Lite 抓取 */
async function searchDuckDuckGoLite(query: string, maxResults: number): Promise<LocalSearchResult[]> {
  const resp = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'User-Agent': SEARCH_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

  const links: Array<[string, string]> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html))) {
    links.push([m[1], m[2]]);
  }
  while ((m = snippetRegex.exec(html))) {
    snippets.push(m[1]);
  }

  const results: LocalSearchResult[] = [];
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const [rawUrl, rawTitle] = links[i];
    const title = cleanDdgTitle(rawTitle);
    const url = extractDdgUrl(rawUrl);
    const snippet = i < snippets.length ? decodeHtmlEntities(stripHtml(snippets[i])).trim() : '';
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/** 提取 DDG 跳转链接中的真实 URL */
function extractDdgUrl(rawUrl: string): string {
  if (rawUrl.includes('uddg=')) {
    const match = rawUrl.match(/uddg=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  if (rawUrl.startsWith('//')) return 'https:' + rawUrl;
  return rawUrl;
}

/** 清理 DDG Lite 标题中的 URL 残留 */
function cleanDdgTitle(rawTitle: string): string {
  let text = stripHtml(rawTitle).trim();
  // 截断混入的 URL
  text = text.split(/https?:\/\//)[0];
  // 去掉尾部残留域名
  text = text.replace(/\s*\w+\.\w{2,}\s*$/, '').trim();
  return text;
}

/** 移除 HTML 标签 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** 解码常见 HTML 实体 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&nbsp;': ' ', '&ensp;': ' ', '&emsp;': ' ',
    '&#0183;': '·', '&middot;': '·', '&mdash;': '—', '&ndash;': '–',
    '&hellip;': '…', '&ldquo;': '\u201c', '&rdquo;': '\u201d',
  };
  for (const [entity, char] of Object.entries(entities)) {
    text = text.split(entity).join(char);
  }
  // 数字实体
  text = text.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    return code < 0x10000 ? String.fromCharCode(code) : '';
  });
  // 合并空白
  return text.replace(/\s+/g, ' ').trim();
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

/**
 * Bob Sandbox 小程序文件回滚（.history 版本快照）。
 * - action=list：列出指定文件的全部历史版本（时间戳）；
 * - action=restore：把指定时间戳版本（或最近一份）写回，恢复旧内容。
 * 快照由 writeAppFileAtomic 写入文件时自动产生（.history/<相对路径>/<时间戳>-<文件名>）。
 */
async function toolSandboxRollback(args: Record<string, unknown>): Promise<string> {
  const appId = String(args.appId ?? '');
  const file = String(args.file ?? '');
  const action = args.action === 'restore' ? 'restore' : 'list';
  const stamp = String(args.stamp ?? '');
  if (!appId) return 'Error: appId required';
  if (!file) return 'Error: file required（app 内相对路径，如 index.html）';
  try {
    const { readdir, readFile, writeFile, stat } = await import('fs/promises');
    // 路径穿越校验：file 必须落在 app 目录内
    const appDir = join(SANDBOX_APPS_DIR, appId);
    const target = join(appDir, file);
    if (target !== appDir && !target.startsWith(appDir + sep)) {
      return 'Error: file 越界（必须是小程序目录内的相对路径）';
    }
    const historyDir = join(appDir, '.history', dirname(file));
    const prefix = `${basename(file)}`; // 备份文件名格式：<时间戳>-<basename>
    let entries: string[] = [];
    try {
      entries = (await readdir(historyDir)).filter((n) => n.endsWith(prefix) && n.length > prefix.length);
    } catch {
      entries = [];
    }
    if (action === 'list' || entries.length === 0) {
      if (entries.length === 0) return `无历史版本：${appId}/${file}（尚无 write_file / edit_code 写入记录）`;
      const lines: string[] = [];
      for (const n of entries) {
        const p = join(historyDir, n);
        const s = await stat(p).catch(() => null);
        lines.push(`- ${n}${s ? ` (${new Date(s.mtime).toISOString()})` : ''}`);
      }
      return `历史版本（共 ${entries.length} 份，时间戳即文件名前缀）：\n${lines.join('\n')}\n恢复请调用 sandbox_rollback(appId, file, action="restore", stamp="<时间戳前缀>")`;
    }
    // restore：stamp 为空取最近一份（按文件名时间戳排序取最后）
    entries.sort();
    const match = stamp
      ? entries.find((n) => n.startsWith(stamp))
      : entries[entries.length - 1];
    if (!match) return `Error: 未找到时间戳 "${stamp}" 对应的历史版本。可用 action="list" 查看。`;
    const content = await readFile(join(historyDir, match), 'utf-8');
    await writeFile(target, content, 'utf-8');
    return `已回滚 ${appId}/${file} → ${match}（${content.length} chars）。请用 capture_preview 复核渲染效果。`;
  } catch (e) {
    return `Rollback failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Bob Sandbox 小程序导出为独立单文件 HTML（发布/分享用）：
 * 内联 app 内相对引用的 css/js（<link href> / <script src>），CDN 外链保留。
 * 输出到 bob-sandbox/exports/<appId>-<ts>.html。
 */
async function toolSandboxExport(args: Record<string, unknown>): Promise<string> {
  const appId = String(args.appId ?? '');
  if (!appId) return 'Error: appId required';
  try {
    const { readFile, mkdir, writeFile } = await import('fs/promises');
    const { readAppEntry } = await import('@/lib/sandbox/apps');
    const entry = await readAppEntry(appId);
    if (!entry) return `Error: 小程序 ${appId} 不存在`;
    const appDir = join(SANDBOX_APPS_DIR, appId);
    let html = entry.content;

    // 内联相对引用的 css：<link rel="stylesheet" href="x.css">
    html = html.replace(/<link\b([^>]*)\bhref=["']([^"'http][^"']*\.css(?:\?[^"']*)?)["']([^>]*)>/gi, (_m, pre, href, post) => {
      try {
        const cssPath = join(appDir, href.split('?')[0]);
        const css = readFileSyncSafe(cssPath);
        if (css == null) return _m;
        return `<style data-inlined="${href}">${css}</style>`;
      } catch {
        return _m;
      }
    });
    // 内联相对引用的 js：<script src="x.js">
    html = html.replace(/<script\b([^>]*)\bsrc=["']([^"'http][^"']*\.js(?:\?[^"']*)?)["']([^>]*)><\/script>/gi, (_m, pre, href, post) => {
      try {
        const jsPath = join(appDir, href.split('?')[0]);
        const js = readFileSyncSafe(jsPath);
        if (js == null) return _m;
        return `<script data-inlined="${href}">${js}<\/script>`;
      } catch {
        return _m;
      }
    });

    const exportsDir = join(resolveAppRoot(), SANDBOX_DIRNAME, 'exports');
    await mkdir(exportsDir, { recursive: true });
    const ts = Date.now();
    const outPath = join(exportsDir, `${appId}-${ts}.html`);
    await writeFile(outPath, html, 'utf-8');
    return `已导出独立页面：${outPath}\n（${html.length} chars；app 内相对 css/js 已内联，CDN 外链保留。可直接用浏览器打开或分享）`;
  } catch (e) {
    return `Export failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 同步读文件（导出内联用）；失败返回 null */
function readFileSyncSafe(p: string): string | null {
  try {
    const fs = require('fs');
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
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

/** 独立 OCR 工具（ocr_document）：复用 ocr-service 引擎，返回文本 + 质量/勾稽元数据。
 *  聚焦纯 OCR（PDF/图片），不处理 docx/视频等附件类型。 */
async function toolOcrDocument(args: Record<string, unknown>): Promise<string> {
  const pathArg = typeof args.path === 'string' ? args.path.trim() : '';
  if (!pathArg) return 'Error: path is required（文件路径必填）';
  try {
    const filePath = await resolvePath(pathArg);
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) return `Error: 文件不存在或不可读: ${pathArg}`;

    const { ocrFile } = await import('@/lib/pdf/ocr-service');
    // upgrade 参数透传给 bob-ocr-mcp：off=不升级（默认）；auto=质量低/勾稽异常自动升级；always=全部升级。
    // 仅 off/auto/always 合法，其余（含缺失）一律回退 off。
    const upgradeArg = typeof args.upgrade === 'string' ? args.upgrade.trim() : '';
    const upgrade = upgradeArg === 'auto' || upgradeArg === 'always' ? upgradeArg : 'off';
    const result = await ocrFile(filePath, { upgrade });
    if (!result.success) {
      return `Error: OCR 失败（${result.error ?? '未知原因'}）`;
    }

    const lines: string[] = [];
    // 附注（消除静默失败）：Online OCR 已配置但未生效等原因透传给 AI
    for (const note of result.notes ?? []) {
      lines.push(`[Note] ${note}`);
    }
    if (result.method === 'pdf-text') {
      lines.push(`OCR 结果（原生文本 PDF，共 ${result.pageCount} 页）`);
      lines.push(result.text);
    } else {
      const upgradedMeta = (result as { upgradedCount?: number }).upgradedCount ?? 0;
      lines.push(
        `OCR 结果（扫描件，共 ${result.pageCount} 页，仅识别辅助，原图保留）` +
          (upgradedMeta > 0 ? `，其中 ${upgradedMeta} 页采用在线模型升级` : ''),
      );
      for (const p of result.pages) {
        const meta = [
          `quality=${p.qualityScore.toFixed(2)}`,
          p.ledgerVerified >= 0 ? `勾稽=${p.ledgerVerified}行` : null,
          p.rotated ? '旋转表格已转置' : null,
          p.enhanced ? '图像增强' : null,
          p.upgraded
            ? `${p.upgradeChain === 'online-ocr' ? '在线OCR' : 'VLM'}(${p.upgradeModel ?? '模型未知'})`
            : null,
        ].filter(Boolean).join(', ');
        lines.push(`[Page ${p.index}]${meta ? `（${meta}）` : ''}\n${p.text.trim()}`);
      }
    }
    return truncate(lines.join('\n\n'), OCR_MAX_LENGTH);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 图像 ROI 裁剪（crop_image）：从整页图中裁出手写字段/印章区域，供后续单独喂 VLM 复核。
 *  治"反复整页重识别"的痛点：只对可疑 ROI 重试，不整页跑。 */
async function toolCropImage(args: Record<string, unknown>): Promise<string> {
  const pathArg = typeof args.path === 'string' ? args.path.trim() : '';
  if (!pathArg) return 'Error: path is required（图片路径必填）';
  const bbox = Array.isArray(args.bbox) ? args.bbox.map(Number) : [];
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    return 'Error: bbox 必须是 [x1,y1,x2,y2] 四个像素坐标（图片左上角为原点，x 向右、y 向下，x1<x2 且 y1<y2）';
  }
  const [x1, y1, x2, y2] = bbox;
  if (!(x1 < x2 && y1 < y2)) return 'Error: 无效 bbox，需满足 x1<x2 且 y1<y2';
  const margin = Math.max(0, Number(args.margin ?? 8)); // 外扩像素，避免裁掉笔画
  const scale = Math.max(1, Number(args.scale ?? 2));   // 放大倍率，便于 VLM 看清手写
  try {
    const filePath = await resolvePath(pathArg);
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) return `Error: 文件不存在或不可读: ${pathArg}`;
    // 输出到 homework/.crops/（隐藏中间产物目录：侧边栏与 Finder 均不可见，任务结束即清理）
    const outDir = join(await getProjectRootPath(), 'homework', '.crops');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, `crop-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
    const { stdout } = await execFileAsync(
      'python3',
      [
        '-c',
        `import json,sys;sys.path.insert(0,'src/lib/pdf/core');` +
          `from PIL import Image;` +
          `im=Image.open(sys.argv[1]);` +
          `w,h=im.size;` +
          `x1,y1,x2,y2=${x1},${y1},${x2},${y2};` +
          `m=${margin};` +
          `L=max(0,x1-m);T=max(0,y1-m);R=min(w,x2+m);B=min(h,y2+m);` +
          `crop=im.crop((L,T,R,B));` +
          `s=${scale};` +
          `crop=crop.resize((int(crop.width*s),int(crop.height*s)),Image.LANCZOS) if s!=1 else crop;` +
          `crop.save(sys.argv[2],format='PNG');` +
          `print(json.dumps({'w':w,'h':h,'crop':[L,T,R,B],'out':sys.argv[2]}))`,
        // 路径经 argv 传递（execFile 不经 shell）：空格/中文/特殊字符不再被 shell 拆词/转义破坏
        filePath,
        outPath,
      ],
      { timeout: 30000 },
    );
    const parsed = JSON.parse(stdout.trim()) as { w: number; h: number; crop: number[]; out: string };
    return [
      `ROI 裁剪完成：`,
      `  原图尺寸：${parsed.w} × ${parsed.h} px`,
      `  裁剪区域（含外扩 ${margin}px）：[${parsed.crop}]`,
      `  输出路径：${parsed.out}`,
      `下一步：把该路径传给 ocr_document / read_attachment 单独识别，或直接传给视觉模型复核该字段。`,
    ].join('\n');
  } catch (e) {
    return `Error: 裁剪失败（${e instanceof Error ? e.message : String(e)}）。请确认 Python + Pillow 可用、路径为图片文件。`;
  }
}

/** 读取附件内容 */
async function toolReadAttachment(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  const path = args.path as string;
  if (!path) return 'Error: path required';
  // 可选：仅扫描件 PDF 生效，按页读取（如 "1-5"、"3"、"6,8-10"），用于长 PDF 分片读取
  const pagesArg = typeof args.pages === 'string' ? args.pages.trim() : undefined;
  // 可选：文本/docx/xls/pptx/doc/rtf 类通用续读偏移——内容超单次上限被截断时，返回头会标注下一次 offset，原样传回即可续读
  const offset = Math.max(0, Math.trunc(Number(args.offset))) || 0;
  // 可选：仅 Excel(.xls/.xlsx) 生效，按 sheet 名过滤（不传=全部 sheet）
  const sheetArg = typeof args.sheet === 'string' ? args.sheet.trim() : undefined;

  try {
    // 附件路径是相对于项目目录的，需要获取当前项目路径
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const project = await getCurrentProject();
    // 防 ../ 穿越：resolve 后必须仍在 project.path 内
    const projectRoot = resolve(project.path);

    // 支持授权目录的绝对路径直通：~ 展开 + 绝对路径 + 相对路径三种形态
    // 1) 绝对路径 / ~ 路径：必须命中用户授权目录（isReadablePath 校验）才放行
    // 2) 相对路径（attachments/...）：基于项目根解析，仍须在项目根内（防穿越）
    let filePath: string;
    if (path === '~') {
      filePath = resolve(homedir());
    } else if (path.startsWith('~/')) {
      filePath = resolve(join(homedir(), path.slice(2)));
    } else if (isAbsolute(path)) {
      filePath = resolve(path);
    } else {
      filePath = resolve(join(projectRoot, path));
    }

    const withinProject =
      filePath === projectRoot || filePath.startsWith(projectRoot + sep);
    if (!withinProject) {
      // 越出项目根：若命中授权目录则放行，否则拒绝
      const authorized = await isReadablePath(filePath);
      if (!authorized) {
        auditLog({ tool: 'read_attachment', blocked: true, reason: 'path-traversal', path, project: projectRoot, resolved: filePath });
        return `Error: 附件路径 "${path}" 越出项目目录且不在授权目录内，拒绝访问。请勿猜测其他个人目录路径（如文稿/下载/桌面/相册）反复尝试；若用户未提供该文件，直接请用户提供路径或将文件放入项目目录。`;
      }
    }
    auditLog({ tool: 'read_attachment', path, project: projectRoot, resolved: filePath });
    const ext = extname(filePath).toLowerCase();

    const textExts = ['.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log'];
    const isTextFile = textExts.includes(ext);

    if (isTextFile) {
      const fileStat = await stat(filePath);
      const raw = await readFile(filePath);
      let content: string;
      let encNote = '';
      try {
        // fatal: true → 遇到非法 UTF-8 序列（如 GBK 中文）直接抛错，触发编码探测
        content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        try {
          content = new TextDecoder('gb18030').decode(raw);
          encNote = ' (GB18030)';
        } catch {
          content = new TextDecoder('utf-8').decode(raw);
        }
      }
      content = content.replace(/^\uFEFF/, ''); // 去 BOM
      return chunkedAttachmentReturn(path, fileStat.size, `${ext.slice(1)} text${encNote}`, content, offset);
    }

    // .doc / .rtf / .rtfd（老版 Office）：macOS 自带 textutil 转纯文本
    if (ext === '.doc' || ext === '.rtf' || ext === '.rtfd') {
      const fileStat = await stat(filePath);
      try {
        const { stdout } = await execFileAsync(
          'textutil',
          ['-convert', 'txt', '-stdout', filePath],
          { timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
        );
        if (!stdout || !stdout.trim()) {
          return `Attachment: ${path}\nType: ${ext} (${formatSize(fileStat.size)})\n\ntextutil 未能提取到文本（文档可能为空或为图片型）。请另存为 .docx 或 .txt 后重试。`;
        }
        return chunkedAttachmentReturn(path, fileStat.size, `${ext.slice(1)} via textutil`, stdout, offset);
      } catch (tuErr) {
        return `Attachment: ${path}\nType: ${ext} (${formatSize(fileStat.size)})\n\ntextutil 转换失败：${tuErr instanceof Error ? tuErr.message : String(tuErr)}。请另存为 .docx 或 .txt 后重试。`;
      }
    }

    // .docx：mammoth HTML 保真管线（段落/标题/列表编号/表格行列结构）→ 紧凑文本
    if (ext === '.docx') {
      const fileStat = await stat(filePath);
      try {
        const mammoth = (await import('mammoth')) as unknown as MammothLike;
        const res = await mammoth.convertToHtml({ path: filePath });
        const fullText = docxHtmlToText(res.value);
        if (!fullText.trim()) {
          return `Attachment: ${path}\nType: Word (.docx) (${formatSize(fileStat.size)})\n\nmammoth 解析成功但未提取到文本（文档可能为空或内容均在文本框/图片中）。`;
        }
        return chunkedAttachmentReturn(path, fileStat.size, '.docx text', fullText, offset);
      } catch (extractErr) {
        // 兜底：直接解 document.xml 做轻量结构提取（不再退化为纯文本时，也要先试一遍）
        try {
          const AdmZipMod = await import('adm-zip');
          const AdmZip = AdmZipMod.default;
          const zip = new AdmZip(filePath);
          const xmlContent = zip.readAsText('word/document.xml');
          const fallbackText = docxXmlFallbackText(xmlContent);
          if (fallbackText.trim()) {
            return chunkedAttachmentReturn(path, fileStat.size, '.docx text (fallback)', fallbackText, offset);
          }
        } catch { /* 兜底失败 → 走下方错误 */ }
        return `Attachment: ${path}\nType: Word (.docx)\nUnable to extract text: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}\n\nSuggestion: please provide .txt or .md format.`;
      }
    }

    // .pptx：解包按页提取文本（PPT 是 zip，文本在 ppt/slides/slideN.xml 的 a:t 内）
    if (ext === '.pptx') {
      const fileStat = await stat(filePath);
      try {
        const AdmZipMod = await import('adm-zip');
        const AdmZip = AdmZipMod.default;
        const zip = new AdmZip(filePath);
        const slideNames = zip
          .getEntries()
          .map((e) => e.entryName)
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
          .sort((a, b) => {
            const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
            const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] ?? 0);
            return na - nb;
          });
        if (slideNames.length === 0) {
          return `Attachment: ${path}\nType: PowerPoint (.pptx) (${formatSize(fileStat.size)})\n\n未在压缩包中找到 ppt/slides/slideN.xml（可能不是标准 PPTX 或纯图型模板）。`;
        }
        const parts: string[] = [];
        for (const name of slideNames) {
          const slideNo = name.match(/slide(\d+)\.xml/i)?.[1] ?? name;
          const body = collapseMarkedLines(
            zip.readAsText(name).replace(/<a:br\/>/g, '\n').replace(/<\/a:p>/g, '\n').replace(/<a:tab\/>/g, '\t'),
          );
          if (body.trim()) parts.push(`[Slide ${slideNo}]\n${body}`);
        }
        if (parts.length === 0) {
          return `Attachment: ${path}\nType: PowerPoint (.pptx) (${formatSize(fileStat.size)})\n\n各页未提取到文本（可能为全图型 PPT）。`;
        }
        return chunkedAttachmentReturn(path, fileStat.size, '.pptx text', parts.join('\n\n'), offset);
      } catch (pptxErr) {
        return `Attachment: ${path}\nType: PowerPoint (.pptx)\n解析失败：${pptxErr instanceof Error ? pptxErr.message : String(pptxErr)}。`;
      }
    }

    // 特殊处理 .xls / .xlsx（Excel 二进制表格）：SheetJS 解析，按 sheet 输出为紧凑文本行
    // （read_attachment 原本不支持表格附件，agent 只能绕道脚本；此处补齐直读能力）
    if (ext === '.xls' || ext === '.xlsx') {
      try {
        const XLSX = await import('xlsx');
        const wb = XLSX.readFile(filePath);
        const fileStat = await stat(filePath);
        // sheet 名过滤：sheetArg 命中则只读该表；未命中返回可用清单让模型修正
        let sheetNames = wb.SheetNames;
        if (sheetArg) {
          const matched = wb.SheetNames.filter((n) => n.toLowerCase() === sheetArg.toLowerCase());
          if (matched.length === 0) {
            return `Attachment: ${path}\nType: Excel (${ext})\n\n指定 sheet "${sheetArg}" 不存在。可用 sheet：${wb.SheetNames.map((n) => `"${n}"`).join('、')}。请用 sheet 参数指定其一，或不传 sheet 读取全部。`;
          }
          sheetNames = matched;
        }
        const sheetBlocks: string[] = [];
        for (const sheetName of sheetNames) {
          const ws = wb.Sheets[sheetName];
          if (!ws) continue;
          const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false }) as unknown[][];
          const lines = rows
            .filter((r) => r.some((c) => c !== '' && c !== null && c !== undefined))
            .map((r) => {
              const cells = r.map((c) => String(c ?? '').replace(/[\r\n\t]+/g, ' ').trim());
              // 去掉行尾空列，避免出现悬挂的分隔符
              while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
              return cells.join(' | ');
            })
            .filter((l) => l.length > 0);
          if (lines.length > 0) sheetBlocks.push(`[Sheet: ${sheetName}] (${lines.length} rows)\n${lines.join('\n')}`);
        }
        if (sheetBlocks.length === 0) {
          return `Attachment: ${path}\nType: Excel (${ext})\nSize: ${formatSize(fileStat.size)}\n\n解析成功但未读到有效内容（表格为空或无数据行）。`;
        }
        const fullText = sheetBlocks.join('\n\n');
        const sheetsLabel = sheetArg ? `sheet ${sheetArg}` : `${sheetBlocks.length} sheet${sheetBlocks.length > 1 ? 's' : ''}`;
        return chunkedAttachmentReturn(path, fileStat.size, `Excel ${ext.slice(1)} (${sheetsLabel})`, fullText, offset);
      } catch (excelErr) {
        const fileStat = await stat(filePath);
        return `Attachment: ${path}\nType: Excel (${ext})\nSize: ${formatSize(fileStat.size)}\n\nExcel 解析失败：${excelErr instanceof Error ? excelErr.message : String(excelErr)}。若为旧版加密 .xls 或格式损坏，请另存为 .xlsx 或 .csv 后重试。`;
      }
    }

    // 特殊处理 .pdf：Python pypdf → pdfplumber → sips+VLM
    if (ext === '.pdf') {
      try {
        const { extractWithPython, extractWithPdfParse } = await import('@/lib/pdf/extractor');
        const fileStat = await stat(filePath);

        // 第1+2级：Python pypdf → pdfplumber
        const pyResult = await extractWithPython(filePath);

        // 方案2（文字层密度门限）：水印/信笺头类 PDF 的文字层只有满页重复装饰字，
        // 绝对长度可轻松超过 20 字符却不含正文，导致此前被误判为"有文字层"而直接短路返回。
        // 改按"平均每页字符数"判断：页数未知时退回原来的长度判断，行为完全兼容。
        const TEXT_DENSITY_CHARS_PER_PAGE = 150;
        const denseLayer = (len: number, pageCount?: number): boolean => {
          if (!pageCount || pageCount <= 0) return len > 20;
          return len / Math.max(1, pageCount) >= TEXT_DENSITY_CHARS_PER_PAGE;
        };

        if (pyResult.text && denseLayer(pyResult.text.length, pyResult.pageCount)) {
          const truncated = pyResult.text.length > READ_CAPACITY
            ? pyResult.text.slice(0, READ_CAPACITY) + `\n...(${pyResult.pageCount} pages, truncated)`
            : pyResult.text;
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, PDF via ${pyResult.method})\n\n${truncated}`,
            READ_CAPACITY,
          );
        }

        // Python 提取失败，尝试 pdf-parse 兜底
        const fallback = await extractWithPdfParse(filePath);
        if (fallback.text && denseLayer(fallback.text.length, fallback.pageCount)) {
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, PDF via pdf-parse)\n\n${fallback.text}`,
            READ_CAPACITY,
          );
        }

        // 扫描件：OCR 识别完全走 bob-ocr-mcp（MCP 优先，不可用时返回明确错误）
        // 注意：不依赖 pageCount 来判断是否需要 OCR，因为提取器在某些情况下可能返回 pageCount=0
        // 方案2判定：只要两种提取器都没有产出"有密度的"文字层（稀疏≠可用），就进入 OCR 缓存分支
        const scannedPages = pyResult.pageCount || fallback.pageCount;
        const needsOcr = !denseLayer(pyResult?.text?.length ?? 0, pyResult?.pageCount)
          && !denseLayer(fallback?.text?.length ?? 0, fallback?.pageCount);

        if (needsOcr) {
          // PDF 级缓存：同一扫描件重复解析直接命中（法律文档常被反复检索引用）
          let pdfHash = '';
          const cacheT0 = Date.now();
          try {
            const { computeFileHash } = await import('@/lib/parse/image-parser');
            const { getCache, waitForPdfWarmOrTimeout } = await import('@/lib/parse/cache');
            pdfHash = await computeFileHash(filePath);
            let pdfCached = await getCache(pdfHash, project.path);
            if (!pdfCached?.result?.extracted_text && !pagesArg) {
              // 缓存未命中：若 PDF Bridge 后台预热正在进行（且非分页读取），等最多 1.2s 收尾，
              // 避免预热快写完时工具又从头开始整份 OCR——典型时预热 10-20s vs 等 1s 换命中，收益远大于代价。
              const waited = await waitForPdfWarmOrTimeout(pdfHash, project.path, 1200);
              if (waited) pdfCached = await getCache(pdfHash, project.path);
            }
            // 方案1a（二级索引）：主缓存 MISS 后，用本地已提取到的文字层做内容指纹反查（位置无关集合匹配）。
            // 若该文件是某份已做过全量 OCR 的文档的再渲染/切片派生件（字节已变、主键必失配），
            // 直接复用父记录全文切片返回，跳过整轮昂贵的 MCP 重 OCR。失败则照常进入 OCR。
            if (!pdfCached?.result?.extracted_text) {
              try {
                const { findSourceByFingerprints } = await import('@/lib/parse/derive-index');
                const probe = await findSourceByFingerprints(
                  project.path,
                  pyResult?.text ? [{ index: 1, text: pyResult.text }] : [],
                  fallback?.text ? [{ index: 1, text: fallback.text }] : [],
                );
                if (probe) {
                  const parentRec = await getCache(probe.parent, project.path);
                  const parentPages = parentRec?.result?.extracted_text
                    ? splitOcrTextToPages(parentRec.result.extracted_text)
                    : [];
                  if (parentPages.length > 0) {
                    console.log(`[read-attachment] PDF 二级索引命中: ${basename(filePath)} hash=${pdfHash.slice(0, 10)}… ← 源=${probe.parent.slice(0, 10)}… 页区间p${probe.start}-${probe.end} 窗口命中率=${Math.round(probe.ratio * 100)}%`);
                    return buildOcrAttachmentOutput(
                      path,
                      fileStat.size,
                      'Scanned PDF, cached OCR (secondary index)',
                      parentPages,
                      { pagesArg, totalPages: parentPages[parentPages.length - 1].index, rendered: parentPages.length },
                    );
                  }
                }
              } catch { /* 二级索引不可用时静默降级到正常 OCR */ }
            }
            if (pdfCached?.result?.extracted_text) {
              const cachedPages = splitOcrTextToPages(pdfCached.result.extracted_text);
              const waitMs = Date.now() - cacheT0;
              console.log(`[read-attachment] PDF cache HIT: ${basename(filePath)} chars=${pdfCached.result.extracted_text.length} pages=${cachedPages.length || '?'} wait=${waitMs}ms`);
              if (cachedPages.length > 0) {
                return buildOcrAttachmentOutput(
                  path,
                  fileStat.size,
                  'Scanned PDF, cached OCR',
                  cachedPages,
                  { pagesArg, totalPages: cachedPages[cachedPages.length - 1].index, rendered: cachedPages.length },
                );
              }
              return truncate(
                `Attachment: ${path} (${formatSize(fileStat.size)}, Scanned PDF, cached OCR)\n\n${pdfCached.result.extracted_text}`,
                OCR_MAX_LENGTH,
              );
            }
            console.log(`[read-attachment] PDF cache MISS: ${basename(filePath)} hash=${pdfHash.slice(0, 10)}… wait=${Date.now() - cacheT0}ms → start full OCR`);
            // 异步调度（调度层落地）：整份扫描件大 PDF 走异步任务，避免同步等待撞 MCP 客户端超时
            // （本地 VLM 分钟级 / 整份大 PDF 20-74s × 多片）。模型立即拿到进度提示，下轮命中缓存。
            // 阈值：整份读取（非分页）且页数 ≥ ASYNC_OCR_MIN_PAGES 或文件较大 → 异步；否则保持同步（小文件秒回）。
            const ASYNC_OCR_MIN_PAGES = 15;
            const ASYNC_OCR_MIN_BYTES = 5 * 1024 * 1024;
            const isLongOcr =
              !pagesArg &&
              (scannedPages >= ASYNC_OCR_MIN_PAGES || fileStat.size >= ASYNC_OCR_MIN_BYTES);
            if (isLongOcr) {
              const { submitOcrTask, getOcrTaskByHash, hasRunningOcrTask } = await import('@/lib/parse/ocr-task-manager');
              if (!hasRunningOcrTask(pdfHash)) {
                const existing = getOcrTaskByHash(pdfHash);
                if (!existing || existing.status === 'done') {
                  try {
                    await submitOcrTask({
                      filePath,
                      projectPath: project.path,
                      hash: pdfHash,
                      upgrade: 'auto',
                      onDone: async (_rec, result) => {
                        // 任务完成：写主缓存 + 二级索引（与同步路径一致），模型下轮直接命中
                        const r = result as { success?: boolean; text?: string; pages?: Array<{ index: number; text: string }> };
                        if (!r?.success || !r.text?.trim()) return;
                        const { setCache } = await import('@/lib/parse/cache');
                        await setCache(pdfHash, {
                          file_name: basename(filePath),
                          file_type: 'pdf',
                          mime_type: 'application/pdf',
                          extracted_text: r.text,
                          parse_method: 'text_extract',
                          parsed_at: new Date().toISOString(),
                          file_hash: pdfHash,
                        }, project.path);
                        const ocrPages = (r.pages ?? []).map((p) => ({ index: p.index, text: p.text }));
                        if (ocrPages.length > 0) {
                          const { registerOcrPages } = await import('@/lib/parse/derive-index');
                          await registerOcrPages(project.path, pdfHash, ocrPages);
                        }
                        console.log(`[read-attachment] 异步OCR完成并写缓存: ${basename(filePath)} chars=${r.text.length} pages=${ocrPages.length}`);
                      },
                    });
                  } catch (e) {
                    console.warn(`[read-attachment] 异步OCR提交失败，回退同步: ${e instanceof Error ? e.message : String(e)}`);
                    // 提交失败 → 走下方同步 OCR（保持功能可用）
                  }
                }
              }
              // 有进行中任务（本次提交或已存在）→ 返回进度提示，模型下轮再读命中缓存
              const rec = getOcrTaskByHash(pdfHash);
              if (rec && (rec.status === 'queued' || rec.status === 'running')) {
                const posText = rec.status === 'queued' ? `排队中${typeof rec.position === 'number' ? `（第${rec.position}位）` : ''}` : `识别中${typeof rec.progress === 'number' ? ` ${rec.progress}%` : ''}`;
                console.log(`[read-attachment] PDF 异步OCR已提交: ${basename(filePath)} task=${rec.taskId.slice(0, 8)}… ${posText}`);
                return truncate(
                  `Attachment: ${path} (${formatSize(fileStat.size)}, Scanned PDF, ${scannedPages} pages)\n\n⏳ 该文件正在后台识别中（${posText}）。识别完成后会自动写入缓存，请稍后再次调用本工具读取本文件，即可秒回识别结果。`,
                  OCR_MAX_LENGTH,
                );
              }
            }
          } catch { /* 缓存不可用则忽略，正常走 OCR */ }

          // 缓存写入 helper（复用 parse cache，key 为 PDF 内容 hash）
          const cachePdf = async (text: string): Promise<void> => {
            if (!pdfHash) return;
            // 分页识别只覆盖目标页，不写入整份缓存（避免把完整 OCR 缓存污染成部分页，影响后续整份读取）
            if (pagesArg) return;
            try {
              const { setCache } = await import('@/lib/parse/cache');
              await setCache(pdfHash, {
                file_name: basename(filePath),
                file_type: 'pdf',
                mime_type: 'application/pdf',
                extracted_text: text,
                parse_method: 'text_extract',
                parsed_at: new Date().toISOString(),
                file_hash: pdfHash,
              }, project.path);
            } catch { /* 缓存写入失败忽略 */ }
          };

          // ---- MCP 优先：扫描件识别统一走 bob-ocr-mcp 常驻服务 ----
          // 可用时直接复用其识别结果（同源引擎，含质量/勾稽/升级元数据），并写入整份缓存；
          // 未配置/不可用/失败时静默回退下方本地渲染 + 视觉模型链路。
          try {
            const { tryOcrViaMcp } = await import('@/lib/mcp/ocr-client');
            const mcpResult = await tryOcrViaMcp(filePath, 'auto', ctx?.onOcrProgress);
            if (mcpResult?.success && mcpResult.text) {
              await cachePdf(mcpResult.text).catch(() => {});
              const ocrPages: OcrPageBlock[] = (mcpResult.pages ?? []).map((p) => ({
                index: p.index,
                text: p.text,
              }));
              // 方案1a 写入侧（全量识别）：把每页文本的滑窗内容指纹登记进二级索引，供之后同源派生件反查。
              // 分页识别（pagesArg）不登记——其内容与父文档重叠，登记会污染归属推断的"主流来源"投票。
              if (!pagesArg && ocrPages.length > 0) {
                try {
                  const { registerOcrPages } = await import('@/lib/parse/derive-index');
                  await registerOcrPages(project.path, pdfHash, ocrPages);
                } catch { /* 索引维护失败不影响 OCR 主流程 */ }
              }
              // 方案1a 学习侧（分页识别）：其页面若大部分命中某个已登记源 → 记 child→parent 溯源链接
              if (pagesArg && ocrPages.length >= 3) {
                try {
                  const { findSourceByFingerprints, linkDerivedToFile } = await import('@/lib/parse/derive-index');
                  const probe = await findSourceByFingerprints(project.path, ocrPages);
                  if (probe) await linkDerivedToFile(project.path, pdfHash, probe.parent, probe.start, probe.end);
                } catch { /* 学习失败忽略 */ }
              }
              if (ocrPages.length > 0) {
                const total = Math.max(0, ...ocrPages.map((p) => p.index), mcpResult.pageCount || 0);
                console.log(`[read-attachment] OCR via MCP: ${basename(filePath)} pages=${ocrPages.length} method=${mcpResult.method}`);
                return buildOcrAttachmentOutput(
                  path,
                  fileStat.size,
                  'Scanned PDF, OCR via MCP',
                  ocrPages,
                  { pagesArg, totalPages: total, rendered: ocrPages.length },
                );
              }
              // 无结构化页（如 GLM-OCR 整份解析）→ 原样返回全文
              return truncate(
                `Attachment: ${path} (${formatSize(fileStat.size)}, Scanned PDF, OCR via MCP)\n\n${mcpResult.text}`,
                OCR_MAX_LENGTH,
              );
            }
          } catch { /* MCP 不可用 → 下方返回明确错误 */ }
          return `Attachment: ${path}\nType: PDF (${scannedPages} pages)\nSize: ${formatSize(fileStat.size)}\n\n无法识别：此 PDF 为扫描件或图片型文档，且识别服务 bob-ocr-mcp 不可用。请确认 OCR 插件已安装且常驻服务在线（bob-ocr-mcp --install-daemon），并在 BobWork 设置 → MCP 中启用 "Bob OCR"。`;
        }
      } catch (extractErr) {
        const fileStat = await stat(filePath);
        return `Attachment: ${path}\nType: PDF\nSize: ${formatSize(fileStat.size)}\n\nPDF text extraction failed: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}`;
      }
    }

    // 图片文件：识别统一走 bob-ocr-mcp（MCP 优先，视觉模型配置已收敛到插件）
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.avif'];
    const isImageFile = imageExts.includes(ext);

    if (isImageFile) {
      const fileStat = await stat(filePath);

      // ---- 图片级 OCR 缓存（内容 hash）：同图跨工具/跨轮次复用，消除"同一页重复识别" ----
      // 袁梦任务实测：同页被渲染成不同命名（page_0.png / p1.png）分别经 recognize / read_attachment
      // 各识别一遍 → 内容 hash 相同即可命中复用。缓存与 PDF 缓存共用 .cache/parse/（同策略：无配置指纹）。
      let imgHash = '';
      try {
        const { computeFileHash } = await import('@/lib/parse/image-parser');
        const { getCache, setCache } = await import('@/lib/parse/cache');
        imgHash = await computeFileHash(filePath);
        const imgCached = await getCache(imgHash, project.path);
        if (imgCached?.result?.extracted_text) {
          console.log(`[read-attachment] Image OCR cache HIT: ${basename(filePath)} chars=${imgCached.result.extracted_text.length}`);
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, image, OCR via MCP, cached)\n\n${imgCached.result.extracted_text.trim()}`,
            8000,
          );
        }
        // ---- MCP 优先：图片识别统一走 bob-ocr-mcp 常驻服务 ----
        // 视觉模型配置已收敛到插件；MCP 不可用/失败 → 明确错误（不再回退 BobWork 内置视觉模型）。
        const { tryOcrViaMcp } = await import('@/lib/mcp/ocr-client');
        const mcpResult = await tryOcrViaMcp(filePath, 'auto', ctx?.onOcrProgress);
        if (mcpResult?.success && (mcpResult.text || mcpResult.understanding)) {
          console.log(`[read-attachment] Image OCR via MCP: ${basename(filePath)} method=${mcpResult.method}`);
          // 剔除空页格式串（[Page 1]）与图片引用占位（![](page=0,bbox=...)），只留真实文字
          const PAGE_PLACEHOLDER_RE = /\[Page \d+\]|!\[[^\]]*\]\([^)]*\)/g;
          const ocrText = (mcpResult.text || '').replace(PAGE_PLACEHOLDER_RE, '').trim();
          if (imgHash) {
            await setCache(
              imgHash,
              {
                file_name: basename(filePath),
                file_type: 'image',
                mime_type: `image/${ext.replace(/^\./, '')}`,
                extracted_text: ocrText || (mcpResult.understanding || '').trim(),
                parse_method: 'vision',
                parsed_at: new Date().toISOString(),
                file_hash: imgHash,
              },
              project.path,
            ).catch(() => {});
          }
          // 纯照片/无文字：插件已自动降级到视觉理解（image_understand）→ 返回 [Image Analysis] 标注 + 画面描述
          if (mcpResult.understanding && !ocrText) {
            return truncate(
              `Attachment: ${path} (${formatSize(fileStat.size)}, image)\n\n[Image Analysis]${mcpResult.understandingModel ? ` (${mcpResult.understandingModel})` : ''}\n${(mcpResult.understanding || '').trim()}`,
              8000,
            );
          }
          // 纯图片/照片：顶层 text 可能只是 "[Page 1]" 这类空页格式串，真实无文字。
          // 插件会带 guidance 引导改走 ocr.image_understand 视觉理解——必须透传给模型，
          // 否则模型看到空壳文本会误判"只有图像引用/视觉不可用"，转而用 crop/HTML/脚本绕路。
          const realTexts = (mcpResult.pages ?? [])
            .map((p) => (p.text ?? '').replace(PAGE_PLACEHOLDER_RE, '').trim())
            .filter((t) => t.length > 0);
          const hasRealText = realTexts.length > 0 || ocrText.length > 20;
          if (mcpResult.guidance && !hasRealText) {
            return `Attachment: ${path} (${formatSize(fileStat.size)}, image)\n\n${mcpResult.guidance}`;
          }
          return truncate(
            `Attachment: ${path} (${formatSize(fileStat.size)}, image, OCR via MCP)\n\n${ocrText}`,
            8000,
          );
        }
      } catch { /* 缓存/识别异常 → 下方明确错误 */ }

      return `Attachment: ${path}\nType: Image (${ext})\nSize: ${formatSize(fileStat.size)}\n\n无法识别：识别服务 bob-ocr-mcp 不可用。请确认 OCR 插件常驻服务在线（bob-ocr-mcp --install-daemon，默认 http://127.0.0.1:9478）且已配置视觉模型（插件 /settings 的 Vision 区块）。`;
    }

    // 视频文件：ffmpeg 抽帧 + 帧识别（统一走 bob-ocr-mcp image_understand；配置已收敛到插件）
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv'];
    if (videoExts.includes(ext)) {
      const stat2 = await stat(filePath);
      try {
        const { parseVideo } = await import('@/lib/parse/video-parser');
        const { ocrImageUnderstandViaMcp } = await import('@/lib/mcp/ocr-client');
        // ⑤ 帧段分片：frame_range（如 "0-1"）→ 只分析该帧段（帧缓存已由主节点预热）
        //    未指定 → 分析全部帧（整视频结果缓存命中直接返回）
        const frameRange = parseFrameRange(args.frame_range as string | undefined, 7);
        const result = await parseVideo(filePath, project.path, {
          model: '',
          apiKey: '',
          baseUrl: '',
          mode: 'general',
        }, {
          ...(frameRange ? { frameRange } : {}),
          // 帧分析器：MCP-only（bob-ocr-mcp image_understand general 模式，复用插件 vision 配置）
          frameAnalyzer: async (
            framePath: string,
            projectPath: string,
            ctx: { fi: number; total: number; timeLabel: string },
          ) => {
            const r = await ocrImageUnderstandViaMcp(framePath, { mode: 'general' });
            if (!r) throw new Error('bob-ocr-mcp 视觉模型不可用');
            return {
              text: `[帧 ${ctx.fi}/${ctx.total}${ctx.timeLabel}]\n${r.understanding}`,
              tin: r.tokens?.input ?? 0,
              tout: r.tokens?.output ?? 0,
            };
          },
        });
        if (result.extracted_text && result.extracted_text.trim().length > 0) {
          const segNote = frameRange ? `（帧段 ${frameRange[0]}-${frameRange[frameRange.length - 1]}，帧缓存命中）` : '';
          return truncate(
            `Attachment: ${path} (${formatSize(stat2.size)}, video, ${result.frame_count} 帧抽帧分析，MCP 识别${segNote})\n\n${result.extracted_text}`,
            READ_CAPACITY,
          );
        }
        return `Attachment: ${path}\nType: Video (${ext})\nSize: ${formatSize(stat2.size)}\n\n视频抽帧分析返回空结果。`;
      } catch (videoErr) {
        const msg = videoErr instanceof Error ? videoErr.message : String(videoErr);
        if (msg.includes('bob-ocr-mcp 视觉模型不可用')) {
          return `Attachment: ${path}\nType: Video (${ext})\nSize: ${formatSize(stat2.size)}\n\n未能分析视频：识别服务 bob-ocr-mcp 不可用或未配置视觉模型。请确认 OCR 插件常驻服务在线（bob-ocr-mcp --install-daemon）且已配置视觉模型（插件 /settings 的 Vision 区块）。`;
        }
        return `Attachment: ${path}\nType: Video (${ext})\nSize: ${formatSize(stat2.size)}\n\n视频分析失败: ${msg}`;
      }
    }

    // 音频文件：云端 STT 转写（豆包/DashScope/SiliconFlow/OpenAI 兼容），未配置则提示
    const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.opus', '.amr'];
    if (audioExts.includes(ext)) {
      const stat2 = await stat(filePath);
      try {
        const { readSettingsFromFile } = await import('@/lib/settings-server');
        const settings = await readSettingsFromFile();
        const { parseAudio } = await import('@/lib/parse/audio-parser');
        const result = await parseAudio(filePath, project.path, { stt: settings.stt });
        return truncate(
          `Attachment: ${path}\nType: Audio (${ext})\nSize: ${formatSize(stat2.size)}\n\n${result.extracted_text}`,
          20000,
        );
      } catch (sttErr) {
        const msg = sttErr instanceof Error ? sttErr.message : String(sttErr);
        return `Attachment: ${path}\nType: Audio (${ext})\nSize: ${formatSize(stat2.size)}\n\n音频转写失败: ${msg}\n\n如需转写请配置音频转写模型（设置 → 角色派发 → 音频转写模型）。`;
      }
    }

    // .zip 压缩包：安全解包到 homework/.unpacks/<指纹>/，返回内部文件清单，供逐个 read_attachment 读取
    if (ext === '.zip') {
      const fileStat = await stat(filePath);
      try {
        const AdmZipMod = await import('adm-zip');
        const AdmZip = AdmZipMod.default;
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        const MAX_ZIP_FILES = 300;
        const MAX_ZIP_TOTAL_BYTES = 300 * 1024 * 1024;
        if (entries.length === 0) {
          return `Attachment: ${path}\nType: Zip (${formatSize(fileStat.size)})\n\n压缩包内无文件。`;
        }
        if (entries.length > MAX_ZIP_FILES) {
          return `Attachment: ${path}\nType: Zip (${formatSize(fileStat.size)})\n\n压缩包内文件过多（${entries.length} > ${MAX_ZIP_FILES}）。请单独上传需要的文件。`;
        }
        // 解压目标：homework/.unpacks/<内容指纹>/（隐藏中间产物目录，任务结束可清理）
        const { computeFileHash } = await import('@/lib/parse/image-parser');
        const hash = (await computeFileHash(filePath)).slice(0, 12);
        const destDir = join(projectRoot, 'homework', '.unpacks', hash);
        const files: Array<{ name: string; size: number }> = [];
        let totalBytes = 0;
        for (const e of entries) {
          if (e.isDirectory) continue;
          const rawName = e.entryName.replace(/\\/g, '/');
          // 防 zip-slip：跳过绝对路径、盘符、父目录回溯、macOS 元数据
          if (
            !rawName ||
            rawName.startsWith('/') ||
            /^[a-zA-Z]:\//.test(rawName) ||
            rawName.split('/').includes('..') ||
            rawName === '.DS_Store' ||
            rawName.endsWith('/.DS_Store') ||
            rawName.startsWith('__MACOSX/')
          ) {
            continue;
          }
          const out = resolve(destDir, rawName);
          if (!out.startsWith(destDir + sep)) continue;
          const size = e.header.size ?? 0;
          totalBytes += size;
          if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
            return `Attachment: ${path}\nType: Zip (${formatSize(fileStat.size)})\n\n解压总大小超限（> ${formatSize(MAX_ZIP_TOTAL_BYTES)}），已中止，防止解压炸弹。请拆分后重试。`;
          }
          files.push({ name: rawName, size });
          await mkdir(dirname(out), { recursive: true });
          await writeFile(out, e.getData());
        }
        if (files.length === 0) {
          return `Attachment: ${path}\nType: Zip (${formatSize(fileStat.size)})\n\n未发现可安全解压的文件（可能均为系统隐藏文件或存在路径穿越）。`;
        }
        const listing = files
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => `- ${f.name} (${formatSize(f.size)})`)
          .join('\n');
        return [
          `Attachment: ${path} (${formatSize(fileStat.size)}, zip, unpacked ${files.length} files)`,
          ``,
          `已安全解包到：homework/.unpacks/${hash}/（项目内目录）`,
          ``,
          `内部文件清单：`,
          listing,
          ``,
          `下一步：对包内目标文件逐个调用本工具读取内容，path 填 "homework/.unpacks/${hash}/<内部相对路径>"（文本/PDF/图片/Excel/Word 均按对应类型解析；包内再嵌套的 zip 同样会被安全解包）。`,
        ].join('\n');
      } catch (zipErr) {
        return `Attachment: ${path}\nType: Zip\nSize: ${formatSize((await stat(filePath)).size)}\n\n压缩包解析失败：${zipErr instanceof Error ? zipErr.message : String(zipErr)}（加密/损坏的 zip 请解压后上传，或提供单个文件）。`;
      }
    }

    const fileStat = await stat(filePath);
    return `Attachment: ${path}\nType: Binary file (${ext || 'unknown'})\nSize: ${formatSize(fileStat.size)}\n\nThis is a non-text file and cannot be read directly. Please provide a text version of the content.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) return `Attachment not found: ${path}`;
    if (msg.includes('EISDIR')) return `Path is a directory, not a file: ${path}`;
    return `Attachment read failed: ${msg}`;
  }
}
/** 读取 materials 文件夹中的参考资料 */
async function toolReadMaterial(args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  if (!path) return 'Error: path required';
  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const project = await getCurrentProject();
    const filePath = join(project.path, path);
    const ext = extname(filePath).toLowerCase();

    // 安全检查：确保在 materials 目录内
    if (!filePath.startsWith(join(project.path, 'materials'))) {
      return 'Error: Invalid material path';
    }

    const textExts = ['.txt', '.md', '.markdown', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.go', '.rs', '.yaml', '.yml', '.ini', '.conf', '.log'];
    const isTextFile = textExts.includes(ext);

    if (isTextFile) {
      const content = await readFile(filePath, 'utf-8');
      const fileStat = await stat(filePath);
      return truncate(
        `Material: ${path} (${formatSize(fileStat.size)})\n\n${content}`,
        READ_CAPACITY,
      );
    }

    // .docx 提取
    if (ext === '.docx') {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const tmpDir = `/tmp/bob-work-docx-${Date.now()}`;
        await execAsync(`mkdir -p "${tmpDir}" && unzip -o "${filePath}" word/document.xml -d "${tmpDir}"`, { timeout: 10000 });
        const xmlContent = await readFile(`${tmpDir}/word/document.xml`, 'utf-8');
        const text = xmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const fileStat = await stat(filePath);
        await execAsync(`rm -rf "${tmpDir}"`).catch(() => {});
        return truncate(
          `Material: ${path} (${formatSize(fileStat.size)}, .docx text extracted)\n\n${text}`,
          READ_CAPACITY,
        );
      } catch {
        return `Material: ${path}\nType: Word (.docx)\nUnable to extract text.`;
      }
    }

    // PDF
    if (ext === '.pdf') {
      try {
        const { extractWithPython, extractWithPdfParse } = await import('@/lib/pdf/extractor');
        const fileStat = await stat(filePath);
        const pyResult = await extractWithPython(filePath);
        if (pyResult.text && pyResult.text.length > 20) {
          return truncate(
            `Material: ${path} (${formatSize(fileStat.size)}, PDF via ${pyResult.method})\n\n${pyResult.text}`,
            READ_CAPACITY,
          );
        }
        const fallback = await extractWithPdfParse(filePath);
        if (fallback.text && fallback.text.length > 20) {
          return truncate(
            `Material: ${path} (${formatSize(fileStat.size)}, PDF via pdf-parse)\n\n${fallback.text}`,
            READ_CAPACITY,
          );
        }
        return `Material: ${path}\nType: PDF (scanned/image-based)\nUnable to extract text automatically.`;
      } catch {
        return `Material: ${path}\nType: PDF\nUnable to extract text.`;
      }
    }

    // Images - return basic info
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    if (imageExts.includes(ext)) {
      const fileStat = await stat(filePath);
      return `Material: ${path}\nType: Image (${ext})\nSize: ${formatSize(fileStat.size)}\nImages in materials are for reference.`;
    }

    // 其他二进制文件
    const fileStat = await stat(filePath);
    return `Material: ${path}\nType: Binary (${ext})\nSize: ${formatSize(fileStat.size)}\nCannot read binary file content.`;
  } catch (e) {
    return `Error reading material: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 读取上游连线节点的完整 .md 文档 */
async function toolReadUpstreamNode(args: Record<string, unknown>): Promise<string> {
  const nodeId = args.node_id as string | undefined;
  const title = args.title as string | undefined;
  if (!nodeId && !title) return 'Error: node_id or title required';

  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const { readdir } = await import('fs/promises');
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const { getAncestorChain } = await import('@/lib/nodes/ancestors');

    const project = await getCurrentProject();
    const nodesDir = join(project.path, 'notes-memory');

    // 按 node_id 查找（通过 frontmatter 匹配，非文件名前缀）
    if (nodeId) {
      const filePath = await findNodeFileById(nodeId, project.path);
      if (filePath) {
        const content = await readFile(filePath, 'utf-8');
        const parsed = parseNodeMarkdown(content);
        const extractedTitle = parsed.frontmatter.title || nodeId;
        return truncate(
          `Node document: ${extractedTitle}\nNode ID: ${nodeId}\n\n${content}`,
          READ_CAPACITY,
        );
      }
      return `No upstream node found with node_id "${nodeId}".`;
    }

    // 按标题匹配（扫描所有 .md 文件的 frontmatter）
    if (title) {
      const files = await readdir(nodesDir);
      const mdFiles = files.filter((f) => f.endsWith('.md'));
      for (const file of mdFiles) {
        const content = await readFile(join(nodesDir, file), 'utf-8');
        const parsed = parseNodeMarkdown(content);
        const extractedTitle = parsed.frontmatter.title || '';
        if (extractedTitle === title) {
          return truncate(
            `Node document: ${title}\nNode ID: ${parsed.frontmatter.node_id}\nFile: ${file}\n\n${content}`,
            8000,
          );
        }
      }
      return `No upstream node found with title "${title}".`;
    }

    return 'Error: node_id or title required';
  } catch (e) {
    return `Upstream node read failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 读取祖先节点的结构化目录（manifest，不含内容正文） */
async function toolReadManifest(args: Record<string, unknown>): Promise<string> {
  const nodeId = args.node_id as string;
  if (!nodeId) return 'Error: node_id required';

  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const { readManifest } = await import('@/lib/nodes/manifest');
    const project = await getCurrentProject();
    if (!project) return 'Error: No active project';

    const manifest = await readManifest(nodeId, project.path);
    if (!manifest) return `Node ${nodeId} not found or has no manifest.`;

    const lines = manifest.sections.map((s) => {
      const tags = [
        s.type,
        s.anchor ? `#${s.anchor}` : '',
        s.time ? `(${s.time})` : '',
        s.sensitive ? '[个人笔记]' : '',
      ].filter(Boolean).join(' ');
      const kw = s.keywords.length > 0 ? ` | 关键词: ${s.keywords.slice(0, 6).join('、')}` : '';
      return `- [${tags}] ${s.title}${kw}`;
    });
    return `节点「${manifest.title}」目录（共 ${manifest.sections.length} 条，状态: ${manifest.outcomeStatus}）：\n${
      lines.join('\n') || '（空）'
    }`;
  } catch (e) {
    return `read_manifest failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 检索员实习生：按指令查祖先节点 manifest → 锚点定位 → 返回原文（R-19 ~ R-24） */
async function toolInternSearch(args: Record<string, unknown>): Promise<string> {
  const targetNodeId = args.target_node_id as string;
  const instruction = args.instruction as string;
  const currentNodeId = args.current_node_id as string;
  if (!targetNodeId || !instruction) return 'Error: target_node_id and instruction required';
  if (!currentNodeId) return 'Error: current_node_id required（当前节点 id，用于祖先链校验）';

  try {
    const { getCurrentProject } = await import('@/lib/project/project-manager');
    const { internSearchNode, INTERN_MAX_ROUNDTRIP } = await import('@/lib/nodes/intern');
    const project = await getCurrentProject();
    if (!project) return 'Error: No active project';

    const res = await internSearchNode(
      {
        targetNodeId,
        instruction,
        maxResults: typeof args.max_results === 'number' ? Math.floor(args.max_results) : 5,
        roundTrip: typeof args.round_trip === 'number' ? Math.floor(args.round_trip) : 1,
      },
      project.path,
      project.id,
      currentNodeId,
    );

    if (res.status === 'found') {
      return `[实习生返回 · 节点「${res.sourceTitle}」] ${res.disclaimer}（引用时须标 [存疑] 或转入 pending，不得标 [确定]）\n${res.content}`;
    }
    if (res.status === 'exhausted') {
      return `status=exhausted：已完成 ${INTERN_MAX_ROUNDTRIP} 轮检索仍无结果。${res.disclaimer} 请停止该条推理线，在 pending 中写明「上游 ${targetNodeId} 中未找到相关内容，需人工确认」，不得基于假设继续计算。`;
    }
    return `status=not-found：${res.content}${res.disclaimer} 若仍需要，可改写关键词后再试一次（round_trip +1，上限 ${INTERN_MAX_ROUNDTRIP}）。`;
  } catch (e) {
    return `intern_search failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============================================================
// 构建工具注册表
// ============================================================

/** 工具定义：name + schema + executor + 元数据 */
const toolDefs: Tool[] = [
  {
    name: 'finish_task',
    description: 'Signal that the current task is fully completed. This tool marks the end of the agent\'s work. It should ONLY be called when all required steps have been successfully executed and the final answer or deliverable has been produced. Calling this tool will immediately end the current turn and deliver the results to the user. Do NOT use this tool prematurely or as a substitute for actually completing the work.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'A brief summary of what was accomplished in this task. This will be logged for audit purposes.',
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
    description: 'Publish the full task step list with current statuses (replacement semantics). This is the ONLY planning + execution-tracking tool for multi-step tasks: the FIRST call creates the track (supply goal + all steps as status=pending), and EVERY step boundary call (a step becomes in_progress, or transitions to completed/failed) resends the FULL latest snapshot. Each call REPLACES the entire list — do NOT diff, do NOT patch. MANDATORY for any multi-step task (multiple tool calls, search→analyze→write flows); do NOT call for single-step or trivial conversational tasks (panel would be noise). Status transitions: pending → in_progress → completed (or failed on error). activeForm is shown ONLY while status=in_progress and gives the user a one-line "currently doing X" signal — keep it concrete and verb-led. Never estimate progress yourself by counting tool calls: the real progress is exactly what you report here.',
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
          description: 'The ultimate goal or deliverable of the entire task, shown at the top of the steps panel. Only needs to be set on the FIRST (track-creating) call; may be omitted on subsequent status-heartbeat calls. (e.g., "Find the user ID for Selenasaid")',
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
    description: 'Read file content. Supports text files like source code, configs, documents etc. Supports relative paths (based on workspace root), absolute paths, and ~ for home directory. .docx files are automatically extracted to plain text (paragraphs and table rows preserved), so you can read generated Word documents directly to verify content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path. Relative paths based on workspace root; "homework/..." and "attachments/..." resolve to the project root (e.g. "homework/报告.html"). Also supports absolute paths or ~/ paths. e.g. "homework/报告.html", "src/main.ts" or "~/.bashrc"',
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
    description: 'Write or create a file. Parent directories are auto-created. Use for code generation, config editing, document creation etc. IMPORTANT: to save a project deliverable, the path MUST start with "homework/" (e.g. "homework/报告.html") so it lands in the project homework/ folder and is shown as an output card. Paths NOT starting with "homework/" or "attachments/" resolve to the temporary workspace and count as scratch files only.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path. Use "homework/<filename>" for final deliverables (saved to project homework/ folder, shown as output card, e.g. "homework/报告.html"). Bare relative paths resolve to the temporary workspace (scratch only, not shown as output). Supports absolute and ~/ paths.',
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
    description: 'Edit a file by replacing the FIRST exact occurrence of "search" with "replace" (SearchReplace-style). PREFER this over write_file for small iterative edits on existing files (large files, one-line changes, fixing a bug) — avoids rewriting the whole file and burning tokens. The search text must match the file content character-for-character (including indentation/newlines); if not found, the error includes the file head to help you craft a correct search. For sandbox mini-app files it writes atomically with automatic .history snapshot (recoverable via sandbox_rollback).',
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
  {
    name: 'sandbox_rollback',
    description: 'List or restore previous versions of a Bob Sandbox mini-app file. Every write_file / edit_code on a mini-app file auto-saves a snapshot under bob-sandbox/apps/<appId>/.history/ (keeps the most recent ones). Use when the latest edit broke the app: action="list" to see available versions, then action="restore" with a stamp to bring back an older version. After restore, re-verify with capture_preview.',
    parameters: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The Bob Sandbox app id (folder name under bob-sandbox/apps/).',
        },
        file: {
          type: 'string',
          description: 'Relative file path inside the app, e.g. index.html.',
        },
        action: {
          type: 'string',
          enum: ['list', 'restore'],
          description: 'list=show available versions (default); restore=write back a previous version.',
        },
        stamp: {
          type: 'string',
          description: 'For restore: the version timestamp prefix shown by action="list". Omit to restore the most recent snapshot.',
        },
      },
      required: ['appId', 'file'],
    },
    category: '文件',
    execute: toolSandboxRollback,
    maxOutput: 2000,
  },
  {
    name: 'sandbox_export',
    description: 'Export a Bob Sandbox mini-app as a standalone single-file HTML page for sharing or publishing. Inlines the app\u2019s own relative css/js references (local <link href> and <script src> become inline <style>/<script>), keeps external CDN links untouched. Output is written to bob-sandbox/exports/<appId>-<ts>.html — open it directly in a browser or share the file.',
    parameters: {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'The Bob Sandbox app id (folder name under bob-sandbox/apps/).',
        },
      },
      required: ['appId'],
    },
    category: '文件',
    execute: toolSandboxExport,
    maxOutput: 800,
  },
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
    description: 'Execute a shell command and return output. Use for running tests, building, git operations, process inspection etc. Runs in workspace root. Timeout: install commands (pip/npm/brew/cargo etc.) get 180s, all others 30s. Files generated by the command land in the workspace root unless you use an absolute path or a "homework/"-prefixed path (project deliverables should use "homework/...").',
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
    description: 'Write and execute a script (Python or Shell) to solve problems autonomously. When encountering issues not solvable by other tools, write a script to analyze, fix, or automate the solution. Supports Python (python3) and Shell (bash). Script runs in the project AI workspace (homework/.ai-workspace/) with 30s timeout. Use this for data processing, file manipulation, automation, analysis etc. IMPORTANT PATH RULE: the script CWD is homework/.ai-workspace/, NOT the project root. Writing a relative path like "homework/xxx.png" inside the script will land at homework/.ai-workspace/homework/xxx.png, which the UI CANNOT see. To produce a visible deliverable, write to the ABSOLUTE path from env var BOB_PROJECT_HOMEWORK: Python: os.path.join(os.environ["BOB_PROJECT_HOMEWORK"], fn); Shell: "$BOB_PROJECT_HOMEWORK/fn". Also use it to read project homework files. Then print "OutputFile: homework/<filename>" so the file is shown to the user.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'shell'],
          description: 'Script language. "python" for Python3, "shell" for Bash.',
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
  {
    name: 'web_search',
    description:
      'Search the web for information. Use when you need latest info, facts, or real-time content. Multiple search engines with auto-fallback. When the query returns multiple results, present them as an ai-card card list (one .ai-card per result with title/meta/body).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords. e.g. "Next.js 16 standalone mode", "Python asyncio tutorial"',
        },
      },
      required: ['query'],
    },
    category: '网络',
    execute: toolWebSearch,
    maxOutput: 5000,
  },
  {
    name: 'web_fetch',
    description: 'Fetch content from a specific URL. Use when the user provides a link (e.g. pasted URL) and you need the webpage content, or to retrieve a known URL directly.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to fetch, e.g. https://example.com/page',
        },
      },
      required: ['url'],
    },
    category: '网络',
    execute: toolWebFetch,
    maxOutput: 8000,
  },
  {
    name: 'read_attachment',
    description: 'Read user-uploaded attachment content. Supports: text/code files (txt/md/json/csv etc., GBK/GB18030 encoding auto-detected), Excel (.xls/.xlsx per-sheet rows; sheet param picks a single sheet), Word (.docx structure-preserving incl. tables/lists; legacy .doc/.rtf via textutil), PowerPoint (.pptx per-slide text), PDF (native extract or scanned OCR), images (.png/.jpg/.jpeg/.gif/.webp etc. OCR/vision), video (ffmpeg frame analysis), audio (STT transcription), and .zip archives (safely unpacked to homework/.unpacks/, then read inner files one by one). Long text/Word/Excel/PPT content beyond the single-return limit prints a next-offset marker — re-call with offset=<value> to keep reading. When user questions involve attachment content, proactively call this tool. EFFICIENCY: recognition results are cached by content hash — re-reading the same image/page (even under a different filename) returns the cached result instantly. For scanned PDFs, prefer page-range reads (pages="x-y") or reading already-rendered page images over re-recognizing the whole document each time. ASYNC NOTE: large scanned PDFs (>=15 pages or >=5MB, full-document read) are recognized in the background — the first call returns a "⏳ recognizing in background" notice, then a SECOND call on the same file returns the result instantly from cache. Do not treat the first notice as failure; just call this tool again on the same path after a moment.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Attachment path, format: attachments/{nodeId}/{filename} (relative to project root). Get from the attachment list in user message. Uploaded attachments are already copied into the project attachments/ folder, so read them directly with this tool — do NOT ask the user for permission or a Downloads/Desktop path, and do NOT emit AUTH_REQ for attachments. You may also pass an absolute path (or ~/ path) of a file inside a user-authorized directory — it will be resolved and read directly.',
        },
        pages: {
          type: 'string',
          description: '可选，仅扫描件 PDF 生效：按页读取，格式如 "1-5"、"3"、"6,8-10"。用于长 PDF 分片读取——不传时读取全部页，若内容超过单次上限会在返回头部标注已返回的页码区间，并提示用本参数继续读取剩余页（如 pages="6-14"）。',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: '可选，通用续读偏移（文本/Word/Excel(.xls/.xlsx)/PPT 等）：内容超过单次输出上限被截断时，返回头部会标注 "offset=<数值>"，把该数值原样传回即可继续读取后半部分。不传=从头读。',
        },
        sheet: {
          type: 'string',
          description: '可选，仅 Excel(.xls/.xlsx) 生效：按 sheet 名（不区分大小写）只读该表；不传=输出全部 sheet。指定不存在的 sheet 时会返回可用 sheet 清单。',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolReadAttachment,
    maxOutput: 8000,
  },
  {
    name: 'ocr_document',
    description: 'OCR 识别（独立工具）：对 PDF 扫描件或图片做高质量文字识别，返回结构化结果（逐页文本 + 质量评分 + 余额勾稽校验报告）。【级联原则】印刷体（正文、证件复印件、印章防伪码）默认走本地 macOS Vision（确定性、零成本、结果稳定），仅在本地质量低（qualityScore<0.30）/文本为空/勾稽异常时自动升级 VLM。因此手写填写字段（姓名、身份证、日期）识别多次给出不同候选属正常波动——不要为求稳定而反复整页重试，应改用 crop_image 只裁剪可疑区域单独复核，或直接标注【需人工复核】核对原件。区别于 read_attachment：本工具聚焦纯 OCR，不处理 docx/视频等，返回更精简且带质量元数据。适用于：扫描版合同/判决书/银行流水/证据材料的文字提取；图片中的文字识别；旋转 90° 扫描的表格（自动转置）。传入文件路径（支持 attachments/ 相对路径、homework/ 相对路径或绝对路径），识别结果含每页 [Page N] 头、qualityScore（0-1 文本质量）、ledgerVerified（流水表格页余额勾稽一致行数，-1 表示非流水页）。增强仅用于识别辅助，原始扫描图始终保留。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径：attachments/{nodeId}/{filename}（项目内附件）或 homework/ 相对路径或绝对路径。支持 PDF（扫描件自动 OCR）与图片（png/jpg/jpeg/gif/webp/bmp/tif）。',
        },
        upgrade: {
          type: 'string',
          enum: ['off', 'auto', 'always'],
          description: '可选，VLM 升级策略：off=纯本地识别（默认，无需视觉模型）；auto=本地质量低（qualityScore<0.30）/勾稽异常/文本为空时，该页自动升级走视觉大模型；always=所有页全部走视觉大模型。auto/always 需在 Role Assignment 配置 Vision Model，未配置时静默退化为纯本地。返回结果中会标注每页是否经 VLM 升级。',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolOcrDocument,
    maxOutput: 8000,
  },
  {
    name: 'crop_image',
    description: '图像 ROI 裁剪（中文）：从整页图片中裁出指定坐标区域（手写字段栏、印章、签名、日期等），输出到 homework/.crops/（隐藏中间产物目录，侧边栏与 Finder 不可见，任务结束即清理）。用于扫描件识别中"只对可疑区域单独复核"，避免反复整页重识别浪费轮次。传入图片路径 + bbox=[x1,y1,x2,y2]（像素坐标，图片左上角为原点，x 向右 y 向下，需 x1<x2 且 y1<y2）；可选 margin=外扩像素（默认 8，避免裁掉笔画）、scale=放大倍率（默认 2，便于看清手写）。裁剪后把返回的输出路径传给 ocr_document / read_attachment 或视觉模型单独识别该字段。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '图片路径：attachments/{nodeId}/{filename}、homework/ 相对路径或绝对路径。',
        },
        bbox: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: '裁剪区域 [x1,y1,x2,y2]（像素）。图片左上角为原点，x 向右、y 向下，需 x1<x2 且 y1<y2。',
        },
        margin: {
          type: 'number',
          description: '可选，外扩像素，默认 8，避免裁掉笔画边缘。',
        },
        scale: {
          type: 'number',
          description: '可选，放大倍率，默认 2，便于 VLM 看清手写小字。',
        },
      },
      required: ['path', 'bbox'],
    },
    category: '文件',
    execute: toolCropImage,
    maxOutput: 2000,
  },
  {
    name: 'read_upstream_node',
    description: 'Read the full .md document of an upstream connected node. Use node_id (preferred, from the upstream node index in system prompt) or title to identify the node. Can be called multiple times for multiple nodes. Note: only reads nodes within the current project.',
    parameters: {
      type: 'object',
      properties: {
        node_id: {
          type: 'string',
          description: 'Node id (e.g. n_001) from the upstream node index in system prompt. Preferred over title for precise matching.',
        },
        title: {
          type: 'string',
          description: 'Title of the upstream node (fallback, use node_id when available). Must match exactly the title in the index table.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadUpstreamNode,
    maxOutput: 8000,
  },
  {
    name: 'read_manifest',
    description: 'Read the structured directory (manifest) of an ancestor node: lists all indexed entries (conversations, annotations, attachments) with anchors and keywords, WITHOUT content. Use to see what an ancestor node contains before fetching details. Pass the ancestor node_id from the upstream ancestor declaration in system prompt.',
    parameters: {
      type: 'object',
      properties: {
        node_id: {
          type: 'string',
          description: 'Ancestor node id (e.g. n_001) from the upstream ancestor declaration.',
        },
      },
      required: ['node_id'],
    },
    category: '文件',
    execute: toolReadManifest,
    maxOutput: 8000,
  },
  {
    name: 'intern_search',
    description: 'Fetch original conversation fragments from an ancestor node by instruction. The intern matches the instruction against the node manifest keywords (with legal synonym expansion), locates anchor blocks, and returns original text verbatim (read-only, no processing). Returned content is always marked [原始对话·未认定] - treat as unverified, mark [存疑] or move to pending, NEVER mark [确定]. Max 2 round trips; on exhaustion stop that reasoning line and note "需人工确认" in pending. target_node_id must be an ancestor of current_node_id.',
    parameters: {
      type: 'object',
      properties: {
        target_node_id: {
          type: 'string',
          description: 'Ancestor node id to search in (from upstream ancestor declaration).',
        },
        instruction: {
          type: 'string',
          description: 'What to look for (keywords will be matched with synonym expansion).',
        },
        current_node_id: {
          type: 'string',
          description: 'Current node id (for ancestor-chain validation).',
        },
        max_results: {
          type: 'number',
          description: 'Max hits, default 5.',
        },
        round_trip: {
          type: 'number',
          description: 'Round trip counter, start at 1, max 2.',
        },
      },
      required: ['target_node_id', 'instruction', 'current_node_id'],
    },
    category: '文件',
    execute: toolInternSearch,
    maxOutput: 8000,
  },
  {
    name: 'read_material',
    description: 'Read a material file from the project materials folder. Materials are files uploaded by the user as reference documents (e.g. PDFs, reports, images, code files). When user refers to "@filename" in their message, use this tool to read the referenced material. Pass the material file path from the user message. NOTE: materials live at <project>/materials/ (NOT in your workspace root, which only contains scripts/). Always read materials with THIS tool; do NOT use list_directory/read_file on the workspace root to locate them — they are listed in the material reference list in the user message.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Material file path, format: materials/{filename}. Get from the material reference list in user message.',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: toolReadMaterial,
    maxOutput: 8000,
  },
  {
    name: 'read_todo',
    description: 'Read WANTED todo records from the current project. Use to query what tasks were recently added, tasks of a specific category (会议/开发/文档/学习/沟通/生活/规划/其他), or today\'s schedule. Supports filtering by time range (today/week/all) and category.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['today', 'week', 'all'],
          description: 'Time filter: "today" for today\'s tasks, "week" for recent 7 days, "all" for everything (default).',
        },
        category: {
          type: 'string',
          description: 'Category filter: 会议(meetings), 开发(development), 文档(documentation), 学习(learning), 沟通(communication), 生活(life), 规划(planning), 其他(other). Leave empty for all categories.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadTodo,
    maxOutput: 5000,
  },

  {
    name: 'read_notebook',
    description: 'Search/read personal notes from the Karpathy-style wiki (notes/wiki/, AI-compiled interlinked markdown, with type/tags/links). Supports keyword search (query, matches title+tags+content) and exact tag filtering (tag, comma-separated = AND). No vector search. "index" mode (default) returns the type/topic index with counts; when searching it lists each hit with id + short excerpt (token-efficient). "full" mode returns full note bodies when few hits (<=3); for more hits it returns id + excerpts only — then call read_note <id> to read a specific note in full. Use when the user asks about their recorded ideas, notes, or personal knowledge.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['index', 'full'],
          description: '"index" (default) returns the index with counts + hit excerpts; "full" returns matching note bodies (<=3 hits) or excerpts with ids (many hits).',
        },
        query: {
          type: 'string',
          description: 'Keyword to search (case-insensitive, matches title, tags and content). e.g. "读书" to find all notes mentioning reading.',
        },
        tag: {
          type: 'string',
          description: 'Exact tag to filter. Comma-separated multiple tags = AND, e.g. "证据链,合同".',
        },
        from: {
          type: 'string',
          description: 'Start date YYYY-MM-DD (inclusive) to filter notes by date.',
        },
        to: {
          type: 'string',
          description: 'End date YYYY-MM-DD (inclusive) to filter notes by date.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadNotebook,
    maxOutput: 5000,
  },
  {
    name: 'read_note',
    description: 'Read ONE note from the personal wiki in full by its id (e.g. "w-xxx"). Use AFTER read_notebook returns many hits as excerpts, to read the exact note(s) that look relevant. Each read_notebook hit line includes "id: <id>". Prefer this over read_notebook full mode when you only need one or two notes\' full content (token-efficient).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (w-xxx) shown in read_notebook hits.',
        },
      },
      required: ['id'],
    },
    category: '文件',
    execute: toolReadNote,
    maxOutput: 8000,
  },
  {
    name: 'read_note_history',
    description: 'List the saved version history of ONE wiki note (id w-xxx). Each version has a "time" value. Use when the user suspects a note was corrupted by a bad compile/merge and asks "这篇之前是什么样 / 能回滚吗" — then restore_note with the chosen time. Note-node context.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (w-xxx).',
        },
      },
      required: ['id'],
    },
    category: '文件',
    execute: toolReadNoteHistory,
    maxOutput: 4000,
  },
  {
    name: 'restore_note',
    description: 'Restore a wiki note to one of its saved history versions (id w-xxx + time from read_note_history). Rolls back the body only; type/tags/links stay current; the restore itself also leaves a snapshot so it is reversible. ONLY call when the user explicitly asks to restore/revert a note to an earlier version.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (w-xxx).',
        },
        time: {
          type: 'number',
          description: 'History version time (from read_note_history).',
        },
      },
      required: ['id', 'time'],
    },
    category: '文件',
    execute: toolRestoreNote,
    maxOutput: 3000,
  },
  {
    name: 'read_raw_inbox',
    description: 'List the raw/ inbox (material layer) — what has been clipped/saved but not yet compiled. Returns each item with its id (r-xxx), title, source URL, status (uncompiled/compiled) and a body preview. Note-node only. Use FIRST when the user asks 素材箱里有什么 / inbox 有哪些 / 有哪些待编译的素材 / 让我挑几条编译 — then compare against existing notes via read_notebook, tell the user which raw items match existing notes (would merge, not create new), and pass the chosen ids to ingest_notes.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'uncompiled', 'compiled'],
          description: 'Filter: all (default) / uncompiled=待编译 / compiled=已编译.',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolReadRawInbox,
    maxOutput: 5000,
    scenes: ['notebook'],
  },
  {
    name: 'update_notebook',
    description: 'Modify one note in the wiki (notes/wiki/) by its id. Use when the user asks to change/update a specific recorded note, e.g. "把笔记改成…" or "给这条笔记换个标题". Only update the provided fields (title/content/tags); other fields are preserved. Use read_notebook (full mode) to find the id first.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (e.g. "w-xxx"), shown by /note check mail or read_notebook full mode. Required.',
        },
        title: {
          type: 'string',
          description: 'New title for the note. Optional if content/tags is provided.',
        },
        content: {
          type: 'string',
          description: 'New full content of the note. Optional if title/tags is provided.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New free-form tags (max 5, 2-6 char short topic words). e.g. ["证据链", "合同"].',
        },
      },
      required: ['id'],
    },
    category: '文件',
    execute: toolUpdateNotebook,
    maxOutput: 3000,
  },
  {
    name: 'delete_notebook',
    description: 'Delete one note from the wiki (notes/wiki/) by its id. Use ONLY when the user explicitly asks to delete/remove a specific recorded note (e.g. "删掉那条笔记", "把笔记删了") — never auto-delete notes on your own. Use read_notebook (full mode) or /note check mail to find the id first; if the id is unknown, ask the user which note to delete. This is irreversible.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Note id (e.g. "w-xxx"). Required. Find it via read_notebook full mode or the /note check mail.',
        },
      },
      required: ['id'],
    },
    category: '文件',
    execute: toolDeleteNotebook,
    maxOutput: 2000,
  },
  {
    name: 'write_notebook_answer',
    description: 'Backfill (write back) an answer/analysis into the personal wiki — the Karpathy "answers compound into knowledge" loop. Use AFTER answering a question based on read_notebook, when the user says "把答案记下来 / 存进笔记 / 沉淀一下", or when an answer is valuable enough to keep. The content is stored directly (no re-compile). MERGE-AWARE: if title exactly matches an existing note (or you pass merge_into with its title), it updates that note instead of creating a new one — new content first, old kept below a divider; only brand-new topics create a new note. Pass links with referenced note titles/ids so the note connects to the knowledge graph. type: concept (knowledge point) / note (analysis/idea) / source / todo; default note.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the note (<=20 chars). Required if content present.' },
        content: { type: 'string', description: 'The answer/analysis body (markdown). Required if title present.' },
        type: { type: 'string', enum: ['concept', 'source', 'note', 'todo'], description: 'Note type. Default note.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free topic tags (0-5, 2-6 char words). e.g. ["证据链"]' },
        links: { type: 'array', items: { type: 'string' }, description: 'Linked note titles or ids (the knowledge this answer builds on).' },
        merge_into: { type: 'string', description: 'Optional: title of an existing note to merge this answer into (updates it, does not create a duplicate). Omit to create a new note.' },
      },
      required: ['title', 'content'],
    },
    category: '文件',
    execute: toolWriteNotebookAnswer,
    maxOutput: 3000,
  },
  {
    name: 'create_note',
    description: 'Record material the user wants to keep into the notes system (Karpathy raw-first capture loop). Use when the user asks to record/save/keep something ("帮我记一笔…", "把这段记到笔记里", "记一下…"), shares an idea/thought worth keeping, or when an earlier note is now wrong and the user provides a correction/update. The content is DROPPED INTO raw/ and compiled by the notes brain (equivalent to /note): the brain decides title/type/tags/links and merges same-topic content into the existing note — feed corrections/updates here and the brain updates the original entry. Only use update_notebook / delete_notebook for structural fixes (rename / delete an entry).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional short title/label for the material (<=30 chars). The brain decides the final wiki title.' },
        content: { type: 'string', description: 'The material body (markdown). Required. Corrections/updates of existing notes: put the new/corrected facts here.' },
      },
      required: ['content'],
    },
    category: '文件',
    execute: toolCreateNote,
    maxOutput: 4000,
    timeoutMs: 180000,
  },
  {
    name: 'ingest_notes',
    description: 'Compile pending raw material(s) into the wiki (Karpathy ingest loop) — Note-node only. Triggers the bob-notes-mcp brain model (its own separately-configured model) to compile the raw/ inbox into interlinked notes (with merge_into dedupe). Pass ids (raw ids or r-xxx prefix) to compile only those; omit to compile all pending. Use when the user, in the notes node, asks to compile/整理/入库 raw material (等价 /note ingest).',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Optional raw ids (or r-xxx prefix) to compile; omit for all pending.' },
      },
    },
    category: '文件',
    execute: toolIngestNotes,
    maxOutput: 4000,
    scenes: ['notebook'],
  },
  {
    name: 'review_notes',
    description: 'Run the review & rescue pass over the wiki (Karpathy review): picks the most stale notes and the bob-notes-mcp brain model decides rescue (promote / rewrite) or sink (demote, never delete). Note-node only. Use when the user asks 回看/打捞/review the notes (等价 /note review).',
    parameters: { type: 'object', properties: {} },
    category: '文件',
    execute: toolReviewNotes,
    maxOutput: 3000,
    scenes: ['notebook'],
  },
  {
    name: 'lint_notes',
    description: 'Health-check the personal wiki (Karpathy lint): broken links / orphan notes / duplicate titles (deterministic) plus an LLM contradiction check across notes (brain model). Note-node only. Use when the user asks 自检/lint/查矛盾 (等价 /note lint).',
    parameters: { type: 'object', properties: {} },
    category: '文件',
    execute: toolLintNotes,
    maxOutput: 3000,
    scenes: ['notebook'],
  },
  {
    name: 'read_note_rules',
    description: 'Read the knowledge-base organizing rules (SCHEMA.md — the user-preference charter the notes brain loads before every ingest/review). Note-node only. Use before tweaking rules or when asked how notes get organized.',
    parameters: { type: 'object', properties: {} },
    category: '文件',
    execute: toolReadNoteRules,
    maxOutput: 4500,
    scenes: ['notebook'],
  },
  {
    name: 'set_note_rules',
    description: 'Record an organizing preference/rule the notes brain must follow (SCHEMA.md). Note-node only. VETO RIGHT: you may DECLINE (do not call) a rule you judge unnecessary, vague, harmful, or conflicting with knowledge-base boundaries (no deletion, no rewriting raw, no degrading future maintenance) — when you decline, you MUST reply to the user with the reason and a concrete better suggestion, never record blindly to please. CALL ONLY when the user states a repeatable, concrete, executable organizing preference with future intent in this node ("以后这类素材都…", "帮我记一条整理规则：标签用两三个字"). DO NOT record: one-off remarks about a single note, general chat habits (use remember_preference instead), vague praise/criticism. If unsure the user wants it kept as a rule, ASK first ("要记成整理规则吗？"). Keep each rule within 120 chars. Default append:true — dedup + 24-item cap enforced server-side; when it reports "未记录", tell the user why and suggest consolidating old rules.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Rule text (appends one preference line, or full replacement when append=false).' },
        append: { type: 'boolean', description: 'Default true = append; false = overwrite the whole SCHEMA.md.' },
      },
      required: ['content'],
    },
    category: '文件',
    execute: toolSetNoteRules,
    maxOutput: 3000,
    scenes: ['notebook'],
  },
  {
    name: 'remember_preference',
    description: 'Record a user preference/habit into global long-term memory (wanted/preferences.md), with structured metadata (type/created_at/source). Call when: (1) the user explicitly asks to remember something (e.g. "记住：以后都用表格输出", "以后引用法条记得标注时效性"), OR (2) the user expresses a clear preference/habit signal (e.g. "我习惯…", "以后都这样", or repeats the same working style twice or more) AND you first proactively ask "需要我把这条记入长期偏好吗？" and the user approves. NEVER record without user consent — if you suggest remembering but the user declines or does not clearly agree, do NOT call this tool. Do NOT record ordinary conversation content on your own. Use content for a one-sentence description of the preference; type is optional and can classify it (e.g. 输出格式 / 引用规范 / 任务流程 / 沟通风格), defaulting to 通用 when omitted.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'One-sentence preference description, e.g. "用户习惯用表格输出" or "引用法条必须标注时效性". Required.',
        },
        type: {
          type: 'string',
          description: 'Optional category for this preference, e.g. 输出格式 / 引用规范 / 任务流程 / 沟通风格. Omit to default to 通用. Prefer to infer the type from the user\'s intent (what aspect of behavior it governs).',
        },
      },
      required: ['content'],
    },
    category: '记忆',
    execute: toolRememberPreference,
    maxOutput: 2000,
  },
  {
    name: 'read_preferences',
    description: 'List all recorded user preferences (global long-term memory, wanted/preferences.md) with index/type/created_at. Use when the user asks "我有哪些偏好" / "你记住了我什么习惯", or before delete_preference to see valid indexes. Optional type filter lists only preferences of that category.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Optional: only list preferences of this type/category (e.g. 输出格式). Omit to list all.',
        },
      },
      required: [],
    },
    category: '记忆',
    execute: toolReadPreferences,
    maxOutput: 4000,
  },
  {
    name: 'delete_preference',
    description: 'Delete one recorded user preference by its index (manual forgetting, wanted/preferences.md). Use read_preferences first to see valid indexes. The user decides what to forget; do not auto-delete.',
    parameters: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'Preference index (1-based), as shown by read_preferences. Required.',
        },
      },
      required: ['index'],
    },
    category: '记忆',
    execute: toolDeletePreference,
    maxOutput: 2000,
  },
  {
    name: 'update_preference',
    description: 'Atomically update one recorded user preference by its index (wanted/preferences.md). Use when the user asks to change/modify a recorded preference, e.g. "把第 2 条改成…" or "第 1 条的类型改成引用规范". Only update the fields provided (content and/or type); created_at/source are preserved. Use read_preferences first to see valid indexes and current values.',
    parameters: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'Preference index (1-based), as shown by read_preferences. Required.',
        },
        content: {
          type: 'string',
          description: 'New one-sentence preference content. Optional if type is provided.',
        },
        type: {
          type: 'string',
          description: 'New category (e.g. 输出格式 / 引用规范 / 任务流程 / 沟通风格). Optional if content is provided.',
        },
      },
      required: ['index'],
    },
    category: '记忆',
    execute: toolUpdatePreference,
    maxOutput: 2000,
  },


  {
    name: 'scan_docx_templates',
    description: '扫描 Word 模板（.docx）中的 Jinja2 占位符（{{ 字段名 }}）。支持指定自定义目录（dir="..."）或显式文件列表（files=["/abs/path/a.docx"]），典型场景是用户上传了 .docx 模板附件后由 AI 调用扫描其中的字段。返回 JSON，包含每个模板的字段列表（key/raw/kind）以及合并去重后的 unique_placeholders 字段总表。AI 和用户确认字段时必须先调用此工具，避免漏字段或填错字段名。仅支持 .docx。',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '自定义模板文件夹绝对路径（包含 .docx 文件）。',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '显式列出单个或多个 .docx 文件路径（如 attachments/{nodeId}/{filename}）。和 dir 同时提供时会合并去重。',
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolScanDocxTemplates,
    maxOutput: 8000,
  },
  {
    name: 'fill_docx_templates',
    description: '用 JSON 数据批量填写 Word 模板（仅 .docx）。1) 指定模板：dir（自定义模板目录）或 files（模板文件列表，如 attachments/{nodeId}/{filename}）；2) 提供数据：context={...} 单套数据或 rows=[{...},{...},...] 多套批量；3) 可选 namingRule 自定义输出文件名（Python str.format 风格：{templatePrefix} {rowIndex:03d} {contractNo} {signDate}）。输出 JSON，包含生成的所有文件绝对路径、文件大小，以及自动打包的 zip 路径。所有文件落在项目 homework/template/docx_fill_*/ 下并自动在前端展示。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '自定义模板目录绝对路径' },
        files: { type: 'array', items: { type: 'string' }, description: '显式列出的模板文件路径数组（如 attachments/{nodeId}/{filename}）' },
        context: {
          type: 'object',
          description: '单套数据（键值对），如 {"contractNo":"CG-001","甲方名称":"北京XX公司"}。与 rows 二选一，优先 context。',
        },
        rows: {
          type: 'array',
          items: { type: 'object' },
          description: '批量多套数据（N 份），每一行一套完整字段。N 行 × M 模板 = N×M 份输出文件。',
        },
        namingRule: {
          type: 'string',
          description: `输出文件名规则（Python str.format 风格，单花括号），可用变量：{templatePrefix}（如 01采购合同模板）、{templateBasename}、{templateNo}、{templateBasenameOrig}、{rowIndex}（从0开始）、{contractNo}、{signDate}。默认值："{templatePrefix}_{templateBasename}__R{rowIndex:03d}__{contractNo}.docx"`,
        },
      },
      required: [],
    },
    category: '文件',
    execute: toolFillDocxTemplates,
    maxOutput: 8000,
  },
  {
    name: 'transcribe_audio',
    description: 'Transcribe an audio file (mp3, wav, m4a, aac, ogg, flac, opus, amr) into text using the configured STT engine (cloud: Volcengine Doubao / Alibaba DashScope / SiliconFlow / OpenAI-compatible, with optional local whisper fallback). Use when the user uploads an audio file or asks to transcribe/convert a voice memo, recording, or meeting audio. Returns the full transcript (chunked with timestamps for audio over 60s). Path format: attachments/{nodeId}/{filename} or a project-relative path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Audio file path. Format: attachments/{nodeId}/{filename}, or a project-relative path. Get from the attachment list in user message.',
        },
      },
      required: ['path'],
    },
    category: '文件',
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const p = (args.path as string) || '';
      if (!p) return 'Error: 缺少 path 参数';
      try {
        const project = await getCurrentProject();
        // 防 ../ 穿越：resolve 后必须仍在 project.path 内
        const projectRoot = resolve(project.path);
        const filePath = resolve(join(projectRoot, p));
        if (!(filePath === projectRoot || filePath.startsWith(projectRoot + sep))) {
          return `Error: 音频路径 "${p}" 越出项目目录，拒绝访问。`;
        }
        const { readSettingsFromFile } = await import('@/lib/settings-server');
        const settings = await readSettingsFromFile();
        const { parseAudio } = await import('@/lib/parse/audio-parser');
        const result = await parseAudio(filePath, project.path, { stt: settings.stt });
        return truncate(result.extracted_text, 20000);
      } catch (e) {
        return `Error: 音频转写失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    maxOutput: 20000,
  },
  {
    name: 'load_skill',
    description: 'Load the complete SKILL.md instructions of a locally available skill by name (e.g. "bob-ui", "slide-craft", "intern-lawyer", "docx", "pdf"). Only skills listed in the available-skills directory can be loaded — a skill NOT listed there is not downloaded yet and cannot be loaded; tell the user to download it in Settings → Skills → Download first. The system prompt only lists skill names + one-line descriptions — call this tool to get the full operational instructions BEFORE performing a task that falls into a skill\'s domain, then follow them strictly. Skills the user force-injected (shown as 已触发技能 in the message) are already fully included and do NOT need this. Read smaller resource files (color palettes, font tables) with read_skill_resource afterwards if the skill body references them.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '技能名（与技能目录名一致），如 "bob-ui"、"slide-craft"、"intern-lawyer"、"docx"、"pdf"、"skill-creator"。',
        },
      },
      required: ['skill_name'],
    },
    category: '技能',
    execute: toolLoadSkill,
    maxOutput: 50000,
  },
  {
    name: 'check_mcp_gaps',
    description: 'Check MCP (Model Context Protocol) server availability against the local BobWork config — which MCPs are configured, enabled, and actually connected (with tool counts). Local-only, does NOT touch the open internet. Use when the current task needs a capability that might come from an MCP (browser automation, GitHub, code docs, legal search, company data, file system, web search), or when a tool call failed because the MCP is missing/offline. Returns a status list so you can tell the user exactly what to configure in Settings → MCP Servers. Never claim an MCP is available unless it shows connected here.',
    parameters: {
      type: 'object',
      properties: {
        need: {
          type: 'string',
          description: 'Optional: capability the current task needs, e.g. "browser automation", "github", "excel". Used to highlight relevant entries; not required.',
        },
      },
      required: [],
    },
    category: '系统',
    execute: toolCheckMcpGaps,
    maxOutput: 4000,
  },
  {
    name: 'read_skill_resource',
    description: '读取已加载/内建技能的 L3「按需资源」文件（结构化分块文档：色板/字号表/组件类/示例代码/自检清单等），用于在技能 L2 正文（规则层）注入后，需要精确细节时部分读取。不传 resource 时返回该技能 resources 目录的索引表（文件名 + 内容摘要）。传 resource + 可选 section 时可只读文件的某一段（按 ## / ### 段落切分），避免整份大文件全量进上下文。适用：bob-ui 等已拆分为「L2 规则 + L3 细节文档」的技能。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '技能名（如 "bob-ui"、"slide-craft"、"docx"），与技能目录名一致。',
        },
        resource: {
          type: 'string',
          description: '资源文件名（含扩展名，如 "01-style-rulers.md"、"03-widget-examples.md"）；支持 resources/ 下相对路径（子目录以 / 分隔）。留空或省略时：返回 resources/ 目录索引（文件名 + 首段摘要）。',
        },
        section: {
          type: 'string',
          description: '可选：只读资源文件中的某一节，按 `##`（父节）或 `###`（子节）标题匹配，传节标题的关键词即可（如 "字号梯度"、"2.2"、"HTML 组件类"、"antv 工具清单"）。省略时返回整个文件。示例：resource="01-style-rulers.md" + section="字号梯度" 只返回该节。',
        },
      },
      required: ['skill_name'],
    },
    category: '技能',
    execute: toolReadSkillResource,
    maxOutput: 20000,
  },
  {
    name: 'get_app_config',
    description: '读取当前应用配置摘要（只读，不改动任何内容）：各聊天厂商（deepseek/glm/moonshot/qwen/openai/doubao）的 API Key 是否已配置、视觉/STT 角色的模型与 Key 状态；任务归纳/成果块编辑已归入主对话模型（taskModel/outcomeModel 字段即为 chatModel 状态，不再独立）；欢迎头像与侧边栏 logo、MCP 服务器列表、自定义工具列表、当前界面主题（主题 id / 自定义主题 id / 自定义主题库摘要）。用户要求修改配置时，先调用本工具确认现状，再调用对应配置工具。',
    parameters: {
      type: 'object',
      properties: {},
    },
    category: '配置',
    execute: toolGetAppConfig,
    maxOutput: 4000,
  },
  {
    name: 'set_app_icon',
    description: '修改应用图标设置：target=avatar 设置欢迎窗口头像（mode=random 随机 / mode=fixed 固定，fixed 时 selected 传头像池 id，如 builtin/pumpkin-a.png 或 custom/xxx.png）；target=logo 设置侧边栏品牌 logo（selected 传头像池 id，传空字符串恢复默认 logo）。修改会写入配置并即时生效（欢迎窗口头像下次启动生效）。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['avatar', 'logo'], description: 'avatar=欢迎窗口头像；logo=侧边栏品牌 logo' },
        mode: { type: 'string', enum: ['random', 'fixed'], description: '仅 target=avatar：random 随机 / fixed 固定' },
        selected: { type: 'string', description: '头像池 id（如 builtin/pumpkin-a.png）；target=logo 传空字符串恢复默认' },
      },
      required: ['target'],
    },
    category: '配置',
    execute: toolSetAppIcon,
    maxOutput: 2000,
  },
  {
    name: 'update_provider_config',
    description: '修改模型配置并即时生效。target=provider 设置聊天厂商的 API Key / 自定义 baseUrl / 勾选模型（provider 取 deepseek/glm/moonshot/qwen/openai/doubao，model 为模型 id，如 qwen-vl-max）；target=vision 设置视觉角色；target=task/outcome 等价于改主对话模型（task/outcome 已归入 chatModel）；target=stt 设置音频转写（provider 取 doubao-stream/doubao/dashscope/siliconflow/openai）。apiKey 传空字符串表示清空该 Key；baseUrl 传空字符串恢复厂商默认端点。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['provider', 'vision', 'task', 'outcome', 'stt'], description: 'provider=聊天厂商；vision=视觉；task=任务归纳（已归入主对话模型）；outcome=成果块编辑（已归入主对话模型）；stt=音频转写' },
        provider: { type: 'string', description: '厂商 type，见描述中各目标允许的取值' },
        apiKey: { type: 'string', description: 'API Key；传空字符串清空' },
        baseUrl: { type: 'string', description: '自定义 baseUrl；传空字符串恢复默认' },
        model: { type: 'string', description: '模型 id（provider 目标下追加到勾选列表；角色目标下设为 defaultModel）' },
      },
      required: ['target', 'provider'],
    },
    category: '配置',
    execute: toolUpdateProviderConfig,
    maxOutput: 2000,
  },
  {
    name: 'test_model',
    description: '验证模型连接是否正常（TRAE 式校验）：对指定厂商的模型发极简请求，返回 ok/error/status。用于修改配置后验证是否修复成功，或诊断连接失败原因（404=模型未开通/ID 错误，401/403=API Key 无效，超时=网络问题或图片生成耗时较长）。provider 取 deepseek/glm/moonshot/qwen/openai/doubao/agentplan/codingplan/siliconflow；models 可选（省略时测试该厂商所有已勾选模型）。建议配合 get_app_config + update_provider_config 形成「诊断→修改→验证」闭环。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: '厂商 type（如 doubao、deepseek、agentplan 等）' },
        models: {
          type: 'array',
          items: { type: 'string' },
          description: '要测试的模型 ID 列表；省略时测试该厂商所有已勾选模型',
        },
      },
      required: ['provider'],
    },
    category: '配置',
    execute: toolTestModel,
    maxOutput: 4000,
  },
  {
    name: 'manage_mcp_server',
    description: '增删改 MCP 服务器配置（写入设置文件并立即按新配置重连，之后该服务器工具可被调用）。action=add 新增（server 传 name、transport=stdio 时传 command/args/env，transport=streamable-http 时传 url/headers，enabled 默认 true）；action=update 按 server.id 或 server.name 更新字段；action=toggle 切换启用/停用；action=remove 删除。新增前先调 get_app_config 确认现有服务器，避免重复添加。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'toggle', 'remove'], description: '操作类型' },
        server: {
          type: 'object',
          description: '服务器配置（id 或 name 用于定位；add 必须含 name）',
          properties: {
            id: { type: 'string', description: '唯一 id（update/toggle/remove 用于定位；add 缺省时自动生成）' },
            name: { type: 'string', description: '显示名称' },
            transport: { type: 'string', enum: ['stdio', 'streamable-http'] },
            command: { type: 'string', description: 'stdio：启动命令（如 npx）' },
            args: { type: 'array', items: { type: 'string' }, description: 'stdio：命令参数' },
            env: { type: 'object', description: 'stdio：环境变量' },
            url: { type: 'string', description: 'streamable-http：远程 URL' },
            headers: { type: 'object', description: 'streamable-http：请求头（如 Authorization）' },
            enabled: { type: 'boolean', description: '是否启用' },
          },
        },
      },
      required: ['action'],
    },
    category: '配置',
    execute: toolManageMcpServer,
    maxOutput: 2000,
  },
  {
    name: 'manage_quick_launch',
    description: '管理 ⌘F 里的自定义快捷入口（My Quick）：action=add 新增一条（label 名称、agent 目标节点类型 chat/coding、prompt 预设提示词）；action=remove 按 id 删除；action=list 列出当前全部入口。当用户说“在 ⌘F 添加/建一个快捷入口/快捷按钮”或要求把某个自研插件/工作流做成一键入口时调用；已有入口可通过 list 确认避免重复。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list'], description: '操作类型' },
        label: { type: 'string', description: 'add：快捷入口名称（用户可见，如 “DeepSeek Harness”）' },
        agent: { type: 'string', enum: ['chat', 'coding'], description: 'add：目标节点类型（默认 chat）' },
        prompt: { type: 'string', description: 'add：点击时预填的提示词（可选）' },
        id: { type: 'string', description: 'remove：要删除的入口 id（list 可得）' },
      },
      required: ['action'],
    },
    category: '配置',
    execute: toolManageQuickLaunch,
    maxOutput: 2000,
  },
  {
    name: 'get_current_theme',
    description: '获取当前生效的界面主题完整设计规范（只读）：返回当前主题 id、名称、是否深色、来源（preset/custom）、关键色摘要（primary/background/surface/text/border/muted）、完整 CSS 变量集（40+ 变量，含 shadcn 基底 + 语义纸张/文字/边框/主色/状态色），以及一份设计指南（每个关键变量的用途说明）。用户询问"当前是什么主题"、"主色是什么"、或需要生成与当前主题配色一致的前端代码/小程序时调用本工具。',
    parameters: {
      type: 'object',
      properties: {},
    },
    category: '配置',
    execute: toolGetCurrentTheme,
    maxOutput: 8000,
  },
  {
    name: 'list_configured_models',
    description: 'List all models available in the user\'s configured model pool (read-only). Returns an array of providers, each with its API-key status and the list of selected (enabled) model IDs. Use this when the user wants to add AI capabilities to a mini-program/app and needs to choose which model to use. The returned model IDs are in "provider:modelId" format, which is exactly the format expected by the sandbox chat bridge (BobWork.request("chat", { model: "..." })). If the pool is empty, inform the user to configure models in Manage Models first.',
    parameters: {
      type: 'object',
      properties: {},
    },
    category: '配置',
    execute: toolListConfiguredModels,
    maxOutput: 4000,
  },
  {
    name: 'ask_user_questions',
    description: 'Pause the response to ask the user structured questions, then wait for their answers before continuing. Use this whenever you need information, clarification, or a decision from the user to proceed (e.g. gathering requirements, confirming preferences, choosing between options). The host will pop up a structured form; the user\'s answers are returned to you as the tool result so you can continue. Prefer this over asking questions in free text.',
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
    description: 'Search the on-demand capability catalog (browser automation, company lookup, team orchestration, local app control, legal, audio, OCR, memory/todo, theme, skills, etc.). Use this when you are unsure whether a capability exists or which intent phrase activates it — the host activates the matched capability (its tools become available in the following rounds) and returns the result. Always available.',
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
  {
    name: 'query_schedule',
    description:
      'Query the user schedule / calendar events (from the calendar events database, cross-project) within a time window. Use BEFORE proposing any arrangement: check which time slots are already occupied so your suggestion does not create conflicts. Returns scheduled (and optionally done/cancelled) events sorted by start time, plus any open untimed checklist items. Prefer this over read_todo for schedule/conflict questions.',
    parameters: {
      type: 'object',
      properties: {
        range_start: {
          type: 'string',
          description: 'Optional ISO start boundary (e.g. 2026-09-03T00:00:00+08:00). Defaults to now.',
        },
        range_end: {
          type: 'string',
          description: 'Optional ISO end boundary. Defaults to range_start + days.',
        },
        days: {
          type: 'number',
          description: 'How many days ahead from now/range_start to scan (default 14, max 120).',
        },
        status: {
          type: 'string',
          enum: ['scheduled', 'done', 'cancelled'],
          description: 'Optional status filter. Default: scheduled only.',
        },
        project_id: {
          type: 'string',
          description: 'Optional project id to restrict results (default: all projects incl. global items).',
        },
      },
      required: [],
    },
    category: '系统',
    execute: toolQuerySchedule,
    maxOutput: 5000,
  },
  {
    name: 'create_scheduled_todo',
    description:
      'Create a scheduled todo: writes a calendar event AND, when the current project has room for a sticky note, appends the todo as a `- [ ]` line on the project sticky note and links them two-way (so ticking either side syncs the other). Call ONLY after the user has explicitly confirmed your proposed arrangement. Params title/start_time/end_time/all_day/reminder_minutes define the event; description goes into the event notes. If no start_time is given, a default next-hour slot is used. If the project already holds three todo sticky notes, the event is still created and reported as calendar-only.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Todo title (also becomes the sticky note line text).',
        },
        start_time: {
          type: 'string',
          description: 'Optional ISO start time (e.g. 2026-09-03T15:00:00+08:00).',
        },
        end_time: {
          type: 'string',
          description: 'Optional ISO end time.',
        },
        all_day: {
          type: 'boolean',
          description: 'All-day event (default false).',
        },
        reminder_minutes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Reminder lead minutes, e.g. [30, 1440]. Default [30]. Pass [] to disable reminders.',
        },
        description: {
          type: 'string',
          description: 'Optional notes/details stored on the calendar event.',
        },
      },
      required: ['title'],
    },
    category: '文件',
    execute: toolCreateScheduledTodo,
    maxOutput: 1500,
  },
  {
    name: 'query_todos',
    description:
      'Query TODOs/tasks the same way the /todo check command does, with free-form semantic queries: natural language time ranges ("today"/"this week"/"tomorrow"/"next Monday"), status keywords ("overdue"/"done"), content keywords, or empty = today. Reads the shared calendar-events database (scope all: project todos + global untimed items). Use for "有什么待办/这周要做什么/查逾期/搜某件事" type questions. For schedule-window conflict checks prefer query_schedule.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional natural-language query, e.g. "今天" / "下周" / "逾期未完成" / "包含 立案" / "上周做完的". Empty = today."' },
        scope: { type: 'string', enum: ['all', 'project', 'global'], description: 'Optional scope. Default all (project + global untimed items).' },
      },
      required: [],
    },
    category: '系统',
    execute: toolQueryTodos,
    maxOutput: 5000,
  },
  {
    name: 'todo_update',
    description:
      'Update an existing todo/event by its event_id: change title, start/end time, all_day, status (done/scheduled), priority, color, location, description or reminder_minutes. Get the event_id first via query_todos (ids are listed there). Changes propagate both ways: calendar event updates, and if it originated from a sticky note line the line is synced too.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id (from query_todos output).' },
        title: { type: 'string', description: 'New title / todo text.' },
        start_time: { type: 'string', description: 'New start time (local ISO, e.g. 2026-09-04T09:00:00+08:00).' },
        end_time: { type: 'string', description: 'New end time (local ISO).' },
        all_day: { type: 'boolean', description: 'All-day flag.' },
        status: { type: 'string', enum: ['scheduled', 'done'], description: "done = complete the todo, scheduled = re-open it. Use todo_delete to remove entirely (not 'cancelled')." },
        priority: { type: 'string', enum: ['high', 'normal', 'low'] },
        color: { type: 'string', description: 'Event color hex, e.g. #F59E0B.' },
        location: { type: 'string' },
        description: { type: 'string' },
        reminder_minutes: { type: 'array', items: { type: 'number' }, description: 'Reminder lead minutes, e.g. [30]. Pass [] to disable.' },
      },
      required: ['event_id'],
    },
    category: '系统',
    execute: toolTodoUpdate,
    maxOutput: 800,
  },
  {
    name: 'todo_delete',
    description:
      'Delete a todo/event by its event_id (soft delete: status → cancelled; external calendars see CANCELLED). If the event came from a sticky note line, the corresponding sticky line is removed as well (two-way). Get event_id first via query_todos. Use only when the user clearly asks to remove/delete a todo.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Event id (from query_todos output).' },
        hard: { type: 'boolean', description: 'Hard delete (physically remove row) instead of soft cancel. Default false.' },
      },
      required: ['event_id'],
    },
    category: '系统',
    execute: toolTodoDelete,
    maxOutput: 600,
  },
  {
    name: 'project_plan_start',
    description:
      'Start a project plan (plan tree) for the current project: creates a persistent plan with milestones → steps and returns its id. Use for any multi-step goal the user wants planned (milestones / phases / dependencies). Pass title/goal and either a flat "steps" list or structured "milestones" [{title, steps:[...]}]. Kept in the project .planner/plans.json; track progress afterwards with project_plan_view / project_plan_add_steps / project_plan_step_status.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Plan title, e.g. "借款纠纷诉讼计划".' },
        goal: { type: 'string', description: 'Optional one-line goal / deliverable statement.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Optional flat step list (used when there are no milestones).' },
        milestones: { type: 'array', description: 'Optional milestones; each { title: string, steps: string[] }.', items: { type: 'object', properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } } },
      },
      required: ['title'],
    },
    category: '系统',
    execute: toolProjectPlanStart,
    maxOutput: 1200,
  },
  {
    name: 'project_plan_view',
    description:
      'Read back the project plan tree(s). Without plan_id: list all plans (title/status/progress). With plan_id: full tree of milestones and steps with their ids and statuses (pending/in_progress/done/blocked). Call this before updating steps so you address steps by their real ids.',
    parameters: {
      type: 'object',
      properties: { plan_id: { type: 'string', description: 'Optional plan id.' } },
      required: [],
    },
    category: '系统',
    execute: toolProjectPlanView,
    maxOutput: 5000,
  },
  {
    name: 'project_plan_add_steps',
    description:
      'Append steps to a plan. Default target = the first (or only) milestone; pass milestone_id (from project_plan_view) to target a specific one, or milestone_title to create/find a milestone by title. Use when the plan grows or a milestone needs more granular steps.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'Plan id.' },
        milestone_id: { type: 'string', description: 'Optional milestone id to append to.' },
        milestone_title: { type: 'string', description: 'Optional milestone title; if no milestone matches (and milestone_id empty), a milestone with this title is created.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Steps to append.' },
      },
      required: ['plan_id', 'steps'],
    },
    category: '系统',
    execute: toolProjectPlanAddSteps,
    maxOutput: 1000,
  },
  {
    name: 'project_plan_step_status',
    description:
      'Advance one step in the plan tree state machine: pending → in_progress → done; blocked (with reason) → pending/in_progress. Milestone and plan completion are derived automatically from their steps. Call when a step is started, finished, or blocked.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'Plan id.' },
        step_id: { type: 'string', description: 'Step id (from project_plan_view).' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'New step status.' },
        note: { type: 'string', description: 'Optional note (esp. reason when blocked).' },
      },
      required: ['plan_id', 'step_id', 'status'],
    },
    category: '系统',
    execute: toolProjectPlanStepStatus,
    maxOutput: 800,
  },
  {
    name: 'create_sticky_note',
    description: 'Create a sticky note on the canvas (project-private). Use when you have produced a plan, checklist, reminder or todo list and the user wants it saved as a sticky note (e.g. a legal work plan split into phases/tasks). The note is written silently to the project sticky-notes.json and the canvas refreshes automatically — no user confirmation dialog is shown. Note: sticky notes are private user data; after creation you must NOT read back or modify their contents via file tools. Note position is auto-assigned on a visible cascade; do not try to control placement. Each project allows up to three todo sticky notes: if three already exist, creation is skipped and an existing note is returned instead of duplicating.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Sticky note body. For a plan, use one line per task/checklist item, each line starting with "- [ ] " (e.g. "- [ ] 收集证据材料").',
        },
        title: {
          type: 'string',
          description: 'Optional note title (defaults to the project name, no auto date suffix). e.g. "借款纠纷诉讼计划".',
        },
        color: {
          type: 'string',
          description: 'Note color: yellow | blue | green | pink. If the color is already used by an existing note in the project, an unused color is auto-assigned so notes stay visually distinct.',
        },
      },
      required: ['content'],
    },
    category: '文件',
    execute: toolCreateStickyNote,
    maxOutput: 1000,
  },
  {
    name: 'create_agent_package',
    description: 'Create a new specialized sub-agent package and install it instantly. Call when the user asks to build a dedicated agent (e.g. "帮我创建一个合同审核 agent"). Inputs: id, name, description (what the agent does), optional scenes (fixed scene list), optional coreExclusions (built-in kernel tools this agent must NOT see), optional skillPool (skills enabled for this agent), optional version. The tool validates the id, resolves scenes, auto-generates a complete base system prompt (persona + standing rules + todo_write/ask_user_questions/finish_task/OutputFile mechanics), writes agent.json to the installed agents directory, and verifies the result. The agent immediately appears in Extensions Store → Agents and the sidebar ＋ Add session menu (dispatch agents-changed to refresh UI).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Unique lowercase agent id, [a-z0-9-], starts with a letter, max 48 chars. Must not collide with built-ins (chat/coding/note/planner).',
        },
        name: {
          type: 'string',
          description: 'Display name, e.g. "Contract Review".',
        },
        description: {
          type: 'string',
          description: 'One-sentence description of the specialized job this agent does; shown in market cards and used to write the persona.',
        },
        role: {
          type: 'string',
          description: 'Optional richer role/persona text the user described (responsibilities, boundaries, style). Appended into the system prompt.',
        },
        scenes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional fixed scenes that decide which scened tools/MCP this agent can call. Allowed: general, coding, wanted, legal, node, audio, skill, design, ocr, admin, office, browser, company, team, local, notebook, planner. Defaults to ["general"]. Scene "notebook" grants the full note domain (Kar-like); "legal" grants pkulaw.',
        },
        coreExclusions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional names of always-on kernel tools to remove for this agent (e.g. read_file, write_file, run_command, execute_script, web_search, web_fetch). Use to make a pure-specialist agent that never roams files/network.',
        },
        skillPool: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional skill names to enable for this agent only (its own skill pool).',
        },
        version: {
          type: 'string',
          description: 'Optional package version, defaults "1.0.0".',
        },
      },
      required: ['id', 'name', 'description'],
    },
    category: '系统',
    scenes: ['coding'],
    execute: toolCreateAgentPackage,
    maxOutput: 2000,
  },
  {
    name: 'validate_agent_package',
    description: 'Validate an existing agent package (installed in the user agents directory or the bundled market source) before/after editing its agent.json. Reports resolved scenes, active core exclusions, skill pool, prompt length, and id conflicts. Call to diagnose why an agent misbehaves or to check a hand-written manifest.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Agent id to inspect.',
        },
      },
      required: ['id'],
    },
    category: '系统',
    scenes: ['coding'],
    execute: toolValidateAgentPackage,
    maxOutput: 1500,
  },
  {
    name: 'update_agent_package',
    description: 'Update an already-installed sub-agent package (created via create_agent_package or installed from the Agent Market, e.g. Kar / Planner). Call when the user asks to change a running agent, e.g. add/remove scenes, change persona instructions, replace core exclusions, or adjust its skill pool. Only the fields you pass are changed; anything omitted is preserved. The installed agent.json is rewritten and takes effect on the agent\'s next conversation (Settings → Agents → Edit Prompt edits the override, not the package).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Agent id of an installed package to update (must exist under the user agents directory).',
        },
        name: {
          type: 'string',
          description: 'Optional new display name.',
        },
        description: {
          type: 'string',
          description: 'Optional new one-line description (market card text).',
        },
        version: {
          type: 'string',
          description: 'Optional new version string.',
        },
        addScenes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional scenes to ADD to the current fixedScenes (whitelisted). e.g. add "notebook" to grant the full note domain, or "legal" for pkulaw.',
        },
        removeScenes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional scenes to REMOVE from the current fixedScenes. Keep at least one scene.',
        },
        coreExclusions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional FULL replacement list of kernel tool names to exclude for this agent. Pass [] to clear all exclusions. Unknown names are kept but reported.',
        },
        skillPool: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional FULL replacement skill pool for this agent. Pass [] to clear (agent falls back to global default). Omit to leave unchanged.',
        },
        prompt: {
          type: 'string',
          description: 'Optional FULL replacement of the base system prompt. Use only when regenerating; prefer instructions for small tweaks.',
        },
        instructions: {
          type: 'string',
          description: 'Optional additional persona/standing-rule text APPENDED to the current prompt as a new section (keeps the existing prompt intact).',
        },
      },
      required: ['id'],
    },
    category: '系统',
    scenes: ['coding'],
    execute: toolUpdateAgentPackage,
    maxOutput: 2000,
  },
];

// ==================== Agent 包 创建 / 校验（coding 造包工具，2026-09-06） ====================
// 架构：由 AI Coding（coding 场景）统一生产新子 agent 包。create 校验 id/场景，
// 自动生成自含机制的 base prompt，落盘 <APP_ROOT>/agents/<id>/agent.json → 立即成为已装市场 agent
// （Extensions Store → Agents + 左侧 ＋ Add session 菜单，无需重启）。
const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

/** 常驻内核工具名集合：无场景标注且未在 SCENED_TOOLS 表 = core 层（coreExclusions 只对这类工具生效） */
const agentCoreToolNames = new Set(
  toolDefs
    .filter((d) => !(d.scenes && d.scenes.length > 0) && !SCENED_TOOLS[d.name])
    .map((d) => d.name),
);

function strArg(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

/** 生成自含机制的专属 base system prompt（与既有市场包同一套约定） */
function buildAgentBasePrompt(name: string, description: string, role: string): string {
  const roleLines = role
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n');
  return [
    `You are ${name} — a dedicated sub-agent of BobWork (BobAgent), specialized in: ${description}.`,
    roleLines ? `\n## Role\n${roleLines}` : '',
    `\n## Standing rules`,
    `- Keep every reply precise, professional, and auditable; state assumptions and cite sources where relevant.`,
    `- If the user's intent is ambiguous or inputs are missing, ask targeted questions first (ask_user_questions) instead of guessing.`,
    `- Stay in your lane: only do the specialized job above; do not wander into unrelated domains.`,
    `\n## Workflow`,
    `- For any multi-step task, first call todo_write to publish the full todo list (goal + all steps as status=pending), then call todo_write again at every step boundary (pending→in_progress→completed/failed) so the side panel reflects real progress.`,
    `- Use your available tools only when needed; never call a tool "just in case".`,
    `- Always end the turn by calling finish_task(summary) with a short summary of what was accomplished.`,
    `\n## Deliverables & output`,
    `- To save a deliverable file, write it under the homework/ directory (path "homework/<filename>") and end your reply with the marker line \`OutputFile: homework/<filename>\` so it is shown to the user as an output card.`,
    `- When quoting law articles, judgments or other materials, give the source and version date.`,
    `\n## Communication`,
    `- Reply in the same language the user writes in.`,
    ``,
  ]
    .filter((s) => s.trim())
    .join('\n')
    .trim();
}

async function toolCreateAgentPackage(args: Record<string, unknown>): Promise<string> {
  try {
    const rawId = strArg(args.id, '');
    const id = rawId.toLowerCase();
    if (!AGENT_ID_RE.test(id)) {
      return 'Error: invalid id. Use lowercase [a-z][a-z0-9-]*, start with a letter, max 48 chars (e.g. "contract-review").';
    }
    if (id in AGENT_PROFILES) {
      return `Error: id "${id}" conflicts with a built-in agent (${Object.keys(AGENT_PROFILES).join(', ')}). Pick another id.`;
    }
    const name = strArg(args.name, '');
    const description = strArg(args.description, '');
    const role = strArg(args.role, '');
    if (!name) return 'Error: name is required.';
    if (!description) return 'Error: description is required (what this agent does).';

    // 场景解析：白名单过滤；提供但全非法 → 报错提示
    const allowed = new Set(ALLOWED_AGENT_SCENES);
    const requested = Array.isArray(args.scenes)
      ? args.scenes.map((s) => String(s).toLowerCase()).filter((s) => allowed.has(s))
      : [];
    if (Array.isArray(args.scenes) && requested.length === 0) {
      return `Error: none of the requested scenes is valid. Allowed: ${ALLOWED_AGENT_SCENES.join(', ')}.`;
    }
    const fixedScenes = requested.length > 0 ? requested : ['general'];

    // 内核剔除：未知项保留但提示（可能为后续新增工具）
    const requestedExclusions = Array.isArray(args.coreExclusions)
      ? Array.from(new Set(args.coreExclusions.map((s) => String(s).trim()).filter((s) => !!s)))
      : [];
    const unknownExclusions = requestedExclusions.filter((s) => !agentCoreToolNames.has(s));

    const skillPool = Array.isArray(args.skillPool)
      ? Array.from(new Set(args.skillPool.map((s) => String(s).trim()).filter((s) => !!s)))
      : [];
    const version = strArg(args.version, '1.0.0');

    const prompt = buildAgentBasePrompt(name, description, role);
    const dir = join(USER_AGENTS_DIR, id);
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'agent.json');
    const exists = await (async () => {
      try { await access(target); return true; } catch { return false; }
    })();
    if (exists) {
      return `Error: agent "${id}" already installed at ${dir}. Edit agent.json directly or pick another id.`;
    }

    const manifest: AgentPackageManifest = {
      id,
      name,
      description,
      version,
      fixedScenes,
      coreExclusions: requestedExclusions.length > 0 ? requestedExclusions : undefined,
      skillPool: skillPool.length > 0 ? skillPool : undefined,
      prompt,
    };
    await writeFile(target, JSON.stringify(manifest, null, 2), 'utf-8');

    // round-trip：写盘后从已装目录回读解析（readManifest 校验），失败即删除并报错
    const back = listInstalledPackages().find((m) => m.id === id);
    if (!back) {
      try { await mkdir(USER_AGENTS_DIR, { recursive: true }); } catch { /* ignore */ }
      await writeFile(target, JSON.stringify(manifest, null, 2), 'utf-8');
      const again = listInstalledPackages().find((m) => m.id === id);
      if (!again) {
        await (async () => { try { await (await import('fs/promises')).rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } })();
        return 'Error: written manifest failed validation (check required fields).';
      }
    }
    const profile = manifestToProfile(back ?? manifest);

    // 独立技能池
    if (skillPool.length > 0) {
      const { enableSkillForAgent } = await import('@/lib/skills/registry-server');
      for (const s of skillPool) enableSkillForAgent(id, s);
    }

    const exclusionsKept = (profile.coreExclusions ?? []);
    const resolvedScenes = profile.fixedScenes ?? fixedScenes;
    const summary = [
      `Agent "${name}" (${id}) created and installed at ${dir}/agent.json.`,
      `- Scenes (fixed): ${resolvedScenes.join(', ')}`,
      exclusionsKept.length > 0 ? `- Kernel tools removed: ${exclusionsKept.join(', ')}` : '- Kernel tools removed: none',
      skillPool.length > 0 ? `- Skill pool: ${skillPool.join(', ')}` : '- Skill pool: none (falls back to global default)',
      unknownExclusions.length > 0 ? `- Note: unknown coreExclusions entries kept but not verified: ${unknownExclusions.join(', ')}` : '',
      `- System prompt: ${prompt.length} chars (auto-generated with todo_write / ask_user_questions / finish_task / OutputFile mechanics).`,
      '',
      'The agent is live now — it appears in Extensions Store → Agents and the sidebar ＋ Add session menu. Have the user dispatch an agents-changed event (or reopen) to refresh open UIs.',
    ].filter((l) => !!l).join('\n');
    return summary;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolValidateAgentPackage(args: Record<string, unknown>): Promise<string> {
  try {
    const id = strArg(args.id, '').toLowerCase();
    if (!AGENT_ID_RE.test(id)) return 'Error: invalid agent id.';
    const installed = listInstalledPackages().find((m) => m.id === id);
    const bundled = installed ? undefined : listMarketSource().find((m) => m.id === id);
    const m = installed ?? bundled;
    if (!m) return `Error: no agent package found for "${id}" (checked installed dir and bundled market source).`;
    const profile = manifestToProfile(m);
    const exclusions = profile.coreExclusions ?? [];
    const unknown = exclusions.filter((s) => !agentCoreToolNames.has(s));
    const resolvedScenes = profile.fixedScenes ?? ['general'];
    const where = installed ? `installed (${join(USER_AGENTS_DIR, id)})` : 'bundled market source';
    return [
      `Agent "${m.name}" (${m.id}) — ${where}`,
      `- Version: ${m.version || '1.0.0'}`,
      `- Scenes (fixed, resolved): ${resolvedScenes.join(', ')}`,
      `- Core exclusions: ${exclusions.length > 0 ? exclusions.join(', ') : 'none'}`,
      unknown.length > 0 ? `  (unknown/unverified: ${unknown.join(', ')})` : '',
      `- Skill pool: ${m.skillPool?.length ? m.skillPool.join(', ') : 'none (global default)'}`,
      `- Prompt: ${m.prompt.length} chars`,
      id in AGENT_PROFILES ? `- Note: conflicts with a built-in id (should never happen for market packages).` : '',
    ].filter((l) => !!l).join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolUpdateAgentPackage(args: Record<string, unknown>): Promise<string> {
  try {
    const id = strArg(args.id, '').toLowerCase();
    if (!AGENT_ID_RE.test(id)) return 'Error: invalid agent id.';
    if (id in AGENT_PROFILES) return `Error: "${id}" is a system built-in (chat/coding) and cannot be edited via packages.`;
    const target = join(USER_AGENTS_DIR, id, 'agent.json');
    let raw: Partial<AgentPackageManifest>;
    try {
      raw = JSON.parse(await readFile(target, 'utf-8')) as Partial<AgentPackageManifest>;
    } catch {
      return `Error: no installed agent package "${id}" found at ${USER_AGENTS_DIR}/${id}/agent.json — install it first (Market → Agents), then update.`;
    }

    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : (raw.name ?? id);
    const description = typeof args.description === 'string' ? args.description.trim() : (raw.description ?? '');
    const version = typeof args.version === 'string' && args.version.trim() ? args.version.trim() : (raw.version ?? '1.0.0');

    // scenes：以已装包当前 fixedScenes 为基准做差集/并集（白名单过滤）
    const allowed = new Set(ALLOWED_AGENT_SCENES);
    const currentScenes = Array.isArray(raw.fixedScenes) && raw.fixedScenes.length > 0
      ? raw.fixedScenes.map(String)
      : ['general'];
    const addScenes = Array.isArray(args.addScenes)
      ? Array.from(new Set(args.addScenes.map((s) => String(s).toLowerCase()).filter((s) => allowed.has(s))))
      : [];
    const unknownAdd = Array.isArray(args.addScenes)
      ? Array.from(new Set(args.addScenes.map((s) => String(s).toLowerCase()).filter((s) => !allowed.has(s))))
      : [];
    const removeScenes = Array.isArray(args.removeScenes)
      ? new Set(args.removeScenes.map((s) => String(s).toLowerCase()))
      : new Set<string>();
    const nextScenes = [...new Set([...currentScenes, ...addScenes])].filter((s) => !removeScenes.has(s));
    if (nextScenes.length === 0) return 'Error: scene update would leave the agent with no scenes (keep at least one).';

    // prompt：全量替换 or 追加 instructions 段（未指定则保持原文）
    const promptArg = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : '';
    let prompt = (raw.prompt ?? '').trim();
    if (promptArg) prompt = promptArg;
    else if (instructions) prompt = `${prompt}\n\n## Update requested by user\n${instructions}`;
    if (!prompt) return 'Error: resulting system prompt is empty (provide prompt or instructions).';

    // coreExclusions：数组即全量替换（空数组 = 清空）
    const exclusionWarnings: string[] = [];
    let coreExclusions: string[] | undefined;
    if (Array.isArray(args.coreExclusions)) {
      coreExclusions = Array.from(new Set(args.coreExclusions.map((s) => String(s).trim()).filter((s) => !!s)));
      exclusionWarnings.push(...coreExclusions.filter((s) => !agentCoreToolNames.has(s)));
      if (coreExclusions.length === 0) coreExclusions = undefined;
    }

    const manifest: AgentPackageManifest = {
      id,
      name,
      description,
      version,
      fixedScenes: nextScenes,
      ...(coreExclusions ? { coreExclusions } : {}),
      ...(raw.skillPool ? { skillPool: raw.skillPool } : {}), // 未指定时保持原清单记录
      prompt,
    };

    // skillPool：显式传入即全量替换（含技能池副作用：清旧 + 启新）
    if (Array.isArray(args.skillPool)) {
      const skillPool = Array.from(new Set(args.skillPool.map((s) => String(s).trim()).filter((s) => !!s)));
      if (skillPool.length > 0) manifest.skillPool = skillPool;
      else delete manifest.skillPool;
      const reg = await import('@/lib/skills/registry-server');
      reg.clearAgentSkills(id);
      for (const s of skillPool) reg.enableSkillForAgent(id, s);
    }

    await writeFile(target, JSON.stringify(manifest, null, 2), 'utf-8');
    const back = listInstalledPackages().find((m) => m.id === id);
    if (!back) return `Error: updated agent.json failed validation (${id}).`;
    const profile = manifestToProfile(back);
    const resolvedScenes = profile.fixedScenes ?? nextScenes;
    const kept = profile.coreExclusions ?? [];

    return [
      `Agent "${back.name}" (${back.id}) updated.`,
      `- Scenes (fixed): ${resolvedScenes.join(', ')}`,
      kept.length > 0 ? `- Core exclusions: ${kept.join(', ')}` : '- Core exclusions: none',
      `- Skill pool: ${(back.skillPool ?? []).length > 0 ? back.skillPool!.join(', ') : 'none (global default)'}`,
      `- Prompt: ${back.prompt.length} chars${instructions ? ' (appended instructions)' : ''}${promptArg ? ' (full replace)' : ''}`,
      unknownAdd.length > 0 ? `- Note: ignored unknown scenes: ${unknownAdd.join(', ')} (allowed: ${ALLOWED_AGENT_SCENES.join(', ')})` : '',
      exclusionWarnings.length > 0 ? `- Note: unknown coreExclusions kept unverified: ${exclusionWarnings.join(', ')}` : '',
      'Takes effect on the agent\'s next conversation (loaded from agent.json each request).',
    ].filter((l) => !!l).join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * query_todos 工具执行器：复用 /todo check 的查询管线
 * （resolveReadCalendarQuery 自由语义解析 → querySchedule 读全局日历库并精确过滤/格式化）。
 * 服务端自调用带绝对 base（Node fetch 不支持相对路径），与 daily-report / organize-send 同一约定。
 */
async function toolQueryTodos(args: Record<string, unknown>): Promise<string> {
  try {
    const queryText = typeof args.query === 'string' ? args.query.trim() : '';
    const scope =
      args.scope === 'project' || args.scope === 'global' ? (args.scope as 'project' | 'global') : 'all';
    const base = `http://localhost:${process.env.PORT || '5000'}`;
    const { resolveReadCalendarQuery, querySchedule } = await import('@/lib/wanted/schedule');
    const { query } = await resolveReadCalendarQuery({ query_text: queryText, scope }, base);
    const res = await querySchedule(query, base);
    if (!res.ok) return `(todo query failed: ${res.reply})`;
    // 附上 event_id 索引，供 todo_update / todo_delete 定位（reply 本身不带完整 id）
    const events = res.events || [];
    if (events.length > 0) {
      const fmt = (iso?: string | null): string =>
        iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
      const idx = events
        .slice(0, 40)
        .map((e) => `- ${e.title}${e.start_time ? ` (${fmt(e.start_time)})` : ''} → id:${e.event_id}`)
        .join('\n');
      return `${res.reply}\n\n【event_id 索引（改/删用）】\n${idx}`;
    }
    return res.reply;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 服务端自调用绝对 base（Node fetch 不支持相对路径），与 daily-report / query_todos 同一约定 */
function selfBaseUrl(): string {
  return `http://localhost:${process.env.PORT || '5000'}`;
}

/** todo_update 执行器：按 event_id 改标题/时间/完成态等；复用 /api/calendar/events PATCH（含反向落回便签） */
async function toolTodoUpdate(args: Record<string, unknown>): Promise<string> {
  try {
    const eventId = String(args.event_id ?? '').trim();
    if (!eventId) return JSON.stringify({ ok: false, error: 'event_id 不能为空' });
    const body: Record<string, unknown> = {};
    const fieldMap: Array<[string, unknown]> = [
      ['title', args.title],
      ['start_time', args.start_time],
      ['end_time', args.end_time],
      ['all_day', args.all_day],
      ['status', args.status],
      ['priority', args.priority],
      ['color', args.color],
      ['location', args.location],
      ['description', args.description],
      ['reminder_minutes', args.reminder_minutes],
    ];
    for (const [k, v] of fieldMap) {
      if (v !== undefined && v !== null) body[k] = v;
    }
    if (Object.keys(body).length === 0) return JSON.stringify({ ok: false, error: '没有要更新的字段' });
    const resp = await fetch(`${selfBaseUrl()}/api/calendar/events?event_id=${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data?.success) return `(todo update failed: ${data?.error || resp.status})`;
    const ev = data.event;
    if (ev?.status === 'done') return `✅ 已完成：${ev.title}`;
    if (ev?.status === 'scheduled' && body.status === 'scheduled') return `↩ 已恢复未完成：${ev.title}`;
    return `✓ 已更新：${ev?.title ?? eventId}${ev?.start_time ? ` @ ${ev.start_time}` : ''}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** todo_delete 执行器：按 event_id 删除（软删默认；硬删可选）；反向联动同步移除便签行 */
async function toolTodoDelete(args: Record<string, unknown>): Promise<string> {
  try {
    const eventId = String(args.event_id ?? '').trim();
    if (!eventId) return JSON.stringify({ ok: false, error: 'event_id 不能为空' });
    const hard = args.hard === true;
    const resp = await fetch(`${selfBaseUrl()}/api/calendar/events?event_id=${encodeURIComponent(eventId)}${hard ? '&hard=1' : ''}`, {
      method: 'DELETE',
    });
    const data = await resp.json();
    if (!data?.success) return `(todo delete failed: ${data?.error || resp.status})`;
    return hard ? `🗑 已彻底删除待办：${eventId}` : `🗑 已删除待办：${eventId}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * ── Planner 计划树状态机（project_plan_*）──
 * 持久化在当前项目 <projectRoot>/.planner/plans.json，按项目隔离。
 * 结构：计划 → 里程碑 → 步骤；步骤状态机 pending → in_progress → done / blocked；
 * 里程碑与计划完成态由系统按步骤自动推导（仅汇总，不手工置）。
 */

type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';
type PlanStep = { id: string; title: string; status: PlanStepStatus; note?: string };
type PlanMilestone = {
  id: string;
  title: string;
  status: 'active' | 'done';
  steps: PlanStep[];
};
type ProjectPlan = {
  id: string;
  title: string;
  goal?: string;
  status: 'active' | 'done';
  milestones: PlanMilestone[];
  createdAt: string;
  updatedAt: string;
};

const PLANNER_DATA_DIR = '.planner';
const PLANNER_DATA_FILE = 'plans.json';

const ALLOWED_TRANSITIONS: Record<PlanStepStatus, PlanStepStatus[]> = {
  pending: ['in_progress', 'blocked'],
  in_progress: ['pending', 'done', 'blocked'],
  done: [],
  blocked: ['pending', 'in_progress'],
};

function newPlanId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

async function readPlans(root: string): Promise<ProjectPlan[]> {
  try {
    const raw = await readFile(join(root, PLANNER_DATA_DIR, PLANNER_DATA_FILE), 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.plans) ? (data.plans as ProjectPlan[]) : [];
  } catch {
    return [];
  }
}

async function writePlans(root: string, plans: ProjectPlan[]): Promise<void> {
  const dir = join(root, PLANNER_DATA_DIR);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${PLANNER_DATA_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
  await writeFile(tmp, JSON.stringify({ plans }, null, 2), 'utf-8');
  await rename(tmp, join(dir, PLANNER_DATA_FILE));
}

function recalcMilestone(m: PlanMilestone): void {
  m.status = m.steps.length > 0 && m.steps.every((s) => s.status === 'done') ? 'done' : 'active';
}

function recalcPlan(p: ProjectPlan): void {
  p.milestones.forEach(recalcMilestone);
  p.status = p.milestones.length > 0 && p.milestones.every((m) => m.status === 'done') ? 'done' : 'active';
  p.updatedAt = new Date().toISOString();
}

function buildMilestone(title: string, stepTitles: string[]): PlanMilestone {
  return {
    id: newPlanId('ms'),
    title,
    status: 'active',
    steps: stepTitles.map((t) => ({ id: newPlanId('st'), title: t, status: 'pending' })),
  };
}

function renderPlan(p: ProjectPlan): string {
  const lines: string[] = [];
  lines.push(`# ${p.title} · ${p.status === 'done' ? '✅ done' : '▶ active'}`);
  lines.push(`> id: ${p.id}${p.goal ? ` · goal: ${p.goal}` : ''}`);
  if (p.milestones.length === 0) {
    lines.push('');
    lines.push('(no milestones yet)');
    return lines.join('\n');
  }
  for (const m of p.milestones) {
    const doneCount = m.steps.filter((s) => s.status === 'done').length;
    lines.push('');
    lines.push(`## ${m.title} ${m.status === 'done' ? '✅' : `(${doneCount}/${m.steps.length})`} · ms:${m.id}`);
    for (const s of m.steps) {
      const mark = s.status === 'done' ? '[x]' : s.status === 'in_progress' ? '[>]' : s.status === 'blocked' ? '[!]' : '[ ]';
      lines.push(`- ${mark} ${s.title} · ${s.status}${s.note ? ` · ${s.note}` : ''} · st:${s.id}`);
    }
  }
  return lines.join('\n');
}

/** 计划树：新建计划（含可选里程碑/步骤） */
async function toolProjectPlanStart(args: Record<string, unknown>): Promise<string> {
  try {
    const root = await getProjectRootPath();
    const title = String(args.title ?? '').trim();
    if (!title) return JSON.stringify({ ok: false, error: 'title 不能为空' });
    const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : undefined;

    const now = new Date().toISOString();
    const plan: ProjectPlan = {
      id: newPlanId('plan'),
      title,
      goal,
      status: 'active',
      milestones: [],
      createdAt: now,
      updatedAt: now,
    };

    const rawMs = args.milestones;
    if (Array.isArray(rawMs) && rawMs.length > 0) {
      for (const it of rawMs as Array<Record<string, unknown>>) {
        const msTitle = String(it.title ?? '').trim() || 'Milestone';
        const stepTitles = (Array.isArray(it.steps) ? it.steps : [])
          .map((s) => String(s).trim())
          .filter(Boolean);
        plan.milestones.push(buildMilestone(msTitle, stepTitles));
      }
    } else {
      const stepTitles = (Array.isArray(args.steps) ? args.steps : [])
        .map((s) => String(s).trim())
        .filter(Boolean);
      plan.milestones.push(buildMilestone('执行', stepTitles));
    }

    const plans = await readPlans(root);
    plans.push(plan);
    await writePlans(root, plans);
    return `Plan created. id: ${plan.id}\n\n${renderPlan(plan)}\n\nTrack progress with project_plan_view / project_plan_step_status.`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：回读（不带 id 列全部；带 id 列完整树） */
async function toolProjectPlanView(args: Record<string, unknown>): Promise<string> {
  try {
    const root = await getProjectRootPath();
    const plans = await readPlans(root);
    const planId = typeof args.plan_id === 'string' ? args.plan_id : '';
    if (planId) {
      const p = plans.find((x) => x.id === planId);
      if (!p) return `Plan not found: ${planId}`;
      return renderPlan(p);
    }
    if (plans.length === 0) return '(no plans in this project yet. Use project_plan_start to create one.)';
    const lines = ['# Project plans', ''];
    for (const p of plans) {
      const steps = p.milestones.reduce((n, m) => n + m.steps.length, 0);
      const doneSteps = p.milestones.reduce((n, m) => n + m.steps.filter((s) => s.status === 'done').length, 0);
      lines.push(`- ${p.status === 'done' ? '✅' : '▶'} ${p.title} · id:${p.id} · ${doneSteps}/${steps} steps done`);
    }
    lines.push('');
    lines.push('Pass plan_id to project_plan_view to see a full tree.');
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：追加步骤到里程碑（默认第一个/仅有；可按 id 或按标题定位/新建里程碑） */
async function toolProjectPlanAddSteps(args: Record<string, unknown>): Promise<string> {
  try {
    const root = await getProjectRootPath();
    const planId = String(args.plan_id ?? '').trim();
    const stepTitles = (Array.isArray(args.steps) ? args.steps : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!planId) return JSON.stringify({ ok: false, error: 'plan_id 不能为空' });
    if (stepTitles.length === 0) return JSON.stringify({ ok: false, error: 'steps 不能为空' });

    const plans = await readPlans(root);
    const plan = plans.find((x) => x.id === planId);
    if (!plan) return JSON.stringify({ ok: false, error: `计划不存在: ${planId}` });

    let milestone: PlanMilestone | undefined;
    const msId = typeof args.milestone_id === 'string' ? args.milestone_id : '';
    const msTitle = typeof args.milestone_title === 'string' && String(args.milestone_title).trim() ? String(args.milestone_title).trim() : '';
    if (msId) milestone = plan.milestones.find((m) => m.id === msId);
    if (!milestone) milestone = plan.milestones.find((m) => !msTitle || m.title === msTitle);
    if (!milestone && !msTitle) milestone = plan.milestones[0];
    if (!milestone) {
      milestone = buildMilestone(msTitle || '执行', []);
      plan.milestones.push(milestone);
    }
    for (const t of stepTitles) milestone.steps.push({ id: newPlanId('st'), title: t, status: 'pending' });
    recalcPlan(plan);
    await writePlans(root, plans);
    return `Added ${stepTitles.length} step(s) to "${milestone.title}".\n\n${renderPlan(plan)}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 计划树：步骤状态机推进 */
async function toolProjectPlanStepStatus(args: Record<string, unknown>): Promise<string> {
  try {
    const root = await getProjectRootPath();
    const planId = String(args.plan_id ?? '').trim();
    const stepId = String(args.step_id ?? '').trim();
    const want = String(args.status ?? '').trim() as PlanStepStatus;
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;
    if (!planId || !stepId) return JSON.stringify({ ok: false, error: 'plan_id / step_id 不能为空' });
    if (!['pending', 'in_progress', 'done', 'blocked'].includes(want)) {
      return JSON.stringify({ ok: false, error: `非法状态: ${want}` });
    }

    const plans = await readPlans(root);
    const plan = plans.find((x) => x.id === planId);
    if (!plan) return JSON.stringify({ ok: false, error: `计划不存在: ${planId}` });
    const milestone = plan.milestones.find((m) => m.steps.some((s) => s.id === stepId));
    if (!milestone) return JSON.stringify({ ok: false, error: `步骤不存在: ${stepId}` });
    const step = milestone.steps.find((s) => s.id === stepId)!;

    if (step.status !== want) {
      const allowed = ALLOWED_TRANSITIONS[step.status];
      if (!allowed.includes(want)) {
        return JSON.stringify({ ok: false, error: `不允许 ${step.status} → ${want}（仅支持：${[...allowed, step.status].join(' / ')}）` });
      }
    }
    step.status = want;
    if (note !== undefined) step.note = note;
    recalcPlan(plan);
    await writePlans(root, plans);
    const prefix = want === 'done' ? '✅' : want === 'blocked' ? '⛔' : want === 'in_progress' ? '▶' : '◻';
    return `${prefix} Step "${step.title}" → ${want}${plan.status === 'done' ? ' · 🎉 计划全部完成' : ''}\n\n${renderPlan(plan)}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * query_schedule 工具执行器：从全局日历库按时间窗读取日程（跨项目），
 * 供日程安排专家在做安排前查冲突。输出按开始时间排序的 markdown 列表，
 * 并附带"无时间"的未完成清单项（合并散活，便于整体排期）。
 */
async function toolQuerySchedule(args: Record<string, unknown>): Promise<string> {
  try {
    const { getCalendarDb, listEventsInRange, listEventsByStatus } = await import('@/lib/db');
    const db = await getCalendarDb();
    const now = new Date();
    const days = Math.min(Math.max(Number(args.days) || 14, 1), 120);
    const rangeStart = args.range_start ? new Date(String(args.range_start)) : now;
    const rangeEnd = args.range_end
      ? new Date(String(args.range_end))
      : new Date(rangeStart.getTime() + days * 86400_000);
    const wantStatus = typeof args.status === 'string' ? args.status : 'scheduled';
    const onlyProject = typeof args.project_id === 'string' ? args.project_id : undefined;

    const fmt = (iso?: string | null): string =>
      iso
        ? new Date(iso).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '—';

    const rows = await listEventsInRange(db, null, rangeStart.toISOString(), rangeEnd.toISOString());
    const timed = rows
      .filter(
        (r) =>
          (!wantStatus || r.status === wantStatus) &&
          (!onlyProject || r.project_id === onlyProject),
      )
      .sort((a, b) => (a.start_time ?? '9999').localeCompare(b.start_time ?? '9999'));

    // 无时间清单项（start null）：仅列 scheduled，供排建议时合并散活
    const untimedScheduled = (await listEventsByStatus(db, null, 'scheduled', 300)).filter(
      (r) => !r.start_time && (!onlyProject || r.project_id === onlyProject),
    );

    const lines: string[] = [
      `# Schedule · ${new Date(rangeStart).toLocaleDateString('zh-CN')} → ${new Date(rangeEnd).toLocaleDateString('zh-CN')}`,
      `> ${timed.length} timed event(s) · ${untimedScheduled.length} open item(s) without a time`,
      '',
    ];
    if (timed.length === 0) lines.push('(no timed events in this window)');
    for (const r of timed) {
      lines.push(
        `- ${fmt(r.start_time)}${r.end_time ? ` ~ ${fmt(r.end_time)}` : ''} · ${r.title}${r.status === 'done' ? ' ✅' : ''}${r.scope === 'global' ? ' (global)' : ''} · id:${r.event_id.slice(0, 8)}`,
      );
    }
    if (wantStatus === 'scheduled') {
      lines.push('');
      lines.push('### Open items (no fixed time)');
      if (untimedScheduled.length === 0) lines.push('(none)');
      for (const r of untimedScheduled) {
        lines.push(`- ${r.title}${r.scope === 'global' ? ' (global)' : ''} · id:${r.event_id.slice(0, 8)}`);
      }
    }
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * create_scheduled_todo 工具执行器：写日历事件 + 在当前项目便签上追加一行待办并双向绑定。
 * 仅在用户明确同意安排后调用（日程专家先查冲突、再提议、用户确认后才落地）。
 */
async function toolCreateScheduledTodo(args: Record<string, unknown>): Promise<string> {
  try {
    const project = await getCurrentProject();
    const projectId = project.id;
    const projectRoot = project.path;
    const title = String(args.title ?? '')
      .trim()
      .replace(/\n+/g, ' ');
    if (!title) return JSON.stringify({ ok: false, error: 'title 不能为空' });

    const cal = await import('@/lib/sticky-calendar-sync');
    const notes = await cal.readStickyNotesFile(projectRoot);

    const startRaw = typeof args.start_time === 'string' && args.start_time ? String(args.start_time) : '';
    const startTime = startRaw || cal.stickyTodoDefaultRange().start;
    const allDay = args.all_day === true;
    const endTime =
      typeof args.end_time === 'string' && args.end_time
        ? String(args.end_time)
        : allDay
          ? undefined
          : new Date(new Date(startTime).getTime() + 3600_000).toISOString();
    const reminderRaw = args.reminder_minutes;
    const reminderMinutes =
      Array.isArray(reminderRaw) && reminderRaw.every((x) => typeof x === 'number')
        ? (reminderRaw as number[])
        : allDay
          ? []
          : [30];

    // 选择一个可挂载的便签页；无则尝试新建（每项目最多三张，超限则只建日历事件）
    const MAX_TODO_NOTES = 3;
    let note = notes.find((n) => Array.isArray(n.pages) && n.pages.some((p) => p.kind !== 'note'));
    let pageId: string | undefined;
    let attachNote: (typeof notes)[number] | undefined;
    let newNoteCreated = false;
    if (note) {
      const page = note.pages!.find((p) => p.kind !== 'note')!;
      pageId = page.id;
      attachNote = note;
    } else if (notes.length < MAX_TODO_NOTES) {
      const now = new Date().toISOString();
      const pid = `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const nid = `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const topZ = notes.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
      const { pickTodoNoteColor } = await import('@/lib/sticky-todo');
      note = {
        id: nid,
        x: 40 + (notes.length % 5) * 28,
        y: 120 + (notes.length % 5) * 28,
        color: pickTodoNoteColor(notes as Array<Record<string, unknown>>),
        kind: 'todo',
        title: project.name || 'Untitled',
        pages: [{ id: pid, title: 'P1', content: `- [ ] ${title}`, kind: 'todo' }],
        activePageId: pid,
        createdAt: now,
        updatedAt: now,
        width: 400,
        height: 225,
        sidebarCollapsed: true,
        z: topZ + 1,
      } as import('@/app/api/sticky-notes/route').StickyNote;
      pageId = pid;
      attachNote = note;
      newNoteCreated = true;
      notes.push(note);
    }

    // 建日历事件（先建，获得 event_id 后再回填到便签行锚点）
    const { getCalendarDb, createEvent } = await import('@/lib/db');
    const db = await getCalendarDb();
    const sourceRef =
      attachNote && pageId ? cal.stickyRefOf(attachNote.id, pageId) : undefined;
    const eventId = await createEvent(db, {
      project_id: projectId,
      title,
      description: typeof args.description === 'string' && args.description ? args.description : undefined,
      start_time: startTime,
      end_time: endTime ?? null,
      all_day: allDay,
      scope: 'project',
      reminder_minutes: reminderMinutes,
      source_ref: sourceRef,
    });

    let lineIndex: number | undefined;
    if (attachNote && pageId) {
      const noteIdx = notes.findIndex((n) => n.id === attachNote!.id);
      const page = notes[noteIdx].pages!.find((p) => p.id === pageId)!;
      const rawLines = String(page.content ?? '').split('\n');
      lineIndex = newNoteCreated ? 0 : rawLines.length;
      const evs = Array.isArray(page.lineEventIds)
        ? page.lineEventIds.map((x) => [...x])
        : Array.from({ length: lineIndex }, () => [] as string[]);
      const calArr = Array.isArray(page.lineCalendared)
        ? [...page.lineCalendared]
        : Array.from({ length: lineIndex }, () => false);
      if (newNoteCreated) {
        rawLines[0] = `- [ ] ${title}`;
        evs[0] = [eventId];
        calArr[0] = true;
      } else {
        rawLines.push(`- [ ] ${title}`);
        evs.push([eventId]);
        calArr.push(true);
      }
      const updated: typeof notes[number] = {
        ...notes[noteIdx],
        pages: notes[noteIdx].pages!.map((p) =>
          p.id === pageId
            ? { ...p, content: rawLines.join('\n'), lineEventIds: evs, lineCalendared: calArr }
            : p,
        ),
        updatedAt: new Date().toISOString(),
      };
      notes[noteIdx] = updated;
      // 落盘前统一剔除空行并重排行级日历锚点（空行不是待办）
      const { normalizeStickyNote } = await import('@/lib/sticky-todo');
      notes[noteIdx] = normalizeStickyNote(notes[noteIdx] as unknown as Record<string, unknown>) as typeof notes[number];
      await cal.writeStickyNotesFile(projectRoot, notes);
    }

    return JSON.stringify({
      ok: true,
      event_id: eventId,
      title,
      start_time: startTime,
      end_time: endTime ?? null,
      all_day: allDay,
      note_id: attachNote?.id ?? null,
      line_index: lineIndex ?? null,
      calendar_only: !attachNote,
      reminder_minutes: reminderMinutes,
    });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * create_sticky_note 工具执行器：在画布上静默创建一张便签（项目私有）。
 * 便签为用户私有数据（AI 不可读回），本工具仅负责写入，不返回内容、不触发确认弹窗。
 * 写入格式与 /api/sticky-notes 完全一致（pages/activePageId 结构）。
 */
async function toolCreateStickyNote(args: Record<string, unknown>): Promise<string> {
  try {
    const projectRoot = await getProjectRootPath();
    const stickyDir = join(projectRoot, 'sticky-notes');
    const stickyFile = join(stickyDir, 'sticky-notes.json');
    const fs = require('fs/promises') as typeof import('fs/promises');

    // 读取现有便签（文件不存在时视为空数组）
    let notes: Array<Record<string, unknown>> = [];
    try {
      const raw = await fs.readFile(stickyFile, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data?.notes)) notes = data.notes as Array<Record<string, unknown>>;
    } catch { /* 文件不存在或损坏 → 从空数组开始 */ }

    const content = String(args.content ?? '').trim();
    if (!content) return JSON.stringify({ ok: false, error: 'content 不能为空' });

    // 默认标题：项目名（不自动追加创建日期，与 /api/sticky-notes defaultTitle 一致）
    let projectName = 'Untitled';
    try {
      const project = await getCurrentProject();
      projectName = project.name || 'Untitled';
    } catch { /* 兜底 */ }
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : projectName;
    const { MAX_TODO_NOTES, pickTodoNoteColor, normalizeStickyNote } = await import('@/lib/sticky-todo');
    // 每项目最多三张待办便签：已满三张时不新建，返回已有便签
    if (notes.length >= MAX_TODO_NOTES) {
      const existing = notes[0];
      return JSON.stringify({
        ok: true,
        note_id: existing.id,
        title: typeof existing.title === 'string' ? existing.title : title,
        color: typeof existing.color === 'string' ? existing.color : 'yellow',
        limited: true,
        message: '该项目已有三张待办便签，未重复创建',
      });
    }
    // 颜色自动与已有便签区分：优先调用方指定色，已被占用则取当前未使用色
    const color = pickTodoNoteColor(notes, typeof args.color === 'string' ? args.color : undefined);
    // 便签为屏幕像素定位，模型无法获知窗口尺寸 → 坐标一律由服务端级联分配，
    // 从源头避免模型自编坐标（如 1586）导致便签落在可视区外（2026-08-22 修复）
    const n = notes.length;
    const x = 40 + (n % 5) * 28;
    const y = 120 + (n % 5) * 28;
    const now = new Date().toISOString();
    const pageId = `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const noteId = `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const topZ = notes.reduce((m, n) => Math.max(m, typeof n.z === 'number' ? n.z : 0), 0);

    notes.push({
      id: noteId,
      x,
      y,
      color,
      kind: 'todo',
      title,
      pages: [{ id: pageId, title: 'P1', content }],
      activePageId: pageId,
      createdAt: now,
      updatedAt: now,
      width: 400,
      height: 225,
      sidebarCollapsed: true,
      z: topZ + 1,
    });

    // 便签待办行自动入日历（打通）：与 /api/sticky-notes 写盘路径一致地 reconcile，
    // 让 AI 静默创建的便签行也获得事件锚点（lineEventIds 回填）；失败不阻断便签本身
    let saved = notes;
    try {
      const { getCurrentProject: getCurrentProjectSafe } = await import('@/lib/project/project-manager');
      const cur = await getCurrentProjectSafe();
      const { reconcileStickyNoteEvents } = await import('@/lib/sticky-calendar-sync');
      if (cur?.id) {
        const synced = await reconcileStickyNoteEvents(
          cur.id,
          notes[notes.length - 1] as unknown as import('@/app/api/sticky-notes/route').StickyNote,
        );
        saved = notes.map((n, i) => (i === notes.length - 1 ? (synced as unknown as Record<string, unknown>) : n));
      }
    } catch (e) {
      console.error('[create_sticky_note] 自动入日历失败（不阻断）:', e);
    }
    const arrToWrite = saved.map((n) =>
      normalizeStickyNote(n as unknown as Record<string, unknown>),
    );

    // 原子写入：先写临时文件再 rename，避免半写状态。
    // 临时名唯一：与 /api/sticky-notes、迁移脚本并发写时不共用固定 tmp 名，避免互相踩踏（rename ENOENT）
    await fs.mkdir(stickyDir, { recursive: true });
    const tmp = join(stickyDir, `.sticky-notes.json.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    await fs.writeFile(tmp, JSON.stringify({ notes: arrToWrite }, null, 2), 'utf-8');
    await fs.rename(tmp, stickyFile);

    // 同步未完成待办索引（todo-index.json，与 /api/sticky-notes 写盘路径一致；
    // 失败仅影响 /inspect 的索引命中，回退全量扫描可自愈）
    try {
      const { writeTodoIndexFile } = await import('@/lib/sticky-todo');
      await writeTodoIndexFile(projectRoot, arrToWrite);
    } catch { /* 索引同步失败不阻断工具成功返回 */ }

    return JSON.stringify({ ok: true, note_id: noteId, title, color });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * load_skill 工具执行器（DSH 模式）：按名称加载技能库中某技能的完整 SKILL.md 正文。
 * 系统提示只列出技能名称+一句话简介，完整操作指令由模型按需调用本工具获取。
 */
async function toolLoadSkill(args: Record<string, unknown>): Promise<string> {
  const skillName = String(args.skill_name ?? '').trim();
  if (!skillName) return 'Error: skill_name is required';
  try {
    const { getAllSkills } = await import('@/lib/skills/loader-server');
    const all = await getAllSkills();
    const def = all.find((s) => s.meta.name === skillName);
    if (!def) {
      const names = all.map((s) => s.meta.name).join(', ');
      return `Error: skill "${skillName}" not found in the skill library. Available skills: ${names}`;
    }
    const body = def.body || '(empty)';
    return `## 技能完整指令：${skillName}\n\n${body}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 常用 MCP 推荐目录（内置写死，本地盘点用；不触网） */
const KNOWN_MCP_CATALOG: Array<{ id: string; name: string; purpose: string; how: string }> = [
  { id: 'bob-browser-mcp', name: 'Bob Browser', purpose: '真实浏览器自动化（导航/点击/填表/抓取反爬站）', how: 'bob-browser-mcp --serve 常驻 + streamable-http 接入' },
  { id: 'github', name: 'GitHub', purpose: 'GitHub 仓库/代码搜索、文件读写、PR/Issue', how: 'stdio npx @modelcontextprotocol/server-github + GITHUB_PERSONAL_ACCESS_TOKEN' },
  { id: 'context7', name: 'Context7', purpose: '代码库/框架文档查询', how: 'streamable-http https://mcp.context7.com/mcp' },
  { id: 'pkulaw', name: '北大法宝', purpose: '法律法规/案例检索（法律场景）', how: 'streamable-http pkulaw 网关' },
  { id: 'tianyancha', name: '天眼查', purpose: '企业工商/风险/知识产权查询', how: 'streamable-http mcp.tianyancha.com + API Key' },
  { id: 'brave-search', name: 'Brave Search', purpose: '网页搜索 API（快/结构化；内置 web_search 可替代）', how: 'stdio npx @modelcontextprotocol/server-brave-search + BRAVE_API_KEY' },
  { id: 'filesystem', name: 'Filesystem', purpose: '文件系统操作（与内置文件工具重复，通常不需要）', how: 'stdio npx @modelcontextprotocol/server-filesystem' },
  { id: 'notion', name: 'Notion', purpose: 'Notion 文档/数据库操作', how: 'stdio npx @modelcontextprotocol/server-notion + token' },
  { id: 'excel-mcp', name: 'Excel', purpose: 'Excel 读写（内置 openpyxl 可替代，通常不需要）', how: 'npx excel-mcp-server（社区包）' },
];

/** check_mcp_gaps 工具：本地盘点 MCP 配置/连接状态（不触网），供模型感知能力缺口并引导用户配置 */
async function toolCheckMcpGaps(args: Record<string, unknown>): Promise<string> {
  try {
    const need = String(args.need || '').trim().toLowerCase();
    const settings = await readSettingsFromFile();
    const servers = settings.mcpServers || [];
    const connIds = new Set(mcpManager.getConnectedServers().map((s) => s.id));

    // settings 中实际配置（含用户自定义条目）→ 配置状态
    const cfgById = new Map<string, { name: string; enabled: boolean; transport?: string; url?: string; command?: string; hasSecret: boolean }>();
    for (const s of servers) {
      const env = (s as { env?: Record<string, unknown> }).env || {};
      cfgById.set(s.id, {
        name: s.name || s.id,
        enabled: s.enabled !== false,
        transport: s.transport,
        url: s.url,
        command: s.command,
        hasSecret: Object.values(env).some((v) => typeof v === 'string' && v.length > 0),
      });
    }

    // 目录：内置推荐 + settings 里出现但目录外的（自定义）
    const entries = new Map<string, { id: string; name: string; purpose: string; how: string }>();
    for (const c of KNOWN_MCP_CATALOG) entries.set(c.id, c);
    for (const s of servers) {
      if (!entries.has(s.id)) {
        entries.set(s.id, { id: s.id, name: s.name || s.id, purpose: '（用户自定义 MCP）', how: `${s.transport || ''} ${s.url || s.command || ''}`.trim() });
      }
    }

    const lines: string[] = ['MCP status (local BobWork config only, no internet):'];
    for (const [id, c] of entries) {
      const cfg = cfgById.get(id);
      const rel = need && `${c.name} ${c.purpose}`.toLowerCase().includes(need) ? '  ← relevant' : '';
      if (!cfg) {
        lines.push(`✗ not_configured  ${id} — ${c.purpose} | 配置：${c.how}${rel}`);
      } else if (!cfg.enabled) {
        lines.push(`○ disabled  ${id} — ${c.purpose}${cfg.hasSecret ? '' : '（未填密钥）'} | 配置：${c.how}${rel}`);
      } else if (connIds.has(id)) {
        const toolCount = registry.listAll().filter((t) => t.name.startsWith(`mcp__${id}__`)).length;
        lines.push(`● connected  ${id} — ${c.purpose} (${toolCount} tools)${rel}`);
      } else {
        const why = cfg.url ? `url=${cfg.url}` : cfg.command ? `command=${cfg.command}` : '(no transport)';
        lines.push(`△ enabled_but_disconnected  ${id} — ${c.purpose} | ${why}${cfg.hasSecret ? '' : '（未填密钥）'}${rel}`);
      }
    }
    lines.push('\n提示：MCP 在 设置 → MCP Servers 面板配置；未 connected 的 MCP 其工具对模型不可见。');
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * read_skill_resource 工具：读取技能 L3 资源文件（结构化分块文档）
 * - resource 传文件名：读取并返回该文件原始内容（Markdown，直接注入上下文即可阅读）
 * - resource 不传：返回 resources/ 目录下所有文件名 + 每个文件的首段 # / ## / 首段文本摘要（作为索引给 LLM 决策读哪份）
 * - 全程防路径穿越（skillName 正则白名单 + resource 禁止 .. / 绝对路径）
 */
/** 按 ## / ### 段落标题从 Markdown 资源中提取指定节（宽松匹配：精确标题 / 标题包含关键词 / 编号前缀）。
 *  用于 read_skill_resource 的 section 参数：只读所需的某一节，避免整份大文件全量进上下文。
 *  命中多个段落时优先更深的子节（### > ##），内容更精确、更省 token。 */
function extractSkillResourceSection(content: string, section: string): string | null {
  const target = section.trim().replace(/^#+\s*/, '');
  const norm = (s: string) => s.toLowerCase().replace(/[.·:：]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = norm(target);
  if (!t) return null;

  // 按 `## ` / `### ` 标题切分（### 子节默认归属其父 ## 段；直接命中 ### 时单独返回）
  const sections = content.split(/\n(?=(?:#{2,3})\s+)/);
  let best: { sec: string; depth: number } | null = null;
  for (const sec of sections) {
    const head = (sec.match(/^#{2,3}\s+(.+)$/m)?.[1] ?? '').trim();
    const h = norm(head);
    if (!h) continue; // 文件头（单 # 或非标题段）跳过，避免空字符串 includes 误命中
    const core = h.split(/[·:：]/)[0].trim();
    // 完全相等 / 标题包含目标 / 目标包含标题冒号/斜杠前的核心词（如 "2.2" 命中 "### 2.2 字号梯度…"）
    if (h === t || h.includes(t) || (core && t.includes(core))) {
      const depth = /^###\s/.test(sec.trim()) ? 3 : 2;
      if (!best || depth > best.depth) best = { sec, depth };
    }
  }
  return best ? best.sec : null;
}

async function toolReadSkillResource(args: Record<string, unknown>): Promise<string> {
  try {
    const skillName = String(args.skill_name ?? '').trim();
    const resourceRaw = args.resource === undefined || args.resource === null ? undefined : String(args.resource);
    if (!skillName) return JSON.stringify({ ok: false, error: 'skill_name 必填' });

    // 1) 无 resource → 返回索引
    if (resourceRaw === undefined || resourceRaw.trim() === '') {
      const dir = resolveSkillResource(skillName, undefined);
      if (!dir || !dir.isDir) {
        return JSON.stringify({
          ok: false,
          error: `技能 ${skillName} 没有 resources/ 目录（该技能未拆分 L3，细节全在 L2 正文）`,
        });
      }
      const fs = require('fs');
      const entries = fs.readdirSync(dir.path, { withFileTypes: true }) as Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
      const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort();
      const index: Array<{ file: string; size_chars: number; preview: string }> = [];
      for (const f of files) {
        const full = join(dir.path, f);
        try {
          const content = fs.readFileSync(full, 'utf-8') as string;
          const sizeChars = content.length;
          // 预览：首段 280 字符（优先取第一条 # / ## 标题 + 首段非空行）
          const lines = content.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
          const headings = lines.filter((l: string) => /^#{1,3}\s+/.test(l)).slice(0, 2);
          const firstBody = lines.filter((l: string) => !/^#{1,3}\s+/.test(l)).slice(0, 2).join(' ');
          const rawPreview = [...headings, firstBody].join('  ·  ');
          const preview =
            rawPreview.length > 320 ? rawPreview.slice(0, 317) + '...' : rawPreview;
          index.push({ file: f, size_chars: sizeChars, preview });
        } catch {
          index.push({ file: f, size_chars: 0, preview: '(读取失败)' });
        }
      }
      return JSON.stringify({
        ok: true,
        skill: skillName,
        note: '按需读取（可带 section 只读某段，如 resource="01-style-rulers.md" section="字号梯度"）：样式标尺(色板/字体/字号/间距/圆角/阴影)→01-style-rulers；布局/密度/对齐→02-density-layout；类型示例(html组件/mermaid着色/antv与chart清单)→03-widget-examples；自检→04-quality-checklist；信息图海报→05-infographic-poster；审美→06-aesthetic-design；数据图原则→07-dataviz-principles。',
        resources_count: index.length,
        index,
      }, null, 2);
    }

    // 2) 有 resource → 读单个文件
    const resolved = resolveSkillResource(skillName, resourceRaw);
    if (!resolved) {
      return JSON.stringify({ ok: false, error: `未找到资源：${resourceRaw}（可能路径非法或文件不存在；如需索引，不传 resource 参数即可）` });
    }
    if (resolved.isDir) {
      // 指向目录（resource 以 / 结尾或 资源名是子目录）：返回该子目录下的 index（与空 resource 类似但限定子目录）
      const fs = require('fs');
      const entries = fs.readdirSync(resolved.path, { withFileTypes: true }) as Array<{ name: string; isFile: () => boolean }>;
      const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name).sort();
      return JSON.stringify({
        ok: true,
        skill: skillName,
        subdir: resourceRaw.trim().replace(/\/+$/, ''),
        files,
      });
    }
    const content = await readFile(resolved.path, 'utf-8');
    const sectionRaw = args.section === undefined || args.section === null ? undefined : String(args.section).trim();

    // 2b) 指定了 section → 只读匹配的段落（避免整份大文件全量进上下文）
    if (sectionRaw) {
      const extracted = extractSkillResourceSection(content, sectionRaw);
      if (extracted) {
        return (
          `<!-- skill: ${skillName} | resource: ${resourceRaw.trim()} | section: ${sectionRaw} | chars: ${extracted.length}（整文件 ${content.length}） -->\n` +
          `<!-- 已按 section 只返回「${sectionRaw}」节；如需其他节，再次调用并换 section 关键词。 -->\n\n` +
          extracted
        );
      }
      // 未匹配 → 列出该文件全部段落标题，引导重新指定
      const headings = content
        .split(/\r?\n/)
        .filter((l: string) => /^#{2,3}\s+/.test(l.trim()))
        .map((l: string) => l.trim().replace(/^#{2,3}\s+/, ''))
        .join('\n');
      return (
        `<!-- 未找到匹配 section「${sectionRaw}」的段落。${resourceRaw.trim()} 可用 section（关键词或编号）： -->\n` +
        headings + '\n\n' +
        '（可再次调用 read_skill_resource 指定以上任一 section；或省略 section 读取整个文件。）'
      );
    }

    // 2c) 无 section → 返回整个文件
    // 结果直接返回 Markdown 原文（不用 JSON 包），方便 LLM 直接读入上下文；但加个头部标识
    const head =
      `<!-- skill: ${skillName} | resource: ${resourceRaw.trim()} | chars: ${content.length} -->\n` +
      `<!-- 用法：直接当作该技能 L3 文档内容阅读，不要重复读取。完成对应章节输出后无需再读。 -->\n\n`;
    return head + content;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============================================================
// 配置类工具（AI 对话可直接查看/修改程序配置）
// 写入口统一走 settings-server（app_root/.settings.json），
// 与设置弹窗/Electron IPC 同一数据源；前端通过
// 'provider-configs-changed' 事件感知变更并刷新 UI。
// ============================================================

/** 聊天厂商 type 白名单 */
const CHAT_PROVIDER_TYPES = new Set(['deepseek', 'glm', 'moonshot', 'qwen', 'openai', 'doubao']);
/** STT 厂商 type 白名单 */
const STT_PROVIDER_TYPES = new Set(['doubao-stream', 'doubao', 'dashscope', 'siliconflow', 'openai']);

/** get_app_config 工具：只读当前配置摘要 */
async function toolGetAppConfig(_args: Record<string, unknown>): Promise<string> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();
    const summary = {
      providers: (s.providers || []).map((p) => ({
        type: p.type,
        hasApiKey: !!p.apiKey,
        apiKeyLen: p.apiKey?.length || 0,
        baseUrl: p.baseUrl || '(default)',
        models: (p.selectedModels ?? []).map((m) => m.modelId),
      })),
      // 视觉模型配置已收敛到 bob-ocr-mcp 插件（数据根 config.json 的 vision 字段，BobWork 托管：~/BobWork/extensions/bob-ocr-mcp）
      vision: { note: 'managed by bob-ocr-mcp plugin (see /settings)' },
      taskModel: {
        provider: s.chatModel?.defaultProvider || '(未配置)',
        model: s.chatModel?.defaultModel || '(未配置)',
        hasApiKey: !!s.chatModel?.apiKey,
      },
      outcomeModel: {
        provider: s.chatModel?.defaultProvider || '(未配置)',
        model: s.chatModel?.defaultModel || '(未配置)',
        hasApiKey: !!s.chatModel?.apiKey,
      },
      stt: {
        provider: s.stt?.provider || '(未配置)',
        model: s.stt?.model || '(未配置)',
        hasApiKey: !!s.stt?.apiKey,
      },
      avatar: s.avatar || { mode: 'random' },
      brandLogo: s.brandLogo || '(default)',
      mcpServers: (s.mcpServers || []).map((m) => ({
        id: m.id,
        name: m.name,
        transport: m.transport,
        enabled: m.enabled,
        url: m.url,
        command: m.command,
        args: m.args,
      })),
      customTools: (s.customTools || []).map((t) => ({ name: t.name, enabled: t.enabled, endpoint: t.endpoint })),
      theme: {
        current: s.theme ?? 'warm',
      },
    };
    return JSON.stringify(summary, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** get_current_theme 工具：返回当前生效主题的完整 CSS 变量集 + 设计规范摘要 */
async function toolGetCurrentTheme(_args: Record<string, unknown>): Promise<string> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const { PRESET_THEME_VARIABLES, THEME_OPTIONS } = await import('@/lib/settings');
    const s = await readSettingsFromFile();
    const themeId = s.theme ?? 'warm';
    // 统一单一品牌色：始终使用预设变量（历史 custom 主题已被 normalizeCustomThemes 收敛）
    const preset = PRESET_THEME_VARIABLES[themeId];
    if (!preset) {
      return JSON.stringify({ error: `未知主题 id: ${themeId}` });
    }
    const variables = preset;
    const opt = THEME_OPTIONS.find((t) => t.id === themeId);
    const themeName = opt?.label ?? themeId;
    const dark = opt?.dark ?? false;
    const source = 'preset';

    // 提取关键色摘要（AI 最常用的几个）
    const keyColors = {
      primary: variables['--primary'],
      background: variables['--background'] ?? variables['--canvas-bg'],
      surface: variables['--paper'] ?? variables['--card'],
      text: variables['--foreground'] ?? variables['--ink'],
      border: variables['--border'] ?? variables['--line'],
      muted: variables['--muted-foreground'] ?? variables['--ink-muted'],
    };

    return JSON.stringify({
      themeId,
      themeName,
      dark,
      source,
      keyColors,
      variablesCount: Object.keys(variables).length,
      variables,
      designGuide: {
        '主色(--primary)': `${variables['--primary']} — 按钮、标签、链接、选中态`,
        '背景(--background/--canvas-bg)': `${variables['--background'] ?? variables['--canvas-bg']} — 全局/画布背景`,
        '卡片/纸张(--paper/--card)': `${variables['--paper'] ?? variables['--card']} — 节点卡片、弹窗、侧边栏`,
        '主文字(--foreground/--ink)': `${variables['--foreground'] ?? variables['--ink']} — 正文文字`,
        '弱化文字(--muted-foreground/--ink-muted)': `${variables['--muted-foreground'] ?? variables['--ink-muted']} — 辅助、说明文字`,
        '边框(--border/--line)': `${variables['--border'] ?? variables['--line']} — 分割线、卡片边框`,
        '信息蓝(--info)': `${variables['--info']} — 信息提示`,
        '成功绿(--success)': `${variables['--success']} — 成功状态`,
        '警示橙(--warn)': `${variables['--warn']} — 警告提示`,
        '危险红(--danger)': `${variables['--danger']} — 错误、删除`,
      },
    }, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** list_configured_models 工具：列出用户已配置模型池中的可用模型（只读）。
 *  供 AI Coding 节点在用户同意接入 AI 功能后，询问用户选择哪个模型使用。 */
async function toolListConfiguredModels(_args: Record<string, unknown>): Promise<string> {
  try {
    const s = await readSettingsFromFile();
    const providers: ProviderConfig[] = s.providers ?? [];

    if (providers.length === 0) {
      return JSON.stringify({
        empty: true,
        message: '模型池为空。请先在 Manage Models 中配置厂商 API Key 并勾选模型，然后再为小程序接入 AI。',
        providers: [],
      });
    }

    const result = providers.map((config) => {
      const preset = PROVIDER_PRESETS.find((p) => p.type === config.type);
      const presetLabel = preset?.label ?? config.type;
      const selected: SelectedModel[] = config.selectedModels ?? [];
      const models = selected.map((sel) => {
        const modelId = sel.modelId;
        const presetModel = preset?.models.find((m) => m.modelId === modelId);
        return {
          modelId,
          fullId: `${config.type}:${modelId}`,
          label: presetModel?.label ?? modelId,
          description: presetModel?.description ?? '',
          thinking: sel.thinking,
          purpose: sel.purpose ?? 'chat',
        };
      });
      return {
        provider: config.type,
        label: presetLabel,
        hasApiKey: Boolean(config.apiKey?.trim()),
        baseUrl: config.baseUrl || preset?.baseUrl || '',
        models,
      };
    });

    const totalModels = result.reduce((sum, p) => sum + p.models.length, 0);
    return JSON.stringify({
      empty: totalModels === 0,
      totalModels,
      providers: result,
      hint: '模型 ID 格式为 "provider:modelId"（如 deepseek:deepseek-v4-flash）。在小程序中通过 BobWork.request("chat", { model: "provider:modelId", messages: [...] }) 调用。省略 model 参数则走 Auto 模式自动选择。',
    }, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** set_app_icon 工具：设置欢迎窗口头像 / 侧边栏品牌 logo */
async function toolSetAppIcon(args: Record<string, unknown>): Promise<string> {
  try {
    const target = String(args.target ?? '').trim();
    if (target !== 'avatar' && target !== 'logo') {
      return 'Error: target 必须是 avatar（欢迎头像）或 logo（侧边栏 logo）';
    }
    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();

    if (target === 'avatar') {
      const mode = args.mode === 'fixed' ? 'fixed' : 'random';
      s.avatar = { mode };
      if (mode === 'fixed') {
        const selected = String(args.selected ?? '').trim();
        if (!selected) return 'Error: mode=fixed 时必须提供 selected（头像池 id，如 builtin/pumpkin-a.png）';
        s.avatar.selected = selected;
      }
    } else {
      const selected = String(args.selected ?? '').trim();
      s.brandLogo = selected || undefined; // 空字符串 → 恢复默认 logo
    }

    await writeSettingsToFile(s);
    return JSON.stringify({
      success: true,
      target,
      ...(target === 'avatar' ? { avatar: s.avatar } : { brandLogo: s.brandLogo || '(default)' }),
    });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** update_provider_config 工具：设置厂商 Key / 角色模型 */
async function toolUpdateProviderConfig(args: Record<string, unknown>): Promise<string> {
  try {
    const target = String(args.target ?? '').trim();
    const provider = String(args.provider ?? '').trim();
    const apiKey = args.apiKey !== undefined ? String(args.apiKey) : undefined;
    const baseUrl = args.baseUrl !== undefined ? String(args.baseUrl) : undefined;
    const model = args.model !== undefined ? String(args.model).trim() : undefined;

    if (!target || !provider) return 'Error: target 与 provider 均为必填';

    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();

    if (target === 'provider') {
      if (!CHAT_PROVIDER_TYPES.has(provider)) {
        return `Error: 未知聊天厂商 '${provider}'。可用: ${[...CHAT_PROVIDER_TYPES].join(', ')}`;
      }
      let cfg = s.providers.find((p) => p.type === provider as ProviderConfig['type']);
      if (!cfg) {
        cfg = { type: provider as ProviderConfig['type'], apiKey: '', selectedModels: [] };
        s.providers.push(cfg);
      }
      if (apiKey !== undefined) cfg.apiKey = apiKey;
      if (baseUrl !== undefined) cfg.baseUrl = baseUrl || undefined;
      if (model) {
        const list = cfg.selectedModels ?? (cfg.selectedModels = []);
        if (!list.some((m) => m.modelId === model)) {
          list.push({ modelId: model, thinking: true } as SelectedModel);
        }
      }
    } else if (target === 'vision' || target === 'task' || target === 'outcome' || target === 'stt') {
      // task / outcome 已统一复用 chatModel；保留 target 枚举用于向后兼容 AI 调用
      const isChatRole = target === 'task' || target === 'outcome';
      const roleKey: string = isChatRole ? 'chatModel'
        : target === 'vision' ? 'vision'
        : 'stt';
      const sRoles = s as unknown as Record<string, Record<string, unknown>>;
      const role = sRoles[roleKey] = sRoles[roleKey] || {};
      if (target === 'stt') {
        if (!STT_PROVIDER_TYPES.has(provider)) return `Error: 未知 STT 厂商 '${provider}'。可用: ${[...STT_PROVIDER_TYPES].join(', ')}`;
        role.provider = provider;
        if (model !== undefined) role.model = model;
        if (apiKey !== undefined) role.apiKey = apiKey;
        if (baseUrl !== undefined) role.baseUrl = baseUrl;
      } else {
        if (!CHAT_PROVIDER_TYPES.has(provider)) return `Error: 未知厂商 '${provider}'。可用: ${[...CHAT_PROVIDER_TYPES].join(', ')}`;
        role.defaultProvider = provider;
        if (model !== undefined) role.defaultModel = model;
        if (apiKey !== undefined) role.apiKey = apiKey;
        if (baseUrl !== undefined) role.baseUrl = baseUrl;
      }
    } else {
      return 'Error: target 必须是 provider/vision/task/outcome/stt（task/outcome 已归入主对话模型）';
    }

    await writeSettingsToFile(s);
    return JSON.stringify({
      success: true,
      target,
      provider,
      ...(apiKey !== undefined ? { apiKeySet: !!apiKey } : {}),
      ...(model !== undefined ? { model } : {}),
    });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** test_model 工具：验证模型连接（TRAE 式校验，复用 /api/test-model 同逻辑） */
async function toolTestModel(args: Record<string, unknown>): Promise<string> {
  try {
    const provider = String(args.provider ?? '').trim();
    if (!provider) return 'Error: provider 为必填';

    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();

    const cfg = s.providers.find((p) => p.type === provider);
    if (!cfg) return `Error: 设置中未找到厂商 '${provider}'`;
    if (!cfg.apiKey) return `Error: 厂商 '${provider}' 未配置 API Key`;

    // 确定要测试的模型列表
    const models = Array.isArray(args.models) && args.models.length > 0
      ? args.models.map(String)
      : (cfg.selectedModels ?? []).map((m) => m.modelId);

    if (models.length === 0) {
      return `Error: 厂商 '${provider}' 没有已勾选的模型，且未传入 models 参数`;
    }

    // 解析 Base URL（清理端点后缀 + 回退到预设默认值）
    const preset = PROVIDER_PRESETS.find((p) => p.type === provider);
    const base = sanitizeBaseUrl(cfg.baseUrl || preset?.baseUrl || '');
    if (!base) return `Error: 无法解析厂商 '${provider}' 的 Base URL`;

    // 逐模型测试
    const results: Array<{ modelId: string; ok: boolean; status?: number; error?: string }> = [];

    for (const modelId of models) {
      const id = modelId.toLowerCase();
      let path: string;
      let body: object;
      let timeout: number;

      if (/seedream|seededit|gpt-image|qwen-image|dall-?e|flux|sdxl|stable-diffusion|image-edit/.test(id)) {
        path = 'images/generations';
        body = { model: modelId, prompt: 'a red circle', n: 1 };
        timeout = 100000;
      } else if (/tts|speech|voice/.test(id)) {
        path = 'services/tts';
        body = { model: modelId, input: 'hi' };
        timeout = 8000;
      } else if (/asr|whisper|qwen-audio/.test(id)) {
        path = 'audio/transcriptions';
        body = { model: modelId };
        timeout = 8000;
      } else {
        path = 'chat/completions';
        body = { model: modelId, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 16 };
        timeout = 8000;
      }

      try {
        const resp = await fetch(`${base}/${path}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });

        if (resp.ok) {
          results.push({ modelId, ok: true });
        } else {
          const text = await resp.text().catch(() => '');
          let errorMsg = text.slice(0, 200);
          if (/ModelNotFound|model.*not.*found|NoSuchModel|does not exist|do not have access|InvalidEndpointOrModel|UnsupportedModel/i.test(text)) {
            errorMsg = '模型不存在或未开通：请确认模型 ID 正确并在方舟控制台开通该模型服务（订阅制还需确认该模型在当前套餐档位内）';
          } else if (/rate.?limit|RateLimit/i.test(text)) {
            errorMsg = 'RPM 限流：每分钟请求数超限，请稍后重试或检查方舟控制台模型配额';
          }
          // TTS/STT 端点 404 特殊提示
          if (resp.status === 404 && (path === 'services/tts' || path === 'audio/transcriptions')) {
            errorMsg = '当前网关不支持语音端点（TTS/STT）：语音模型需在火山语音平台单独开通，或订阅制请改用 doubao-seed-asr-2.0 等 HTTP 端点模型';
          }
          results.push({ modelId, ok: false, status: resp.status, error: errorMsg });
        }
      } catch (err) {
        const isTimeout = err instanceof Error && /abort|timeout/i.test(err.message);
        results.push({
          modelId,
          ok: false,
          error: isTimeout
            ? 'Timeout (image generation can take 60-90s, retry later or check the Ark console)'
            : (err instanceof Error ? err.message : String(err)),
        });
      }
    }

    return JSON.stringify({ provider, baseUrl: base, results }, null, 2);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** manage_mcp_server 工具：MCP 服务器增删改 + 立即重连 */
async function toolManageMcpServer(args: Record<string, unknown>): Promise<string> {
  try {
    const action = String(args.action ?? '').trim();
    if (!['add', 'update', 'toggle', 'remove'].includes(action)) {
      return 'Error: action 必须是 add/update/toggle/remove';
    }
    const server = (args.server ?? {}) as Record<string, unknown>;
    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();
    const servers = s.mcpServers ?? (s.mcpServers = []);

    const findTarget = () =>
      servers.find((m) => (server.id && m.id === String(server.id)) || (server.name && m.name === String(server.name)));

    if (action === 'add') {
      const name = String(server.name ?? '').trim();
      if (!name) return 'Error: add 操作必须提供 server.name';
      const id = server.id ? String(server.id) : `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server'}-${Date.now().toString(36)}`;
      if (servers.some((m) => m.id === id)) return `Error: id '${id}' 已存在`;
      const transport = server.transport === 'stdio' ? 'stdio' : 'streamable-http';
      servers.push({
        id,
        name,
        transport,
        command: server.command ? String(server.command) : undefined,
        args: Array.isArray(server.args) ? server.args.map(String) : undefined,
        env: server.env && typeof server.env === 'object' ? (server.env as Record<string, string>) : undefined,
        url: server.url ? String(server.url) : undefined,
        headers: server.headers && typeof server.headers === 'object' ? (server.headers as Record<string, string>) : undefined,
        enabled: server.enabled !== false,
      });
    } else {
      const target = findTarget();
      if (!target) return `Error: 未找到 MCP 服务器（id=${server.id ?? ''} name=${server.name ?? ''}）`;
      if (action === 'toggle') {
        target.enabled = !target.enabled;
      } else if (action === 'update') {
        if (server.name !== undefined) target.name = String(server.name);
        if (server.transport !== undefined) target.transport = server.transport === 'stdio' ? 'stdio' : 'streamable-http';
        if (server.command !== undefined) target.command = server.command ? String(server.command) : undefined;
        if (server.args !== undefined) target.args = Array.isArray(server.args) ? server.args.map(String) : undefined;
        if (server.env !== undefined && typeof server.env === 'object') target.env = server.env as Record<string, string>;
        if (server.url !== undefined) target.url = server.url ? String(server.url) : undefined;
        if (server.headers !== undefined && typeof server.headers === 'object') target.headers = server.headers as Record<string, string>;
        if (server.enabled !== undefined) target.enabled = server.enabled !== false;
      } else if (action === 'remove') {
        const idx = servers.indexOf(target);
        if (idx >= 0) servers.splice(idx, 1);
      }
    }

    await writeSettingsToFile(s);

    // 按新配置立即重连（失败不阻断返回，下次请求仍会同步）
    try {
      const { mcpManager: mgr } = await import('@/lib/mcp/manager');
      await mgr.syncServers(servers);
    } catch {
      /* 重连失败留待下次请求 syncServers 兜底 */
    }

    return JSON.stringify({ success: true, action, serverCount: servers.length });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** manage_quick_launch 工具：在 ⌘F 添加/移除用户自建快捷入口（My Quick） */
async function toolManageQuickLaunch(args: Record<string, unknown>): Promise<string> {
  try {
    const action = String(args.action ?? '').trim();
    if (!['add', 'remove', 'list'].includes(action)) {
      return 'Error: action 必须是 add/remove/list';
    }
    const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
    const s = await readSettingsFromFile();
    const list = s.quickLaunchers ?? [];

    if (action === 'list') {
      return JSON.stringify({ success: true, quickLaunchers: list });
    }

    if (action === 'add') {
      const label = String(args.label ?? '').trim();
      const agent = String(args.agent ?? '').trim() || 'chat';
      const prompt = String(args.prompt ?? '').trim();
      if (!label) return 'Error: add 操作必须提供 label';
      const id = `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      s.quickLaunchers = [...list, { id, label, agent, prompt }];
      await writeSettingsToFile(s);
      return JSON.stringify({ success: true, id, label, agent, prompt });
    }

    // remove
    const id = String(args.id ?? '').trim();
    if (!id) return 'Error: remove 操作必须提供 id';
    s.quickLaunchers = list.filter((q) => q.id !== id);
    await writeSettingsToFile(s);
    return JSON.stringify({ success: true, id });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** P2-2-2 scan_docx_templates 进程级缓存（按 dir + files mtime 签名，TTL 5min） */
const _scanCache: Map<string, { value: string; expireAt: number }> = new Map();
function _pruneScanCache(now: number) {
  if (_scanCache.size > 128) {
    for (const k of _scanCache.keys()) {
      const e = _scanCache.get(k);
      if (!e || e.expireAt < now) _scanCache.delete(k);
      if (_scanCache.size <= 64) break;
    }
  }
}
/** 计算 scene-dir 下所有 docx 的最新 mtime + 文件列表签名（作为 cache key 一部分） */
function _scanDirSig(dir: string): string {
  const fs = require('fs');
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return `nodir`; }
  const docxs = files
    .filter((f: string) => /\.docx$/i.test(f) && !f.startsWith('~$'))
    .sort();
  let latest = 0;
  for (const f of docxs) {
    try {
      const s = fs.statSync(join(dir, f));
      if (s.mtimeMs > latest) latest = s.mtimeMs;
    } catch { /* ignore */ }
  }
  return `${docxs.length}:${docxs.join(',')}:${latest.toFixed(0)}`;
}

/** scan_docx_templates 工具：扫描一份/多份/场景文件夹下的 docx 模板，列出所有 {{ }} 占位符。
 *  用途：AI 在和用户确认要填哪些字段时，先调用这个工具得到字段表。
 */
async function toolScanDocxTemplates(args: Record<string, unknown>): Promise<string> {
  const script = resolveDocxTemplateScript('scan_placeholders.py');
  if (!script) return 'Error: 未找到 scan_placeholders.py（docx-template-mcp 独立包未安装）。';

  const dir = (args.dir as string) || '';       // 模板目录绝对路径
  const filesRaw = args.files;
  const files: string[] = Array.isArray(filesRaw)
    ? (filesRaw as unknown[]).filter((x): x is string => typeof x === 'string')
    : typeof filesRaw === 'string' ? [filesRaw] : [];

  // 定位目录：仅支持 dir（自定义模板目录）；files 显式列表兼容保留
  const chosenDir = dir || '';

  // P2-2-2 命中缓存：dir 模式签名相同则直接返回（避免反复启动 python 子进程）
  if (chosenDir && files.length === 0) {
    const sig = `${chosenDir}::${_scanDirSig(chosenDir)}`;
    const now = Date.now();
    const entry = _scanCache.get(sig);
    _pruneScanCache(now);
    if (entry && entry.expireAt >= now) return entry.value;
    // 执行完写入缓存时带此 sig
    (toolScanDocxTemplates as unknown as { _pendingCacheKey?: string })._pendingCacheKey = sig;
  }

  const parts: string[] = [script];
  if (chosenDir) parts.push('--dir', `"${chosenDir}"`);
  for (const f of files) {
    if (f && typeof f === 'string') parts.push(`"${f}"`);
  }
  if (parts.length === 1) return 'Error: 请提供 dir 或 files 参数之一';

  const SCRIPT_TIMEOUT = 30_000;
  try {
    const cmd = ['/usr/bin/python3', ...parts].join(' ');
    const envChild = {
      ...process.env,
      PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':'),
    };
    const { stdout, stderr } = await execAsync(cmd, { cwd: await getWorkspacePath(), timeout: SCRIPT_TIMEOUT, maxBuffer: 1024 * 1024, env: envChild });
    let out = (stdout || '').trim();
    if (!out) {
      try { out = JSON.stringify({ error: (stderr || 'empty output').trim() }, null, 2); } catch { out = stderr || 'empty'; }
    }
    const final = truncate(out, 8000);
    // P2-2-2 写入缓存：scene-dir 纯目录扫描模式（无 files 指定）且结果非 Error 才存
    const pkey = (toolScanDocxTemplates as unknown as { _pendingCacheKey?: string })._pendingCacheKey;
    if (pkey && final && !final.startsWith('Error:')) {
      _scanCache.set(pkey, { value: final, expireAt: Date.now() + 5 * 60 * 1000 });
      (toolScanDocxTemplates as unknown as { _pendingCacheKey?: string })._pendingCacheKey = undefined;
    }
    return final;
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    (toolScanDocxTemplates as unknown as { _pendingCacheKey?: string })._pendingCacheKey = undefined;
    if (err.killed) return `Error: 模板扫描超时 (${SCRIPT_TIMEOUT / 1000}s)`;
    let msg = (err.stdout || '') + (err.stderr ? `\n[stderr]\n${err.stderr}` : '');
    if (!msg.trim()) msg = err.message || String(e);
    return `Error: ${truncate(msg, 5000)}`;
  }
}

/** fill_docx_templates 工具：用一套/多套数据填写 docx 模板。
 *  输入：dir（模板目录）或 files（模板文件列表），
 *  加上 context（单套数据 object） 或 rows（多套数据 object[]）。
 *  输出 JSON，包含生成的每个文件绝对路径及 zip 下载路径。
 */
async function toolFillDocxTemplates(args: Record<string, unknown>): Promise<string> {
  const script = resolveDocxTemplateScript('fill_template.py');
  if (!script) return 'Error: 未找到 fill_template.py（docx-template-mcp 独立包未安装）。';

  const dir = (args.dir as string) || '';
  const filesRaw = args.files;
  const files: string[] = Array.isArray(filesRaw)
    ? (filesRaw as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const context = args.context as Record<string, unknown> | undefined;
  const rowsRaw = args.rows;
  const rows: Record<string, unknown>[] | undefined = Array.isArray(rowsRaw)
    ? (rowsRaw as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : undefined;

  const ws = await getWorkspacePath();
  const path = require('path');
  const fs = require('fs');

  // 组装 python 命令参数：dir/files 指定模板目录/文件（附件场景）
  const argParts: string[] = [script];
  if (dir) argParts.push('--dir', `"${dir}"`);
  for (const f of files) if (f && typeof f === 'string') argParts.push(`"${f}"`);

  // 写数据到临时 JSON，避免命令行转义地狱
  const ts = Date.now();
  let dataFile: string | null = null;
  try {
    if (rows && Array.isArray(rows)) {
      const rowsPath = path.join(ws, `.bob_docx_rows_${ts}.json`);
      await writeFile(rowsPath, JSON.stringify(rows, null, 2), 'utf-8');
      dataFile = rowsPath;
      argParts.push('--rows-json', `"${rowsPath}"`);
    } else if (context && typeof context === 'object') {
      const ctxPath = path.join(ws, `.bob_docx_ctx_${ts}.json`);
      await writeFile(ctxPath, JSON.stringify(context, null, 2), 'utf-8');
      dataFile = ctxPath;
      argParts.push('--data-json', `"${ctxPath}"`);
    } else {
      return 'Error: 必须提供 context (object) 或 rows (object[]) 参数';
    }
  } catch (e) {
    return `Error: 写入临时数据文件失败: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 输出目录 + zip：统一到项目 homework/template/（与插件模式 fill/route.ts 同目录，Finder 可见、侧边栏分组可见）。
  // AI 工具产物放在 docx_fill_<scene>_<stamp>/ 子目录，避免与插件模式根目录文件重名冲突。
  const projectRoot = await getProjectRootPath();
  const templateRoot = join(projectRoot, 'homework', 'template');
  try { fs.mkdirSync(templateRoot, { recursive: true }); } catch { /* ignore */ }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + Date.now().toString().slice(-6);
  const outDir = join(templateRoot, `docx_fill_custom_${stamp}`);
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
  argParts.push('--out-dir', `"${outDir}"`);
  const zipPath = join(templateRoot, `docx_fill_custom_${stamp}.zip`);
  argParts.push('--zip', `"${zipPath}"`);
  // 每套数据一个子目录（set_000/、set_001/...）：与批次目录双层隔离，同套多个模板归入同一子目录
  argParts.push('--row-subdir', 'set');

  // 自定义命名规则（可选）
  const namingRule = args.namingRule as string | undefined;
  if (namingRule) argParts.push('--naming-rule', `"${namingRule.replace(/"/g, "'")}"`);

  const SCRIPT_TIMEOUT = 120_000;
  try {
    const cmd = ['/usr/bin/python3', ...argParts].join(' ');
    const envChild = {
      ...process.env,
      PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':'),
    };
    const { stdout, stderr } = await execAsync(cmd, { cwd: ws, timeout: SCRIPT_TIMEOUT, maxBuffer: 5 * 1024 * 1024, env: envChild });
    let out = (stdout || '').trim();
    if (!out) {
      out = JSON.stringify({ ok: false, error: (stderr || 'empty output').trim() }, null, 2);
    }
    return truncate(out, 8000);
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    if (err.killed) return `Error: 模板填充超时 (${SCRIPT_TIMEOUT / 1000}s)`;
    let msg = (err.stdout || '') + (err.stderr ? `\n[stderr]\n${err.stderr}` : '');
    if (!msg.trim()) msg = err.message || String(e);
    return `Error: ${truncate(msg, 5000)}`;
  } finally {
    if (dataFile) try { await unlink(dataFile); } catch { /* ignore */ }
  }
}

/** 工具注册表实例 */
const registry = new ToolRegistry();
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

/** 查询内置工具分层（供排序/过滤用；未标注默认 core） */
export function getToolLayer(name: string): ToolLayer {
  return BUILTIN_LAYER[name] ?? 'core';
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
      description: `[MCP: ${mcpTool.serverName}] ${mcpTool.description}`,
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
/** 服务端 ai-card 卡片列表生成器（方案 B）—— 输出结构对应前端 HtmlRenderer 注入的 .ai-card CSS。
 *  用于 web_search / browser.snapshot 等结构化工具：宿主直接渲染卡片，LLM 只需引用精简文本。 */
export interface CardItem {
  title: string;
  badge?: string;
  badgeColor?: 'default' | 'green' | 'red';
  status?: 'ok' | 'err' | 'run';
  meta?: string;
  body?: string;
  url?: string;
  btnText?: string;
}

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildCardListHtml(items: CardItem[]): string {
  if (!items || items.length === 0) return '';
  const cards = items
    .map((it) => {
      const badge = it.badge
        ? `<span class="ai-badge${it.badgeColor && it.badgeColor !== 'default' ? ' ' + it.badgeColor : ''}">${escHtml(it.badge)}</span>`
        : '';
      const status = it.status ? `<span class="ai-status ${escHtml(it.status)}"></span> ` : '';
      const meta = it.meta || it.status ? `<div class="ai-card-meta">${status}${escHtml(it.meta || '')}</div>` : '';
      const body = it.body ? `<div class="ai-card-body">${escHtml(it.body)}</div>` : '';
      const btn = it.url ? `<div class="ai-card-body"><a class="ai-btn" href="${escHtml(it.url)}">${escHtml(it.btnText || '查看详情')}</a></div>` : '';
      return `<div class="ai-card"><div class="ai-card-title">${escHtml(it.title)}${badge}</div>${meta}${body}${btn}</div>`;
    })
    .join('\n');
  return `<div class="ai-card-list">\n${cards}\n</div>`;
}

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
