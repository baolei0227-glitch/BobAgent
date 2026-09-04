/**
 * 项目配置管理模块
 *
 * 管理项目列表和当前活跃项目。
 * 配置文件位于 $BOBWORK_HOME/.projects.json（默认 ~/BobWork/.projects.json）
 *
 * 文件结构：
 * <APP_ROOT>/
 * ├── .settings.json         # 全局系统设置（隐藏）
 * ├── .projects.json         # 项目列表配置（隐藏）
 * └── BobWorkspace/         # 所有项目数据（旧版目录名为 projects）
 *     ├── <项目A>/
 *     │   ├── notes-memory/         # 节点 .md 文件
 *     │   └── .project.db     # 项目数据库（隐藏，连线等）
 *     └── <项目B>/
 *         ├── notes-memory/
 *         └── .project.db
 */

import { promises as fs } from 'fs';
import { join, sep, resolve, isAbsolute, basename } from 'path';
import { homedir } from 'os';
import { resolveAppRoot, PROJECT_DB_FILENAME, TEMPLATES_DB_FILENAME, resolveProjectDbPath } from '../app-root';
import { migrateStickyNotePages } from '@/lib/sticky-notes-migrate';
import { PROJECT_TAG_LIMIT, PROJECT_NOTE_MAX } from '@/lib/types';

/** BobWork 根目录（可通过 BOBWORK_HOME 环境变量覆盖） */
const APP_ROOT = resolveAppRoot();

/** 项目数据目录名（旧版为 projects，现更名为 BobWorkspace） */
const PROJECTS_DIR_NAME = 'BobWorkspace';

/** 项目数据目录 */
const PROJECTS_DIR = join(APP_ROOT, PROJECTS_DIR_NAME);

/** 项目配置文件路径 */
const CONFIG_FILE = join(APP_ROOT, '.projects.json');

/** 默认项目 ID */
const DEFAULT_PROJECT_ID = 'default';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_accessed_at: string;
  analysis_model?: string;
  archived?: boolean;
  archived_at?: string;
  /** 隐藏项目（不显示在侧边栏项目列表，如 wanted 临时问答项目） */
  hidden?: boolean;
  /** 已移入垃圾桶（软删除）：数据仍在磁盘，可恢复；trashed 与 archived 互斥 */
  trashed?: boolean;
  trashed_at?: string;
  /** 项目分类（诉讼 / 常法 / 非诉 / 破产） */
  category?: string;
  /** 自定义标签（最多 PROJECT_TAG_LIMIT 个），显示在项目标题右侧 */
  tags?: string[];
  /** 项目备注（新建时填写，可后续修改/清空；上限 PROJECT_NOTE_MAX 字符） */
  note?: string;
}

export interface ProjectsConfig {
  /** 当前活跃项目 ID（无项目时为空字符串） */
  current_project_id: string;
  /** 所有项目列表 */
  projects: ProjectConfig[];
  /** 新建项目默认保存位置（绝对路径；为空时使用默认 BobWorkspace） */
  default_project_dir?: string;
}

