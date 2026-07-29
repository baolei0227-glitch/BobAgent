/**
 * skills/context.ts — 上下文构建器
 *
 * 将匹配结果组装为可注入 Agent system prompt 的文本。
 *
 * 三层:
 *   L1 - 技能目录（始终包含）
 *   L2 - 匹配技能正文
 *   L3 - 按需资源（由 Agent 工具访问）
 */

import type { SkillMeta, SkillMatchResult, SkillDefinition } from './types';

const MAX_L2_BODY_CHARS = 3000;
const MAX_TOTAL_CHARS = 50000;

function buildL1(availableSkills: SkillMeta[]): string {
  if (!availableSkills.length) return '';

  const lines = [
    '## 可用技能目录',
    '',
    '以下技能可在需要时触发。当用户的问题匹配技能描述中的关键词时，',
    '请参考对应技能的 SKILL.md 正文获取详细指令。',
    '',
  ];

  for (const s of availableSkills) {
    lines.push(`- **${s.name}**: ${s.description}`);
  }

  return lines.join('\n');
}

function buildL2(
  matchedSkills: SkillMatchResult[],
  definitions: Map<string, SkillDefinition>,
): string {
  if (!matchedSkills.length) return '';

  const parts: string[] = [];

  for (const match of matchedSkills) {
    const skill = definitions.get(match.skillMeta.name);
    if (!skill || !skill.body) continue;

    let body = skill.body;
    if (body.length > MAX_L2_BODY_CHARS) {
      body = body.slice(0, MAX_L2_BODY_CHARS) + '\n\n(正文已截断)';
    }

    const scorePct = Math.round(match.score * 100);
    const matchedKws = match.matchedKeywords.slice(0, 10).join(', ');

    parts.push(
      `## 已触发技能: ${skill.meta.name}\n` +
      `> 匹配度: ${scorePct}% | 命中关键词: ${matchedKws}\n\n` +
      body,
    );
  }

  return parts.join('\n\n---\n\n');
}

/**
 * 构建完整的技能上下文（L1 + L2），可直接拼接到 system prompt。
 */
export function buildSkillContext(
  matchedSkills: SkillMatchResult[],
  definitions: Map<string, SkillDefinition>,
  availableSkills: SkillMeta[],
): string {
  if (!availableSkills.length && !matchedSkills.length) return '';

  const parts: string[] = [];

  const l1 = buildL1(availableSkills);
  if (l1) parts.push(l1);

  const l2 = buildL2(matchedSkills, definitions);
  if (l2) parts.push(l2);

  let result = parts.join('\n\n');

  if (result.length > MAX_TOTAL_CHARS) {
    result = result.slice(0, MAX_TOTAL_CHARS) + '\n\n(上下文已截断)';
  }

  return result;
}
