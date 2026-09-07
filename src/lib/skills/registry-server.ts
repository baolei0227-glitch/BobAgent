/**
 * skills/registry-server.ts — 服务端技能注册表
 *
 * 仅在 Next.js 服务端路由 handler（app/api/* / route.ts 或 instrumentation）
 * 内部 import，维护 Agent 级别的技能开关状态。不使用 `server-only` 哨兵包。
 *
 * 持久化（2026-09-06 多 agent 分发）：
 *   - settings.agentSkills: Record<agentId, string[]> —— 每个 agent 的独立技能池（权威源）；
 *   - settings.enabledSkills: string[] —— 恒为 'default' 全局池镜像（兼容旧读方）。
 *   - 两字段都 undefined → 从未配置，走系统默认技能（所有已发现技能）
 *   - agentSkills[某agent] = [] → 该 agent 显式全关（无技能注入）
 *
 * 分发语义：某 agent 有独立配置（agentSkills 有该 key）→ 按其出 L1 技能目录；
 * 否则回退 'default' 全局池（即现状的全局启停）。
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

async function persistAgentSkills(_agentId: string): Promise<void> {
  const { readSettingsFromFile, writeSettingsToFile } = await import('@/lib/settings-server');
  const settings = await readSettingsFromFile();
  if (settings.version === 0) return; // 读取异常的空默认值，拒绝覆盖已有配置
  // agentSkills 全量落盘（每 agent 独立池互不覆盖）；enabledSkills 恒镜像 'default' 池，兼容旧读方
  settings.agentSkills = Object.fromEntries(
    [..._agentSkills.entries()].map(([k, v]) => [k, Array.from(v)]),
  );
  settings.enabledSkills = Array.from(_agentSkills.get('default') ?? []);
  await writeSettingsToFile(settings);
}

/** 服务启动时调用：从 .settings.json 恢复各 Agent 技能池（agentSkills 为权威源；未配置过则保持默认路径） */
export async function loadAgentSkillsFromSettings(): Promise<void> {
  try {
    const { readSettingsFromFile } = await import('@/lib/settings-server');
    const settings = await readSettingsFromFile();
    if (settings.agentSkills && typeof settings.agentSkills === 'object') {
      for (const [agentId, names] of Object.entries(settings.agentSkills)) {
        _agentSkills.set(agentId, new Set(names ?? []));
      }
      return; // agentSkills 权威（含 default 池镜像）
    }
    // 旧版单池格式：仅 enabledSkills
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

/** 移除某 agent 的整条技能池配置（agent 卸载用）：删 key → 恢复"未配置=回退全局默认池"语义 */
export function clearAgentSkills(agentId: string): void {
  if (_agentSkills.delete(agentId)) queuePersist(agentId);
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

/**
 * 取某 agent 的独立技能池（2026-09-06 分发用）：
 * 未为该 agent 配置过 → 返回 null，调用方应回退 'default' 全局池（enableSkill 只写 default 的旧语义不变）。
 */
export function getAgentSkills(agentId: string): Set<string> | null {
  return _agentSkills.get(agentId) ?? null;
}