/** 确保根目录存在，并处理旧数据迁移 */
export async function ensureAppRoot(): Promise<void> {
  await fs.mkdir(APP_ROOT, { recursive: true });

  // 迁移旧文件名 projects.json → .projects.json
  const oldConfigPath = join(APP_ROOT, 'projects.json');
  try {
    await fs.access(oldConfigPath);
    try { await fs.access(CONFIG_FILE); } catch {
      await fs.rename(oldConfigPath, CONFIG_FILE);
    }
  } catch { /* 旧文件不存在 */ }

  // 迁移：项目数据目录名 projects → BobWorkspace（并同步更新 .projects.json 中的 path）
  await migrateProjectsDirName();

  // 检查是否有旧数据需要迁移
  const oldDbPath = join(homedir(), 'agent.db');
  const oldNodesDir = join(homedir(), 'nodes');

  let hasOldData = false;
  try {
    await fs.access(oldDbPath);
    hasOldData = true;
  } catch { /* ignore */ }
  try {
    await fs.access(oldNodesDir);
    const files = await fs.readdir(oldNodesDir);
    if (files.some((f) => f.endsWith('.md'))) {
      hasOldData = true;
    }
  } catch { /* ignore */ }

  // 配置文件不存在则创建空配置
  try {
    await fs.access(CONFIG_FILE);
  } catch {
    if (hasOldData) {
      // 有旧数据：创建默认项目承接旧数据
      const defaultPath = join(PROJECTS_DIR, DEFAULT_PROJECT_ID);
      await fs.mkdir(join(defaultPath, 'notes-memory'), { recursive: true });
      await fs.mkdir(join(defaultPath, 'homework'), { recursive: true });

      // 迁移数据库
      const newDbPath = resolveProjectDbPath(defaultPath);
      try {
        await fs.access(oldDbPath);
        await fs.copyFile(oldDbPath, newDbPath);
      } catch { /* ignore */ }

      // 迁移 nodes
      const newNodesDir = join(defaultPath, 'notes-memory');
      try {
        await fs.access(oldNodesDir);
        const files = await fs.readdir(oldNodesDir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const oldFile = join(oldNodesDir, file);
          const newFile = join(newNodesDir, file);
          try {
            await fs.access(newFile);
          } catch {
            await fs.copyFile(oldFile, newFile);
          }
        }
      } catch { /* ignore */ }

      const now = new Date().toISOString();
      const initialConfig: ProjectsConfig = {
        current_project_id: DEFAULT_PROJECT_ID,
        projects: [
          {
            id: DEFAULT_PROJECT_ID,
            name: '默认项目',
            path: defaultPath,
            created_at: now,
            last_accessed_at: now,
          },
        ],
      };
      await writeConfig(initialConfig);
    } else {
      // 无旧数据：创建空配置
      const initialConfig: ProjectsConfig = {
        current_project_id: '',
        projects: [],
      };
      await writeConfig(initialConfig);
    }
  }
}

/** 迁移：旧项目数据目录名 projects → BobWorkspace，并同步更新 .projects.json 中所有项目的 path 前缀 */
async function migrateProjectsDirName(): Promise<void> {
  const oldDir = join(APP_ROOT, 'projects');
  const newDir = join(APP_ROOT, PROJECTS_DIR_NAME);

  // 1) 目录改名：旧目录存在、新目录不存在时才 rename，避免覆盖
  try {
    await fs.access(oldDir);
    try {
      await fs.access(newDir);
      // 新旧并存：以新目录为准，保留旧目录
    } catch {
      await fs.rename(oldDir, newDir);
    }
  } catch { /* 旧目录不存在，无需迁移 */ }

  // 2) 修正 .projects.json 中 path 的旧目录前缀（幂等，仅替换仍含旧前缀的项）
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as ProjectsConfig;
    const oldPrefix = `${sep}projects${sep}`;
    const newPrefix = `${sep}${PROJECTS_DIR_NAME}${sep}`;
    let changed = false;
    for (const p of config.projects || []) {
      if (typeof p.path === 'string' && p.path.includes(oldPrefix)) {
        p.path = p.path.split(oldPrefix).join(newPrefix);
        changed = true;
      }
    }
    if (changed) {
      await writeConfig(config);
    }
  } catch { /* 配置文件不存在或损坏，readConfig 会兜底重建 */ }
}

/** 读取配置文件 */
export async function readConfig(): Promise<ProjectsConfig> {
  await ensureAppRoot();
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as ProjectsConfig;
    // 兼容旧数据：确保字段完整
    if (!config.projects) config.projects = [];
    if (!config.current_project_id) config.current_project_id = '';
    for (const p of config.projects) {
      if (p.archived === undefined) p.archived = false;
    }
    return config;
  } catch {
    // 配置文件损坏，返回空配置
    const config: ProjectsConfig = {
      current_project_id: '',
      projects: [],
    };
    await writeConfig(config);
    return config;
  }
}

