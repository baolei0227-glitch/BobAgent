/**
 * 用户记忆（统一长期记忆，所有联系人共享）共享逻辑：供 remember_preference /
 * read_preferences / delete_preference 工具与 /api/chat 每轮注入共用。
 *
 * 定位：用户记忆的**唯一**长期存储。记忆的主语是用户，与联系人无关——多个联系人服务
 * 同一个用户，档案只有一份（「按联系人不同」这一维度由会话人设承担，不属于记忆）。
 *
 * 写入规则（自动抽取 + 用户可改可删，主流形态）：AI 在对话中识别到**持久事实 / 偏好**
 * 即主动调用 remember_preference 写入，无需用户显式说「记住」；写入前先 read_preferences
 * 查同类矛盾条目，有矛盾走 update_preference 覆盖而非重复追加（防矛盾累积）。用户可在记忆
 * 面板随时改 / 删，也可让 AI 用 delete_preference。敏感信息（密码 / 密钥 / token / 证件号 /
 * 银行卡等）一律拒绝写入（见 detectSensitive，存储是明文 Markdown）。
 * 存储于 ~/BobWork/butler/preferences.md（统一，跨项目，所有联系人的每轮对话都注入参考）。
 *
 * 注入分档（见 runtime/context.ts 的 buildUserPreferencesInjection）：常驻档
 * （身份画像 / 偏好习惯）每轮注入正文；其余类型只注入 type 目录，按需 read_preferences 取全文。
 *
 * 结构化存储（完整结构化，每条记忆带元数据字段）：
 *   - content    记忆内容（一句话，去重键）
 *   - type       类型分类（六类词表见 MEMORY_TYPES，缺省「通用」）
 *   - created_at 记录时间（自动写入）
 *   - source     记录来源（默认 chat，标识触发来源）
 * 文件格式（人类可读的 Markdown + 缩进元数据）：
 *   - 用户习惯用表格输出
 *     type: 偏好习惯
 *     created_at: 2026-08-07 14:30
 *     source: chat
 */
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { resolveAppRoot } from '@/lib/app-root';
// 纯常量与类型放 preferences-shared（客户端「记忆面板」直接引用）：本模块含 fs 读写与
// app-root 解析，客户端链路无法 bundle，故词表 / 常驻档名单 / 相似度门限抽到无 Node 依赖的模块共用。
import { CONFLICT_SIMILARITY_THRESHOLD, detectNegation, similarity, type UserPreference } from './preferences-shared';

export type { UserPreference } from './preferences-shared';
export {
  MEMORY_TYPES,
  ALWAYS_INJECTED_TYPES,
  ALWAYS_INJECTED_MAX,
} from './preferences-shared';
export { CONFLICT_SIMILARITY_THRESHOLD, similarity };

const APP_ROOT = resolveAppRoot();

/** addPreference 可选元数据 */
export interface AddPreferenceOptions {
  type?: string;
  source?: string;
}

/**
 * 敏感信息守卫词表：记忆以**明文** Markdown 落盘并每轮注入，凭证 / 证件一旦写入等于长期留痕。
 * 只拦「凭证类」与「证件 / 金融类」，保持收敛——普通偏好（如「喜欢用命令行」）不应被误判。
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /密码|口令|passw(or)?d/i,
  /密钥|私钥|secret|api[\s_-]?key|access[\s_-]?key|access[\s_-]?token/i,
  /\btokens?\b/i,
  /身份证|证件号|护照号|社保号/,
  /银行卡|信用卡|储蓄卡|\bcvv\b|验证码/i,
];

/**
 * 检测文本是否含敏感信息。命中返回命中的特征串（供回执提示），未命中返回 null。
 * 供 addPreference 写前拦截，也可被上层复用。
 */
