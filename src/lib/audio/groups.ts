/**
 * 音频库**分组**（用户自建的文件夹 + 条目归属）。
 *
 * 落盘：`<APP_ROOT>/.audio-library/.groups.json`（隐藏文件，与库产物同居一处，**不进 workspace**）。
 *
 * 为什么把分组状态放在**库根**、而不是塞进每个条目目录：
 *   - 分组是**库级**的组织方式（一个组跨多个源音频），写在根上才是唯一真源；
 *   - 它是应用产物，随 `.audio-library/` 一起存在 / 删除，与库的"绝不进 workspace"口径一致；
 *   - `listLibrary`（只认目录）与 `listShadowDirs`（只认目录）都会跳过这个文件，
 *     不会被当成一条音频或一个影子目录。
 *
 * 归属用**条目目录名**（`<源名>-<指纹>`）而不是绝对路径：
 *   - 目录名在库内唯一，且不随 APP_ROOT 变化失效（库整体搬家/换机器后仍对得上）；
 *   - 条目在库里的身份本来就是"这个目录"，与 `listLibrary().dir` 的 basename 一一对应。
 *
 * 只在**服务端**使用（路由层）。
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { libraryRoot } from './library';
import { AUDIO_EXTS } from './naming';

/** 分组状态文件名（库根下；`listLibrary` 只认目录，不会把它当音频） */
const GROUPS_NAME = '.groups.json';
/** 状态结构版本（未来改结构时据此迁移；当前只有 1） */
const GROUPS_VERSION = 1;
/** 组名长度上限（与 `safeBaseName` 的 80 相比更紧：分组名是标签，不该长过一行） */
const MAX_NAME = 40;

/** 一个用户自建的分组 */
export interface AudioGroup {
  /** 稳定 id（`g_` + 12 位 hex）；重命名不改 id，归属靠它引用 */
  id: string;
  /** 展示名（已 sanitize，非空） */
  name: string;
}

/** 库分组状态：组列表 + 条目归属 */
export interface GroupState {
  /** 分组（数组顺序 = 展示顺序 = 创建顺序） */
  groups: AudioGroup[];
  /** 条目目录名 → 组 id（键不存在 = 未分组） */
  assign: Record<string, string>;
}

/** 分组状态文件绝对路径 */
function groupsFile(): string {
  return join(libraryRoot(), GROUPS_NAME);
}

/**
 * 组名 sanitize：折叠换行/制表与连续空白 → 去首尾空白 → 截断。
 * 空串返回 null（调用方据此判"没填名字"）。
 */
function sanitizeName(input: unknown): string | null {
  const cleaned = String(input ?? '')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return cleaned || null;
}

/** 组 id 形态校验：只认本模块自己生成的格式（防止脏数据被当 id 用） */
function isGroupId(v: unknown): v is string {
  return typeof v === 'string' && /^g_[a-f0-9]{12}$/.test(v);
}

/**
 * 把磁盘上读到的任意 JSON **规范化**成可信状态。
 * 所有不可信项一律丢弃（不抛错）：脏组、重复 id、指向不存在组的归属。
 */
function normalize(raw: unknown): GroupState {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const groups: AudioGroup[] = [];
  const ids = new Set<string>();
  if (Array.isArray(obj.groups)) {
    for (const item of obj.groups) {
      if (!item || typeof item !== 'object') continue;
      const { id, name } = item as { id?: unknown; name?: unknown };
      const nm = sanitizeName(name);
      if (!isGroupId(id) || !nm || ids.has(id)) continue;
      ids.add(id);
      groups.push({ id, name: nm });
    }
  }
  const assign: Record<string, string> = {};
  if (obj.assign && typeof obj.assign === 'object') {
    for (const [key, value] of Object.entries(obj.assign as Record<string, unknown>)) {
      if (!key || !isGroupId(value) || !ids.has(value)) continue;
      assign[key] = value;
    }
  }
  return { groups, assign };
}

