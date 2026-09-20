/**
 * Agent 工具系统 — 跨场景共享基础层
 *
 * 从 tools/index.ts 抽出的公共助手，供各场景模块（butler / hippo-browser / ocr / ...）
 * 与聚合入口共同引用，避免「场景模块 ⇄ index.ts」的循环依赖。
 */

import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { join, resolve, isAbsolute, sep } from 'path';
import { getCurrentProject } from '@/lib/project/project-manager';
import { resolveAppRoot, SANDBOX_DIRNAME, BOB_SANDBOX_DIRNAME, LOGS_DIRNAME } from '@/lib/app-root';

/** bob-sandbox/apps/ 根目录（Bob Sandbox 小程序目录） */
export const SANDBOX_APPS_DIR = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME, 'apps');

/** 当前项目根路径（无激活项目时回退 ~/BobWork/.sandbox 兜底） */
export async function getProjectRootPath(): Promise<string> {
  try {
    const project = await getCurrentProject();
    return project.path;
  } catch {
    return join(homedir(), 'BobWork', SANDBOX_DIRNAME);
  }
}

/**
 * 当前项目 AI 工作区：<项目>/homework/.ai-workspace/
 * 脚本执行、临时生成物等中间产物隔离在项目内，保持项目独立性。
 * 无激活项目时回退到 ~/BobWork/.sandbox 兜底。
 */
export async function getWorkspacePath(): Promise<string> {
  try {
    const project = await getCurrentProject();
    const ws = join(project.path, 'homework', '.ai-workspace');
    try { mkdirSync(join(ws, 'scripts'), { recursive: true }); } catch {}
    return ws;
  } catch {
    const sandbox = join(homedir(), 'BobWork', SANDBOX_DIRNAME);
    try { mkdirSync(sandbox, { recursive: true }); } catch {}
    return sandbox;
  }
}

/**
 * 路径解析 — 对应 Python 版 Path.expanduser() + resolve()
 *
 * 支持：
 *   - ~ 展开为用户主目录
 *   - 相对路径基于当前项目 AI 工作区（homework/.ai-workspace/）
 *   - 绝对路径直接使用
 */
export async function resolvePath(inputPath: string): Promise<string> {
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

/** 截断输出，附加字符计数 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n...(truncated, ${text.length} chars total)`;
}

/** 扫描件 PDF OCR 单次返回上限（**1M 窗口模型的上限**）：超过时按页边界截断，提示模型用 pages 参数续读。
 *  实际取值由调用方按请求窗口收缩（read_attachment 的 buildOcrAttachmentOutput：min(本值, ctx.maxOutputChars)），
 *  小窗口模型下头部标注的"本次返回第 X-Y 页"才会与实际可见内容一致。 */
export const OCR_MAX_LENGTH = 150000;

/** 读取类工具内部返回上限的**天花板**（read_file / read_attachment / run_command 等，1M 窗口模型用满）。
 *  实际单次上限由 T_turn 收紧（context-limits.toolOutputMaxForContext，1M→5 万）与 T_task 累计预算
 *  （taskToolOutputMaxForContext）决定：读取类工具经 ctx.maxOutputChars 取二者更小值
 *  （attachment.ts readCapForContext），避免续读提示被外层截断吞掉。 */
export const READ_CAPACITY = 150000;

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

/** 工具审计日志路径：~/BobWork/.logs/tool-audit.log（自动清理 30 天前的行） */
const AUDIT_LOG_DIR = join(homedir(), 'BobWork', LOGS_DIRNAME);
const AUDIT_LOG_PATH = join(AUDIT_LOG_DIR, 'tool-audit.log');
const AUDIT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
let auditLastPruneTs = 0; // 上次执行清理的时间（每天最多清一次，避免频繁 IO）
try { require('fs').mkdirSync(AUDIT_LOG_DIR, { recursive: true }); } catch {}

export function auditLog(entry: unknown): void {
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

/** 检查路径是否在可读范围内（AI 侧文件操作工具统一限制：BobWork 数据根 appRoot 全量 + 当前项目 + 用户授权目录） */
export async function isReadablePath(resolvedPath: string): Promise<boolean> {
  const [projectRoot, localRoots] = await Promise.all([getProjectRootPath(), getLocalAuthorizedRoots()]);
  // 便签（sticky-notes/）为纯用户私有数据：不写入节点 .md、不接入搜索，AI 一律不可读。
  // 按路径段排除，保证 appRoot 全量授权后其它项目下的 sticky-notes 同样不可读。
  if (resolvedPath.split(sep).includes('sticky-notes')) return false;
  // appRoot 全量放行（skills/extensions/mcp/bob-sandbox/BobWorkspace 各项目等尽在其内）；
  // 另保留 projectRoot 以覆盖不在 appRoot 下的外置项目。
  const allRoots = [resolveAppRoot(), projectRoot, ...localRoots];
  return allRoots.some(root => {
    const r = resolve(root);
    return resolvedPath === r || resolvedPath.startsWith(r + sep);
  });
}

/** 格式化文件大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
