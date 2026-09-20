/**
 * 话题关键词表（多端共用）。
 *
 * 原为 XhsCard 内 `autoTag` 的私有映射表；微博 target 需要同一份关键词表来推导
 * `#话题#`（方案 §5.4「复用 autoTag 的关键词表」），故提到 lib 层由两端共用，
 * 避免两份规则各自漂移。
 */

/** 关键词 → 话题标签（按表顺序匹配） */
export const TOPIC_KEYWORDS: Array<[RegExp, string]> = [
  [/合同|合约|签署|违约/, '合同'],
  [/劳动|工伤|赔偿|裁员|辞退/, '劳动'],
  [/离婚|婚姻|彩礼|抚养/, '婚姻'],
  [/借款|借贷|欠款|还款|民间借贷/, '借贷'],
  [/侵权|名誉|肖像|骚扰/, '侵权'],
  [/刑事|犯罪|量刑|取保/, '刑事'],
  [/房产|房屋|买房|卖房/, '房产'],
  [/租赁|房东|租金/, '租赁'],
  [/公司|股权|股东|合伙|法定代表人/, '公司'],
  [/交通|事故|车祸|碰撞/, '交通'],
  [/继承|遗嘱|遗产/, '继承'],
];

/** 单标签：命中第一个规则即返回；无命中返回 fallback */
export function autoTopic(text: string, fallback: string): string {
  const t = text || '';
  for (const [re, tag] of TOPIC_KEYWORDS) {
    if (re.test(t)) return tag;
  }
  return fallback;
}

/** 标题里可当话题的短语（按标点/空白切分，取长度合适的整段，不硬切词） */
const TITLE_SPLIT = /[，。！？；：、,.!?;:\s|｜/／\\()（）【】[\]《》<>"'“”]+/;
const TOPIC_MIN = 2;
const TOPIC_MAX_LEN = 12;

/**
 * 多标签（微博 `#话题#` 栏）：
 * 先收集关键词表命中的全部标签，不足 `min` 个时用标题里的整段短语补齐，
 * 仍不足则退回 `fallback`。结果去重、保序、截到 `max` 个。
 */
export function extractTopics(text: string, min = 2, max = 4, fallback = '干货'): string[] {
  const src = text || '';
  const out: string[] = [];
  const push = (t: string) => {
    const v = t.trim();
    if (v && !out.includes(v)) out.push(v);
  };

  for (const [re, tag] of TOPIC_KEYWORDS) {
    if (re.test(src)) push(tag);
  }

  if (out.length < min) {
    for (const seg of src.split(TITLE_SPLIT)) {
      if (out.length >= min) break;
      if (seg.length >= TOPIC_MIN && seg.length <= TOPIC_MAX_LEN) push(seg);
    }
  }

  if (out.length === 0) push(fallback);
  return out.slice(0, max);
}
