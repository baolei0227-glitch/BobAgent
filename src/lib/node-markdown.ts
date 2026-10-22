import matter from 'gray-matter';
import { homedir } from 'os';
import { renderOutcome, parseOutcome, createEmptyOutcome, type Outcome } from '@/lib/nodes/outcome';
import { collectAnchorIds, generateAnchorId } from '@/lib/nodes/anchor';
import type { SubagentPanel } from '@/lib/types';

// ==================== 数据模型 ====================

/**
 * AI Coding 创建简报（创建对话框 → 节点 frontmatter → coding 注入）。
 *
 * 存在意义：用户在创建时**显式开启 Fast build** 并确认一份可编辑简报后，coding 首轮
 * 直接按简报出首版，不再弹 6 问 Spec。默认（未开启 Fast build / 旧节点）仍走 6 问。
 * 因此 fast_build 是唯一的跳过开关；缺省 = 完全保持原有 6 问行为。
 */
export interface SandboxSpec {
  category?: string;
  audience?: string;
  interaction?: string;
  persistence?: string;
  style?: string;
  ai?: string;
  /** 用户创建时的原始愿望（截断存储） */
  wish?: string;
  /** 简报来源：template = 模板种子；wish = 愿望推断 */
  source?: 'template' | 'wish';
  /** 用户显式开启 Fast build 并确认简报：true 才允许 coding 首轮跳过 6 问 */
  fast_build?: boolean;
}

const SANDBOX_SPEC_TEXT_KEYS = ['category', 'audience', 'interaction', 'persistence', 'style', 'ai', 'wish'] as const;

/** 归一化创建简报：只保留已知文本字段并限长，避免 frontmatter 被任意 payload 撑大。 */
export function normalizeSandboxSpec(raw: unknown): SandboxSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: SandboxSpec = {};
  for (const key of SANDBOX_SPEC_TEXT_KEYS) {
    const value = src[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 600);
  }
  if (src.source === 'template' || src.source === 'wish') out.source = src.source;
  // Fast build 是唯一允许跳过 6 问的显式标记；只认 true（字符串/false 一律不写）
  if (src.fast_build === true) out.fast_build = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface NodeFrontmatter {
  node_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sources: string[];
  model?: string;
  tags?: string[];
  initial_prompt?: string;
  thinking_level?: 'off' | 'low' | 'medium' | 'high';
  attachment_hint?: string;
  skills?: string[];
  // ===== v3 新增（节点记忆与继承规格 v3 §二）=====
  parent_nodes?: string[];
  outcome_status?: 'locked' | 'draft' | 'stale' | 'legacy';
  outcome_locked_at?: string;
  outcome_version?: number;
  /** 成果块已覆盖的对话轮次数（append/手动提取成果块成功时更新）；锁定前据此判断是否存在未提炼的新对话 */
  outcome_turns?: number;
  /** 研究结论回流已覆盖的对话轮次数（后台静默窗回流成功后更新）：
   *  幂等游标 —— 无新轮次则连模型都不调，见 @/lib/nodes/note-ingest-auto */
  note_ingest_turns?: number;
  /** 强制锁定标记：校验未通过但用户自主决定锁定（R-1~R-8b 有未达标项） */
  outcome_force_locked?: boolean;
  /** 成果块失效原因（R-10 级联）：写下可读的前提失效链，注入侧据此告诉下游模型「哪条前提已废」；
   *  仅在 outcome_status === 'stale' 期间有意义，重新锁定/重新生成时清除 */
  outcome_stale_reason?: string;
  /** 锁定留痕（签署）：发起锁定/强制锁定的操作者标识（本地用户名或 'unknown'）。
   *  属「自称」留痕，用于事后追溯「谁签的字」，不作为密码学意义上的不可否认证据。 */
  outcome_locked_by?: string;
  /** 锁定时的成果块内容哈希（SHA-256(renderOutcome(outcome)) 前 32 位 hex）：
   *  注入/继承前据此校验「盘上的成果块是否仍是签字那一刻的那一份」，不一致则降级为警告。 */
  outcome_content_hash?: string;
  /** 追加式锁定历史（P0-a 外部锚点在节点侧的镜像）：每次锁定/重锁 push 一条，
   *  与项目级台账 .ledger/locks.md 双向比对，防止正文与哈希被一并重写。 */
  outcome_lock_history?: Array<{ version: number; hash: string; by?: string; at: string; prev?: string }>;
  /** 画布节点位置（重启恢复用；缺省时按网格排列） */
  position_x?: number;
  position_y?: number;
  outcome_user_edited?: boolean;
  outcome_template?: string;
  memory_compacted_at?: string;
  memory_compacted_until?: number;
  memory_turn_count?: number;
  /** T2 一次性回声标记（gap 修复）：route（R-14-C/预算前瞻）在 chat 请求内折叠推进游标后置位，
   *  随折叠写回持久化；同轮 append 读到后把真实游标随响应 compacted 回传前端并清除本标记。
   *  属瞬态协调字段（非记忆内容），序列化仅在 === true 时写出。 */
  memory_compacted_pending_echo?: boolean;
  manifest_hash?: string;
  /** 节点级 MCP 选择：undefined=跟随全局设置；[]=显式全关；[id]=自定义启用 */
  enabledMcpIds?: string[];
  /** 节点级技能强制勾选：undefined=未自定义；[name]=强制注入 */
  selectedSkills?: string[];
  /** 多智能体协作模式（chat 节点「Multi-agent mode」开关）：true=主 agent 只作用户代理，队长会话负责编排 */
  multi_agent_mode?: boolean;
  /** team 模式队长模型（provider:modelId）：Team 分栏「Main model」选择，跑队长会话（规划 + 复核/整合） */
  team_main_model?: string;
  /** team 模式成员模型（provider:modelId）：Team 分栏「Worker model」选择，一刀切覆盖全部成员 */
  team_worker_model?: string;
  /** 本节点关联的团队 id 清单（团队工作台用）：只存引用，团队数据真相源在引擎侧 */
  team_ids?: string[];
  /** AI Coding 节点：绑定的小程序（Bob Sandbox app）ID */
  sandbox_app_id?: string;
  /** 管家派发会话的产物暂存批次 id（Outbox）：存在时该节点的交付物落 <appRoot>/outbox/<批次>/，
   *  不写入当前项目 homework/（见 lib/outbox/store.ts） */
  outbox_batch_id?: string;
  /** AI Coding 节点：创建时确认的构建简报（缺省=旧行为，首轮仍走 6 问 Spec） */
  sandbox_spec?: SandboxSpec;
  /** 节点类型：aiChat（默认，缺省）/ imageGen（图像生成节点）等 */
  node_type?: string;
  /** 批注框节点（node_type='annotation'）：包裹的卡片节点 id 列表（自动跟随包围盒用） */
  annotation_node_ids?: string[];
  /** 批注框节点：批注文字（圆角矩形顶部展示） */
  annotation_text?: string;
  /** 星标：用户在画布标记节点重要性（仅画布提示，不影响 AI/排版） */
  starred?: boolean;
  /** md 文档来源锚点（JSON）：创建节点时记录来源文档标识 + 划词文字上下文，
   *  支持反向定位回对应 md 文档位置 */
  md_anchor?: string;
}

