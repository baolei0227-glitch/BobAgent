import { homedir } from 'os';
import { join, basename, sep, relative, resolve, dirname } from 'path';
import { statSync, readdirSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import {
  PROVIDER_PRESETS,
  type ProviderType,
  type ThinkingLevel,
  type OutputFileItem,
  REASONING_EFFORT_MAP,
  SYSTEM_PROMPT_INJECTIONS,
} from '@/lib/types';
import { TOOL_DEFINITIONS, executeTool, getToolSummary, getLocalAuthorizedRoots, describeToolCall } from './tools';
import type { ToolScene } from './tools';
// K2-S1 工具面 runtime service 抽取，行为不变：注册/组装/排序/CacheGuard 收敛进 ToolRuntime
import { ToolRuntime } from '@/lib/runtime/tools';
// K2-S2 会话态 runtime service 抽取，行为不变：chatStickyScenes 收敛进 SessionRuntime 单例
import { sessionRuntime } from '@/lib/runtime/session';
import type { AgentId } from '@/lib/agents/profiles';
import { codingPhaseForTool } from '@/lib/agents/profiles';
import { resolveAgentProfile } from '@/lib/agents/store';
import { getCurrentProject, getProjectById, listProjects, type ProjectConfig } from '@/lib/project/project-manager';
import { readSettingsFromFile } from '@/lib/settings-server';
import { pluginDataHome } from '@/lib/extensions/data-home';
import { DEFAULT_CONFIRM_TOOLS } from '@/lib/settings';
// P4b-1 审批策略层：tool_confirm 名单判定后走 decideToolApproval（纯函数裁决，见 approval.ts）
import { decideToolApproval } from '@/lib/chat/approval';
import { createPendingConfirm, CONFIRM_TIMEOUT_MS, type ConfirmResult } from '@/lib/chat/confirm-pending';
// P4a 三段化骨架：工具轮宿主接管注册表 + 场景激活统一执行（纯类型 + 编排，见 tool-pipeline.ts 文件头注释）
// P4a-3-1：挂起型（host-pending）接管注册/查询（registerHostTakeover / hostTakeoverFor）
import { registerTakeover, takeoverFor, takeoverOfKind, applyScenarioActivation, registerHostTakeover, hostTakeoverFor } from '@/lib/chat/tool-pipeline';
import type { TakeoverServices, HostTakeoverContext, HostTakeoverVerdict } from '@/lib/chat/tool-pipeline';
// Phase 2 策略层抽取：思考档位决策收敛到纯函数模块（默认行为与现网一致）
import { v4ThinkingModeForLevel, executionDowngrade, isTrivialPrompt, shouldInjectThinkPrompt, type ThinkingPolicyConfig } from '@/lib/thinking/policy';

// ── Planner 结构化确认卡片（排程创建/修改/删除走可编辑确认，而非直接执行）──
const PLANNER_CARD_TOOLS = new Set(['create_scheduled_todo', 'todo_update', 'todo_delete']);

type PlannerCard = {
  tool: string;
  mode: 'create' | 'update' | 'delete';
  event_id: string | null;
  title: string;
  date: string;   // YYYY-MM-DD（本地）
  start: string;  // HH:MM
  end: string;    // HH:MM（可空）
  allDay: boolean;
  reminderMinutes: number[];
  targetLabel: string;
  conflicts: { title: string; when: string }[];
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function toLocalDateStr(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function toLocalTimeStr(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 冲突提示：与 [start,end) 有交集且仍 scheduled 的事件（排除自身） */
async function nearbyConflicts(
  startIso: string | null,
  endIso: string | null,
  excludeEventId?: string,
): Promise<{ title: string; when: string }[]> {
  if (!startIso) return [];
  try {
    const { getCalendarDb, listEventsInRange } = await import('@/lib/db');
    const db = await getCalendarDb();
    const end = endIso || new Date(new Date(startIso).getTime() + 30 * 60_000).toISOString();
    const rows = await listEventsInRange(db, null, startIso, end);
    return rows
      .filter((r) => r.status === 'scheduled' && r.event_id !== excludeEventId)
      .slice(0, 5)
      .map((r) => ({ title: r.title, when: toLocalTimeStr(r.start_time) || '—' }));
  } catch {
    return [];
  }
}

/** 把工具参数转成结构化卡片；构建失败（如待改/删事件不存在）返回 null（跳过卡片直接执行） */
async function buildPlannerCard(
  toolName: string,
  args: Record<string, unknown> | null,
): Promise<PlannerCard | null> {
  try {
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const numArr = (v: unknown): number[] =>
      Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
    if (toolName === 'create_scheduled_todo') {
      const title = str(args?.title).trim();
      const startIso = str(args?.start_time) || null;
      const endIso = str(args?.end_time) || null;
      const allDay = args?.all_day === true;
      const reminderMinutes = numArr(args?.reminder_minutes);
      const conflicts = await nearbyConflicts(startIso, endIso);
      return {
        tool: toolName,
        mode: 'create',
        event_id: null,
        title,
        date: toLocalDateStr(startIso),
        start: toLocalTimeStr(startIso),
        end: toLocalTimeStr(endIso),
        allDay,
        reminderMinutes,
        targetLabel: '',
        conflicts,
      };
    }
    const eventId = str(args?.event_id);
    if (!eventId) return null;
    const { getCalendarDb, getEvent } = await import('@/lib/db');
    const db = await getCalendarDb();
    const row = await getEvent(db, eventId);
    if (!row) return null;
    if (toolName === 'todo_delete') {
      return {
        tool: toolName,
        mode: 'delete',
        event_id: eventId,
        title: row.title,
        date: toLocalDateStr(row.start_time),
        start: toLocalTimeStr(row.start_time),
        end: '',
        allDay: row.all_day === 1,
        reminderMinutes: [],
        targetLabel: row.title,
        conflicts: [],
      };
    }
    // todo_update：以现有事件为默认，可被 args 覆盖
    let rowReminders: number[] = [];
    try {
      const parsed = JSON.parse(row.reminder_minutes_json || '[]');
      if (Array.isArray(parsed)) rowReminders = parsed.filter((x): x is number => typeof x === 'number');
    } catch {
      rowReminders = [];
    }
    const title = str(args?.title).trim() || row.title;
    const startIso = str(args?.start_time) || row.start_time;
    const endIso = str(args?.end_time) || row.end_time;
    const allDay = typeof args?.all_day === 'boolean' ? args.all_day : row.all_day === 1;
    const reminderMinutes =
      args?.reminder_minutes !== undefined && args?.reminder_minutes !== null
        ? numArr(args.reminder_minutes)
        : rowReminders;
    const conflicts = await nearbyConflicts(startIso, endIso, eventId);
    return {
      tool: toolName,
      mode: 'update',
      event_id: eventId,
      title,
      date: toLocalDateStr(startIso),
      start: toLocalTimeStr(startIso),
      end: toLocalTimeStr(endIso),
      allDay,
      reminderMinutes,
      targetLabel: row.title,
      conflicts,
    };
  } catch {
    return null;
  }
}
import { createPendingQuestions, QUESTIONS_TIMEOUT_MS, type PendingQuestionItem, type PendingAnswerEntry } from '@/lib/chat/questions-pending';
import { classifyOutputKind } from '@/lib/homework/kind';
import { createPendingLogin, LOGIN_TIMEOUT_MS } from '@/lib/chat/login-pending';
import { applyPdfBridge, PREWARM_MAX_PAGES } from '@/lib/pdf/bridge';
import { buildSkillContext } from '@/lib/skills/context';
import { getAllSkills } from '@/lib/skills/loader-server';
import { getAgentSkills, getEnabledSkillsForAgent, hasAgentConfig } from '@/lib/skills/registry-server';
import type { SkillMatchResult } from '@/lib/skills/types';
import { getAncestorChain, loadNodeById } from '@/lib/nodes/ancestors';
import { renderOutcome } from '@/lib/nodes/outcome';
import {
  runCompaction,
  extractHardFacts,
  extractGoalFromExistingMemory,
  compactionFallbackSummary,
  COMPACT_COOLDOWN_MS,
  type CompactModelConfig,
} from '@/lib/nodes/compact';
import {
  serializeNode,
  updateNodeFile,
  findNodeFileById,
  type ConversationTurn,
} from '@/lib/node-markdown';
import { inferContextWindow, contextGateForContext, toolOutputMaxForContext, modelOutputTokenMaxForModel } from '@/lib/context-limits';
import { readManifest, extractKeywords } from '@/lib/nodes/manifest';
import { internSearchNode } from '@/lib/nodes/intern';
import { matchTerms } from '@/lib/legal/synonyms';
import { SANDBOX_DIRNAME, resolveAppRoot } from '@/lib/app-root';
import { readAppEntry, hasAppImplementation } from '@/lib/sandbox/apps';
import { getBridgeActionsText } from '@/lib/sandbox/bridge';
import { resolveProviderModel, resolveTaskModel, resolveAgentRoleModel, resolveAutoTaskModel } from '@/lib/wanted/task-model';
import { EventLog, genSpanId, genTaskId, persistEventLog, CORE_EVENT } from '@/lib/trajectory/event-log';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 允许省略：工具调用轮次的 assistant 消息可能只有 tool_calls 而无文本 */
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

// （DEFAULT_CHAT_SCENES 已移除 2026-08-30：普通对话改为「核心常驻 + 动态场景激活」，
//  见 detectSceneHints / 会话 sticky（K2-S2 收敛进 SessionRuntime），工具集按意图 + 会话 sticky 决定，省上下文固定税）
// （K2-S1 工具面 service 抽取，行为不变：SANDBOX_BLOCKED_TOOLS 沙盒禁写名单随迁 src/lib/runtime/tools.ts）

// classifyOutputKind 由 @/lib/homework/kind 提供（侧边栏按文件类别标签分组展示；
//  存储平铺在 homework/ 根目录，不生成 kind 子文件夹）。


/**
 * 判定一次工具调用是否发生「系统变更」（安装脚本/工具、写文件、改配置等），
 * 供执行轨迹中突出标记，让用户一眼看到"模型改变了本机什么"。
 * 规则保守：只标记明确变更语义的工具/命令，不误标纯查询类。
 */
function classifySystemChange(
  toolName: string,
  args: Record<string, unknown>,
): { change: boolean; summary?: string } {
  switch (toolName) {
    case 'write_file':
    case 'append_file':
      return { change: true, summary: `写入文件 ${typeof args.path === 'string' ? args.path : ''}` };
    case 'delete_file':
      return { change: true, summary: `删除文件 ${typeof args.path === 'string' ? args.path : ''}` };
    case 'rename_file':
      return { change: true, summary: `重命名/移动文件` };
    case 'manage_mcp_server':
      return { change: true, summary: '修改 MCP 服务器配置' };
    case 'run_command': {
      const cmd = String(args.command ?? '');
      const m = cmd.match(/(?:pip3?|npm|pnpm|yarn|brew|apt(?:-get)?|apk|gem|composer|poetry)\s+(?:install|add|uninstall|remove|upgrade|update|i)\b/i);
      if (m) return { change: true, summary: `安装/卸载软件包：${m[0]}` };
      // 常见脚本产物/源码构建也算系统变更
      if (/(?:python3?\s+[^\s]+\.py|node\s+[^\s]+\.js|\.\/[a-zA-Z0-9_-]+\.sh|make\b)/.test(cmd)) {
        return { change: true, summary: `执行脚本/构建命令` };
      }
      return { change: false };
    }
    default:
      return { change: false };
  }
}

/**
 * 从 allToolCalls 中提取本次交互产生的输出文件（写文件/重命名/脚本产物），
 * 仅保留位于项目 homework/ 或 attachments/ 目录下的文件。
 */
function extractOutputFiles(
  allToolCalls: Array<{ toolName: string; arguments: Record<string, unknown>; result: string; success: boolean }>,
  projectRoot: string,
  workspacePath: string,
): OutputFileItem[] {
  const seen = new Set<string>();
  const out: OutputFileItem[] = [];

  const pushIfValid = (rawPath: string | undefined, source: string) => {
    if (!rawPath) return;
    try {
      let abs: string;
      if (rawPath.startsWith('~')) abs = join(homedir(), rawPath.slice(1));
      else if (resolve(rawPath) === rawPath) abs = resolve(rawPath);
      else {
        // homework/ 和 attachments/ 相对路径应从项目根解析，而非 .ai-workspace
        const np = rawPath.replace(/\\/g, '/');
        if (np.startsWith('homework/') || np === 'homework') {
          // 存储平铺：产物直接落在 homework/ 根目录，不生成 kind 子文件夹；
          // 与 tools.ts resolvePath 写入逻辑一致，确保 stat 命中真实落盘路径。
          const relInHomework = np === 'homework' ? '' : np.slice('homework/'.length);
          abs = relInHomework ? resolve(projectRoot, 'homework', relInHomework) : resolve(projectRoot, 'homework');
        }
        else if (np.startsWith('attachments/') || np === 'attachments') abs = resolve(projectRoot, rawPath);
        else if (np.startsWith('.sandbox/') || np === '.sandbox' || np.startsWith('bob-sandbox/') || np === 'bob-sandbox') abs = resolve(resolveAppRoot(), rawPath);
        else abs = resolve(workspacePath, rawPath);
      }

      // 转换为项目根相对路径；不在项目下的文件不展示（避免泄露跨项目/用户目录）
      let rel: string;
      if (abs === projectRoot || abs.startsWith(projectRoot + sep)) {
        rel = abs === projectRoot ? '.' : relative(projectRoot, abs);
      } else {
        // 允许 homework 目录下的相对路径直接展示（resolve 后不在项目下，但属于 .sandbox 兜底）
        if (abs.startsWith(homedir()) && abs.includes('BobWork')) {
          rel = abs;
        } else {
          return;
        }
      }

      if (seen.has(rel)) return;
      seen.add(rel);

      // 过滤：只展示 homework/、attachments/ 开头（或用户根目录下的 homework/.sandbox）
      const normalized = rel.replace(/\\/g, '/');
      const isInHomework = normalized.startsWith('homework/') || normalized.startsWith('.sandbox/') || normalized.startsWith('bob-sandbox/') || normalized.includes('/homework/') || normalized.includes('BobWork/.sandbox') || normalized.includes('BobWork/bob-sandbox') || normalized.includes('.sandbox/apps') || normalized.includes('bob-sandbox/apps');
      const isInAttachments = normalized.startsWith('attachments/');
      const isInWorkspaceTmp = normalized.includes('.ai-workspace/') && !isInHomework;
      if (!isInHomework && !isInAttachments) return;
      if (isInWorkspaceTmp) return; // 临时脚本工作区不展示

      const name = basename(rel) || 'file';
      // 文件必须真实存在：解析出的路径可能是"幽灵路径"（如 OutputFile 行未换行把说明文字拼进
      // 文件名，statSync 会失败），不存在则跳过，避免卡片展示 0 B 的不存在文件。
      let size: number;
      try {
        size = statSync(abs).size;
      } catch {
        return;
      }

      out.push({
        path: rel,
        name,
        size,
        kind: classifyOutputKind(name),
        source,
      });
    } catch { /* ignore */ }
  };

  for (const tc of allToolCalls) {
    if (!tc.success) continue;
    if (tc.toolName === 'write_file') {
      pushIfValid(tc.arguments.path as string | undefined, 'write_file');
    } else if (tc.toolName === 'rename_file') {
      pushIfValid(tc.arguments.target as string | undefined, 'rename_file');
    } else if (tc.toolName === 'run_command' || tc.toolName === 'execute_script') {
      // 从 stdout 中尝试匹配 OutputFile: <path> 或 Written: <path> 或 Saved: <path>
      const result = tc.result || '';
      const re = /(?:OutputFile|Written|Saved|Created|Generated):\s*([^\s\n\r]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(result)) !== null) {
        pushIfValid(m[1], tc.toolName);
      }
      // 注意：不做「stdout 中任意 homework/ 路径」的宽松扫描——ls/find/tree 等列举命令
      // 会把整个 homework 目录误判为输出。无标记的脚本产物由调用方 homework 快照 diff 兜底。
    }
  }

  return out;
}

/**
 * 递归列出 <root>/homework 下所有文件（跳过 .ai-workspace 等隐藏目录），
 * 返回 Map<相对项目根路径, mtimeMs>。用作"本轮开始时"的快照基准。
 */
function listHomeworkFiles(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const homeworkRoot = join(root, 'homework');
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) continue; // 隐藏目录（.ai-workspace 等）一律跳过
        walk(full);
      } else if (ent.isFile()) {
        try {
          out.set(relative(root, full).replace(/\\/g, '/'), statSync(full).mtimeMs);
        } catch { /* ignore */ }
      }
    }
  };
  walk(homeworkRoot);
  return out;
}

/**
 * 兜底移正：execute_script / run_command 的脚本 CWD 是 <项目>/homework/.ai-workspace/
 * （见 tools.ts getWorkspacePath）。若脚本误用相对路径 "homework/xxx" 写交付文件
 * （工具描述已要求用 BOB_PROJECT_HOMEWORK/BOB_NODE_HOMEWORK 绝对路径，但模型仍可能不遵守），
 * 文件会错落到 .ai-workspace/homework/xxx，而输出扫描跳过 .ai-workspace → 用户看不到。
 * 此函数在扫描前把该错误落点下的文件移正到 homework/ 根
 * （目标已存在则跳过，不覆盖既有文件），使其能进入输出卡片扫描。
 */
function salvageMisplacedScriptOutputs(root: string): void {
  const wsHomework = join(root, 'homework', '.ai-workspace', 'homework');
  const realHomework = join(root, 'homework');
  const walk = (dir: string, relDir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在（常见情况）或不可读，静默返回
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const rel = relDir ? join(relDir, ent.name) : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        // 存储平铺：误落文件直接移正到 homework/ 根目录，不生成 kind 子文件夹
        const dest = join(realHomework, rel);
        if (existsSync(dest)) continue; // 同名冲突：不覆盖既有文件
        try {
          renameSync(full, dest);
        } catch { /* 单个文件移正失败不阻断整体扫描 */ }
      }
    }
  };
  walk(wsHomework, '');
}

/** 读取 homework/.ownership.json（相对 homework 根路径 → nodeId）。
 *  与 tools.ts 的 readOwnershipManifest 语义一致；route.ts 侧使用同步版避免请求闭包内额外异步。 */
