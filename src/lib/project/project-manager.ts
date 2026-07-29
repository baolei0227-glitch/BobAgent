/**
 * 项目配置管理模块
 *
 * 管理项目列表和当前活跃项目。
 * 配置文件位于 $BOBAGENT_HOME/.projects.json（默认 ~/BobAgent/.projects.json）
 *
 * 文件结构：
 * <APP_ROOT>/
 * ├── .settings.json         # 全局系统设置（隐藏）
 * ├── .projects.json         # 项目列表配置（隐藏）
 * └── projects/              # 所有项目数据
 *     ├── <项目A>/
 *     │   ├── nodes/         # 节点 .md 文件
 *     │   └── project.db     # 项目数据库（连线等）
 *     └── <项目B>/
 *         ├── nodes/
 *         └── project.db
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveAppRoot } from '../app-root';

/** BobAgent 根目录（可通过 BOBAGENT_HOME 环境变量覆盖） */
const APP_ROOT = resolveAppRoot();

/** 项目数据目录 */
const PROJECTS_DIR = join(APP_ROOT, 'projects');

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
  vision_model?: string;
  vision_api_key?: string;
  vision_base_url?: string;
}

export interface ProjectsConfig {
  /** 当前活跃项目 ID（无项目时为空字符串） */
  current_project_id: string;
  /** 所有项目列表 */
  projects: ProjectConfig[];
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
      await fs.mkdir(join(defaultPath, 'nodes'), { recursive: true });

      // 迁移数据库
      const newDbPath = join(defaultPath, 'project.db');
      try {
        await fs.access(oldDbPath);
        await fs.copyFile(oldDbPath, newDbPath);
      } catch { /* ignore */ }

      // 迁移 nodes
      const newNodesDir = join(defaultPath, 'nodes');
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

/** 读取配置文件 */
export async function readConfig(): Promise<ProjectsConfig> {
  await ensureAppRoot();
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as ProjectsConfig;
    // 兼容旧数据：确保字段完整
    if (!config.projects) config.projects = [];
    if (!config.current_project_id) config.current_project_id = '';
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

/** 列出所有项目 */
export async function listProjects(): Promise<{ projects: ProjectConfig[]; currentId: string }> {
  const config = await readConfig();
  return {
    projects: config.projects,
    currentId: config.current_project_id,
  };
}

/** 获取当前活跃项目；无项目时抛出错误 */
export async function getCurrentProject(): Promise<ProjectConfig> {
  const config = await readConfig();
  if (!config.current_project_id || config.projects.length === 0) {
    throw new Error('NO_PROJECT');
  }
  const current = config.projects.find((p) => p.id === config.current_project_id);
  if (!current) {
    // 当前项目不存在，回退到第一个项目
    if (config.projects.length > 0) {
      await switchProject(config.projects[0].id);
      return config.projects[0];
    }
    throw new Error('NO_PROJECT');
  }
  return current;
}

/** 创建新项目 */
export async function createProject(name: string): Promise<ProjectConfig> {
  const config = await readConfig();

  // 生成项目 ID：基于名称 + 创建日期
  const safeName = name.replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 20);
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let projectId = `${safeName}-${dateStr}`;

  // 处理同一天创建同名项目的冲突
  let counter = 1;
  while (await fs.access(join(PROJECTS_DIR, projectId)).then(() => true).catch(() => false)) {
    counter++;
    projectId = `${safeName}-${dateStr}_${counter}`;
  }

  // 创建项目目录
  const projectPath = join(PROJECTS_DIR, projectId);
  await fs.mkdir(join(projectPath, 'nodes'), { recursive: true });
  await fs.mkdir(join(projectPath, 'materials'), { recursive: true });

  const now = new Date().toISOString();
  const newProject: ProjectConfig = {
    id: projectId,
    name: name.trim(),
    path: projectPath,
    created_at: now,
    last_accessed_at: now,
  };

  config.projects.push(newProject);
  // 如果是第一个项目，自动设为当前项目
  if (config.projects.length === 1 || !config.current_project_id) {
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

  // 确保项目目录存在
  await fs.mkdir(join(target.path, 'nodes'), { recursive: true });

  target.last_accessed_at = new Date().toISOString();
  config.current_project_id = projectId;
  await writeConfig(config);

  return target;
}

/** 删除项目（连同文件夹一起删除） */
export async function deleteProject(projectId: string): Promise<void> {
  const config = await readConfig();

  const idx = config.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) {
    throw new Error(`项目不存在: ${projectId}`);
  }

  const project = config.projects[idx];

  // 删除项目文件夹
  try {
    await fs.rm(project.path, { recursive: true, force: true });
  } catch (e) {
    // 文件夹删除失败不阻止项目记录删除
    console.warn('项目文件夹删除失败:', e instanceof Error ? e.message : String(e));
  }

  config.projects.splice(idx, 1);

  // 如果删除的是当前项目
  if (config.current_project_id === projectId) {
    if (config.projects.length > 0) {
      // 还有其他项目：切换到第一个
      config.current_project_id = config.projects[0].id;
    } else {
      // 没有项目了：清空当前项目
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

const DEFAULT_ANALYSIS_MODEL = 'gpt-4o-mini';
const DEFAULT_VISION_MODEL = 'qwen-vl-max';

export async function getProjectVisionModel(projectId: string): Promise<string> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  return project?.vision_model ?? DEFAULT_VISION_MODEL;
}

export async function setProjectVisionModel(
  projectId: string,
  modelId: string
): Promise<void> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  project.vision_model = modelId;
  await writeConfig(config);
}

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

export async function getProjectVisionApiKey(projectId: string): Promise<string> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  return project?.vision_api_key ?? '';
}

export async function setProjectVisionApiKey(
  projectId: string,
  apiKey: string
): Promise<void> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  project.vision_api_key = apiKey;
  await writeConfig(config);
}

export async function getProjectVisionBaseUrl(projectId: string): Promise<string> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  return project?.vision_base_url ?? '';
}

export async function setProjectVisionBaseUrl(
  projectId: string,
  baseUrl: string
): Promise<void> {
  const config = await readConfig();
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`项目不存在: ${projectId}`);
  }
  project.vision_base_url = baseUrl;
  await writeConfig(config);
}

export async function buildVisionModelConfig(
  modelId: string,
  apiKey: string,
  storedBaseUrl?: string
): Promise<{ model: string; baseUrl?: string; apiKey: string }> {
  if (storedBaseUrl) {
    return { model: modelId, baseUrl: storedBaseUrl, apiKey };
  }
  const { getModelById, getDefaultBaseUrl } = await import('@/lib/models/config');
  const model = getModelById(modelId);
  const baseUrl = model?.baseUrl ?? getDefaultBaseUrl(model?.provider ?? 'qwen');
  return {
    model: modelId,
    baseUrl,
    apiKey,
  };
}
