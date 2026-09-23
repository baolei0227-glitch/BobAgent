/**
 * 项目引用只读访问（轻量、无反向依赖）
 *
 * 为什么独立于 project-manager：
 *   md-annotations-cleanup / mcp manager / sticky-notes-migrate 都需要「项目 id → 路径」映射，
 *   而 project-manager 又反向引用这些模块（静态或动态 import），直接互相引用会形成
 *   import/no-cycle。本模块只读 <APP_ROOT>/.projects.json，导出最小 ProjectRef 视图，
 *   且自身不引用 project-manager，是依赖链上的死路，用于打断上述循环。
 *
 * 与 project-manager.readConfig 的差异：
 *   这里只做纯读取（不触发 ensureAppRoot 迁移/写盘）——调用方均只关心已有项目的 id/path，
 *   配置缺失时返回空结果即可，避免只读路径产生副作用。
 */
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { resolveAppRoot } from '../app-root';

const APP_ROOT = resolveAppRoot();
const CONFIG_FILE = join(APP_ROOT, '.projects.json');
/** 旧版配置文件名（尚未迁移时兜底） */
const LEGACY_CONFIG_FILE = join(APP_ROOT, 'projects.json');

/** 项目最小视图：id + 已 resolve 的绝对路径 */
export interface ProjectRef {
  id: string;
  path: string;
}

interface RawProject {
  id?: unknown;
  path?: unknown;
  archived?: unknown;
  trashed?: unknown;
}

interface RawConfig {
  current_project_id?: unknown;
  projects?: unknown;
}

/** 读取原始配置（新文件名优先，旧文件名兜底）；缺失/损坏返回 null */
async function readRawConfig(): Promise<RawConfig | null> {
  for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(content) as RawConfig;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 尝试下一个候选路径 */ }
  }
  return null;
}

/** 把原始项目条目收窄为合法的 ProjectRef（非法条目跳过） */
function toRef(p: RawProject | undefined): ProjectRef | null {
  if (!p || typeof p.id !== 'string' || typeof p.path !== 'string' || !p.path) return null;
  return { id: p.id, path: resolve(p.path) };
}

/** 读取全部项目引用（含归档/垃圾桶/隐藏）；配置缺失时返回空数组 */
export async function readProjectRefs(): Promise<ProjectRef[]> {
  const config = await readRawConfig();
  if (!config || !Array.isArray(config.projects)) return [];
  const refs: ProjectRef[] = [];
  for (const p of config.projects as RawProject[]) {
    const ref = toRef(p);
    if (ref) refs.push(ref);
  }
  return refs;
}

/** 当前活跃项目的引用；无活跃项目、或当前项目已归档/移入垃圾桶且无其它活跃项目时返回 null */
export async function getCurrentProjectRef(): Promise<ProjectRef | null> {
  const config = await readRawConfig();
  if (!config || !Array.isArray(config.projects)) return null;
  const projects = config.projects as RawProject[];
  if (typeof config.current_project_id !== 'string' || !config.current_project_id) return null;

  const current = projects.find((p) => p && p.id === config.current_project_id);
  // 当前项目可用则直接返回；否则回退到第一个活跃项目（与 getCurrentProject 的兜底一致）
  const picked = current && !current.archived && !current.trashed
    ? current
    : projects.find((p) => p && !p.archived && !p.trashed);
  return toRef(picked);
}