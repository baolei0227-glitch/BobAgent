/**
 * lib/butler/storage.ts —— Butler 存储路径真源
 *
 * 目录布局（会话 / 附件 / 输出文档按**角色**分类，角色内再按**日期**分类）：
 *
 *   <APP_ROOT>/butler/
 *     roles.json                        # 角色注册表：threadId → { name, dir }
 *     .state/                           # 内部状态（去重标记等），与用户可见内容分离
 *       daily-tasks/<YYYY-MM-DD>.<type>
 *     <角色名>/<YYYY-MM-DD>/
 *       attachments/                    # 当天上传的附件
 *       docs/                           # 当天生成的输出文档（报告等）
 *       chat/YYYY-MM-DD.md              # 当天该会话的可读记录
 *
 * 「角色」= 会话人设 `persona.name`（联系人标题 / 助理姓名）；`persona.role` 是自由文本，不作目录名。
 * 无会话上下文（系统定时产出、尚未建会话时上传）归固定角色：
 *   - 通知助理线程（notify）→ 「Bobby」（微信桥入站消息自 2026-09-28 起也落这条线程）
 *   - 完全没有 threadId      → 「未分类」
 *
 * 本模块 server-only（角色解析要读线程文件的人设），仅供服务端引用。
 *
 * 依赖刻意做到「零内部依赖」：只碰 app-root、线程文件与 .inbox.db，不 import threads / butler-notify，
 * 避免与「threads → transcript → storage」形成 import 环（eslint import/no-cycle）。
 * （人设真源为 `<butler>/.state/threads/<threadId>.json`，本模块直接读文件而不 import threads.ts，
 *  旧 `chat_sessions.persona` 仅作迁移期兜底。）
 */
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { atomicWriteFile, createLock } from './fs-atomic';
import { join, resolve, sep } from 'path';
import { INBOX_DB_FILENAME, resolveAppRoot } from '@/lib/app-root';

/** 常驻通知助理的会话线程 ID（真源；butler-notify.ts 从这里再导出） */
export const NOTIFY_THREAD_ID = 'butler-notify';
/**
 * 常驻通知助理的**显示名** / 其角色目录名。
 * 显示名于 2026-09-28 定为「Bobby」（前身「Alfred」，中间曾短暂用「Xiao Wei」）。
 * ⚠️ 形象沿革：2026-09-30 与「小微」**互换**（微信绿专用件归小微），2026-10-01 起改用
 * Bobby 自己的专用件 `bell` + 蓝底 210°（见 lib/butler/avatar.ts 的 SYSTEM_IDENTITIES）。
 * 「通知助理」仍是它在这个代码库里的**角色定位**说法，所以各处注释里的「通知助理」指的是角色，不是界面上的字符串。
 *
 * ⚠️ **命名歧义（2026-10-06 显式记录）：本仓有两个「Bobby」，同名不同物。**
 *   - **本常量** = 管家（identity `butler`）**通知助理会话的显示名**：就是 Butler 抽屉里跟你对话的那个联系人，
 *     会话线程 `butler-notify`、落盘目录 `butler/Bobby/`、头像 `bell`。姓名由本常量钉死
 *     （人设弹窗「据此锁定姓名」，只能改性格/风格/称呼），persona 真源在 `.state/threads/<id>.json`。
 *   - **另一个 Bobby** = **本地软件操控插件**：`src/app/api/bobby/route.ts`、画布 `BobbyNode`、
 *     全局授权宿主 `components/bobby/BobbyAuthHost.tsx`、MCP server id `bobby`（工具场景 `local`）。
 *     那是「让 AI 操控本机软件」的能力，与管家会话没有任何关系。
 *   搜索 "Bobby" 时先辨别是哪一个；两边都写了这条互指注释。
 */
export const NOTIFY_TITLE = 'Bobby';

/** 常驻「小微」会话线程 ID（搜索与资料整理助手；真源，butler-search.ts 从这里再导出） */
export const SEARCH_THREAD_ID = 'butler-search';
/** 常驻搜索助手的**显示名** / 其角色目录名。中文名，与 Bobby 区分开。 */
export const SEARCH_TITLE = '小微';

/** Butler 根目录：<APP_ROOT>/butler */
export function butlerRoot(): string {
  return join(resolveAppRoot(), 'butler');
}

