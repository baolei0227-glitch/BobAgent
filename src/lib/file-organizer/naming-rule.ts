/**
 * 命名规则 —— 纯函数、零依赖，设置界面与 tools/organize 共用同一份定义。
 *
 * 用户可在设置里按「受控选项」调整文件名形态：
 *   字段顺序（主题 / 版本号 / 日期，三个位置各一个下拉，任选）× 分隔符（_ - 空格 无）× 版本号补零位数
 * 「拼名」与「反解」共用同一份规则：order 决定字段先后，其余选项只影响外观，
 * 因此无论怎么改都能从既有文件名读回「版本号 + 主题」，版本累加不会失效。
 *
 * 默认形态：房屋租赁合同v01_2026-09-12.pdf
 *   版本号 = 同主题既有文件的最大序号 +1（新主题首份若文档自带版本标识则采纳）
 *   主题   = 模型输出，已清理非法字符
 *   日期   = 执行整理的当天（本地时区），由代码填
 */

/** 文件名中的三个字段 */
export type NameSlot = 'version' | 'topic' | 'date';

export interface NamingRule {
  /** 字段排列顺序；必须恰好包含三个字段各一次 */
  order: NameSlot[];
  /** 字段之间的分隔符（空字符串 = 不设分隔符） */
  separator: string;
  /** 版本号补零位数：1 → v1，2 → v01，3 → v001 */
  padVersion: number;
}

/** 默认规则：主题 + 版本号 + 日期 */
export const DEFAULT_NAMING: NamingRule = {
  order: ['topic', 'version', 'date'],
  separator: '_',
  padVersion: 2,
};

/** 三个字段的全集（设置界面每个位置的下拉选项） */
export const SLOTS: NameSlot[] = ['version', 'topic', 'date'];

/** 把某个位置换成指定字段：该字段若已在别处，则与那个位置互换，始终保持三字段各一次 */
export function setSlotAt(order: NameSlot[], index: number, slot: NameSlot): NameSlot[] {
  const next = [...order];
  const from = next.indexOf(slot);
  if (from === -1) {
    next[index] = slot;
    return next;
  }
  [next[index], next[from]] = [next[from], next[index]];
  return next;
}

/** 分隔符可选值（'' = 无分隔符，UI 上显示为「None」） */
export const SEPARATOR_OPTIONS = ['_', '-', ' ', ''] as const;

/** 版本号补零可选值 */
export const PAD_OPTIONS = [2, 1, 3] as const;

export const SLOT_LABELS: Record<NameSlot, string> = {
  version: 'Version',
  topic: 'Topic',
  date: 'Date',
};

/** 归一化：缺省/非法字段回退默认值，保证拼名与反解永远拿到一份合法规则 */
export function normalizeNaming(raw?: Partial<NamingRule> | null): NamingRule {
  const list = Array.isArray(raw?.order) ? raw!.order.filter((s) => SLOTS.includes(s)) : [];
  const order = Array.from(new Set(list)); // 去重：防止手改 settings.json 写出重复字段
  const separator = typeof raw?.separator === 'string' && (SEPARATOR_OPTIONS as readonly string[]).includes(raw.separator)
    ? raw.separator
    : DEFAULT_NAMING.separator;
  const pad = Number(raw?.padVersion);
  return {
    order: order.length === SLOTS.length ? order : [...DEFAULT_NAMING.order],
    separator,
    padVersion: Number.isInteger(pad) && pad >= 1 && pad <= 3 ? pad : DEFAULT_NAMING.padVersion,
  };
}

/** 是否等于默认规则（用于设置界面提示，以及「默认不落盘」判定） */
export function isDefaultNaming(rule: NamingRule): boolean {
  return rule.separator === DEFAULT_NAMING.separator
    && rule.padVersion === DEFAULT_NAMING.padVersion
    && rule.order.join('|') === DEFAULT_NAMING.order.join('|');
}

/** 版本号文本 */
export function formatVersion(n: number, pad: number = DEFAULT_NAMING.padVersion): string {
  return `v${String(n).padStart(pad, '0')}`;
}

/** 本地时区的 YYYY-MM-DD（命名中的「日期」字段） */
export function todayStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 字段间的连接符：版本号与主题恒紧贴（v01合同），其余用所选分隔符 */
function gap(a: NameSlot, b: NameSlot, separator: string): string {
  return [a, b].sort().join('|') === 'topic|version' ? '' : separator;
}

/** 拼名（不含扩展名） */
export function composeName(rule: NamingRule, stamp: string, topic: string, versionIndex: number): string {
  const values: Record<NameSlot, string> = {
    version: formatVersion(versionIndex, rule.padVersion),
    topic,
    date: stamp,
  };
  let name = '';
  rule.order.forEach((slot, i) => {
    if (i > 0) name += gap(rule.order[i - 1], slot, rule.separator);
    name += values[slot];
  });
  return name;
}

/** 反解正则：由规则派生，捕获组顺序 = rule.order */
function nameRegex(rule: NamingRule): RegExp {
  const patterns: Record<NameSlot, string> = {
    version: '(v\\d{1,3})',
    topic: '(.+)',
    date: '(\\d{4}-\\d{2}-\\d{2})',
  };
  let src = '^';
  rule.order.forEach((slot, i) => {
    if (i > 0) src += gap(rule.order[i - 1], slot, rule.separator).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    src += patterns[slot];
  });
  return new RegExp(src + '$');
}

/** 从文件名（不含扩展名）反解「版本号 + 主题」；不符合当前规则时返回 null */
export function parseName(
  base: string,
  rule: NamingRule = DEFAULT_NAMING,
): { version: number; topic: string } | null {
  const m = nameRegex(rule).exec(base);
  if (!m) return null;
  const got: Partial<Record<NameSlot, string>> = {};
  rule.order.forEach((slot, i) => { got[slot] = m[i + 1]; });
  return { version: Number((got.version ?? '').replace(/\D/g, '')) || 0, topic: got.topic ?? '' };
}

/** 规则预览（设置界面用）：用占位主题与给定日期拼一个示例名 */
export function previewName(rule: NamingRule, stamp: string, topic = '房屋租赁合同', versionIndex = 1): string {
  return `${composeName(rule, stamp, topic, versionIndex)}.pdf`;
}
