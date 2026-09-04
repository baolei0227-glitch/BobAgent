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

// 单个技能正文注入上限：须能容纳 slide-craft 等长技能的全部交互指令
// （其「Phase 1 提问表格 / Phase 2 风格选择 / Phase 3 配图与内容预览确认」分布在正文 2.6k–11.2k 字符处，
//  旧值 3000 会把提问表格截断在中间，导致技能执行时不会主动询问用户）
const MAX_L2_BODY_CHARS = 16000;
const MAX_TOTAL_CHARS = 50000;

function buildL1(availableSkills: SkillMeta[]): string {
  if (!availableSkills.length) return '';

  const lines = [
    '## 可用技能目录',
    '',
    '以下是本机技能库（名称 + 一句话用途）。当用户请求涉及某个技能领域时，先调用 `load_skill` 工具加载该技能的完整操作指令，再严格按其执行。已手动勾选强制注入的技能（见下方「已触发技能」段落）已直接给出完整指令，无需再调用 load_skill。',
    '',
  ];

  // 只列名称 + 一句话用途（截断）：完整正文由模型按需 load_skill 加载，不预注入
  for (const s of availableSkills) {
    const brief = s.description.length > 60 ? s.description.slice(0, 60) + '…' : s.description;
    // 场景徽标：非通用技能标注场景类别，帮助模型感知能力分组
    const scene = s.scenes && s.scenes[0] !== 'general' ? s.scenes[0] : '';
    const sceneTag = scene ? ` [${scene}]` : '';
    lines.push(`- **${s.name}**${sceneTag}：${brief}`);
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