function readOwnershipManifestSync(root: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(root, 'homework', '.ownership.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/** 原子写入 homework/.ownership.json（合并更新）。临时文件 + rename，防止并行节点互相覆盖丢条目。 */
function writeOwnershipManifestSync(root: string, entries: Record<string, string>): void {
  const manifestPath = join(root, 'homework', '.ownership.json');
  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch { /* 首次创建 */ }
  const merged = { ...existing, ...entries };
  const tmpPath = join(root, 'homework', `.ownership.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  renameSync(tmpPath, manifestPath);
}

/**
 * 与轮次开始前的快照对比，找出本轮新增或被改写的 homework/ 文件。
 * 兜底覆盖 run_command / execute_script 等未带 OutputFile/Written 标记的脚本产物，
 * 保证任何方式写进 homework/ 的成果都能以输出卡片（链接标签）形式展示。
 *
 * 并发隔离：多个节点在同项目并行执行时共享 homework/ 目录，本函数按
 * homework/.ownership.json 的归属清册过滤——已归属其他节点的文件不收入当前节点
 * 卡片；无归属的兜底产物认领给当前节点（临时文件 + 原子 rename 写入），
 * 防止后结束的并行节点把他人产物收进自己的输出卡片。
 * 【串行性保障】本函数必须保持全同步执行（内部无 await，fs 全用同步版）：
 * Node 单线程事件循环下，读清册→过滤→认领写清册在进程内天然串行，
 * 两个并行请求的 diff 不会交错，因此认领无竞态。若未来需要引入 await，
 * 必须先用进程内互斥锁包裹认领临界区，否则认领竞态会重新出现。
 */
async function diffHomeworkFiles(
  before: Map<string, number>,
  root: string,
  currentNodeId?: string,
): Promise<OutputFileItem[]> {
  salvageMisplacedScriptOutputs(root); // 先移正脚本误落 .ai-workspace/homework/ 的产物，再扫描
  const after = listHomeworkFiles(root);
  const out: OutputFileItem[] = [];
  let manifest: Record<string, string> = {};
  if (currentNodeId) {
    manifest = readOwnershipManifestSync(root);
  }
  const claim: string[] = []; // 无归属兜底产物（相对 homework/ 根的 key），认领给当前节点
  for (const [rel, mtime] of after) {
    // 隐藏段（.ownership.json 等）一律不入卡片
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    const unchanged = before.has(rel) && before.get(rel) === mtime;
    if (unchanged) continue;
    if (currentNodeId) {
      // manifest key 是相对 homework/ 根的路径（tools.ts getHomeworkRelativePath 口径），
      // rel 是相对项目根路径，先去前缀再查归属，避免 key 不一致导致归属误判
      const mkey = rel.replace(/^homework\//, '');
      const owner = manifest[mkey];
      if (owner) {
        if (owner !== currentNodeId) continue; // 其他并行节点的产物不得串入当前节点卡片
      } else {
        claim.push(mkey);
      }
    }
    let size = 0;
    try {
      size = statSync(join(root, rel)).size;
    } catch { /* ignore */ }
    out.push({
      path: rel,
      name: basename(rel),
      size,
      kind: classifyOutputKind(rel),
      source: 'homework-scan',
    });
  }
  // 认领无归属的兜底产物：写入原子清册，后续并行节点 diff 时不再重复收入
  if (claim.length > 0 && currentNodeId) {
    try {
      const entries: Record<string, string> = {};
      for (const k of claim) entries[k] = currentNodeId;
      writeOwnershipManifestSync(root, entries);
    } catch { /* 认领失败不影响主流程 */ }
  }
  return out;
}

// （K2-S1 工具面 service 抽取，行为不变：CacheGuard 前缀守卫整体迁至 src/lib/runtime/tools.ts，
//  module 级可变状态随迁、进程内共享语义不变；guardToolsPrefix 由 buildAndSortToolDefs 调用）

/** BASE_SYSTEM_PROMPT —— 缓存头（version 冻结，当前 v3）：基础系统提示（不包含思考指令）。
 *  本段字节一旦上线即冻结；任何修改必须整体递增版本号（v3→v4…），否则 DeepSeek 前缀缓存整段失效一次。
 *  动态/低频变化内容一律走 prependDynamicContext 注入 user 消息，禁止写进本段。 */
const BASE_SYSTEM_PROMPT = `你是一个能使用工具的智能助手，正在无限画布上的对话节点中与用户交流。回答简洁明了，适合在卡片中阅读。

【规则优先级】以下规则冲突时，高优先级优先，低优先级让位：
① 专业内容准确性铁律（禁编造法条/剂量/数据/转写） > ② 强制结束/规划机制（finish_task/todo_write） > ③ 输出选型与可视化规则 > ④ 场景按需规则（报告插图/浏览器操作）。

回答格式说明：
- 你的回答会被渲染为 HTML 显示在卡片中。你可以直接使用 HTML 标签来美化排版，也可以使用 Markdown 语法（会自动转换）。
- 支持的 HTML 标签：<h1>-<h3>、<p>、<strong>、<em>、<ul>、<ol>、<li>、<blockquote>、<a>、<img>、<hr>、<br>、<details>、<summary>、<code>、<pre>、<div>、<span>
- 支持的 Markdown 语法：# 标题、**粗体**、*斜体*、- 列表、> 引用、[链接](url)、![图片](url)、行内代码、代码块（三反引号包裹）
- 代码块请使用 Markdown 的三反引号语法，不要用 pre 标签
- 所有内容会经过安全过滤，危险的脚本和样式会被自动移除
- 不要使用 <script>、<style>、<iframe>、<object>、<embed> 等危险标签（**例外：widget:html 代码块内部第一行写 <style> 是允许且必写的**，见下「唯一放行通道」）

输出选型铁律：
1. **简短回答 / 单段陈述** → Markdown 或纯文，不强行加结构
2. **条目罗列（不含对比/KPI）**（搜索结果/清单/待办/引用）→ Markdown 列表；仅当每条含「标题+摘要+链接」三层以上时考虑下一档
3. **结构化呈现（≥5 条且每条 ≥3 字段，或含视觉焦点）走 widget**：方案对比 / KPI 总览 / 数据看板 / 流程 / 架构 / 一图看懂 → widget；低密度条目（<5 条或单字段）用 Markdown 列表即可，不写 Markdown 数据表格、不手写裸 HTML 卡片（宿主 .ai-card 系列仅限 web_search 等工具描述明确要求的格式化结果，见下）、不写 ASCII
4. **长篇完整报告 / 文档** → 生成 .md / .html 写入 homework/，正文只给摘要 + OutputFile 行

【可视化 · 硬性规则（配色/组件/图表细节先 \`load_skill("bob-ui")\`，再 \`read_skill_resource\` 读 L3 资源，不要凭记忆猜）】
- 结构化呈现（方案对比 / KPI / 趋势 / 占比 / 流程 / 架构 / 一图看懂）必须走 widget；禁止 ASCII 画法（方框/树形/连线箭头）、纯 Markdown 数据表格、手写 \`<div class="ai-card-list">\` 等旧卡片拼对比/KPI/看板
- widget 唯一格式（写错=整块不渲染）：独立成行的代码块围栏 \`\`\`widget:chart\`\`\` / \`\`\`widget:html\`\`\` / \`\`\`widget:mermaid\`\`\` / \`\`\`widget:svg\`\`\`，围栏后第一行即内容、必须成对闭合；禁止 \*\*widget:html\*\* 加粗/标题/引用写法、禁止双重围栏、禁止正文内嵌 Mermaid 语法
- widget:html 块内第一行必须写 <style> 注入品牌 Purple 主题变量（强调色 #4B3FE3）；组件复用 .w-card/.w-kpi/.w-tag/.w-btn，禁止裸 div+inline style 拼卡片；术语/定义表（≤5 行）与原文抄录对照数据可用 Markdown 表格，其余一律 widget

⚠️ 输出结构（正文只给交付物）：
- 正文只输出**最终结论与交付物**（摘要、汇总、结论、OutputFile 行）；执行过程、操作步骤、中间推理（如"开始执行第一步…""已读取到附件…""裁剪复核…"）一律不写入正文——这些属于思考过程，自行省略或放进思考区；不要在正文里汇报"我调了什么工具/我发现了什么 bug/我修正了什么"——直接给用户能用的结果
- 长篇明细/完整报告 → 写文件，正文只给摘要 + OutputFile 行
- **多步任务结论必须落盘（交付物 = 文档）**：通过多步工具链产出了「完整结论/报告/分析意见」这类可保存、可转发、需存档的交付物（法律分析、调研报告、方案设计、代码审查、清单整理等）时，**必须在结束任务前**用 write_file 将完整内容落盘为 \`homework/<关键词>.md\`（文件名 1~6 个简短关键词、≤30 字符），并在正文末尾单独一行输出 \`OutputFile: homework/<文件名>.md\` 作为产物声明；正文只给精炼结论 + OutputFile 行，不重复全文。简短问答/单点答复（一句话结论即可）无需落盘
- **OutputFile 声明通用铁律（所有交付物，2026-08-30 新增）**：任何落盘到 homework/（或 attachments/）的交付物——报告、图表、**下载的图片/文件/资料**、脚本产物——都必须在正文末尾单独一行打印 \`OutputFile: homework/<路径>\`（路径无空格、文件真实存在、扩展名完整）；结束任务前自查：本轮已落盘用户要求的交付物但正文无 OutputFile 行 → 先补上再结束。禁止用"已保存到 homework""文件已下载"等无路径的模糊表述代替

⚠️ **强制结束机制（finish_task）**：
- 当你认为所有任务步骤均已完成，且已经输出了最终的答案或交付物时，**必须主动调用 \`finish_task\` 工具**来结束本次任务。
- **不要仅仅通过输出文字（如"任务完成"、"总结如下"等）来宣告结束**，系统无法识别这种纯文本信号。
- 调用 \`finish_task\` 意味着你确认任务已真正结束，没有遗漏的步骤。
- 这是一个强制性的结束仪式，请务必遵守。

⚠️ **强制建轨机制（todo_write）**：
- 对于需要多步操作的任务（如搜索后分析、读取后写入、或任何需要多次调用工具的任务），**必须在执行前先调用 \`todo_write\` 建立带状态的步骤轨**：第一次调用携带 goal + 全部步骤（status=pending），这就是你的执行计划。
- \`todo_write\` 协议：全量替换语义，每次调用携带整份最新 todos 数组覆盖旧状态，不要 diff、不要 patch。
- 每条 todo 字段：\`content\`（静态描述，始终展示）+ \`activeForm\`（动态文案，仅 in_progress 时展示，给用户"正在做 X"信号）+ \`status\`（pending/in_progress/completed/failed）。
- 状态机：pending → in_progress（开始该步）→ completed（该步成功）/ failed（该步失败）。**每个步骤边界（开始/完成/失败）都调一次 \`todo_write\` 提交全量最新快照推进状态**，一次推进 = 一次心跳，面板刷新节奏由你驱动。
- 不要用工具调用数自己推算进度——真实进度只以你 \`todo_write\` 报告的 status 为准。
- 执行过程中，如果发现计划需要调整，重新调一次 \`todo_write\` 提交更新后的步骤列表即可。
- 对于简单的、单步即可完成的问答任务（如直接回答一个事实性问题），无需调用 \`todo_write\`，直接回答即可。
- 这是一个强制性的建轨仪式，有助于确保任务有序执行，避免遗漏步骤。

⚠️ 落盘图表文件：当用户明确要求产出「可下载/可离线打开的图表文件」（图片 / 独立 HTML）时，用 execute_script 写 Python matplotlib 脚本生成并落盘（脚本 CWD 是 homework/.ai-workspace/，交付路径用 $BOB_PROJECT_HOMEWORK 拼绝对路径，见 execute_script schema）；widget 通道仅用于对话/节点内联展示，不产出文件

【技能使用机制（DSH 模式）】
- 本机技能库会以「可用技能目录」形式列在用户消息中（技能名 + 一句话用途），请留意。
- 技能需先下载才能使用：出厂默认仅系统技能（bob-ui/skill-creator/user-guide）立即可用；docx/pdf/pptx/xlsx、法律、幻灯片等技能需用户在 **设置 → 技能 → Download** 下载到本地后才进入「可用技能目录」。
- 当用户请求涉及某技能领域且该技能已在「可用技能目录」列出 → **先调用 \`load_skill("技能名")\` 加载该技能的完整操作指令，再严格按其执行**；目录中未列出的技能 = 未下载，直接引导用户去下载，不要 load_skill 不存在或未下载的技能。
- 用户已手动勾选强制注入的技能会直接给出完整指令（见「已触发技能」段落），此时不要再调用 load_skill。


对话标题（可选）：仅当本轮对话主题明确、值得命名时，在回答最末尾用以下格式补一个标题建议；简短问答/单点答复可省略。
<!-- TITLE: 简短标题（不超过20字） -->
标题应简洁概括核心主题，只放在最后这一处，正文不重复标题内容。

工具使用说明（tools 参数中的工具按需加载，只调用 tools 参数里实际存在的工具名，不要调用未列出的工具）：
- 核心常驻工具：文件/编辑（read_file、write_file、edit_code、rename_file、delete_file、list_directory、search_files）、命令/脚本（run_command、execute_script）、网页（web_search、web_fetch）、附件/材料（read_attachment、read_material）、规划/结束（todo_write、finish_task）、提问（ask_user_questions）、偏好（read_preferences）、技能（load_skill、read_skill_resource）
- 其余能力（OCR 识别、音频转写、记忆/待办/偏好写入、界面主题、Word 模板、配置/模型管理、网页浏览、企业查询、团队协作、本地软件操控等）**按需自动加载**：说出对应意图（如"识别这张扫描件""转写这段录音""查这家公司""打开这个网页"），对应工具会随本轮 tools 注入；tools 中未出现的工具不可调用，不要尝试调用不存在的工具名
- 工具参数 schema 以 tools 参数为准，不要猜测参数
- read_skill_resource 读技能资源：禁止用 read_file 直接读技能目录（会被权限门控挡掉），必须走本工具

【按需能力（工具未加载时的兜底通道）】以下能力默认不加载工具以节省上下文。当任务需要时，请**用自然语言明确说出意图**，系统会立即启用对应工具（无需你指定工具名）：
| 能力 | 触发语句示例 | 边界 |
|---|---|---|
| 网页浏览/抓取 | "打开这个网页/去这个网站/抓取页面数据" | 真实浏览器自动化，含反爬站点 |
| 企业工商查询 | "查一下这家公司的工商信息/股权结构" | 工商/股权/司法风险/招投标 |
| 多智能体团队 | "让团队协作处理/分配任务给成员" | 多成员编排，非单 Agent 可完成时用 |
| 本地软件操控 | "打开微信应用/操控本地软件" | 本地应用自动化，非网页 |
| 法律检索 | "查一下相关法条/这份合同的法律风险" | 法条检索+判例，可追溯原文 |
| 音频转写 | "转写这段录音" | 真实转写，禁止凭元数据编造 |
| 图片/PDF 文字识别 | "识别这张扫描件/图片里的文字" | 印刷体识别+手写复核 |
| 记忆/待办/偏好 | "记住这个偏好/我的待办有哪些" | 全局长期记忆+项目待办 |
| 界面主题/前端 | "按当前主题配色做一个页面" | 读取真实主题 CSS 变量 |
| 技能按需加载 | "用 slide-craft/docx 技能做 PPT" | 仅已下载技能可 load_skill；缺技能去 设置→技能→Download |
| 知识库/笔记 | "查一下笔记里的X/把这段存进知识库" | 笔记能力由「知识库（Kar）节点」专职承载，本对话不注入笔记工具 → 引导打开画布 Kar 节点，或使用 ⌘F / 微信的 /note 指令（/note check 查阅） |
若不确定是否有对应能力，可调用 \`search_capabilities\` 工具查询（该工具常驻可用）。

任务执行纪律（多步任务）：
- 执行前先建轨：多步任务先调 todo_write 建立步骤轨（见强制建轨机制），再在思考区拆解具体步骤；用户指令中的目标词（如"小红书号""账号信息"）即最终交付物，禁止漏读目标词，禁止只做字面第一步就结束
- 按步骤推进，每步完成自查是否仍朝最终目标前进；中途结果（列表页、中间截图、部分结果）只算中间态，不算完成
- **目标/交付物不明确时先澄清再开工**：指令多解、缺关键信息（如"小红书号"指账号 ID 还是账号名）→ 先提精准问题（一次 1-2 个）问清目标，按答复调整计划后执行；目标明确时 → 执行到位再收尾，未达最终交付目标前不得结束任务，也不得用"是否需要继续"之类的反问代替继续执行；执行中遇新歧义同样先问，问完调整计划继续

通用工具原则：
- **脚本化执行优先（PTC）**：当任务需要连续做多步操作时（读→处理→写、批量文件处理、多文件统计/分析、数据清洗/转换、循环/条件/管道逻辑、串联多条命令），优先用 execute_script 写一个脚本一次性完成，或用 run_command 串成一条命令链，不要一个工具一个工具地串行循环——减少工具轮次与上下文膨胀，更快更省。
  边界：① 单步简单操作（读一个文件/搜一次网/查一个目录/单次写文件）仍用对应专用工具，不强行脚本化；② 浏览器交互、附件 OCR/视觉识别、MCP 专属能力不能用脚本替代；③ 脚本 CWD 是 homework/.ai-workspace/，读写项目文件/交付物必须用 $BOB_PROJECT_HOMEWORK 拼绝对路径并打印 OutputFile: 行（见 execute_script schema），禁止相对路径；④ 触发危险命令/个人目录拦截即停止，禁止绕过；脚本超时 30s。
- 需要读文件/查目录/搜文件/执行命令/搜网/读附件时，主动调对应工具取真实数据，不猜测内容或输出
- 结果足够即答，不再多调工具；文件/附件/资料/上游节点只读一次（read_upstream_node 每节点 ≤1 次；intern_search 每祖先 ≤2 次，返回恒标 [原始对话·未认定]，引用须标 [存疑]/pending；web_search 每问题 ≤1-2 次）
- 读取项目内文件（homework/ 各产出、homework/template/ 下生成的文档）一律用 read_file（homework/ 前缀自动解析到项目根），不要用 execute_script 相对路径去读
- **工具并行化**：多个相互无依赖的工具调用（如同时检索多条法条、同时读多个文件、同时搜多个关键词）应在同一轮一次性发出多个 tool_calls 并行执行，不要串行逐个调用、每调一个就等结果再调下一个——每少一轮请求就少一次完整上下文重发，更快更省缓存。仅当后一个工具的参数依赖前一个工具的结果时才必须串行。

## 包安装指引
本机直连官方源极慢（pypi.org 约 21KB/s）。安装 Python/Node 依赖务必带镜像：
- pip：\`pip3 install <pkg> -i https://mirrors.aliyun.com/pypi/simple/\`（备用清华源 https://pypi.tuna.tsinghua.edu.cn/simple）
- npm：\`npm install <pkg> --registry=https://registry.npmmirror.com\`
- 安装 30s 无进展不要重复重试同一命令，改用镜像源重试一次；仍失败向用户说明网络限制并给替代方案。

工具边界：
- read_file/list_directory/search_files 仅限当前项目+已授权目录；禁读个人目录（桌面/文档/下载/图片等）与系统文件（~/.ssh、~/.bashrc、/etc/passwd 等）
- write_file/run_command 仅可写：homework/（含 homework/.ai-workspace/ 临时区，仅脚本与中间产物；无激活项目兜底 ~/BobWork/.sandbox）、~/BobWork/skills/、用户授权可写目录
- 最终产出默认 .md，必须 homework/ 前缀（homework/ 与 attachments/ → 项目根，不进 .ai-workspace）；.html/.docx/.pdf/.xlsx 等仅当用户明确要求；未加前缀 → 临时区，不出现在输出卡片
- 中间产物（裁剪图/切片/临时脚本/中间数据等非最终交付文件）一律写 homework/.ai-workspace/（隐藏临时区，侧边栏不显示），禁止散落到 homework/ 根或其他位置；任务完成、交付物就绪后，必须用 execute_script / run_command 清理本轮自己生成的中间产物（如 rm -rf homework/.ai-workspace/xxx），只保留最终交付物
- 产出存储位置默认 homework/，除用户明确指定外，禁止主动询问"是否可以保存到某文件夹"、禁止对写入目录发起 AUTH_REQ
- **存储平铺**：homework/ 所有产物直接落在根目录，不生成类别子文件夹；侧边栏按文件类别标签（doc/sheet/slide/pdf/image/text/code/other）分组展示
- 文件名 1~6 个简短关键词（中文或英文 kebab-case）、≤30 字符，禁完整句子/冗余词（例：homework/q3-sales-analysis.md）
- 创建技能 → ~/BobWork/skills/<技能名>/SKILL.md（自动被系统加载）
- Bob Sandbox 小程序 → bob-sandbox/apps/<appId>/（路径不加 homework/ 前缀）；改后调 capture_preview 截图核对渲染（真实 Chromium 渲染，支持 appId 预览地址），完成后提示用户左侧面板打开
- 处理文件：告知用户放入工作区 → read_file；可用 list_directory 确认存在
- 答案不在训练知识/上下文/附件 → 直接承认"不确定"/"超出能力范围"，禁止遍历本地文件找线索
- 需读项目外目录但未授权 → 回复末尾一次性列 AUTH_REQ:/完整绝对路径，每行一条（用途在正文说明）；前端会弹出授权请求卡片，用户批准后才生效；严禁逐个索要、严禁混排、严禁对超大范围（整个家目录/个人目录根/系统目录）发起
- AUTH_REQ 授权规则：用户在本轮对话中粘贴/明确给出的路径即视为用户授权，系统自动加入 AI 可读写白名单（无需再手动点授权）；对用户未给出的路径，AI 可主动发起 AUTH_REQ 请求授权（前端展示授权请求卡片，用户一键批准后才生效）；严禁声明无关目录或自动扫描到的目录
- 「找不到技能」≠「读个人目录」：技能补缺（检索/安装/自建）可自主推进；读本地文件必须用户给路径且已授权，未给路径不得猜测尝试
- 附件处理：用户附带的文件已自动复制到项目 attachments/ 目录（路径格式 attachments/{nodeId}/{文件名}），文本/图片/PDF 内容已自动解析注入——通常无需额外操作；当消息明确提示"使用 read_attachment"或需以文件路径方式深入处理附件时，直接调用 read_attachment 读取（禁止索要附件路径）；禁止询问"是否可以访问下载/文档等文件夹"、禁止对附件发起 AUTH_REQ（附件在项目内，无需任何授权）；不忽略任何附件
- 扫描件级联：印刷体（正文/证件/印章）用 ocr_document 识别（经 bob-ocr-mcp）；仅手写字段升视觉模型；不反复整页重试，改 crop_image 裁可疑区复核或标【需人工复核】
- **图片处理路由（重要，禁止绕路）**：① 提取/识别图中**文字** → ocr_document（经 bob-ocr-mcp）；② 描述**画面内容/视觉理解**（物体/场景/颜色/风格/图表数据/UI 状态/自由提问）→ 直接调用 bob-ocr-mcp 的视觉理解工具 ocr_image_understand（工具清单名，即 ocr.image_understand），只需传**原图路径** + 可选 prompt，**禁止**用 crop_image / 嵌 HTML 预览 / 浏览器截图 / 像素统计等中间步骤拼凑画面描述；③ 视觉引擎的具体型号与可用性以本轮注入的「OCR/视觉引擎现状」事实行为准，本提示词不作静态断言：事实行显示已配置 → **「OCR 未检出文字」≠「无法描述画面」**，纯照片/无文字图直接走视觉理解，不要只给像素/色温推断当画面描述，也不要引导用户去重复配置；未注入事实行 → 如实回答"当前无法确认视觉引擎状态"，禁止虚构某个型号"已配置"、也不要武断宣称"未配置"
- 音频：系统已注入转写则直接用；只有文件名/大小或"转写失败"提示时，必须调 transcribe_audio 真实转写，禁止凭元数据编造
- 引用资料（--- 引用资料列表 --- 开头的 @ 引用）→ read_material 读，每资料只读一次，不猜内容

能力缺口处理：
- 缺程序（ffmpeg/rembg 等）→ run_command 安装；缺信息 → web_search；缺专业/流程 → 先基于自身知识推理
- 推理不了 → 基于自身知识推理并如实说明能力边界；若用户明确需要某专业技能而「可用技能目录」中未列出 → 如实告知技能未下载，引导用户在 **设置 → 技能 → Download** 页自行下载/安装（或创建自定义技能存 ~/BobWork/skills/）；禁止代替用户静默安装技能
- MCP 能力缺口（主动推荐）：任务需要但本轮工具列表没有的能力，可能来自 MCP——真实浏览器自动化/调试 → bob-browser-mcp；GitHub 代码参考/仓库操作 → github；代码/框架文档 → context7；法律/法规检索 → pkulaw；企业工商查询 → tianyancha；网页搜索加速 → brave-search。当任务明显需要这类能力而对应 MCP 工具不在工具列表中（或 mcp__ 工具调用失败/返回连接错误）时：若本轮 tools 中有 check_mcp_gaps 可先调用它盘点本地 MCP 配置与连接状态（纯本地，不触网）；无论能否调用，都要如实向用户说明「缺什么能力 + 配置方法（设置 → MCP Servers）」，状态如实描述（未配置/已禁用/连接失败/缺密钥），**禁止虚构 MCP 已可用、禁止假装调用不存在的 MCP 工具**；若任务与 MCP 无关则不要调用该工具
- 用户拒绝/找不到 → 停：不反复询问、不擅自 force；如实说明能力限制，降级完成或征求同意后手写新 skill 存 ~/BobWork/skills/

互动与提问：
- 需求不明/多方案/涉偏好 → 主动提问澄清（简洁，数量受限）
- 提问必须用 ask_user_questions 工具（结构化表单，宿主弹出并回传答案），禁止用自由文本拼接提问。每次提问把问题集中放到该工具一次调用里（question/options 2-4 个/allowCustom），避免多轮打断。

--- 专业内容准确性铁律（违反将导致严重误导用户，必须严格遵守） ---

法律条文引用（恒生效；命中法律技能时，以顶部注入的更强法律约束为准）：
- 禁止编造法条、法条编号、案例号或裁判观点；引用的条文必须经 web_search 检索核实原文，查不到就明说"无法确认该法条原文"。
- 引用法条时必须核查时效性（现行有效/已修订/已废止），无法确认则标注"时效性未经核实"。

医学/健康建议：
- 禁止提供具体药物剂量、用药方案或手术建议。
- 症状描述必须注明"以下信息仅供参考，请以执业医师诊断为准"。

金融/投资建议：
- 禁止提供具体的买卖时机、价格预测或投资承诺。
- 涉及数据时必须标注来源和时间。

通用引用规则：
- 凡是引用具体数字、条文、条款、案例编号的内容，必须能够指明来源。
- 如果不确定某个事实，使用"据我了解""根据可查到的信息"等限定语，或直接说"我不确定"。
- 不要为了让回答看起来更权威而添加未经证实的细节。

音频/语音转写（违反将直接导致内容失实，必须严格遵守）：
- 绝对禁止凭文件名、大小、时长等音频元数据编造转写内容。
- 音频内容必须来自真实转写：系统注入的转写文本，或调用 transcribe_audio 工具的结果。
- 若 STT 未配置或转写失败，必须明确告知用户"无法转写该音频"并说明原因（如未配置音频转写模型、云端失败等），不得虚构转写内容。
- 法律场景（庭审录音、证词、会议纪要等）尤其禁止编造，转写文本必须可溯源。`;

/** 浏览器专精规则（2026-08-30 从 BASE_SYSTEM_PROMPT 移出）：
 *  浏览器 MCP 现按需注入（browser 场景激活才加载工具），这些规则仅对浏览器操作有意义，
 *  常驻 system 在未激活时纯浪费固定 token → 改为 browser 场景激活 / coding 节点时
 *  prependDynamicContext 注入当前轮 user 消息（不破坏 system 前缀缓存）。 */
const BROWSER_RULES = `
## 浏览器操作规则（browser 能力已激活，按此执行）
- **浏览器工具命名**：浏览器能力来自 MCP，工具列表中的完整名称均以 \`mcp__bob-browser-mcp__\` 开头（如 \`mcp__bob-browser-mcp__browser_navigate\`）。下文为行文简洁以 \`browser_*\` 简称指代，**调用时必须使用 tools 参数里的完整名称**，不要调用不带前缀的 browser_navigate 等（不存在）
- 抓取网页正文优先用 web_fetch；但访问百度百科、百度贴吧、百度知道、知乎、小红书等强反爬站点时，web_fetch 常被 403/风控拦截，此时改用浏览器工具走真实浏览器会话抓取（browser_navigate 打开页面 → browser_extract_text 提取正文 / browser_snapshot 定位元素），不要反复重试 web_fetch
- **强反爬站点定位策略（小红书/知乎/百度系等，重要）**：这类站点禁用 browser.run_js（CSP 会拦截注入）、browser.get_html 拿整页会因超大被截断。定位元素一律用 browser.snapshot：结果 truncated=true 时不要换工具，用 offset 分页继续取（offset = 上次 offset+count，ref 编号连续）；一次 snapshot 拿全目标列表后再逐个操作，禁止"每开一篇就返回列表页重新定位"造成反复往返。browser.screenshot(describe:true) 若返回明确提示"截图未翻译/视觉不可用"，立即改用 snapshot 分页或 extract_text，不要继续等描述或重复截图
- **页内多步自动化（重要）**：同一页面需连续 ≥3 步交互（多字段表单、搜索输入→提交→读结果、"展开更多"/逐页翻找）时，优先用 browser.page_script 把整串写成一次 bb.* 脚本调用（替代 N 次 navigate/click/fill 往返，也优于 run_js 单表达式硬塞）；每步自动 trace 并返回 {result, steps[], stats}。纪律：① 定位前先 bb.waitFor 确认锚点存在再 fill/click，sel 支持 snapshot ref("e12")/CSS/"text=登录"，禁止盲填盲点；② 页内导航默认拒绝，bb.goto 需 allowNav=true 且目标域已在 Net 白名单，且 goto 之后的语句不会执行——放脚本末尾或单独调用；③ 失败时按 [page_script:*] 报错附带的 last steps 精准修改脚本重试，勿整段推倒重写；④ 默认预算 20s/40 ops/返回超 6 万字符截断，可按需上调 timeoutMs/maxOps/maxReturnChars；⑤ 报 [page_script:inject] 类失败说明该站不适合脚本注入，退回 snapshot 定位 + click/fill 路线
- **凭据红线**：禁止用 page_script / run_js / get_html 读取或回显密码、验证码等敏感输入框的值；账号登录一律走 browser.login 应用内弹窗
- **长文分页续读纪律（重要）**：browser.read_article（readability 抽取）与 browser.extract_text（innerText 抽取）是两套算法，同一 URL 的 totalChars/chars 口径不同、offset 互不兼容。续读长文必须回到**同一个工具**，用它自己上一次返回的 offset / 末尾"[chars X/Y — call again with offset=Z]"标记的建议值继续分片；禁止把一个工具的字数当另一个工具的翻页锚点，禁止对空结果反复重试同一 offset；到达 EOF 或需要完整原文时改用 web_fetch / read_pdf 拿全文
- 浏览器工具（browser_*）遇 navigate 报 CDP 超时、标签页受限不可附加、extract/get_html 报 "no tab is attached" 或 native read failed 时，**直接带 useNewTab: true 重试**（新开标签页），不要先查标签页状态再重试、不要臆测「浏览器被占用/用户正在浏览」而放弃或空等子节点；连续两次仍失败才换 web_fetch 或其他方案
- **登录墙处理（重要，禁止绕路）**：浏览器操作遇登录墙（browser.detect_login 返回 needsLogin=true、页面提示"登录后查看"/登录弹窗、或访问受限）时，**必须立即调用 browser.login 发起登录**——BobWork 会在应用内弹出登录窗，用户输入账号密码后系统自动代填提交。**禁止**停下来请求用户手动登录、**禁止**断言"自动登录不可用/扩展版本过旧/组件缺失"、**禁止**跳过登录墙直接放弃。登录完成后继续原任务
- 列表页批量抓取（搜索结果/笔记列表/目录等）：先一次性收集全部目标条目（snapshot 分页拿完所有卡片与链接），再逐个 navigate 打开；取链接阶段优先区分图文 vs 视频类条目，先读图文详情，视频条目仅在必要时读评论区
`;

/** 报告插图约定（2026-08-30 从 BASE_SYSTEM_PROMPT 移出）：
 *  仅生成报告/调研/分析类交付物时需要，常驻 system 纯浪费固定 token →
 *  报告意图（detectSceneHints 命中 report 信号词）时 prependDynamicContext 注入当前轮 user 消息。 */
const REPORT_RULES = `
## 报告插图约定（自动配图 + 禁止询问路径）
- **配图由你根据报告内容自动判断，无需用户点名**：报告含数据趋势/对比/占比/流程/结构等适合可视化的内容时，自动生成图表插图（widget 仅对话内联展示，落盘插图用 matplotlib/脚本）；纯文字叙事报告不强配图；用户明确要求"带图/配图"时必配
- **带插图的报告以文件夹形式交付**：报告文件与插图同放 \`homework/<报告名>/\` 目录下（如 \`homework/市场分析/报告.md\` + \`homework/市场分析/图1.png\`），正文末尾输出 \`OutputFile: homework/<报告名>/报告.md\`；无插图的报告平铺为 \`homework/<关键词>.md\`
- 报告内引用插图一律用**相对路径**：\`![图1](图1.png)\`（同目录）或 \`images/图1.png\`
- 图表类插图：execute_script 用 matplotlib 落盘到 \`$BOB_PROJECT_HOMEWORK/<报告名>/\` 下，与报告同目录（先建目录再写文件）；用户附件插图经 read_attachment 读取后复制到报告文件夹再引用，或直接引用 \`../attachments/{nodeId}/{文件名}\`
- **插图保存/引用路径由你自动决定，禁止向用户询问"图片保存路径"**；插图无来源（无附件且非图表类）时如实告知"对话节点不生成照片/实拍图"，不得用占位图或编造路径
`;

// （K2-S1 工具面 service 抽取，行为不变：确定性排序 buildAndSortToolDefs（P4 + 来源分组，
//  MCP 段按 settings serverId 分组）与 CacheGuard 守卫随迁 src/lib/runtime/tools.ts，
//  由 ToolRuntime.assemble 统一调用——首轮初始化与场景中途激活重建共用同一排序管线。）

/** 提取最后一条用户消息的纯文本内容 */
function extractLastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content || '';
    }
  }
  return '';
}

/** 普通对话已激活场景的会话内 sticky（key=nodeId；无 nodeId 不持久化，仅当轮生效）。
 *  目的：场景一旦激活即在该会话内保持，避免"每轮按意图变化"导致工具集在轮次间抖动——
 *  工具前缀只在首次激活时变化一次，之后逐轮字节稳定 → 前缀缓存命中率最大化。
 *  K2-S2 会话态 service，行为不变：本 module 级 Map 已收敛为 SessionRuntime 单例
 *  （src/lib/runtime/session.ts，保留跨请求全局态），读写点改走 sessionRuntime。 */

/**
 * L2 动态意图检测：从最后一条用户消息提取场景关键词（含附件类型），返回命中场景集合（不含 general）。
 * 命中场景对应的 ondemand 工具（见 tools.ts SCENED_TOOLS / BUILTIN_LAYER）本轮才注入；
 * 未涉及该场景则专属工具对模型不可见，避免误调用 + 省上下文固定税。
 */
export function detectSceneHints(text: string): Set<ToolScene> {
  const scenes = new Set<ToolScene>();
  if (!text) return scenes;
  // wanted：记忆/待办/偏好/工作报告/日历（含复盘/习惯/计划等高频信号词）
  if (/wanted|记忆|待办|偏好|工作报告|日历|记住|查询|复盘|习惯|总结|计划|安排|清单|收藏|备忘|遗忘|便签|todo|notebook|preference|work.?report|calendar|reminder|daily.?report/i.test(text)) {
    scenes.add('wanted');
  }
  // legal：法律场景（含协议/起草/拟定等高频触发词，及刑事法核心术语）
  // 补执行/金钱债务领域词（执行款清偿顺序、先本后息/先息后本、加倍迟延履行利息等提问
  // 不含"法条/法律"字样，缺词会导致 legal 场景不激活 → 北大法宝 pkulaw MCP 不注入 → 模型只能用 web_search 兜底）
  if (/法条|文书|判决|合同|协议|诉讼|律师|法律|庭审|案由|罪名|法规|司法解释|起草|拟定|起诉状|答辩状|申请书|委托书|诈骗|犯罪|被害人|共犯|刑事|量刑|定罪|判刑|主犯|从犯|胁从犯|自首|立功|缓刑|拘役|有期徒刑|追诉|侦查|起诉|审判|执行款|执行程序|强制执行|被执行人|迟延履行|加倍部分|加倍迟延|清偿|抵充|本金|利息|债权|生效法律文书|债务/i.test(text)) {
    scenes.add('legal');
  }
  // audio：音频转写（关键词或音频附件）
  // 附件路径可能含空格/中文目录（如 attachments/8ec9_AI Chat/录音.m4a），
  // 不能限定 [^\s)，否则空格后匹配中断 → 场景不激活 → 音频工具不注入。
  if (/转写|录音|语音|音频|字幕|听写|转录|transcrib|庭审.*(录音|语音)|会议.*(纪要|录音)/i.test(text) ||
      /路径:\s*(?:attachments|assets)\/[^\n"']+\.(?:mp3|wav|m4a|aac|ogg|flac|opus|amr)\b/i.test(text)) {
    scenes.add('audio');
  }
  // skill：技能检索/安装
  if (/技能|能力缺口|skill|安装技能|技能库|skill registry|找.*技能/i.test(text)) {
    scenes.add('skill');
  }
  // coding：Agent 造包（子 agent/子助手/专职角色/agent 包）——无沙盒的 coding 会话也能激活
  // create_agent_package 场景，让「＋ → AI Coding → 创建子 Agent」表单预填的首轮消息可用该工具
  if (/create_agent_package|sub.?agent|子agent|子.?.agent|创建.{0,8}(专职助手|专属助手|子助手)|做一个.{0,8}(agent|子代理)/i.test(text)) {
    scenes.add('coding');
  }
  // design：主题/前端界面（coding 节点已在 L1 放行，此处覆盖普通对话）
  if (/主题|配色|颜色|前端|网页|网站|页面|界面|小程序|ui|设计风格|美化|风格|视觉|色值/i.test(text)) {
    scenes.add('design');
  }
  // ocr：图片/PDF 文字识别（关键词或图片/PDF 附件）
  // 附件路径可能含空格/中文目录（如 attachments/8ec9_AI Chat/小狗.png），
  // 不能限定 [^\s)，否则空格后匹配中断 → ocr 场景不激活 → 视觉/OCR 工具不注入。
  if (/扫描|识别.*(文字|图片|图像)|ocr|截图.*文字|提取.*(文字|图片).*字|转文字|文字识别|图片.*字|票据|证件|票据识别/i.test(text) ||
      /路径:\s*(?:attachments|assets)\/[^\n"']+\.(?:png|jpe?g|gif|webp|pdf)\b/i.test(text)) {
    scenes.add('ocr');
  }
  // office：Word 模板批量填充/占位符扫描（文档/模板意图；与 legal 的"模板"词可同时激活）
  if (/word|docx|模板|文档模板|合同模板|批量.*(填写|填充|生成)|jinja|占位符|扫描.*模板|套用.*模板/i.test(text)) {
    scenes.add('office');
  }
  // admin：配置/模型/沙盒运维（低频管理操作，用户明确提及才激活）
  if (/配置|设置|api.?key|provider|图标|回滚|导出.*(应用|沙盒)|管理.*(mcp|服务器)|mcp.*(增删改|管理|检查)|测试.*连接|连接测试|列出.*模型|修改.*(模型|配置)|应用配置|查.*配置|模型池/i.test(text)) {
    scenes.add('admin');
  }
  // browser：网页浏览/抓取/浏览器操作（bob-browser-mcp，61 工具 ≈ 1.8 万 token，最大 MCP 开销）
  // 注意与 design 的"网页/网站/页面"词重叠：做网页任务确实可能需要浏览器测试，双激活无害
  if (/浏览器|网页|网址|网站|打开.*(页面|链接)|https?:\/\/|抓取|爬取|浏览.*(页面|网站)|页面.*内容|在线.*(查看|预览)|访问.*网站|看.*(页面|网页)/i.test(text)) {
    scenes.add('browser');
  }
  // company：企业/工商信息查询（tianyancha）——"公司"不带查询动词不触发，避免"公司介绍"类误激活；
  // 补充"信用代码"（覆盖"社会信用代码/统一社会信用代码"这类高频公司查询意图，如"XX公司的社会信用代码"无需"查/工商"动词）
  if (/查.*(企业|公司|工商)|工商|法定代表人|股权|股东|天眼查|企业信息|注册资本|经营范围|企业.*(详情|资料|报告)|公司.*(背景|注册|资质)|信用代码/i.test(text)) {
    scenes.add('company');
  }
  // team：多智能体团队协作（Agent Teams）
  if (/团队|协作|分工|分配.*(任务|成员)|组队|multi.?agent|多.?智能体|多人协作/i.test(text)) {
    scenes.add('team');
  }
  // local：本地软件操控（bobby）——"应用"单独不触发；"打开"后跟应用名（如"打开微信应用"）也算
  if (/操控|打开.{0,6}?(?:应用|软件|程序|\bapp\b)|本地软件|自动化.*(应用|软件)|bobby|控制.*(应用|软件|mac)|操作.*(应用|软件)|启动.*(应用|软件)/i.test(text)) {
    scenes.add('local');
  }
  return scenes;
}

/** search_capabilities 能力目录条目 */
interface CapabilityEntry {
  scene: ToolScene;
  name: string;
  keywords: string[];
  description: string;
  triggerPhrase: string;
}

/** 按需能力目录（search_capabilities 的检索源；与 detectSceneHints / MCP_SERVER_SCENES 场景对齐） */
const CAPABILITY_CATALOG: CapabilityEntry[] = [
  { scene: 'browser', name: '网页浏览/抓取', keywords: ['网页', '浏览器', '抓取', '爬取', '网站', '网址', '链接', '反爬', '页面', '上网'], description: '真实浏览器自动化（含反爬站点）：打开网页、提取正文、截图、填表、登录', triggerPhrase: '"打开这个网页" / "抓取页面数据"' },
  { scene: 'company', name: '企业工商查询', keywords: ['企业', '公司', '工商', '股权', '股东', '天眼查', '注册资本', '法定代表人', '招投标', '工商信息', '信用代码', '社会信用代码'], description: '工商信息、股权结构、司法风险、招投标', triggerPhrase: '"查一下这家公司的工商信息"' },
  { scene: 'team', name: '多智能体团队', keywords: ['团队', '协作', '分工', '分配', '组队', '多智能体', 'multi-agent', '多人'], description: '多成员编排，分配任务并行执行', triggerPhrase: '"让团队协作处理"' },
  { scene: 'local', name: '本地软件操控', keywords: ['本地', '软件', '应用', '操控', '自动化', 'mac', '打开应用'], description: '本地应用自动化控制', triggerPhrase: '"打开微信应用"' },
  { scene: 'legal', name: '法律检索/咨询', keywords: ['法律', '法条', '合同', '诉讼', '律师', '法规', '判例', '文书', '起诉', '司法', '执行', '清偿', '本金', '利息', '债权', '迟延履行', '加倍', '抵充'], description: '法条检索、判例查询、文书起草（含防幻觉约束）', triggerPhrase: '"查一下相关法条"' },
  { scene: 'audio', name: '音频转写', keywords: ['音频', '录音', '转写', '语音', '字幕', '听写'], description: '真实音频转写，禁止凭元数据编造', triggerPhrase: '"转写这段录音"' },
  { scene: 'ocr', name: '图片/PDF 文字识别', keywords: ['识别', '扫描', 'ocr', '图片文字', 'pdf文字', '票据', '证件', '文字识别'], description: '印刷体识别 + 手写复核', triggerPhrase: '"识别这张扫描件"' },
  { scene: 'wanted', name: '记忆/待办/偏好', keywords: ['记忆', '待办', '偏好', '笔记', '日历', '提醒', '便签', '收藏', '备忘'], description: '全局长期记忆、项目待办、用户偏好', triggerPhrase: '"记住这个偏好"' },
  { scene: 'design', name: '界面主题/前端', keywords: ['主题', '配色', '前端', '界面', 'ui', '美化', '网页', '页面'], description: '读取真实主题 CSS 变量，前端/页面生成', triggerPhrase: '"按当前主题配色做页面"' },
  { scene: 'skill', name: '技能检索/安装', keywords: ['技能', 'skill', '安装技能', '能力缺口', '技能库'], description: '受控技能库检索与安装', triggerPhrase: '"有没有能做 PPT 的技能"' },
  { scene: 'office', name: 'Word 模板', keywords: ['word', 'docx', '模板', '文档模板', '占位符', '合同模板'], description: 'Word 模板批量填充/占位符扫描', triggerPhrase: '"批量填写 Word 模板"' },
  { scene: 'admin', name: '配置/模型管理', keywords: ['配置', 'api key', '模型', 'provider', 'mcp', '连接测试', '图标', '快捷入口', '快捷按钮', '⌘f', 'cmd+f', 'command+f'], description: '模型/MCP/应用配置管理', triggerPhrase: '"帮我配置模型"' },
];

/** 按 query 匹配能力目录（任一 keyword 命中即算；返回空 = 未匹配） */
export function matchCapabilities(query: string): CapabilityEntry[] {
  if (!query) return [];
  const q = query.toLowerCase();
  return CAPABILITY_CATALOG.filter((c) => c.keywords.some((k) => q.includes(k.toLowerCase())));
}

/** 构造 search_capabilities 的 tool_result 文本：匹配项 + 激活说明 */
function buildCapabilityResultText(query: string, matched: CapabilityEntry[], newlyActivated: ToolScene[]): string {
  if (matched.length === 0) {
    return (
      `未在能力目录中找到匹配「${query}」的能力。可用能力：网页浏览/抓取、企业工商查询、多智能体团队、本地软件操控、` +
      `法律检索、音频转写、图片/PDF 文字识别、记忆/待办/偏好、界面主题/前端、技能检索/安装、Word 模板、配置/模型管理。` +
      `请尝试用更明确的意图短语描述（如"查企业""转写音频""识别扫描件"）。`
    );
  }
  const activatedList = newlyActivated.length > 0
    ? `，本轮已激活: ${newlyActivated.join(', ')}`
    : '（已在可用状态）';
  const lines = matched.map(
    (c) => `- ${c.name}：${c.description}。触发语句示例：${c.triggerPhrase}`,
  );
  return `能力目录匹配「${query}」${activatedList}：\n${lines.join('\n')}\n\n` +
    `已激活的能力其对应工具会在**下一个工具回合**立即注入（本轮剩余的工具调用序列请立即结束）。` +
    `**禁止**继续用 web_search / web_fetch 等网页方式兜底查询（反爬会拦截且查不到结构化工商/企业数据）——` +
    `请结束本轮工具调用，等待工具就绪后直接调用对应工具完成查询。`;
}

/** 法律技能名称集合 */
const LEGAL_SKILL_NAMES = new Set(['intern-lawyer', 'legal-drafter', 'legal-statute-search']);

// ── P4a 三段化骨架：首批宿主接管注册（scenario_activate，行为与迁移前的 if-else 判定一致）──
// 判定顺序 = 注册顺序（takeoverFor 同 priority 保持注册序）：
//   · search_capabilities：pre-execute 全接管（执行前咨询、命中即替代 executeTool），先判定；
//   · load_skill 法律联动：post-execute 联动（工具执行成功后咨询），后判定。
// 场景激活 / sticky / needRebuildTools 由 pipeline 统一执行（applyScenarioActivation）。
registerTakeover({
  kind: 'scenario_activate',
  phase: 'pre',
  name: 'search_capabilities',
  // 能力目录检索：命中的场景交 pipeline 去重激活 + sticky + 触发重建；
  // meta 携带匹配条目（含已激活的）供宿主编排能力清单文本（buildCapabilityResultText）。
  handleScenario(name, args) {
    const query = String(args?.query ?? '');
    const matched = matchCapabilities(query);
    return { scenes: matched.map((c) => c.scene), sticky: true, meta: { matched } };
  },
});
registerTakeover({
  kind: 'scenario_activate',
  phase: 'post',
  name: 'load_skill',
  // 法律技能加载成功 → 激活 legal 场景（pkulaw 工具随工具集重建注入可见）；
  // 技能名不在法律名单返回 null（不接管）。"成功"由宿主在 post 咨询点保证（仅 execResult.success 时咨询）。
  handleScenario(name, args) {
    let skillName = '';
    try {
      skillName = String(args?.skill_name ?? '').trim();
    } catch {
      /* 参数异常则不激活（与原 if 分支同语义） */
    }
    if (!skillName || !LEGAL_SKILL_NAMES.has(skillName)) return null;
    return {
      scenes: ['legal'],
      sticky: true,
      hint: '[宿主提示] 已自动激活法律场景(legal)：北大法宝 pkulaw MCP 法条/案例检索工具已加入可用工具集，法条原文、时效性、裁判规则核对请优先使用 mcp__pkulaw__* 工具（结果自带 pkulaw.com 原文链接），仅在 pkulaw 不可用时才用 web_search/web_fetch 降级。',
    };
  },
});

// ── P4a-2a 迁移：节点参数注入 + 执行结果压缩 收敛为注册式接管（tool-pipeline.ts，行为不变）──
//   · args_transform（phase: pre，match 文件/沙箱工具名单）：exec 前把 current_node_id /
//     node_sandbox_app_id 注入执行参数字符串 —— 名单判定与注入规则在本注册内，请求作用域值
//     （nodeId / toolLoopSandboxAppId）由宿主在咨询点经 ctx 传入；JSON 解析/回写失败返回
//     null = 原样执行（与原 if 内联 try/catch 同语义）。
//   · result_compact（phase: post，通用变换，match 全量工具）：结果写入对话历史前压缩 —— 仅
//     文本超阈值时保头保尾压缩（阈值/文案沿用 compactToolResult，含 LIST_LIKE_TOOLS 区分）；
//     compacted 由宿主发 SSE tool_compact 帧 + 压缩日志。
//     注册序须保持在 load_skill 之后：load_skill 亦为 post 场景激活条目，route 的 post 咨询点
//     用 takeoverFor（按 name+phase、不分 kind，首个命中即返回），对 load_skill 须仍先命中
//     场景激活条目，故本条目不得排在其前（其余工具无 post 场景激活条目，无影响）。
/** 节点参数自动注入名单：intern_search 需 current_node_id 做祖先链校验；read_file/write_file/
 *  rename_file/delete_file 需 current_node_id 做 homework/ 文件归属隔离与 .ownership.json 清册
 *  维护；execute_script/run_command 需 current_node_id 注入 BOB_NODE_HOMEWORK 产出目录。 */
const NODE_PARAM_INJECT_TOOLS = new Set([
  'intern_search',
  'read_file',
  'write_file',
  'rename_file',
  'delete_file',
  'list_directory',
  'execute_script',
  'run_command',
  'ocr_document',
  'crop_image',
]);
registerTakeover({
  kind: 'args_transform',
  phase: 'pre',
  name: '__node_param_inject__',
  match: (name) => NODE_PARAM_INJECT_TOOLS.has(name),
  transformArgs(name, args, ctx) {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      parsed.current_node_id = ctx.currentNodeId;
      // Coding 节点标识：工具据此强制所有写操作落 bob-sandbox/apps/<appId>/（不落 homework）
      if (ctx.sandboxAppId) parsed.node_sandbox_app_id = ctx.sandboxAppId;
      return JSON.stringify(parsed);
    } catch {
      // 参数解析/回写失败时原样传递（与原 if 内联 try/catch 一致）
      return null;
    }
  },
});
registerTakeover({
  kind: 'result_compact',
  phase: 'post',
  name: '__result_compact__', // 通用变换：命中全部工具；仅超阈值结果才实际压缩（compactToolResult 判定）
  match: () => true,
  compactResult(name, result) {
    return compactToolResult(result, name);
  },
});

// ── P4a-3-1 迁移 ask_user_questions，行为不变 ──
// 挂起型（host-pending）接管首类：模型调用 ask_user_questions → 立即推 questions_request 弹窗挂起
// 等待用户 answers 回传（POST /api/chat/questions 独立恢复端点，跨请求内存挂起），再把 answers 作为
// tool_result 回灌模型继续生成。与 scenario_activate 等模块级纯函数接管不同：需要 send(SSE) /
// pending 容器 / 心跳 / 回灌 / 循环 continue → handler 经 ctx（HostTakeoverContext，宿主在 handle()
// 调用点注入最小服务面）完成全部副作用；本注册为模块级单次、不持 route 闭包（多请求并发安全）。
// 行为等价：questions_request 载荷字段 / 20s tool_call_update(running) 心跳时序 / answers 回灌文本 /
// eventLog·tool_result·遥测 / 循环 continue 语义逐位一致（原 if 分支体见 git 历史 3812-3878）。
// planner_confirm / tool_confirm / login / grant 后续复用同一 host-pending 形态（各自注册新 kind）。
async function handleAskUserQuestions(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① 归一化 questions（与原 if 内联同语义：结构异常元素兜底为自增 id / 空问题 / 空选项 / allowCustom 默认开）
  const pendingQuestions: PendingQuestionItem[] = (
    Array.isArray(ctx.args.questions) ? ctx.args.questions : []
  ).map((q, i) => {
    const item = (q ?? {}) as Record<string, unknown>;
    return {
      id: String(item.id ?? `q${i + 1}`),
      question: String(item.question ?? ''),
      options: Array.isArray(item.options) ? item.options.map(String) : [],
      allowCustom: item.allowCustom !== false,
    };
  });
  // ② 登记挂起项 + SSE questions_request（载荷字段与原分支一致：requestId / questions / timeoutSec）
  const { requestId, promise, getSupplement } = createPendingQuestions(pendingQuestions, ctx.nodeId);
  ctx.send({
    questions_request: {
      requestId,
      questions: pendingQuestions,
      timeoutSec: Math.ceil(QUESTIONS_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  // ③ 等待用户提交期间 SSE 无数据，会被前端 90s 空闲超时误杀；每 20s 发一条
  //    tool_call_update(running) 心跳保持连接（前端对重复 running 幂等）。
  const qKeepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let answers: PendingAnswerEntry[] | null;
  try {
    answers = await promise; // 前端弹窗提交回传；超时/关闭为 null
  } finally {
    clearInterval(qKeepalive);
  }
  // ④ 组织回灌文本（answers + 补充说明；未回答走降级文案，与原分支逐字一致）
  const supplement = getSupplement();
  const answersText = answers && answers.length > 0
    ? `用户对你提出的问题逐一答复如下（problem/question 为其原问题，answer 为用户选择或填写的答复）：\n${JSON.stringify(answers, null, 2)}${supplement ? `\n\n用户补充说明：${supplement}` : ''}`
    : '用户未回答你的提问（弹窗被跳过或超时）。请基于已有信息继续，必要时简要说明缺失的信息。';
  // ⑤ SSE tool_result（done 成功回灌，span 轨迹字段与原分支一致）+ 结果落账（顺序与原分支一致）
  ctx.send({
    tool_result: {
      name: ctx.name,
      result: answersText,
      durationMs: 0,
      success: true,
      phase: 'done',
      spanId: ctx.spanId,
      startAt: ctx.startAt,
      endAt: Date.now(),
    },
    nodeId: ctx.nodeId,
  });
  ctx.commitToolResult(answersText);
  // ⑥ 该工具已由宿主处理 → 宿主据此 continue（跳过下方通用执行逻辑）
  return 'handled_continue';
}
registerHostTakeover({
  kind: 'ask_user',
  phase: 'pre',
  name: 'ask_user_questions',
  handle: handleAskUserQuestions,
});

// ── P4a-3-2 迁移 tool_confirm（需手动确认名单通用确认），行为不变 ──
// P4b-1 追加：本 handler 名单判定后接入审批策略层（decideToolApproval，approval.ts）——默认
// allow_scope 档与迁移前逐位一致（名单内 request、名单外 noop 放行）；ask/never 为新档位（默认
// 不启用，经 settings.approval.defaultStrategy 开启、route 咨询点注入 ctx.approvalStrategy）。
// 挂起型第二类：模型调用「需手动确认名单」内工具 → 立即推 tool_confirm 弹窗挂起，等待用户确认
// （POST /api/chat/confirm 恢复端点，跨请求内存挂起；超时 = timeout ≠ 用户拒绝）。与 ask_user 同
// host-pending 形态：send / 挂起容器 / 20s 心跳 / 回灌 / 循环 continue 均经 ctx 服务面完成；本注册
// 模块级单条、不持 route 闭包。与 ask_user 的差异：判定名单（confirmTools）是运行期配置、无法绑定
// 固定工具名 → 注册条目 match 恒 true（工具名恒咨询），名单与身份由宿主在咨询点经 ctx 注入，handler
// 内判定：名单外 / planner 结构化卡片已覆盖（identity==='planner' 且属 PLANNER_CARD_TOOLS）→ 'noop'
// 照常通用执行。咨询点物理位置保持在 planner 卡片段之后（route 工具轮 ①.4 之后原 if 位置，见
// handleAskUserQuestions 上方同轮咨询点），planner 先判的顺序约束由宿主保证。
// 行为等价：tool_confirm 载荷字段（confirmId/name/arguments/timeoutSec）/ 心跳时序 / denied·timeout
// 区分措辞 / tool_result(error)·落账三连 / 循环 continue 语义逐位一致（原 if 分支体见 git 历史
// 4045-4106）；approved 不回灌编辑参数 → 'handled_fallback' 回落本轮通用执行（与迁移前一致：前端
// 通用确认只回传 approved，服务端原样忽略 edited，args 不覆盖）。
async function handleToolConfirm(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① P4b-1 名单判定 + 审批策略裁决（默认档与迁移前 if 条件逐位一致：名单内 且 未被 planner
  //    结构化卡片覆盖才弹通用确认、名单外一律 'noop' 放行）。顺序约束：
  //      a) planner 结构化卡覆盖最先判定并 'noop' 保留 —— planner 卡（用户可见可编辑确认 UI）视为
  //         强于 confirm 的人工审批，任何 strategy 均不拦截（见 approval.ts 文件头边界说明）；
  //      b) 其余工具走 decideToolApproval（纯函数，approval.ts）：'request' → 原挂起确认流程
  //         （② 起不变）；'allow' → 'noop' 通用执行（同现状名单外，allow_scope 下不 consult 写类）；
  //         'deny'（仅 never 档，名单内或写类）→ SSE tool_result(error) + 落账 + 'handled_continue'。
  //    ctx.approvalStrategy 未注入（undefined）= 兜底 'allow_scope'（向后兼容，行为同现网）。
  const confirmTools = ctx.confirmTools ?? [];
  const usesPlannerCard = ctx.identity === 'planner' && PLANNER_CARD_TOOLS.has(ctx.name);
  if (usesPlannerCard) return 'noop';
  const approvalStrategy = ctx.approvalStrategy ?? 'allow_scope';
  const approval = decideToolApproval({
    name: ctx.name,
    inConfirmList: confirmTools.includes(ctx.name),
    strategy: approvalStrategy,
  });
  if (approval === 'allow') return 'noop';
  if (approval === 'deny') {
    // never 档：名单内或写类工具一律拒绝执行（读类已在 decideToolApproval 判 'allow'，不会到达此处）
    const deniedResult =
      `该工具调用被当前审批策略（never）拦截：写类工具及「需手动确认名单」内工具在 never 策略下` +
      `默认不允许执行，本次调用未执行。请停止涉及该工具的操作，如实向用户说明该工具尚未执行，` +
      `并征询其意见（如确认需要，可在设置中将审批策略切回 allow_scope/ask 后重试）。`;
    ctx.send({
      tool_result: {
        name: ctx.name,
        result: deniedResult,
        durationMs: 0,
        success: false,
        phase: 'error',
        spanId: ctx.spanId,
        startAt: ctx.startAt,
        endAt: Date.now(),
      },
      nodeId: ctx.nodeId,
    });
    ctx.commitToolError?.(deniedResult);
    return 'handled_continue';
  }
  // approval === 'request' → 原挂起确认流程（与迁移前逐位一致）：
  // ② 登记挂起项 + SSE tool_confirm（载荷字段与原分支一致：confirmId/name/arguments/timeoutSec；
  //    arguments 用已解析参数对象，挂起登记用原始参数字符串 ctx.execArgs）
  const { confirmId, promise } = createPendingConfirm(ctx.name, ctx.execArgs ?? '', ctx.nodeId);
  ctx.send({
    tool_confirm: {
      confirmId,
      name: ctx.name,
      arguments: ctx.args,
      timeoutSec: Math.ceil(CONFIRM_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  // ③ 等待确认期间 SSE 无数据，会被前端 90s 空闲超时误杀；每 20s 发一条
  //    tool_call_update(running) 心跳保持连接（前端对重复 running 幂等）。
  const confirmKeepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let confirmRes: ConfirmResult;
  try {
    confirmRes = await promise; // 前端弹窗确认回传；超时记为 timeout（≠ 用户拒绝）
  } finally {
    clearInterval(confirmKeepalive);
  }
  // ④ verdict 三分：approved → 'handled_fallback' 回落本轮通用执行路径（args 原样，executeTool
  //    真正执行 + 成功落账在通用路径完成，与迁移前一致）；denied/timeout → SSE tool_result(error、
  //    措辞区分「明确拒绝」与「超时未操作」) + 落账三连 + 'handled_continue'（宿主 continue 跳过通用执行）。
  if (confirmRes.verdict === 'approved') return 'handled_fallback';
  const deniedResult =
    confirmRes.verdict === 'timeout'
      ? `该工具调用因等待确认超时（${Math.ceil(CONFIRM_TIMEOUT_MS / 60_000)} 分钟内未收到你的确认）而自动跳过，并非用户拒绝执行。请如实向用户说明该工具尚未执行，并询问是否继续执行。`
      : '用户拒绝了该工具的调用（该工具在「需手动确认名单」中，未获用户确认即不执行）。请停止涉及该工具的操作，向用户说明情况并征询其意见。';
  ctx.send({
    tool_result: {
      name: ctx.name,
      result: deniedResult,
      durationMs: 0,
      success: false,
      phase: 'error',
      spanId: ctx.spanId,
      startAt: ctx.startAt,
      endAt: Date.now(),
    },
    nodeId: ctx.nodeId,
  });
  ctx.commitToolError?.(deniedResult);
  return 'handled_continue';
}
registerHostTakeover({
  kind: 'tool_confirm',
  phase: 'pre',
  name: '*', // 名单是运行期配置（不绑定固定工具名）→ 恒咨询，名单判定在 handler 内（ctx.confirmTools）
  match: () => true,
  handle: handleToolConfirm,
});

// ── P4a-3-3 迁移 planner 卡片，行为不变 ──
// 挂起型第三类：planner 专属节点（identity==='planner'）的排程 创建/改/删（PLANNER_CARD_TOOLS =
// create_scheduled_todo / todo_update / todo_delete）→ 先弹结构化可编辑确认卡片（buildPlannerCard
// 预填字段 + 冲突提示），用户可改字段后确认才真正执行；拒绝/超时按未执行处理。与 tool_confirm 同
// host-pending 形态（send / createPendingConfirm 挂起容器 / 20s 心跳 / 回灌 / 循环 continue 均经
// ctx 服务面完成）；本注册模块级单条、不持 route 闭包。与 tool_confirm 的差异：approved 后用户
// 编辑过的参数（edited.toolArgs）要覆盖本轮执行参数 —— ctx.setExecArgs 写回通道由宿主注入
// （route 闭包内 let parsedArgs/execArgs），handler 据此把新参数交给宿主回落通用执行时生效。
// 判定：非 planner 身份 / 工具不在 PLANNER_CARD_TOOLS / 卡片构建失败（无 event 等）→ 'noop' 交还
// 宿主走 tool_confirm/通用执行（与迁移前 if(card) 不进入同语义）。咨询点物理位置保持在 tool_confirm
// 之前（route 工具轮 ①.4 原 if 位置），planner 先判的顺序约束由宿主保证。
// 行为等价：planner_confirm 载荷字段（confirmId/name/card/timeoutSec，card 即 buildPlannerCard 产出）
// / 心跳时序 / denied·timeout 区分措辞 / tool_result(error)·落账三连 / 循环 continue 语义 /
// approved+edited.toolArgs 覆盖路径逐位一致（原 if 分支体见 git 历史 4049-4116）。
async function handlePlannerCard(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① 身份 + 工具名单判定（与迁移前 if 条件逐位一致：planner 专属节点的排程 创建/改/删 才走卡片）
  if (ctx.identity !== 'planner' || !PLANNER_CARD_TOOLS.has(ctx.name)) return 'noop';
  // ② 卡片构建（buildPlannerCard：create 由参数预填；update/delete 拉库内事件行 + 冲突提示）；
  //    构建失败（缺 event_id / 库内无此事件 / 异常）→ 不弹卡，交还宿主（noop）走下方 tool_confirm
  //    consult —— 与迁移前 if(card) 不进入、随后 tool_confirm 的 usesPlannerCard 覆盖判定等价。
  const card = await buildPlannerCard(ctx.name, ctx.args);
  if (!card) return 'noop';
  // ③ 登记挂起项 + SSE planner_confirm（载荷字段与原分支一致：confirmId/name/card/timeoutSec）
  const { confirmId, promise } = createPendingConfirm(ctx.name, ctx.execArgs ?? '', ctx.nodeId);
  ctx.send({
    planner_confirm: {
      confirmId,
      name: ctx.name,
      card,
      timeoutSec: Math.ceil(CONFIRM_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  // ④ 等待确认期间 SSE 无数据，会被前端 90s 空闲超时误杀；每 20s 发一条
  //    tool_call_update(running) 心跳保持连接（前端对重复 running 幂等）。
  const cardKeepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let cardRes: ConfirmResult;
  try {
    cardRes = await promise; // 前端卡片确认/拒绝回传；超时记为 timeout（≠ 用户拒绝）
  } finally {
    clearInterval(cardKeepalive);
  }
  // ⑤ verdict 三分：
  //    - denied/timeout → SSE tool_result(error、措辞区分「明确拒绝」与「超时未操作」) + 落账三连
  //      + 'handled_continue'（宿主 continue 跳过通用执行，与迁移前分支 continue 一致）；
  //    - approved → 用户可能编辑过卡片 → 经 setExecArgs 用 edited.toolArgs 覆盖执行参数（对象判
  //      定与迁移前 4110-4114 逐位一致：toolArgs truthy 且 typeof object 才覆盖），随后
  //      'handled_fallback' 回落宿主通用执行（宿主用覆盖后 args 真正执行 + 成功落账在通用路径完成）。
  if (cardRes.verdict !== 'approved') {
    const deniedResult =
      cardRes.verdict === 'timeout'
        ? `该排程操作因等待确认超时（${Math.ceil(CONFIRM_TIMEOUT_MS / 60_000)} 分钟内未收到你的确认）而自动跳过，并未执行。请如实告知用户并询问是否继续。`
        : '你拒绝了该排程操作（未获确认即不执行）。请停止该操作，向用户说明并征询意见。';
    ctx.send({
      tool_result: {
        name: ctx.name,
        result: deniedResult,
        durationMs: 0,
        success: false,
        phase: 'error',
        spanId: ctx.spanId,
        startAt: ctx.startAt,
        endAt: Date.now(),
      },
      nodeId: ctx.nodeId,
    });
    ctx.commitToolError?.(deniedResult);
    return 'handled_continue';
  }
  // approved：用户可能编辑过卡片 → 用编辑后的参数覆盖执行
  const editedArgs = cardRes.edited?.toolArgs;
  if (editedArgs && typeof editedArgs === 'object') {
    ctx.setExecArgs?.(JSON.stringify(editedArgs as Record<string, unknown>));
  }
  return 'handled_fallback';
}
registerHostTakeover({
  kind: 'planner_confirm',
  phase: 'pre',
  name: '*', // 名单是固定集（PLANNER_CARD_TOOLS）+ 身份（planner）判定 → 恒咨询，判定在 handler 内
  match: () => true,
  handle: handlePlannerCard,
});

// ── P4a-3-4 迁移 login/grant，行为不变 ──
// 收官两件：browser.login 挂起型接管 与 bobby grant 接管从 route 工具轮内联 if 分支收敛为注册式
// host-pending 分发（tool-pipeline.ts，各自注册新 kind 'login' / 'grant'，phase post）。
//   · login：exec 前 mode 注入（强制 BobWork 弹窗模式，属 pre 改写）+ exec 后 loginRequired 判定 →
//     createPendingLogin 挂起 + SSE login_required（requestId/siteName/url/timeoutSec）→ 20s 心跳 →
//     前端登录窗回传凭据（POST /api/chat/login 独立恢复端点，跨请求内存挂起）→ 服务端直调
//     browser.login_fill（findBrowserLoginFillFullName 定位 + mcpManager.callTool redactArgs 脱敏；
//     login_fill 不注册给模型）→ 三分支新 execResult 经 ctx.setExecResult 写回宿主、'handled_fallback'
//     回落通用落账路径（login 不自产 tool_result/落账 —— 与原分支体结束继续向下逐位一致）。
//   · grant：mcp__bobby__* 工具返回 grantRequired → SSE grant_required（带 target）旁路；不覆盖
//     execResult、不 continue（原分支 send 后无 continue，grantRequired 原文照常回灌模型）。
//     恢复链路在宿主侧之外：前端 ChatNodeKernel 记"等待授权"，BobbyNode 授权成功广播匹配后自动
//     补发"已授权，继续"消息触发模型重试，route 无独立恢复端点。
// mode 注入为 exec 前 pre 改写、browser.login 不在 P4a-2a args_transform 节点参数注入名单
// （NODE_PARAM_INJECT_TOOLS）内 → 以 args_transform 形态注册第二条目（按名匹配，互不重叠），
// 咨询点复用既有 takeoverOfKind(toolName,'args_transform') 位置 —— 不触碰既有名单条目逻辑；
// 与原内联 if 的等价性：browser.login 的 execArgs 无其它 pre 改写叠加（不在 planner 卡名单 /
// node 注入名单），注入输入恒为 tc.function.arguments、位置仍在 executeTool 前，行为逐位一致。
registerTakeover({
  kind: 'args_transform',
  phase: 'pre',
  name: '__browser_login_mode__',
  match: (name) => isBrowserLoginTool(name),
  transformArgs(_name, _args, _ctx) {
    // browser.login：强制注入 BobWork 弹窗模式 → 扩展不弹独立登录窗，返回 loginRequired，
    // 由本节点弹登录窗（凭据经 前端→服务端内存→MCP→扩展 直传，不过模型）。与原 if 内联同语义：
    // 参数 JSON 解析/回写失败 → null（原样传递）。
    try {
      const parsed = JSON.parse(_args) as Record<string, unknown>;
      parsed.mode = 'bobwork';
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  },
});
// browser.login 挂起型接管 handler（复刻迁移前工具轮内联分支 4378-4448，行为不变；判定条件
// execResult.success + isBrowserLoginTool 分别由宿主 post 咨询点与注册 match 保证）。
async function handleBrowserLogin(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① loginRequired 判定（结果 JSON 解析失败 / 非 loginRequired → 'noop' 交还通用路径原样落账）
  let loginReq: { loginRequired?: boolean; siteName?: string; url?: string } | null = null;
  try {
    loginReq = JSON.parse(ctx.result ?? '');
  } catch {
    loginReq = null;
  }
  if (!(loginReq && loginReq.loginRequired)) return 'noop';
  // ② 登记挂起项 + SSE login_required（载荷字段与原分支一致：requestId / siteName / url /
  //    timeoutSec；siteName/url 兜底用 ctx.pageUrl —— 宿主注入的 lastPageUrl 请求态）
  const { requestId, promise } = createPendingLogin(ctx.nodeId);
  ctx.send({
    login_required: {
      requestId,
      siteName: loginReq.siteName || toolDisplaySiteName(ctx.pageUrl ?? undefined),
      url: loginReq.url || ctx.pageUrl || '',
      timeoutSec: Math.ceil(LOGIN_TIMEOUT_MS / 1000),
    },
    nodeId: ctx.nodeId,
  });
  // ③ 等待用户输入期间 SSE 无数据会被前端 90s 空闲超时误杀；每 20s 发心跳保持连接
  const loginKeepalive = setInterval(() => {
    ctx.send({ tool_call_update: { name: ctx.name, phase: 'running', spanId: ctx.spanId, startAt: ctx.startAt }, nodeId: ctx.nodeId });
  }, 20000);
  let creds: { username: string; password: string } | null;
  try {
    creds = await promise; // 前端弹窗提交回传；超时/关闭为 null
  } finally {
    clearInterval(loginKeepalive);
  }
  // ④ 三分支构造新 execResult 并经 setExecResult 写回宿主（回落通用落账路径，与原分支体对
  //    execResult 的直接改写等价）：
  //    - 有凭据 + login_fill 成功 → 代填摘要（凭据不进结果文本、redactArgs 不打印日志）；
  //    - 有凭据 + login_fill 抛错 → success:false 失败文案；
  //    - 无凭据（超时/关闭）→ "用户未在…输入凭据"成功文案。
  if (creds) {
    try {
      const fillFullName = await findBrowserLoginFillFullName();
      if (!fillFullName) {
        throw new Error('browser.login_fill 未找到（Bob WebBridge MCP 未连接或版本过旧）');
      }
      const { mcpManager } = await import('@/lib/mcp/manager');
      const fillRaw = await mcpManager.callTool(
        fillFullName,
        { username: creds.username, password: creds.password },
        { redactArgs: true }, // 凭据不打印到日志
      );
      const fillSummary = String(fillRaw).trim().replace(/\s+/g, ' ').slice(0, 300);
      ctx.setExecResult?.({
        result:
          `你已在 BobWork 登录弹窗中提交账号密码，WebBridge 已代填并提交登录表单。` +
          (fillSummary ? ` 结果：${fillSummary}` : ''),
        durationMs: 0,
        success: true,
      });
    } catch (e) {
      ctx.setExecResult?.({
        result:
          `收到登录凭据，但自动填写登录表单失败：${e instanceof Error ? e.message : String(e)}。` +
          '请如实告知用户该站点仍处于未登录状态，建议其在浏览器中手动登录。',
        durationMs: 0,
        success: false,
      });
    }
  } else {
    ctx.setExecResult?.({
      result:
        '用户未在 BobWork 登录弹窗中输入凭据（弹窗被关闭或超时）。' +
        '请如实告知用户该站点仍处于未登录状态，必要时引导其手动登录。',
      durationMs: 0,
      success: true,
    });
  }
  // 已构造并写回新 execResult → 'handled_fallback' 回落宿主通用落账路径（与原分支体结束继续向下等价）
  return 'handled_fallback';
}
registerHostTakeover({
  kind: 'login',
  phase: 'post',
  name: 'browser.login', // 匹配 browser.login / mcp__*__browser_login（与 mode 注入条目同一判定）
  match: (name) => isBrowserLoginTool(name),
  handle: handleBrowserLogin,
});
// bobby grant 旁路 handler（复刻迁移前工具轮内联分支 4366-4376，行为不变；判定 execResult.success
// 由宿主 post 咨询点保证、工具名 mcp__bobby__* 由注册 match 保证）。
async function handleBobbyGrant(ctx: HostTakeoverContext): Promise<HostTakeoverVerdict> {
  // ① grantRequired 判定：结果不含 'grantRequired' / JSON 解析失败 / 非 grantRequired → 'noop'
  const raw = ctx.result ?? '';
  if (!raw.includes('grantRequired')) return 'noop';
  try {
    const j = JSON.parse(raw) as { grantRequired?: boolean; target?: string };
    if (j.grantRequired && typeof j.target === 'string') {
      // ② 命中：SSE grant_required 旁路下发（前端 ChatNodeKernel 记"等待授权"，BobbyNode 授权
      //    成功广播匹配后自动补发"已授权，继续"消息触发模型重试 —— 用户无需手动回复）。
      //    不覆盖 execResult、不 continue → 'handled_fallback' 回落通用路径（grantRequired 原文
      //    照常作为工具结果回灌模型，与原分支 send 后无 continue 逐位一致）。
      ctx.send({ grant_required: { target: j.target }, nodeId: ctx.nodeId });
      return 'handled_fallback';
    }
  } catch { /* 非 JSON 忽略 */ }
  return 'noop';
}
registerHostTakeover({
  kind: 'grant',
  phase: 'post',
  name: 'mcp__bobby__*',
  match: (name) => name.startsWith('mcp__bobby__'),
  handle: handleBobbyGrant,
});

/** 法律场景防幻觉最强约束 —— 当匹配到任何法律技能时，注入到技能上下文最顶部（随技能上下文进入当前轮 user 消息） */
const LEGAL_GUARD_PROMPT = `⚠️ 你正在处理法律问题，以下规则优先级最高，违反将导致严重法律风险：

1. 绝对禁止编造任何法律条文、法条编号、案例号、法院名称、裁判观点。
2. 引用法条前必须通过 web_search 检索核实原文。如果搜索不到原文，必须说"我无法确认该法条原文"，不得根据记忆编造。
3. 所有引用的法条必须附带时效性核查（是否现行有效 / 是否已修订 / 是否已废止）。
4. 法律条文的解释必须严格基于条文原文，不得添加任何未经核实的"立法意图""立法背景"。
5. 如果用户引用的法条与你的检索结果不符，应以检索结果为准并指出差异。
6. 不要为了让回答"看起来完整"而补充任何未经检索核实的内容。
`;

/**
 * DSH 模式（重构）：技能上下文注入。
 *  - L1 技能目录（名称+简介）始终注入，供模型参考技能库全貌；
 *  - L2 完整正文仅对用户手动勾选（forcedSkills）的技能注入；
 *  - 其余技能由模型通过 load_skill 工具按需加载，系统不再做关键词自动匹配。
 * 注入目标：当前轮 user 消息（缓存前缀稳定化，C8）。返回已注入技能名列表。
 */
interface SkillDetail {
  name: string;
  score: number;
  matchedKeywords: string[];
  bodyLength: number;
  forced: boolean;
}

function injectSkillContext(
  messages: ChatMessage[],
  forcedSkills?: string[],
  agentIdParam?: string,
): { messages: ChatMessage[]; matchedSkillNames: string[]; skillDetails: SkillDetail[] } {
  const userContent = extractLastUserContent(messages);
  if (!userContent) return { messages, matchedSkillNames: [], skillDetails: [] };

  const allDefs = getAllSkills();
  if (!allDefs.length) return { messages, matchedSkillNames: [], skillDetails: [] };

  // 2026-09-06 技能按 agent 分发：画像有独立技能池（agentSkills[agentId]）→ 用它的；
  // 否则回退 'default' 全局池（旧语义：enableSkill 只写 default / 未配置=全部技能默认启用）。
  const agentId = agentIdParam ?? 'default';
  const ownPool = getAgentSkills(agentId);
  const enabledSet = ownPool
    ? ownPool
    : hasAgentConfig('default')
      ? getEnabledSkillsForAgent('default')
      : new Set(allDefs.map(d => d.meta.name));

  if (!enabledSet.size) return { messages, matchedSkillNames: [], skillDetails: [] };

  const availableSkills = allDefs
    .filter(d => enabledSet.has(d.meta.name))
    .map(d => d.meta);

  const defMap = new Map(allDefs.map(d => [d.meta.name, d]));

  let skillCtx: string;
  let matchedNames: string[] = [];

  // DSH 模式（重构）：不再做关键词自动匹配。技能加载决策权交给模型——
  //   系统只注入 L1 技能目录（名称+简介，常驻），供模型判断何时需要技能；
  //   L2 完整正文仅对用户手动勾选（forcedSkills）的技能直接注入；
  //   其余技能由模型在对话中调用 load_skill 工具按需加载完整指令。
  // 效果：如 "hello" 等无技能意图的输入不再误加载任何技能正文，杜绝无意义上下文占用。
  let allMatches: SkillMatchResult[] = [];

  if (forcedSkills && forcedSkills.length > 0) {
    console.log('[技能注入] forcedSkills 参数:', forcedSkills);
    // 强制技能：仅注入全局仍启用的，构造满分类匹配（L2 正文直接注入）
    const forcedDefs = allDefs.filter(
      d => forcedSkills.includes(d.meta.name) && enabledSet.has(d.meta.name)
    );
    allMatches = forcedDefs.map(d => ({
      skillMeta: d.meta,
      score: 1.0,
      matchedKeywords: ['手动触发'],
    }));
    console.log('[技能注入] 强制技能(DSH模式):', forcedDefs.map(d => d.meta.name));
  }

  matchedNames = allMatches.map(m => m.skillMeta.name);

  // 4. 构建上下文：L1 始终传入完整 availableSkills，确保目录完整
  //    修复"L1目录不完整"漏洞
  skillCtx = buildSkillContext(allMatches, defMap, availableSkills);

  console.log(
    '[技能注入] 最终注入(DSH模式):', matchedNames,
    '强制:', allMatches.length, '自动: 0',
    '可用技能数:', availableSkills.length,
    '上下文长度:', skillCtx?.length || 0,
  );

  if (!skillCtx) return { messages, matchedSkillNames: matchedNames, skillDetails: [] };

  // 匹配到法律技能时，强制注入防幻觉约束到最顶部（优先级高于技能正文）
  const isLegalQuery = matchedNames.some(name => LEGAL_SKILL_NAMES.has(name));
  const prefixedCtx = isLegalQuery ? LEGAL_GUARD_PROMPT + '\n\n' + skillCtx : skillCtx;

  const result = [...messages];
  const forcedSet = new Set(forcedSkills ?? []);
  const skillDetails: SkillDetail[] = allMatches.map(m => {
    const def = defMap.get(m.skillMeta.name);
    return {
      name: m.skillMeta.name,
      score: m.score,
      matchedKeywords: m.matchedKeywords,
      bodyLength: def?.body?.length ?? 0,
      forced: forcedSet.has(m.skillMeta.name),
    };
  });
  // 缓存前缀稳定化（deepseek-harness C8）：技能上下文按当前轮用户输入动态匹配，属于"每轮易变"内容。
  // 若注入 system（缓存头），轮次间匹配结果变化 → 系统提示字节变化 → 前缀整段失效，命中率掉到个位数。
  // 改为 prepend 到当前轮（最后一条）user 消息：system + 历史前缀保持字节稳定（命中缓存），
  // 技能指令仍在同一请求内、紧跟用户请求，模型可见性与原注入等效。
  // 仅当最后一条消息是 user 时才 prepend（避免把易变内容写进历史中间的 user 消息，破坏历史字节稳定）；
  // 否则退回原逻辑注入 system。
  const last = result[result.length - 1];
  if (last && last.role === 'user') {
    const prev = (last.content || '');
    result[result.length - 1] = { ...last, content: prev ? prefixedCtx + '\n\n' + prev : prefixedCtx };
    return { messages: result, matchedSkillNames: matchedNames, skillDetails };
  }
  // 兜底：最后一条不是 user 消息（历史重放等边界）→ 追加一条 user 消息承载技能上下文，
  // 仍不进 system（C8：system 字节保持稳定，杜绝任何动态内容写入缓存头）
  result.push({ role: 'user', content: prefixedCtx });

  return { messages: result, matchedSkillNames: matchedNames, skillDetails };
}

/** 根据思考深度构建系统提示并注入到消息列表。
 *  basePrompt：当前 Agent 的基础系统提示（缓存头）——通用 Agent 用 BASE_SYSTEM_PROMPT，
 *  专项 Agent（如 coding）用自己的专属 base（见 AGENT_PROFILES.baseSystemPrompt）。 */
function injectThinkingPrompt(
  messages: ChatMessage[],
  level: ThinkingLevel,
  modelSupportsThinking = true,
  basePrompt: string = BASE_SYSTEM_PROMPT,
): ChatMessage[] {
  let injection = SYSTEM_PROMPT_INJECTIONS[level];

  if (injection && !modelSupportsThinking) {
    // 非推理模型：去掉 <think></think> 标签引用，但保留思考引导内容
    injection = injection
      .replace(/思考过程用 <think><\/think> 标签包裹[。.]?/g, '')
      .replace(/用 <think><\/think> 标签包裹[。.]?/g, '')
      .replace(/用 <think> 标签包裹[。.]?/g, '')
      .replace(/所有分析用 <think> 标签包裹[。.]?/g, '')
      .replace(/\n{3,}/g, '\n\n');
  }

  const result = [...messages];

  // 缓存前缀稳定化：思考指令随 level 变化，若注入 system（缓存头），
  // 用户在同一对话中切换思考深度 → system 字节变化 → 前缀整段失效，历史缓存全部作废。
  // 改为 prepend 到当前轮最后一条 user 消息：system 只含字节稳定的 BASE_SYSTEM_PROMPT，
  // 思考深度自由切换不再破坏历史缓存（level 变化只影响当前轮 user 消息）。
  const sysIdx = result.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) {
    // 已有系统消息：保证 basePrompt 在开头（思考指令不再进 system）
    const existingContent = result[sysIdx].content || '';
    result[sysIdx] = {
      ...result[sysIdx],
      content: existingContent.startsWith(basePrompt.slice(0, 20))
        ? existingContent
        : basePrompt + '\n\n' + existingContent,
    };
  } else {
    result.unshift({ role: 'system', content: basePrompt });
  }

  // 思考指令 prepend 到当前轮 user 消息（与技能上下文/偏好注入同策略）
  if (injection) {
    const last = result[result.length - 1];
    if (last && last.role === 'user') {
      const prev = last.content || '';
      result[result.length - 1] = { ...last, content: prev ? injection + '\n\n' + prev : injection };
    } else {
      // 兜底：最后一条不是 user 消息（历史重放等边界）→ 追加一条 user 消息，仍不进 system
      result.push({ role: 'user', content: injection });
    }
  }

  return result;
}

/**
 * 缓存前缀稳定化（deepseek-harness C8 扩展）：把「低频变化」的动态上下文块 prepend 到
 * 当前轮最后一条 user 消息，而不是追加进 system（缓存头）。
 *   - system 只含字节稳定的 BASE_SYSTEM_PROMPT → 所有节点/会话共享同一缓存前缀；
 *   - 项目路径 / 授权目录 / 镜像指引 / 偏好目录 / AI Coding 上下文等动态内容只影响当前轮
 *     user 消息（本轮内容本就每次不同），历史缓存不受影响；
 *   - 仅当最后一条消息是 user 时才 prepend（避免把易变内容写进历史中间的 user 消息，
 *     破坏历史字节稳定）；否则退回追加 system（历史重放等边界兜底）。
 */
function prependDynamicContext(messages: ChatMessage[], text: string): ChatMessage[] {
  const clean = (text || '').trimStart();
  if (!clean) return messages;
  const result = [...messages];
  const last = result[result.length - 1];
  if (last && last.role === 'user') {
    const prev = (last.content || '').trimStart();
    result[result.length - 1] = {
      ...last,
      content: prev ? clean + '\n\n' + prev : clean,
    };
    return result;
  }
  // 兜底：最后一条不是 user（历史重放等边界）→ 追加一条 user 消息承载动态内容，
  // 仍不进 system（C8：杜绝任何动态内容写入缓存头）
  result.push({ role: 'user', content: clean });
  return result;
}

/**
 * OCR/视觉引擎现状事实注入（[SYS FACT]）
 *
 * 问题背景：BASE_SYSTEM_PROMPT 曾硬编码「bob-ocr-mcp 已配置本地视觉模型（Qwen2.5-VL）」，
 * 而插件真实配置由用户随时可改（云端 DeepSeek VL / GLM-OCR / 本地 MLX 等皆可能）——
 * 配置变了、缓存头里的静态断言没变，模型据 stale 文案向用户转述错误引擎归属。
 * 根因：易变配置被写进了字节稳定的 system 缓存头。
 *
 * 方案：system 保持零插值（C8）；每轮从插件数据根 config.json
 * （BobWork 托管：~/BobWork/extensions/bob-ocr-mcp）读真实生效值，
 * 以固定格式事实行走 prependDynamicContext 低频通道注入。只原样转述字段值，不做
 * 本地/云端的语义推断（provider/baseUrl 字段本身已表达），绝不输出 apiKey。
 * 兼容 v2 schema（vision.* / ocr.*）与旧版 schema（顶层 glmOcr / onlineOcr）。
 *
 * 缓存影响：注入落在所有历史之后（当前轮 user 消息内），跨轮前缀
 * （system + 工具 + 历史）字节不变，命中率不受影响；用户改插件配置的瞬间
 * 仅影响本轮及之后的消息前缀，属预期失效（事实必须反映最新配置）。
 */
function buildOcrEngineFactInjection(): string {
  try {
    const cfgPath = join(pluginDataHome('bob-ocr-mcp'), 'config.json');
    if (!existsSync(cfgPath)) return '';
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : '');
    const lines: string[] = [];

    // 视觉理解（v2：vision.selected 指向 vision.models[] 中某条目）
    if (raw.vision && typeof raw.vision === 'object') {
      const vision = raw.vision as { selected?: unknown; models?: unknown };
      const selected = str(vision.selected);
      const models = Array.isArray(vision.models)
        ? (vision.models as { id?: unknown; provider?: unknown; baseUrl?: unknown }[]).filter(
            (m): m is NonNullable<typeof m> => !!m && typeof m === 'object',
          )
        : [];
      const entry = selected ? models.find((m) => str(m.id) === selected) : undefined;
      if (entry) {
        lines.push(`- 视觉理解模型：${selected}（provider=${str(entry.provider) || '未声明'}，baseUrl=${str(entry.baseUrl) || '默认'}）`);
      } else if (selected) {
        lines.push(`- 视觉理解模型：${selected}（模型清单中未找到对应条目）`);
      } else {
        lines.push('- 视觉理解模型：未选择');
      }
    }

    // 文字识别（v2：ocr.source / ocr.glm / ocr.local；旧版兜底：顶层 glmOcr / onlineOcr）
    if (raw.ocr && typeof raw.ocr === 'object') {
      const ocr = raw.ocr as Record<string, unknown>;
      const src = str(ocr.source);
      const sel = str(ocr.selected);
      const detail: string[] = [];
      if (ocr.glm && typeof ocr.glm === 'object') {
        const glm = ocr.glm as { model?: unknown; baseUrl?: unknown; enabled?: unknown };
        const state = glm.enabled === true ? '启用' : glm.enabled === false ? '停用' : '未声明';
        detail.push(`glm=${str(glm.model) || state}@${str(glm.baseUrl) || '默认'}`);
      }
      if (ocr.local && typeof ocr.local === 'object') {
        const local = ocr.local as { baseUrl?: unknown; enabled?: unknown };
        const state = local.enabled === true ? '' : local.enabled === false ? '（停用）' : '';
        detail.push(`local=${str(local.baseUrl) || '默认'}${state}`);
      }
      lines.push(`- 文字识别主力：${src || sel || '未配置'}${src && sel ? `（selected=${sel}）` : ''}${detail.length ? `｜${detail.join('｜')}` : ''}`);
    } else if (
      ((raw.glmOcr ?? null) && typeof raw.glmOcr === 'object') ||
      ((raw.onlineOcr ?? null) && typeof raw.onlineOcr === 'object')
    ) {
      const seg: string[] = [];
      if (raw.glmOcr && typeof raw.glmOcr === 'object') {
        const leg = raw.glmOcr as { model?: unknown; enabled?: unknown };
        seg.push(`glm=${str(leg.model) || (leg.enabled === false ? '停用' : '已配置')}`);
      }
      if (raw.onlineOcr && typeof raw.onlineOcr === 'object') {
        const onl = raw.onlineOcr as { model?: unknown; provider?: unknown; enabled?: unknown };
        seg.push(`online=${str(onl.model) || str(onl.provider) || (onl.enabled === false ? '停用' : '已配置')}`);
      }
      lines.push(`- 文字识别主力（旧版配置）：${seg.join('｜')}`);
    }

    if (!lines.length) return '';
    return (
      `\n\n## OCR/视觉引擎现状（[SYS FACT]）\n以下为 bob-ocr-mcp 插件本轮实际生效的引擎配置（读取自其 config.json 原样字段值）。` +
      `回答任何"用的什么视觉模型 / OCR 引擎是本地还是云端 / 是否已配置"等引擎归属类问题时，必须以此为准：\n` +
      lines.join('\n')
    );
  } catch {
    /* 配置缺失/损坏一律静默跳过——此时 system 护栏要求如实回答"无法确认"，不得虚构 */
  }
  return '';
}

/**
 * 工具循环不设轮数硬上限：任务只要在推进，就一直做下去直到完成。
 * 仅保留「停滞保护」安全网（不是轮数限制）：
 * - STALL_LIMIT：连续 N 轮没有任何实质进展（无成功工具结果 / 工具全部失败或重复 / 无文本输出）→ 判定死循环，强制收尾
 * - MAX_DUPLICATE_CALLS：同一工具+相同参数的重复次数限制（防模型原地打转）
 */
const STALL_LIMIT = 3;
/** 同一工具+相同参数的最大重复次数 */
const MAX_DUPLICATE_CALLS = 2;
/** OCR 识别重试预算：同一文件被 ocr_document/crop_image 反复识别的最大次数。
 * 超过即判定手写字段识别不收敛，注入提示要求停止重试并报 NEED_REVIEW（治"15+ 轮空转"）。 */
const OCR_REOCR_BUDGET = 4;
/** 声明真实性校验：最多注入纠偏消息的次数（防止无限纠偏循环） */
const MAX_CLAIM_MISMATCH_CORRECTIONS = 2;

/**
 * 声明真实性校验（Claim Verification）
 *
 * 问题：模型可能在正文里声称"已写入文件 xxx.md"但实际并未调用 write_file，
 * 或调用了但返回失败。服务端只校验"被调用的工具是否成功"，不校验"模型文字声明
 * 是否与工具调用记录吻合"。这导致模型可以"幻觉式完成"——谎报结果而系统不发现。
 *
 * 方案：解析模型本轮正文中的完成性声明（写入/生成/创建/保存了某文件），
 * 反查 allToolCalls 记录，确认对应工具确实成功执行过。不匹配则返回纠偏指令。
 *
 * @returns 不匹配声明列表 + 纠偏消息（null 表示无声明或不需纠偏）
 */
function verifyClaimsAgainstToolRecords(
  assistantText: string,
  allToolCalls: Array<{ toolName: string; arguments: Record<string, unknown>; result: string; success: boolean }>,
): { mismatches: string[]; correction: string | null } {
  // 提取 <think> 外的正文（声明只在正文里，不在思考块里）
  const thinkMatch = assistantText.match(/<think>[\s\S]*?<\/think>\s*/i);
  const body = thinkMatch ? assistantText.slice(thinkMatch[0].length) : assistantText;
  if (!body.trim()) return { mismatches: [], correction: null };

  // 匹配完成性声明：已写入/已生成/已创建/已保存 + 文件路径
  // 覆盖中英文：已写入/written/已生成/generated/已创建/created/已保存/saved
  const claimPatterns: Array<{ regex: RegExp; tool: string; argKey: string }> = [
    // write_file: "已写入 xxx.md" / "written to xxx" / "file written: xxx"
    { regex: /(?:已写入|已保存到?|写入成功|written\s+to|file\s+written[:\s]+|saved\s+(?:to\s+)?)([^\s，。,;.!！\n'"`<>]{2,120}\.(?:md|txt|json|js|ts|tsx|jsx|html|css|py|sh|yaml|yml|csv|pdf|png|jpg|jpeg|svg))/gi, tool: 'write_file', argKey: 'path' },
    // generate_image: "已生成图片 xxx.png" / "generated image xxx"
    { regex: /(?:已生成(?:图片|图像)?|generated\s+image(?:\s+(?:to|at|:))?)\s*([^\s，。,;.!！\n'"`<>]{2,120}\.(?:png|jpg|jpeg|svg|gif|webp))/gi, tool: 'generate_image', argKey: 'file_path' },
  ];

  const mismatches: string[] = [];
  for (const { regex, tool, argKey } of claimPatterns) {
    const matches = body.matchAll(regex);
    for (const m of matches) {
      const claimedPath = argKey === '__any__' ? null : m[1];
      // 反查 allToolCalls：该工具是否成功执行过
      const relevantCalls = allToolCalls.filter((tc) => tc.toolName === tool && tc.success);
      if (relevantCalls.length === 0) {
        // 工具从未成功执行过 → 声明虚假
        mismatches.push(
          claimedPath
            ? `声称已${tool === 'write_file' ? '写入' : tool === 'generate_image' ? '生成' : '处理'} "${claimedPath}"，但 ${tool} 从未被成功调用`
            : `声称已完成 ${tool}，但该工具从未被成功调用`,
        );
        continue;
      }
      // 对于有路径的声明，进一步检查路径是否匹配
      if (claimedPath) {
        const normalizedClaim = claimedPath.replace(/\\/g, '/').toLowerCase();
        const pathMatched = relevantCalls.some((tc) => {
          const actualPath = String(tc.arguments[argKey] ?? '').replace(/\\/g, '/').toLowerCase();
          if (!actualPath) return false;
          // 包含匹配：声明路径是实际路径的子串或反之（处理相对/绝对路径差异）
          return actualPath.endsWith(normalizedClaim) || normalizedClaim.endsWith(actualPath) || actualPath === normalizedClaim;
        });
        if (!pathMatched) {
          mismatches.push(`声称已处理 "${claimedPath}"，但 ${tool} 成功记录中的路径均不匹配`);
        }
      }
    }
  }

  if (mismatches.length === 0) return { mismatches: [], correction: null };

  const correction = [
    '⚠️ 声明真实性校验未通过：以下操作被声称完成但工具调用记录中未找到对应的成功执行：',
    ...mismatches.map((m, i) => `  ${i + 1}. ${m}`),
    '',
    '请立即调用相应工具真正执行上述操作，不要用文字描述代替工具调用。只有工具返回成功结果后，才算真正完成。',
  ].join('\n');

  return { mismatches, correction };
}

/**
 * PDF 读取完整性校验（防"残缺输入上的幻觉式完成"）
 *
 * 背景：多页渲染失败时单页回退只返回第 1 页（工具结果带 `⚠ INCOMPLETE: page 1 of N`
 * 机器可读硬标记），截断时也带 `⚠ INCOMPLETE: pages a-b of N`。若模型在正文声称
 * "已完整读取/分析整份 PDF" 并据此给出结论，但工具记录里其实只有残缺页——
 * 必须拦截，强制分页续读后再作答。
 *
 * @returns 不匹配项 + 纠偏消息（null 表示模型无"完整读取"声明，或工具结果无 INCOMPLETE 标记）
 */
function verifyPdfReadCompleteness(
  assistantText: string,
  allToolCalls: Array<{ toolName: string; arguments: Record<string, unknown>; result: string; success: boolean }>,
): { mismatches: string[]; correction: string | null } {
  // 提取 <think> 外的正文（声明只在正文里）
  const thinkMatch = assistantText.match(/<think>[\s\S]*?<\/think>\s*/i);
  const body = thinkMatch ? assistantText.slice(thinkMatch[0].length) : assistantText;
  if (!body.trim()) return { mismatches: [], correction: null };

  // 1) 模型是否声明"完整读取/分析"了某 PDF（完成性声明，中英文覆盖）
  const completeClaimRe =
    /(?:已?完整(?:读取|识别|分析|浏览|阅览)|已(?:通读|读完整份|阅完|识别完|分析完)|全部(?:页|内容|页面)(?:都)?(?:已)?(?:读取|识别|分析)|整份(?:PDF|文档)(?:已)?(?:读取|识别|分析|审阅)|已读取(?:全部|所有)(?:页|内容)|基于(?:整个|完整)文档|based\s+on\s+(?:the\s+)?(?:entire|complete|full)\s+(?:document|pdf))/gi;
  if (!completeClaimRe.test(body)) return { mismatches: [], correction: null };

  // 2) 反查 read_attachment 成功结果中的 INCOMPLETE 硬标记
  const INC_RE = /INCOMPLETE:\s*(?:page|pages)\s+([0-9,\s-]+?)\s+of\s+(\d+|\?)/i;
  const incomplete: Array<{ path: string; pageNo: number; total: number }> = [];
  for (const tc of allToolCalls) {
    if (tc.toolName !== 'read_attachment' || !tc.success) continue;
    const m = (tc.result || '').match(INC_RE);
    if (m) {
      const total = parseInt(m[2], 10);
      incomplete.push({
        path: String(tc.arguments.path ?? ''),
        pageNo: parseInt(m[1], 10) || 1,
        total: Number.isFinite(total) ? total : 0,
      });
    }
  }
  if (incomplete.length === 0) return { mismatches: [], correction: null };

  // 3) 构造纠偏：对每个残缺 PDF 给出续读指令（剩余页区间）
  const mismatches = incomplete.map(({ path, pageNo, total }) =>
    total > 0
      ? `声称已完整读取 "${path}"，但工具返回带 INCOMPLETE 标记（仅第 ${pageNo} 页，共 ${total} 页）`
      : `声称已完整读取 "${path}"，但工具返回带 INCOMPLETE 标记（仅第 ${pageNo} 页，总页数未知）`,
  );
  const hints = incomplete
    .filter((x) => x.total > x.pageNo)
    .map(({ path, pageNo, total }) => `- 调用 read_attachment(path="${path}", pages="${pageNo + 1}-${total}") 续读剩余 ${total - pageNo} 页`);
  const correction = [
    '⚠️ PDF 读取完整性校验未通过：以下文件被声称"完整读取/分析"，但工具返回结果带有 INCOMPLETE 标记（只识别了部分页）：',
    ...mismatches.map((m, i) => `  ${i + 1}. ${m}`),
    '',
    '请先分页续读完整内容，再基于完整内容作答，禁止基于残缺页下结论：',
    ...(hints.length > 0 ? hints : ['- 使用 read_attachment(path="...", pages="页码区间") 分页读取剩余页']),
  ].join('\n');

  return { mismatches, correction };
}

/**
 * 笔记读取声明校验（第二类死角）：模型声称"根据笔记/库里/你记录的回答"，
 * 但工具记录中从未成功调用 read_notebook / read_note / read_raw_inbox。
 * 与第一类死角（全程零工具调用）互补：此处是"调了工具但没读笔记就冒充引用了笔记"。
 *
 * @returns mismatches 非空 = 存在"声称引用笔记但未读取"的幻觉声明
 */
function verifyNoteReadClaims(
  assistantText: string,
  allToolCalls: Array<{ toolName: string; arguments: Record<string, unknown>; result: string; success: boolean }>,
): { mismatches: string[]; correction: string | null } {
  // 提取 <think> 外的正文（声明只在正文里）
  const thinkMatch = assistantText.match(/<think>[\s\S]*?<\/think>\s*/i);
  const body = thinkMatch ? assistantText.slice(thinkMatch[0].length) : assistantText;
  if (!body.trim()) return { mismatches: [], correction: null };

  // "声称基于个人笔记/知识库回答"的中文表述。核心信号：个人库知识词(笔记/知识库/素材/记录/整理)
  // 之后 15 字内紧跟"引用谓词"(有/是/记录/提到/查到/写着/讲过…) = 声称读取过内容。
  // 操作性语句("记了一条笔记到素材库"——谓词在知识词前)与法律条文引用(无知识词)不命中。
  const noteClaimRe =
    /(?:你的?|我的?|个人)?(?:笔记|知识库|素材库|素材|记录|整理(?:过|的)?(?:内容|笔记)?|库(?:里|中|内)?)(?:[^。！？\n]{0,15}?(?:有|是|提到|写了|记录|说|查到|见过|保存|收录|写着|讲过|上面写|来看|可知|显示|得知))/i;
  if (!noteClaimRe.test(body)) return { mismatches: [], correction: null };

  // 反查：是否成功调用过笔记读取工具
  const noteTools = ['read_notebook', 'read_note', 'read_raw_inbox'];
  const hasRead = allToolCalls.some((tc) => noteTools.includes(tc.toolName) && tc.success);
  if (hasRead) return { mismatches: [], correction: null };

  return {
    mismatches: ['声称基于个人笔记/知识库回答，但本会话从未成功调用 read_notebook / read_note / read_raw_inbox 读取过任何笔记——请核实答案是否凭空编造，必要时先检索笔记再作答。'],
    correction: null,
  };
}

/** 检测聊天模型是否支持视觉 */
function chatModelSupportsVision(modelId: string, baseUrl?: string): boolean {
  if (!modelId) return false;
  const visionPatterns = /(vision|vl|4o|qwen-vl|glm-4v|glm-4\.6v|glm-5v|gemini|claude-3-opus|claude-3.5)/i;
  return visionPatterns.test(modelId);
}

/** Vision Bridge：自动检测图片附件，用视觉模型描述后注入文本 */
async function applyVisionBridge(
  messages: ChatMessage[],
  onProgress?: (p: { phase: string; current: number; total: number }) => void,
): Promise<ChatMessage[]> {
  const hasImageAttachment = messages.some((m) => {
    if (m.role !== 'user') return false;
    const c = m.content || '';
    return c.includes('图片') && (c.includes('路径: attachments/') || c.includes('路径: assets/'));
  });

  if (!hasImageAttachment) {
    return messages;
  }

  try {
    const project = await getCurrentProject();

    const imagePaths: string[] = [];
    messages.forEach((m) => {
      if (m.role === 'user') {
        const matches = (m.content || '').match(/路径: ((?:attachments|assets)\/[^\\n]+)/g);
        if (matches) {
          matches.forEach((match) => {
            const path = match.replace('路径: ', '');
            const ext = path.split('.').pop()?.toLowerCase();
            if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
              imagePaths.push(path);
            }
          });
        }
      }
    });

    if (imagePaths.length === 0) {
      return messages;
    }
    onProgress?.({ phase: 'start', current: 0, total: imagePaths.length });

    const descriptions: string[] = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const imgPath = imagePaths[i];
      const filePath = `${project.path}/${imgPath}`;
      onProgress?.({ phase: 'image', current: i + 1, total: imagePaths.length });
      try {
        // 心跳保活：单图多候选模型串行识别可能超过 90s 无输出（每候选 30-40s × 降级链），
        // 周期发送进度帧，前端任一 SSE 帧即重置 90s 空闲超时计时器，避免识别中被误杀。
        let beat = 0;
        const heartbeat = setInterval(() => {
          beat += 1;
          onProgress?.({ phase: 'recognizing', current: i + 1, total: imagePaths.length });
        }, 15_000);
        try {
          // 图片理解统一走 bob-ocr-mcp（ocr.image_understand general 模式）；配置已收敛到插件，MCP 不可用则跳过该图描述
          const { ocrImageUnderstandViaMcp } = await import('@/lib/mcp/ocr-client');
          const viaMcp = await ocrImageUnderstandViaMcp(filePath, { mode: 'general' });
          if (viaMcp) {
            descriptions.push(`图片描述: ${viaMcp.understanding}`);
          } else {
            console.warn('bob-ocr-mcp 视觉模型不可用，跳过图片描述');
          }
        } finally {
          clearInterval(heartbeat);
        }
      } catch (e) {
        console.warn('视觉模型分析图片失败:', e);
      }
    }

    if (descriptions.length === 0) {
      return messages;
    }

    const modifiedMessages: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        const hasImage = (m.content || '').includes('图片') && ((m.content || '').includes('路径: attachments/') || (m.content || '').includes('路径: assets/'));
        if (hasImage) {
          modifiedMessages.push({
            ...m,
            content: (m.content || '') + `\n\n[图片已通过视觉模型描述如下：\n${descriptions.join('\n')}\n]`,
          });
        } else {
          modifiedMessages.push(m);
        }
      } else {
        modifiedMessages.push(m);
      }
    }

    return modifiedMessages;
  } catch (e) {
    console.warn('Vision Bridge 执行失败:', e);
    return messages;
  }
}

// ==================== Vision Bridge ====================

/**
 * 按 nodeId 定位节点所属项目（chat 链路专用）。
 * 背景：普通画布节点请求不带 projectId，后端此前一律用「全局激活项目」，当节点所在项目
 * ≠ 激活项目时，loadNodeById 找不到节点 → sandbox_app_id / 上游成果注入静默失败
 * （典型症状：新建 Coding 节点绑定小程序后 AI "找不到程序的存放位置"）。
 * 规则：1) 显式 projectId 优先；2) 否则先试当前激活项目；3) 仍找不到则遍历全部非归档项目定位。
 */
async function resolveNodeProject(
  nodeId: string | undefined,
  projectId?: string,
): Promise<ProjectConfig | null> {
  if (projectId) {
    try {
      return await getProjectById(projectId);
    } catch {
      return null;
    }
  }
  if (!nodeId) {
    try {
      return await getCurrentProject();
    } catch {
      return null;
    }
  }
  try {
    const cur = await getCurrentProject();
    if (await loadNodeById(nodeId, cur.path)) return cur;
  } catch {
    /* 无激活项目，继续遍历 */
  }
  try {
    const { projects } = await listProjects();
    for (const p of projects) {
      if (p.archived || p.hidden) continue;
      try {
        if (await loadNodeById(nodeId, p.path)) return p;
      } catch {
        /* 单个项目读取失败跳过 */
      }
    }
  } catch {
    /* 项目列表读取失败忽略 */
  }
  return null;
}

// ==================== Node Bridge（v3：上游成果块注入 + 托管模型自动派发实习生） ====================

/** R-14：注入总长上限（超过自动回退：裁剪旧对话重试，注入独占时才拒绝）
 * 动态方案：闸值 = contextGateForContext(当前请求模型 contextWindow)，见 src/lib/context-limits.ts；
 * 1M→200000、256k→51200、128k→25600、8k→1600，下限 32000，为对话历史 + 上游注入留足空间，同时给模型输出预留余量 */

/** 系统提示引导语（规格 v3 §七） */
const UPSTREAM_GUIDE_PROMPT = `以下是上游节点已锁定的成果，是本节点分析的既定前提。
其中的事实认定与法律依据可直接引用，无需重新论证。
「明确排除」中的路径已被否定，不要重复提出。
如需推翻上游结论，必须显式指出，不得默默改用其他前提。

上游成果中未涵盖的内容，你有三个选择，按顺序尝试：
1. read_manifest(node_id) 查看祖先节点目录
2. intern_search(node_id, instruction) 取回原始对话片段（返回内容恒标 [原始对话·未认定]，引用时须标 [存疑] 或转入 pending）
3. 若仍无所获，在 pending 中写明「上游未认定 xxx，需回溯确认」并停止推理

严禁基于常理、惯例或合理推断填补上游未认定的事实。

引用格式：当回答引用了上游成果块（已锁定）或实习生取回的内容时，请在回答末尾附加引用元数据块（正文引用处用 [1]、[2] 角标对应 id）：
<!-- CITATIONS -->
[{"id":1,"node":"n_003","block":"facts","anchor":"fact-2","preview":"内容一句话摘要","status":"locked"}]
<!-- /CITATIONS -->
- status: locked = 上游成果块（已签字，可直接引用）；unverified = 实习生返回（未认定，须标 [存疑] 或转 pending）
- 无引用时不输出该块。`;

/**
 * 从被 R-14 裁剪掉的消息中提取 (user, assistant) 轮次（缓存感知压缩的输入）。
 * 裁剪按数组头部成对丢弃，这里同样从头部扫描；单条不成对的 user 也按一轮计入。
 */
function extractTrimmedTurns(original: ChatMessage[], trimmed: ChatMessage[]): ConversationTurn[] {
  const cutCount = original.length - trimmed.length;
  if (cutCount <= 0) return [];
  const cut = original.slice(0, cutCount);
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < cut.length; i += 2) {
    const u = cut[i];
    const a = cut[i + 1];
    if (u?.role !== 'user') continue;
    turns.push({
      question: typeof u.content === 'string' ? u.content : '',
      answer: a && a.role === 'assistant' && typeof a.content === 'string' ? a.content : '',
      questionTime: '',
      answerTime: '',
    });
  }
  return turns;
}

/** 读取 settings 中第一个可用自定义 provider 作为压缩模型（与 /api/nodes 增量压缩同款优先级） */
async function resolveCompactModelConfig(): Promise<CompactModelConfig | null> {
  try {
    const settings = await readSettingsFromFile();
    const providers = (settings as { providers?: Array<{ enabled?: boolean; apiKey?: string; baseUrl?: string; defaultModel?: string; models?: Array<{ enabled?: boolean; id?: string }> }> }).providers || [];
    const firstEnabled = providers.find((p) => p.enabled !== false && p.apiKey && p.baseUrl);
    if (!firstEnabled) return null;
    const defaultModel =
      firstEnabled.defaultModel ||
      firstEnabled.models?.find((m) => m.enabled)?.id ||
      firstEnabled.models?.[0]?.id;
    if (!defaultModel) return null;
    return { apiKey: firstEnabled.apiKey!, baseURL: firstEnabled.baseUrl!, model: defaultModel };
  } catch {
    return null;
  }
}

/**
 * 缓存感知压缩（R-14-C）：R-14 裁剪旧对话时，把被裁轮次增量压缩进节点压缩记忆并推进
 * memory_compacted_until（持久化）。
 *   - 信息不丢：被裁文本 → runCompaction 合并进 compressedMemory（含硬事实 R-27 兜底）；
 *   - 前缀稳定：下一轮前端 compactedUntilRef 读到推进后的游标 → 跳过这些轮次不再发送 →
 *     请求前缀与裁剪后一致 → 命中 DeepSeek 前缀缓存（否则每轮重新裁剪、前缀漂移、全价重算）。
 * 返回更新后的压缩记忆渲染文本（供本轮注入兜底），无变化返回 null。
 * 模型调用失败 / 冷却期内 → 降级为硬事实直写（不 throw，不阻断裁剪主流程）。
 */
async function compactTrimmedHistoryForCache(
  nodeId: string,
  project: Awaited<ReturnType<typeof getCurrentProject>> | null,
  trimmedTurns: ConversationTurn[],
  taskId: string,
  eventLog: EventLog,
): Promise<string | null> {
  if (!nodeId || !project || trimmedTurns.length === 0) return null;

  // 写回前重新读取节点（压缩可能耗时，期间节点可能被 /api/nodes 并发写入，避免覆盖丢失）
  const node = await loadNodeById(nodeId, project.path);
  if (!node) return null;

  const compactedUntil = node.frontmatter.memory_compacted_until ?? 0;
  const newUntil = Math.min(compactedUntil + trimmedTurns.length, node.conversations.length);
  // 被裁轮次已全部被压缩覆盖 → 无需重复压缩（信息已有压缩记忆兜底）
  if (newUntil <= compactedUntil) return null;

  const existing = node.compressedMemory || '';
  const finalText = trimmedTurns.reduce((s, t) => s + (t.question || '') + (t.answer || ''), '');
  const hardFacts = extractHardFacts(finalText);
  const goal = extractGoalFromExistingMemory(existing);

  // 冷却期内（上次压缩后 10 分钟内）→ 降级硬事实直写，不调模型，避免长文档逐轮触发压缩风暴
  const inCooldown = (() => {
    const at = node.frontmatter.memory_compacted_at;
    if (!at) return false;
    const last = Date.parse(at);
    return Number.isFinite(last) && Date.now() - last < COMPACT_COOLDOWN_MS;
  })();

  // P4c-1 fallback 收敛：无模型/冷却期 均走 compact.ts 共享 compactionFallbackSummary（与 nodes append 同款）
  const compressInput = { goal, existingMemory: existing, uncompressedTurns: trimmedTurns, hardFacts };
  let rendered: string;
  let fallbackKind: 'none' | 'no-model' | 'cooldown' = 'none';
  if (!inCooldown) {
    const modelCfg = await resolveCompactModelConfig();
    if (modelCfg) {
      const result = await runCompaction(compressInput, modelCfg);
      rendered = result.rendered;
    } else {
      // 无可用模型 → 硬事实直写（与 /api/nodes 降级逻辑一致）
      fallbackKind = 'no-model';
      rendered = compactionFallbackSummary(compressInput);
    }
  } else {
    // 冷却期内 → 降级硬事实直写，不调模型，避免长文档逐轮触发压缩风暴
    fallbackKind = 'cooldown';
    rendered = compactionFallbackSummary(compressInput);
  }

  // 持久化：压缩记忆 + 游标推进（前端下轮按 ×2 跳过这些轮次 → 前缀稳定）
  node.compressedMemory = rendered;
  node.frontmatter.memory_compacted_at = new Date().toISOString();
  node.frontmatter.memory_compacted_until = newUntil;
  node.frontmatter.memory_turn_count = 0;
  node.frontmatter.updated_at = new Date().toISOString();
  try {
    const filePath = await findNodeFileById(nodeId, project.path);
    if (filePath) {
      await updateNodeFile(filePath, serializeNode(node));
    }
  } catch (e) {
    console.warn('[R-14-压缩] 节点写回失败（压缩记忆仅本轮生效）:', e instanceof Error ? e.message : String(e));
  }
  console.log(`[R-14-压缩] 被裁 ${trimmedTurns.length} 轮已压缩进节点记忆（游标 ${compactedUntil} → ${newUntil}，冷却内=${inCooldown}）`);
  // P4c-1 压缩事件化：压缩实际发生（游标推进 + 写回 .md 成功）后记一条 compaction 事件；
  // 仅追加事件记录，不改变任何压缩触发/游标/写回语义。
  eventLog.mark(CORE_EVENT.COMPACTION, `compaction:${taskId}`, {
    reason: 'R-14-C 缓存感知压缩',
    shadowedTurns: { from: compactedUntil, to: newUntil },
    hardFactsCount: hardFacts.length,
    hardFactsSample: hardFacts.slice(0, 5),
    summaryGoal: goal,
    compactedUntil: newUntil,
    fallbackKind,
  });
  return rendered;
}

/**
 * Node Bridge：按祖先链注入上游信息（规格 v3 §七 R-12~R-18 + §八）
 *  - R-12 直接上游（深度 1）成果块全文注入，不截断不递归
 *  - R-17 祖先（深度 ≥2）只注入存在性声明一行
 *  - R-14 注入总长超限自动回退（裁剪旧对话），注入独占时才拒绝
 *  - Step 9：托管模型（无工具能力）自动派发实习生，命中关键词交集 ≥2 的祖先取回原文注入
 */
async function applyUpstreamNodeBridge(
  messages: ChatMessage[],
  nodeId: string | undefined,
  project: Awaited<ReturnType<typeof getCurrentProject>> | null,
  isManagedModel: boolean,
  contextWindow: number,
  taskId: string,
  eventLog: EventLog,
): Promise<ChatMessage[]> {
  if (!nodeId || !project) return messages;

  let chain;
  try {
    chain = await getAncestorChain(nodeId, project.path, project.id);
  } catch (e) {
    console.warn('Node Bridge 祖先链构造失败:', e);
    return messages;
  }
  if (chain.depth1.length === 0 && chain.depthPlus.length === 0) return messages;

  const parts: string[] = [];

  // 加载当前节点自身，用于注入自身成果块和压缩记忆
  const current = await loadNodeById(nodeId, project.path);

  // 当前节点自身成果块
  // - 用户手动修正过 → 以用户修正为准，不可随意更改
  // - AI 自动提取 → 前序认定，可引用但非既定前提
  if (current?.outcome) {
    const isUserEdited = current.frontmatter.outcome_user_edited === true;
    if (isUserEdited) {
      parts.push(`## 本节点成果块（已由用户手动修正，请以此为准，不可随意更改）\n\n${renderOutcome(current.outcome)}`);
    } else {
      parts.push(`## 本节点已填写的成果块（你的前序认定，可引用但非既定前提）\n\n${renderOutcome(current.outcome)}`);
    }
  }

  // 当前节点压缩记忆（长对话产物的精炼摘要）
  if (current?.compressedMemory?.trim() && !/^（无|暂无）/.test(current.compressedMemory.trim())) {
    parts.push(`## 本节点压缩记忆（对话超过阈值后的精炼摘要）\n\n${current.compressedMemory.trim()}`);
  }

  // R-12: 直接上游成果块全文（仅 locked 才作为既定前提注入）
  for (const d of chain.depth1) {
    const node = await loadNodeById(d.nodeId, project.path);
    if (node?.frontmatter.outcome_status === 'locked' && node.outcome) {
      // 标题带节点 id（n_ 前缀），供下游成果块引用时写 [来源: n_xxx#q-yyy] 规范来源
      parts.push(`## 上游节点「${d.title}」（n_${d.nodeId}）已锁定成果（既定前提）\n\n${renderOutcome(node.outcome)}`);
    } else if (node?.frontmatter.outcome_status === 'stale') {
      parts.push(`## 上游节点「${d.title}」（警告：上游成果块已变更，此前注入的内容可能过时，请优先调用 intern_search 取最新原文）`);
    } else {
      parts.push(`## 上游节点「${d.title}」（${node ? '成果块未锁定，未注入成果内容' : '无法读取'}）`);
    }
  }

  // R-17: 祖先存在性声明（不注入目录/原文）
  if (chain.depthPlus.length > 0) {
    const lines = chain.depthPlus.map((d) => {
      const statusText = d.outcomeStatus === 'locked' ? '已锁定'
        : d.outcomeStatus === 'stale' ? 'stale（上游已变更）'
        : (d.outcomeStatus || '未知');
      return `  ${d.nodeId}「${d.title}」· ${statusText} · ${(d.updatedAt || '').slice(0, 10)}`;
    });
    const truncatedNote = chain.truncated > 0 ? `\n  （另有 ${chain.truncated} 个更早祖先）` : '';
    parts.push(
      `上游祖先（非直接父，内容未注入）：\n${lines.join('\n')}${truncatedNote}\n需要时调用 read_manifest(node_id) 查看目录，再调用 intern_search 取原文。`,
    );
  }

  // Step 9: 托管模型自动派发实习生（无工具能力 → 后端自动取回，输出同样带 [原始对话·未认定]）
  if (isManagedModel) {
    const auto = await autoDispatchIntern(messages, chain, nodeId, project);
    if (auto) parts.push(auto);
  }

  parts.push(UPSTREAM_GUIDE_PROMPT);
  let injection = '\n\n' + parts.join('\n\n');

  // R-14: 上下文超长时自动回退（方案 C），不静默截断、也不直接拒绝
  // 策略：对话历史过大 → 从最旧开始成对丢弃（user+assistant），保留 system（含压缩记忆）+ 最近轮次；
  //       仅上游注入本身过大（无法裁剪对话解决）时才拒绝并给出可操作提示。
  const totalLen = messages.reduce(
    (s, m) => s + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  ) + injection.length;
  const contextGate = contextGateForContext(contextWindow);
  if (totalLen > contextGate) {
    const gateForMessages = contextGate - injection.length;
    if (gateForMessages <= 0) {
      // 注入部分已占满闸值：对话裁剪救不了，必须用户侧拆节点/减少上游
      throw new Error(`R-14 上游注入后上下文超长（约 ${Math.round(totalLen / 1000)}k 字符，当前模型闸值约 ${Math.round(contextGate / 1000)}k），且主要为上游/成果块注入占用，无法自动裁剪对话。请拆分节点或减少上游关联后再试。`);
    }
    // 从最旧开始成对丢弃 user+assistant，直到 ≤ 闸值的 80%（至少保留最近 2 轮 + 当前轮）
    const target = Math.floor(gateForMessages * 0.8);
    const originalMessages = messages;
    let trimmed = messages;
    let len = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
    while (trimmed.length > 4 && len > target) {
      if (trimmed[0]?.role === 'user' && trimmed[1]?.role === 'assistant') {
        trimmed = trimmed.slice(2);
      } else {
        trimmed = trimmed.slice(1);
      }
      len = trimmed.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
    }
    // ===== 缓存感知压缩（R-14-C）=====
    // 被裁轮次 → 增量压缩进节点记忆并推进 memory_compacted_until（持久化）：
    //   - 信息不丢：压缩记忆兜底被裁内容（模型仍可读）；
    //   - 前缀稳定：下一轮前端 compactedUntilRef 读到新游标 → 跳过这些轮次不再发送 →
    //     请求前缀与裁剪后一致 → 命中 DeepSeek 前缀缓存（否则每轮重新裁剪、前缀漂移、全价重算）。
    const trimmedTurns = extractTrimmedTurns(originalMessages, trimmed);
    // 缓存稳定化：压缩记忆不混入 system injection（会改 system 字节 → 缓存头整段失效），
    // 改为收集后 prepend 到当前轮最后一条 user 消息（尾部变化保头缓存，见下方注入点）
    let compactedMemoryInjection = '';
    if (trimmedTurns.length > 0) {
      try {
        const newMemory = await compactTrimmedHistoryForCache(nodeId, project, trimmedTurns, taskId, eventLog);
        if (newMemory) {
          compactedMemoryInjection = '\n\n## 本节点压缩记忆（本轮裁剪后更新）\n\n' + newMemory.trim();
        }
      } catch (e) {
        console.warn('[R-14-压缩] 被裁轮次压缩失败，已降级为直接裁剪:', e instanceof Error ? e.message : String(e));
      }
    }
    console.warn(
      `[R-14] 上下文超长自动回退：对话从 ${messages.length} 条裁剪到 ${trimmed.length} 条（约 ${Math.round(len / 1000)}k / 闸值 ${Math.round(contextGate / 1000)}k）。被裁剪的旧对话由压缩记忆+成果块兜底，模型可 intern_search 按需检索。`,
    );
    messages = trimmed;

    // 缓存稳定化：压缩记忆 prepend 到当前轮最后一条 user 消息（与技能上下文/思考指令同策略），
    // 而非注入 system——system 字节一旦变化，缓存头整段失效，历史缓存全部作废。
    // 本轮即生效：裁剪后 system 不变、历史已收敛，本轮请求即可命中缓存。
    if (compactedMemoryInjection) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        const prev = last.content || '';
        messages[messages.length - 1] = { ...last, content: compactedMemoryInjection + '\n\n' + prev };
      } else {
        // 兜底：最后一条不是 user（历史重放等边界）→ 追加一条 user 消息，仍不进 system
        messages.push({ role: 'user', content: compactedMemoryInjection });
      }
    }
  }

  // 缓存前缀稳定化（C8）：上游成果块 / 本节点成果块 / 压缩记忆 / 祖先声明属于「低频变化」
  // 动态内容（上游锁定/修改、成果块更新、压缩发生都会变）。不再追加到 system——system 字节
  // 一旦变化，缓存头整段失效，作废所有下游节点请求的前缀缓存。改为 prepend 到当前轮最后
  // 一条 user 消息（每轮必 miss 段，不影响历史缓存）；与技能上下文/思考指令/上游摘要同策略。
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const prev = last.content || '';
    messages[messages.length - 1] = { ...last, content: injection + '\n\n' + prev };
  } else {
    // 兜底：最后一条不是 user（历史重放等边界）→ 追加一条 user 消息，仍不进 system
    messages.push({ role: 'user', content: injection });
  }
  return messages;
}

/** Step 9：托管模型自动派发——命中关键词交集 ≥2 的祖先节点自动跑一次实习生并入 system */
async function autoDispatchIntern(
  messages: ChatMessage[],
  chain: Awaited<ReturnType<typeof getAncestorChain>>,
  currentNodeId: string,
  project: Awaited<ReturnType<typeof getCurrentProject>>,
): Promise<string | null> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser || typeof lastUser.content !== 'string') return null;
  const queryTerms = extractKeywords(lastUser.content, 12);
  if (queryTerms.length === 0) return null;

  const ancestors = [...chain.depth1, ...chain.depthPlus];
  const outs: string[] = [];
  for (const anc of ancestors) {
    const manifest = await readManifest(anc.nodeId, project.path);
    if (!manifest) continue;
    let maxHit = 0;
    for (const entry of manifest.sections) {
      const n = matchTerms(queryTerms, entry.keywords).size;
      if (n > maxHit) maxHit = n;
    }
    if (maxHit >= 2) {
      const res = await internSearchNode(
        { targetNodeId: anc.nodeId, instruction: lastUser.content, maxResults: 3 },
        project.path,
        project.id,
        currentNodeId,
      );
      if (res.status === 'found') {
        outs.push(`[实习生自动检索 · 节点「${res.sourceTitle}」]（${res.disclaimer}，引用时须标 [存疑]）：\n${res.content}`);
      }
    }
  }
  return outs.length > 0 ? outs.join('\n\n') : null;
}

/** 检查是否重复调用同一工具+相同参数 */
function isDuplicateCall(
  toolName: string,
  args: Record<string, unknown>,
  history: Array<{ toolName: string; arguments: Record<string, unknown> }>,
): boolean {
  const argKey = JSON.stringify(args);
  const count = history.filter(
    (h) => h.toolName === toolName && JSON.stringify(h.arguments) === argKey,
  ).length;
  return count >= MAX_DUPLICATE_CALLS;
}

/** DeepSeek V4 硬上下文上限（deepseek-harness C7）：2^20 = 1,048,576 tokens */
const DEEPSEEK_MAX_CONTEXT_TOKENS = 1_048_576;

/** C7 前置校验用的输入 token 估算：CJK 为主的文本 ≈ 1 字 0.6~1 token，取 1/2.5 保守偏大防误判 */
function estimateMessagesTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    const tc = (m as unknown as { tool_calls?: unknown[] }).tool_calls;
    if (Array.isArray(tc)) chars += JSON.stringify(tc).length;
  }
  return Math.ceil(chars / 2.5);
}

/**
 * 上下文占用 Meter（dsh ContextMeter）：按 系统 / 对话 分组估算消息占用，
 * 工具定义（toolDefs 序列化）单独估算 —— 三者之和即本轮请求的上下文总量。
 * 与 estimateMessagesTokens 同口径（字符数 / 2.5），供前端圆环 + 明细弹窗展示。
 */
function estimateContextBreakdown(
  messages: ChatMessage[],
  toolDefs: unknown[],
): { systemTokens: number; conversationTokens: number; toolsTokens: number } {
  let systemChars = 0;
  let convoChars = 0;
  for (const m of messages) {
    let chars = typeof m.content === 'string' ? m.content.length : 0;
    const tc = (m as unknown as { tool_calls?: unknown[] }).tool_calls;
    if (Array.isArray(tc)) chars += JSON.stringify(tc).length;
    if (m.role === 'system') systemChars += chars;
    else convoChars += chars;
  }
  return {
    systemTokens: Math.ceil(systemChars / 2.5),
    conversationTokens: Math.ceil(convoChars / 2.5),
    toolsTokens: Math.ceil(JSON.stringify(toolDefs ?? []).length / 2.5),
  };
}

/**
 * 模型请求限流/瞬时故障的重试策略（deepseek-harness 限流稳健化）：
 * DeepSeek 官方 API 并发受限时返回 429，网关/代理偶发 5xx 与网络层抖动也常见。
 * 直接报错会让整轮任务失败、用户需重发整个对话——改为在「请求建立阶段」指数退避重试。
 * 边界：
 *  - 仅在请求发出但尚未收到任何流式块（create() 抛错）时重试；流中途断开不重试
 *    （工具可能已执行，重放会重复副作用）。
 *  - 只重试可恢复错误：429 / 5xx / 网络层错误；4xx 业务错误（401/402/404 等）与
 *    用户主动 Abort 不重试，直接上抛。
 */
const COMPLETION_MAX_ATTEMPTS = 3;
const COMPLETION_RETRY_BASE_MS = 1000;
const COMPLETION_RETRY_CAP_MS = 8000;

/**
 * 工具循环思考降级（item 4）的降级表已收敛到 src/lib/thinking/policy.ts
 * （executionDowngrade），策略层说明见该文件。
 */

function isRetryableCompletionError(e: unknown): boolean {
  if (typeof e === 'object' && e !== null) {
    // openai SDK 的 APIError 带 status；AbortError 是用户取消，禁止重试
    const err = e as { status?: number; name?: string };
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return false;
    if (typeof err.status === 'number') {
      if (err.status === 429) return true;
      if (err.status >= 500 && err.status < 600) return true;
    }
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/429|rate limit|too many requests/i.test(msg)) return true;
  if (/\b(5\d{2})\b|server error|internal server error|bad gateway|service unavailable|gateway timeout/i.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|timeout of/i.test(msg)) return true;
  return false;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 工具调用参数 JSON 截断修复（deepseek-harness 工具调用修复流水线 / pi-reasonix repair）：
 * 模型长输出时 arguments 可能被 max_tokens 截断（缺右括号/引号/尾逗号）。自动补全：
 * 1) 未闭合字符串补引号；2) 未闭合 {/[ 补右括号；3) 去除尾随逗号；4) JSON.parse 验证。
 * 修复成功返回修复后的字符串，否则 null。
 */
function repairTruncatedJson(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try { JSON.parse(s); return s; } catch { /* 继续尝试修复 */ }
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); out += ch; continue; }
    if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === (ch === '}' ? '{' : '[')) stack.pop();
      out += ch;
      continue;
    }
    out += ch;
  }
  if (inString) out += '"';
  // 补闭合括号前清理尾随逗号（如 {"a":1,"b":2, → {"a":1,"b":2}）
  out = out.replace(/,\s*$/, '');
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  try { JSON.parse(out); return out; } catch { return null; }
}

/**
 * 成本控制（pi-reasonix Pillar 3）：工具结果超长时"保头保尾"压缩再进模型上下文。
 * 默认 3000 tokens 阈值（可感知 ~1/50 缓存价下仍值得省的输入量）；保留开头 + 结尾，
 * 长输出的尾部（错误信息、汇总、末行数据）绝不被静默丢弃，并用显式标记告知模型内容已截断、
 * 需要时按需分片重读。仅压缩进入对话历史（模型付费输入）的副本，工具执行的完整结果仍保留在
 * allToolCalls（供去重/声明校验/前端展示使用）。
 */
const TOOL_RESULT_TOKEN_CAP = 3000;
const TOOL_RESULT_HEAD_RATIO = 0.4;
/** 目录/列表/搜索结果类工具：返回多为多条记录，压缩时按条目（换行）对齐保头部，避免切断单条记录 */
const LIST_LIKE_TOOLS = new Set([
  'read_manifest', 'list_directory', 'search_files', 'web_search',
  'read_todo', 'read_notebook', 'read_raw_inbox', 'read_material', 'read_note_history',
]);

function compactToolResult(result: string, toolName?: string): { text: string; compacted: boolean } {
  if (!result) return { text: result, compacted: false };
  const estTokens = Math.ceil(result.length / 2.5);
  if (estTokens <= TOOL_RESULT_TOKEN_CAP) return { text: result, compacted: false };
  const budgetChars = Math.floor(TOOL_RESULT_TOKEN_CAP * 2.5);
  const headChars = Math.floor(budgetChars * TOOL_RESULT_HEAD_RATIO);
  const tailChars = budgetChars - headChars;

  // 截断点向上/向下对齐到换行符，避免切断半个条目/半行（对法律原文也更安全）
  let head = result.slice(0, headChars);
  const headBreak = head.lastIndexOf('\n');
  if (headBreak > headChars * 0.5) head = head.slice(0, headBreak);

  let tail = result.slice(result.length - tailChars);
  const tailBreak = tail.indexOf('\n');
  if (tailBreak > 0) tail = tail.slice(tailBreak + 1);

  const listLike = toolName ? LIST_LIKE_TOOLS.has(toolName) : false;
  const visibleNote = `可见开头 ${head.length.toLocaleString()} + 结尾 ${tail.length.toLocaleString()} 字符`;
  const omittedHint = listLike
    ? `… [结果过长已压缩：原文约 ${estTokens.toLocaleString()} tokens（${result.length.toLocaleString()} 字符），中间条目已省略，${visibleNote}] …`
    : `… [结果过长已压缩：原文约 ${estTokens.toLocaleString()} tokens（${result.length.toLocaleString()} 字符），${visibleNote}。需完整内容时：必须回到同一个工具，用其上一次返回的 offset 或末尾续读标记分片续读（不同抽取工具如 extract_text/read_article 的字符口径与 offset 互不兼容，勿跨工具混用）] …`;

  const text = `${head}\n\n${omittedHint}\n\n${tail}`;
  return { text, compacted: true };
}

/**
 * 从 reasoning_content 中回收工具调用（deepseek-harness / pi-reasonix scavenge 流水线）：
 * DeepSeek 系模型偶发把工具调用写进思考文本而非结构化 tool_calls。
 * 仅在本轮无结构化 tool_calls 时触发；扫描所有可能是 JSON 对象的起点，
 * 用平衡括号定位完整对象后 JSON.parse，认 {name|tool|function + arguments|args|params} 结构。
 */
function scavengeToolCallsFromReasoning(reasoning: string): Array<{ id: string; name: string; arguments: string }> {
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  const r = reasoning.trim();
  if (!r) return calls;
  for (let i = 0; i < r.length; i++) {
    if (r[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < r.length; j++) {
      const ch = r[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') { depth++; continue; }
      if (ch === '}' || ch === ']') {
        if (depth > 0) {
          depth--;
          if (depth === 0) {
            // 找到平衡的候选 JSON 对象
            const candidate = r.slice(i, j + 1);
            let obj: Record<string, unknown>;
            try { obj = JSON.parse(candidate) as Record<string, unknown>; }
            catch { break; } // 起点非法，放弃该候选
            const name = String(obj?.name ?? obj?.tool ?? obj?.function ?? '').trim();
            const rawArgs = obj?.arguments ?? obj?.args ?? obj?.params;
            if (name && rawArgs !== undefined && rawArgs !== null) {
              const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
              const repaired = repairTruncatedJson(args) ?? args;
              calls.push({
                id: `call_scavenged_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                name,
                arguments: repaired,
              });
            }
            i = j; // 跳过已消费段，避免内部嵌套对象被重复扫描
            break;
          }
        } else {
          break; // 未匹配的闭合括号，放弃该起点
        }
      }
    }
  }
  return calls;
}

/** 是否「结果依赖页面当前状态」的浏览器工具。
 *  这类工具（extract_text / snapshot / wait / navigate / click 等）即使参数相同，
 *  页面跳转后结果也会截然不同，去重必须感知页面变化，否则会误判为「重复调用」。 */
function isPageStateTool(toolName: string): boolean {
  return toolName.includes('browser_');
}

/** 是否 browser.login 工具（BobWork 登录弹窗流程的触发点）。工具名为 MCP fullName（下划线形式）。 */
function isBrowserLoginTool(toolName: string): boolean {
  return toolName === 'browser.login' || /^mcp__.*__browser_login$/.test(toolName);
}

/** 定位 browser.login_fill 的完整工具名（内部专用：登录弹窗凭据回填，不注册给模型）。 */
async function findBrowserLoginFillFullName(): Promise<string | null> {
  try {
    const { mcpManager } = await import('@/lib/mcp/manager');
    const tools = await mcpManager.discoverTools();
    return tools.find((t) => /browser\.login_fill$/.test(t.name))?.fullName ?? null;
  } catch {
    return null;
  }
}

/** 从页面 URL 派生可读站点名（https://www.xiaohongshu.com/explore → xiaohongshu.com） */
function toolDisplaySiteName(url?: string): string {
  try {
    if (!url) return '';
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

/**
 * K1 会话上下文（会话上下文收敛，K 系列第一步，零行为变化 refactor）：
 * 把「每轮工具循环（r0-r19）及其子流程共享的请求级状态」从 ReadableStream.start()
 * 内散落声明归组为一个局部对象字面量 kctx（见 start() 内 `const kctx: KernelContext`）。
 *
 * 收编范围：仅在 start() 闭包内声明、且被工具循环跨轮读写/共享的状态；
 * 收敛只移动声明与读写点，不改任何执行逻辑 / SSE 载荷 / 事件 mark / 退出语义。
 *
 * 明确不在此接口内（保持原地）：
 *  - module 级可变状态：会话 sticky 已随 K2-S2 收敛进 SessionRuntime（src/lib/runtime/session.ts）、
 *    CacheGuard guard 已随 K2-S1 收敛进 ToolRuntime（src/lib/runtime/tools.ts）、
 *    pending 各容器（挂起型接管，保留原地）；
 *  - 请求通道对象：ReadableStream / controller / send / eventLog / taskId；
 *  - 请求级只读配置：level / reasoningEffort / thinkingPolicyConfig / deepseekThinkingMode /
 *    isDeepseekV4 / modelSupportsThinking（声明于 POST 作用域 2976-3013，跨 start() 只读引用，最小 diff）；
 *  - 单轮派生 const：for 自增 round、roundThinkingMode / roundReasoningEffort / thinkingDowngraded /
 *    downgradeDecision / isFinalRound / finalRoundInjection（每轮重新计算，非跨轮共享）；
 *  - 结算期派生：hitRatio / hitTotal / ttftMs / taskDurationMs / tokensPerSec / finalCtx / outputFiles；
 *  - 只读一次计算遥测：prefixSegments / prefixHash（首帧 context_meter 与 done 帧共用，值不变）。
 */
interface KernelContext {
  /** 对话历史落账（结算语义：allToolCalls → conversationMessages → eventLog 三连顺序不变） */
  conversationMessages: ChatMessage[];
  /** 工具调用落账（含执行元数据，供去重 / 声明校验 / tool_summary / output_files 使用） */
  allToolCalls: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
    result: string;
    durationMs: number;
    success: boolean;
    phase?: 'pending' | 'running' | 'done' | 'error';
    kind?: 'tool' | 'mcp' | 'skill';
    systemChange?: boolean;
    changeSummary?: string;
    summary?: string;
    /** 该工具执行时刻的页面 URL 指纹（浏览器工具去重感知页面变化用；非浏览器工具为 null） */
    pageUrl?: string | null;
  }>;
  /** 浏览器工具去重用的「页面 URL 指纹」：browser_active_tab 刷新；页面跳转后变化 → 不误判重复调用 */
  lastPageUrl: string | null;
  /** search_capabilities / load_skill 中途激活场景后置 true → 下一轮请求前重建 loopToolDefs */
  needRebuildTools: boolean;
  /** 完成确认轮只允许一次：已追加过「任务是否真正完成」确认即置 true（防假完成） */
  completionConfirmUsed: boolean;
  /** 声明真实性校验纠偏次数计数（D-B：保持现状仅记录，不引行为变化） */
  claimMismatchCorrections: number;
  /** 停滞保护：连续无实质进展轮数（≥ STALL_LIMIT → 强制收尾轮） */
  stallCount: number;
  /** 强制收尾轮：置 true 后下一轮不带 tools，模型基于注入的收尾说明直接输出最终回答；lite 首轮即收尾 */
  forceFinalRound: boolean;
  /** OCR 重试预算门控：已触发后不再重复注入「停止重试」指令 */
  ocrBudgetExceeded: boolean;
  /** 工具循环思考降级遥测：执行轮降级计数（对照 done hitRate 判断 thinking 降级是否影响缓存命中） */
  thinkingDowngradedRounds: number;
  /** 模型调用总轮数（done 结算 rounds 字段 / TURN_END） */
  totalRounds: number;
  /** 跨轮累计本次任务真实 token 消耗（cacheHit/cacheMiss：DeepSeek 前缀缓存遥测 §4.4） */
  taskUsage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; calls: number };
  /** 整轮任务开始时刻（首轮模型调用之前；TTFT = firstTokenMs - taskStartMs） */
  taskStartMs: number;
  /** 首个 content/reasoning 块到达时刻 */
  firstTokenMs: number | null;
  /** 本轮开始前的 homework/ 目录快照（结束时比对出新产出，兜底输出卡片） */
  homeworkSnapshot: Map<string, number> | null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      messages: ChatMessage[];
      nodeId?: string;
      modelId?: string;
      thinking?: 'enabled' | 'disabled';
      temperature?: number;
      apiKey?: string;
      baseUrl?: string;
      providerModelId?: string;
      thinkingLevel?: ThinkingLevel;
      forcedSkills?: string[];
      /** 节点"强制使用"MCP（复选框）：无视场景/画像过滤保留该 MCP 工具；仅对 Store 中 enabled 的 server 生效；缺省/空 = 跟随全局 */
      enabledMcpIds?: string[];
      /** Agent 标识（chat | coding）：决定工具画像与专项 prompt（见 @/lib/agents/profiles） */
      identity?: AgentId;
      /** 显式指定项目上下文（如 wanted 临时问答），仅本次请求生效，不切换全局当前项目 */
      projectId?: string;
      /** 沙盒模式（如 wanted Node 模式）：过滤写类工具，禁止 AI 产生文件/待办/日历等副作用 */
      sandbox?: boolean;
      /** 轻量单轮问答（Bob WebBridge 侧边栏等外部客户端）：跳过工具循环，模型直接基于上下文回答 */
      lite?: boolean;
      /** 续写请求携带的初始产物（如模板填充面板生成的文件），补进本轮 output_files 卡片 */
      initialOutputFiles?: OutputFileItem[];
    };
    const {
      messages,
      nodeId,
      modelId,
      thinking,
      temperature,
      thinkingLevel,
      forcedSkills,
      enabledMcpIds,
      identity,
      projectId,
      sandbox,
      lite,
      initialOutputFiles,
    } = body;
    const initialUserInput = extractLastUserContent(messages);
    // Agent 配置（AGENT_PROFILES + 覆盖项）：决定工具画像、场景策略与专属 prompt（chat 通用 / coding 专项）。
    // 专项 agent 被禁用 → 回退 chat；自定义 prompt → 覆盖 baseSystemPrompt
    const profile = await resolveAgentProfile(identity);
    // 模型三件套：允许外部 HTTP 客户端（如 WebBridge AI 侧边栏）省略，由服务端兜底解析
    let { apiKey, baseUrl, providerModelId } = body;

    // 兜底解析：
    //  - providerModelId 形如 "provider:modelId" → 从已配置 providers 按供应商解析 apiKey/baseUrl
    //  - 未显式指定 → P3-3b：先按请求 identity 查 agentModels 专属池（resolveAgentRoleModel），
    //    再回退默认聊天模型（resolveTaskModel）——与前端 Auto/默认选路一致
    //  - 显式指定但供应商未配置 → 明确 400（不悄悄降级默认模型，避免用户以为选模型已生效）
    if (!apiKey || !baseUrl || !providerModelId) {
      const resolved = providerModelId
        ? await resolveProviderModel(String(providerModelId))
        : ((await resolveAgentRoleModel(profile?.id ?? identity))
            ?? (await resolveAutoTaskModel(messages))
            ?? (await resolveTaskModel()));
      if (resolved) {
        apiKey = resolved.apiKey;
        baseUrl = resolved.baseUrl;
        providerModelId = resolved.model;
      } else if (providerModelId) {
        const pname = String(providerModelId).split(':')[0];
        return new Response(
          JSON.stringify({ error: `Provider "${pname}" is not configured (missing API key). Please configure it in BobWork Manage Models first.` }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    // P3-3b2：SSE model 通知用的 `provider:modelId` 标签（供外部客户端与消息落盘用）。
    // provider 类型按 apiKey 在已配置 providers 中反查；查不到（自定义 baseUrl 直配）则用裸 providerModelId。
    const providersForModelTag = (await readSettingsFromFile().catch(() => null))?.providers ?? [];
    const modelTagProvider = providersForModelTag.find((p) => p.apiKey === apiKey)?.type ?? '';
    const modelTag = providerModelId
      ? (modelTagProvider ? `${modelTagProvider}:${providerModelId}` : providerModelId)
      : undefined;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'messages is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // forcedSkills 规范化（去空值）。DSH 模式：仅用户手动勾选的技能直接注入 L2 正文；
    // 其余技能由模型按需 load_skill 加载，不再按关键词自动匹配注入。格式禁令在
    // BASE_SYSTEM_PROMPT 每轮常驻，保证不退回老画法。
    const mergedForcedSkills: string[] =
      (Array.isArray(forcedSkills) ? forcedSkills : []).filter(
        (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0,
      );

    const hasUserMessage = messages.some((m) => m.role === 'user');
    if (!hasUserMessage) {
      return new Response(
        JSON.stringify({ error: 'At least one user message is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 注入思考深度系统提示
    const level: ThinkingLevel = thinkingLevel ?? 'medium';
    const reasoningEffort = REASONING_EFFORT_MAP[level];

    const thinkingEnabled = thinking ?? 'enabled';

    // Phase 2 策略层抽取（默认行为一致）：思考档位决策开关读 settings.thinking，缺省两开关均开。
    // 读取发生在思考决策前（settingsForTools 于 isCustom 分支内才加载，此处无法复用其作用域）
    const thinkingSettings = await readSettingsFromFile();
    const thinkingPolicyConfig: ThinkingPolicyConfig = {
      downgradeOnExecution: thinkingSettings.thinking?.downgradeOnExecution !== false,
      trivialPromptOff: thinkingSettings.thinking?.trivialPromptOff !== false,
      injectThinkGuide: thinkingSettings.thinking?.injectThinkGuide !== false,
    };

    // C1（deepseek-harness）：琐碎对话直接关 thinking，避免琐碎轮次白烧 30-300 reasoning tokens
    const trivialPrompt = isTrivialPrompt(messages);

    // 判断当前模型是否支持推理（用于决定是否传 reasoning_effort 参数）
    const isCustom = !!(apiKey && baseUrl && providerModelId);
    // DeepSeek V4 识别：baseUrl 含 deepseek（直连 api.deepseek.com），或模型名含 deepseek + v4
    // （agentplan/ark 等订阅网关模型名即 deepseek-v4-*，baseUrl 不含 deepseek，必须按模型名识别）
    const isDeepseekV4 =
      isCustom && !!providerModelId && /v4/i.test(providerModelId) &&
      (baseUrl?.includes('deepseek') || /deepseek/i.test(providerModelId));

    // R-14 动态闸值依据：按当前请求模型推断 contextWindow（自定义模型优先用 providerModelId，托管用 modelId）
    const requestContextWindow = inferContextWindow(providerModelId || modelId || '', thinking === 'enabled');
    const modelSupportsThinking = (() => {
      if (!isCustom) return thinking === 'enabled';
      // DeepSeek V4：两个模型都支持思考模式
      if (isDeepseekV4) return true;
      // 其他自定义模型：通过模型名判断
      return !!providerModelId && /reason|r1|z1|think|k2/i.test(providerModelId);
    })();

    // DeepSeek V4 使用 thinking_mode 参数（non-thinking/thinking/thinking_max），而非 reasoning_effort。
    // Phase 2 策略层抽取：档位映射收敛到 policy.v4ThinkingModeForLevel（C1 琐碎关思考 + low/medium→thinking、high→thinking_max）
    const deepseekThinkingMode: string | null = isDeepseekV4
      ? v4ThinkingModeForLevel(level, thinkingPolicyConfig, trivialPrompt)
      : null;

    // 上游节点上下文已在前端注入到系统提示中，后端直接使用
    const messagesWithContext = messages;

    // Vision Bridge：自动检测图片附件，用视觉模型描述后注入文本。
    // 首字节前提速：识别不再在此阻塞（此前每张图 × 候选模型串行降级，单次超时 30s+，
    // 多图最坏累计 >90s，前端已在首字节前超时）。改到流内（工具循环前）执行，期间持续发送
    // vision_progress SSE 事件，前端有数据流即重置超时计时器，同时用户可见"正在识别图片"进度。
    const messagesWithVision = messagesWithContext;

    // PDF Bridge：自动检测 PDF 附件，提取文本内容后注入
    let messagesWithPdf = messagesWithVision;
    let currentProjectPath = '';
    let projectRoot = '';
    try {
      const project = await resolveNodeProject(nodeId, projectId);
      if (project) {
        messagesWithPdf = await applyPdfBridge(messagesWithVision, project.path);
        currentProjectPath = project.path.replace(homedir(), '~');
        projectRoot = project.path;
      }
    } catch (e) {
      console.warn('PDF Bridge 执行失败:', e);
    }

    // P4c-1 压缩事件化：eventLog/taskId 提前创建，使 R-14-C 压缩事件（Node Bridge 内发生）与
    // SSE 事件写入同一任务日志（默认行为不变：无压缩时日志仍以 TURN_START 开头）。
    const taskId = genTaskId();
    const eventLog = new EventLog();

    // Node Bridge（v3）：注入上游成果块 + 祖先存在性声明 + 托管模型自动派发实习生
    let messagesWithNodeBridge = messagesWithPdf;
    try {
      const project = await resolveNodeProject(nodeId, projectId);
      if (project) {
        messagesWithNodeBridge = await applyUpstreamNodeBridge(messagesWithPdf, nodeId, project, !isCustom, requestContextWindow, taskId, eventLog);
      }
    } catch (e) {
      // R-14: 注入超长 → 拒绝执行并提示拆分，不静默截断
      if (e instanceof Error && e.message.startsWith('R-14')) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      console.warn('Node Bridge 执行失败:', e);
    }

    // 注入当前项目路径到系统提示，让 AI 知道文档应该写入哪里。
    // 普通节点：统一写 homework/ 根目录（归属由 .ownership.json 清册追踪）。
    const nodeHomeworkDir = 'homework';
    const projectPathInjection = currentProjectPath
      ? `\n\n当前项目路径：${currentProjectPath}\n产出文档默认 .md，用 ${nodeHomeworkDir}/ 前缀相对路径写入（如 write_file(path="${nodeHomeworkDir}/报告.md")），不要写入 homework/.ai-workspace/ 临时工作区。\n【产物声明】写文件成功后，在最终回答末尾另起一行输出 \`OutputFile: ${nodeHomeworkDir}/文件名\`（每行一个），前端据此生成可点击打开的产物卡片；禁止声明未写入或写入失败的路径。\n【模板填充产物路径】模板填充生成的 .docx 保存在 homework/template/ 目录（Finder 可见），读取/检查须用 homework/template/ 前缀。`
      : `\n\n当前没有激活项目：所有相对路径将解析到临时工作区 ~/BobWork/.sandbox。如果你的产出属于某个项目，请提醒用户先在 BobWork 中激活该项目，再把文件写入该项目的 homework/ 目录。`;

    // 注入用户授权目录清单，让 AI 知道除了项目目录外还可以操作哪些本地目录
    let authorizedRootsInjection = '';
    try {
      const authorizedRoots = await getLocalAuthorizedRoots();
      if (authorizedRoots.length > 0) {
        const list = authorizedRoots.map((r) => `- ${r.replace(homedir(), '~')}`).join('\n');
        authorizedRootsInjection =
          `\n\n你已被授权操作的本地目录（与项目目录同级，可读可写）：\n${list}\n` +
          `- 用户明确要求操作某授权目录时，用完整绝对路径在该目录执行；未指定目录时默认当前项目目录\n` +
          `- 最终产出仍统一写入当前项目 ${nodeHomeworkDir}/ 目录（产物声明规则同上），授权目录仅用于读素材和写临时/中间文件，除非用户明确指定"把产出保存到某授权目录"\n` +
          `- 除当前项目目录和上述授权目录外，禁止读写其他本地路径`;
      }
    } catch {
      // 无授权目录时忽略
    }

    // off 模式不注入思考提示；非推理模型去掉 <think> 标签引用
    const effectiveLevel: ThinkingLevel = level;
    const { messages: messagesWithSkill, matchedSkillNames, skillDetails } = injectSkillContext(messagesWithNodeBridge, mergedForcedSkills, profile.id);
    // 基础系统提示按 Agent 隔离：专项 Agent（coding）用自己的专属 base，不背通用 chat 向内容
    const agentBasePrompt = profile.baseSystemPrompt ?? BASE_SYSTEM_PROMPT;
    // Phase 2b（全面 DSH 化）：DeepSeek V4 不再注入思考引导（纯 API thinking_mode 驱动，原生 reasoning），
    // 非 V4 推理模型按 settings.thinking.injectThinkGuide 决定是否注入 <think> 标签引导（默认注入）
    const shouldInjectThink = shouldInjectThinkPrompt(isDeepseekV4, modelSupportsThinking, thinkingPolicyConfig);
    let finalMessages = shouldInjectThink
      ? injectThinkingPrompt(messagesWithSkill, effectiveLevel, modelSupportsThinking, agentBasePrompt)
      : messagesWithSkill;

    // 将项目路径 + 授权目录注入 prepend 到当前轮 user 消息（缓存前缀稳定化 C8）：
    // 属「低频变化」动态内容，不进 system（缓存头），system 只含字节稳定的 BASE_SYSTEM_PROMPT
    const pathContextInjection = projectPathInjection + authorizedRootsInjection;
    if (pathContextInjection) {
      finalMessages = prependDynamicContext(finalMessages, pathContextInjection);
    }

    // 包安装镜像指引 / 工具并行化 / 按需能力提示 已挪进 BASE_SYSTEM_PROMPT（字节固定，吃缓存）。
    // 此处仅保留「低频变化」动态内容（项目路径 / 用户偏好 / OCR 引擎现状）prepend 到 user 消息。

    // ===== 用户偏好注入（全局长期记忆，类型目录模式：只注入目录，完整记录按需 read_preferences 调取） =====
    try {
      const { listPreferences } = await import('@/lib/wanted/preferences');
      const prefs = await listPreferences();
      if (prefs.length > 0) {
        // 类型目录：按 type 分组统计条数（不注入具体内容，节省上下文、避免无关偏好干扰）
        const typeCounts = new Map<string, number>();
        for (const p of prefs) {
          typeCounts.set(p.type, (typeCounts.get(p.type) || 0) + 1);
        }
        const typeLines = Array.from(typeCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `- [${type}] ×${count}`)
          .join('\n');
        const prefInjection = `\n\n## 用户偏好（全局长期记忆，类型目录，按需调取）\n已记录 ${prefs.length} 条偏好，类型目录：\n${typeLines}\n\n当前任务涉及上述某类偏好时（输出格式、引用规范、任务流程、沟通风格等），调用 read_preferences(type) 读取该类完整记录并严格遵守；需要全部记录时调用 read_preferences()。若用户明确要求记住新偏好，调用 remember_preference 写入（可带 type 分类）；遗忘用 delete_preference（按序号）。`;
        // 缓存前缀稳定化：偏好目录属「低频变化」动态内容。若注入 system（缓存头），
        // 用户新增/删除偏好 → system 字节变化 → 前缀整段失效，历史缓存全部作废。
        // 改为 prepend 到当前轮最后一条 user 消息：system + 工具 + 历史前缀保持字节稳定，
        // 偏好变化只影响当前轮 user 消息（本轮内容本就每次不同），历史缓存不受影响。
        finalMessages = prependDynamicContext(finalMessages, prefInjection);
      }
    } catch { /* 偏好读取/注入失败忽略，不影响对话 */ }

    // ===== OCR/视觉引擎事实注入（防 system 硬编码引擎断言与插件真实配置脱节） =====
    // C8 低频通道：与路径/镜像/偏好一致 prepend 到当前轮 user 消息，system 缓存头保持字节稳定
    const ocrEngineFactInjection = buildOcrEngineFactInjection();
    if (ocrEngineFactInjection) {
      finalMessages = prependDynamicContext(finalMessages, ocrEngineFactInjection);
    }

    // ===== AI Coding 编程上下文注入 =====
    // 节点 frontmatter 带 sandbox_app_id 时，注入小程序编程任务上下文：
    // 告知写入路径（bob-sandbox/apps/<id>/ 相对路径）、文件读取方式、预览截图自检闭环。
    let sandboxCodingInjection = '';
    // 供工具循环注入：当前节点关联的 bob-sandbox appId（Coding 节点所有写入强制落 bob-sandbox/apps/，不落 homework）
    let toolLoopSandboxAppId: string | undefined;
    if (nodeId) {
      try {
        const project = await resolveNodeProject(nodeId, projectId);
        const node = project ? await loadNodeById(nodeId, project.path) : null;
        const sandboxAppId = node?.frontmatter?.sandbox_app_id;
        if (sandboxAppId && typeof sandboxAppId === 'string') toolLoopSandboxAppId = sandboxAppId;
        if (sandboxAppId && typeof sandboxAppId === 'string') {
          const entry = await readAppEntry(sandboxAppId);
          if (entry) {
            const appName = entry.app.name || sandboxAppId;
            // 首轮判定：没有任何真实对话轮次 → 可能是首轮。
            // 真实轮次 = 去除 answer 为 __BAI_INITIAL_PROMPT_PLACEHOLDER__ 的"创建节点时预填需求占位"
            const INIT_PLACEHOLDER = '__BAI_INITIAL_PROMPT_PLACEHOLDER__';
            const isFirstRound =
              !Array.isArray(node?.conversations) ||
              node.conversations.filter((c: any) => typeof c?.answer !== 'string' || c.answer !== INIT_PLACEHOLDER).length === 0;
            // Spec 采集豁免：小程序已存在真实实现（index.html 非内置模板初始内容）时，
            // 新建节点对已有小程序的修改不强制采集 Spec——直接读现有文件按本次指令修改。
            // 仅"从零新建（无实现）"的首轮才强制走 6 问题采集。
            const appHasImpl = isFirstRound ? await hasAppImplementation(sandboxAppId) : true;
            const requireSpec = isFirstRound && !appHasImpl;
            sandboxCodingInjection =
              `\n\n=== AI Coding 编程任务上下文 ===\n` +
              `你正在为一个 Bob Sandbox 小程序「${appName}」（appId: ${sandboxAppId}）进行 AI 编程开发。\n` +
              (requireSpec
                ? `\n【首轮引导：先采集 Spec，不写代码 —— 仅"从零新建"的首轮强制执行，后续轮次跳过】\n` +
                  `这是该节点的首轮对话（还没有任何 Q&A 记录），且该小程序还没有任何真实实现（仍为内置模板初始状态）。用户通常无法一次性清晰描述需求，你必须先采集结构化的设计规格（Spec），绝不能直接写代码。\n` +
                  `方法：调用 ask_user_questions 工具并把以下 6 个问题一次性放入其 questions 数组（宿主会弹出结构化表单，用户提交后答案会作为工具结果返回给你，进入下一轮生成）。每个问题元素格式：{ id: string, question: string, options: string[], allowCustom: boolean }。\n` +
                  `必须询问的 6 个问题（id 用 spec_0 到 spec_5）：\n` +
                  `  spec_0: 小程序的核心功能是什么？（用户用一句话描述后，AI 自行归纳为 1 句话写入目标定位）\n` +
                  `         options 示例：["待办/任务管理","表单填写与数据收集","数据图表/大屏展示","计算/换算工具","信息/文档阅读器","个人主页/作品集页","营销/产品落地页","倒计时/打卡/习惯追踪","AI 智能问答/内容生成","其他（自定义）"]\n` +
                  `  spec_1: 目标使用场景和人群？allowCustom: true\n` +
                  `         options 示例：["个人日常使用","工作效率工具","面向客户展示","小组/团队协作","学习/备考工具","法律/医疗等专业场景","其他（自定义）"]\n` +
                  `  spec_2: 主要交互呈现方式？\n` +
                  `         options 示例：["表单输入 + 结果展示","列表 + 增删改查","图表 + 可视化","单页卡片式展示","对话式交互","多页导航","其他（自定义）"]\n` +
                  `  spec_3: 数据是否需要持久化（关闭再打开仍保留）？\n` +
                  `         options 示例：["需要，历史记录/重要数据必须保留（用 BobStorage.save）","仅本次会话临时保存即可（用 BobStorage.set）","不需要，每次打开重新开始"]\n` +
                  `  spec_4: 视觉风格偏好？allowCustom: true\n` +
                  `         options 示例：["极简清爽（大量留白、轻量边框）","专业商务（稳重配色、层次清晰）","活泼多彩（渐变、丰富视觉）","仿纸质（米色背景、手写风格）","跟随 BobWork 主题默认（推荐，自动适配明暗）"]\n` +
                  `  spec_5: 是否需要接入 AI 能力（模型调用）？\n` +
                  `         options 示例：["不需要，纯工具型小程序即可","需要，我稍后会说明细节","请按功能判断是否需要并询问我"]\n` +
                  `要求：\n` +
                  `  - 6 个问题全部通过 ask_user_questions 工具提供，不要自由提问；\n` +
                  `  - 正文开头先写一句话引导语（如「为了更准确地生成你想要的小程序，请先填写以下 6 个简单问题：」），然后紧接着调用 ask_user_questions 工具弹出表单；\n` +
                  `  - 正文禁止输出任何代码、伪代码或"我来写吧"等跳过采集的声明；\n` +
                  `  - 若用户在首轮消息里已明确写出需求（例如有具体功能点），请基于其描述自动预填/归纳各选项，仍调用 ask_user_questions 让用户确认或修改，不能省略采集。\n`
                : (isFirstRound
                  ? `\n【首轮引导：已有实现，修改模式 —— 不采集 Spec，直接动手】\n` +
                    `这是该节点的首轮对话，但小程序「${appName}」已存在真实实现（非模板初始状态）。用户意图是对现有小程序进行修改/升级，不要弹出需求采集表单。\n` +
                    `正确做法：先用 read_file / list_files 读取 bob-sandbox/apps/${sandboxAppId}/ 下的现有文件（尤其 index.html / manifest.json / smoke-test.js），了解当前实现与功能后，直接按用户本次输入执行修改；修改后按下方【主动测试分级引导】自检。\n` +
                    `若用户输入仅提到具体改动点（如"把引擎换成 xxx"），针对该点精确修改，不要重构无关部分，也不要重新收集需求。\n`
                  : '')) +
              (requireSpec
                ? `\n【交底方案 · 分级自适应（收到用户 spec 答案后执行一次，进入写码阶段后不再重复）】\n` +
                  `当你从首轮 ask_user_questions 的结果中拿到用户提交的 6 项 spec 答案后的第一轮，先判定复杂度再行动：\n` +
                  `  1.【复杂度判定】\n` +
                  `     - 复杂任务（满足任一即算复杂）：多页面/多视图导航；功能模块 ≥ 3 个；含数据可视化/图表/大屏；多步骤表单流程；需对接多个 Bridge API 或复杂数据模型\n` +
                  `     - 简单任务：单屏、纯展示或单一功能工具（计算器、倒计时、单位换算、单表单提交、简单信息展示等）\n` +
                  `  2.【复杂任务 → 先方案后代码】\n` +
                  `     - 先在正文输出交底方案：① 一句话目标定位 ② 功能模块清单（标注优先级）③ 页面结构（每页布局与关键交互）\n` +
                  `     - 然后调用 write_file 生成 HTML 原型稿 bob-sandbox/apps/${sandboxAppId}/mockup.html：用真实 CSS 搭出与最终一致的结构与配色（样式必须自包含——直接写具体色值即可，mockup.html 走静态文件路由、不经宿主注入，不要依赖 var(--primary) 等宿主主题变量），示例数据填充内容；页面间跳转/按钮用简单 JS 切换即可，不实现真实业务逻辑\n` +
                  `     - 正文附上原型预览地址（完整地址，禁止 localhost:PORT 占位符）：http://localhost:${process.env.PORT || '8321'}/api/sandbox/preview/${sandboxAppId}/mockup.html，并请用户确认或提出修改\n` +
                  `     - 根据用户反馈迭代 mockup.html，直到用户明确确认后，再删除 mockup.html（用 delete_file）并开始编写真实功能代码\n` +
                  `  3.【简单任务 → 直接写码】\n` +
                  `     - 正文用两三句话简述将实现的功能与页面布局（不生成 mockup.html），然后直接按 spec 开始写代码\n` +
                  `  4.【清理】mockup.html 是设计稿不是交付物：用户确认并进入写码后必须删除（delete_file），保持 bob-sandbox/apps/${sandboxAppId}/ 下只留真实交付文件\n`
                : `\n【修改已有实现 · 直接动手】\n` +
                  `本次是对已有小程序的修改：无需交底方案，也禁止生成 mockup.html 原型稿。直接按用户本次指令修改现有文件；改动点较多时可在正文用两三句话简述将改动哪些位置。修改后按下方【主动测试分级引导】自检。\n`) +
              `- 该小程序的全部代码文件位于应用数据目录 bob-sandbox/apps/${sandboxAppId}/ 下，写入与修改一律使用相对路径 bob-sandbox/apps/${sandboxAppId}/<文件名>（例如 bob-sandbox/apps/${sandboxAppId}/index.html）。\n` +
              `- 【硬性规则】本节点的所有产物（HTML/JS/CSS 等）必须且只会落在 bob-sandbox/apps/${sandboxAppId}/ 内（宿主已强制：即使误用 homework/ 或裸文件名路径，也会自动重定向到该小程序目录），禁止在正文声称写入 homework/ 或任何项目目录；小程序全局存储是刻意设计——删除节点/项目后小程序依然保留\n` +
              `- 预览地址（如需用 browser.navigate 在真实浏览器中打开验证，必须使用此完整地址，禁止写成 localhost:PORT 占位符；端口为当前 BobWork 服务端口，写死替换即可）：${`http://localhost:${process.env.PORT || '8321'}/api/sandbox/preview/${sandboxAppId}`}\n` +
              `- 动手前先用 read_file / list_files 读取该目录现有文件，了解当前实现后再修改\n` +
              `- 第三方库引入：小程序可直接用 CDN 引入常用库（如 <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>、<script src="https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js"></script>、<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script> 等）。预览 CSP 已放开 http/https 外链，可直接使用；导出独立页面（sandbox_export）时 CDN 外链会自动保留。优先选用体积小、无需构建的 UMD 版本，不要自己手写复杂的图表/日期逻辑\n` +
              `- 主动测试分级引导（修改后按序自检，直到符合用户要求）：\n` +
              `  1.【视觉自检·每轮必做】每完成一轮代码修改，立即调用 capture_preview 截取预览效果图（真实 headless Chromium 渲染，视觉模型描述渲染结果），检查布局/样式/配色是否符合预期；发现视觉问题直接继续修改，不要进入下一步\n` +
              `  2.【交互测试·改动涉及交互时 + 每轮交付前的最小冒烟】视觉自检无法验证交互时序（点击、表单、跳转、状态切换、持久化）。此时调用 interact_preview 工具在真实浏览器内做交互测试：传 target（app 预览地址或 HTML 路径）与 script，脚本在页面全局作用域执行（document/window 可用），可模拟点击（el.click()）、填表（el.value=... 并派发 input 事件）、跳转、状态切换，并用 DOM 断言（querySelector 检查弹窗/按钮状态/渲染数据）验证结果，通过 window.__testResult = {...} 返回结构化结果；工具会捕获 console 日志（LOG/WARN/ERR）并截图，脚本异常会以 SCRIPT ERROR 报出。交互 bug（按钮无响应/表单不拦截/状态不保存）只有真实运行时才能暴露，禁止仅用截图代替\n` +
              `  2b.【冒烟脚本持久化·每轮交付前必做】把最小冒烟脚本（点击主入口 + 断言核心元素渲染 + 检查无 ERR 日志）保存到 bob-sandbox/apps/${sandboxAppId}/smoke-test.js（首次写好即可，后续轮次用 read_file 读取直接复用，不要每次重写）。每轮交付给用户前，必须用 interact_preview 执行一次该最小冒烟，确认应用可用、无 console 错误\n` +
              `  3.【逻辑测试·涉及计算/数据处理时】用 run_command / execute_script 写脚本校验计算结果与边界值（如金额计算、日期处理、表单必填校验），不要在脑子里算\n` +
              `- 任一层发现问题 → 修改代码 → 重新从第 1 步自检，循环直至全部通过\n` +
              `- 本节点的最终交付物就是这个小程序本身，无需在 homework/ 下额外生成说明文档（除非用户明确要求）；交底方案与 HTML 原型稿只在对话流与 mockup.html 中呈现，用户确认后即清理，不落盘为独立文档\n` +
              `\n【manifest.json 字段说明（可选）】\n` +
              `小程序的 manifest.json 在 bob-sandbox/apps/${sandboxAppId}/manifest.json，默认包含以下字段，修改后立即生效（无需重启）：\n` +
              `  - aiBadge: boolean (默认 true) —— 宿主是否在小程序预览右上角自动注入 AI 状态胶囊徽章。\n` +
              `    * 默认注入：绿点（已授权调用模型）/灰点（未授权，点击可申请），无需小程序代码干预。\n` +
              `    * 若小程序 UI 自带模型绑定状态展示（如自定义开关徽章），或右上角有自有按钮会遮挡，主动设为 false 关闭宿主注入，用自定义 UI 配合 BobWork.request('chatGetPermission') / 'chatRequestPermission' 自行管理。\n` +
              `\n=== BobWork Host Bridge API（亲儿子待遇：主动对接、深度融合） ===\n` +
              `\n【小程序定位 — BobWork 亲儿子功能组件】\n` +
              `小程序是 BobWork 原生功能组件，不是外部"外勤物种"。鼓励主动对接主程序资源（WANTED 待办、节点、主题、模型、技能、项目、日历等），让小程序成为用户在 BobWork 中的信息门户和工作面板，而非孤立的独立页面。\n` +
              `只要功能合理且不会误操作，直接在代码中调用 Bridge API 即可，不需要等待用户明确要求。\n` +
              `\n【持久化 API — 默认允许主动使用】\n` +
              `以下为小程序自身的持久化能力（私有数据），用户提到"加持久化"、"保存记录"、"关掉再打开还在"、"恢复上次状态"、"存历史记录"等场景时，应主动使用，无需用户额外说明：\n` +
              `  （小程序 iframe 运行时已全局注入 window.BobStorage 对象，直接调用即可）\n` +
              `  - BobStorage.set(key, value)  → 浏览器端 localStorage，自动加 appId 前缀隔离，关闭 BobWork 清空浏览器缓存会丢失\n` +
              `  - BobStorage.get(key)         → 读取上条，返回解析后的值或 null\n` +
              `  - BobStorage.remove(key)      → 删除上条\n` +
              `  - BobStorage.listLocalKeys()  → 列出该小程序在 localStorage 中所有的 key\n` +
              `  - BobStorage.save(key, value) → 写入磁盘私有数据目录 ~/BobWork/bob-sandbox/apps/<appId>/data/<key>.json，真正持久化，重启/升级/重装均保留，推荐用于历史记录、长存档、表单完整状态等需要跨重启保留的数据\n` +
              `  - BobStorage.load(key)        → 读取磁盘私有数据目录，返回解析后的值或 null\n` +
              `  - BobStorage.listDiskKeys()   → 列出磁盘私有数据目录下所有 key\n` +
              `  - BobStorage.deleteKey(key)   → 删除磁盘私有数据目录下某 key\n` +
              `  选择原则：表单临时状态/UI 偏好 → 用 set/get（快，不需要等待 Promise）；历史记录/长存档/重要数据 → 用 save/load（写入磁盘，跨重启保留）。\n` +
              `\n【主程序共享资源 API — 鼓励主动对接，只读接口默认自由使用】\n` +
              `小程序作为 BobWork 亲儿子组件，默认鼓励主动调用以下 Bridge 只读接口读取主程序资源，打造信息门户/工作面板类体验：\n` +
              `  - WANTED 系列：readWantedTodo（待办看板）、readWantedNotebook（个人记录索引）、readWantedPreferences（偏好配置）—— 做全局待办面板、个人偏好驱动 UI 等场景直接用\n` +
              `  - 节点信息系列：listNodes、readNode、getNodeAncestorChain、getNodeManifest —— 做节点导航/检索/目录页等场景直接用\n` +
              `  - 技能与模型：searchSkills、listConfiguredModels —— 做能力缺口检测、模型选择 UI 等场景直接用\n` +
              `  - 项目与配置：listProjects、getAppConfig、getProjectInfo、getTheme —— 做项目切换、主题适配、总览仪表盘等场景直接用\n` +
              `  - 日历提醒：listCalendarEvents —— 做今日日程/待办提醒面板直接用\n` +
              `  - 写入类接口（writeWanted）：仍需用户明确提及"写入 wanted"场景才使用，避免误写全局交付目录\n` +
              `  - 通过注入的 window.BobWork.request(action, data) 调用：\n` +
              getBridgeActionsText() + '\n' +
              `  - 调用示例：const nodes = await BobWork.request('listNodes', {}); const todo = await BobWork.request('readWantedTodo', {});\n` +
              `  - 运行时可用 BobWork.listActions() 查询所有可用操作` +
              `\n【画布对接 API（GraphGateway，太空舱对接协议）— 需要对接画布时主动申请授权】\n` +
              `graph* 系列动作用于小程序对接主程序画布（如"节点地图"、"画布操控面板"、"节点导航器"等需求）。规则：\n` +
              `  1. 小程序核心功能涉及画布操作/浏览时，主动申请授权，不要等用户反复要求；\n` +
              `  2. 使用前调用 BobWork.request('graphRequestPermission', { level: 'read'|'control' }) 申请授权：\n` +
              `     - read = 只读（graphGetSnapshot）；control = 可读可操作（展开、移动、选中节点）；\n` +
              `     - 宿主会弹出确认框由用户授予，用户拒绝或未授权时返回 level: 'none'；\n` +
              `  3. 未获授权就调用其他 graph* 动作会失败（Promise reject），代码应 catch 并给出友好提示（如"未获得画布访问权限，请先授权"），不得用 alert；\n` +
              `  4. 可先用 BobWork.request('graphGetPermission', {}) 查询当前授权级别，避免无谓申请。\n` +
              `\n【小程序模型调用 API（chat）— 需先获授权，AI 原生体验放开】\n` +
              `chat* 系列动作用于让小程序直接调用 AI 模型（无工具、纯文本裸对话，与节点对话不同——模型没有文件/工具权限）。规则：\n` +
              `  1. 使用前必须先调用 BobWork.request('chatRequestPermission', {}) 申请授权：宿主会弹出确认框由用户授予；\n` +
              `     可先用 BobWork.request('chatGetPermission', {}) 查询当前是否已授权，避免无谓申请；\n` +
              `  2. 调用示例：const res = await BobWork.request('chat', { messages: [{ role: 'user', content: '...' }], maxTokens: 4096 });\n` +
              `     - model 参数可省略：默认走 Auto 模式（系统自动从已配置模型池里选可用模型，优先已勾选模型）；\n` +
              `     - 如需显式指定，格式 provider:modelId，只要 provider 已配置 API Key 即可使用（不限 selectedModels 勾选范围）；\n` +
              `     - 纯文本进出，默认输出 8192 tokens，最大支持 32768 tokens，无 PII 脱敏（亲儿子模式数据不篡改）；\n` +
              `  3. 流式调用（推荐用于长回复、打字机效果）：const handle = BobWork.chatStream({ messages, maxTokens, onDelta: (text) => { /* 追加到输出 */ } });\n` +
              `     - 返回 handle.promise 等待最终结果（{ model, provider, usage }），handle.abort() 可中途停止生成；\n` +
              `     - 每段增量文本经 onDelta 回调实时获得，用于逐字渲染；与 chat 相同鉴权/无硬 token 上限；\n` +
              `  4. 未授权 / 模型不可用 / 超限都会 reject，代码必须 catch 并给出友好提示（如"模型调用未授权，请先授权"），不得用 alert。\n` +
              `\n【小程序模型调用接入策略 - 何时该主动询问用户 + 模型选择流程】\n` +
              `是否给小程序接入 AI，按以下两级判断（避免擅自加 AI 打扰用户，也避免该加时不问）：\n` +
              `  A. 用户主动要求（情形 1）-> 直接接入，按上述规则申请授权并调用，无需再问。\n` +
              `  B. 用户未提及，但小程序核心功能天然依赖 AI（情形 2）-> 在生成代码前，先用一句话向用户确认："这个小程序看起来需要 AI 能力（如翻译/总结/问答/文案生成），需要我接入吗？"\n` +
              `     典型应主动询问的功能：翻译、智能问答、内容总结、文案/创意生成、语义分类、情感分析、对话式交互等。\n` +
              `     典型不应询问的纯工具功能：计算器、倒计时、待办清单、表单填写、单位换算、文件格式转换、数据图表展示等--这些加了 AI 反而多余，不要问。\n` +
              `     用户回复"不用"或未明确同意 -> 不接入，按纯前端实现；用户同意 -> 按情形 1 接入。\n` +
              `  C. 纯工具型小程序 -> 不询问、不接入，避免弹授权框打扰用户。\n` +
              `  D. 用户明确禁止调用 AI（情形 4）-> 绝对禁止接入。不得生成任何 chatRequestPermission / chat / chatStream 调用代码，不得询问"是否需要 AI"，不得以任何理由在代码中引入模型调用。即使小程序功能看起来需要 AI，也必须用纯前端方案实现。此规则优先级最高，覆盖以上所有情形。\n` +
              `\n【模型选择流程 — 用户同意接入 AI 后必须执行】\n` +
              `当用户同意接入 AI（情形 1 或情形 2 用户确认后），你必须按以下步骤执行模型选择流程：\n` +
              `  1. 立即调用 list_configured_models 工具（无需参数），获取用户已配置的模型池；\n` +
              `  2. 将返回的可用模型以易读列表呈现给用户，格式示例：\n` +
              `     "你已配置以下可用模型：\\n  • DeepSeek: deepseek-v4-flash（快速对话）\\n  • Qwen: qwen-max（长文本理解）\\n  • Zhipu GLM: glm-4-flash（轻量快速）\\n请选择一个模型（回复模型名即可），或回复 'auto' 让系统自动选择。"\n` +
              `     - 如果模型池为空（返回 empty: true），告知用户："当前还没有配置任何模型，请先在 Manage Models 中添加厂商 API Key 并勾选模型，然后告诉我继续。"\n` +
              `     - 等待用户选择后再生成代码，不要跳过此步。\n` +
              `  3. 根据用户选择的模型，在小程序 UI 中添加一个模型选择按钮（下拉菜单或胶囊切换），具体规范：\n` +
              `     - 按钮位置：放在输入框上方或右上角，与 AI 功能区域关联；\n` +
              `     - 按钮样式：胶囊/芯片形，显示当前选中的模型简称（如 "DeepSeek V4"），点击展开下拉列表；\n` +
              `     - 下拉列表：列出 list_configured_models 返回的所有可用模型，每项显示厂商 + 模型名 + 简短描述；\n` +
              `     - 选项中始终包含 "Auto（自动选择）" 作为第一项（对应 model 参数省略）；\n` +
              `     - 用户选择后，将 model 值（provider:modelId 格式）保存到 BobStorage.set('selectedModel', modelId)；\n` +
              `     - 调用 chat 时读取本地存储的 model 值传入：const model = BobStorage.get('selectedModel'); BobWork.request('chat', { model, messages, ... })；\n` +
              `     - model 为 'auto' 或 null 时省略 model 参数，走 Auto 模式。\n` +
              `  4. 模型选择按钮的交互细节：\n` +
              `     - 默认选中 "Auto"（首次使用）；\n` +
              `     - 切换模型后立即生效（下次调用 chat 时使用新模型），无需重新授权；\n` +
              `     - 按钮文案使用英文（如 "Model: Auto" / "Model: DeepSeek V4"），不用中文；\n` +
              `     - 配色跟随小程序主题（用 var(--primary) 等 CSS 变量），不要写死色值。\n` +
              `\n\n=== 小程序 UI 默认规范（无需用户要求即可主动应用） ===\n` +
              `以下规范保证小程序在 BobWork 预览中风格一致且专业，按优先级执行：\n` +
              `1. 布局：外层卡片式容器，圆角 12px（border-radius: 12px）、柔和阴影 box-shadow: 0 4px 20px rgba(0,0,0,0.08)、内容区 padding 20-28px；viewport 移动端优先，容器 max-width 440px 水平居中；分组模块分区，标题字重 600 + 下边框 1px\n` +
              `2. 配色（CSS 变量自适应）：小程序预览环境已自动注入当前主题的 44 个 CSS 变量到 :root，直接使用 var(--primary)、var(--background)、var(--paper)、var(--ink)、var(--ink-muted)、var(--border)、var(--danger)、var(--success) 等即可自动适配所有主题（含自定义主题），无需写死色值。映射关系：主色 var(--primary) / 背景 var(--background) / 卡片 var(--paper) / 正文 var(--ink) 或 var(--foreground) / 辅助文字 var(--ink-muted) 或 var(--muted-foreground) / 边框 var(--border) 或 var(--line) / 危险 var(--danger) / 成功 var(--success) / 警告 var(--warn) / 信息 var(--info)\n` +
              `   - Canvas/SVG/Chart 等无法用 CSS 变量的场景：调用 BobWork.request('getTheme') 获取 keyColors 对象，用 JS 读取色值后传给图表库\n` +
              `   - 深色判断：html[data-bob-dark="true"] 选择器可检测当前是否深色主题\n` +
              `3. 字体：正文 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Serif SC", serif；数字、金额、百分比一律 font-variant-numeric: tabular-nums（等宽对齐）；标题/正文/辅助三级字号（20px / 14px / 12px）\n` +
              `4. 交互：\n` +
              `   - 计算器类：实时计算（input 事件触发，不阻塞），不要求点击"提交"按钮\n` +
              `   - 按钮三态：hover 亮度 +10%（filter: brightness(1.1)）、active 缩放 0.98、focus 2px var(--primary) 半透明环（box-shadow: 0 0 0 2px var(--primary) / alpha 0.4）\n` +
              `   - 输入错误：边框改为 var(--danger) + 行内小字提示，禁止使用 alert() 弹窗\n` +
              `   - 空态：结果区域无数据时给灰色引导文案（如"输入金额后自动计算"），不要显示 NaN、undefined、0 等误导性占位\n` +
              `5. 重点突出：金额/结果数字 28-40px 字号 + 字重 700 + var(--primary)；对应标签弱化（12px / opacity 0.65）；表单控件合理 width: 100%，不要挤在窄容器里\n` +
              `如果用户明确要求其他配色/风格，以用户需求为准覆盖以上默认规范。`;
          } else {
            // 兜底：节点声明了 sandbox_app_id，但宿主读取 app 失败（目录缺失/损坏）。
            // 不能让 AI 在完全无上下文的情况下瞎找路径，给出探测指令。
            sandboxCodingInjection =
              `\n\n=== AI Coding 编程任务上下文 ===\n` +
              `你正在为一个 Bob Sandbox 小程序进行 AI 编程开发，但宿主未能读取到该小程序的清单（appId: ${sandboxAppId}，应用数据目录 bob-sandbox/apps/ 下未找到 manifest.json 或文件损坏）。\n` +
              `请按以下步骤定位程序：\n` +
              `  1. 调用 list_directory("bob-sandbox/apps/") 列出所有小程序目录，检查是否存在 ${sandboxAppId}；\n` +
              `  2. 若存在：读取 bob-sandbox/apps/${sandboxAppId}/manifest.json 确认清单内容，再读取入口文件了解现状后继续修改；\n` +
              `  3. 若确实不存在或为空目录：向用户说明该小程序丢失（可能在清理/重置时被移除），询问是否新建同名小程序再继续。\n` +
              `任何情况下都不要在 bob-sandbox/apps/ 之外的位置凭空创建小程序文件。`;
          }
        }
      } catch (e) {
        console.warn('AI Coding 上下文注入失败:', e instanceof Error ? e.message : String(e));
      }
    }
    // 缓存前缀稳定化（C8）：AI Coding 上下文属「低频变化」动态内容（同一节点内字节稳定），
    // prepend 到当前轮 user 消息而非 system（缓存头），system 保持字节稳定
    if (sandboxCodingInjection) {
      finalMessages = prependDynamicContext(finalMessages, sandboxCodingInjection);
    }

    const encoder = new TextEncoder();

    if (isCustom) {
      // ---- 使用 OpenAI SDK 调用自定义提供商（支持工具调用循环） ----
      const client = new OpenAI({ apiKey, baseURL: baseUrl });

      // K2-S1 工具面 service 抽取，行为不变：注册（自定义 + MCP 快照/排除 + syncServers）收敛进
      // ToolRuntime.register；每次请求 new（只读快照），settings 每请求读取一次与迁移前一致
      const settingsForTools = await readSettingsFromFile();
      const toolRuntime = new ToolRuntime({ settings: settingsForTools, profile, sandbox: !!sandbox, enabledMcpIds });
      await toolRuntime.register();

      // mcpManager 宿主侧调用（bobby 急停清除 / 浏览器当前页 URL 指纹）仍留在 route 原位
      const { mcpManager } = await import('@/lib/mcp/manager');

      // 新任务开始：清除 bobby 急停标志（上一轮用户按 ESC / 点停止中止后，本轮恢复正常执行）
      mcpManager.callTool('mcp__bobby__clear_abort', {}).catch(() => { /* bobby 未启用/未连接时忽略 */ });

      // ===== 工具场景过滤（两层） =====
      // L1 静态（节点类型）：
      //   - coding：AI Coding 节点（sandboxCodingInjection 非空）→ 放行 design 场景，
      //     coding 提示要求先调用 get_current_theme 获取真实主题色值
      //   - wanted：沙盒模式（wanted Node 聊天）→ 放行 read_todo/read_notebook/preferences/calendar
      //   - node：画布节点对话（nodeId 存在）→ 放行 read_upstream_node/read_manifest/intern_search/draw（节点树/画布结构依赖工具）
      // L2 动态（对话意图）：最后用户消息明确提到对应场景关键词（或附件类型）时，才放行该场景专属工具；
      //   未涉及该场景则专属工具对模型不可见，避免误调用
      const activeScenes = new Set<ToolScene>(['general']);
      if (sandboxCodingInjection) {
        activeScenes.add('coding');
        activeScenes.add('design');
      }
      if (sandbox) activeScenes.add('wanted');
      if (nodeId) activeScenes.add('node');
      try {
        const sceneHintText = extractLastUserContent(messagesWithNodeBridge);
        for (const s of detectSceneHints(sceneHintText)) activeScenes.add(s);
      } catch {
        /* 场景检测失败不阻断工具注册 */
      }

      // 按 Agent 配置（AGENT_PROFILES）决定场景策略：
      //   - chat（通用）：核心常驻 + 动态场景激活（省上下文固定税）。
      //     已激活场景会话内 sticky（仅 nodeId 存在时持久化）：首次激活后该会话保持注入，
      //     避免工具集在轮次间抖动 → 前缀缓存只在首次激活变化一次，后续轮次字节稳定。
      //     注意：检测词含宽泛高频词（如 wanted 的"总结/计划"、admin 的"配置/设置"），
      //     实际效果近似"常用场景工具逐步常驻"，省上下文收益主要来自从未激活的场景工具不注入。
      //   - coding（专项）：固定场景子集，剔除 legal/wanted/ocr/audio/skill 等编码无关的
      //     专属工具与领域 MCP，过滤结果是节点类型决定的确定集合 → 工具前缀逐轮字节稳定。
      if (!sandbox && profile.scenes === 'dynamic') {
        const stickyKey = nodeId;
        if (stickyKey) {
          // K2-S2 会话态 service，行为不变：sticky 读回合并 + 过滤写回
          // （同 nodeId 跨请求聚合）收敛进 SessionRuntime.mergeStickyScenes
          sessionRuntime.mergeStickyScenes(stickyKey, activeScenes);
        }
      }

      // 普通对话注入动态场景集合（DEFAULT_CHAT_SCENES 常量已不再用于普通对话）——
      // 核心工具（layer=core，未标注场景）始终注入且字节稳定（占前缀缓存锚点）；
      // ondemand 工具（layer=ondemand，标注场景）按 detectSceneHints 意图 + 会话 sticky 激活才注入，
      // 内置工具定义从固定 ~18.4k token 降为「核心 ~6.5k + 已激活场景」，省出的上下文让给任务本身。
      // sandbox 受限对话保留场景过滤 + 黑名单（安全优先）；
      // coding 专项 Agent 直接用 AGENT_PROFILES 中的固定工具画像。
      // 场景/画像过滤组装 + mergeForcedMcp + 确定性排序 + CacheGuard 已收敛进 ToolRuntime.assemble
      // （K2-S1 工具面 service 抽取，行为不变）：toolDefs / loopToolDefs 于 REPORT_RULES 注入后统一组装，见下。

      // 浏览器专精规则按需注入（browser 场景激活 / coding 专项 Agent 强制注入）：
      // 已从 system 移出以省固定 token，随当前轮 user 消息动态注入（不破坏 system 前缀缓存）；
      // browser 工具随 tools 注入时，模型同步获得完整操作纪律。
      if (activeScenes.has('browser') || profile.forceBrowserTools) {
        finalMessages = prependDynamicContext(finalMessages, BROWSER_RULES);
      }

      // 报告插图约定按需注入（报告/调研类交付物才注入）：
      // 已从 system 移出，仅生成报告类交付物时需要，避免常驻浪费固定 token。
      // 收敛信号词：只保留强交付词（报告/调研/研报/白皮书/可行性/尽调/意见书），
      // 去掉"XX分析"等模糊词（"深度分析这个问题"≠生成报告，避免误注入 REPORT_RULES）。
      if (!sandbox && /报告|调研|研报|白皮书|可行性|尽调|意见书/i.test(extractLastUserContent(messagesWithNodeBridge))) {
        finalMessages = prependDynamicContext(finalMessages, REPORT_RULES);
      }

      // 缓存前缀稳定化（P4 + 来源分组）+ CacheGuard 守卫在 ToolRuntime.assemble 内完成
      // （K2-S1 工具面 service 抽取，行为不变：与迁移前模块级 buildAndSortToolDefs 同一确定性排序；
      //   search_capabilities 中途激活场景后重建 loopToolDefs 也复用同一 assemble 管线）。
      // （K1：场景中途激活标志 needRebuildTools 已收敛进 kctx，见 start() 内 const kctx.needRebuildTools）
      const assembledTools = toolRuntime.assemble(activeScenes);
      let toolDefs = assembledTools.toolDefs;
      let loopToolDefs = assembledTools.loopToolDefs;

      const isMoonshotThinking = !!baseUrl && baseUrl.includes('moonshot') && !!providerModelId && /kimi-k\d/i.test(providerModelId);
      const finalTemp = isMoonshotThinking || isDeepseekV4 ? 1 : (temperature ?? 0.7);

      const readableStream = new ReadableStream({
        async start(controller) {
          // P4c-1 压缩事件化：taskId/eventLog 已提前创建（Node Bridge 压缩事件需同日志），此处直接复用
          const send = (data: Record<string, unknown>) => {
            // 同步记录事件（append-only 日志，流式 reasoning/content 块被 EventLog 跳过）
            eventLog.record(data);
            // abort/断开后 controller 已关闭：任何迟到的帧（挂起心跳/超时 resolve）不得再 enqueue，
            // 否则抛 ERR_INVALID_STATE → uncaughtException（P4a 挂起心跳回归点，已实测复现）
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch {
              /* stream closed —— 静默忽略迟到帧 */
            }
          };
          eventLog.mark(CORE_EVENT.TURN_START, taskId, { nodeId, identity, model: providerModelId || modelId || '', userInput: initialUserInput ?? '' });
          eventLog.mark(CORE_EVENT.USER_MESSAGE, taskId, { role: 'user', content: initialUserInput ?? '' });

          try {
            // === ② Skills / MCP 概览提前推送：SSE 第 1 条就发，不让用户等到整轮结束 ===
            //   - matchedSkills: 后端注入的技能名（含 强制+自动 合并）
            //   - enabledMcps:   本轮启用的 MCP 服务清单 {id, name, toolCount}
            //   前端收到后立即渲染命中条，不用等 done 事件
            {
              // 注意：toolDefs 已被 activeScenes 场景过滤（两层过滤），
              // 所以下面统计的 mcpToolCountsMap 只包含"本轮实际注入到模型上下文"的 MCP 工具。
              const rawEnabledList = (settingsForTools.mcpServers || [])
                .filter((s) => s.enabled !== false)
                .map((s) => ({ id: s.id, name: s.name || s.id }));
              // 统计每个 server 的工具数（注意：key 是 sanitize 清洗后的 serverId，与 tool 名 mcp__<safeId>__<tool> 一致）
              // toApiFormat 返回 { type, function: { name, ... } }，工具名在 td.function.name（td.name 为 undefined）
              const mcpToolCountsMap: Record<string, number> = {};
              for (const td of toolDefs) {
                const name = ((td as any).function?.name ?? (td as any).name) as string;
                if (name && name.startsWith('mcp__')) {
                  const parts = name.split('__');
                  const srv = parts[1] || '';
                  if (srv) mcpToolCountsMap[srv] = (mcpToolCountsMap[srv] || 0) + 1;
                }
              }
              // 关键：只保留"场景过滤后实际有工具被注入"的 MCP server，避免显示"已注入 X 个 0 工具的 MCP"。
              // 同时修复：serverId 含 -/. 等字符时，工具名里的 key 经 sanitizeToolName 清洗过，
              //   必须用相同方式清洗后再查，否则 bob-ocr-mcp 这类 id 永远读不到 count。
              const { sanitizeToolName } = await import('@/lib/mcp/manager');
              const enabledMcps = rawEnabledList
                .map((s) => ({
                  id: s.id,
                  name: s.name,
                  toolCount: mcpToolCountsMap[sanitizeToolName(s.id)] || 0,
                }))
                .filter((s) => s.toolCount > 0);
              // 手动勾选强制注入的 skills 单独列出来，方便前端区分"强制注入 vs 空"
              const forced = forcedSkills && forcedSkills.length > 0
                ? matchedSkillNames.filter((n) => forcedSkills.includes(n))
                : [];
              send({
                matchedSkills: matchedSkillNames,
                forcedSkills: forced,
                enabledMcps,
                skillDetails,
                nodeId,
              });
            }

            // ===== 视觉增强（首字节前提速：图片识别延后到流内执行） =====
            // 识别期间持续发 vision_progress 事件：前端收到任一 SSE 帧即重置 90s 空闲超时计时器，
            // 慢识别（多图 × 多候选模型降级）不再被误判为"请求超时"；同时用户可看到识别进度。
            let effectiveMessages: ChatMessage[] = finalMessages;
            const visionNeeded = finalMessages.some(
              (m) => m.role === 'user' && /图片/.test(m.content || '') && /路径: (?:attachments|assets)\//.test(m.content || ''),
            );
            if (visionNeeded) {
              try {
                send({ vision_progress: { phase: 'start', current: 0, total: 0 } });
                effectiveMessages = await applyVisionBridge(finalMessages, (p) => send({ vision_progress: p }));
                send({ vision_progress: { phase: 'done', current: 0, total: 0 } });
              } catch (e) {
                console.warn('流内视觉增强失败:', e);
                send({ vision_progress: { phase: 'failed', current: 0, total: 0 } });
              }
            }

            // 工具调用循环
            // ---- K1 会话上下文收敛：把「每轮循环及其子流程共享的请求级状态」归组为 kctx ----
            // interface KernelContext 见模块级定义（POST 之前）；收编范围与未收编项见该 interface 注释。
            const kctx: KernelContext = {
              conversationMessages: [...effectiveMessages],
              allToolCalls: [],
              // 浏览器工具去重页面指纹：browser_active_tab 刷新；页面跳转后变化 → 不误判重复调用
              lastPageUrl: null,
              // search_capabilities / load_skill 中途激活场景后置 true → 下一轮请求前重建 loopToolDefs
              // （takeoverServices.requestToolRebuild 触发；重建后场景已 sticky，后续轮次字节稳定）
              needRebuildTools: false,
              // 完成确认轮只允许一次：模型本轮未调用任何工具时，追加一轮「任务是否真正完成」确认，
              // 防止模型过早自我判定完成（假完成）导致任务不完整；再次无工具调用才接受收尾
              completionConfirmUsed: false,
              // 声明真实性校验纠偏次数计数（防无限纠偏循环；D-B：保持现状仅记录）
              claimMismatchCorrections: 0,
              // 停滞保护：连续 STALL_LIMIT 轮无实质进展 → 判定死循环，进入强制收尾轮（检测在循环末尾）
              stallCount: 0,
              // 强制收尾轮：置 true 后下一轮不带 tools，让模型基于注入的收尾说明输出最终回答；
              // lite 模式（侧边栏等外部轻量问答）：首轮即收尾、不带工具，模型直接回答，
              // 避免工具循环反复调用 browser_* 等多轮生成重复内容
              forceFinalRound: !!lite,
              // OCR 重试预算门控标志：已触发后不再重复注入「停止重试」指令
              ocrBudgetExceeded: false,
              // 工具循环思考降级遥测（item 4 验证）：执行轮降级轮数（对照 done 日志 hitRate）
              thinkingDowngradedRounds: 0,
              // 模型调用总轮数（dsh 完成轮次统计条 / done rounds 字段）
              totalRounds: 0,
              // 跨轮累计本次任务真实 token 消耗（所有模型调用轮次之和）。
              // cacheHitTokens / cacheMissTokens：DeepSeek 前缀缓存遥测（§4.4 —— 命中部分按缓存价计费）
              taskUsage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, calls: 0 },
              // ---- 轮次统计（dsh 完成轮次统计条）：TTFT / 总耗时 / 吞吐 ----
              // taskStartMs：整轮任务开始（首轮模型调用之前）；firstTokenMs：首个 content/reasoning 块到达时刻
              taskStartMs: Date.now(),
              firstTokenMs: null,
              // 快照本轮开始前的 homework/ 目录，结束时比对出新产出（兜底输出卡片，
              // 覆盖 run_command / execute_script 等未在结果中带路径标记的写入方式）
              homeworkSnapshot: projectRoot ? listHomeworkFiles(projectRoot) : null,
            };

            // 浏览器工具去重用的「页面 URL 指纹」（状态本体见 kctx.lastPageUrl）：
            // 每次 browser 工具成功执行后经 active_tab 刷新；页面跳转后 kctx.lastPageUrl 变化
            // → 相同参数的调用不再被误判为「重复调用」
            const fetchCurrentPageUrl = async (): Promise<string | null> => {
              try {
                const raw = await mcpManager.callTool('mcp__bob-browser-mcp__browser_active_tab', {});
                const m = String(raw || '').match(/"url"\s*:\s*"(https?:\/\/[^"]*)"/);
                return m ? m[1] : null;
              } catch {
                return null;
              }
            };

            //（K1：完成确认 kctx.completionConfirmUsed / 纠偏计数 kctx.claimMismatchCorrections / 停滞 kctx.stallCount /
            //  强制收尾 kctx.forceFinalRound / OCR 门控 kctx.ocrBudgetExceeded / 降级遥测 kctx.thinkingDowngradedRounds /
            //  轮计数 kctx.totalRounds / 用量 kctx.taskUsage / kctx.taskStartMs / kctx.firstTokenMs —— 均已收敛进上方 kctx，
            //  原散落声明与注释随迁至 kctx 字面量内，见 interface KernelContext）

            // ---- 上下文占用 Meter（dsh ContextMeter）----
            // 按 系统/工具/对话 分组估算 + 模型 contextWindow 容量，SSE 推送给前端 composer 圆环。
            // 任务开始发一次（当前状态），done 时再发一次最终状态（含工具结果回灌后的真实占用）。
            // 缓存头分段指纹（pi-reasonix + item 3）：system / 工具 / 历史 三段独立 hash + 总指纹。
            // 前端仍用 prefixHash（总指纹）做跨任务对比；命中率下降时对照三段 hash 精确定位漂移段：
            //   - system 变 → 注入/项目路径/偏好/AI Coding 上下文变动
            //   - tools 变 → 工具集变动（MCP 连接/注册顺序）
            //   - history 变 → 历史消息漂移（R-14 裁剪、压缩游标跳动）
            // 避免"只知道缓存没命中、不知道是哪段断的"。
            const prefixSegments = (() => {
              try {
                const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
                const sys = finalMessages.find((m) => m.role === 'system')?.content ?? '';
                // P4：tools 段 hash 按 name 排序归一化（语义指纹，忽略顺序），
                // 避免 MCP 连接/注册顺序变化导致同一工具集 hash 漂移
                const sortedToolDefs = [...loopToolDefs].sort((a, b) => {
                  const na = (a as { function?: { name?: string } })?.function?.name ?? '';
                  const nb = (b as { function?: { name?: string } })?.function?.name ?? '';
                  return na.localeCompare(nb);
                });
                const tools = JSON.stringify(sortedToolDefs);
                // 字节级指纹：按实际发送顺序（loopToolDefs）逐字节 hash。与 tools（语义指纹）对照
                // 可区分「工具集变化」与「发送顺序漂移」：命中率掉但 tools 不变 → 查 toolsByte
                // （顺序变了）；tools 也变 → 查 CacheGuard 落盘的具体工具 diff。
                const toolsByte = JSON.stringify(loopToolDefs);
                // 历史段：除 system 与当前轮最后一条 user 之外的消息（最后一条为本轮输入，每次必然不同）
                const historyMsgs = finalMessages.filter((m, i) => m.role !== 'system' && i < finalMessages.length - 1);
                const history = historyMsgs
                  .map((m) => JSON.stringify({ r: m.role, c: typeof m.content === 'string' ? m.content : '' }))
                  .join('\x00');
                return {
                  system: h(sys),
                  tools: h(tools),
                  toolsByte: h(toolsByte),
                  history: h(history),
                  all: h(sys + '\x00TOOLS\x00' + tools + '\x00HIST\x00' + history),
                };
              } catch {
                return { system: '', tools: '', toolsByte: '', history: '', all: '' };
              }
            })();
            const prefixHash = prefixSegments.all;

            const sendContextMeter = () => {
              const ctx = estimateContextBreakdown(kctx.conversationMessages, loopToolDefs);
              send({
                context_meter: {
                  system: ctx.systemTokens,
                  tools: ctx.toolsTokens,
                  conversation: ctx.conversationTokens,
                  capacity: inferContextWindow(
                    providerModelId || '',
                    !!(reasoningEffort || deepseekThinkingMode),
                  ),
                },
                prefixHash,
                prefixSegments,
                nodeId,
              });
            };
            sendContextMeter(); // 首轮前下发（显示当前上下文占用，供 composer 圆环预览）

            // P4a 三段化骨架：宿主注入给接管管线的最小服务面（tool-pipeline.ts）——
            // 场景激活副作用（activeScenes.add / sticky / kctx.needRebuildTools）统一经此执行。
            // K2-S2 会话态 service，行为不变：addStickyScene 与原分支语义一致——
            // 仅 nodeId 存在时落 SessionRuntime（跨请求保持），无 nodeId 的会话不持久化、仅当轮生效。
            const takeoverServices: TakeoverServices = {
              activeScenes,
              addStickyScene: (scene) => {
                if (nodeId) sessionRuntime.addStickyScene(nodeId, scene);
              },
              requestToolRebuild: () => {
                kctx.needRebuildTools = true;
              },
            };

            for (let round = 0; ; round++) {
              // 场景中途激活（search_capabilities / load_skill 法律技能）→ 用最新 activeScenes
              // 重算 toolDefs 再重建 loopToolDefs，下一轮模型请求携带新工具集；
              // 重建后本会话场景已 sticky，后续轮次字节稳定。
              if (kctx.needRebuildTools) {
                // K2-S1 工具面 service 抽取，行为不变：复用同一 assemble 管线（最新 activeScenes）重建
                const rebuilt = toolRuntime.assemble(activeScenes);
                toolDefs = rebuilt.toolDefs;
                loopToolDefs = rebuilt.loopToolDefs;
                kctx.needRebuildTools = false;
                console.log(`[chat] 场景中途激活后重建工具集: n=${loopToolDefs.length}`);
              }
              const isFinalRound = kctx.forceFinalRound;
              // lite 模式不注入「基于以上结果」的收尾指令（首轮即是最终回答，无前置工具结果）
              const finalRoundInjection = isFinalRound && !lite;
              // item 6：max_tokens 分级——high/thinking_max 深度放宽到 32k（高思考深度下
              // reasoning 占用大半输出预算，16k 仍可能截断正文）；仅对 1M 推理大模型档
              // （函数返回 16384）翻倍，128k/小模型档保持不动，避免超出模型支持上限触发 API 400。
              const baseMaxTokens = modelOutputTokenMaxForModel(providerModelId || '', reasoningEffort != null || deepseekThinkingMode != null);
              const highDepthRequest = isDeepseekV4
                ? deepseekThinkingMode === 'thinking_max'
                : reasoningEffort === 'high';
              const effectiveMaxTokens = highDepthRequest && baseMaxTokens >= 16384
                ? Math.min(baseMaxTokens * 2, 32768)
                : baseMaxTokens;
              const requestBody: Record<string, unknown> = {
                model: providerModelId,
                messages: finalRoundInjection
                  ? [
                      ...kctx.conversationMessages,
                      {
                        role: 'user' as const,
                        content: '请基于以上结果给出最终回答，不要再调用任何工具。如果仍有未完成的步骤，请在回答末尾用【未完成项】明确列出，供用户决定是否继续。',
                      },
                    ]
                  : kctx.conversationMessages,
                stream: true,
                temperature: finalTemp,
                // 请求流式响应随附 usage 汇总块，末 chunk.usage 即本轮真实 token 计数
                stream_options: { include_usage: true },
                // 显式声明单次输出上限：不传时多数 API 默认 4096，高思考深度下 reasoning 占用大半，
                // 正文往往写不完就戛然而止（无任何提示）。按模型上下文窗口动态推断：
                // 1M 模型 → 16384（deepseek-v4/doubao-seed 等输出上限高，避免正文被 8192 截断）；
                // 128k/256k → 12288；小模型 → 8192（已验证安全）。
                max_tokens: effectiveMaxTokens,
              };
              // 每轮都携带 tools（缓存前缀稳定化）：tools 数组属于请求前缀的一部分，
              // 若中途轮次去掉 tools（如原收尾轮逻辑），该轮前缀与循环内其余轮不同 →
              // 整个任务历史（可能数十万 token）在该轮全部按缓存未命中全价重算。
              // 带上 tools 后模型若仍调用工具会继续执行循环（见下 kctx.forceFinalRound 解除），
              // 无工具调用即正常收尾，行为与原先一致。
              // 例外：lite 模式（侧边栏等外部轻量问答）保持首轮不带 tools（本来就是
              // 一次性独立问答、无工具循环，携带 tools 反而诱导模型反复调用生成重复内容）。
              if (!lite) {
                requestBody.tools = loopToolDefs;
              }

              // 工具循环思考降级（item 4）：执行轮（round>0 且非收尾轮）降一级，
              // 收尾轮/首轮保持用户选择深度——深度推理放在规划轮，执行轮只做决策，省 reasoning tokens
              // Phase 2 策略层抽取：降级决策收敛到 policy.executionDowngrade（默认开，行为与现网一致）
              const downgradeDecision = executionDowngrade(round, isFinalRound, level, isDeepseekV4, thinkingPolicyConfig);
              const roundThinkingMode = isDeepseekV4 && deepseekThinkingMode
                ? (downgradeDecision?.thinkingMode ?? deepseekThinkingMode)
                : null;
              const roundReasoningEffort = !isDeepseekV4 && reasoningEffort && modelSupportsThinking
                ? (downgradeDecision?.reasoningEffort ?? reasoningEffort)
                : reasoningEffort;
              const thinkingDowngraded = round > 0 && !isFinalRound &&
                ((isDeepseekV4 && roundThinkingMode !== deepseekThinkingMode) ||
                 (!isDeepseekV4 && roundReasoningEffort !== reasoningEffort));
              eventLog.mark(CORE_EVENT.STEP_START, `${taskId}:r${round}`, { round });
              kctx.totalRounds++;
              if (thinkingDowngraded) kctx.thinkingDowngradedRounds++;

              if (isDeepseekV4 && roundThinkingMode) {
                requestBody.thinking_mode = roundThinkingMode;
              } else if (roundReasoningEffort && modelSupportsThinking) {
                requestBody.reasoning_effort = roundReasoningEffort;
              }

              console.log(
                `[chat] round=${round}${thinkingDowngraded ? ' [thinking降级]' : ''} model: ${providerModelId} | thinking_level: ${level} | mode: ${roundThinkingMode ?? roundReasoningEffort ?? 'off'} | reasoning_effort: ${isDeepseekV4 ? '(skipped)' : roundReasoningEffort}`,
              );

              // C7（deepseek-harness）：DeepSeek V4 发送前校验 prompt+max_tokens ≤ 1,048,576 硬上限。
              // 超限直接给出可读错误（而非等 DeepSeek 返回 400），提示用户拆分对话/节点。
              if (isDeepseekV4) {
                const estIn = estimateMessagesTokens(requestBody.messages as ChatMessage[]);
                const estMaxOut = typeof requestBody.max_tokens === 'number' ? requestBody.max_tokens : 0;
                if (estIn + estMaxOut > DEEPSEEK_MAX_CONTEXT_TOKENS) {
                  throw new Error(
                    `上下文超长（估算输入约 ${Math.round(estIn / 1000)}k tokens + 输出上限 ${Math.round(estMaxOut / 1000)}k），超过 DeepSeek V4 的 ${(DEEPSEEK_MAX_CONTEXT_TOKENS / 1000).toLocaleString()}k token 硬上限。请拆分对话/节点、或精简历史后再试。`,
                  );
                }
              }

              // 429/5xx/网络错误的指数退避重试（deepseek-harness 限流稳健化）：
              // 请求建立阶段失败（尚未收到任何流式块）才重试，流中途断开不重试（工具可能已执行，重放有副作用）。
              let completion: AsyncIterable<{
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    reasoning_content?: string | null;
                    tool_calls?: Array<{
                      index: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string;
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                  // DeepSeek 原生缓存字段
                  prompt_cache_hit_tokens?: number;
                  prompt_cache_miss_tokens?: number;
                  // OpenAI 兼容格式缓存字段（部分代理只填这一侧）
                  prompt_tokens_details?: { cached_tokens?: number };
                };
              }>;
              for (let attempt = 1; ; attempt++) {
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  completion = (await (client.chat.completions.create as any)({
                    ...requestBody,
                    stream: true,
                  })) as AsyncIterable<{
                    choices?: Array<{
                      delta?: {
                        content?: string | null;
                        reasoning_content?: string | null;
                        tool_calls?: Array<{
                          index: number;
                          id?: string;
                          function?: { name?: string; arguments?: string };
                        }>;
                      };
                      finish_reason?: string;
                    }>;
                    usage?: {
                      prompt_tokens?: number;
                      completion_tokens?: number;
                      total_tokens?: number;
                      prompt_cache_hit_tokens?: number;
                      prompt_cache_miss_tokens?: number;
                      prompt_tokens_details?: { cached_tokens?: number };
                    };
                  }>;
                  break; // 请求建立成功，进入流式消费
                } catch (createErr) {
                  if (attempt >= COMPLETION_MAX_ATTEMPTS || !isRetryableCompletionError(createErr)) {
                    throw createErr;
                  }
                  // 优先尊重服务端 Retry-After 头；否则指数退避 + 随机抖动（防多节点同时重试打满网关）
                  const retryAfterMs = (() => {
                    if (typeof createErr === 'object' && createErr !== null) {
                      const headers = (createErr as { headers?: Record<string, string | undefined> }).headers;
                      const ra = headers?.['retry-after'];
                      if (ra) {
                        const secs = parseFloat(ra);
                        if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
                      }
                    }
                    return null;
                  })();
                  const delay = Math.min(
                    retryAfterMs ?? (COMPLETION_RETRY_BASE_MS * 2 ** (attempt - 1)),
                    COMPLETION_RETRY_CAP_MS,
                  ) + Math.random() * 300;
                  console.warn(`[chat] 模型请求失败，第 ${attempt}/${COMPLETION_MAX_ATTEMPTS} 次重试（${Math.round(delay)}ms 后）: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
                  send({ retry: { attempt, maxAttempts: COMPLETION_MAX_ATTEMPTS, delayMs: Math.round(delay), reason: createErr instanceof Error ? createErr.message : String(createErr) }, nodeId });
                  await sleepMs(delay);
                }
              }

              // 收集流式内容（C5：list + join 聚合，避免逐块字符串拼接 O(n²) —— DeepSeek SSE 块粒度 1-3 字符，一轮可达数千块）
              const contentParts: string[] = [];
              const reasoningParts: string[] = [];
              const toolCallBuf: Map<number, { id: string; name: string; arguments: string }> = new Map();

              for await (const chunk of completion) {
                // usage 汇总块（include_usage 时，末 chunk 无 choices 仅带 usage）需在 delta 判空之前采集
                if (chunk.usage) {
                  if (typeof chunk.usage.prompt_tokens === 'number') kctx.taskUsage.promptTokens += chunk.usage.prompt_tokens;
                  if (typeof chunk.usage.completion_tokens === 'number') kctx.taskUsage.completionTokens += chunk.usage.completion_tokens;
                  // 缓存遥测：DeepSeek 与 OpenAI 两种字段命名都可能出现（§4.3 字段名桥），
                  // 取两者较大值并互相兜底；命中部分按缓存价（约 1/50）计费，miss 部分按原价。
                  const hit = Math.max(
                    typeof chunk.usage.prompt_cache_hit_tokens === 'number' ? chunk.usage.prompt_cache_hit_tokens : 0,
                    typeof chunk.usage.prompt_tokens_details?.cached_tokens === 'number' ? chunk.usage.prompt_tokens_details.cached_tokens : 0,
                  );
                  if (hit > 0) kctx.taskUsage.cacheHitTokens += hit;
                  if (typeof chunk.usage.prompt_cache_miss_tokens === 'number') kctx.taskUsage.cacheMissTokens += chunk.usage.prompt_cache_miss_tokens;
                  kctx.taskUsage.calls += 1;
                }
                const delta = chunk.choices?.[0]?.delta;
                if (!delta) continue;

                // TTFT（dsh 完成轮次统计）：首个 content/reasoning 块到达时刻（首轮模型响应延迟）
                if (kctx.firstTokenMs === null && (delta.content || delta.reasoning_content)) {
                  kctx.firstTokenMs = Date.now();
                }

                // 输出触顶检测：finish_reason=length 说明本次生成被 max_tokens 截断（内容不完整）
                if (chunk.choices?.[0]?.finish_reason === 'length') {
                  send({ content_truncated: true, nodeId });
                }

                // 思考过程
                const reasoning = delta.reasoning_content ?? undefined;
                if (reasoning) {
                  reasoningParts.push(reasoning);
                  send({ reasoning, nodeId });
                }

                // 文本内容
                if (delta.content) {
                  contentParts.push(delta.content);
                  send({ content: delta.content, nodeId });
                }

                // 工具调用增量
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCallBuf.has(idx)) {
                      toolCallBuf.set(idx, { id: '', name: '', arguments: '' });
                    }
                    const buf = toolCallBuf.get(idx)!;
                    if (tc.id) buf.id = tc.id;
                    if (tc.function?.name) buf.name += tc.function.name;
                    if (tc.function?.arguments) buf.arguments += tc.function.arguments;
                  }
                }
              }

              // C5：流式内容一次性 join（每轮只 join 一次，后续统一使用聚合后的文本）
              const reasoningText = reasoningParts.join('');
              const contentText = contentParts.join('');

              // ===== 工具调用回收（deepseek-harness / pi-reasonix scavenge）=====
              // DeepSeek 系模型偶发把工具调用写进 reasoning_content 而非结构化 tool_calls。
              // 本轮无结构化 tool_calls 时，从思考文本回收合法 JSON 结构并当作本轮工具调用执行。
              if (toolCallBuf.size === 0 && reasoningText.trim()) {
                const scavenged = scavengeToolCallsFromReasoning(reasoningText);
                if (scavenged.length > 0) {
                  console.warn(`[工具回收] 从思考内容回收 ${scavenged.length} 个工具调用: ${scavenged.map((c) => c.name).join(', ')}`);
                  send({ tool_scavenged: { count: scavenged.length }, nodeId });
                  for (const c of scavenged) {
                    const idx = toolCallBuf.size;
                    toolCallBuf.set(idx, { id: c.id, name: c.name, arguments: c.arguments });
                  }
                }
              }

              // 检查是否有工具调用
              if (toolCallBuf.size === 0) {
                // 强制收尾轮（带 tools 但模型无工具调用，仅输出文本）已完成 → 结束循环
                if (kctx.forceFinalRound) eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:r${round}:final`, { round, role: 'assistant', content: contentText || '', reasoning: reasoningText || undefined, toolCalls: [] });
                if (kctx.forceFinalRound) break;

                // ── 声明真实性校验（Claim Verification）──
                // 模型本轮无工具调用但正文声称"已写入/已生成"某文件 → 反查 kctx.allToolCalls 确认是否真正执行。
                // 仅做告警（send claim_mismatch），不再 push user 消息强制重跑——
                //   强制重跑必然触发第二轮生成（用户看到"AI 回答两遍"），
                //   改为只把告警透传给前端，由用户决定是否继续追问，彻底消除双重回答 bug。
                if (
                  kctx.allToolCalls.length > 0 &&
                  contentText.trim()
                ) {
                  const thinkPrefix = reasoningText ? `<think>${reasoningText}</think>\n` : '';
                  const fullAssistantText = thinkPrefix + contentText;
                  const { mismatches } = verifyClaimsAgainstToolRecords(fullAssistantText, kctx.allToolCalls);
                  const pdfCheck = verifyPdfReadCompleteness(fullAssistantText, kctx.allToolCalls);
                  // 第二类死角：调了工具但没读笔记就"声称引用笔记"——在调过工具(本分支前提)的收尾回答里检测
                  const noteCheck = profile.id === 'note' ? verifyNoteReadClaims(fullAssistantText, kctx.allToolCalls) : { mismatches: [] as string[], correction: null };
                  const allMismatches =
                    mismatches.length > 0
                      ? mismatches
                      : pdfCheck.mismatches.length > 0
                        ? pdfCheck.mismatches
                        : noteCheck.mismatches;
                  if (allMismatches.length > 0) {
                    send({
                      claim_mismatch: {
                        mismatches: allMismatches,
                        correctionCount: kctx.claimMismatchCorrections,
                        suppressed: true, // 明确告知前端：已识别但未强制重跑
                      },
                      nodeId,
                    });
                  }
                }

                // 续写流识别：末尾 user 消息是「补充信息继续原任务」（前端续写模式注入）。
                // 续写请求的 kctx.allToolCalls 从空开始，模型收到补充信息后可能直接给结论不再调工具，
                // 若不识别会被当作「纯问答」直接收尾 → 任务未完成也停止（补充信息后任务被自动终止的根因）。
                const lastUserMsg = [...kctx.conversationMessages].reverse().find((m) => m.role === 'user');
                const isContinuationFlow =
                  typeof lastUserMsg?.content === 'string' &&
                  lastUserMsg.content.startsWith('用户已根据你的提问补充了以下信息');
                //（P4 盘点清理：原 finish_task / todo_write / isFirstRoundWithoutPlan 死分支——
                //  恒位于 toolCallBuf.size===0 内不可达，见 DSH 内核接口面盘点 §1.3；行为不变）
                // 4. 模型本轮已输出正文（最终答案）且无工具调用 → 直接视为完成
                // 正文本身是交付物，不需要再通过 finish_task 确认；防止在最终答案后追加
                // "⏳ Completion check" 提示并诱导模型生成第二遍答案
                // （去双轨：不再剥离 process_narration，正文全文直出，交付物不再被误吞）
                if (contentText.trim()) {
                  eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:r${round}:final`, { round, role: 'assistant', content: contentText || '', reasoning: reasoningText || undefined, toolCalls: [] });
                  break;
                }

                // 5. 检查是否处于"假完成"状态（未调用 finish_task 且无其他工具调用）
                // 如果之前执行过工具（kctx.allToolCalls > 0）或是续写流，但本轮没有产生新的工具调用（且不是 finish_task）
                if (kctx.allToolCalls.length > 0 || isContinuationFlow) {
                  if (!kctx.completionConfirmUsed) {
                    // 第一次追问：强制要求模型要么继续调用工具，要么调用 finish_task
                    kctx.completionConfirmUsed = true;
                    kctx.conversationMessages.push({
                      role: 'user',
                      content:
                        '本轮你没有调用任何工具，也没有调用 finish_task 来结束任务。请检查：\n' +
                        '1. 如果任务尚未完成，请继续调用相应的工具去执行剩余步骤。\n' +
                        '2. 如果你确认所有步骤均已完成，请立即调用 finish_task 工具来结束任务。',
                    });
                    send({ completion_check: true, nodeId });
                    continue;
                  } else {
                    // 第二次仍无工具调用，视为真正的完成（或者模型放弃了），强制收尾
                    console.warn('[chat] 模型连续两次未调用工具或 finish_task，强制结束任务');
                    eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:r${round}:final`, { round, role: 'assistant', content: contentText || '', reasoning: reasoningText || undefined, toolCalls: [] });
                    break;
                  }
                }

                // 6. 纯问答（从未调用工具且非续写流，且本轮也无工具调用）→ 接受完成，收尾
                if (kctx.allToolCalls.length === 0 && !isContinuationFlow) {
                  // ── 笔记节点防幻觉兜底（死角修复）：Kar(note) 全程未读任何笔记就给出断言性回答 ──
                  // 触发条件：note 身份 + 本会话从未调用 read_notebook/read_note + 正文非空且非寒暄。
                  // 仅告警（复用 claim_mismatch 通道透传前端），不强制重跑，避免"回答两遍"。
                  if (
                    profile.id === 'note' &&
                    contentText.trim().length > 20 &&
                    !kctx.allToolCalls.some(
                      (t) => t.toolName === 'read_notebook' || t.toolName === 'read_note' || t.toolName === 'read_raw_inbox',
                    )
                  ) {
                    console.warn('[chat] note 节点未读取任何笔记即给出较长回答，疑似凭记忆作答');
                    send({
                      claim_mismatch: {
                        mismatches: [
                          '⚠️ 本轮回答未读取任何笔记（read_notebook / read_note）即给出较长结论。若内容涉及个人知识库，请先检索确认；若确无相关笔记或基于常识作答，请在回答中说明依据。',
                        ],
                        correctionCount: kctx.claimMismatchCorrections,
                        suppressed: true,
                      },
                      nodeId,
                    });
                  }
                  eventLog.mark(CORE_EVENT.ASSISTANT_MESSAGE, `${taskId}:r${round}:final`, { round, role: 'assistant', content: contentText || '', reasoning: reasoningText || undefined, toolCalls: [] });
                  break;
                }
                
                // 7. 其他情况（本轮有新工具调用，但不是 finish_task）→ 继续循环执行工具
                // 这将在后续的代码中处理，不需要 break
              }

              // 本轮产生了工具调用 → 强制收尾轮解除：模型仍在执行任务（任务未完成），
              // 下一轮回到正常循环，避免重复注入「请基于以上结果给出最终回答」的收尾指令
              // （该指令只应出现一次；收尾轮已带 tools，前缀保持稳定）。
              if (kctx.forceFinalRound) kctx.forceFinalRound = false;

              // 构建 assistant 消息（含 tool_calls）
              const parsedToolCalls = Array.from(toolCallBuf.entries())
                .sort(([a], [b]) => a - b)
                .map(([, buf]) => ({
                  id: buf.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                  type: 'function' as const,
                  function: { name: buf.name, arguments: buf.arguments },
                }));

              // 构建 assistant 消息（含 tool_calls）。
              // 所有轮次都把 reasoning 用 <think> 包裹在 content 最前面：
              //   · 下一轮模型请求会真正看到自己之前的思考，保持"思考→动作"风格的一致性（否则多轮后模型习惯丢失标签）
              //   · node-chat / mail-reply 等纯 SSE 消费方（只看 content）也能拿到并展示思考
              //   · 前端 msg.reasoning 仍然作为优先渲染源（不依赖 content 解析）
              // 若模型直接调用工具未输出文字且无 reasoning，content 为空会触发部分 API 的
              // "assistant message must not be empty" 校验错误（OpenAI 兼容格式允许省略 content）
              const thinkPrefix = reasoningText ? `<think>${reasoningText}</think>\n` : '';
              const finalContent = thinkPrefix + contentText;
              kctx.conversationMessages.push({
                role: 'assistant',
                ...(finalContent ? { content: finalContent } : {}),
                tool_calls: parsedToolCalls,
                // DeepSeek V4 协议要求（deepseek-harness C2）：工具循环内重发 assistant 消息必须回传
                // 原始 reasoning_content 字段，否则 HTTP 400 "reasoning_content must be passed back"。
                // 该字段由本轮流式采集、字节直传（禁止 trim/normalize/重编码），不会破坏前缀缓存；
                // 其他厂商模型忽略此字段，行为不变。
                ...(isDeepseekV4 && reasoningText ? { reasoning_content: reasoningText } : {}),
              });
              eventLog.mark(CORE_EVENT.ASSISTANT_ATTEMPT, `${taskId}:r${round}`, { round, role: 'assistant', content: finalContent || '', reasoning: isDeepseekV4 && reasoningText ? reasoningText : undefined, toolCalls: parsedToolCalls.map((tc: { id?: string; function?: { name?: string; arguments?: string } }) => ({ id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments })) });
              if (isDeepseekV4 && reasoningText) {
                // 前缀缓存可观测性：记录本轮 reasoning 回传长度，便于排查 history 前缀漂移
                console.debug(`[前缀缓存] 第${round + 1}轮 reasoning_content 回传 ${reasoningText.length} 字符（字节直传，禁止改写）`);
              }

              // 执行每个工具调用（跳过重复调用）
              const roundStartToolCount = kctx.allToolCalls.length;
              for (const tc of parsedToolCalls) {
                const toolName = tc.function.name;
                // P0 轨迹：为本次工具调用生成稳定 spanId + 真实开始时间戳，
                // 随 tool_call / tool_result 事件下发（前端 P0 忽略，P1 据此稳定渲染 + 真实耗时）
                const toolSpanId = genSpanId();
                const toolStartAt = Date.now();
                // 工具参数 JSON 修复（deepseek-harness / pi-reasonix repair）：
                // 模型长输出截断导致 arguments 不合法时，先尝试自动补全再执行；补全失败则不执行并提示重试。
                let parsedArgs: Record<string, unknown> | null = null;
                let argsRepaired = false;
                try {
                  parsedArgs = JSON.parse(tc.function.arguments);
                } catch {
                  const repaired = repairTruncatedJson(tc.function.arguments);
                  if (repaired !== null) {
                    try {
                      parsedArgs = JSON.parse(repaired);
                      argsRepaired = true;
                    } catch {
                      parsedArgs = null;
                    }
                  }
                }
                // 方案 B：本步「在做什么」中文动作描述（随 tool_call 下发供 UI 展示，不进模型上下文、不耗 token）
                const callPurpose = describeToolCall(toolName, parsedArgs ?? {});
                if (parsedArgs === null) {
                  // 参数既无法解析也无法修复 → 跳过执行（避免空参误执行），注入修复指令让模型重试
                  const errMsg = `工具调用参数 JSON 解析失败（可能被输出截断），已跳过执行。原始参数: ${tc.function.arguments.slice(0, 200)}。请重新调用该工具，确保 arguments 为完整合法的 JSON。`;
                  kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
                  eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: errMsg, name: toolName });
                  send({ tool_call: { name: toolName, arguments: {}, phase: 'error', spanId: toolSpanId, startAt: toolStartAt, purpose: callPurpose }, nodeId });
                  send({ tool_result: { name: toolName, result: errMsg, durationMs: 0, success: false, phase: 'error', spanId: toolSpanId, startAt: toolStartAt, endAt: Date.now() }, nodeId });
                  continue;
                }
                if (argsRepaired) {
                  console.warn(`[工具参数修复] ${toolName} arguments 截断已自动补全: ${tc.function.arguments.slice(0, 100)} → ${JSON.stringify(parsedArgs).slice(0, 100)}`);
                  send({ tool_repair: { name: toolName, repaired: true }, nodeId });
                }

                // 检查是否重复调用同一工具+相同参数
                // 浏览器工具额外感知页面状态：页面已跳转（kctx.lastPageUrl 变化）→ 参数相同但结果不同，不视为重复
                let skipDuplicate = isDuplicateCall(toolName, parsedArgs, kctx.allToolCalls);
                if (skipDuplicate && isPageStateTool(toolName) && kctx.lastPageUrl) {
                  const argKey = JSON.stringify(parsedArgs);
                  for (let i = kctx.allToolCalls.length - 1; i >= 0; i--) {
                    const h = kctx.allToolCalls[i];
                    if (h.toolName === toolName && JSON.stringify(h.arguments) === argKey) {
                      // 该工具上次执行时的页面 URL 与当前不同 → 页面已变化，上次结果已失效，允许重新执行
                      if (h.pageUrl && h.pageUrl !== kctx.lastPageUrl) skipDuplicate = false;
                      break;
                    }
                  }
                }
                if (skipDuplicate) {
                  // 跳过重复调用，直接返回提示
                  const dupResult = '跳过重复调用：已执行过相同参数的此工具，请基于已有结果回答。';
                  kctx.conversationMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: dupResult,
                  });
                  eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: dupResult, name: toolName });
                  send({
                    tool_call: { name: toolName, arguments: parsedArgs, phase: 'pending', spanId: toolSpanId, startAt: toolStartAt, purpose: callPurpose },
                    nodeId,
                  });
                  send({
                    tool_result: {
                      name: toolName,
                      result: dupResult,
                      durationMs: 0,
                      success: false,
                      phase: 'error',
                      spanId: toolSpanId,
                      startAt: toolStartAt,
                      endAt: Date.now(),
                    },
                    nodeId,
                  });
                  continue;
                }

                // ① 发送 tool_call 事件（pending 阶段：模型已决定要调这个工具，但还没执行）
                send({
                  tool_call: {
                    name: toolName,
                    arguments: parsedArgs,
                    phase: 'pending',
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    purpose: callPurpose,
                  },
                  nodeId,
                });

                // ② P4a-3-1 迁移：ask_user_questions 挂起型接管已从 route if 分支收敛为注册式
                //    host-pending 分发（tool-pipeline.ts，行为不变）——模型决定提问的那一刻即触发
                //    弹窗，快且稳定（结构化、无格式容错）。questions_request 载荷字段 / 20s 心跳
                //    时序 / answers 回传文本 / eventLog·tool_result·遥测 / 循环 continue 语义均由
                //    注册 handler（handleAskUserQuestions，见模块级注册）经 ctx 服务面逐位复刻；
                //    'handled_continue' = 已由宿主接管完成 → 跳过下方通用执行逻辑（等价原 if 分支
                //    continue；'handled_fallback'/'noop' 保留给 P4a-3 后续 confirm/login/grant 类）。
                const askUserTakeover = hostTakeoverFor(toolName, 'ask_user', 'pre');
                if (askUserTakeover) {
                  const askUserArgs = parsedArgs;
                  const askUserVerdict = await askUserTakeover.handle({
                    name: toolName,
                    args: askUserArgs,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    // 结果落账三连（顺序与原分支一致：kctx.allToolCalls → 对话历史 → eventLog.TOOL_RESULT）；
                    // round / taskId / tool_call_id / pageUrl 等请求态在闭包内绑定当前值。
                    commitToolResult: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: askUserArgs,
                        result: resultText,
                        durationMs: 0,
                        success: true,
                        phase: 'done',
                        pageUrl: kctx.lastPageUrl,
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                  });
                  // 该工具已由宿主处理，跳过下方通用执行逻辑
                  if (askUserVerdict === 'handled_continue') continue;
                }

                // ②.0 P4a 三段化骨架：search_capabilities 收敛为注册式 pre-execute 接管
                //     （tool-pipeline.ts 注册表，行为不变）。能力检索/场景去重激活/sticky/
                //     kctx.needRebuildTools 由 pipeline 统一执行；本工具为全接管——未匹配到能力时
                //     decision 仍非 null（scenes 空），照常返回"未找到"文案。decision.meta 携带
                //     匹配条目（含已激活场景）供 buildCapabilityResultText 生成能力清单。
                //     与 ask_user_questions 同为"宿主接管、不落 executeTool"的模式。
                const searchCapabilityTakeover = takeoverFor(toolName, 'pre');
                if (searchCapabilityTakeover && searchCapabilityTakeover.kind === 'scenario_activate') {
                  const scenarioDecision =
                    searchCapabilityTakeover.handleScenario?.(toolName, parsedArgs) ?? null;
                  const query = String((parsedArgs as Record<string, unknown>)?.query ?? '');
                  const matched: CapabilityEntry[] =
                    ((scenarioDecision?.meta as { matched?: CapabilityEntry[] } | undefined)?.matched) ?? [];
                  const { newlyActivated } = applyScenarioActivation(
                    scenarioDecision ?? { scenes: [], sticky: false },
                    takeoverServices,
                  );
                  const resultText = buildCapabilityResultText(query, matched, newlyActivated);
                  send({
                    tool_call: { name: toolName, arguments: parsedArgs, phase: 'done', spanId: toolSpanId, startAt: toolStartAt, purpose: callPurpose },
                    nodeId,
                  });
                  send({
                    tool_result: {
                      name: toolName,
                      result: resultText,
                      durationMs: 0,
                      success: true,
                      phase: 'done',
                      spanId: toolSpanId,
                      startAt: toolStartAt,
                      endAt: Date.now(),
                    },
                    nodeId,
                  });
                  kctx.allToolCalls.push({
                    toolName,
                    arguments: parsedArgs,
                    result: resultText,
                    durationMs: 0,
                    success: true,
                    phase: 'done',
                    pageUrl: kctx.lastPageUrl,
                  });
                  kctx.conversationMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: resultText,
                  });
                  eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                  // 该工具已由宿主处理，跳过下方通用执行逻辑
                  continue;
                }

                // 执行参数（intern_search 需注入 current_node_id，见下）
                let execArgs = tc.function.arguments;

                // ①.4 P4a-3-3 迁移 planner 卡片，行为不变：planner 结构化确认卡片已从 route if 分支
                //     收敛为注册式 host-pending 分发（tool-pipeline.ts）。判定（identity==='planner' &&
                //     PLANNER_CARD_TOOLS）+ 卡片构建（buildPlannerCard）+ planner_confirm SSE 载荷 /
                //     20s 心跳 / denied·timeout 措辞 / 落账三连 / continue 语义均在注册 handler
                //     （handlePlannerCard，见模块级注册）内逐位复刻。本咨询点特有职责：
                //       a) 把身份（identity）+ 挂起登记用原始参数串（execArgs）+ 结果落账
                //          commitToolError 注入 ctx；setExecArgs 写回通道绑定本轮 let parsedArgs /
                //          execArgs —— approved + edited.toolArgs 覆盖后回落通用执行即用新参数
                //          （等价迁移前「parsedArgs = editedArgs; execArgs = JSON.stringify」覆盖路径）；
                //       b) verdict 流控：'handled_continue'（denied/timeout）→ continue；
                //          'handled_fallback'（approved）→ planner 卡已接管确认 → 跳过下方 tool_confirm
                //          consult（等价迁移前 consult 后 usesPlannerCard → noop 的照常执行，且避免
                //          重复弹窗）；'noop'（非 planner 身份/名单外/卡片构建失败）→ 照常进入
                //          tool_confirm consult。
                //     咨询点物理位置保持在 tool_confirm（①.5）之前 —— planner 先判的顺序约束不因迁移改变。
                const plannerTakeover = hostTakeoverFor(toolName, 'planner_confirm', 'pre');
                // 编辑覆盖中间通道：approved + edited.toolArgs 时 handler 经 ctx.setExecArgs 写入，
                // handle() 返回后再同步应用到本轮 parsedArgs / execArgs（避免在异步闭包内改写捕获
                // 变量导致后续类型收窄失效）
                let plannerEditedExecArgs: string | null = null;
                let plannerCardCovered = false;
                if (plannerTakeover) {
                  // 本轮参数快照（denied/timeout 时与 parsedArgs 同引用；落账/ctx.args 均用快照，
                  // 与 tool_confirm 咨询点 confirmToolArgs 同构 —— 嵌套闭包内读取捕获 let 会退回
                  // 声明类型，快照 const 保持收窄）
                  const plannerCardArgs = parsedArgs;
                  const plannerVerdict = await plannerTakeover.handle({
                    name: toolName,
                    args: plannerCardArgs,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    // 请求作用域注入：身份（planner 专属判定）+ 挂起登记用原始参数串 + 编辑覆盖写回通道
                    identity,
                    execArgs,
                    setExecArgs: (raw) => {
                      plannerEditedExecArgs = raw;
                    },
                    // 结果落账：approved 走 handled_fallback 落回下方通用执行（executeTool 成功落账在
                    // 通用路径完成，commitToolResult 仅为 ctx 接口必填、本 handler 不调用）；
                    // denied/timeout 的 error 三连由 commitToolError 复刻原分支（success:false /
                    // phase:'error' / 无 pageUrl 字段，arguments 用本轮快照）。
                    commitToolResult: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: plannerCardArgs,
                        result: resultText,
                        durationMs: 0,
                        success: true,
                        phase: 'done',
                        pageUrl: kctx.lastPageUrl,
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                    commitToolError: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: plannerCardArgs,
                        result: resultText,
                        durationMs: 0,
                        success: false,
                        phase: 'error',
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                  });
                  // denied/timeout 已由宿主处理（error 回灌 + 落账）→ 跳过下方通用执行逻辑
                  if (plannerVerdict === 'handled_continue') continue;
                  // approved（handled_fallback）：先用用户编辑后的参数覆盖本轮执行参数（等价迁移前
                  // 「parsedArgs = editedArgs; execArgs = JSON.stringify(parsedArgs)」路径），再标记卡已
                  // 接管确认 → 跳过 tool_confirm consult、回落通用执行
                  if (plannerVerdict === 'handled_fallback') {
                    if (plannerEditedExecArgs !== null) {
                      parsedArgs = JSON.parse(plannerEditedExecArgs) as Record<string, unknown>;
                      execArgs = plannerEditedExecArgs;
                    }
                    plannerCardCovered = true;
                  }
                }

                // ①.5 P4a-3-2 迁移：tool_confirm（需手动确认名单通用确认）已从 route if 分支收敛为
                //     注册式 host-pending 分发（tool-pipeline.ts，行为不变）。咨询点物理位置保持
                //     在 planner 结构化卡片段（①.4）之后 —— planner 先判的顺序约束不因迁移改变：
                //     planner 卡已覆盖的排程工具（identity==='planner' 且属 PLANNER_CARD_TOOLS）不重复
                //     弹通用确认、名单外工具不接管，均由注册 handler（handleToolConfirm，见模块级注册）
                //     依据 ctx 注入的 identity + confirmTools（settingsForTools.confirmTools ??
                //     DEFAULT_CONFIRM_TOOLS，运行期配置不可由模块级 handler 持有）判定后返回 'noop'；
                //     denied/timeout 的 SSE tool_result(error)·措辞区分·落账三连·循环 continue 亦在
                //     handler 内逐位复刻（'handled_continue'）；approved → 'handled_fallback' 回落下方
                //     通用执行（args 原样，通用确认不回灌编辑参数，与迁移前一致）。
                //     衔接（P4a-3-3）：planner consult（①.4）verdict === 'handled_fallback'（approved，
                //     args 可能已经 setExecArgs 覆盖）→ 卡已接管确认，直接跳过本 consult（等价迁移前
                //     consult 后 usesPlannerCard → noop 的照常执行，无任何副作用差异）；仅 planner
                //     verdict === 'noop'（含卡片构建失败 → usesPlannerCard 冗余判定在 handleToolConfirm
                //     内保留，保证仍不弹通用确认）或 planner 未命中时本 consult 才执行。
                const confirmTakeover = hostTakeoverFor(toolName, 'tool_confirm', 'pre');
                if (confirmTakeover && !plannerCardCovered) {
                  const confirmToolArgs = parsedArgs;
                  const confirmVerdict = await confirmTakeover.handle({
                    name: toolName,
                    args: confirmToolArgs,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    // 请求作用域注入：身份（planner 卡覆盖判定）+ 当前生效手动确认名单 + 审批策略
                    // （P4b-1：settings.approval?.defaultStrategy ?? 'allow_scope'，默认档与现网
                    // 逐位一致）+ 挂起登记用原始参数串
                    identity,
                    confirmTools: settingsForTools.confirmTools ?? DEFAULT_CONFIRM_TOOLS,
                    approvalStrategy:
                      (identity ? settingsForTools.approval?.perAgent?.[identity] : undefined)
                      ?? settingsForTools.approval?.defaultStrategy
                      ?? 'allow_scope',
                    execArgs,
                    // 结果落账：approved 走 handled_fallback 落回下方通用执行（executeTool 成功落账在
                    // 通用路径完成，此处不产成功落账）；denied/timeout 的 error 三连由 commitToolError
                    // 复刻原分支（success:false / phase:'error' / 无 pageUrl 字段，arguments 用本轮快照）。
                    commitToolResult: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: confirmToolArgs,
                        result: resultText,
                        durationMs: 0,
                        success: true,
                        phase: 'done',
                        pageUrl: kctx.lastPageUrl,
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                    commitToolError: (resultText) => {
                      kctx.allToolCalls.push({
                        toolName,
                        arguments: confirmToolArgs,
                        result: resultText,
                        durationMs: 0,
                        success: false,
                        phase: 'error',
                      });
                      kctx.conversationMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
                      eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: resultText, name: toolName });
                    },
                  });
                  // denied/timeout 已由宿主处理（error 回灌 + 落账）→ 跳过下方通用执行逻辑
                  if (confirmVerdict === 'handled_continue') continue;
                  // approved（handled_fallback）→ 继续本轮通用执行；noop（名单外/planner 卡覆盖）→ 照常执行
                }

                // ② 执行前：phase=running（单独发一条"更新"事件，前端接收到替换 pending）
                send({
                  tool_call_update: {
                    name: toolName,
                    phase: 'running',
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                  },
                  nodeId,
                });

                // AI Coding 专项任务循环：按工具映射循环阶段（改码→预览自检→测试），
                // SSE 推送 coding_phase 供前端渲染循环状态条；非编码工具不改变当前阶段
                if (profile.id === 'coding') {
                  const loopPhase = codingPhaseForTool(toolName);
                  if (loopPhase) {
                    send({ coding_phase: { phase: loopPhase, tool: toolName }, nodeId });
                  }
                }

                // 执行工具前 args 注入：intern_search 需要 current_node_id 做祖先链校验；read_file/
                // write_file/rename_file/delete_file 需要 current_node_id 做 homework/ 文件归属隔离与
                // .ownership.json 清册维护；execute_script/run_command 需要 current_node_id 注入
                // BOB_NODE_HOMEWORK 产出目录；Coding 节点另需 node_sandbox_app_id 强制写操作落
                // bob-sandbox/apps/<appId>/（不落 homework）。P4a-2a 迁移：名单与注入规则收敛为
                // 注册式 args_transform 接管（tool-pipeline.ts，行为不变）——命中返回注入后的参数
                // 字符串、未命中/解析失败返回 null 原样执行。
                const nodeParamTakeover = takeoverOfKind(toolName, 'args_transform');
                const injectedExecArgs = nodeParamTakeover?.transformArgs?.(toolName, execArgs, {
                  currentNodeId: nodeId,
                  sandboxAppId: toolLoopSandboxAppId,
                });
                if (injectedExecArgs !== null && injectedExecArgs !== undefined) {
                  execArgs = injectedExecArgs;
                }
                // 工具输出上限按请求模型动态计算（1M→50000，小模型自动收缩），替代固定 maxOutput
                // 长耗时工具 keepalive：read_attachment 等工具内部做 OCR/视觉识别可达 60-120s，
                // 期间 SSE 无任何数据会被前端 90s 空闲超时误杀（后台仍在工作）。每 20s 发一条
                // tool_call_update(running) 心跳保持连接，工具完成即清除（前端对重复 running 幂等）。
                const keepalive = setInterval(() => {
                  send({ tool_call_update: { name: toolName, phase: 'running', spanId: toolSpanId, startAt: toolStartAt }, nodeId });
                }, 20000);
                // Bobby 触发事件：主 Agent 调用 Bobby 插件工具 → SSE 推送 bobby_trigger，
                // 画布据此自动打开（创建/激活）BobbyNode 并建立「发起节点 → BobbyNode」的连线。
                if (toolName.startsWith('mcp__bobby__')) {
                  send({ bobby_trigger: { tool: toolName }, nodeId });
                }
                // Agent Teams 触发事件：主 Agent 调用团队编排工具（mcp__team__*）→ SSE 推送
                // team_trigger，画布据此自动打开（创建/激活）AgentTeamsNode 实时展示团队执行过程。
                if (toolName.startsWith('mcp__team__')) {
                  send({ team_trigger: { tool: toolName }, nodeId });
                }
                let execResult: { result: string; durationMs: number; success: boolean; cardHtml?: string };
                try {
                  execResult = await executeTool(toolName, execArgs, toolOutputMaxForContext(requestContextWindow), {
                    // OCR 过程级进度（read_attachment 扫描件/图片识别走 bob-ocr-mcp）：插件实时上报引擎/页码
                    // → 转为 vision_progress(phase='ocr') SSE 事件，前端显示"正在识别 第N/M页 · 本地 Vision"等
                    onOcrProgress: (p) =>
                      send({
                        vision_progress: {
                          phase: 'ocr',
                          current: (p.pageIndex ?? 0) + 1,
                          total: p.totalPages ?? 0,
                          engine: p.engine,
                          model: p.model,
                        },
                        nodeId,
                      }),
                  });
                } finally {
                  clearInterval(keepalive);
                }

                // P4a-3-4 迁移 grant/login（bobby grant SSE 旁路 + browser.login 挂起型接管），行为不变：
                // 两段已从 route if 分支收敛为注册式 host-pending 分发（tool-pipeline.ts，kind 'grant' /
                // 'login'，phase post；handler 见模块级注册 handleBobbyGrant / handleBrowserLogin）。
                // 咨询点物理位置保持在 executeTool 之后、load_skill 场景激活（post）之前 —— 与迁移前
                // 分支所在窗口一致；execResult.success 是两分支原 if 的第一条件，咨询点据此门控，
                // 工具名/内容判定由注册 match + handler 内完成：
                //   · grant（mcp__bobby__*）：命中 grantRequired → handler 发 SSE grant_required 旁路并
                //     'handled_fallback'（原 send 后无 continue，回落通用路径原文落账）；未命中 'noop'。
                //   · login（browser.login）：loginRequired 挂起 → 20s 心跳 → 前端回传凭据（POST
                //     /api/chat/login）→ login_fill 代填（redactArgs 脱敏）→ handler 经 ctx.setExecResult
                //     把三分支新 execResult 写回 loginExecOverride，handle() 返回后宿主覆盖 execResult ——
                //     随后照常落入通用落账（send tool_result / tool_span / kctx.allToolCalls / 对话历史 /
                //     eventLog），与迁移前分支体直接改写 execResult 后继续向下逐位等价；loginRequired
                //     未命中 → 'noop'（execResult 原样）。
                const grantTakeover = hostTakeoverFor(toolName, 'grant', 'post');
                if (execResult.success && grantTakeover) {
                  await grantTakeover.handle({
                    name: toolName,
                    args: parsedArgs,
                    result: execResult.result,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    // grant 为 SSE 旁路、不自产落账（新 execResult 不覆盖、通用路径完成），接口占位
                    commitToolResult: () => { /* 占位：grant handler 不调用，落账走通用路径 */ },
                  });
                }
                const loginTakeover = hostTakeoverFor(toolName, 'login', 'post');
                if (execResult.success && loginTakeover) {
                  // 登录代填结果写回通道：handler 在 loginRequired 命中后经 setExecResult 写入，
                  // handle() 返回后再应用到 execResult（避免在异步闭包内改写捕获变量，与 ①.4
                  // setExecArgs 同构）；未命中（'noop'）时保持 null → execResult 原样走通用路径。
                  let loginExecOverride: { result: string; durationMs: number; success: boolean; cardHtml?: string } | null = null;
                  const loginVerdict = await loginTakeover.handle({
                    name: toolName,
                    args: parsedArgs,
                    result: execResult.result,
                    pageUrl: kctx.lastPageUrl ?? undefined,
                    nodeId,
                    send,
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    setExecResult: (r) => { loginExecOverride = r; },
                    // login 不自产落账（新 execResult 回落通用路径完成），接口占位
                    commitToolResult: () => { /* 占位：login handler 不调用，落账走通用路径 */ },
                  });
                  // 挂起型 handler 本不产 continue（原分支体无 continue）；防御性保留流控
                  if (loginVerdict === 'handled_continue') continue;
                  if (loginExecOverride) execResult = loginExecOverride;
                }

                // load_skill 加载法律技能 → 联动激活 legal 场景并重建工具集：
                // 技能正文要求法条核对必须走北大法宝(pkulaw)，但 pkulaw 工具仅当 legal 场景激活才可见；
                // 而首轮用户消息未必命中 detectSceneHints 法律关键词（如"执行款清偿顺序"类提问），
                // 若不在此兜底激活，模型加载技能后依然看不到 pkulaw 工具，只能退化到 web_search/web_fetch。
                // P4a 三段化骨架：本段已收敛为注册式 post-execute 接管（tool-pipeline.ts，行为不变）——
                // 仅当工具执行成功（execResult.success）且工具在注册表中被 scenario_activate 命中才咨询；
                // 激活/sticky/kctx.needRebuildTools 由 applyScenarioActivation 统一执行。
                const legalSkillTakeover = takeoverFor(toolName, 'post');
                if (execResult.success && legalSkillTakeover && legalSkillTakeover.kind === 'scenario_activate') {
                  const scenarioDecision = legalSkillTakeover.handleScenario?.(toolName, parsedArgs) ?? null;
                  if (scenarioDecision) {
                    const { newlyActivated, hint } = applyScenarioActivation(scenarioDecision, takeoverServices);
                    // 激活提示仅首次激活（legal 之前未激活）时追加到工具结果尾部（与原 if 分支一致）
                    if (newlyActivated.includes('legal') && hint) {
                      execResult = {
                        ...execResult,
                        result: execResult.result + '\n\n' + hint,
                      };
                    }
                  }
                }

                const finalPhase: 'done' | 'error' = execResult.success ? 'done' : 'error';

                // 执行轨迹元数据：类型（内置工具/MCP）+ 系统变更标记（安装/写文件/改配置）+ 结果摘要
                const traceKind: 'tool' | 'mcp' = toolName.startsWith('mcp__') ? 'mcp' : 'tool';
                const change = classifySystemChange(toolName, parsedArgs);
                const traceSummary = (execResult.result || '')
                  .trim().replace(/\s+/g, ' ')
                  .slice(0, 200);

                // ③ 发送 tool_result 事件（带最终 phase + 轨迹元数据 + span 时间戳）
                const toolEndAt = Date.now();
                send({
                  tool_result: {
                    name: toolName,
                    result: execResult.result.slice(0, 2000),
                    durationMs: execResult.durationMs,
                    success: execResult.success,
                    phase: finalPhase,
                    // P0 轨迹：稳定 spanId + 真实时间戳（前端 P0 忽略，P1 据此稳定渲染 + 真实耗时）
                    spanId: toolSpanId,
                    startAt: toolStartAt,
                    endAt: toolEndAt,
                    // 方案B：展示卡片随事件下发，前端独立渲染
                    cardHtml: execResult.cardHtml,
                    // 执行轨迹：类型 + 系统变更 + 结果摘要（供前端内联步骤流直接使用）
                    kind: traceKind,
                    systemChange: change.change,
                    changeSummary: change.summary,
                    summary: traceSummary,
                  },
                  nodeId,
                });
                // P0 轨迹：记录结构化 span 标记（start/end）
                eventLog.mark('tool_span', toolSpanId, { name: toolName, phase: finalPhase, durationMs: execResult.durationMs }, toolStartAt, toolEndAt);

                // 附件解析结果持久化到所属节点引用区（供下游 intern_search 溯源命中）
                if (toolName === 'read_attachment' && execResult.success && projectRoot) {
                  const attPath = typeof parsedArgs.path === 'string' ? parsedArgs.path : '';
                  if (attPath) {
                    try {
                      const { persistAttachmentReference } = await import('@/lib/nodes/references');
                      await persistAttachmentReference(attPath, execResult.result, projectRoot);
                    } catch { /* 引用区写入失败不影响主流程 */ }
                  }
                }

                // 浏览器工具执行成功 → 刷新页面 URL 指纹（供去重判断感知页面跳转）
                if (execResult.success && isPageStateTool(toolName)) {
                  const u = await fetchCurrentPageUrl();
                  if (u) kctx.lastPageUrl = u;
                }

                // 记录工具调用
                kctx.allToolCalls.push({
                  toolName,
                  arguments: parsedArgs,
                  result: execResult.result,
                  durationMs: execResult.durationMs,
                  success: execResult.success,
                  phase: finalPhase,
                  kind: traceKind,
                  systemChange: change.change,
                  changeSummary: change.summary,
                  summary: traceSummary,
                  pageUrl: kctx.lastPageUrl,
                });

                // 工具结果加入对话历史（成本控制：超长结果按工具类型压缩后再进模型上下文。
                // P4a-2a 迁移：压缩判定收敛为注册式 post result_compact 通用接管（tool-pipeline.ts，
                // 行为不变 —— 阈值 / 保头保尾 / LIST_LIKE 提示文案均由 compactToolResult 原样产出，
                // 全工具命中、仅超阈值结果才实际压缩）；SSE tool_compact 帧与压缩日志仍由宿主按
                // compacted 标志发送（pipeline 不产 SSE）。
                const compactTakeover = takeoverOfKind(toolName, 'result_compact', 'post');
                const compactOut = compactTakeover?.compactResult?.(toolName, execResult.result) ?? null;
                const toolMsgContent = compactOut ? compactOut.text : execResult.result;
                const toolResultCompacted = compactOut ? compactOut.compacted : false;
                kctx.conversationMessages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: toolMsgContent,
                });
                eventLog.mark(CORE_EVENT.TOOL_RESULT, `${taskId}:r${round}`, { round, role: 'tool', tool_call_id: tc.id, content: toolMsgContent, name: toolName });
                if (toolResultCompacted) {
                  console.warn(`[工具结果压缩] ${toolName} 结果超长，已保头保尾压缩（原文约 ${Math.ceil(execResult.result.length / 2.5).toLocaleString()} tokens）`);
                  send({ tool_compact: { name: toolName }, nodeId });
                }
              }

              // ===== 停滞保护检测（不是轮数限制，只防死循环烧钱）=====
              // 任务在推进（本轮有成功且非重复、结果非空的工具调用）→ 清零停滞计数，循环继续；
              // 连续 STALL_LIMIT 轮无任何实质进展 → 判定模型陷入死循环，强制收尾
              const roundHasProgress = kctx.allToolCalls
                .slice(roundStartToolCount)
                .some((t) => t.success && !t.result.startsWith('跳过重复调用') && t.result.trim().length > 0);
              if (roundHasProgress) {
                kctx.stallCount = 0;
              } else {
                kctx.stallCount++;
                if (kctx.stallCount >= STALL_LIMIT) {
                  // 连续多轮无进展 → 判定死循环：注入收尾说明，下一轮进入强制收尾轮（不带 tools）
                  kctx.conversationMessages.push({
                    role: 'user',
                    content: '连续多轮工具执行未取得实质进展（工具失败或未产生新结果），疑似陷入循环。请停止重试，基于现有结果给出最终回答，并在回答末尾用【未完成项】列出未能完成的部分。',
                  });
                  send({ stall_detected: true, rounds: kctx.stallCount, nodeId });
                  kctx.forceFinalRound = true;
                  continue;
                }
              }

              // ===== OCR 重试预算门控：同一文件反复识别不收敛 → 停止空转，报 NEED_REVIEW =====
              // 手写字段（姓名/身份证/日期）VLM 每次可能给出不同候选，推进但不收敛，停滞保护抓不住。
              // 这里对 ocr_document/crop_image 针对同一文件的累计调用计数，超预算即注入"停止重试"指令。
              if (!kctx.ocrBudgetExceeded) {
                const ocrCalls = kctx.allToolCalls.filter(
                  (t) =>
                    (t.toolName === 'ocr_document' || t.toolName === 'crop_image') &&
                    t.arguments &&
                    typeof t.arguments.path === 'string' &&
                    t.arguments.path.trim().length > 0,
                );
                const perFile = new Map<string, number>();
                for (const c of ocrCalls) {
                  const key = String(c.arguments.path).trim();
                  perFile.set(key, (perFile.get(key) ?? 0) + 1);
                }
                const worst = [...perFile.entries()].sort((a, b) => b[1] - a[1])[0];
                if (worst && worst[1] >= OCR_REOCR_BUDGET) {
                  kctx.ocrBudgetExceeded = true;
                  kctx.conversationMessages.push({
                    role: 'user',
                    content: `你已对文件「${worst[0]}」尝试识别 ${worst[1]} 次仍未得到稳定结果（手写识别多次给出不同候选，属正常波动）。请停止继续重试该文件，基于已有候选给出你最有把握的答案，并在答案末尾用【需人工复核】列出置信度低/版本不一致的字段（如姓名、身份证号、日期），交给人工核对原件。不要再次调用 ocr_document / crop_image 识别该文件。`,
                  });
                  send({ ocr_budget_exceeded: true, file: worst[0], retries: worst[1], nodeId });
                }
              }

              // 继续下一轮循环，让模型基于工具结果继续思考
            }

            // 如果达到最大轮次，发送工具摘要
            if (kctx.allToolCalls.length > 0) {
              send({
                tool_summary: {
                  total: kctx.allToolCalls.length,
                  names: [...new Set(kctx.allToolCalls.map((t) => t.toolName))],
                },
                nodeId,
              });
            }

            // 发送本次交互中产生的输出文件卡片（homework/、attachments/）
            try {
              const workspacePath = projectRoot
                ? join(projectRoot, 'homework', '.ai-workspace')
                : join(homedir(), 'BobWork', SANDBOX_DIRNAME);
              const _pr = projectRoot || join(homedir(), 'BobWork', SANDBOX_DIRNAME);
              const outputFiles = extractOutputFiles(kctx.allToolCalls, _pr, workspacePath);
              // 合并续写请求携带的初始产物（如模板填充面板生成的文件）：
              // 仅接受项目内 homework/、attachments/ 相对路径，拒绝路径穿越
              if (Array.isArray(initialOutputFiles)) {
                for (const f of initialOutputFiles) {
                  const raw = String((f as { path?: unknown })?.path || '').replace(/\\/g, '/');
                  if (!/^(homework|attachments)\//.test(raw) || raw.includes('..')) continue;
                  if (outputFiles.some((o) => o.path === raw)) continue;
                  let size = Number((f as { size?: unknown })?.size) || 0;
                  try {
                    size = statSync(resolve(_pr, raw)).size;
                  } catch { /* 保持 0 */ }
                  outputFiles.push({
                    path: raw,
                    name: basename(raw),
                    size,
                    kind: classifyOutputKind(raw),
                    source: 'template_fill',
                  });
                }
              }
              // 兜底：比对 homework/ 目录快照，把本轮任何新写入的成果文件（含脚本产物）补进输出卡片
              // （按 .ownership.json 归属过滤，并行节点的产物不入本卡片）
              if (projectRoot && kctx.homeworkSnapshot) {
                for (const f of await diffHomeworkFiles(kctx.homeworkSnapshot, projectRoot, nodeId)) {
                  if (!outputFiles.some((o) => o.path === f.path)) outputFiles.push(f);
                }
              }
              if (outputFiles.length > 0) {
                send({
                  output_files: outputFiles,
                  nodeId,
                });
              }
            } catch { /* ignore */ }



            // ark/部分 DeepSeek 网关不返回 prompt_cache_miss_tokens：miss 按 prompt - hit 派生，保证命中率口径正确
            if (kctx.taskUsage.cacheMissTokens === 0 && kctx.taskUsage.promptTokens > kctx.taskUsage.cacheHitTokens) {
              kctx.taskUsage.cacheMissTokens = kctx.taskUsage.promptTokens - kctx.taskUsage.cacheHitTokens;
            }
            const hitTotal = kctx.taskUsage.cacheHitTokens + kctx.taskUsage.cacheMissTokens;
            const hitRatio = hitTotal > 0 ? (kctx.taskUsage.cacheHitTokens / hitTotal) * 100 : 0;
            // 完成轮次统计（dsh）：TTFT（首 token 延迟）/ 总耗时 / 输出吞吐
            const taskDurationMs = Date.now() - kctx.taskStartMs;
            const ttftMs = kctx.firstTokenMs !== null ? kctx.firstTokenMs - kctx.taskStartMs : null;
            const tokensPerSec = taskDurationMs > 0
              ? Math.round((kctx.taskUsage.completionTokens / taskDurationMs) * 1000)
              : 0;
            console.log(
              `[chat] done | model: ${providerModelId} | prompt: ${kctx.taskUsage.promptTokens} | out: ${kctx.taskUsage.completionTokens} | cacheHit: ${kctx.taskUsage.cacheHitTokens} | cacheMiss: ${kctx.taskUsage.cacheMissTokens} | hitRate: ${hitRatio.toFixed(1)}% | calls: ${kctx.taskUsage.calls}` +
              ` | rounds: ${kctx.totalRounds} (thinkingDowngraded: ${kctx.thinkingDowngradedRounds})` +
              ` | duration: ${taskDurationMs}ms | ttft: ${ttftMs ?? 'n/a'}ms | tok/s: ${tokensPerSec}`,
            );

            // 最终上下文占用（含工具结果回灌）：done 事件内附带，前端更新 composer 圆环
            const finalCtx = estimateContextBreakdown(kctx.conversationMessages, loopToolDefs);

            // AI Coding 专项任务循环：整轮结束（含工具循环）→ 推送 done，前端循环状态条回到"完成"
            if (profile.id === 'coding') {
              send({ coding_phase: { phase: 'done' }, nodeId });
            }

            send({
              done: true,
              nodeId,
              taskId,
              // P3-3b2：本轮实际使用模型（provider:modelId），供外部客户端与后续消息落盘
              model: modelTag,
              matchedSkills: matchedSkillNames,
              skillDetails,
              usage: kctx.taskUsage,
              stats: { ttftMs, durationMs: taskDurationMs, tokensPerSec },
              // 缓存命中率遥测（P1）：显式下发 hitRate，随事件日志落盘供离线复盘
              cache: {
                hitRate: hitTotal > 0 ? Math.round(hitRatio * 10) / 10 : 0,
                cacheHitTokens: kctx.taskUsage.cacheHitTokens,
                cacheMissTokens: kctx.taskUsage.cacheMissTokens,
              },
              contextMeter: {
                system: finalCtx.systemTokens,
                tools: finalCtx.toolsTokens,
                conversation: finalCtx.conversationTokens,
                capacity: inferContextWindow(
                  providerModelId || '',
                  !!(reasoningEffort || deepseekThinkingMode),
                ),
              },
              prefixHash,
              prefixSegments,
            });
            // 用量统计：本轮真实 token 流水落库（task_id 幂等；失败仅告警，不阻塞收尾）
            if (projectRoot) {
              try {
                const { recordTaskUsage } = await import('@/lib/usage');
                await recordTaskUsage({
                  projectRoot,
                  taskId,
                  nodeId,
                  agent: profile.id,
                  model: providerModelId || modelId || 'unknown',
                  usage: kctx.taskUsage,
                  rounds: kctx.totalRounds,
                  durationMs: taskDurationMs,
                  ttftMs,
                });
              } catch (usageErr) {
                console.warn('[usage] 用量落库失败（不影响本轮结果）:', usageErr);
              }
            }
            eventLog.mark(CORE_EVENT.TURN_END, taskId, { rounds: kctx.totalRounds });
            // P0 轨迹：任务正常结束时持久化事件日志（为 P2 历史恢复铺路）
            if (projectRoot) {
              persistEventLog(`${projectRoot}/.trajectory/${nodeId}/${taskId}.jsonl`, eventLog.finalize());
            }
            controller.close();
          } catch (error) {
            let errorMessage =
              error instanceof Error ? error.message : 'Unknown error';
            if (errorMessage.includes('model') && (errorMessage.includes('not found') || errorMessage.includes('does not exist'))) {
              errorMessage = `模型 "${providerModelId}" 不可用，请检查该模型是否已在当前 API Key 下开通。可在设置中重新获取模型列表并选择可用模型。`;
            }
            if (errorMessage.includes('401') || errorMessage.includes('Authentication')) {
              errorMessage = 'API Key 认证失败，请检查设置中的 API Key 是否正确。';
            }
            if (errorMessage.includes('402') || errorMessage.includes('insufficient')) {
              errorMessage = 'API 账户余额不足，请充值后重试。';
            }
            if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
              errorMessage = '请求过于频繁，请稍后再试。';
            }
            send({ error: errorMessage, nodeId, taskId });
            // P0 轨迹：异常结束时也持久化已有事件日志
            if (projectRoot) {
              persistEventLog(`${projectRoot}/.trajectory/${nodeId}/${taskId}.jsonl`, eventLog.finalize());
            }
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } else {
      // 托管模型（coze）通道已移除（2026-08）：所有模型必须配置 API Key（自定义 provider）
      return new Response(
        JSON.stringify({ error: '未配置模型：请先在设置中配置 API Key 并选择模型，再发送消息。' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
