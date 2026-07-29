/**
 * skills/matcher.ts — 技能匹配器
 *
 * 根据用户输入匹配相关技能，纯内存操作，零延迟。
 */

import type { SkillMeta, SkillMatchResult } from './types';

// 停用词
const STOP_WORDS = new Set([
  '的', '是', '在', '了', '和', '与', '或', '到', '要', '会', '能', '对',
  '当', '用', '被', '把', '从', '也', '就', '都', '而', '及', '但', '以',
  '不', '这', '那', '有', '我', '你', '他', '她', '它', '们',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can',
  'could', 'should', 'may', 'might', 'to', 'of', 'in', 'for', 'on',
  'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so', 'than',
  'too', 'very', 'just', 'about', 'up', 'out', 'if', 'now',
  '使用', '可以', '需要', '能够', '以及', '通过', '进行', '没有',
  '一个', '一种', '这个', '那个', '什么', '怎么', '如何', '为什么',
]);

function extractKeywords(text: string): Set<string> {
  text = text.toLowerCase().trim();
  const keywords = new Set<string>();

  // 英文单词（>= 2 字符）
  const engMatches = Array.from(text.matchAll(/[a-z]{2,}/g));
  for (const m of engMatches) {
    if (!STOP_WORDS.has(m[0])) keywords.add(m[0]);
  }

  // 中文 2-gram
  const chineseChars = Array.from(text.matchAll(/[\u4e00-\u9fff]/g)).map(m => m[0]);
  for (let i = 0; i < chineseChars.length - 1; i++) {
    const bigram = chineseChars[i] + chineseChars[i + 1];
    if (!STOP_WORDS.has(bigram)) keywords.add(bigram);
  }

  // 中文词组（>= 2 字符）
  const chineseMatches = Array.from(text.matchAll(/[\u4e00-\u9fff]{2,}/g));
  for (const m of chineseMatches) {
    if (!STOP_WORDS.has(m[0])) keywords.add(m[0]);
  }

  return keywords;
}

/**
 * 匹配用户输入与可用技能。
 *
 * @param userInput 用户输入文本
 * @param availableSkills 可用技能元数据列表
 * @param conversationContext 可选的对话历史
 * @param threshold 最低匹配分数 [0, 1]
 * @returns 按分数降序的匹配结果
 */
export function matchSkills(
  userInput: string,
  availableSkills: SkillMeta[],
  conversationContext = '',
  threshold = 0.1,
): SkillMatchResult[] {
  if (!userInput.trim() || !availableSkills.length) return [];

  const userKeywords = extractKeywords(userInput);

  if (conversationContext) {
    const ctxKeywords = extractKeywords(conversationContext);
    ctxKeywords.forEach(k => userKeywords.add(k));
  }

  if (userKeywords.size === 0) return [];

  const results: SkillMatchResult[] = [];

  for (const skillMeta of availableSkills) {
    const descKeywords = extractKeywords(skillMeta.description);
    if (descKeywords.size === 0) continue;

    const matched: string[] = [];
    userKeywords.forEach((kw) => {
      if (descKeywords.has(kw)) matched.push(kw);
    });

    if (matched.length === 0) continue;

    const score = Math.min(1.0, matched.length / descKeywords.size);
    if (score >= threshold) {
      results.push({
        skillMeta,
        score: Math.round(score * 1000) / 1000,
        matchedKeywords: matched.sort(),
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
