/**
 * src/lib/nodes/outcome.ts
 * 成果块（Outcome）解析、渲染与校验
 *
 * 规格：《BobWork 节点记忆与继承规格 v3》第三节（成果块 schema）
 *  - 字段顺序即渲染顺序，默认模板 legal-analysis
 *  - 空值必须写「无」而不能省略字段（limits 写「无已知限制」，user_notes 允许空字符串）
 *  - 校验规则 R-1 ~ R-8b（R-8「未锁定不得建边」在 edges 侧执行，见 api/edges/route.ts）
 */

// ==================== 字段定义 ====================

export interface OutcomeFieldDef {
  key: string;
  label: string;
  required: boolean;
  /** 允许的空值标记（R-2）：空字段必须显式写出该标记，不得省略或留空 */
  emptyValue: string;
}

/** 成果块总长度上限（R-7）兜底值。默认 48000 字符：当前模型均为 1M 上下文（≈3-5%），保留"精炼成果"导向同时大幅放宽
 * 动态计算见 src/lib/context-limits.ts（outcomeMaxLengthForContext / outcomeMaxLengthForModel） */
export const OUTCOME_MAX_LENGTH = 48000;

/** 成果块字段定义（v3 §三 表格，顺序即渲染顺序） */
export const OUTCOME_FIELD_DEFS: readonly OutcomeFieldDef[] = [
  { key: 'facts', label: '事实认定', required: true, emptyValue: '无' },
  { key: 'basis', label: '法律依据', required: true, emptyValue: '无' },
  { key: 'reasoning', label: '分析推理', required: true, emptyValue: '无' },
  { key: 'conclusions', label: '结论', required: true, emptyValue: '无' },
  { key: 'excluded', label: '明确排除', required: true, emptyValue: '无' },
  { key: 'limits', label: '适用限制', required: true, emptyValue: '无已知限制' },
  { key: 'pending', label: '待确认', required: true, emptyValue: '无' },
  { key: 'user_notes', label: '用户补充', required: true, emptyValue: '' }, // 允许空字符串，AI 不得写入
] as const;

export type OutcomeFieldKey = (typeof OUTCOME_FIELD_DEFS)[number]['key'];

/** 成果块内容（各字段为原文文本，条目以换行分隔） */
export interface Outcome {
  facts: string;
  basis: string;
  reasoning: string;
  conclusions: string;
  excluded: string;
  limits: string;
  pending: string;
  user_notes: string;
}

/** 确定性等级（R-5） */
export type CertaintyLevel = '确定' | '倾向性' | '存疑';

/** 节点成果状态 */
export type OutcomeStatus = 'locked' | 'draft' | 'stale' | 'legacy';

// ==================== 工具函数 ====================

/** 字段 key → 中文标签 */
export function outcomeLabel(key: OutcomeFieldKey): string {
  return OUTCOME_FIELD_DEFS.find((d) => d.key === key)?.label ?? key;
}

function truncate(s: string, max = 40): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