/**
 * 该绝对路径是否落在 Butler 根目录内（含根目录自身）。
 * 用途：只允许读自家目录的接口（如自定义头像 GET /api/butler/avatar）做**越界校验**——
 * 先 resolve 归一掉 `..` / 相对段再比前缀，字符串前缀比较才可靠（否则 `/butler-evil` 会冒充命中）。
 */
export function isInButlerRoot(p: string): boolean {
  const root = resolve(butlerRoot());
  const abs = resolve(p);
  return abs === root || abs.startsWith(root + sep);
}

/** 内部状态根（与用户可见的角色目录分离）：<APP_ROOT>/butler/.state */
export const STATE_DIR = join(butlerRoot(), '.state');

/** 角色注册表文件路径 */
export const ROLES_FILE = join(butlerRoot(), 'roles.json');

/** 无 threadId（尚未建会话时上传）时的兜底角色 */
export const UNSORTED_ROLE_NAME = '未分类';
/** 人设姓名为空 / 清洗后为空时的兜底目录名 */
export const FALLBACK_ROLE_NAME = '未命名角色';

/** 角色目录名上限（超长会拖累路径拼接与文件系统兼容） */
const MAX_ROLE_NAME_LEN = 64;

export interface RoleEntry {
  /** 角色显示名（人设姓名原文，用于标题/展示） */
  name: string;
  /** 角色目录名（经白名单清洗，用于落盘路径） */
  dir: string;
}

interface RolesFile {
  threads: Record<string, RoleEntry>;
}

/**
 * 角色目录名白名单清洗：剔除文件系统非法字符与换行、去掉 `..`、不以点开头、截断到 64 字符。
 * 结果为空则回退「未命名角色」。
 */
export function sanitizeRoleName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return FALLBACK_ROLE_NAME;
  let name = s
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_') // 文件系统非法字符
    .replace(/\.{2,}/g, '_')             // 去掉 `..`，防目录穿越
    .replace(/^\.+/, '_')                // 不以点开头（避免与 .state 等内部目录混淆）
    .replace(/\s+$/g, '')                // 去掉尾部空白（Windows 兼容）
    .trim();
  if (name.length > MAX_ROLE_NAME_LEN) name = name.slice(0, MAX_ROLE_NAME_LEN).trim();
  return name || FALLBACK_ROLE_NAME;
}

/** 本地时区日期戳 YYYY-MM-DD */
export function dateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 确保目录存在（幂等） */
export async function ensureDir(p: string): Promise<string> {
  await fs.mkdir(p, { recursive: true });
  return p;
}

/**
 * 回收 `roles.json` 里的**孤儿角色条目**（2026-10-02 评审 P2-⑯）。
 *
 * 背景：`roles.json` 是只增不删的注册表（只有 readRoles / writeRoles / 增改），
 * 而条目与线程文件是「指针 ↔ 实体」关系——线程被删（过期清扫 / `purgeRetiredWechatThread` /
 * 用户在联系人列删除）后条目仍留着。实测运行实例：10 条角色 vs 3 个活线程，
 * 含已退役的 `butler-wechat`（Xiao Wei）。
 *
 * 清理判据：**线程文件不存在** ⇒ 该条目已无实体可指（联系人列也渲染不出它）。
 * 三条豁免（不清理）：
 *   - 两个常驻 id（Bobby / 小微）：线程可能只是还没被首次创建（`ensure*Session` 才落盘）；
 *   - 有线程文件的条目；
 *   - 非法 id（不是本模块能判定的形态）。
 * **绝不删除角色目录**：那里面有用户的附件与文档，清条目只是清指针。
 *
 * 幂等、可重复调用；返回被清掉的 threadId 列表（供日志/测试）。
 */
export async function pruneOrphanRoles(): Promise<string[]> {
  const RESIDENT = new Set<string>([NOTIFY_THREAD_ID, SEARCH_THREAD_ID]);
  const roles = await readRoles();
  const ids = Object.keys(roles.threads);
  if (ids.length === 0) return [];

  const removed: string[] = [];
  for (const id of ids) {
    if (RESIDENT.has(id)) continue;
    if (existsSync(join(threadsDirPath(), `${id}.json`))) continue;
    delete roles.threads[id];
    removed.push(id);
  }
  if (removed.length === 0) return [];
  await writeRoles(roles);
  return removed;
}

