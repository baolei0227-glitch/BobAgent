/**
 * 用户记忆的**纯常量与类型**（无任何 Node 依赖）。
 *
 * 为什么单独成文件：记忆面板 `components/butler/ButlerMemoryPanel.tsx` 是客户端组件，
 * 需要六类词表与常驻档名单做分组展示；而 `preferences.ts` 含 fs 读写与 app-root 解析，
 * 客户端链路无法 bundle（Turbopack 报 Can't resolve 'fs/promises'）。故把纯数据抽到这里，
 * 服务端（preferences.ts 转出）与客户端（面板直接 import）共用同一份定义，避免两处词表漂移。
 */

/** 一条用户记忆（结构化字段说明见 preferences.ts 文件头） */
export interface UserPreference {
  /** 序号（1-based，列表中位置；删除时用） */
  index: number;
  /** 记忆内容（一句话） */
  content: string;
  /** 类型分类（六类词表见 MEMORY_TYPES，缺省「通用」） */
  type: string;
  /** 记录时间（YYYY-MM-DD HH:mm，无元数据的历史条目为空串） */
  createdAt: string;
  /** 记录来源（默认 chat；标识哪次对话触发写入） */
  source: string;
}

/**
 * 记忆类型词表（六类；缺省「通用」）。写入时由模型选择，用于注入分档与检索过滤。
 * 保持稳定：改词表等于改存量数据的分类语义，需同步 ALWAYS_INJECTED_TYPES 与工具描述。
 */
export const MEMORY_TYPES = [
  '身份画像',
  '偏好习惯',
  '工作上下文',
  '事实经历',
  '目标计划',
  '关系边界',
] as const;

/** 常驻档类型：每轮注入正文（条数少、每轮都用，漏掉就不像「记得你」）。
 *  **数组顺序 = 优先级**（靠前的更该保常驻），[0] 是「身份画像」——它掉了最不像「记得你」。 */
export const ALWAYS_INJECTED_TYPES: readonly string[] = ['身份画像', '偏好习惯'];

/** 常驻档安全阀：常驻档条目**合计**上限，避免 token 无上限增长（超限按类型逐级退化，见下） */
export const ALWAYS_INJECTED_MAX = 20;

/**
 * 安全阀判定（纯函数）：给定各类型条数，选出本轮仍**注入正文**的常驻档类型。
 *
 * 为什么不是「整体退化」（2026-10-02 改）：此前只要 `身份画像 + 偏好习惯` 合计超上限，
 * **连身份画像也一起掉进目录档** —— 用户会突然感觉「它不记得我了」，而这恰恰是常驻档存在的理由。
 * 现在取 `alwaysTypes` 的**优先级前缀**：从高到低逐级纳入，某一级放不下就**到此为止**
 * （不跳过去纳更低优先级——否则会出现「低的在常驻档、高的反而在目录档」的倒挂）。
 * 空条数的类型不占额度、也不打断前缀。
 *
 * 粒度是**整类型**而不是「留前 K 条」：同类型条目一起进退，口径才好解释、也才好向用户交代。
 * 返回的类型里没有谁，其条目由调用方并入目录档（**数据不丢**，只是不再每轮注入正文）。
 */
export function selectResidentTypes(
  counts: Record<string, number>,
  alwaysTypes: readonly string[] = ALWAYS_INJECTED_TYPES,
  max: number = ALWAYS_INJECTED_MAX,
): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const t of alwaysTypes) {
    const n = counts[t] ?? 0;
    if (n <= 0) continue; // 没有条目 → 不占额度，也不打断前缀
    if (used + n > max) break; // 这一级放不下 → 其后（优先级更低）一律不进常驻档
    kept.push(t);
    used += n;
  }
  return kept;
}

/**
 * 同类型条目相似度门限：命中则拒绝追加，倒逼模型改走 update_preference（防同一事实换措辞重复累积）。
 * 保守起步（0.5）：false positive（拦住合法新条目）比 false negative（漏放重复）更扰人，先观察再调。
 */
export const CONFLICT_SIMILARITY_THRESHOLD = 0.5;

/**
 * 否定式表达识别（纯函数，BobWork 轻量化管家方案 v6 §4.2 / ⑧）。
 *
 * 判据落在「**能否确定执行 + 是否存在中间态**」，不落在语气强弱：
 * 「回复里不要用感叹号」是硬约束（→ 规则）；「我不太喜欢很长的回复」是倾向（→ 偏好）。
 * 只认能确定执行的显式否定标记；倾向表达不含标记，自然判 false。
 * 「别」需避开「特别 / 区别 / 识别 / 别人 / 别的」等常见非否定词。
 *
 * 为何放在本模块（lib/core）而非 lib/butler：`preferences.ts` 要在**存储层**用它在写入前拒收，
 * 而 lib/core 不 import lib/butler（避免耦合）。本模块无任何 Node 依赖，客户端亦可引用。
 */
const NEGATION_PATTERNS: readonly RegExp[] = [
  /不要/,
  /禁止/,
  /不准/,
  /不许/,
  /严禁/,
  /不得/,
  /勿/,
  // 「别」：前不接「特区识辨差分级类个」，后不接「人的处家名」
  /(?<![特区识辨差分级类个])别(?!人|的|处|家|名)/,
];

export function detectNegation(text: string): boolean {
  const s = typeof text === 'string' ? text : '';
  if (!s) return false;
  return NEGATION_PATTERNS.some((re) => re.test(s));
}

// ==================== 文本相似度（纯函数） ====================
// 原本在 preferences.ts（含 fs 与 app-root 解析）。迁移到这里的原因：规则的软通道裁决
// （lib/butler/rule-decision.ts）是**纯函数**，要复用同一份相似度口径，不能因此把 fs
// 副作用拖进可单测的裁决层。preferences.ts 原样 re-export，既有导入路径不变。

/** 归一化：去空白 / 标点 / 符号，统一小写（中英混排可比；保留中文、字母、数字） */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 字符 bigram 集合（不引分词依赖；单字符文本回退为单字符，保证非空） */
export function charBigrams(s: string): Set<string> {
  const n = normalizeForCompare(s);
  const grams = new Set<string>();
  if (n.length <= 1) {
    if (n) grams.add(n);
    return grams;
  }
  for (let i = 0; i < n.length - 1; i++) grams.add(n.slice(i, i + 2));
  return grams;
}

/**
 * 文本相似度（overlap coefficient = |A∩B| / min(|A|,|B|)，字符 bigram）。
 * 用 overlap 而非 Jaccard：记忆条目常是一长一短的包含 / 细化关系，Jaccard 会漏掉「短串被长串包含」。
 * 局限：纯字面相似，能抓「同一事实换措辞」，抓不了语义级反转（如「喜欢猫」vs「讨厌猫」几乎无重叠）。
 */
export function similarity(a: string, b: string): number {
  const A = charBigrams(a);
  const B = charBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0;
  for (const g of small) if (large.has(g)) inter++;
  return inter / small.size;
}