export interface ConversationAttachment {
  id: string;
  name: string;
  type: 'image' | 'text' | 'file';
  mimeType: string;
  size: number;
  path: string;
}

/**
 * 本轮 @引用 快照（资料库文件 / 引用本地文件 / 链接材料 / 操作目录）。
 * 落盘为 question 块开头的 `<!-- REFERENCES: [...] -->`，恢复后气泡内仍展示引用 chip。
 */
export interface ConversationReference {
  id: string;
  kind: 'material' | 'file' | 'link' | 'folder';
  name: string;
  path?: string;
  url?: string;
  size?: string;
  locked?: boolean;
}

export interface ConversationTurn {
  question: string;
  answer: string;
  questionTime: string;
  answerTime: string;
  questionAttachments?: ConversationAttachment[];
  /** 本轮 @引用 快照（资料 / 本地文件 / 链接 / 操作目录） */
  questionReferences?: ConversationReference[];
  /** v3 锚点 id（如 'q-003'），全文件唯一，只增不改 */
  anchor?: string;
  /** 该轮回答实际使用的模型 id（auto 模式每轮可能不同；custom 模型为完整配置串） */
  modelId?: string;
  /** 该轮回答实际使用的思考等级（S2b：DSH 四档 off/low/high/max + legacy medium） */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'max';
  /** 该轮回答的思考内容（reasoning_content，think 标签持久化，恢复后仍可回看） */
  reasoning?: string;
  /** 该轮工具调用轮剥离出的执行过程叙述（持久化，恢复后仍可按步骤卡片回看） */
  processNarration?: string;
  /** P2 轨迹：本轮任务的轨迹事件日志 id（对应 .trajectory/<nodeId>/<taskId>.jsonl） */
  taskId?: string;
  /** 该轮回答的工具调用记录（executing steps 持久化） */
  toolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
    result: string;
    durationMs: number;
    success: boolean;
    phase?: string;
  }>;
  /** 该轮回答产生的输出文件卡片（homework/、attachments/ 产物，重启/切换节点后仍可显示） */
  outputFiles?: Array<{
    path: string;
    name: string;
    size: number;
    kind: string;
    source: string;
  }>;
  /** 该轮多智能体协作的成员分支面板（Multi-agent mode 下主 agent 编排的过程，重启后仍可回看） */
  subagents?: SubagentPanel;
}

export interface NodeMarkdown {
  frontmatter: NodeFrontmatter;
  summary: string;
  conversations: ConversationTurn[];
  annotations: string;
  // ===== v3 新增 =====
  /** 成果块（undefined = 旧节点无成果块，标 outcome_status: legacy） */
  outcome?: Outcome;
  /** 压缩记忆（增量压缩产物，v3 §四） */
  compressedMemory?: string;
  /** 引用区（附件解析缓存，v3 §二） */
  references?: string;
}

// ==================== 常量 ====================

const SECTIONS = {
  SUMMARY: '## 摘要',
  OUTCOME: '## 成果块',
  COMPRESSED: '## 压缩记忆',
  CONVERSATION: '## 对话记录',
  REFERENCES: '## 引用区',
  ANNOTATION: '## 批注',
} as const;

// ==================== 工具函数 ====================

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2B50}\u{2B55}\u{231A}-\u{23FA}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}]/gu;
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\n\r\t]/g;

