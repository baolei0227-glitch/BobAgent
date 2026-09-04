/**
 * 用户偏好记忆（全局长期记忆）共享逻辑：供 remember_preference / read_preferences /
 * delete_preference 工具与 /api/chat 每轮注入共用。
 *
 * 定位：用户偏好记忆的长期存储
 *
 * 写入规则（仅用户显式触发）：只有用户明确说「记住 / 以后都这样」时 AI 才调用
 * remember_preference；禁止擅自记录普通对话内容。存储于 ~/BobWork/wanted/preferences.md
 * （全局，跨项目，所有节点每轮对话注入参考）。
 *
 * 结构化存储（完整结构化，每条偏好带元数据字段）：
 *   - content    偏好内容（一句话，去重键）
 *   - type       类型分类（默认「通用」，如 输出格式/引用规范/任务流程）
 *   - created_at 记录时间（自动写入）
 *   - source     记录来源（默认 chat，标识触发来源）
 * 文件格式（人类可读的 Markdown + 缩进元数据）：
 *   - 用户习惯用表格输出
 *     type: 输出格式
 *     created_at: 2026-08-07 14:30
 *     source: chat
 */
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';

const APP_ROOT = resolveAppRoot();

export interface UserPreference {
  /** 序号（1-based，列表中位置；删除时用） */
  index: number;
  /** 偏好内容（一句话） */
  content: string;
  /** 类型分类（默认「通用」；输出格式/引用规范/任务流程 等） */
  type: string;
  /** 记录时间（YYYY-MM-DD HH:mm，无元数据的历史条目为空串） */
  createdAt: string;
  /** 记录来源（默认 chat；标识哪次对话触发写入） */
  source: string;
}

/** addPreference 可选元数据 */
export interface AddPreferenceOptions {
  type?: string;
  source?: string;
}

/** 确保 wanted/preferences.md 存在，返回其绝对路径 */
export async function ensurePreferencesFile(): Promise<string> {
  const wantedDir = join(APP_ROOT, 'wanted');
  const prefPath = join(wantedDir, 'preferences.md');
  try {
    await access(wantedDir);
  } catch {
    await mkdir(wantedDir, { recursive: true });
  }
  try {
    await access(prefPath);
  } catch {
    await writeFile(prefPath, `# User Preferences

> 用户显式要求记住的偏好/习惯（全局长期记忆，所有节点每轮对话参考）。
> 仅当用户明确说「记住 / 以后都这样」时才由 AI 调用 remember_preference 写入；禁止擅自记录。
> 查看用 read_preferences，删除用 delete_preference（按序号）。

`, 'utf-8');
  }
  return prefPath;
}

/** 解析出的原始条目（内容 + 缩进元数据键值对） */
interface RawEntry {
  content: string;
  meta: Record<string, string>;
  /** 条目主行行号（0-based） */
  startLine: number;
  /** 条目末行行号（含缩进元数据，0-based） */
  endLine: number;
}

/**
 * 逐行扫描文件，切分出条目块：
 *  - 主行：以 "- " 开头（跳过 "- [" 注释行）
 *  - 元数据行：紧跟在主行后的缩进 "key: value" 行，并入当前条目
 */
function parseEntries(lines: string[]): RawEntry[] {
  const entries: RawEntry[] = [];
  let current: RawEntry | null = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('- ') && !t.startsWith('- [')) {
      if (current) current.endLine = i - 1;
      current = { content: t.slice(2).trim(), meta: {}, startLine: i, endLine: i };
      if (current.content) entries.push(current);
    } else if (current && /^\s+\S/.test(lines[i]) && lines[i].includes(':')) {
      const idx = lines[i].indexOf(':');
      const key = lines[i].slice(0, idx).trim();
      const value = lines[i].slice(idx + 1).trim();
      if (key && value) current.meta[key] = value;
      current.endLine = i;
    }
  }
  return entries;
}

