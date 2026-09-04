/**
 * skills/registry-server.ts — 服务端技能注册表
 *
 * 仅在 Next.js 服务端路由 handler（app/api/* / route.ts 或 instrumentation）
 * 内部 import，维护 Agent 级别的技能开关状态。不使用 `server-only` 哨兵包。
 *
 * 持久化：技能启用状态同步写入 .settings.json 的 enabledSkills 字段，
 * 服务启动时（instrumentation）从设置恢复，重启不丢失。
 *  - enabledSkills = undefined → 从未配置，走系统默认技能
 *  - enabledSkills = []        → 显式全关（无技能注入）
 */

const _agentSkills = new Map<string, Set<string>>();

// ==================== 持久化 ====================

/** 串行持久化队列：避免多次启停的并发读-改-写竞争丢更新 */
let persistChain: Promise<void> = Promise.resolve();

function queuePersist(agentId: string): void {
  persistChain = persistChain
    .then(() => persistAgentSkills(agentId))
    .catch((e) => {
      console.warn('[skills-registry] 技能状态持久化失败:', e instanceof Error ? e.message : String(e));
    });
}

async function persistAgentSkills(agentId: string): Promise<void> {
  const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
  const settings = await readSettingsFromFile();
  if (settings.version === 0) return; // 读取异常的空默认值，拒绝覆盖已有配置
  settings.enabledSkills = Array.from(_agentSkills.get(agentId) ?? []);
  await writeSettingsToFile(settings);
}

/** 服务启动时调用：从 .settings.json 恢复 Agent 技能启用状态（未配置过则保持默认路径） */
export async function loadAgentSkillsFromSettings(): Promise<void> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    if (settings.enabledSkills === undefined) return; // 从未配置过 → 走系统默认技能
    _agentSkills.set('default', new Set(settings.enabledSkills));
  } catch (e) {
    console.warn('[skills-registry] 从设置恢复技能状态失败:', e instanceof Error ? e.message : String(e));
  }
}

// ==================== 内存状态 ====================

export function enableSkillForAgent(agentId: string, skillName: string): void {
  if (!_agentSkills.has(agentId)) _agentSkills.set(agentId, new Set());
  _agentSkills.get(agentId)!.add(skillName);
  queuePersist(agentId);
}

export function disableSkillForAgent(agentId: string, skillName: string): void {
  _agentSkills.get(agentId)?.delete(skillName);
  queuePersist(agentId);
}

export function enableAllSkillsForAgent(agentId: string): void {
  _agentSkills.set(agentId, new Set()); // 将在 API 层配合 getAllSkills 填充
  queuePersist(agentId);
}

export function getEnabledSkillsForAgent(agentId: string): Set<string> {
  // 如果从未设置过，返回空集合而非全启用
  const skills = _agentSkills.get(agentId);
  if (!skills) return new Set();

  // 如果是空 Set 且是 enableAll 调用的结果，返回全部技能名
  // enableAll 调用后 Set 为空，但 getAllSkills 在 API 层会返回全部并标记 enabled=true
  return skills;
}

/** 检查是否有显式配置（用于判断是否使用默认全启用） */
export function hasAgentConfig(agentId: string): boolean {
  return _agentSkills.has(agentId);
}
