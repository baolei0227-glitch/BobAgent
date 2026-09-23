/**
 * 文档一致性检查（仅当前文档）：编号错误 / 交叉引用断裂 / 术语不一致。
 *
 * 确定性与模型分工：
 *   - 编号（checkNumbering）与交叉引用（checkReferences）为纯正则确定性判定，零模型调用、零成本；
 *   - 术语不一致（extractTermCandidates）先抽候选，交模型分组，服务端回校「两种写法都真实出现」
 *     后才报出（级别固定 warn，避免把「同义词」误判为错误）。
 *
 * 与 md-export/check.ts 的关系：ConsistencyItem 继承 CheckItem（level/msg/fix 同构），
 * 因此可直接复用 CheckReport 展示；额外带 kind（分类）与 locate（原文定位锚，点击跳转正文）。
 */

import type { CheckItem, CheckLevel } from '@/lib/md-export/check';

export interface ConsistencyItem extends CheckItem {
  /** 问题分类 */
  kind: 'numbering' | 'reference' | 'term';
  /** 定位锚：原文连续片段（点击跳转到正文；空串 = 无锚、不可跳） */
  locate: string;
}

export type ConsistencyLevel = CheckLevel;

// ============================================================
// 中文数字 ↔ 阿拉伯数字
// ============================================================

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 条款编号 → 数值：支持阿拉伯数字与中文数字（十/二十三/一百二十），解析失败返回 null */
export function cnToNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let section = 0;
  let number = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) number = CN_DIGITS[ch];
    else if (ch in CN_UNITS) {
      section += (number === 0 ? 1 : number) * CN_UNITS[ch];
      number = 0;
    } else return null;
  }
  return section + number;
}

// ============================================================
// 编号检查
// ============================================================

/** 条款定义行：行首（可含引用前缀 >）「第X条」；后随非数字字符，避免把「第3条款」拆错 */
const CLAUSE_DEF_RE = /^\s*(?:>\s*)?第([一二三四五六七八九十百零〇0-9]+)条(?![一二三四五六七八九十百零〇0-9])/;
/** 多级编号标题：## 3.1 标题 */
const HEADING_NUM_RE = /^#{1,6}\s+(\d+(?:\.\d+)*)[\s、.．]/;

/** 提取条款定义（行首「第X条」）：返回按文档顺序的 { num, raw }。
 *  raw 作为定位锚：形如「第3条」的纯文本在 md 与编辑器正文里都逐字存在，跳转可靠。 */
function collectClauseDefs(md: string): { num: number; raw: string }[] {
  const out: { num: number; raw: string }[] = [];
  for (const line of md.split('\n')) {
    const m = CLAUSE_DEF_RE.exec(line);
    if (!m) continue;
    const num = cnToNumber(m[1]);
    if (num == null) continue;
    out.push({ num, raw: `第${m[1]}条` });
  }
  return out;
}

/**
 * 编号检查：
 *   - 条款编号重复 → fail
 *   - 条款编号不连续 / 顺序颠倒 → warn
 *   - 多级编号标题重复（如两个 3.1）→ warn
 */
export function checkNumbering(md: string): ConsistencyItem[] {
  const items: ConsistencyItem[] = [];
  const defs = collectClauseDefs(md);

  // ① 重复编号
  const countOf = new Map<number, number>();
  for (const d of defs) countOf.set(d.num, (countOf.get(d.num) ?? 0) + 1);
  for (const [num, count] of countOf) {
    if (count < 2) continue;
    const first = defs.find((d) => d.num === num)!;
    items.push({
      key: `num-dup-${num}`,
      level: 'fail',
      msg: `Clause 第${num}条 is defined ${count} times (duplicate numbering)`,
      fix: 'Renumber the duplicate clause, or turn the later mention into a cross-reference.',
      kind: 'numbering',
      locate: first.raw,
    });
  }

  // ② 顺序 / 跳号（按首次出现去重后比较）
  const ordered = defs.filter((d, i) => defs.findIndex((x) => x.num === d.num) === i);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.num === prev.num + 1) continue;
    items.push({
      key: `num-seq-${prev.num}-${cur.num}`,
      level: 'warn',
      msg:
        cur.num < prev.num
          ? `Clause numbering goes backwards: 第${prev.num}条 → 第${cur.num}条`
          : `Clause numbering skips: 第${prev.num}条 → 第${cur.num}条 (第${prev.num + 1}条 missing)`,
      fix: cur.num < prev.num ? 'Reorder the clauses or fix their numbers.' : 'Check whether a clause was deleted without renumbering.',
      kind: 'numbering',
      locate: cur.raw,
    });
  }

  // ③ 多级编号标题重复
  const headingSeen = new Map<string, number>();
  for (const line of md.split('\n')) {
    const m = HEADING_NUM_RE.exec(line);
    if (!m) continue;
    headingSeen.set(m[1], (headingSeen.get(m[1]) ?? 0) + 1);
  }
  for (const [num, count] of headingSeen) {
    if (count < 2) continue;
    items.push({
      key: `num-heading-dup-${num}`,
      level: 'warn',
      msg: `Heading number ${num} appears ${count} times`,
      fix: 'Give each section a unique number so cross-references stay unambiguous.',
      kind: 'numbering',
      locate: '',
    });
  }

  return items;
}

// ============================================================
// 交叉引用检查
// ============================================================

/** 引用动词 + 第X条/章/节/款/项 */
const REF_PATTERN = '(?:见|参见|详见|依照|依据|根据|按|按照|如|与|及)\\s*第([一二三四五六七八九十百零〇0-9]+)([条章节款项])';
/** 定义：行首「第X条/章/节/款/项」 */
const DEF_RE = /^\s*(?:>\s*)?第([一二三四五六七八九十百零〇0-9]+)([条章节款项])/;

