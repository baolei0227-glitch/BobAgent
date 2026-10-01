/**
 * 项目引用解析 —— Butler 写类工具的「项目归属」运行时收口。
 *
 * 背景：create_scheduled_todo / create_sticky_note / project_plan_* 原先一律走
 * getCurrentProject() / getProjectRootPath()，用户没点名项目时会**静默**写入"当前激活项目"，
 * 模型看不到落点，于是反复「建→撤→建」。现在的口径是「显式优先 + 兜底可见」：
 * 用户点名项目就按名字解析；没点名就落当前激活项目，但必须在工具回执里回显 project_source，
 * 让模型和用户都能立刻看出写偏（不再靠静默猜测）。
 *
 * 本模块把「项目引用」解析成真实项目，并承担硬校验：
 *   - 空引用            → project_required（交给 resolveProjectWithFallback 兜底当前项目）
 *   - 哨兵（当前项目）  → 仅当用户明确说"当前项目/这个项目"时才应传；无激活项目 → no_current_project
 *   - id / 名称精确匹配 → 只匹配**活跃**项目（archived / trashed / hidden 不写）
 *   - 基名匹配（去掉 createProject 追加的日期后缀）→ 用户只说「余靖潘案」也能命中「余靖潘案_20260927」
 *   - 同名多命中 / 未命中 → project_ambiguous / project_not_found（附候选，供模型回问，绝不猜测）
 *
 * 依赖以 deps 注入（默认走 project-manager），便于纯单测，避免测试触达文件系统。
 */
import { getCurrentProject, listProjects } from '@/lib/project/project-manager';

/** 解析结果里的项目最小契约（id / 显示名 / 磁盘路径） */
export interface ResolvedProjectRef {
  id: string;
  name: string;
  path: string;
}

export type ResolvedProjectResult =
  | { ok: true; project: ResolvedProjectRef; via: 'current' | 'id' | 'name' }
  | {
      ok: false;
      error: 'project_required' | 'no_current_project' | 'project_not_found' | 'project_ambiguous';
      message: string;
      candidates?: { id: string; name: string }[];
    };

export interface ProjectLookupDeps {
  /** 活跃项目（archived / trashed / hidden 均不在内） */
  listActiveProjects: () => Promise<ResolvedProjectRef[]>;
  /** 当前激活项目；无项目时抛错 */
  getCurrent: () => Promise<ResolvedProjectRef>;
}

/** 用户明确指代"当前项目"时可传的哨兵值（精确匹配，大小写不敏感） */
const SENTINELS = new Set([
  'current',
  'current project',
  'this project',
  '当前项目',
  '当前',
  '本项目',
  '这个项目',
]);

/** 候选项目列表上限（避免错误信息过长） */
const MAX_CANDIDATES = 20;

const PROJECT_REQUIRED_MESSAGE =
  '未指定项目：请先向用户确认要写入哪个项目（项目名或 ID）；仅当用户明确说"当前项目 / 这个项目"时才可传 "current"。不要猜测，不要默认当前项目。';

function toRef(p: { id: string; name: string; path: string }): ResolvedProjectRef {
  return { id: p.id, name: p.name, path: p.path };
}

/** 去掉 createProject 追加的日期后缀（`_YYYYMMDD` / `-YYYYMMDD`），得到项目基名 */
function baseNameOf(name: string): string {
  return name.trim().replace(/[_-]\d{8}$/, '');
}

/** 默认依赖：真实项目库 */
export const defaultProjectLookupDeps: ProjectLookupDeps = {
  listActiveProjects: async () => (await listProjects()).active_projects.map(toRef),
  getCurrent: async () => toRef(await getCurrentProject()),
};

/**
 * 把用户口中的项目引用解析成真实项目。
 * @param ref 项目 id / 名称 / "current" 哨兵；空值 = 用户未提及项目
 */
