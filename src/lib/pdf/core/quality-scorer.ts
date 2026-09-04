/**
 * 文本质量评分器
 *
 * 5 维度评分模型，判断提取文本是否可读。
 * 中文文档侧重中文字符连贯度，英文文档侧重单词比例。
 */
import { COMMON_HANZI } from './common-hanzi';

/**
 * 无效汉字比例（0~1）：OCR 文本中不属于《现代汉语常用字表》3500 字的
 * 汉字占比。乱码页常由生僻字/错字拼凑而成，比例显著偏高；
 * 正常文书、流水、判决书用字几乎都在常用字表内，比例接近 0。
 * 仅统计汉字字符（基本区 + 扩展 A/B），无汉字时返回 0。
 */
export function invalidChineseRatio(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let invalid = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // 基本区 \u4E00-\u9FFF + 扩展A \u3400-\u4DBF + 扩展B-F \u20000-\u2FA1F
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2fa1f);
    if (!isCjk) continue;
    cjk++;
    // 扩展区汉字均为生僻字，不在 3500 常用字表内，直接视为无效
    if (code < 0x4e00 || code > 0x9fff) {
      invalid++;
      continue;
    }
    if (!COMMON_HANZI.includes(ch)) invalid++;
  }
  if (cjk === 0) return 0;
  return invalid / cjk;
}

/** 病态重复检测：同一行文本重复出现 ≥8 次且占行数 ≥25%，视为 OCR 列错位/乱码
 *  （如 "99999999"×50、"境内"×50、"Z1990006"×30——正常文书同一行不会反复出现）。
 *  无效汉字比例（invalidChineseRatio）对"重复 token 稀释生僻字占比"的乱码页不敏感，
 *  此信号与其互补。 */
export function hasPathologicalRepetition(text: string): boolean {
  if (!text) return false;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 2);
  if (lines.length < 8) return false;
  const freq = new Map<string, number>();
  let maxFreq = 0;
  for (const l of lines) {
    const n = (freq.get(l) ?? 0) + 1;
    freq.set(l, n);
    if (n > maxFreq) maxFreq = n;
  }
  return maxFreq >= 8 && maxFreq / lines.length >= 0.25;
}

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
