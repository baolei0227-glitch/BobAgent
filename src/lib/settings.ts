/**
 * 统一应用设置模块
 *
 * 所有全局设置存储于 ~/BobAgent/settings.json：
 *   Electron: 主进程通过 IPC 读写文件
 *   浏览器(dev): 降级为 localStorage
 *
 * 扩展方式：只需在 AppSettings 接口中加字段即可。
 *
 * 注意：此模块前端和后端共用。Node.js 文件 I/O 使用动态 import，
 * 避免在浏览器环境中加载 fs/path/os 模块。
 */

import type { ProviderConfig, SearchConfig } from './types';

// ============================================================
// 接口定义 — 所有全局设置集中于此
// ============================================================

export interface VisionSettings {
  defaultProvider?: string;
  defaultModel?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** 任务归纳小模型配置（与视觉模型同结构） */
export interface TaskModelSettings {
  defaultProvider?: string;
  defaultModel?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface UISettings {
  sidebarCollapsed: boolean;
}

export interface GeneralSettings {
  language: string;
}

export interface AppSettings {
  version: number;
  providers: ProviderConfig[];
  search: SearchConfig;
  vision: VisionSettings;
  taskModel: TaskModelSettings;
  ui: UISettings;
  general: GeneralSettings;
}

/** 默认设置 */
export function defaultSettings(): AppSettings {
  return {
    version: 1,
    providers: [],
    search: { apiKey: '', baseUrl: '' },
    vision: {},
    taskModel: {},
    ui: { sidebarCollapsed: false },
    general: { language: 'zh-CN' },
  };
}

// ============================================================
// 运行时检测
// ============================================================

let _hasElectronAPI: boolean | null = null;
function hasElectronAPI(): boolean {
  if (_hasElectronAPI !== null) return _hasElectronAPI;
  _hasElectronAPI =
    typeof window !== 'undefined' &&
    !!(window as unknown as Record<string, unknown>).desktopAPI;
  return _hasElectronAPI;
}

/** 获取 Electron settings IPC API */
function electronSettingsApi(): { load: () => Promise<AppSettings | null>; save: (s: AppSettings) => Promise<void> } {
  return (window as unknown as { api: { settings: { load: () => Promise<AppSettings | null>; save: (s: AppSettings) => Promise<void> } } }).api.settings;
}

// ============================================================
// 客户端统一入口 — 自动选择 IPC 或 localStorage
// ============================================================

const LS_KEY = 'bob-agent-settings';

function readFromLocalStorage(): AppSettings {
  if (typeof window === 'undefined') return defaultSettings();
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...defaultSettings(), ...parsed, version: parsed.version ?? 1 };
  } catch {
    return defaultSettings();
  }
}

function writeToLocalStorage(settings: AppSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_KEY, JSON.stringify(settings));
}

/**
 * 读取全局设置（前端调用）
 */
export async function loadSettings(): Promise<AppSettings> {
  if (hasElectronAPI()) {
    try {
      const api = electronSettingsApi();
      const result = await api.load();
      if (result) return { ...defaultSettings(), ...result };
    } catch {
      // IPC 失败降级
    }
  }
  return readFromLocalStorage();
}

/**
 * 保存全局设置（前端调用）
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  if (hasElectronAPI()) {
    try {
      await electronSettingsApi().save(settings);
      return;
    } catch {
      // IPC 失败降级
    }
  }
  writeToLocalStorage(settings);
}

// ============================================================
// 旧数据迁移 — localStorage → settings.json
// ============================================================

const OLD_PROVIDER_KEY = 'ai-canvas-providers';
const OLD_SEARCH_KEY = 'ai-canvas-search-config';

/** 检查旧数据并迁移 */
export async function migrateOldSettingsIfNeeded(): Promise<AppSettings | null> {
  if (typeof window === 'undefined') return null;

  const oldProviders = window.localStorage.getItem(OLD_PROVIDER_KEY);
  const oldSearch = window.localStorage.getItem(OLD_SEARCH_KEY);

  if (!oldProviders && !oldSearch) return null;

  const settings = defaultSettings();

  if (oldProviders) {
    try {
      settings.providers = JSON.parse(oldProviders) as ProviderConfig[];
    } catch { /* ignore */ }
  }

  if (oldSearch) {
    try {
      settings.search = JSON.parse(oldSearch) as SearchConfig;
    } catch { /* ignore */ }
  }

  // 保存到新位置
  await saveSettings(settings);

  // 清除旧数据
  window.localStorage.removeItem(OLD_PROVIDER_KEY);
  window.localStorage.removeItem(OLD_SEARCH_KEY);

  return settings;
}

// ============================================================
// 便捷方法 — 更新单个设置字段
// ============================================================

/** 更新 providers 并保存 */
export async function updateProviders(providers: ProviderConfig[]): Promise<void> {
  const settings = await loadSettings();
  settings.providers = providers;
  await saveSettings(settings);
}

/** 更新 search 并保存 */
export async function updateSearch(search: SearchConfig): Promise<void> {
  const settings = await loadSettings();
  settings.search = search;
  await saveSettings(settings);
}

/** 更新 vision 并保存 */
export async function updateVision(vision: VisionSettings): Promise<void> {
  const settings = await loadSettings();
  settings.vision = vision;
  await saveSettings(settings);
}

/** 更新 taskModel（任务归纳模型）并保存 */
export async function updateTaskModel(taskModel: TaskModelSettings): Promise<void> {
  const settings = await loadSettings();
  settings.taskModel = taskModel;
  await saveSettings(settings);
}

/** 更新 ui 并保存 */
export async function updateUI(ui: Partial<UISettings>): Promise<void> {
  const settings = await loadSettings();
  settings.ui = { ...settings.ui, ...ui };
  await saveSettings(settings);
}