/** 列出全部用户偏好（带序号与元数据；文件不存在/解析失败返回空数组） */
export async function listPreferences(): Promise<UserPreference[]> {
  try {
    const path = await ensurePreferencesFile();
    const raw = await readFile(path, 'utf-8');
    return parseEntries(raw.split('\n')).map((e, i) => ({
      index: i + 1,
      content: e.content,
      type: e.meta.type || '通用',
      createdAt: e.meta.created_at || '',
      source: e.meta.source || 'chat',
    }));
  } catch {
    return [];
  }
}

/** 追加一条偏好（按 content 去重；自动写入 created_at，默认 source=chat） */
export async function addPreference(
  content: string,
  opts?: AddPreferenceOptions,
): Promise<{ added: boolean; total: number; duplicate?: string }> {
  const text = content.trim().replace(/\s+/g, ' ');
  if (!text) return { added: false, total: 0 };
  const path = await ensurePreferencesFile();
  const raw = await readFile(path, 'utf-8');
  const existing = parseEntries(raw.split('\n'));
  const dup = existing.find((e) => e.content === text);
  if (dup) return { added: false, total: existing.length, duplicate: dup.content };
  const type = (opts?.type || '通用').trim() || '通用';
  const source = (opts?.source || 'chat').trim() || 'chat';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const block = `- ${text}\n  type: ${type}\n  created_at: ${createdAt}\n  source: ${source}\n`;
  await writeFile(path, `${raw.trimEnd()}\n${block}`, 'utf-8');
  return { added: true, total: existing.length + 1 };
}

/** 按序号删除一条偏好（1-based，整块删除含元数据；返回是否删除成功与剩余条数） */
export async function removePreference(index: number): Promise<{ removed: boolean; remaining: number }> {
  const path = await ensurePreferencesFile();
  const raw = await readFile(path, 'utf-8');
  const lines = raw.split('\n');
  const entries = parseEntries(lines);
  if (index < 1 || index > entries.length) return { removed: false, remaining: entries.length };
  const target = entries[index - 1];
  const kept = lines.filter((_, i) => i < target.startLine || i > target.endLine);
  await writeFile(path, kept.join('\n'), 'utf-8');
  return { removed: true, remaining: entries.length - 1 };
}

/**
 * 原子更新一条偏好（1-based，按序号定位）。
 * 只更新传入的字段（content / type），未传字段保留原值；created_at / source 保持不变。
 * 返回是否更新成功、剩余条数，以及更新后的完整条目（供工具回显）。
 */
export async function updatePreference(
  index: number,
  patch: { content?: string; type?: string },
): Promise<{ updated: boolean; remaining?: number; preference?: UserPreference; error?: string }> {
  const path = await ensurePreferencesFile();
  const raw = await readFile(path, 'utf-8');
  const lines = raw.split('\n');
  const entries = parseEntries(lines);
  if (index < 1 || index > entries.length) {
    return { updated: false, error: `Entry ${index} not found (currently ${entries.length} entries)` };
  }
  const target = entries[index - 1];
  const content =
    patch.content !== undefined ? patch.content.trim().replace(/\s+/g, ' ') : target.content;
  if (!content) return { updated: false, error: 'Preference content cannot be empty' };
  const type = patch.type !== undefined && patch.type.trim() ? patch.type.trim() : target.meta.type || '通用';
  // 显式标注 Record 类型：对象 spread 不保留索引签名（TS 行为），否则 meta.created_at 等访问报错
  const meta: Record<string, string> = { ...target.meta, type };
  const newBlock = [`- ${content}`];
  for (const [k, v] of Object.entries(meta)) {
    newBlock.push(`  ${k}: ${v}`);
  }
  const kept = [...lines.slice(0, target.startLine), ...newBlock, ...lines.slice(target.endLine + 1)];
  await writeFile(path, kept.join('\n'), 'utf-8');
  return {
    updated: true,
    remaining: entries.length,
    preference: {
      index,
      content,
      type,
      createdAt: meta.created_at || '',
      source: meta.source || 'chat',
    },
  };
}