/** 写入配置文件（原子写入） */
async function writeConfig(config: ProjectsConfig): Promise<void> {
  const tmpPath = CONFIG_FILE + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  await fs.rename(tmpPath, CONFIG_FILE);
}

/** 列出所有项目（hidden 项目从 active/archived/trashed 列表中隐藏，仅保留在全量 projects 中） */
export async function listProjects(): Promise<{
  projects: ProjectConfig[];
  active_projects: ProjectConfig[];
  archived_projects: ProjectConfig[];
  trashed_projects: ProjectConfig[];
  currentId: string;
}> {
  const config = await readConfig();
  const active = config.projects.filter((p) => !p.archived && !p.hidden && !p.trashed);
  const archived = config.projects.filter((p) => p.archived && !p.hidden && !p.trashed);
  const trashed = config.projects.filter((p) => p.trashed && !p.hidden);
  return {
    projects: config.projects,
    active_projects: active,
    archived_projects: archived,
    trashed_projects: trashed,
    currentId: config.current_project_id,
  };
}

/** 获取当前活跃项目；无项目时抛出错误 */
export async function getCurrentProject(): Promise<ProjectConfig> {
  const config = await readConfig();
  const activeProjects = config.projects.filter((p) => !p.archived && !p.trashed);
  if (!config.current_project_id || activeProjects.length === 0) {
    throw new Error('NO_PROJECT');
  }
  let current = config.projects.find((p) => p.id === config.current_project_id);
  // 当前项目已归档或已移入垃圾桶：自动切换到第一个活跃项目
  if (current && (current.archived || current.trashed)) {
    const firstActive = activeProjects[0];
    if (firstActive) {
      await switchProject(firstActive.id);
      current = firstActive;
    } else {
      throw new Error('NO_PROJECT');
    }
  }
  if (!current) {
    // 当前项目不存在，回退到第一个活跃项目
    if (activeProjects.length > 0) {
      await switchProject(activeProjects[0].id);
      return activeProjects[0];
    }
    throw new Error('NO_PROJECT');
  }
  return current;
}

/** 按 ID 查找项目（不改变当前项目；找不到抛错） */
export async function getProjectById(projectId: string): Promise<ProjectConfig> {
  const config = await readConfig();
  const target = config.projects.find((p) => p.id === projectId);
  if (!target) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  return target;
}

/** 校验项目父目录合法性：返回错误信息（空串 = 通过） */
export async function validateProjectParentDir(dir: string): Promise<string> {
  if (!dir || typeof dir !== 'string') return 'Storage location is required';
  if (!isAbsolute(dir)) return 'Storage location must be an absolute path';

  const normalized = resolve(dir);
  const home = homedir();

  // 排除系统保留目录（不能作为项目父目录）
  const forbidden = new Set([
    '/',
    '/System',
    '/Applications',
    '/Library',
    '/Users',
    '/Volumes',
    '/private',
    home,
  ]);
  if (forbidden.has(normalized)) {
    return 'Storage location cannot be a system directory';
  }

  // 可写性校验：创建目录（不存在则建）并写入探针文件验证
  try {
    await fs.mkdir(normalized, { recursive: true });
    const probe = join(normalized, `.bobwork-probe-${Date.now()}`);
    await fs.writeFile(probe, '', 'utf-8');
    await fs.rm(probe, { force: true });
  } catch {
    return 'Storage location is not writable';
  }

  return '';
}