/** 清理标题文本：移除 emoji、非法文件名字符、多余空白 */
export function cleanTitleText(text: string): string {
  let cleaned = text.replace(EMOJI_REGEX, '');
  cleaned = cleaned.replace(INVALID_FILENAME_CHARS, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/** 判断是否为临时文件名（未命名/untitled/temp 等） */
const TEMP_FILENAME_PATTERNS = [
  /^untitled/i,
  /^未命名/i,
  /^temp/i,
  /^tmp/i,
  /^new[-_ ]?file/i,
  /^新建文件/i,
  /^node[_-]?\d+/i,
];

export function isTemporaryFileName(fileName: string): boolean {
  const nameWithoutExt = fileName.replace(/\.md$/i, '');
  return TEMP_FILENAME_PATTERNS.some((pattern) => pattern.test(nameWithoutExt));
}

/** 生成日期后缀：YYYYMMDD */
function dateStamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 将标题转为安全的文件名主体（保留中文，移除非法字符，限制长度） */
export function titleToFileName(title: string, maxLen: number = 30): string {
  const cleaned = cleanTitleText(title);
  if (!cleaned) return '未命名';
  const truncated = cleaned.slice(0, maxLen).trim();
  return truncated || '未命名';
}

/** 根据标题生成文件路径：<主题>-<YYYYMMDD>.md */
export function buildFilePath(title: string, date?: Date): string {
  const name = titleToFileName(title);
  const stamp = dateStamp(date);
  return `notes-memory/${name}-${stamp}.md`;
}

/**
 * 获取工作区根目录
 *
 * 多项目模式：优先从全局变量 CURRENT_PROJECT_PATH（在请求处理时设置）
 * 获取当前项目的绝对路径；回退到环境变量；最后回退到 home 目录。
 */
function getWorkspaceRoot(): string {
  // 优先使用当前请求上下文中的项目路径
  const currentProjectPath = (globalThis as { CURRENT_PROJECT_PATH?: string }).CURRENT_PROJECT_PATH;
  if (currentProjectPath) return currentProjectPath;
  return process.env.COZE_WORKSPACE_PATH || homedir();
}

/** 显式设置当前项目路径（在 API 请求处理开始时调用） */
export function setCurrentProjectPath(projectPath: string): void {
  (globalThis as { CURRENT_PROJECT_PATH?: string }).CURRENT_PROJECT_PATH = projectPath;
}

/** 清除当前项目路径（在 API 请求处理结束时调用） */
export function clearCurrentProjectPath(): void {
  delete (globalThis as { CURRENT_PROJECT_PATH?: string }).CURRENT_PROJECT_PATH;
}

// ==================== 正文分节解析 ====================

const KNOWN_SECTIONS = new Set(['摘要', '成果块', '压缩记忆', '对话记录', '引用区', '批注']);

/** 归一化 section 内容：'（暂无）' / '无' → undefined */
function normalizeSection(text: string | undefined): string | undefined {
  const t = (text || '').replace(/^（暂无）$/, '').replace(/^无$/, '').trim();
  return t || undefined;
}

/** 按二级标题分割正文（只分割已知章节标题，保留 AI 回复中的 Markdown 标题） */
function splitSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split('\n');
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const sectionName = line.slice(3).trim();
      if (KNOWN_SECTIONS.has(sectionName)) {
        if (currentSection) {
          sections.set(currentSection, currentContent.join('\n').trim());
        }
        currentSection = sectionName;
        currentContent = [];
        continue;
      }
    }
    currentContent.push(line);
  }
  if (currentSection) {
    sections.set(currentSection, currentContent.join('\n').trim());
  }
  return sections;
}

/**
 * 剥离 question 块开头的单行元信息注释（`<!-- META: ... -->` / `<!-- ATTACHMENTS: ... -->` / `<!-- REFERENCES: ... -->`）。
 *
 * 与 RMETA 相同的行级容错：注释由 JSON.stringify 生成，总是单行（换行已转义为 \n 字符串），
 * 但 payload（如附件 path、模型名）可能含 ` -->`（如内嵌的 `<!-- TITLE: ... -->` 注释），
 * 非贪婪 `.+? -->` 会在第一个 ` -->` 处提前截断导致 JSON.parse 失败——因此取该行内最后一个
 * ` -->` 作为注释真实结束符。
 *
 * 返回 { payload, rest }：payload 为注释内 JSON 原文（不含标记前缀/结束符），rest 为注释行之后的
 * 剩余文本（已 trim）。开头不是该 tag 注释时返回 null。
 */
function stripQuestionCommentLine(text: string, tag: string): { payload: string; rest: string } | null {
  const lineEnd = text.indexOf('\n');
  const line = lineEnd === -1 ? text : text.slice(0, lineEnd);
  const prefix = `<!-- ${tag}: `;
  const open = line.indexOf(prefix);
  const close = line.lastIndexOf(' -->');
  if (open !== 0 || close <= prefix.length) return null;
  const payload = line.slice(prefix.length, close);
  const rest = (lineEnd === -1 ? '' : text.slice(lineEnd + 1)).trim();
  return { payload, rest };
}

