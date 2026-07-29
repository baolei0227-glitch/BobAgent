/**
 * skills/types.ts — TypeScript 侧技能类型定义
 *
 * 与 Python skill_core/types.py 保持数据结构一致。
 */

/** 技能元数据（L1 层，始终在线） */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  source: 'builtin' | 'user' | 'external';
  version: string;
}

/** SKILL.md YAML frontmatter 结构 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
}

/** 技能匹配结果 */
export interface SkillMatchResult {
  skillMeta: SkillMeta;
  score: number; // 0.0 ~ 1.0
  matchedKeywords: string[];
}

/** 技能完整定义（L2 层） */
export interface SkillDefinition {
  meta: SkillMeta;
  body: string;
}
