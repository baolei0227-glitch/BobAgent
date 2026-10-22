/**
 * 便签「作用域」解析 —— 画布便签 / 待办写入的落点收口（项目 or 全局 Inbox）
 *
 * 背景：butler 每天会收到许多待办，其中一部分「尚未立项、也没有时间」——这类临时待办
 * 既不属于任何项目，也进不了日历。产品定案（方案 A：归口 + 聚合，不新增第四套体系）：
 *   有项目 + 有时间 → 项目便签行 + 日历事件
 *   有项目 + 无时间 → 项目便签行
 *   未立项 + 有时间 → 全局日历事件（scope='global'）
 *   未立项 + 无时间 → **全局 Inbox 待办**（本模块提供落点）
 *
 * 归口原则：不新增存储。全局 Inbox 的便签直接落在**应用根目录**（resolveAppRoot()）下的
 * 标准便签文件 `<appRoot>/sticky-notes/sticky-notes.json`，与项目便签**同一套文件结构与
 * 同一套读写/索引/日历同步函数**——只是把 appRoot 当作一个 pseudo-project root 使用。
 * `syncProjectsFromDisk` 只扫描 `BobWorkspace/` 子目录，不会把 `sticky-notes/` 误认成项目。
 *
 * 两个哨兵常量的分工（勿混）：
 *   - INBOX_PROJECT_ID='__inbox__'        —— 便签 / 聚合层面的 Inbox 标识（inspect 分组标签、
 *     前端便签项定位、路由便签落点哨兵）。日历事件**不用**它。
 *   - GLOBAL_SCOPE_PROJECT_ID='__global__' —— 日历事件层面的全局归属（Inbox 行入日历 / 无项目
 *     待办），与 app/api/calendar/events POST 的 scope=global 口径一致。
 * 二者都解析到同一个 Inbox 便签作用域（见 resolveStickyScope）。
 *
 * 命名区分（勿混）：本模块的 Inbox 是**待办 Inbox**（sticky 文件，显示名 'Todo Inbox'），
 * 与 butler 的**通知收件箱**（`lib/core/inbox.ts` + `.inbox.db`）是两回事。
 */
import { resolveAppRoot } from '@/lib/app-root';
import { getCurrentProject, getProjectById } from '@/lib/project/project-manager';

/** 待办 Inbox 在便签 / 聚合层面的项目标识（inspect 分组、前端便签定位、落点哨兵） */
export const INBOX_PROJECT_ID = '__inbox__';

/** 待办 Inbox 行入日历时的全局归属 project_id（与日历 scope='global' 口径一致） */
export const GLOBAL_SCOPE_PROJECT_ID = '__global__';

/** 待办 Inbox 的显示名（English label；勿用裸 'Inbox'，避免与通知收件箱混淆） */
export const TODO_INBOX_NAME = 'Todo Inbox';

/** 显式指向「未立项」的引用别名（大小写不敏感，精确匹配；不与项目名做模糊匹配，避免误判）。
 *  用户说"先记一下 / 还没立项 / 临时"时，模型可传这些值把待办归到 Todo Inbox。 */
const INBOX_REFS = new Set([
  'inbox',
  'todo inbox',
  'todo-inbox',
  INBOX_PROJECT_ID,
  GLOBAL_SCOPE_PROJECT_ID,
  '未立项',
  '收件箱',
  '待归口',
]);

/** 判断一个项目引用是否**显式**指向待办 Inbox（未立项的临时待办）。
 *  butler 写类工具（create_sticky_note / create_scheduled_todo）与归属迁移（todo_update）共用同一套别名。
 *  注意：这是「显式指定」，与「未指定 project 时的当前项目兜底 / 无项目时的 Inbox 回退」是两回事。 */
export function isInboxRef(ref?: string | null): boolean {
  const raw = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
  return raw !== '' && INBOX_REFS.has(raw);
}

/** 便签作用域：一次写入的落点（项目便签 或 全局 Inbox 便签） */
export interface StickyScope {
  /** 便签文件所在根目录（项目路径 / 应用根目录） */
  root: string;
  /** 项目 id；Inbox 时为 null（便签无项目归属） */
  projectId: string | null;
  /** 显示名：项目名 / 'Todo Inbox'（默认便签标题、聚合分组名） */
  projectName: string;
  /** 是否全局 Inbox（未立项的临时待办） */
  isInbox: boolean;
  /** 日历事件归属 project_id：项目 id / '__global__'（供 sticky-calendar-sync 建事件用） */
  calendarProjectId: string;
  /** 日历事件 scope：Inbox → 'global'，其余 → 'project' */
  calendarScope: 'project' | 'global';
}

/** 构造全局 Inbox 作用域（app root 当 pseudo-project root 用） */
function inboxScope(): StickyScope {
  return {
    root: resolveAppRoot(),
    projectId: null,
    projectName: TODO_INBOX_NAME,
    isInbox: true,
    calendarProjectId: GLOBAL_SCOPE_PROJECT_ID,
    calendarScope: 'global',
  };
}

/** 由真实项目配置构造作用域 */
function projectScope(p: { id: string; name: string; path: string }): StickyScope {
  return {
    root: p.path,
    projectId: p.id,
    projectName: p.name || p.id,
    isInbox: false,
    calendarProjectId: p.id,
    calendarScope: 'project',
  };
}

/**
 * 解析便签写入落点：
 *   1) 显式 project_id 有效 → 该项目；
 *   2) project_id 是 Inbox 哨兵（'__inbox__' / '__global__'）→ 全局 Inbox；
 *   3) 未指定 → 当前激活项目；
 *   4) 无激活项目 → 全局 Inbox（不再抛 NO_PROJECT —— 未立项的临时待办有处可去）。
 * @param projectId 项目 id 或 Inbox 哨兵；缺省 = 未指定（走当前项目 / Inbox 兜底）
 */
export async function resolveStickyScope(projectId?: string | null): Promise<StickyScope> {
  if (projectId === INBOX_PROJECT_ID || projectId === GLOBAL_SCOPE_PROJECT_ID) {
    return inboxScope();
  }
  if (projectId) {
    try {
      return projectScope(await getProjectById(projectId));
    } catch {
      // 无效 project_id → 与未指定同口径（回退当前项目 / Inbox），不再直接失败
    }
  }
  try {
    return projectScope(await getCurrentProject());
  } catch {
    return inboxScope();
  }
}

/** 判断某项目引用（便签项定位 / 分组标签）是否指向全局 Inbox */
export function isInboxProjectId(projectId?: string | null): boolean {
  return projectId === INBOX_PROJECT_ID || projectId === GLOBAL_SCOPE_PROJECT_ID;
}