/** 读角色注册表；无文件 / 损坏 → 空表（不让脏数据阻断落盘） */
export async function readRoles(): Promise<RolesFile> {
  try {
    const raw = await fs.readFile(ROLES_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const t = (parsed as { threads?: unknown }).threads;
      if (t && typeof t === 'object' && !Array.isArray(t)) {
        const threads: Record<string, RoleEntry> = {};
        for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
          if (!v || typeof v !== 'object') continue;
          const name = typeof (v as RoleEntry).name === 'string' ? (v as RoleEntry).name : '';
          const dir = typeof (v as RoleEntry).dir === 'string' ? (v as RoleEntry).dir : '';
          if (name && dir) threads[k] = { name, dir };
        }
        return { threads };
      }
    }
  } catch { /* 无文件或损坏 → 空表 */ }
  return { threads: {} };
}

/** 写角色注册表（先写 tmp 再 rename，避免并发读-改-写写出半截 JSON） */
export async function writeRoles(roles: RolesFile): Promise<void> {
  await ensureDir(butlerRoot());
  await atomicWriteFile(ROLES_FILE, JSON.stringify(roles, null, 2));
}

/** roles.json 读-改-写串行化（多请求并发解析同一 mapping 时避免互相覆盖）。
 *  锁与原子写原语统一取自 `./fs-atomic`（2026-10-02 评审：此前 5 份副本各自演化）。 */
const withRolesLock = createLock();

/** 只读连接（进程内复用；角色解析是高频轻量操作，不值得每次开库） */
let _personaDb: import('better-sqlite3').Database | null = null;

/** 线程真源目录：<butler>/.state/threads（与 threads.ts 的 threadsDir 同口径） */
function threadsDirPath(): string {
  return join(butlerRoot(), '.state', 'threads');
}

/** 从 `{ persona: { name } }` 这样的对象里取人设姓名；非对象 / 无 name → null */
function pickPersonaName(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const name = (parsed as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * 读某线程的人设姓名。
 *
 * 真源是 Butler 线程文件 `<butler>/.state/threads/<threadId>.json` 的 `persona.name`；
 * 读不到再兜底读旧 `chat_sessions.persona`（Phase 4 迁移期的兼容，迁移完成后自然不再命中）。
 *
 * ⚠️ 这里**直接读文件而不 import threads.ts**：本模块刻意零内部依赖，以避免
 * `threads → transcript → storage` 的 import 环（见文件头注释）。
 * 只取 name 字段；无文件 / 坏 JSON / name 为空一律 null（调用方回退「未命名角色」）。
 */
async function lookupPersonaName(threadId: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(threadsDirPath(), `${threadId}.json`), 'utf-8');
    const v = JSON.parse(raw) as { persona?: unknown };
    const fromThread = pickPersonaName(v?.persona);
    if (fromThread) return fromThread;
  } catch { /* 无线程文件 → 回退旧表 */ }
  try {
    if (!_personaDb) {
      const Database = (await import('better-sqlite3')).default;
      _personaDb = new Database(join(resolveAppRoot(), INBOX_DB_FILENAME), { readonly: true });
    }
    const row = _personaDb
      .prepare(`SELECT persona FROM chat_sessions WHERE thread_id = ?`)
      .get(threadId) as { persona: string | null } | undefined;
    if (!row?.persona) return null;
    return pickPersonaName(JSON.parse(row.persona) as unknown);
  } catch {
    return null;
  }
}

/** threadId → 稳定短标识（djb2 → base36）：目录名冲突时做消歧后缀，同一 id 每次解析结果一致 */
function shortIdHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * 目录名已被其他角色占用时，追加 threadId 的稳定短后缀消歧：
 * 两个同名联系人必须落到两个目录，否则附件/文档/记录会串到一起。
 */
function disambiguateRoleDir(base: string, threadId: string, taken: Set<string>): string {
  const hash = shortIdHash(threadId);
  for (let len = 4; len <= hash.length; len++) {
    const cand = `${base}-${hash.slice(0, len)}`;
    if (!taken.has(cand) && !existsSync(join(butlerRoot(), cand))) return cand;
  }
  return `${base}-${hash}`;
}