/** 创建新项目（opts.hidden = true 时不显示在侧边栏，也不抢占当前项目；默认保存位置取自 config.default_project_dir） */
export async function createProject(
  name: string,
  opts?: { hidden?: boolean; category?: string; note?: string; tags?: string[] },
): Promise<ProjectConfig> {
  const config = await readConfig();

  // 项目父目录：始终落在统一的 BobWorkspace 大文件夹内
  // （用户自定义"默认保存位置"时，在该位置下创建 BobWorkspace 子目录存放项目；未配置则用内置 BobWorkspace）
  const baseDir = config.default_project_dir
    ? resolveProjectsWorkspace(config.default_project_dir)
    : PROJECTS_DIR;

  // 确保大文件夹存在（用户选择保存位置后即可在文件系统看到 BobWorkspace 目录）
  await fs.mkdir(baseDir, { recursive: true });

  // 生成项目 ID：基于名称 + 创建日期
  // 所有新建项目统一在名称后追加 _YYYYMMDD 后缀
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const baseName = name.trim();
  const displayName = `${baseName}_${dateStr}`;
  const safeName = baseName.replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 20);
  let projectId = `${safeName}-${dateStr}`;

  // 处理同一天创建同名项目的冲突
  let counter = 1;
  while (await fs.access(join(baseDir, projectId)).then(() => true).catch(() => false)) {
    counter++;
    projectId = `${safeName}-${dateStr}_${counter}`;
  }

  // 创建项目目录
  const projectPath = join(baseDir, projectId);
  await fs.mkdir(join(projectPath, 'notes-memory'), { recursive: true });
  await fs.mkdir(join(projectPath, 'materials'), { recursive: true });
  await fs.mkdir(join(projectPath, 'homework'), { recursive: true });

  // 确保全局 wanted 目录存在（与 projects 同级）
  const wantedDir = join(APP_ROOT, 'wanted');
  try {
    await fs.access(wantedDir);
  } catch {
    await fs.mkdir(wantedDir, { recursive: true });
  }

  const now = new Date().toISOString();
  const newProject: ProjectConfig = {
    id: projectId,
    name: displayName,
    path: projectPath,
    created_at: now,
    last_accessed_at: now,
    ...(opts?.hidden ? { hidden: true } : {}),
    ...(opts?.category ? { category: opts.category } : {}),
    ...(opts?.note ? { note: opts.note.trim().slice(0, PROJECT_NOTE_MAX) } : {}),
    ...(Array.isArray(opts?.tags) && opts.tags.some((t) => t.trim())
      ? { tags: opts.tags.map((t) => t.trim()).filter(Boolean).slice(0, PROJECT_TAG_LIMIT) }
      : {}),
  };

  config.projects.push(newProject);
  // 如果是第一个项目，自动设为当前项目（隐藏项目除外，避免临时项目抢占用户当前项目）
  if (!newProject.hidden && (config.projects.length === 1 || !config.current_project_id)) {
    config.current_project_id = projectId;
  }
  await writeConfig(config);

  return newProject;
}

/** 切换当前项目 */
export async function switchProject(projectId: string): Promise<ProjectConfig> {
  const config = await readConfig();
  const target = config.projects.find((p) => p.id === projectId);
  if (!target) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  if (target.archived) {
    throw new Error('ARCHIVED_PROJECT');
  }
  if (target.trashed) {
    throw new Error('TRASHED_PROJECT');
  }

  // 确保项目目录存在
  await fs.mkdir(join(target.path, 'notes-memory'), { recursive: true });
  await fs.mkdir(join(target.path, 'homework'), { recursive: true });

  target.last_accessed_at = new Date().toISOString();
  config.current_project_id = projectId;
  await writeConfig(config);

  return target;
}