export async function resolveExplicitProject(
  ref: string | undefined | null,
  deps: ProjectLookupDeps = defaultProjectLookupDeps,
): Promise<ResolvedProjectResult> {
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (!raw) {
    return { ok: false, error: 'project_required', message: PROJECT_REQUIRED_MESSAGE };
  }

  if (SENTINELS.has(raw.toLowerCase())) {
    try {
      return { ok: true, project: await deps.getCurrent(), via: 'current' };
    } catch {
      return {
        ok: false,
        error: 'no_current_project',
        message:
          '用户说的"当前项目"不存在（应用当前没有激活项目）。请让用户先在 BobWork 中激活或选择一个项目，再确认要写入哪个项目。',
      };
    }
  }

  const active = await deps.listActiveProjects();

  const byId = active.find((p) => p.id === raw);
  if (byId) return { ok: true, project: byId, via: 'id' };

  const nameKey = raw.toLowerCase();
  const named = active.filter((p) => p.name.trim().toLowerCase() === nameKey);
  if (named.length === 1) return { ok: true, project: named[0], via: 'name' };
  if (named.length > 1) {
    return {
      ok: false,
      error: 'project_ambiguous',
      message: `有多个同名项目都叫「${raw}」，无法确定写入哪一个。请让用户确认具体项目（或改用项目 ID）。`,
      candidates: named.slice(0, MAX_CANDIDATES).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  // 基名兜底：用户只说了项目基名（未带日期后缀）时，匹配 createProject 生成的 `<基名>_YYYYMMDD`。
  // 仅当引用本身不含日期后缀才启用——用户给了明确日期就必须精确命中，不得跨日期乱配。
  if (!/[_-]\d{8}$/.test(raw)) {
    const byBase = active.filter((p) => baseNameOf(p.name).toLowerCase() === nameKey);
    if (byBase.length === 1) return { ok: true, project: byBase[0], via: 'name' };
    if (byBase.length > 1) {
      return {
        ok: false,
        error: 'project_ambiguous',
        message: `有多个项目的基名都叫「${raw}」（仅日期后缀不同），无法确定写入哪一个。请让用户确认具体项目（或改用项目 ID）。`,
        candidates: byBase.slice(0, MAX_CANDIDATES).map((p) => ({ id: p.id, name: p.name })),
      };
    }
  }

  const available = active.map((p) => p.name).join('、');
  return {
    ok: false,
    error: 'project_not_found',
    message: `未找到项目「${raw}」（只匹配当前活跃项目）。请让用户确认项目名。可选：${available || '（当前没有活跃项目）'}。`,
    candidates: active.slice(0, MAX_CANDIDATES).map((p) => ({ id: p.id, name: p.name })),
  };
}

/** 项目落点来源（随工具回执回传，让"写偏"可见）：
 *   explicit         用户点名了项目（id / 名称）
 *   current_explicit 用户明确说"当前项目 / 这个项目"
 *   current_fallback 用户未提及项目 → 自动落到当前激活项目
 *   global           用户未提及项目且当前无激活项目 → 落全局（仅日历事件可如此） */
export type ProjectSource = 'explicit' | 'current_explicit' | 'current_fallback' | 'global';

export type ResolveProjectWithFallbackResult =
  | { ok: true; project: ResolvedProjectRef | null; source: ProjectSource }
  | { ok: false; payload: string };

const NO_ACTIVE_PROJECT_MESSAGE =
  '应用当前没有激活项目，没有可写入的项目。请让用户先在 BobWork 中激活或选择一个项目。';

/**
 * 在 resolveExplicitProject 之上加「未提及项目 → 落当前激活项目」的统一兜底（写类工具共用口径）：
 *   - 点名项目 / 显式 current                  → explicit / current_explicit
 *   - 未提及项目（空引用）或无 current 可用    → 自动落当前激活项目（current_fallback）
 *   - allowGlobal=true 且当前无激活项目        → project=null / source='global'（仅日历事件可如此）
 *   - allowGlobal=false 且当前无激活项目       → 结构化错误（无可写项目，需用户先激活）
 *   - 同名多命中 / 未找到                      → 原样返回解析错误（交模型澄清），不兜底
 */
export async function resolveProjectWithFallback(
  ref: unknown,
  opts: { allowGlobal?: boolean } = {},
  deps: ProjectLookupDeps = defaultProjectLookupDeps,
): Promise<ResolveProjectWithFallbackResult> {
  const resolved = await resolveExplicitProject(typeof ref === 'string' ? ref : undefined, deps);
  if (resolved.ok) {
    return {
      ok: true,
      project: resolved.project,
      source: resolved.via === 'current' ? 'current_explicit' : 'explicit',
    };
  }
  // 未提及项目（空引用）或"当前项目"不存在 → 兜底当前激活项目
  if (resolved.error === 'project_required' || resolved.error === 'no_current_project') {
    try {
      return { ok: true, project: await deps.getCurrent(), source: 'current_fallback' };
    } catch {
      if (opts.allowGlobal) return { ok: true, project: null, source: 'global' };
      return {
        ok: false,
        payload: JSON.stringify({
          ok: false,
          error: 'no_active_project',
          message: NO_ACTIVE_PROJECT_MESSAGE,
        }),
      };
    }
  }
  // 同名多命中 / 未找到 → 不兜底，原样交模型澄清
  return { ok: false, payload: JSON.stringify(resolved) };
}