/** 读分组状态；文件不存在 / 非法 JSON / 结构不符 → 空状态（**绝不抛错**） */
export async function readGroupState(): Promise<GroupState> {
  try {
    return normalize(JSON.parse(await fs.readFile(groupsFile(), 'utf-8')));
  } catch {
    return { groups: [], assign: {} };
  }
}

/**
 * 写分组状态（临时文件 + rename，避免中途失败留下半截 JSON）。
 * `mkdir -p` 库根：库可能还不存在（用户还没导入过任何音频就先建了组）。
 */
async function writeGroupState(state: GroupState): Promise<void> {
  const root = libraryRoot();
  await fs.mkdir(root, { recursive: true });
  const file = groupsFile();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: GROUPS_VERSION, groups: state.groups, assign: state.assign }), 'utf-8');
  await fs.rename(tmp, file);
}

/** 新建一个分组（名字为空 → 抛错）。返回写盘后的完整状态。 */
export async function createGroup(name: unknown): Promise<GroupState> {
  const nm = sanitizeName(name);
  if (!nm) throw new Error('group name is required');
  const state = await readGroupState();
  state.groups.push({ id: `g_${randomBytes(6).toString('hex')}`, name: nm });
  await writeGroupState(state);
  return state;
}

/** 重命名一个分组（组不存在 / 名字为空 → 抛错） */
export async function renameGroup(id: string, name: unknown): Promise<GroupState> {
  const nm = sanitizeName(name);
  if (!nm) throw new Error('group name is required');
  const state = await readGroupState();
  const group = state.groups.find((g) => g.id === id);
  if (!group) throw new Error('group not found');
  group.name = nm;
  await writeGroupState(state);
  return state;
}

/** 删除一个分组（组不存在 → 抛错）：组消失 + 指向它的归属一并抹掉（条目回到未分组） */
export async function deleteGroup(id: string): Promise<GroupState> {
  const state = await readGroupState();
  if (!state.groups.some((g) => g.id === id)) throw new Error('group not found');
  state.groups = state.groups.filter((g) => g.id !== id);
  for (const [key, gid] of Object.entries(state.assign)) {
    if (gid === id) delete state.assign[key];
  }
  await writeGroupState(state);
  return state;
}

/**
 * 目标目录是否是一条**正式库条目**（库内 + 含 `source.<音频扩展名>`）。
 * 分组只认这种目录：防止借 `assign_group` 往状态文件里塞任意键。
 */
async function isLibraryEntryDir(dirAbs: string): Promise<boolean> {
  const root = libraryRoot();
  if (!dirAbs.startsWith(root + '/') || dirAbs === root) return false;
  let files: string[];
  try {
    files = await fs.readdir(dirAbs);
  } catch {
    return false;
  }
  return files.some((f) => f.startsWith('source.') && AUDIO_EXTS.includes(extname(f).toLowerCase()));
}

/**
 * 把某条库内音频移入分组（`groupId` 为空串 → 移出分组回到未分组）。
 *
 * `dirAbs` 是条目目录的**绝对路径**（`LibraryEntry.dir`）；只认正式库条目，
 * 目标组必须存在。状态没变化时**不写盘**（拖到原地不该产生一次 I/O）。
 */
export async function assignEntry(dirAbs: string, groupId: string): Promise<GroupState> {
  if (!(await isLibraryEntryDir(dirAbs))) throw new Error('not a library entry');
  const key = basename(dirAbs);
  const state = await readGroupState();
  if (!groupId) {
    if (!(key in state.assign)) return state;
    delete state.assign[key];
    await writeGroupState(state);
    return state;
  }
  if (!state.groups.some((g) => g.id === groupId)) throw new Error('group not found');
  if (state.assign[key] === groupId) return state;
  state.assign[key] = groupId;
  await writeGroupState(state);
  return state;
}

/**
 * 条目被从库中删除时，顺手抹掉它的归属 —— 否则 `.groups.json` 会留下永远对不上的键。
 * 没记录就不写盘。
 */
export async function forgetEntry(dirAbs: string): Promise<void> {
  const key = basename(dirAbs);
  const state = await readGroupState();
  if (!(key in state.assign)) return;
  delete state.assign[key];
  await writeGroupState(state);
}