/**
 * 解析 threadId 对应的角色（显示名 + 目录名），并同步维护 roles.json。
 *
 * - threadId 缺失        → 未分类
 * - 通知助理线程（notify）→ 固定「Bobby」（微信入站消息也归这里，见 wechat-bridge.ts）
 * - 其余                 → 读 chat_sessions.persona.name，清洗后作目录名
 *
 * 检测到改名（同 threadId 的 dir 变化）时把旧目录整体 rename 到新目录名（不丢已有附件/文档/记录）；
 * rename 失败、目标目录已存在、或目标名已被**其他** threadId 占用时，保留旧目录，只更新映射里的显示名。
 * 新 threadId 首次解析时若目录名已被其他角色占用（两个同名联系人会算出同一个 dir），
 * 追加该 threadId 的稳定短后缀消歧——「一个角色一个目录」，否则附件/文档/记录会串到一起。
 */
export async function resolveRole(threadId: string | null | undefined): Promise<RoleEntry> {
  const id = typeof threadId === 'string' ? threadId.trim() : '';
  if (!id) return { name: UNSORTED_ROLE_NAME, dir: UNSORTED_ROLE_NAME };

  let name: string;
  let dir: string;
  if (id === NOTIFY_THREAD_ID) {
    name = NOTIFY_TITLE;
    dir = sanitizeRoleName(NOTIFY_TITLE);
  } else if (id === SEARCH_THREAD_ID) {
    // 搜索助手常驻联系人：显示名固定「小微」，目录固定，保证其附件/产物落点稳定
    name = SEARCH_TITLE;
    dir = sanitizeRoleName(SEARCH_TITLE);
  } else {
    const personaName = await lookupPersonaName(id);
    name = (personaName || '').trim() || FALLBACK_ROLE_NAME;
    dir = sanitizeRoleName(name);
  }

  await withRolesLock(async () => {
    const roles = await readRoles();
    const old = roles.threads[id];
    /** 该目录名是否已被**其他** threadId 占用（同名联系人会算出同一个 dir） */
    const claimedByOther = (d: string) =>
      Object.entries(roles.threads).some(([tid, entry]) => tid !== id && entry.dir === d);

    if (old && old.dir !== dir) {
      const oldPath = join(butlerRoot(), old.dir);
      const newPath = join(butlerRoot(), dir);
      if (claimedByOther(dir) || (existsSync(oldPath) && existsSync(newPath))) {
        // 目标目录已被占用（另一角色占用同名 / 旧目录尚有内容）：保留旧目录，避免目录混用与文件失联
        dir = old.dir;
      } else if (existsSync(oldPath)) {
        try {
          await fs.rename(oldPath, newPath);
        } catch (e) {
          console.warn('[butler/storage] 角色目录改名失败，保留旧目录:', e instanceof Error ? e.message : String(e));
          dir = old.dir;
        }
      }
      // 旧目录不存在（历史遗留 / 未落盘）→ 直接采用新目录名
    } else if (!old) {
      // 新 threadId 首次解析：目录名若已被其他角色占用，追加稳定后缀消歧（两个同名联系人不能共用一个目录）
      const taken = new Set<string>([UNSORTED_ROLE_NAME]);
      for (const [tid, entry] of Object.entries(roles.threads)) {
        if (tid !== id) taken.add(entry.dir);
      }
      if (taken.has(dir)) dir = disambiguateRoleDir(dir, id, taken);
    }
    if (!old || old.name !== name || old.dir !== dir) {
      roles.threads[id] = { name, dir };
      await writeRoles(roles);
    }
  });

  return { name, dir };
}

/** 角色目录绝对路径：<butler>/<角色目录名> */
export async function resolveRoleDir(threadId: string | null | undefined): Promise<string> {
  const role = await resolveRole(threadId);
  return join(butlerRoot(), role.dir);
}

/** 角色 + 日期目录绝对路径：<butler>/<角色目录名>/<YYYY-MM-DD> */
export async function roleDateDir(threadId: string | null | undefined, date: Date): Promise<string> {
  return join(await resolveRoleDir(threadId), dateStamp(date));
}