/** 解析对话记录分节，提取问答对 */
function parseConversations(content: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const lines = content.split('\n');
  let currentTurn: Partial<ConversationTurn> = {};
  let currentField: 'question' | 'answer' | null = null;
  let buffer: string[] = [];
  // v3 锚点：`<!-- #q-001 -->` 行关联到下一轮问答
  let pendingAnchor: string | null = null;

  const flush = () => {
    if (currentField && buffer.length > 0) {
      let text = buffer.join('\n').trim();

      // 解析消息级元数据与附件标记（只在问题部分）。
      // 循环剥离开头的 META / ATTACHMENTS 注释（与注释顺序无关）：
      // 序列化时 META 在前、ATTACHMENTS 在后，而旧解析按相反顺序各剥一次——顺序不匹配时
      // 后写的那条注释会残留进 question 正文，前端以纯文本渲染导致 JSON/文件路径原样露出。
      // 改为循环剥离后，任意顺序、任意多条都能完整剥净；JSON 损坏时同样剥掉注释，
      // 避免元信息泄漏进正文（宁丢 modelId/附件记录，不让用户看到 JSON）。
      if (currentField === 'question') {
        let commentRemoved = true;
        while (commentRemoved) {
          commentRemoved = false;

          // 附件标记（文件附件）
          const att = stripQuestionCommentLine(text, 'ATTACHMENTS');
          if (att) {
            try {
              currentTurn.questionAttachments = JSON.parse(att.payload);
            } catch {
              // JSON 损坏：丢弃附件记录，仅剥注释
            }
            text = att.rest;
            commentRemoved = true;
            continue;
          }

          // @引用 快照（资料 / 本地文件 / 链接 / 操作目录）
          const refs = stripQuestionCommentLine(text, 'REFERENCES');
          if (refs) {
            try {
              currentTurn.questionReferences = JSON.parse(refs.payload);
            } catch {
              // JSON 损坏：丢弃引用记录，仅剥注释
            }
            text = refs.rest;
            commentRemoved = true;
            continue;
          }

          // 消息级元数据（实际模型 + 思考等级）
          const meta = stripQuestionCommentLine(text, 'META');
          if (meta) {
            try {
              const parsed = JSON.parse(meta.payload);
              if (typeof parsed.modelId === 'string') currentTurn.modelId = parsed.modelId;
              if (typeof parsed.thinkingLevel === 'string') currentTurn.thinkingLevel = parsed.thinkingLevel;
            } catch {
              // JSON 损坏：丢弃元信息，仅剥注释
            }
            text = meta.rest;
            commentRemoved = true;
          }
        }
      }

      // 解析回答元数据（思考内容 + 工具调用，位于回答块开头）
      if (currentField === 'answer') {
        // RMETA 由 JSON.stringify 生成，注释总是单行（换行已被转义为 \n 字符串）。
        // 但内容（reasoning/toolCalls 结果）可能含 ' -->'（如内嵌的 <!-- TITLE: ... --> 注释），
        // 旧的非贪婪 (.+?) --> 会在内容中的第一个 ' -->' 处提前截断，导致 JSON.parse 失败
        // 而被静默吞掉 → think 标签与分步标签（reasoning/toolCalls）全部丢失。
        // 修复：在 RMETA 所在逻辑行内取最后一个 ' -->' 作为注释真实结束符。
        const rmLineEnd = text.indexOf('\n');
        const rmLine = rmLineEnd === -1 ? text : text.slice(0, rmLineEnd);
        const rmClose = rmLine.lastIndexOf(' -->');
        const rmOpen = rmLine.indexOf('<!-- RMETA: ');
        if (rmOpen === 0 && rmClose > '<!-- RMETA: '.length) {
          try {
            const rmeta = JSON.parse(rmLine.slice('<!-- RMETA: '.length, rmClose));
            if (typeof rmeta.reasoning === 'string') currentTurn.reasoning = rmeta.reasoning;
            if (typeof rmeta.processNarration === 'string') currentTurn.processNarration = rmeta.processNarration;
            if (typeof rmeta.taskId === 'string') currentTurn.taskId = rmeta.taskId;
            if (Array.isArray(rmeta.toolCalls)) currentTurn.toolCalls = rmeta.toolCalls;
            if (Array.isArray(rmeta.outputFiles)) currentTurn.outputFiles = rmeta.outputFiles;
            // 多智能体协作分支面板（旧文件无此字段 → 保持 undefined，向前兼容）
            if (rmeta.subagents && Array.isArray(rmeta.subagents.members)) currentTurn.subagents = rmeta.subagents;
          } catch {
            // 解析失败就忽略
          }
          text = (rmLineEnd === -1 ? '' : text.slice(rmLineEnd + 1)).trim();
        }
      }

      currentTurn[currentField] = text;
      buffer = [];
    }
  };

  const finishTurn = () => {
    flush();
    if (currentTurn.question !== undefined && currentTurn.answer !== undefined) {
      turns.push(currentTurn as ConversationTurn);
    }
    currentTurn = {};
    currentField = null;
  };

  for (const line of lines) {
    // v3 锚点注释行（<!-- #q-001 -->）：不进入正文 buffer，关联到下一轮
    const anchorMatch = line.match(/^<!--\s*#([a-z]+-\d+)\s*-->$/);
    if (anchorMatch) {
      pendingAnchor = anchorMatch[1];
      continue;
    }
    const qMatch = line.match(/^### Q \((.+)\)$/);
    const aMatch = line.match(/^### A \((.+)\)$/);

    if (qMatch) {
      finishTurn();
      currentTurn.questionTime = qMatch[1];
      if (pendingAnchor) {
        currentTurn.anchor = pendingAnchor;
        pendingAnchor = null;
      }
      currentField = 'question';
    } else if (aMatch) {
      flush();
      currentTurn.answerTime = aMatch[1];
      currentField = 'answer';
    } else {
      buffer.push(line);
    }
  }
  finishTurn();

  return turns;
}

// ==================== 校验 ====================

export interface FrontmatterValidationResult {
  valid: boolean;
  error?: string;
}

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** 判断是否包含 frontmatter */
export function hasFrontmatter(content: string): boolean {
  return FRONTMATTER_REGEX.test(content);
}

/** 校验 NodeFrontmatter 的必填字段和类型 */
export function validateNodeFrontmatter(fm: NodeFrontmatter): FrontmatterValidationResult {
  if (!fm.node_id || typeof fm.node_id !== 'string') {
    return { valid: false, error: 'frontmatter 缺少必填字段 node_id（必须为字符串）' };
  }
  if (!fm.title || typeof fm.title !== 'string') {
    return { valid: false, error: 'frontmatter 缺少必填字段 title（必须为字符串）' };
  }
  if (!fm.created_at || typeof fm.created_at !== 'string') {
    return { valid: false, error: 'frontmatter 缺少必填字段 created_at（必须为字符串）' };
  }
  if (!fm.updated_at || typeof fm.updated_at !== 'string') {
    return { valid: false, error: 'frontmatter 缺少必填字段 updated_at（必须为字符串）' };
  }
  if (!Array.isArray(fm.sources)) {
    return { valid: false, error: 'frontmatter 字段 sources 必须为数组' };
  }
  if (fm.tags && !Array.isArray(fm.tags)) {
    return { valid: false, error: 'frontmatter 字段 tags 必须为数组' };
  }
  return { valid: true };
}

/** 校验完整 .md 内容（frontmatter + 结构） */
export function validateNodeContent(content: string): FrontmatterValidationResult {
  if (!content || !content.trim()) {
    return { valid: false, error: '文件内容为空' };
  }
  if (!hasFrontmatter(content)) {
    return { valid: false, error: '缺少 frontmatter 区域（文件开头需要以 --- 包裹的 YAML 头）' };
  }
  try {
    const parsed = matter(content);
    const fm = parsed.data as unknown as NodeFrontmatter;
    return validateNodeFrontmatter(fm);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { valid: false, error: `frontmatter 解析失败：${message}` };
  }
}

// ==================== 序列化 ====================

/** 将 NodeMarkdown 序列化为 .md 字符串 */
export function serializeNode(node: NodeMarkdown): string {
  const fm = {
    node_id: node.frontmatter.node_id,
    title: node.frontmatter.title,
    created_at: node.frontmatter.created_at,
    updated_at: node.frontmatter.updated_at,
    sources: node.frontmatter.sources,
    ...(node.frontmatter.model ? { model: node.frontmatter.model } : {}),
    ...(node.frontmatter.tags && node.frontmatter.tags.length > 0 ? { tags: node.frontmatter.tags } : {}),
    ...(node.frontmatter.initial_prompt ? { initial_prompt: node.frontmatter.initial_prompt } : {}),
    ...(node.frontmatter.thinking_level ? { thinking_level: node.frontmatter.thinking_level } : {}),
    ...(node.frontmatter.attachment_hint ? { attachment_hint: node.frontmatter.attachment_hint } : {}),
    ...(node.frontmatter.skills && node.frontmatter.skills.length > 0 ? { skills: node.frontmatter.skills } : {}),
    // ===== v3（节点记忆与继承规格 v3 §二）=====
    ...(node.frontmatter.parent_nodes && node.frontmatter.parent_nodes.length > 0 ? { parent_nodes: node.frontmatter.parent_nodes } : {}),
    ...(node.frontmatter.outcome_status ? { outcome_status: node.frontmatter.outcome_status } : {}),
    ...(node.frontmatter.outcome_locked_at ? { outcome_locked_at: node.frontmatter.outcome_locked_at } : {}),
    ...(node.frontmatter.outcome_version !== undefined ? { outcome_version: node.frontmatter.outcome_version } : {}),
    ...(node.frontmatter.outcome_turns !== undefined ? { outcome_turns: node.frontmatter.outcome_turns } : {}),
    ...(node.frontmatter.note_ingest_turns !== undefined ? { note_ingest_turns: node.frontmatter.note_ingest_turns } : {}),
    ...(node.frontmatter.outcome_force_locked ? { outcome_force_locked: node.frontmatter.outcome_force_locked } : {}),
    ...(node.frontmatter.outcome_stale_reason ? { outcome_stale_reason: node.frontmatter.outcome_stale_reason } : {}),
    ...(node.frontmatter.outcome_locked_by ? { outcome_locked_by: node.frontmatter.outcome_locked_by } : {}),
    ...(node.frontmatter.outcome_content_hash ? { outcome_content_hash: node.frontmatter.outcome_content_hash } : {}),
    // 追加式锁定历史（P0-a）：外部台账在节点侧的镜像，非空数组才写
    ...(node.frontmatter.outcome_lock_history && node.frontmatter.outcome_lock_history.length > 0
      ? { outcome_lock_history: node.frontmatter.outcome_lock_history }
      : {}),
    ...(node.frontmatter.position_x !== undefined ? { position_x: node.frontmatter.position_x } : {}),
    ...(node.frontmatter.position_y !== undefined ? { position_y: node.frontmatter.position_y } : {}),
    // AI Coding 节点绑定的小程序 ID（缺此字段重启后 coding 上下文会丢失）
    ...(node.frontmatter.sandbox_app_id ? { sandbox_app_id: node.frontmatter.sandbox_app_id } : {}),
    // AI Coding 创建简报（缺省不写；有则在首轮跳过 6 问 Spec）
    ...(node.frontmatter.sandbox_spec ? { sandbox_spec: node.frontmatter.sandbox_spec } : {}),
    // 节点类型标记（imageGen 等；缺省视为 aiChat）
    ...(node.frontmatter.node_type ? { node_type: node.frontmatter.node_type } : {}),
    // 批注框（仅 annotation 节点使用）：关联卡片 + 批注文字
    ...(node.frontmatter.annotation_node_ids && node.frontmatter.annotation_node_ids.length > 0 ? { annotation_node_ids: node.frontmatter.annotation_node_ids } : {}),
    ...(node.frontmatter.annotation_text ? { annotation_text: node.frontmatter.annotation_text } : {}),
    // 星标（任意节点可用）：true 才写，避免冗余
    ...(node.frontmatter.starred ? { starred: true } : {}),
    // md 文档来源锚点（JSON 字符串，有才写）
    ...(node.frontmatter.md_anchor ? { md_anchor: node.frontmatter.md_anchor } : {}),
    ...(node.frontmatter.outcome_user_edited ? { outcome_user_edited: node.frontmatter.outcome_user_edited } : {}),
    ...(node.frontmatter.outcome_template ? { outcome_template: node.frontmatter.outcome_template } : {}),
    ...(node.frontmatter.memory_compacted_at ? { memory_compacted_at: node.frontmatter.memory_compacted_at } : {}),
    ...(node.frontmatter.memory_compacted_until !== undefined ? { memory_compacted_until: node.frontmatter.memory_compacted_until } : {}),
    ...(node.frontmatter.memory_turn_count !== undefined ? { memory_turn_count: node.frontmatter.memory_turn_count } : {}),
    // T2 一次性回声标记：仅在 true 时写出（append 回声后即清除，不残留）
    ...(node.frontmatter.memory_compacted_pending_echo === true ? { memory_compacted_pending_echo: true } : {}),
    ...(node.frontmatter.manifest_hash ? { manifest_hash: node.frontmatter.manifest_hash } : {}),
    // 节点级 MCP / 技能选择：undefined 不写（跟随全局），空数组显式全关也保留
    ...(node.frontmatter.enabledMcpIds !== undefined ? { enabledMcpIds: node.frontmatter.enabledMcpIds } : {}),
    ...(node.frontmatter.selectedSkills !== undefined ? { selectedSkills: node.frontmatter.selectedSkills } : {}),
    // 多智能体协作模式：仅在开启时写出（缺省=关闭，避免冗余字段）
    ...(node.frontmatter.multi_agent_mode === true ? { multi_agent_mode: true } : {}),
    // team 模式两档模型：undefined 不写（未在 Team 分栏显式选择时回落默认）
    ...(node.frontmatter.team_main_model ? { team_main_model: node.frontmatter.team_main_model } : {}),
    ...(node.frontmatter.team_worker_model ? { team_worker_model: node.frontmatter.team_worker_model } : {}),
    // 关联团队 id 清单：undefined 不写，空数组也写出（表示用户显式解绑了全部团队）
    ...(node.frontmatter.team_ids !== undefined ? { team_ids: node.frontmatter.team_ids } : {}),
  };

  // 对话记录（v3：每轮前置锚点注释）
  let conversationText = '';
  for (const turn of node.conversations) {
    let questionBlock = turn.question;
    if (turn.questionAttachments && turn.questionAttachments.length > 0) {
      const attJson = JSON.stringify(turn.questionAttachments);
      questionBlock = `<!-- ATTACHMENTS: ${attJson} -->\n${turn.question}`;
    }
    // @引用 快照（资料 / 本地文件 / 链接 / 操作目录）
    if (turn.questionReferences && turn.questionReferences.length > 0) {
      const refJson = JSON.stringify(turn.questionReferences);
      questionBlock = `<!-- REFERENCES: ${refJson} -->\n${questionBlock}`;
    }
    // 消息级元数据（实际模型 + 思考等级）：注释行写入，便于追溯每条回复的推理参数
    if (turn.modelId || turn.thinkingLevel) {
      const metaJson = JSON.stringify({ modelId: turn.modelId ?? null, thinkingLevel: turn.thinkingLevel ?? null });
      questionBlock = `<!-- META: ${metaJson} -->\n${questionBlock}`;
    }
    // 回答级元数据（思考内容 + 工具调用 + 输出文件）：注释行写入，think/executing steps/output files 持久化
    let answerBlock = turn.answer;
    if (turn.reasoning || turn.processNarration || turn.taskId || (turn.toolCalls && turn.toolCalls.length > 0) || (turn.outputFiles && turn.outputFiles.length > 0) || (turn.subagents && turn.subagents.members.length > 0)) {
      const rmetaJson = JSON.stringify({
        reasoning: turn.reasoning ?? null,
        processNarration: turn.processNarration ?? null,
        taskId: turn.taskId ?? null,
        toolCalls: turn.toolCalls ?? null,
        outputFiles: turn.outputFiles ?? null,
        subagents: turn.subagents ?? null,
      });
      answerBlock = `<!-- RMETA: ${rmetaJson} -->\n${answerBlock}`;
    }
    const anchorLine = turn.anchor ? `<!-- #${turn.anchor} -->\n` : '';
    conversationText += `\n${anchorLine}### Q (${turn.questionTime})\n${questionBlock}\n\n### A (${turn.answerTime})\n${answerBlock}\n`;
  }

  const bodyParts: string[] = [];

  // v3：成果块（旧节点无 outcome 时省略，保持向前兼容）
  if (node.outcome) {
    bodyParts.push(`${SECTIONS.OUTCOME}\n\n${renderOutcome(node.outcome)}`);
  }
  // v3：压缩记忆（无内容时省略）
  if (node.compressedMemory) {
    bodyParts.push(`${SECTIONS.COMPRESSED}\n\n${node.compressedMemory}`);
  }
  // v1 遗留：摘要（旧节点仍在使用，保留输出避免数据丢失）
  bodyParts.push(`${SECTIONS.SUMMARY}\n${node.summary || ''}`);
  // 对话记录
  bodyParts.push(`${SECTIONS.CONVERSATION}\n${conversationText.trim() || '（暂无）'}`);
  // v3：引用区（附件解析缓存）
  if (node.references) {
    bodyParts.push(`${SECTIONS.REFERENCES}\n\n${node.references}`);
  }
  // v3：批注（此前缺失序列化，v3 补上）
  if (node.annotations) {
    bodyParts.push(`${SECTIONS.ANNOTATION}\n\n${node.annotations}`);
  }

  return matter.stringify(bodyParts.join('\n\n'), fm);
}

/**
 * 成果块内容哈希（锁定签字留痕）：SHA-256(renderOutcome(outcome)) 前 32 位 hex。
 * 与 R-9 闸门同口径（都是比对 renderOutcome），因此「签字后手改 .md 正文的成果块」
 * 必然导致哈希不一致 —— 注入/继承前据此判断盘上内容是否仍是签字那一刻的那一份。
 */
export function outcomeContentHash(outcome: Outcome | null | undefined): string {
  const text = outcome ? renderOutcome(outcome) : '';
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 32);
}

// ==================== 解析 ====================

/** 从 .md 字符串解析出 NodeMarkdown 对象 */
export function parseNodeMarkdown(mdString: string): NodeMarkdown {
  const parsed = matter(mdString);
  const fm = parsed.data as unknown as NodeFrontmatter;

  // 校验必填字段
  if (!fm.node_id) throw new Error('frontmatter 缺少 node_id');
  if (!fm.title) throw new Error('frontmatter 缺少 title');
  if (!fm.created_at) throw new Error('frontmatter 缺少 created_at');
  if (!fm.updated_at) throw new Error('frontmatter 缺少 updated_at');
  if (!Array.isArray(fm.sources)) fm.sources = [];

  const sections = splitSections(parsed.content);

  // v3：旧节点（无成果块且未显式声明状态）标 outcome_status: legacy —— 允许查看，不允许作为已锁定上游被继承
  const outcome = parseOutcome(sections.get('成果块') || '');
  if (!outcome && fm.outcome_status === undefined) {
    fm.outcome_status = 'legacy';
  }

  return {
    frontmatter: {
      ...fm,
      sources: fm.sources || [],
    },
    summary: (sections.get('摘要') || '').replace(/^（暂无）$/, '').trim(),
    conversations: parseConversations(sections.get('对话记录') || ''),
    annotations: (sections.get('批注') || '').replace(/^（暂无）$/, '').trim(),
    outcome: outcome || undefined,
    compressedMemory: normalizeSection(sections.get('压缩记忆')),
    references: normalizeSection(sections.get('引用区')),
  };
}

// ==================== 删除操作 ====================

/** 删除指定索引的一轮问答，返回更新后的完整 .md 字符串 */
export function removeConversation(mdString: string, roundIndex: number): string {
  const node = parseNodeMarkdown(mdString);
  if (roundIndex < 0 || roundIndex >= node.conversations.length) {
    throw new Error(`roundIndex ${roundIndex} 超出范围 (0-${node.conversations.length - 1})`);
  }
  node.conversations.splice(roundIndex, 1);
  node.frontmatter.updated_at = new Date().toISOString();
  return serializeNode(node);
}


// ==================== 追加操作 ====================

/** 追加一轮问答到 .md 字符串，返回更新后的完整 .md 字符串（保留历史） */
export function appendConversation(
  mdString: string,
  question: string,
  answer: string,
  options?: { questionTime?: string; answerTime?: string; summary?: string; title?: string; questionAttachments?: ConversationAttachment[]; questionReferences?: ConversationReference[]; modelId?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'max'; reasoning?: string; processNarration?: string; taskId?: string; toolCalls?: ConversationTurn['toolCalls']; outputFiles?: ConversationTurn['outputFiles']; subagents?: ConversationTurn['subagents'] },
): string {
  const node = parseNodeMarkdown(mdString);
  const now = new Date().toISOString();

  // v3：生成全文件唯一锚点（只增不改，编号不复用），定位靠 grep 锚点注释
  const existingIds = collectAnchorIds(mdString);
  const anchor = generateAnchorId('q', existingIds);

  node.conversations.push({
    question,
    answer,
    questionTime: options?.questionTime || now,
    answerTime: options?.answerTime || now,
    questionAttachments: options?.questionAttachments,
    questionReferences: options?.questionReferences,
    ...(options?.modelId ? { modelId: options.modelId } : {}),
    ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options?.processNarration ? { processNarration: options.processNarration } : {}),
    ...(options?.taskId ? { taskId: options.taskId } : {}),
    ...(options?.toolCalls && options.toolCalls.length > 0 ? { toolCalls: options.toolCalls } : {}),
    ...(options?.outputFiles && options.outputFiles.length > 0 ? { outputFiles: options.outputFiles } : {}),
    ...(options?.subagents && options.subagents.members.length > 0 ? { subagents: options.subagents } : {}),
    anchor,
  });

  node.frontmatter.updated_at = now;
  node.frontmatter.memory_turn_count = (node.frontmatter.memory_turn_count ?? 0) + 1;
  if (options?.summary) node.summary = options.summary;
  if (options?.title) node.frontmatter.title = options.title;

  return serializeNode(node);
}

/** 创建新节点的 .md 字符串 */
export function createNodeMarkdown(
  nodeId: string,
  title: string,
  options?: {
    model?: string;
    sources?: string[];
    tags?: string[];
    initial_prompt?: string;
    thinking_level?: 'off' | 'low' | 'medium' | 'high';
    attachment_hint?: string;
    skills?: string[];
    position_x?: number;
    position_y?: number;
    /** AI Coding 节点：绑定的小程序（Bob Sandbox app）ID */
    sandbox_app_id?: string;
    /** 管家派发会话的产物暂存批次 id（Outbox）：产物落暂存区而非当前项目 */
    outbox_batch_id?: string;
    /** AI Coding 节点：创建时确认的构建简报（避免首轮重复 6 问） */
    sandbox_spec?: SandboxSpec;
    /** 节点类型：aiChat（缺省）/ imageGen / orchestrator */
    node_type?: string;
    /** 批注框（annotation）节点：关联的卡片节点 id 列表 */
    annotation_node_ids?: string[];
    /** 批注框（annotation）节点：初始批注文字 */
    annotation_text?: string;
    /** md 文档来源锚点（JSON 字符串） */
    md_anchor?: string;
  },
): string {
  const now = new Date().toISOString();
  const node: NodeMarkdown = {
    frontmatter: {
      node_id: nodeId,
      title,
      created_at: now,
      updated_at: now,
      sources: options?.sources || [],
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.tags ? { tags: options.tags } : {}),
      ...(options?.initial_prompt ? { initial_prompt: options.initial_prompt } : {}),
      ...(options?.thinking_level ? { thinking_level: options.thinking_level } : {}),
      ...(options?.attachment_hint ? { attachment_hint: options.attachment_hint } : {}),
      ...(options?.skills ? { skills: options.skills } : {}),
      ...(options?.position_x !== undefined ? { position_x: options.position_x } : {}),
      ...(options?.position_y !== undefined ? { position_y: options.position_y } : {}),
      ...(options?.sandbox_app_id ? { sandbox_app_id: options.sandbox_app_id } : {}),
      ...(options?.outbox_batch_id ? { outbox_batch_id: options.outbox_batch_id } : {}),
      ...(options?.sandbox_spec ? { sandbox_spec: options.sandbox_spec } : {}),
      ...(options?.node_type ? { node_type: options.node_type } : {}),
      ...(options?.annotation_node_ids && options.annotation_node_ids.length > 0 ? { annotation_node_ids: options.annotation_node_ids } : {}),
      ...(options?.annotation_text ? { annotation_text: options.annotation_text } : {}),
      ...(options?.md_anchor ? { md_anchor: options.md_anchor } : {}),
      // ===== v3：新节点默认 draft，成果块版本 1，模板 legal-analysis =====
      outcome_status: 'draft',
      outcome_version: 1,
      outcome_turns: 0,
      outcome_template: 'legal-analysis',
      memory_turn_count: 0,
    },
    summary: '',
    conversations: [],
    annotations: '',
    outcome: createEmptyOutcome(),
  };
  return serializeNode(node);
}