/** 收集各计量单位的定义编号集合（条/章/节/款/项） */
function collectDefinedNumbers(md: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const line of md.split('\n')) {
    const m = DEF_RE.exec(line);
    if (!m) continue;
    const num = cnToNumber(m[1]);
    if (num == null) continue;
    const unit = m[2];
    if (!map.has(unit)) map.set(unit, new Set());
    map.get(unit)!.add(num);
  }
  return map;
}

/** 交叉引用检查：引用「第X条/章/节/款/项」但全文没有对应定义 → fail */
export function checkReferences(md: string): ConsistencyItem[] {
  const items: ConsistencyItem[] = [];
  const defined = collectDefinedNumbers(md);
  const seen = new Set<string>();
  const re = new RegExp(REF_PATTERN, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const num = cnToNumber(m[1]);
    if (num == null) continue;
    const unit = m[2];
    if (defined.get(unit)?.has(num)) continue;
    const target = `第${m[1]}${unit}`;
    const key = `ref-${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      key,
      level: 'fail',
      msg: `Cross-reference ${target} points to a ${unit} that does not exist in this document`,
      fix: 'Fix the reference number, or add the missing clause.',
      kind: 'reference',
      // 锚用「见第X条」整段引用文本：md 与正文里都逐字存在，跳转可靠
      locate: m[0],
    });
  }
  return items;
}

/** 确定性检查汇总：编号 + 交叉引用（无问题则给出 pass 项作为「已查过」的证据） */
export function runDeterministicChecks(md: string): ConsistencyItem[] {
  const numItems = checkNumbering(md);
  const refItems = checkReferences(md);
  const items: ConsistencyItem[] = [...numItems, ...refItems];
  // 注意：CLAUSE_DEF_RE 带 `^` 且按行使用；对整篇检测需补 m 标志，否则只在文首命中
  if (numItems.length === 0 && new RegExp(CLAUSE_DEF_RE.source, 'm').test(md)) {
    items.push({ key: 'num-ok', level: 'pass', msg: 'Clause numbering is sequential and unique', kind: 'numbering', locate: '' });
  }
  if (refItems.length === 0 && new RegExp(REF_PATTERN).test(md)) {
    items.push({ key: 'ref-ok', level: 'pass', msg: 'All cross-references resolve to existing clauses', kind: 'reference', locate: '' });
  }
  return items;
}

// ============================================================
// 术语候选抽取（供模型分组判定）
// ============================================================

export interface TermCandidate {
  /** 术语写法 */
  term: string;
  /** 全文出现次数 */
  count: number;
  /** 同处出现的另一种写法（别名的本体 / 双语对照的另一侧） */
  related?: string;
  /** 来源：alias=以下简称定义；bilingual=中文（英文）对照；quoted=引号术语 */
  source: 'alias' | 'bilingual' | 'quoted';
}

/** 以下简称定义：「甲方（以下简称“买方”）」 */
const ALIAS_RE = /（以下简称\s*[「“"']?([^」”"'）)]{1,20})[」”"']?\s*）|\(以下简称\s*[「“"']?([^」”"'）)]{1,20})[」”"']?\s*\)/g;
/** 双语对照：「保密信息（Confidential Information）」 */
const BILINGUAL_RE = /([\u4e00-\u9fa5]{2,12})[（(]([A-Za-z][A-Za-z0-9 .&/-]{1,40})[)）]/g;
/** 引号术语：「X」/ “X” */
const QUOTED_RE = /[「“]([\u4e00-\u9fa5A-Za-z0-9]{2,12})[」”]/g;

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) {
    n++;
    i += needle.length;
  }
  return n;
}

/** 全文出现次数（模型分组回校用：两种写法都必须真实出现） */
export function countTerm(md: string, term: string): number {
  return countOccurrences(md, term);
}

/**
 * 抽取术语候选（去重 + 计数），交给模型判断哪些写法指同一概念。
 * 只做「候选」，不做判定 —— 判定交模型 + 服务端回校，避免误报。
 */
export function extractTermCandidates(md: string, max = 60): TermCandidate[] {
  const byTerm = new Map<string, TermCandidate>();
  const put = (term: string, source: TermCandidate['source'], related?: string) => {
    const t = term.trim();
    if (!t) return;
    const existing = byTerm.get(t);
    if (existing) {
      if (related && !existing.related) existing.related = related;
      return;
    }
    byTerm.set(t, { term: t, count: countOccurrences(md, t), source, related });
  };

  // ① 以下简称：别名 + 其前的本体（如「甲方（以下简称“买方”）」→ 买方 / 甲方）
  for (const m of md.matchAll(ALIAS_RE)) {
    const alias = (m[1] ?? m[2] ?? '').trim();
    if (!alias) continue;
    const before = md.slice(0, m.index ?? 0);
    // 本体 = 括号前最近的短语，按连接词/标点断开（「本合同所称甲方」→「甲方」）
    const owner = /[\u4e00-\u9fa5A-Za-z0-9]{1,12}$/.exec(before)?.[0]?.split(/[称为系指：:，,、]/).pop();
    put(alias, 'alias', owner && owner !== alias ? owner : undefined);
  }
  // ② 双语对照
  for (const m of md.matchAll(BILINGUAL_RE)) {
    put(m[1], 'bilingual', m[2].trim());
  }
  // ③ 引号术语
  for (const m of md.matchAll(QUOTED_RE)) {
    put(m[1], 'quoted');
  }

  return [...byTerm.values()]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}
