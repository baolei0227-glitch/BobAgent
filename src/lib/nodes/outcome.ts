/**
 * src/lib/nodes/outcome.ts
 * 成果块（Outcome）解析、渲染与校验
 *
 * 规格：《BobWork 节点记忆与继承规格 v3》第三节（成果块 schema）
 *  - 字段顺序即渲染顺序，默认模板 legal-analysis
 *  - 空值必须写「无」而不能省略字段（limits 写「无已知限制」，user_notes 允许空字符串）
 *  - 校验规则 R-1 ~ R-8b（R-8「未锁定不得建边」在 edges 侧执行，见 api/edges/route.ts）
 */

import { BRIEF_MAX_CHARS_PER_UPSTREAM } from '@/lib/context-limits';

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
/** R-3 材料来源页码未通过索引校验时的降级标记（见 src/lib/nodes/outcome-source-check.ts） */
export const PAGE_UNVERIFIED = '页码待核实';
/** R-3 来源标记，三种其一（互不替代）：
 *  - `n_xxx` / `n_xxx#q-007`：上游节点成果块（n_ 后允许 UUID 连字符）
 *  - `本节点`：本节点对话记录中提炼
 *  - `材料:materials/相对路径#p页码`：项目材料原文（页码可省略；路径不含 `]` 与 `#`）
 *    页码未通过索引校验时写作 `#p页码待核实`（保留出处、不冒充已核实）*/
const SOURCE_RE = /\[来源:\s*(n_[a-z0-9-]+(?:#[a-z]+-\d+)?|本节点|材料:materials\/[^\]\n#]+(?:#p(?:\d+|页码待核实))?)\]/;
/** R-4 可定位的规范指向：条款号 / 案例编号 / 法释 / 年份文号 */
const CITATION_RE = /(第[零一二三四五六七八九十百千\d]+[条款章]|法释|指导案例|公报案例|案例|[〔\[]20\d{2}[〕\]])/;
/** R-5 确定性等级标签（导出：账本自检据它识别「疑似越权结论」，见 lib/mcp/ledger.ts lintLedger） */
export const CERTAINTY_RE = /\[(确定|倾向性|存疑)\]/;
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

/**
 * 将 Outcome 渲染为「结论档」brief 正文（不含 `## 上游节点…` 标题——标题由调用方拼，P0-c）。
 * 只出三样：结论原文 + 确定性等级 + 来源 id；**不做摘要改写**，超预算时只按整条取舍：
 *  - 结论：按 conclusions 条目顺序原文列出，超出预算则丢弃**尾部整条**（绝不从条目中间切断，
 *    保证条目内的等级/来源标记不丢）；
 *  - 确定性等级：条目未带 [确定|倾向性|存疑] 时在该条尾部补 ` [等级未标注]`，并在汇总行给出计数；
 *  - 来源：只从**保留下来的**条目中收集 [来源: …] 的 id（去重、保持出现顺序）。
 * 任何丢弃/缺标都在文本里显式告知模型（含回原节点核对提示），不做静默截断。
 *
 * @param maxChars 单上游 brief 硬上限（默认 BRIEF_MAX_CHARS_PER_UPSTREAM）
 * @param nodeId   来源节点标识（如 n_xxx），用于截断/来源缺标时提示回原节点核对
 */
export function renderOutcomeBrief(
  outcome: Outcome,
  maxChars = BRIEF_MAX_CHARS_PER_UPSTREAM,
  nodeId?: string,
): string {
  const backTo = nodeId ? `原节点${nodeId}` : '原节点';
  const items = getItems(outcome.conclusions);

  if (items.length === 0) {
    return `### 结论\n- 无\n\n### 来源\n- （未标注，请回${backTo}核对）`;
  }

  // 固定尾巴（确定性等级汇总 + 来源清单 + 截断提示）预留约 240 字符
  const budget = maxChars - 240;
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  let firstOverBudget = false;
  for (const item of items) {
    const hasLevel = CERTAINTY_RE.test(item);
    const line = `- ${item}${hasLevel ? '' : ' [等级未标注]'}`;
    // 至少保留第 1 条：第 1 条本身超长时原样保留（并在末尾说明）
    if (kept.length > 0 && used + line.length > budget) {
      dropped = items.length - kept.length;
      break;
    }
    if (kept.length === 0 && line.length > budget) firstOverBudget = true;
    kept.push(line);
    used += line.length + 1;
  }

  // 确定性等级汇总：只统计实际列出的条目
  const counts = { 确定: 0, 倾向性: 0, 存疑: 0, 未标注: 0 };
  for (const line of kept) {
    const m = line.match(CERTAINTY_RE);
    if (m) counts[m[1] as '确定' | '倾向性' | '存疑'] += 1;
    else counts.未标注 += 1;
  }
  const levelParts = (['确定', '倾向性', '存疑', '未标注'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${k} ${counts[k]}`)
    .join(' / ');

  // 来源 id：只从保留下来的条目文本里收集（去重、保持出现顺序）
  const sources: string[] = [];
  const sourceRe = /\[来源:\s*([^\]]+)\]/g;
  for (const line of kept) {
    for (const m of line.matchAll(sourceRe)) {
      if (!sources.includes(m[1])) sources.push(m[1]);
    }
  }
  const sourceBlock = sources.length > 0
    ? sources.map((s) => `- ${s}`).join('\n')
    : `- （未标注，请回${backTo}核对）`;

  const notes: string[] = [];
  if (dropped > 0) notes.push(`（另有 ${dropped} 条结论未列出，请回${backTo}查看）`);
  if (firstOverBudget) notes.push('（首条结论已超单条预算，按整条原样保留）');

  return [
    '### 结论',
    kept.join('\n'),
    '',
    '### 确定性等级',
    `- ${levelParts || '无'}`,
    '',
    '### 来源',
    sourceBlock,
    ...(notes.length > 0 ? ['', ...notes] : []),
  ].join('\n');
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

// ==================== 记忆源权威顺序（P0-1） ====================

/**
 * 记忆源权威顺序（最小口径，不做五源排序）：
 * 冲突时「谁算数」只有一个判据 —— **锁定成果块是结论的唯一权威**；
 * 账本只出索引与出处、不出结论；压缩记忆/摘要等缓存不得作为引用来源。
 *
 * 只在**条件注入段**使用（上游成果块注入 / 项目档案快照头），不做常驻注入：
 * 没有跨源冲突可能的轮次不该为它付 token。
 */
export const MEMORY_AUTHORITY_RULE = [
  '## 记忆源权威顺序（跨源冲突时按此裁决）',
  '1) 结论只认**锁定成果块**（本节点成果块被用户手动修正过时以用户修正为准）；',
  '2) 项目账本（.ledger/）提供索引、出处与既有结论/约定，但**与锁定成果块冲突时一律以锁定成果块为准**；',
  '3) 压缩记忆、对话摘要等缓存只用于理解上下文，**不得作为引用来源**；引用一律回原始出处（材料原文 / 上游成果块 / 本节点对话）。',
].join('\n');

/** 紧凑版（一行）：挂在项目档案快照头，随账本索引/材料清单一并给模型定调 */
export const MEMORY_AUTHORITY_BRIEF =
  '记忆源权威顺序：结论只认「锁定成果块」，账本/缓存与它冲突时以它为准；压缩记忆与摘要不得作为引用来源。';