/** 归档项目 */
export async function archiveProject(projectId: string): Promise<ProjectConfig> {
  const config = await readConfig();
  const target = config.projects.find((p) => p.id === projectId);
  if (!target) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  if (target.archived) return target;
  if (target.trashed) {
    throw new Error('TRASHED_PROJECT');
  }

  target.archived = true;
  target.archived_at = new Date().toISOString();

  // 如果是当前项目，切换到第一个活跃项目（非归档、非垃圾桶）
  if (config.current_project_id === projectId) {
    const firstActive = config.projects.find((p) => !p.archived && !p.trashed && p.id !== projectId);
    if (firstActive) {
      config.current_project_id = firstActive.id;
      firstActive.last_accessed_at = new Date().toISOString();
    } else {
      config.current_project_id = '';
    }
  }
  await writeConfig(config);
  return target;
}

/** 取消归档项目 */
export async function unarchiveProject(projectId: string): Promise<ProjectConfig> {
  const config = await readConfig();
  const target = config.projects.find((p) => p.id === projectId);
  if (!target) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  if (!target.archived) return target;

  target.archived = false;
  delete target.archived_at;
  await writeConfig(config);
  return target;
}

/** 获取项目统计（节点数 + 数据库大小 + 天龄） */
export async function getProjectStats(projectId: string): Promise<{ nodeCount: number; dbSizeKB: number; createdDaysAgo: number }> {
  const config = await readConfig();
  const target = config.projects.find((p) => p.id === projectId);
  if (!target) throw new Error(`项目不存在: ${projectId}`);

  let nodeCount = 0;
  try {
    const files = await fs.readdir(join(target.path, 'notes-memory'));
    nodeCount = files.filter((f) => f.endsWith('.md')).length;
  } catch { /* notes-memory 文件夹不存在 */ }

  let dbSizeKB = 0;
  try {
    const st = await fs.stat(resolveProjectDbPath(target.path));
    dbSizeKB = Math.round(st.size / 1024);
  } catch { /* db 不存在 */ }

  let createdDaysAgo = 0;
  try {
    const created = new Date(target.created_at).getTime();
    createdDaysAgo = Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)));
  } catch { /* ignore */ }

  return { nodeCount, dbSizeKB, createdDaysAgo };
}

/**
 * 软删除项目（移入垃圾桶）：数据保留在磁盘，可从垃圾桶恢复。
 *  - 先兜底迁移便签 note 页到全局笔记库（笔记独立于项目）
 *  - 标记 trashed（与 archived 互斥），不移除配置条目、不删文件夹
 *  - 删除的是当前项目时自动切换到第一个活跃项目
 */
export async function deleteProject(projectId: string): Promise<ProjectConfig> {
  const config = await readConfig();

  const idx = config.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  const project = config.projects[idx];

  // 移入垃圾桶前兜底迁移：把仍残留在该项目 sticky-notes.json 中的 note 页（kind='note'）
  // 迁入全局笔记库 notebook.json，实现"笔记独立于项目"——即使彻底删除也不丢笔记。
  try {
    const res = await migrateStickyNotePages(project.path);
    if (res.migrated > 0) {
      console.log(
        `[project-trash] 移入垃圾桶前迁移 ${res.migrated} 条便签笔记到全局笔记库（项目: ${project.id}）`,
      );
    }
  } catch (e) {
    console.warn('移入垃圾桶前便签笔记迁移失败:', e instanceof Error ? e.message : String(e));
  }

  project.trashed = true;
  project.trashed_at = new Date().toISOString();
  delete project.archived;

  // 如果删除的是当前项目：切换到第一个活跃项目（非归档、非垃圾桶、非隐藏）
  if (config.current_project_id === projectId) {
    const firstActive = config.projects.find((p) => !p.archived && !p.trashed && !p.hidden);
    if (firstActive) {
      config.current_project_id = firstActive.id;
      firstActive.last_accessed_at = new Date().toISOString();
    } else {
      config.current_project_id = '';
    }
  }

  await writeConfig(config);
  return project;
}

