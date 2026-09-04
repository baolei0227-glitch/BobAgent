/**
 * skills/types.ts — TypeScript 侧技能类型定义
 *
 * 与 Python skill_core/types.py 保持数据结构一致。
 */

/** 技能场景/领域类别（展示分类用；无标注或 frontmatter 未声明时按名称映射表兜底，仍无则 general） */
export type SkillScene = 'legal' | 'office' | 'design' | 'lark' | 'docs' | 'dev' | 'bob-work' | 'video' | 'general';

/** 技能元数据（L1 层，始终在线） */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  source: 'builtin' | 'user' | 'external';
  version: string;
  /** 适用场景/领域类别（展示分组与目录徽标） */
  scenes: SkillScene[];
}

/** SKILL.md YAML frontmatter 结构 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  /** 可选场景标注（frontmatter 优先，如 `scenes: legal,office`） */
  scenes?: string[];
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
