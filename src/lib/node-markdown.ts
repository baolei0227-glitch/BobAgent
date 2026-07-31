import matter from 'gray-matter';

// ==================== 数据模型 ====================

export interface NodeMood {
  vibe?: string[];
  sparks?: string[];
  reflections?: string[];
  will?: string[];
}

export interface NodeFrontmatter {
  node_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sources: string[];
  model?: string;
  mood?: NodeMood;
  tags?: string[];
  initial_prompt?: string;
  thinking_level?: 'off' | 'low' | 'medium' | 'high';
  attachment_hint?: string;
  skills?: string[];
}

export interface ConversationAttachment {
  id: string;
  name: string;
  type: 'image' | 'text' | 'file';
  mimeType: string;
  size: number;
  path: string;
}

export interface ConversationTurn {
  question: string;
  answer: string;
  questionTime: string;
  answerTime: string;
  questionAttachments?: ConversationAttachment[];
}

export interface NodeMarkdown {
  frontmatter: NodeFrontmatter;
  summary: string;
  conversations: ConversationTurn[];
  annotations: string;
  stickies: string[];
}

// ==================== 常量 ====================

const SECTIONS = {
  SUMMARY: '## 摘要',
  CONVERSATION: '## 对话记录',
  STICKY: '## 便签',
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
export function buildFilePath(_nodeId: string, title: string, date?: Date): string {
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
  return process.env.COZE_WORKSPACE_PATH || require('os').homedir();
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

const KNOWN_SECTIONS = new Set(['摘要', '对话记录', '便签']);

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

/** 解析对话记录分节，提取问答对 */
function parseConversations(content: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const lines = content.split('\n');
  let currentTurn: Partial<ConversationTurn> = {};
  let currentField: 'question' | 'answer' | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentField && buffer.length > 0) {
      let text = buffer.join('\n').trim();

      // 解析附件标记（只在问题部分）
      if (currentField === 'question') {
        const attMatch = text.match(/^<!-- ATTACHMENTS: (.+?) -->\n?/);
        if (attMatch) {
          try {
            currentTurn.questionAttachments = JSON.parse(attMatch[1]);
            text = text.replace(/^<!-- ATTACHMENTS: .+? -->\n?/, '').trim();
          } catch {
            // 解析失败就忽略
          }
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
    const qMatch = line.match(/^### Q \((.+)\)$/);
    const aMatch = line.match(/^### A \((.+)\)$/);

    if (qMatch) {
      finishTurn();
      currentTurn.questionTime = qMatch[1];
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
  if (fm.mood && typeof fm.mood !== 'object') {
    return { valid: false, error: 'frontmatter 字段 mood 必须为对象' };
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
    ...(node.frontmatter.mood ? { mood: node.frontmatter.mood } : {}),
    ...(node.frontmatter.tags && node.frontmatter.tags.length > 0 ? { tags: node.frontmatter.tags } : {}),
    ...(node.frontmatter.initial_prompt ? { initial_prompt: node.frontmatter.initial_prompt } : {}),
    ...(node.frontmatter.thinking_level ? { thinking_level: node.frontmatter.thinking_level } : {}),
    ...(node.frontmatter.attachment_hint ? { attachment_hint: node.frontmatter.attachment_hint } : {}),
    ...(node.frontmatter.skills && node.frontmatter.skills.length > 0 ? { skills: node.frontmatter.skills } : {}),
  };

  // 对话记录
  let conversationText = '';
  for (const turn of node.conversations) {
    let questionBlock = turn.question;
    if (turn.questionAttachments && turn.questionAttachments.length > 0) {
      const attJson = JSON.stringify(turn.questionAttachments);
      questionBlock = `<!-- ATTACHMENTS: ${attJson} -->\n${turn.question}`;
    }
    conversationText += `\n### Q (${turn.questionTime})\n${questionBlock}\n\n### A (${turn.answerTime})\n${turn.answer}\n`;
  }

  const body = [
    `${SECTIONS.SUMMARY}`,
    node.summary || '',
    '',
    `${SECTIONS.CONVERSATION}`,
    conversationText.trim() || '（暂无）',
    '',
    `${SECTIONS.STICKY}`,
    node.stickies.length > 0 ? node.stickies.map(s => `- ${s}`).join('\n') : '（暂无）',
    '',
  ].join('\n');

  return matter.stringify(body, fm);
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

  const stickiesText = sections.get('便签') || '';
  const stickies = stickiesText === '（暂无）'
    ? []
    : stickiesText.split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);

  return {
    frontmatter: {
      ...fm,
      sources: fm.sources || [],
    },
    summary: (sections.get('摘要') || '').replace(/^（暂无）$/, '').trim(),
    conversations: parseConversations(sections.get('对话记录') || ''),
    annotations: (sections.get('批注') || '').replace(/^（暂无）$/, '').trim(),
    stickies,
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
  options?: { questionTime?: string; answerTime?: string; mood?: NodeMood; summary?: string; title?: string; questionAttachments?: ConversationAttachment[] },
): string {
  const node = parseNodeMarkdown(mdString);
  const now = new Date().toISOString();

  node.conversations.push({
    question,
    answer,
    questionTime: options?.questionTime || now,
    answerTime: options?.answerTime || now,
    questionAttachments: options?.questionAttachments,
  });

  node.frontmatter.updated_at = now;
  if (options?.mood) node.frontmatter.mood = options.mood;
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
    mood?: NodeMood;
    tags?: string[];
    initial_prompt?: string;
    thinking_level?: 'off' | 'low' | 'medium' | 'high';
    attachment_hint?: string;
    skills?: string[];
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
      ...(options?.mood ? { mood: options.mood } : {}),
      ...(options?.tags ? { tags: options.tags } : {}),
      ...(options?.initial_prompt ? { initial_prompt: options.initial_prompt } : {}),
      ...(options?.thinking_level ? { thinking_level: options.thinking_level } : {}),
      ...(options?.attachment_hint ? { attachment_hint: options.attachment_hint } : {}),
      ...(options?.skills ? { skills: options.skills } : {}),
    },
    summary: '',
    conversations: [],
    annotations: '',
    stickies: [],
  };
  return serializeNode(node);
}

// ==================== 文件系统操作 ====================

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
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

/** 写入节点 .md 文件到磁盘（原子写入，自动处理重名冲突） */
export async function writeNodeFile(nodeId: string, title: string, mdContent: string): Promise<string> {
  const workspaceRoot = getWorkspaceRoot();
  const relativePath = buildFilePath(nodeId, title);
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

/** 读取节点 .md 文件并解析 */
export async function readNodeFile(nodeId: string, title: string): Promise<NodeMarkdown> {
  const workspaceRoot = getWorkspaceRoot();
  const relativePath = buildFilePath(nodeId, title);
  const fullPath = join(workspaceRoot, relativePath);

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    return parseNodeMarkdown(content);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') throw new Error(`节点文件不存在: ${relativePath}`);
    if (err.code === 'EACCES') throw new Error('文件权限不足');
    throw new Error(`读取文件失败: ${err.message}`);
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

/**
 * 安全写入：检测文件是否被外部修改（基于 mtime），冲突则抛出错误
 * 防止用户编辑时覆盖了外部程序的改动
 */
export async function safeWriteFile(
  filePath: string,
  content: string,
  expectMtimeMs?: number,
): Promise<void> {
  if (expectMtimeMs !== undefined) {
    try {
      const stat = await fs.stat(filePath);
      if (Math.abs(stat.mtimeMs - expectMtimeMs) > 10) {
        throw new Error('文件已被其他进程修改，请刷新后再保存');
      }
    } catch (e) {
      const err = e as Error;
      if (err.message.includes('文件已被其他进程修改')) throw e;
    }
  }
  await atomicWriteFile(filePath, content);
}