/** 从垃圾桶恢复项目（取消软删除标记） */
export async function restoreProject(projectId: string): Promise<ProjectConfig> {
  const config = await readConfig();
  const target = config.projects.find((p) => p.id === projectId);
  if (!target) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  if (!target.trashed) return target;

  target.trashed = false;
  delete target.trashed_at;
  // 恢复后若没有当前项目，自动设为当前项目
  if (!config.current_project_id) {
    config.current_project_id = projectId;
  }
  await writeConfig(config);
  return target;
}

/**
 * 彻底删除项目（不可恢复）：与旧 deleteProject 行为一致。
 *  - 删除前仍兜底迁移便签 note 页到全局笔记库（防丢笔记）
 *  - 删除项目文件夹 + 移除配置条目（无回收站，谨慎调用）
 */
export async function purgeProject(projectId: string): Promise<void> {
  const config = await readConfig();

  const idx = config.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  const project = config.projects[idx];

  // 彻底删除前兜底迁移便签 note 页（与软删除一致，防丢笔记）
  try {
    const res = await migrateStickyNotePages(project.path);
    if (res.migrated > 0) {
      console.log(
        `[project-purge] 删除前迁移 ${res.migrated} 条便签笔记到全局笔记库（项目: ${project.id}）`,
      );
    }
  } catch (e) {
    console.warn('彻底删除前便签笔记迁移失败:', e instanceof Error ? e.message : String(e));
  }

  // 删除项目文件夹
  try {
    await fs.rm(project.path, { recursive: true, force: true });
  } catch (e) {
    // 文件夹删除失败不阻止项目记录删除
    console.warn('项目文件夹删除失败:', e instanceof Error ? e.message : String(e));
  }

  // 联动清理：项目被彻底删除（不可恢复）→ 清理该项目全部 md-annotations sidecar。
  // 动态 import 避免 project-manager ↔ md-annotations-cleanup 顶层循环依赖。
  try {
    const { cleanupMdAnnotationSidecars } = await import('@/lib/md-annotations-cleanup');
    await cleanupMdAnnotationSidecars({ projectIds: [projectId] }).catch(() => {});
  } catch { /* sidecar 清理失败不阻断项目删除 */ }

  config.projects.splice(idx, 1);

  // 如果删除的是当前项目
  if (config.current_project_id === projectId) {
    const firstActive = config.projects.find((p) => !p.archived && !p.trashed && !p.hidden);
    if (firstActive) {
      config.current_project_id = firstActive.id;
      firstActive.last_accessed_at = new Date().toISOString();
    } else {
      config.current_project_id = '';
    }
  }

  await writeConfig(config);
}

/** 重命名项目（仅修改显示名称，不改变文件夹路径） */
export async function renameProject(projectId: string, newName: string): Promise<ProjectConfig> {
  const config = await readConfig();
  const target = config.projects.find((p) => p.id === projectId);
  if (!target) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  target.name = newName.trim();
  await writeConfig(config);

  return target;
}

/** 更新项目元信息（分类 / 自定义标签 / 备注）：仅修改配置条目，不影响磁盘文件 */
export async function updateProjectMeta(
  projectId: string,
  meta: { category?: string; tags?: string[]; note?: string },
): Promise<ProjectConfig> {
  const config = await readConfig();
  const target = config.projects.find((p) => p.id === projectId);
  if (!target) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  if (meta.category !== undefined) {
    const cat = meta.category.trim();
    if (cat) target.category = cat;
    else delete target.category;
  }
  if (Array.isArray(meta.tags)) {
    const cleaned = meta.tags.map((t) => t.trim()).filter(Boolean).slice(0, PROJECT_TAG_LIMIT);
    if (cleaned.length > 0) target.tags = cleaned;
    else delete target.tags;
  }
  if (meta.note !== undefined) {
    const note = meta.note.trim().slice(0, PROJECT_NOTE_MAX);
    if (note) target.note = note;
    else delete target.note;
  }
  await writeConfig(config);

  return target;
}

/** 获取项目路径 */
export async function getProjectPath(projectId: string): Promise<string> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  return project.path;
}