/** 校验用的正则（v3 §三） */
/** 规范空值标记（R-2 允许）：逐条校验（R-3~R-8b）应跳过这些条目 */
const EMPTY_MARKERS = new Set(['无', '无已知限制']);
/** R-3 来源标记：n_xxx 或 n_xxx#q-007 或 本节点（n_ 后允许 UUID 连字符） */
const SOURCE_RE = /\[来源:\s*(n_[a-z0-9-]+(?:#[a-z]+-\d+)?|本节点)\]/;
/** R-4 可定位的规范指向：条款号 / 案例编号 / 法释 / 年份文号 */
const CITATION_RE = /(第[零一二三四五六七八九十百千\d]+[条款章]|法释|指导案例|公报案例|案例|[〔\[]20\d{2}[〕\]])/;
/** R-5 确定性等级标签 */
const CERTAINTY_RE = /\[(确定|倾向性|存疑)\]/;
/** R-8b 未认定标记 */
const UNVERIFIED_RE = /\[原始对话·未认定\]/;
/** R-6 待确认条目：需写明所需内容与责任方（宽松校验） */
const PENDING_ACTION_RE = /(需|待|由|应|须|用户|人工)/;

/** 取出条目并过滤规范空值标记（空字段写法由 R-2 负责校验） */
function getItems(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter((l) => l.length > 0 && !EMPTY_MARKERS.has(l));
}

// ==================== 解析 ====================

/**
 * 从 `## 成果块` section 文本解析出 Outcome
 * 结构：每个字段以 `### {字段标签}` 为分隔，后续行（含 `- ` 列表）为字段内容。
 * 无任何字段时返回 null（旧节点无成果块）。
 */
export function parseOutcome(sectionText: string): Outcome | null {
  if (!sectionText || !sectionText.trim()) return null;

  const lines = sectionText.split('\n');
  const fields: Partial<Record<OutcomeFieldKey, string>> = {};
  let currentKey: OutcomeFieldKey | null = null;
  const buffer: string[] = [];

  const flush = () => {
    if (currentKey && buffer.length > 0) {
      fields[currentKey] = buffer.join('\n').trim();
      buffer.length = 0;
    }
  };

  for (const line of lines) {
    const m = line.match(/^###\s+(.+)$/);
    if (m) {
      flush();
      const label = m[1].trim();
      const def = OUTCOME_FIELD_DEFS.find((d) => d.label === label);
      currentKey = def ? (def.key as OutcomeFieldKey) : null;
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  flush();

  if (Object.keys(fields).length === 0) return null;
  return {
    facts: fields.facts ?? '',
    basis: fields.basis ?? '',
    reasoning: fields.reasoning ?? '',
    conclusions: fields.conclusions ?? '',
    excluded: fields.excluded ?? '',
    limits: fields.limits ?? '',
    pending: fields.pending ?? '',
    user_notes: fields.user_notes ?? '',
  };
}

// ==================== 渲染 ====================

/**
 * 将 Outcome 渲染为 `## 成果块` section 的正文（不含标题）
 * 空字段输出该字段的规范空值标记（R-2），user_notes 输出空字符串。
 */
export function renderOutcome(outcome: Outcome): string {
  const record = outcome as unknown as Record<OutcomeFieldKey, string>;
  const blocks = OUTCOME_FIELD_DEFS.map((def) => {
    const value = (record[def.key] ?? '').trim();
    return `### ${def.label}\n${value || def.emptyValue}`;
  });
  return blocks.join('\n\n');
}

/** 生成空成果块模板（新节点初始化用，空值标记符合 R-2） */
export function createEmptyOutcome(): Outcome {
  return {
    facts: '',
    basis: '',
    reasoning: '',
    conclusions: '',
    excluded: '',
    limits: '',
    pending: '',
    user_notes: '',
  };
}

// ==================== 校验（R-1 ~ R-8b） ====================

export interface OutcomeValidationResult {
  valid: boolean;
  /** 逐条错误（带规则编号） */
  errors: string[];
}

/**
 * 校验成果块（R-1 ~ R-8b）
 * @param maxLength 成果块总长度上限（R-7，默认 OUTCOME_MAX_LENGTH=48000）
 */
export function validateOutcome(outcome: Outcome, maxLength = OUTCOME_MAX_LENGTH): OutcomeValidationResult {
  const errors: string[] = [];
  const record = outcome as unknown as Record<OutcomeFieldKey, string>;

  // R-1: 全部必填字段存在（parseOutcome 总是补全 8 字段，此检查由 route 层 !node.outcome 兜底）
  // R-2: 空字段显式写空值标记，不得省略或留空（user_notes 允许空字符串）
  for (const def of OUTCOME_FIELD_DEFS) {
    if (def.key === 'user_notes') continue; // 允许空字符串
    const value = (record[def.key] ?? '').trim();
    if (value.length === 0) {
      errors.push(`R-2 字段「${def.label}」为空，必须显式写「${def.emptyValue}」`);
    } else if (value === '（暂无）') {
      errors.push(`R-2 字段「${def.label}」应使用规范空值「${def.emptyValue}」，而非「（暂无）」`);
    }
  }

  // R-3: facts 与 basis 每条带来源标记
  for (const key of ['facts', 'basis'] as const) {
    for (const item of getItems(record[key])) {
      if (!SOURCE_RE.test(item)) {
        errors.push(`R-3 ${outcomeLabel(key)}条目缺少来源标记: ${truncate(item)}`);
      }
    }
  }

  // R-4: basis 每条可定位（含条款号/案例编号）或必须带 [待核实]
  for (const item of getItems(record.basis)) {
    if (!CITATION_RE.test(item) && !/\[待核实\]/.test(item)) {
      errors.push(`R-4 法律依据不可定位且未标 [待核实]: ${truncate(item)}`);
    }
  }

  // R-5: conclusions 每条带确定性等级标签
  for (const item of getItems(record.conclusions)) {
    if (!CERTAINTY_RE.test(item)) {
      errors.push(`R-5 结论缺少确定性等级标签([确定]/[倾向性]/[存疑]): ${truncate(item)}`);
    }
  }

  // R-6: pending 每条写明所需内容与责任方
  for (const item of getItems(record.pending)) {
    if (!PENDING_ACTION_RE.test(item)) {
      errors.push(`R-6 待确认条目未写明所需内容与责任方: ${truncate(item)}`);
    }
  }

  // R-7: 成果块总长度不超过上限
  const totalLen = OUTCOME_FIELD_DEFS.reduce((sum, def) => sum + (record[def.key] ?? '').length, 0);
  if (totalLen > maxLength) {
    errors.push(`R-7 成果块总长度 ${totalLen} 超过上限 ${maxLength}，请拆分节点`);
  }

  // R-8b: 凡带 [原始对话·未认定] 标记的条目，确定性等级不得为 [确定]
  for (const key of OUTCOME_FIELD_DEFS.map((d) => d.key)) {
    if (key === 'user_notes') continue;
    for (const item of getItems(record[key])) {
      if (UNVERIFIED_RE.test(item) && /\[确定\]/.test(item)) {
        errors.push(`R-8b 未认定内容不得标 [确定]（${outcomeLabel(key)}）: ${truncate(item)}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
