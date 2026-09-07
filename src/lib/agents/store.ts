/**
 * Agent 配置持久化存储（服务端）
 *
 * 覆盖项写入 $BOBWORK_HOME/.agents.json（默认 ~/BobWork/.agents.json）：
 *   - disabled：被禁用的专项 agent id（禁用后请求回退到通用 chat Agent）
 *   - prompts ：自定义 base system prompt（按 agentId 覆盖注册表里的字节稳定默认值）
 *
 * 设计约束：自定义 prompt 一旦写入即为"新稳定态"，仍须保持字节稳定（前缀缓存）；
 * 动态/低频变化内容仍应走 prependDynamicContext 注入 user 消息，不应写进自定义 base。
 */
import { join } from 'path';
import { promises as fs } from 'fs';
import { resolveAppRoot } from '@/lib/app-root';
import { AGENT_IDS, AGENT_PROFILES, getAgentProfile, type AgentProfile } from '@/lib/agents/profiles';
import { getInstalledAgentProfile } from '@/lib/agents/market-server';

interface AgentsConfig {
  /** 被禁用的专项 agent id（chat 恒可用，不进此列表） */
  disabled: string[];
  /** 装了但不显示在 ＋ Add session 菜单的 agent id（≠禁用：能力保留，未来可由其他入口调用） */
  hiddenMenu: string[];
  /** agentId → 自定义 base system prompt（覆盖注册表默认值） */
  prompts: Record<string, string>;
}

function configFile(): string {
  return join(resolveAppRoot(), '.agents.json');
}

async function readConfig(): Promise<AgentsConfig> {
  try {
    const raw = await fs.readFile(configFile(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AgentsConfig>;
    return {
      disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
      hiddenMenu: Array.isArray(parsed.hiddenMenu) ? parsed.hiddenMenu : [],
      prompts: parsed.prompts && typeof parsed.prompts === 'object' ? parsed.prompts : {},
    };
  } catch {
    return { disabled: [], hiddenMenu: [], prompts: {} };
  }
}

async function writeConfig(config: AgentsConfig): Promise<void> {
  const file = configFile();
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/** 某专项 agent 是否被禁用（chat 恒可用） */
export async function isAgentDisabled(agentId: string): Promise<boolean> {
  if (agentId === AGENT_IDS.chat) return false;
  const cfg = await readConfig();
  return cfg.disabled.includes(agentId);
}

/** 启用/禁用某专项 agent（chat 不可禁用） */
export async function setAgentDisabled(agentId: string, disabled: boolean): Promise<void> {
  if (agentId === AGENT_IDS.chat) return;
  const cfg = await readConfig();
  const set = new Set(cfg.disabled);
  if (disabled) set.add(agentId);
  else set.delete(agentId);
  cfg.disabled = [...set];
  await writeConfig(cfg);
}

/** 读取某 agent 的自定义 base system prompt（未设置返回 undefined） */
export async function getCustomPrompt(agentId: string): Promise<string | undefined> {
  const cfg = await readConfig();
  const prompt = cfg.prompts[agentId];
  return prompt && prompt.trim() ? prompt : undefined;
}

/** 某 agent 是否"隐藏菜单显示"（≠禁用：能力与身份解析均保留；chat 恒显示） */
export async function isHiddenFromMenu(agentId: string): Promise<boolean> {
  if (agentId === AGENT_IDS.chat) return false;
  const cfg = await readConfig();
  return cfg.hiddenMenu.includes(agentId);
}

/** 设置某 agent 是否显示在 ＋ Add session 菜单（chat 不可隐藏） */
export async function setHiddenFromMenu(agentId: string, hidden: boolean): Promise<void> {
  if (agentId === AGENT_IDS.chat) return;
  const cfg = await readConfig();
  const set = new Set(cfg.hiddenMenu);
  if (hidden) set.add(agentId);
  else set.delete(agentId);
  cfg.hiddenMenu = [...set];
  await writeConfig(cfg);
}

/** 写入/清除某 agent 的自定义 base system prompt（传空字符串清除，恢复注册表默认） */
export async function setCustomPrompt(agentId: string, prompt: string): Promise<void> {
  const cfg = await readConfig();
  const trimmed = prompt.trim();
  if (trimmed) cfg.prompts[agentId] = trimmed;
  else delete cfg.prompts[agentId];
  await writeConfig(cfg);
}

/** 读取当前 Agent 生效配置快照（供设置 UI 展示） */
export async function readAgentsState(): Promise<{
  disabled: string[];
  hiddenMenu: string[];
  prompts: Record<string, string>;
}> {
  const cfg = await readConfig();
  return { disabled: [...cfg.disabled], hiddenMenu: [...cfg.hiddenMenu], prompts: { ...cfg.prompts } };
}

/**
 * 解析出实际生效的 Agent 配置（每次聊天请求调用一次）：
 *   - 内置画像按 AGENT_PROFILES；非内置 identity → 查已安装市场包（agent 市场，2026-09-06）
 *   - 找不到 / 被禁用 → 回退通用 chat（确保请求不会打到已停用/未知的专项）
 *   - 有自定义 prompt → 覆盖 baseSystemPrompt
 */
export async function resolveAgentProfile(identity: string | undefined): Promise<AgentProfile> {
  let profile: AgentProfile;
  if (identity && !(identity in AGENT_PROFILES)) {
    // 市场已安装 agent：动态画像（未安装 → chat 兜底）
    profile = (await getInstalledAgentProfile(identity)) ?? getAgentProfile(undefined);
  } else {
    profile = getAgentProfile(identity);
  }
  if (profile.id === AGENT_IDS.chat) return profile;
  const cfg = await readConfig();
  if (cfg.disabled.includes(profile.id)) return getAgentProfile(undefined);
  const custom = cfg.prompts[profile.id];
  if (custom && custom.trim()) {
    return { ...profile, baseSystemPrompt: custom };
  }
  return profile;
}
