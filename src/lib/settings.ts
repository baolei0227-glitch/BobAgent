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
import type { McpServerConfig } from './mcp/types';
import { MCP_PRESETS } from './mcp/types';

// ============================================================
// 接口定义 — 所有全局设置集中于此
// ============================================================

export interface VisionSettings {
  defaultProvider?: string;
  defaultModel?: string;
  apiKey?: string;
  baseUrl?: string;
  /** 辅助视觉模型：主模型失败时自动切换 */
  auxiliaryProvider?: string;
  auxiliaryModel?: string;
  auxiliaryApiKey?: string;
  auxiliaryBaseUrl?: string;
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

/** 自定义工具定义：用户注册的 HTTP 工具，AI 可通过 function calling 调用 */
export interface CustomToolDef {
  /** 工具名称，需为合法函数名（如 get_weather） */
  name: string;
  /** 工具描述，AI 根据此描述决定是否调用 */
  description: string;
  /** HTTP endpoint URL */
  endpoint: string;
  /** HTTP 方法，默认 POST */
  method?: 'GET' | 'POST';
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** JSON Schema 参数定义 */
  parameters?: Record<string, unknown>;
  /** 是否启用 */
  enabled: boolean;
  /** 最大输出长度（字符），默认 5000 */
  maxOutput?: number;
  /** 请求超时（毫秒），默认 30000 */
  timeoutMs?: number;
}

export interface AppSettings {
  version: number;
  providers: ProviderConfig[];
  search: SearchConfig;
  vision: VisionSettings;
  taskModel: TaskModelSettings;
  textEditModel: TaskModelSettings;
  ui: UISettings;
  general: GeneralSettings;
  textPresets: TextPreset[];
  customTools: CustomToolDef[];
  mcpServers: McpServerConfig[];
}

export interface TextPreset {
  name: string;
  prompt: string;
  children?: TextPreset[]; // 子预设，有则展开二级菜单
}

const DEFAULT_PRESETS: TextPreset[] = [
  // 内容加工
  { name: '精简', prompt: '精简：删除冗余表述，保留核心信息，使文字更紧凑有力。' },
  { name: '润色', prompt: '润色：改善表达，优化措辞，使文字更流畅优雅，不改变原意。' },
  { name: '扩写', prompt: '扩写：在保持原意的基础上丰富细节，使内容更充实。' },
  { name: '修正错别字', prompt: '修正所有错别字、语法错误和标点符号问题，不改变其他内容。' },
  // 图表生成
  {
    name: '图表',
    prompt: '',
    children: [
      { name: '表格', prompt: '将以下内容转为整洁的 HTML 表格，表头加粗居中，数据行交替浅灰背景，边框简洁。' },
      { name: '流程图', prompt: '将以下流程描述转为 Mermaid flowchart 代码，节点用中文，方向自上而下(TD)。只输出 ```mermaid 代码块。' },
      { name: '时序图', prompt: '将以下交互描述转为 Mermaid sequenceDiagram 代码，参与者用中文。只输出 ```mermaid 代码块。' },
      { name: '列表', prompt: '提取关键信息生成嵌套的 HTML 无序列表，层级清晰，要点加粗。' },
    ],
  },
  // 格式重组
  { name: '总结摘要', prompt: '提取核心要点，生成简洁摘要，不超过原文的三分之一。' },
  { name: '列表化', prompt: '将段落内容重组为清晰的要点列表（bullet points），每条一行，简洁明了。' },
  { name: '学术风格', prompt: '将文字改写为学术论文风格，用词严谨规范，逻辑清晰，避免口语化表达。' },
  { name: '技术文档', prompt: '将文字改写为技术文档风格，准确、简洁、无歧义，适合开发者阅读。' },
  // 语言转换
  { name: '翻译为英文', prompt: '将以下中文翻译为英文，保持专业语气。' },
  { name: '翻译为中文', prompt: '将以下英文翻译为中文，保持专业语气。' },
  { name: '正式语气', prompt: '将文字改写为正式、专业的语气，适合商务场合。' },
  { name: '口语化', prompt: '将文字改写为自然、口语化的表达。' },
];

/** 默认设置 */
export function defaultSettings(): AppSettings {
  return {
    version: 1,
    providers: [],
    search: { apiKey: '', baseUrl: '' },
    vision: {},
    taskModel: {},
    textEditModel: {},
    ui: { sidebarCollapsed: false },
    general: { language: 'zh-CN' },
    textPresets: [...DEFAULT_PRESETS],
    customTools: [],
    mcpServers: [...MCP_PRESETS],
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

/** 更新 textEditModel（文本编辑模型）并保存 */
export async function updateTextEditModel(textEditModel: TaskModelSettings): Promise<void> {
  const settings = await loadSettings();
  settings.textEditModel = textEditModel;
  await saveSettings(settings);
}

/** 更新 ui 并保存 */
export async function updateUI(ui: Partial<UISettings>): Promise<void> {
  const settings = await loadSettings();
  settings.ui = { ...settings.ui, ...ui };
  await saveSettings(settings);
}

/** 获取文本编辑预设提示词 */
export async function getTextPresets(): Promise<TextPreset[]> {
  const settings = await loadSettings();
  return settings.textPresets || [];
}

/** 更新文本编辑预设提示词 */
export async function updateTextPresets(presets: TextPreset[]): Promise<void> {
  const settings = await loadSettings();
  settings.textPresets = presets;
  await saveSettings(settings);
}

/** 更新自定义工具列表并保存 */
export async function updateCustomTools(tools: CustomToolDef[]): Promise<void> {
  const settings = await loadSettings();
  settings.customTools = tools;
  await saveSettings(settings);
}

/** 更新 MCP 服务器列表并保存 */
export async function updateMcpServers(servers: McpServerConfig[]): Promise<void> {
  const settings = await loadSettings();
  settings.mcpServers = servers;
  await saveSettings(settings);
}