/** 获取根目录路径 */
export function getAppRoot(): string {
  return APP_ROOT;
}

/** 获取项目数据目录路径 */
export function getProjectsDir(): string {
  return PROJECTS_DIR;
}

/** 需要参与磁盘对账的工作区大文件夹列表：内置 BobWorkspace + 自定义默认目录（若配置过）。
 *  注意：用户切换过默认保存位置后，新旧两个工作区可能同时存在项目，都要扫描。 */
export async function getProjectWorkspaceDirs(): Promise<string[]> {
  const config = await readConfig();
  const dirs = new Set<string>([PROJECTS_DIR]);
  if (config.default_project_dir) {
    dirs.add(resolveProjectsWorkspace(config.default_project_dir));
  }
  return [...dirs];
}

/** 磁盘对账（项目列表实时跟随磁盘变化）：
 *  - 扫描工作区大文件夹，把手动放入（如从 Finder 拖入）的目录自动注册为项目；
 *    项目 id = 目录名（与 createProject 的约定一致：目录名即 id），name = 目录名，
 *    并补齐 notes-memory/materials/homework 标准子目录使其可直接使用。
 *  - 目录已从磁盘消失的项目自动移入垃圾桶（软删除，可在侧边栏 Trash 恢复/彻底删除）。
 *  - 目录重新出现且原本已入垃圾桶的项目自动复活。
 *  并发去重：同时只执行一次（fs.watch 事件风暴 / GET 并发触发时合并），返回是否有变更。 */
export function syncProjectsFromDisk(): Promise<boolean> {
  if (!syncInFlight) {
    syncInFlight = doSyncProjectsFromDisk().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

let syncInFlight: Promise<boolean> | null = null;

/** 内存态标记：记录"因目录从磁盘消失而被自动移入垃圾桶"的项目 id。
 *  仅这类项目在目录重新出现时自动复活；UI 软删除（目录仍在磁盘）不自动复活。 */
const diskDeletedIds = new Set<string>();

async function doSyncProjectsFromDisk(): Promise<boolean> {
  const config = await readConfig();
  let changed = false;
  const now = new Date().toISOString();

  const workspaces = await getProjectWorkspaceDirs();
  const knownPaths = new Set(config.projects.map((p) => p.path));

  for (const workspaceDir of workspaces) {
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
    } catch {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      // 只认直接子目录，跳过隐藏目录（内部数据目录/系统文件）
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dirPath = join(workspaceDir, entry.name);

      // 已登记（id 即目录名）→ 自愈：目录位置漂移以磁盘为准；因磁盘删除入桶且目录重现则复活
      const byId = config.projects.find((p) => p.id === entry.name);
      if (byId) {
        if (byId.trashed && diskDeletedIds.has(byId.id)) {
          byId.trashed = false;
          delete byId.trashed_at;
          byId.path = dirPath;
          byId.last_accessed_at = now;
          diskDeletedIds.delete(byId.id);
          changed = true;
          console.log(`[project-sync] 工作区目录重新出现，自动恢复项目: ${entry.name}`);
        } else if (byId.path !== dirPath) {
          byId.path = dirPath;
          changed = true;
        }
        continue;
      }

      if (knownPaths.has(dirPath)) continue;

      // 全新目录 → 注册为新项目，补齐标准子目录
      try {
        await fs.mkdir(join(dirPath, 'notes-memory'), { recursive: true });
        await fs.mkdir(join(dirPath, 'materials'), { recursive: true });
        await fs.mkdir(join(dirPath, 'homework'), { recursive: true });
      } catch {
        continue; // 目录不可写则跳过，下轮对账再试
      }
      config.projects.push({
        id: entry.name,
        name: entry.name,
        path: dirPath,
        created_at: now,
        last_accessed_at: now,
      });
      knownPaths.add(dirPath);
      changed = true;
      console.log(`[project-sync] 检测到工作区新目录，注册为项目: ${entry.name}`);
    }
  }

  // 目录已从磁盘消失的项目 → 移入垃圾桶（hidden 为内部临时项目，不处理）
  for (const p of config.projects) {
    if (p.hidden || p.trashed) continue;
    if (await pathMissing(p.path)) {
      p.trashed = true;
      p.trashed_at = now;
      delete p.archived;
      diskDeletedIds.add(p.id);
      changed = true;
      console.log(`[project-sync] 项目目录已从磁盘消失，移入垃圾桶: ${p.id}`);
    }
  }

  // 清理失效标记：已复活 / 已由 UI 恢复 / 已彻底删除的项目不再保留
  for (const id of [...diskDeletedIds]) {
    const p = config.projects.find((x) => x.id === id);
    if (!p || !p.trashed) diskDeletedIds.delete(id);
  }

  if (changed) await writeConfig(config);
  return changed;
}

/** 路径是否已不存在 */
async function pathMissing(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return false;
  } catch {
    return true;
  }
}

