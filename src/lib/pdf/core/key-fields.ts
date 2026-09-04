/**
 * 关键字段完整性校验（质量信号增强）
 *
 * 背景：通用 qualityScore 是启发式的（字符密度/有效汉字比例），判断不了"语义上该有的字段
 * 是否提取到了"。对法律/财务文书，金额、日期、编号、电话这类关键字段比字符密度可靠得多。
 *
 * 用法：
 *   - keyFieldCompleteness(text) → { score, present, missing }
 *     score 只统计"文本里出现了字段提示词"的字段（未出现的字段不计入分母，避免误判）；
 *     任何提示词出现但值缺失 → 该字段计入 missing → score < 1。
 *   - 接入方（ocr-service 的 shouldUpgradeWithVlm）：missing.length > 0 视为低质，触发升级
 */
export interface KeyFieldResult {
  /** 0~1：检测到的字段中，值完整的比例（无字段提示词时为 1，即"无字段场景视为完整"） */
  score: number;
  /** 值完整的字段 key 列表 */
  present: string[];
  /** 提示词出现但值缺失的字段 key 列表 */
  missing: string[];
}

interface KeyFieldRule {
  key: string;
  label: string;
  /** 文本中出现该提示词时，才认为"该字段应当存在" */
  hint: RegExp;
  /** 该字段的值提取规则 */
  value: RegExp;
}

/** 常见法律/财务关键字段（金额含大写，编号兼容中文/英文前缀，日期兼容常见分隔）。
 *  hint 收紧为"提示词 + 分隔符（：/:/空格）或强符号（￥¥、No.）"，避免正文散文误触发
 *  （如"本合同不涉及金额条款"不会命中"金额"）。 */
const KEY_FIELD_RULES: KeyFieldRule[] = [
  {
    key: 'amount',
    label: '金额',
    hint: /[￥¥]|(?:合计|总计|金额|总价|大写|小写)[：: ]/,
    value: /[￥¥]\s*[\d,]+(?:\.\d{1,2})?|(?:合计|总计|金额|总价)[：:\s]*[\d,]+(?:\.\d{1,2})?|壹贰叁肆伍陆柒捌玖拾佰仟万亿/,
  },
  {
    key: 'date',
    label: '日期',
    hint: /(?:签署|签订|出具|生效)?日期[：: ]|年月日[：: ]/,
    value: /\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?/,
  },
  {
    key: 'id',
    label: '编号',
    hint: /No\.?|(?:编号|号码|案号|合同号|发票号|订单号|收据号)[：: ]/i,
    value: /(?:编号|No\.?|号码|案号|合同号|发票号|订单号|收据号)[：:\s]*[\w-]{4,}/i,
  },
  {
    key: 'phone',
    label: '电话',
    hint: /(?:电话|联系电话|手机|联系方式)[：: ]/,
    value: /1[3-9]\d{9}/,
  },
];

/** 提取文本中检测到的关键字段值（供诊断/展示） */
export function extractKeyFields(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const rule of KEY_FIELD_RULES) {
    const hits: string[] = [];
    const re = new RegExp(rule.value.source, rule.value.flags.includes('g') ? rule.value.flags : rule.value.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push(m[0]);
      if (hits.length >= 5) break;
    }
    if (hits.length > 0) out[rule.key] = hits;
  }
  return out;
}

/** 关键字段完整性评分：提示词出现但值缺失 → missing，score < 1 */
export function keyFieldCompleteness(text: string): KeyFieldResult {
  const present: string[] = [];
  const missing: string[] = [];
  for (const rule of KEY_FIELD_RULES) {
    if (!rule.hint.test(text)) continue; // 未提示该字段 → 不计入（避免无关页面误判）
    if (rule.value.test(text)) present.push(rule.key);
    else missing.push(rule.key);
  }
  const total = present.length + missing.length;
  return {
    score: total === 0 ? 1 : present.length / total,
    present,
    missing,
  };
}