export function detectSensitive(text: string): string | null {
  for (const re of SENSITIVE_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

/** 确保 butler/preferences.md 存在，返回其绝对路径 */
export async function ensurePreferencesFile(): Promise<string> {
  const butlerDir = join(APP_ROOT, 'butler');
  const prefPath = join(butlerDir, 'preferences.md');
  try {
    await access(butlerDir);
  } catch {
    await mkdir(butlerDir, { recursive: true });
  }
  try {
    await access(prefPath);
  } catch {
    await writeFile(prefPath, `# User Memory

> 用户记忆的唯一长期存储：记的是**用户**，所有联系人共享同一份（联系人差异只体现在会话人设）。
> AI 会在对话中自动记住持久事实与偏好（无需用户显式说「记住」）；写入前先查同类：有矛盾则覆盖更新，同一件事（哪怕措辞不同）则合并成一条。
> 用户可在记忆面板随时查看 / 修改 / 删除，也可靠 AI 增删。
> 类型取六类之一：身份画像 / 偏好习惯 / 工作上下文 / 事实经历 / 目标计划 / 关系边界；缺省「通用」。
> 其中身份画像、偏好习惯每轮注入正文，其余类型按需调取。
> 敏感信息（密码 / 密钥 / token / 证件号 / 银行卡等）一律不记录。
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

/**
 * 追加一条偏好（按 content 去重；自动写入 created_at，默认 source=chat）。
 * 写前三道闸：① 敏感信息拒写（明文落盘）；② **否定式表达拒收并路由到规则集**（v6 §4.2 / ⑧，
 * 偏好层不得承载承诺性内容）；③ 同类型高相似拒写（倒逼走 update_preference，防同一事实换措辞重复累积）。
 * 命中分别返回 blocked / routed / conflict。
 */
export async function addPreference(
  content: string,
  opts?: AddPreferenceOptions,
): Promise<{
  added: boolean;
  total: number;
  duplicate?: string;
  blocked?: string;
  /** 命中否定式表达：不在偏好层落盘，改由调用方（remember_preference）转为规则（v6 §4.2 / ⑧） */
  routed?: { content: string };
  conflict?: { index: number; content: string; score: number };
}> {
  const text = content.trim().replace(/\s+/g, ' ');
  if (!text) return { added: false, total: 0 };
  const hit = detectSensitive(text);
  if (hit) return { added: false, total: 0, blocked: hit };
  const type = (opts?.type || '通用').trim() || '通用';
  const path = await ensurePreferencesFile();
  const raw = await readFile(path, 'utf-8');
  const existing = parseEntries(raw.split('\n'));
  // ⑧：否定式表达是硬约束（执行上无中间态），不属于偏好层——写入前拒收，交调用方路由到规则集。
  if (detectNegation(text)) return { added: false, total: existing.length, routed: { content: text } };
  const dup = existing.find((e) => e.content === text);
  if (dup) return { added: false, total: existing.length, duplicate: dup.content };
  // 同类型相似度门限：命中拒绝追加，回执带既有序号，让模型判断是「更新」还是「换措辞的新事实」
  for (let i = 0; i < existing.length; i++) {
    const e = existing[i];
    if ((e.meta.type || '通用') !== type) continue;
    const score = similarity(e.content, text);
    if (score >= CONFLICT_SIMILARITY_THRESHOLD) {
      return { added: false, total: existing.length, conflict: { index: i + 1, content: e.content, score } };
    }
  }
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
 * 更新后的 content 若为否定式表达，**不写回**，返回 routed 信号（v6 §4.2 / ⑧）。
 * 返回是否更新成功、剩余条数，以及更新后的完整条目（供工具回显）。
 */
export async function updatePreference(
  index: number,
  patch: { content?: string; type?: string },
): Promise<{ updated: boolean; remaining?: number; preference?: UserPreference; error?: string; routed?: { content: string } }> {
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
  // ⑧：把一条偏好改成否定式表达 = 把偏好改成规则，不在偏好层写回。
  if (patch.content !== undefined && detectNegation(content)) {
    return { updated: false, routed: { content } };
  }
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