// ==================== 文件系统操作 ====================

import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { tmpdir } from 'os';

/** 原子写入：先写临时文件再 rename 替换目标文件 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = join(filePath, '..');
  const tmpPath = join(tmpdir(), `.node-${randomUUID()}.tmp`);

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // 清理临时文件
    try { await fs.unlink(tmpPath); } catch {}
    if (err.code === 'ENOSPC') throw new Error('磁盘空间不足');
    if (err.code === 'EACCES') throw new Error('文件权限不足');
    throw new Error(`写入文件失败: ${err.message}`);
  }
}

/**
 * 写入节点 .md 文件到磁盘（原子写入，自动处理重名冲突）
 * @param projectPath 可选：显式指定项目目录（写入该项目的 notes-memory/）。
 *                    不传时回退到 getWorkspaceRoot()（依赖 CURRENT_PROJECT_PATH 全局变量，
 *                    该变量仅在 /api/nodes 请求中设置；/api/chat 等请求需显式传参，否则会写到 home 目录）
 */
export async function writeNodeFile(title: string, mdContent: string, projectPath?: string): Promise<string> {
  const workspaceRoot = projectPath ?? getWorkspaceRoot();
  const relativePath = buildFilePath(title);
  let fullPath = join(workspaceRoot, relativePath);
  // 处理重名冲突：已存在同名文件时追加 _1, _2...
  fullPath = await findUniqueFilePath(fullPath);
  await atomicWriteFile(fullPath, mdContent);
  // 返回相对于 workspaceRoot 的路径
  return fullPath.replace(workspaceRoot + '/', '');
}

