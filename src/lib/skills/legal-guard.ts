/**
 * skills/legal-guard.ts — 法律场景防幻觉约束（scene 驱动的单一事实源）
 *
 * 法律技能通过 frontmatter 声明 `scenes: legal`（或 SKILL_SCENES 名称映射兜底）标识身份；
 * 宿主在技能上下文注入时读 `meta.scenes` 判断是否法律技能，命中则前置注入本 guard。
 * 已从 route.ts 硬编码的 LEGAL_SKILL_NAMES 名字集合迁移至此（scene 驱动，消除重复事实源）。
 */
import type { SkillMeta } from './types';

/** 法律场景防幻觉最强约束（字节稳定）：当匹配到任何法律技能时，注入到技能上下文最顶部 */
export const LEGAL_GUARD_PROMPT = `⚠️ 你正在处理法律问题，以下规则优先级最高，违反将导致严重法律风险：

1. 绝对禁止编造任何法律条文、法条编号、案例号、法院名称、裁判观点。
2. 引用法条前必须通过 web_search 检索核实原文。如果搜索不到原文，必须说"我无法确认该法条原文"，不得根据记忆编造。
3. 所有引用的法条必须附带时效性核查（是否现行有效 / 是否已修订 / 是否已废止）。
4. 法律条文的解释必须严格基于条文原文，不得添加任何未经核实的"立法意图""立法背景"。
5. 如果用户引用的法条与你的检索结果不符，应以检索结果为准并指出差异。
6. 不要为了让回答"看起来完整"而补充任何未经检索核实的内容。
`;

/** 是否法律技能：以技能自声明的 scene 为单一事实源（不再硬编码技能名集合） */
export function isLegalSkill(meta: SkillMeta): boolean {
  return meta.scenes.includes('legal');
}
