import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * 项目内文件标签（作用域 = 文件清单的顶层目录）：
 *  - materials → <项目>/materials/.tags.json（资料）
 *  - homework  → <项目>/homework/.tags.json（作业产物）
 * 键为对应作用域根下的相对路径。标签表名以 "." 开头，既不出现在文件清单中，也不参与内容索引。
 */
export type TagScope = 'materials' | 'homework';

/** 作用域白名单（作用域来自请求参数，必须收敛到已知取值，防路径穿越） */
export const TAG_SCOPES: readonly TagScope[] = ['materials', 'homework'];
export const isTagScope = (value: unknown): value is TagScope =>
  typeof value === 'string' && (TAG_SCOPES as readonly string[]).includes(value);

/** 标签表文件名：与所属作用域根同级存放 */
export const FILE_TAGS_FILE = '.tags.json';

/** 单文件标签数上限 / 单个标签长度上限（用户输入边界，防滥用） */
const MAX_TAGS_PER_FILE = 12;
const MAX_TAG_LENGTH = 24;

/** 作用域根下相对路径 → 标签数组 */
export type FileTagsMap = Record<string, string[]>;

/** 清洗单个标签：折叠空白、去首尾空白、截断超长、剔除空值 */
function normalizeTag(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
}

/** 清洗标签数组：逐项规范化 → 忽略大小写去重（保留首个写法）→ 截断数量 */
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const tag = normalizeTag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_FILE) break;
  }
  return out;
}

const tagsPathFor = (projectPath: string, scope: TagScope): string =>
  join(projectPath, scope, FILE_TAGS_FILE);

/** 读取标签表：文件缺失 / JSON 损坏时返回空表（标签是附加信息，不应阻塞文件浏览） */
export async function readFileTags(projectPath: string, scope: TagScope): Promise<FileTagsMap> {
  try {
    const raw = await fs.readFile(tagsPathFor(projectPath, scope), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: FileTagsMap = {};
    for (const [rel, tags] of Object.entries(parsed as Record<string, unknown>)) {
      const cleaned = normalizeTags(tags);
      if (cleaned.length > 0) out[rel] = cleaned;
    }
    return out;
  } catch {
    return {};
  }
}

/** 落盘标签表（先写临时文件再 rename：避免中断时写坏既有标签） */
async function writeFileTags(projectPath: string, scope: TagScope, map: FileTagsMap): Promise<void> {
  const scopePath = join(projectPath, scope);
  await fs.mkdir(scopePath, { recursive: true });
  const target = tagsPathFor(projectPath, scope);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf-8');
  await fs.rename(tmp, target);
}

/** 设置某文件的标签（空数组 = 删除该文件的标签条目），返回规范化后的标签 */
export async function setFileTags(
  projectPath: string,
  scope: TagScope,
  relPath: string,
  tags: unknown,
): Promise<string[]> {
  const map = await readFileTags(projectPath, scope);
  const cleaned = normalizeTags(tags);
  if (cleaned.length > 0) map[relPath] = cleaned;
  else delete map[relPath];
  await writeFileTags(projectPath, scope, map);
  return cleaned;
}

/** 批量设置多个文件的标签：一次读取 + 一次落盘（多选批量打标签时避免逐项读改写互相覆盖）。
 *  返回本次实际写入的条目（键 = 作用域根相对路径）。 */
export async function setFileTagsBulk(
  projectPath: string,
  scope: TagScope,
  items: { relPath: string; tags: unknown }[],
): Promise<FileTagsMap> {
  const applied: FileTagsMap = {};
  if (items.length === 0) return applied;

  const map = await readFileTags(projectPath, scope);
  for (const { relPath, tags } of items) {
    if (!relPath) continue;
    const cleaned = normalizeTags(tags);
    if (cleaned.length > 0) map[relPath] = cleaned;
    else delete map[relPath];
    applied[relPath] = cleaned;
  }
  await writeFileTags(projectPath, scope, map);
  return applied;
}

/** 路径迁移（移动 / 重命名）：命中条目及其整棵子路径前缀的键一并改写 */
export async function renameFileTags(
  projectPath: string,
  scope: TagScope,
  fromRel: string,
  toRel: string,
): Promise<void> {
  if (!fromRel || fromRel === toRel) return;
  const map = await readFileTags(projectPath, scope);
  const next: FileTagsMap = {};
  let changed = false;
  for (const [rel, tags] of Object.entries(map)) {
    if (rel === fromRel || rel.startsWith(fromRel + '/')) {
      next[toRel + rel.slice(fromRel.length)] = tags;
      changed = true;
    } else {
      next[rel] = tags;
    }
  }
  if (changed) await writeFileTags(projectPath, scope, next);
}

/** 路径移除（删除文件 / 目录）：命中条目及其子路径前缀一并清除 */
export async function removeFileTags(
  projectPath: string,
  scope: TagScope,
  relPath: string,
): Promise<void> {
  if (!relPath) return;
  const map = await readFileTags(projectPath, scope);
  let changed = false;
  for (const rel of Object.keys(map)) {
    if (rel === relPath || rel.startsWith(relPath + '/')) {
      delete map[rel];
      changed = true;
    }
  }
  if (changed) await writeFileTags(projectPath, scope, map);
}
