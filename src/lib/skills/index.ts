/**
 * skills/index.ts — 技能系统统一入口（客户端安全版本）
 *
 * 高频路径（每轮对话）：matchAndBuildContext（纯内存，零延迟）
 * 低频路径（技能管理）：由 /api/skills API 端点处理
 *
 * 注意：此文件不含任何 Node.js 模块（fs/path/os），可被客户端组件安全导入。
 */

import { matchSkills } from './matcher';
import { buildSkillContext } from './context';
import type { SkillMeta, SkillMatchResult, SkillDefinition } from './types';

/**
 * 一站式操作：匹配 + 构建上下文。
 * 在每轮对话前由 route.ts 服务端调用。
 *
 * @param userInput 用户输入文本
 * @param availableSkills 可用技能列表（由服务端提供）
 * @param definitions 技能定义映射（由服务端提供）
 * @returns 技能上下文字符串
 */
export function matchAndBuildContext(
  userInput: string,
  availableSkills: SkillMeta[],
  definitions: Map<string, SkillDefinition>,
): string {
  if (!availableSkills.length) return '';
  const matches = matchSkills(userInput, availableSkills);
  return buildSkillContext(matches, definitions, availableSkills);
}

export type { SkillMeta, SkillMatchResult, SkillDefinition };
