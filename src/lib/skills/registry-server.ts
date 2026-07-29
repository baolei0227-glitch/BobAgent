/**
 * skills/registry-server.ts — 服务端技能注册表
 *
 * 仅在 Next.js 服务端运行，维护 Agent 级别的技能开关状态。
 */
import 'server-only';

const _agentSkills = new Map<string, Set<string>>();

export function enableSkillForAgent(agentId: string, skillName: string): void {
  if (!_agentSkills.has(agentId)) _agentSkills.set(agentId, new Set());
  _agentSkills.get(agentId)!.add(skillName);
}

export function disableSkillForAgent(agentId: string, skillName: string): void {
  _agentSkills.get(agentId)?.delete(skillName);
}

export function enableAllSkillsForAgent(agentId: string): void {
  _agentSkills.set(agentId, new Set()); // 将在 API 层配合 getAllSkills 填充
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