/** 由用户选择的存储位置解析出统一的项目大文件夹（BobWorkspace）路径。
 *  用户选择的是"大文件夹所在的位置"：
 *    - 用户所选目录本身叫 BobWorkspace → 直接作为项目大文件夹（避免双重嵌套）；
 *    - 否则在其下创建 /BobWorkspace 子目录，作为项目大文件夹。
 */
function resolveProjectsWorkspace(location: string): string {
  const resolved = resolve(location);
  if (basename(resolved) === PROJECTS_DIR_NAME) return resolved;
  return join(resolved, PROJECTS_DIR_NAME);
}

export async function getDefaultProjectDir(): Promise<string> {
  const config = await readConfig();
  if (config.default_project_dir) return resolveProjectsWorkspace(config.default_project_dir);
  return PROJECTS_DIR;
}

/** 设置新建项目的默认保存位置（写入前需调用方完成 validateProjectParentDir 校验）；
 *  统一落在所选位置下的 BobWorkspace 大文件夹中；与内置 BobWorkspace 相同时等价于恢复默认，
 *  并立即创建大文件夹目录，让用户选完位置即可在文件系统看到。 */
export async function setDefaultProjectDir(dir: string): Promise<string> {
  const config = await readConfig();
  const projectsDir = resolveProjectsWorkspace(dir);
  if (projectsDir === PROJECTS_DIR) {
    delete config.default_project_dir;
  } else {
    config.default_project_dir = projectsDir;
  }
  // 立即创建大文件夹（项目实际创建时也会创建，这里先行建立便于用户感知统一存储位置）
  await fs.mkdir(config.default_project_dir ?? PROJECTS_DIR, { recursive: true });
  await writeConfig(config);
  return config.default_project_dir ? resolve(config.default_project_dir) : PROJECTS_DIR;
}

/** 清除自定义默认保存位置，恢复为内置 BobWorkspace（新项目重新回到统一大文件夹） */
export async function resetDefaultProjectDir(): Promise<string> {
  const config = await readConfig();
  if (config.default_project_dir !== undefined) {
    delete config.default_project_dir;
    await writeConfig(config);
  }
  return PROJECTS_DIR;
}

/** 是否已自定义默认保存位置（false = 使用内置 BobWorkspace） */
export async function isCustomDefaultProjectDir(): Promise<boolean> {
  const config = await readConfig();
  return config.default_project_dir !== undefined;
}

const DEFAULT_ANALYSIS_MODEL = 'gpt-4o-mini';

export async function getProjectAnalysisModel(projectId: string): Promise<string> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  return project?.analysis_model ?? DEFAULT_ANALYSIS_MODEL;
}

export async function setProjectAnalysisModel(
  projectId: string,
  modelId: string
): Promise<void> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  project.analysis_model = modelId;
  await writeConfig(config);
}
