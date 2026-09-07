/**
 * Wanted 模型解析：任务/成果块系列 API 共用。
 *
 * 分层回退：
 *   resolveTaskModel（通用任务层）：taskModel → 主对话(pool → 旧式直配) → 兜底厂商
 *   resolveOutcomeModel（成果块专属层）：outcomeModel → 主对话(pool → 旧式直配) → taskModel → 兜底厂商
 *
 * 说明：
 *   - taskModel：设置 → 任务模型，统管任务摘要/会议纪要/日程解析/AI 字段抽取等轻量任务，显式配置时优先
 *   - outcomeModel：设置 → 成果块模型，专供成果块（法律引用，质量敏感），默认跟随主对话模型
 */
import { PROVIDER_PRESETS, type ProviderConfig } from '@/lib/types';
import { readSettingsFromFile } from '@/lib/settings-server';
import type { TaskModelSettings } from '@/lib/settings';
import { analyzeTask } from '@/lib/model-matcher';

export interface ResolvedModel {
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** 解析厂商 baseUrl：自定义优先，否则 preset 默认 */
function baseUrlFor(providerType: string, customBaseUrl?: string): string {
  return customBaseUrl
    || PROVIDER_PRESETS.find((p) => p.type === providerType)?.baseUrl
    || '';
}

/** 从 provider 配置解析出一个可用模型（apiKey + 勾选模型 + baseUrl） */
function fromProvider(cfg: ProviderConfig, modelId?: string): ResolvedModel | null {
  if (!cfg.apiKey) return null;
  const selected = cfg.selectedModels ?? [];
  if (selected.length === 0) return null;
  const id = modelId && selected.some((m) => (typeof m === 'string' ? m : m.modelId) === modelId)
    ? modelId
    : (typeof selected[0] === 'string' ? selected[0] : selected[0].modelId);
  return {
    model: id,
    apiKey: cfg.apiKey,
    baseUrl: baseUrlFor(cfg.type, cfg.baseUrl),
  };
}

/**
 * 按 "provider:modelId" 显式指定模型：从已配置 providers 解析该供应商的 apiKey/baseUrl。
 * 供外部 HTTP 客户端（如 Bob WebBridge AI 侧边栏）显式选模型时使用；
 * 目标供应商未配置 / 无 API Key 时返回 null（调用方应给出明确错误而非悄悄降级默认模型）。
 */
export async function resolveProviderModel(providerModelId: string): Promise<ResolvedModel | null> {
  const sep = providerModelId.indexOf(':');
  if (sep <= 0) return null;
  const providerType = providerModelId.slice(0, sep).trim();
  const modelId = providerModelId.slice(sep + 1).trim();
  if (!providerType || !modelId) return null;
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = Array.isArray(settings.providers) ? settings.providers : [];
  const cfg = providers.find((p) => p.type === providerType && !!p.apiKey);
  if (!cfg) return null;
  return { model: modelId, apiKey: cfg.apiKey, baseUrl: baseUrlFor(cfg.type, cfg.baseUrl) };
}

/**
 * 按 AgentId 解析专属默认模型（settings.agentModels，P3-3b）：
 *  复用 resolveRoleModel 语义（pool 有序解析 → defaultModel 直配 → null）。
 *  供 /api/chat 兜底解析按请求 identity 优先选路；未配置返回 null（调用方回退 chatModel）。
 */
export async function resolveAgentRoleModel(agentId?: string): Promise<ResolvedModel | null> {
  if (!agentId) return null;
  const settings = await readSettingsFromFile();
  const role = settings.agentModels?.[agentId];
  if (!role) return null;
  const providers: ProviderConfig[] = Array.isArray(settings.providers) ? settings.providers : [];
  return resolveRoleModel(role, providers);
}

/** 解析单个角色模型（taskModel / outcomeModel）：pool → 旧式直配 apiKey + defaultModel */
function resolveRoleModel(role: TaskModelSettings | undefined, providers: ProviderConfig[]): ResolvedModel | null {
  if (!role) return null;
  const pool = Array.isArray(role.pool) ? role.pool : [];
  if (pool.length > 0) {
    for (const item of pool) {
      const cfg = providers.find((p) => p.type === item.provider);
      const resolved = cfg ? fromProvider(cfg, item.modelId) : null;
      if (resolved) return resolved;
    }
  }
  if (role.apiKey && role.defaultModel) {
    const providerType =
      (role.defaultProvider as string) ||
      (role.defaultModel.includes('deepseek') ? 'deepseek'
        : role.defaultModel.includes('glm') ? 'glm'
        : role.defaultModel.includes('moonshot') ? 'moonshot'
        : role.defaultModel.includes('qwen') ? 'qwen'
        : role.defaultModel.includes('doubao') ? 'doubao'
        : 'openai');
    return {
      model: role.defaultModel,
      apiKey: role.apiKey,
      baseUrl: baseUrlFor(providerType, role.baseUrl),
    };
  }
  return null;
}

/** 主对话模型解析：pool 内第一个可用条目 → 旧式直配（defaultModel + apiKey） */
function resolveMainChat(cm: TaskModelSettings | undefined, providers: ProviderConfig[]): ResolvedModel | null {
  if (!cm) return null;
  const pool = Array.isArray(cm.pool) ? cm.pool : [];
  if (pool.length > 0) {
    for (const item of pool) {
      const cfg = providers.find((p) => p.type === item.provider);
      const resolved = cfg ? fromProvider(cfg, item.modelId) : null;
      if (resolved) return resolved;
    }
  }
  if (cm.apiKey && cm.defaultModel) {
    const providerType =
      (cm.defaultProvider as string) ||
      (cm.defaultModel.includes('deepseek') ? 'deepseek'
        : cm.defaultModel.includes('glm') ? 'glm'
        : cm.defaultModel.includes('moonshot') ? 'moonshot'
        : cm.defaultModel.includes('qwen') ? 'qwen'
        : cm.defaultModel.includes('doubao') ? 'doubao'
        : 'openai');
    return {
      model: cm.defaultModel,
      apiKey: cm.apiKey,
      baseUrl: baseUrlFor(providerType, cm.baseUrl),
    };
  }
  return null;
}

/** 兜底：第一个 apiKey 非空且勾选了模型的厂商 */
function resolveProviderFallback(providers: ProviderConfig[]): ResolvedModel | null {
  for (const cfg of providers) {
    const resolved = fromProvider(cfg);
    if (resolved) return resolved;
  }
  return null;
}

/** 通用任务层：taskModel（显式配置优先）→ 主对话模型 → 兜底厂商 */
export async function resolveTaskModel(): Promise<ResolvedModel | null> {
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = Array.isArray(settings.providers) ? settings.providers : [];

  // 1) taskModel（设置 → 任务模型）：显式配置时优先，统管任务摘要/会议纪要/日程解析/AI 字段抽取等轻量任务
  const roleResolved = resolveRoleModel(settings.taskModel, providers);
  if (roleResolved) return roleResolved;

  // 2) 主对话模型（pool → 旧式直配）
  const mainResolved = resolveMainChat(settings.chatModel, providers);
  if (mainResolved) return mainResolved;

  // 3) 兜底：第一个可用厂商
  return resolveProviderFallback(providers);
}

/** 成果块专属层：outcomeModel（显式配置优先）→ 主对话模型 → taskModel → 兜底厂商 */
export async function resolveOutcomeModel(): Promise<ResolvedModel | null> {
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = Array.isArray(settings.providers) ? settings.providers : [];

  // 1) outcomeModel（设置 → 成果块模型）：成果块质量敏感，显式配置时优先
  const roleResolved = resolveRoleModel(settings.outcomeModel, providers);
  if (roleResolved) return roleResolved;

  // 2) 主对话模型（pool → 旧式直配）：成果块默认跟随主对话，优先于任务模型
  const mainResolved = resolveMainChat(settings.chatModel, providers);
  if (mainResolved) return mainResolved;

  // 3) 回退：任务模型
  const taskResolved = resolveRoleModel(settings.taskModel, providers);
  if (taskResolved) return taskResolved;

  // 4) 兜底：第一个可用厂商
  return resolveProviderFallback(providers);
}

/* ==================== P3-3b2：服务端轻量 Auto 选路（供 lite / 外部 HTTP 客户端） ==================== */

/** 名字级"潜在思考模型"启发（与前端 AvailableModel.spec 相比仅作粗筛） */
const THINKING_MODEL_NAME_HINT = /reason|r1|think|thinking|k2|z1|v4|o[134]|deepseek|claude/i;

export interface PoolItem {
  provider?: string;
  modelId: string;
}

/**
 * 按任务类型对候选池排序（纯函数，可单测）：
 *  - reasoning/analysis/long-context 等需深度思考的任务 → 名字含思考标志的模型前置；
 *  - 其余（conversation/coding 常规）→ 保持池序（用户偏好顺序，等价静态首选）。
 * 分类失败或文本为空 → 保持原序（保守：不因分类错乱打乱用户池顺序）。
 */
export function rankPoolForTaskType(pool: PoolItem[], userText: string): PoolItem[] {
  if (!Array.isArray(pool) || pool.length <= 1) return pool;
  const text = (userText || '').trim();
  let needThinking = false;
  try {
    const type = analyzeTask(text).type;
    needThinking = type === 'reasoning' || type === 'analysis' || type === 'long-context';
  } catch {
    /* 分类异常 → 保序 */
  }
  if (!needThinking) return pool;
  const score = (it: PoolItem) => (THINKING_MODEL_NAME_HINT.test(it.modelId) ? 1 : 0);
  return [...pool]
    .map((it, idx) => ({ it, idx, s: score(it) }))
    .sort((a, b) => (b.s - a.s) || (a.idx - b.idx))
    .map((x) => x.it);
}

/**
 * 服务端 Auto 任务类型选路（P3-3b2）：
 *  - 仅当 settings.chatModel.auto 未显式关闭时启用（与前端开关语义一致）；
 *  - 取最后一条 user 文本做任务分类 → rankPoolForTaskType 排序 → 依次 resolveProviderModel 解析；
 *  - 全部不可解析或候选池为空 → null（调用方回退 resolveTaskModel 静态链路）。
 */
export async function resolveAutoTaskModel(
  messages: Array<{ role?: string; content?: unknown }>,
): Promise<ResolvedModel | null> {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const settings = await readSettingsFromFile();
  if (settings.chatModel?.auto === false) return null; // 开关关闭 → 交给静态链路
  const pool = Array.isArray(settings.chatModel?.pool) ? (settings.chatModel.pool as PoolItem[]) : [];
  if (pool.length === 0) return null;

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = (typeof lastUser?.content === 'string' ? lastUser.content : '').slice(0, 2000);
  for (const item of rankPoolForTaskType(pool, text)) {
    if (!item.modelId || !item.provider) continue;
    const resolved = await resolveProviderModel(`${item.provider}:${item.modelId}`);
    if (resolved) return resolved;
  }
  return null;
}
