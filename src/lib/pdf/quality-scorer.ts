/**
 * 文本质量评分器
 *
 * 5 维度评分模型，判断提取文本是否可读。
 * 中文文档侧重中文字符连贯度，英文文档侧重单词比例。
 */

/**
 * 对提取的文本进行质量评分（0~1）
 * 评分 ≥ 0.3 认为文本可读
 */
export function qualityScore(text: string): number {
  if (!text || text.trim().length === 0) return 0;

  const cleaned = text.replace(/\s+/g, ' ').trim();
  const len = cleaned.length;
  if (len < 20) return 0;

  // 维度1：可打印字符占比（权重 5%）
  const printableRatio = countPrintable(cleaned) / len;
  const s1 = clamp(printableRatio, 0.7, 1);

  // 维度2：中文字符占比（权重 30%）
  const chineseCount = countChinese(cleaned);
  const chineseRatio = chineseCount / len;
  const s2 = chineseRatio > 0.01 ? clamp(chineseRatio * 3, 0, 1) : 0;

  // 维度3：英文单词占比（权重 20%）
  const englishCount = countEnglish(cleaned);
  const englishRatio = englishCount / len;
  const s3 = englishRatio > 0.3 ? clamp(englishRatio, 0, 1) : 0;

  // 维度4：单字符乱码惩罚（权重 25%）
  const garbageRatio = countSingleGarbage(cleaned) / len;
  const s4 = 1 - clamp(garbageRatio * 5, 0, 1);

  // 维度5：空白比例惩罚（权重 20%）
  const spaceRatio = (text.length - text.replace(/\s/g, '').length) / Math.max(text.length, 1);
  const s5 = 1 - clamp(spaceRatio * 2, 0, 1);

  return s1 * 0.05 + s2 * 0.30 + s3 * 0.20 + s4 * 0.25 + s5 * 0.20;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function countPrintable(text: string): number {
  return (text.match(/[\x20-\x7E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g) || []).length;
}

function countChinese(text: string): number {
  return (text.match(/[\u4E00-\u9FFF]/g) || []).length;
}

function countEnglish(text: string): number {
  return (text.match(/[a-zA-Z]/g) || []).length;
}

function countSingleGarbage(text: string): number {
  // 单个独立出现的字母/数字/符号 → 典型的 OCR 乱码
  const singles = text.match(/(?:^|[\s])([a-zA-Z0-9])(?=[\s]|$)/g);
  return singles ? singles.length : 0;
}