/** 更新已存在的节点文件（原子写入 + frontmatter 校验） */
export async function updateNodeFile(filePath: string, content: string, options?: { validate?: boolean }): Promise<void> {
  if (options?.validate !== false) {
    const validation = validateNodeContent(content);
    if (!validation.valid) {
      throw new Error(validation.error || '内容校验失败');
    }
  }
  await atomicWriteFile(filePath, content);
}

/** 读取文件的版本令牌（mtimeMs，毫秒级）；不存在或读取失败返回 null。
 *  作为乐观并发（optimistic concurrency）的比对基准：客户端加载时记录、保存时回传，
 *  服务端写前 stat 比对，检测「加载后被外部（AI 写盘等）改写」导致的静默覆盖风险。
 *  写盘统一走原子 rename（atomicWriteFile），mtime 必然刷新，令牌天然单调。 */
export async function readVersionToken(filePath: string): Promise<number | null> {
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

/** 将 markdown 的 frontmatter updated_at 刷新为当前时间（用户保存节点文档时回写，保持时间戳语义正确）。
 *  用 gray-matter 就地改字段再序列化，正文逐字保留；解析失败时原样返回（不阻塞写盘）。 */
export function bumpUpdatedAt(mdContent: string): string {
  try {
    const parsed = matter(mdContent);
    parsed.data.updated_at = new Date().toISOString();
    return matter.stringify(parsed.content, parsed.data);
  } catch {
    return mdContent;
  }
}

/** 通过 node_id 查找节点文件（扫描 frontmatter 匹配 node_id） */
export async function findNodeFileById(nodeId: string, projectPath?: string): Promise<string | null> {
  // 显式传入 projectPath 避免全局变量竞态；兼容旧调用
  const root = projectPath ?? getWorkspaceRoot();
  const nodesDir = join(root, 'notes-memory');
  console.log('[findNodeFileById] nodeId:', nodeId, 'root:', root, 'nodesDir:', nodesDir);

  try {
    const files = await fs.readdir(nodesDir);
    console.log('[findNodeFileById] files in nodesDir:', files.filter(f => f.endsWith('.md')));

    // 扫描所有 .md 文件，匹配 frontmatter 中的 node_id
    for (const file of files) {
      if (!file.endsWith('.md') || file === 'example_node.md') continue;
      try {
        const content = await fs.readFile(join(nodesDir, file), 'utf-8');
        const parsed = matter(content);
        console.log('[findNodeFileById] checking file:', file, 'frontmatter node_id:', parsed.data.node_id, 'match:', parsed.data.node_id === nodeId);
        if (parsed.data.node_id === nodeId) {
          return join(nodesDir, file);
        }
      } catch {
        continue;
      }
    }
    console.log('[findNodeFileById] NOT FOUND');
    return null;
  } catch (e) {
    console.log('[findNodeFileById] ERROR:', e);
    return null;
  }
}

/** 生成新的节点 UUID */
export function generateNodeId(): string {
  return randomUUID();
}

import { basename, dirname, extname } from 'path';

/** 在目录中查找不冲突的唯一文件名（重名时追加 _1, _2...） */
async function findUniqueFilePath(basePath: string): Promise<string> {
  try {
    await fs.access(basePath);
  } catch {
    return basePath;
  }

  const dir = dirname(basePath);
  const ext = extname(basePath);
  const nameWithoutExt = basename(basePath, ext);

  let counter = 1;
  let candidate: string;
  do {
    candidate = join(dir, `${nameWithoutExt}_${counter}${ext}`);
    counter++;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  } while (counter < 100);

  return candidate;
}

/** 重命名节点文件（标题变化时同步重命名 .md 文件） */
export async function renameNodeFile(oldFilePath: string, newTitle: string): Promise<string> {
  const oldName = basename(oldFilePath);

  const newNameBase = titleToFileName(newTitle);
  const stampMatch = oldName.match(/-(\d{8})\.md$/);
  const stamp = stampMatch ? stampMatch[1] : dateStamp();
  const newFileName = `${newNameBase}-${stamp}.md`;

  const dir = dirname(oldFilePath);
  const newPath = join(dir, newFileName);

  if (newPath === oldFilePath) return oldFilePath;

  const uniquePath = await findUniqueFilePath(newPath);

  try {
    await fs.rename(oldFilePath, uniquePath);
    return uniquePath;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EACCES') throw new Error('文件权限不足，无法重命名');
    if (err.code === 'ENOENT') throw new Error('源文件不存在');
    throw new Error(`重命名文件失败: ${err.message}`);
  }
}
