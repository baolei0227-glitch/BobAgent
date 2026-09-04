/**
 * src/lib/legal/synonyms.ts
 * 法律同义词与近义术语表（规格 v3 §五 关键词匹配的补强）
 *
 * 法律术语的字面与语义脱节严重：裸关键词匹配会大量漏召。
 * 本表手工维护，几十条即可覆盖高频场景，成本远低于向量检索，且可审计。
 * 维护标准：若某次漏召导致实际错误，把该组词补进表；若一个月内补了超过 20 组，说明该上语义匹配了。
 */

/** 同义词组：组内词互为近义，匹配时双向扩展 */
export const LEGAL_SYNONYM_GROUPS: string[][] = [
  ['解除', '终止', '解约'],
  ['定金', '订金', '预付款'],
  ['撤销', '无效', '可撤销'],
  ['N+1', '代通知金'],
  ['经济补偿金', '补偿金', '经济补偿'],
  ['竞业限制', '竞业禁止'],
  ['违约金', '违约赔偿', '赔偿金'],
  ['工资', '薪资', '劳动报酬', '月薪'],
  ['加班费', '加班工资', '加班补偿'],
  ['试用期', '考察期'],
  ['裁员', '经济性裁员', '批量裁员'],
  ['工伤', '工伤事故', '劳动能力鉴定'],
  ['劳动合同', '劳务合同', '用工协议'],
  ['辞职', '离职', '主动离职'],
  ['辞退', '解雇', '开除', '解除劳动关系'],
  ['仲裁', '劳动仲裁', '商事仲裁'],
  ['诉讼', '起诉', '打官司'],
  ['时效', '诉讼时效', '仲裁时效'],
  ['证据', '举证', '证据材料'],
  ['赔偿', '赔偿损失', '损害赔偿'],
  ['著作权', '版权', '著作权人'],
  ['商标', '注册商标', '商标权'],
  ['专利', '专利权', '发明', '实用新型'],
  ['违约', '违反合同', '不履行合同'],
  ['继承', '遗产', '法定继承'],
  ['离婚', '婚姻关系解除', '解除婚姻关系'],
  ['抚养', '抚养权', '抚养费'],
  ['房产', '房屋', '不动产', '商品房'],
  ['租赁', '出租', '承租'],
  ['担保', '保证', '抵押', '质押'],
  ['利息', '逾期利息', '资金占用费'],
];

/** 语义等价但字面差异大的高频映射（单项映射，用于 normalize 归一化） */
const NORMALIZE_MAP: Record<string, string> = {
  'n+1': '代通知金',
  'n+1补偿': '代通知金',
  '补偿n+1': '代通知金',
};

/** 将术语归一化（小写化 + 同义映射） */
export function normalizeTerm(term: string): string {
  const key = term.trim().toLowerCase();
  return NORMALIZE_MAP[key] ?? term.trim();
}

/** 词 → 同义词集合（含自身，双向扩展） */
export function synonymSetOf(term: string): Set<string> {
  const norm = normalizeTerm(term);
  const out = new Set<string>([term.trim(), norm]);
  for (const group of LEGAL_SYNONYM_GROUPS) {
    if (group.includes(norm) || group.some((g) => norm.includes(g))) {
      for (const w of group) out.add(w);
    }
  }
  return out;
}

/** 一组词 → 双向扩展后的同义词全集 */
export function expandTerms(terms: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of terms) {
    const s = t.trim();
    if (!s) continue;
    for (const w of synonymSetOf(s)) out.add(w);
  }
  return out;
}

/**
 * 计算查询词与候选关键词的匹配数量（含同义词双向扩展）
 * @returns 匹配到的同义词集合（用于命中判断与溯源）
 */
export function matchTerms(queryTerms: string[], candidateKeywords: string[]): Set<string> {
  const expandedQuery = expandTerms(queryTerms);
  const expandedCandidates = expandTerms(candidateKeywords);
  const hits = new Set<string>();
  for (const q of expandedQuery) {
    if (!q) continue;
    // 精确命中候选词或其同义词
    if (expandedCandidates.has(q)) {
      hits.add(q);
      continue;
    }
    // 子串命中（长词包含短词，如「经济补偿金」包含「补偿金」）
    for (const c of expandedCandidates) {
      if (q.length >= 2 && c.length >= 2 && (c.includes(q) || q.includes(c))) {
        hits.add(q);
        break;
      }
    }
  }
  return hits;
}
