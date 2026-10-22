/**
 * Daily News —— 数据模型（纯类型 / 常量 / 归一化，无 I/O，可被客户端引用）
 *
 * 产品定位（方案 A，2026-10-04 定稿）：Butler Today 面板的第 4 个页签 `News`。
 *   - 主题（topic）是**结构化的**：每个主题自带检索词 / 条数 / 语言 —— 不复用 Memories
 *     （Memories 是自由文本、每轮注入耗 token，且否定式会被拦成规则）。
 *   - 主题数软上限 8：超出不报错，只在界面提示合并（配置本身照存）。
 *   - 每条新闻 = 一句话总结 + 一句 why + 来源域 + 原文链接；总结优先基于检索一并带回的正文
 *     （generate.ts 用 Search 的 need_content 取正文），正文缺失时回退检索摘要（snippet）。
 *
 * 本文件刻意不碰 fs / server-only 依赖：前端面板与 Butler 工具都能安全 import 这里的常量。
 */

/** 单个主题：检索词 + 条数 + 语言 */
export interface NewsTopic {
  /** 稳定 id（由 label 派生的 slug，用于 React key 与去重） */
  id: string;
  /** 展示名（英文标签，如 "Tech"） */
  label: string;
  /** 检索词（搜什么，可中文） */
  query: string;
  /** 该主题产出条数（1–6，默认 4） */
  limit: number;
  /** 归纳语言提示（zh/en） */
  lang: 'zh' | 'en';
  /** 该主题的策展新闻源（RSS/Atom）；留空则查内置策展表，仍为空则回退关键词搜索 */
  feeds?: string[];
  /** 该主题的权威站域名（多为无 RSS 的领域权威渠道）；留空则查内置权威站表 */
  sites?: string[];
}

/** 新闻主题配置（落 butler/.state/news/config.json） */
export interface NewsConfig {
  topics: NewsTopic[];
  /** 最近一次保存时间（ISO）；空串 = 从未保存过（用的默认预设） */
  updatedAt: string;
}

/** 单条新闻 */
export interface NewsItem {
  /** 在该份简报内的稳定 id（主题序号 + 结果序号） */
  id: string;
  /** 所属主题 id */
  topicId: string;
  /** 所属主题展示名 */
  topicLabel: string;
  title: string;
  /** 一句话总结（模型归纳；降级时为检索摘要片段） */
  summary: string;
  /** 一句 why（模型归纳：为什么值得看；降级时为空） */
  why: string;
  /** 来源域名 */
  source: string;
  /** 原文链接 */
  url: string;
}

/**
 * 当日简报（落 butler/.state/news/briefing-YYYY-MM-DD.json）。
 *
 * `summarized=false` = 降级态（LLM 不可用 / 超时 / 解析失败）：此时只有链接列表，
 * 界面标注 "Not summarized" —— **绝不留半截空壳**（要么有归纳，要么明确标注没归纳）。
 */
export interface NewsBriefing {
  /** 归属日期（本地 YYYY-MM-DD） */
  date: string;
  generatedAt: string;
  /** 顶部 AI「今日看点」总述（降级时为空串） */
  overview: string;
  items: NewsItem[];
  /** true=已归纳；false=降级（纯链接列表） */
  summarized: boolean;
  /** 采集失败 / 无结果的主题展示名（界面可提示，不阻断其余主题） */
  degradedTopics: string[];
}

/** 主题数软上限：超出不报错，界面提示合并 */
export const NEWS_TOPIC_SOFT_MAX = 8;
/** 全篇条目封顶（每主题 Top 3–5，全篇不超过 8 条） */
export const NEWS_ITEM_CAP = 8;
/** 单主题条数上限 / 下限 */
export const NEWS_TOPIC_LIMIT_MAX = 6;
export const NEWS_TOPIC_LIMIT_MIN = 1;
/** 单主题默认条数 */
const DEFAULT_TOPIC_LIMIT = 4;

/** 默认预设主题（首次打开即有用；用户可在 News 页头 chips 增删） */
export const DEFAULT_NEWS_TOPICS: NewsTopic[] = [
  { id: 'tech', label: 'Tech', query: '科技 人工智能 最新进展', limit: 4, lang: 'zh' },
  { id: 'finance', label: 'Finance', query: '金融市场 财经 最新动态', limit: 4, lang: 'zh' },
  { id: 'legal', label: 'Legal', query: '法律法规 司法 最新动态', limit: 4, lang: 'zh' },
];

/**
 * 内置策展新闻源（按主题 slug id）。
 *
 * 只有**实测可用**的源才进这张表（2026-10-04 验证）：
 *   - Tech：ifanr / ithome / sspai —— 均为真 feed（application/rss+xml 或 text/xml）且有当日更新；
 *   - Finance：中新网财经 —— chinanews 分区 feed，30 条 / 有当日更新。
 * 其余一律**不进表**（Google News / BBC / RSSHub 不可达；Bing 的 format=RSS 已失效；法律类无任何可用源）
 * —— 没有源的主题自然回退到关键词搜索，不做无米之炊。
 *
 * 用 id 而非内联默认主题的原因：兼容已经落盘的旧 config.json（无 feeds 字段）——
 * 老配置里的 tech / finance 也能直接吃到 RSS，无需用户重新保存主题。
 */
export const CURATED_TOPIC_FEEDS: Record<string, string[]> = {
  tech: ['https://www.ifanr.com/feed', 'https://www.ithome.com/rss/', 'https://sspai.com/feed'],
  finance: ['https://www.chinanews.com.cn/rss/finance.xml'],
};

/** 主题的新闻源：优先用主题自带的 feeds，其次查内置策展表；都没有则空数组（调用方回退关键词搜索） */
export function feedsForTopic(topic: NewsTopic): string[] {
  if (topic.feeds && topic.feeds.length > 0) return topic.feeds;
  return CURATED_TOPIC_FEEDS[topic.id] ?? [];
}

/**
 * 内置权威站表（按主题 slug id）—— 与 CURATED_TOPIC_FEEDS 的分工：
 *   - feeds：有 RSS 的策展源，采集**第一级**；
 *   - sites：该领域的权威站**域名**，采集**第二级** —— 用 `site:<domain>` 定向检索。
 *
 * 为什么需要 sites：权威渠道里有相当一部分没有 RSS（法院 / 检察院 / 司法部等），
 * 只能靠站内定向检索兜住。域名容错 http(s) 前缀与路径，归一化时会被剥掉。
 */
export const CURATED_TOPIC_SITES: Record<string, string[]> = {
  tech: ['36kr.com', 'ifanr.com', 'ithome.com', 'sspai.com', 'jiqizhixin.com', 'qbitai.com'],
  finance: ['caixin.com', 'yicai.com', 'stcn.com', 'cs.com.cn', '21jingji.com'],
  legal: ['court.gov.cn', 'spp.gov.cn', 'moj.gov.cn', 'legaldaily.com.cn'],
};

/** 主题的权威站：优先用主题自带的 sites，其次查内置权威站表；都没有则空数组（调用方回退裸关键词搜索） */
export function sitesForTopic(topic: NewsTopic): string[] {
  if (topic.sites && topic.sites.length > 0) return topic.sites;
  return CURATED_TOPIC_SITES[topic.id] ?? [];
}

/** label → 稳定 slug（小写、非字母数字转连字符）；空则回退 'topic' */
export function slugifyTopic(label: string): string {
  const s = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'topic';
}

/** 在已占用集合中生成唯一 id（重复时追加 -2 / -3 …） */
function uniqueTopicId(label: string, taken: Set<string>): string {
  const base = slugifyTopic(label);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

/** 每主题的源上限（feeds 与 sites 同口径，防配置膨胀）；前端源编辑面板按此封顶 */
export const TOPIC_SOURCE_MAX = 6;

/** 新闻源归一化：只保留合法 http(s) URL，去重，上限 6 条（防配置膨胀） */
function normalizeFeeds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const u of raw) {
    if (typeof u !== 'string') continue;
    const s = u.trim();
    if (!/^https?:\/\//i.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= TOPIC_SOURCE_MAX) break;
  }
  return out;
}

/**
 * 权威站归一化：宽容接受「裸域名 / 带协议 / 带路径」的写法，统一剥成裸域名（小写、去 www.）后去重。
 * 非法项（含空格 / 无点 / 非域名字符）直接丢弃 —— 与 normalizeFeeds 的「非法即丢」口径一致。
 */
function normalizeSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string') continue;
    const d = s
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/^www\./, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || out.includes(d)) continue;
    out.push(d);
    if (out.length >= TOPIC_SOURCE_MAX) break;
  }
  return out;
}

/** 单主题归一化：校验字段、夹取条数、补 id / query / lang；label 为空则丢弃（返回 null） */
function normalizeTopic(raw: unknown, taken: Set<string>): NewsTopic | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label.trim() : '';
  if (!label) return null;
  const rawLimit = typeof o.limit === 'number' ? o.limit : Number(o.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(NEWS_TOPIC_LIMIT_MAX, Math.max(NEWS_TOPIC_LIMIT_MIN, Math.round(rawLimit)))
    : DEFAULT_TOPIC_LIMIT;
  const query = (typeof o.query === 'string' ? o.query.trim() : '') || label;
  const lang: 'zh' | 'en' = o.lang === 'en' ? 'en' : o.lang === 'zh' ? 'zh' : /[\u4e00-\u9fa5]/.test(query) ? 'zh' : 'en';
  const rawId = typeof o.id === 'string' ? o.id.trim() : '';
  const id = rawId && !taken.has(rawId) ? rawId : uniqueTopicId(label, taken);
  taken.add(id);
  // 与既有口径一致：为空则**不落键**（旧 config 与默认预设的字段逐字不变）
  const topic: NewsTopic = { id, label, query, limit, lang };
  const feeds = normalizeFeeds(o.feeds);
  if (feeds.length > 0) topic.feeds = feeds;
  const sites = normalizeSites(o.sites);
  if (sites.length > 0) topic.sites = sites;
  return topic;
}

/**
 * 归一化一份配置（容错读盘 / 接口入参）：
 * 非法项丢弃；结果为空则回退默认预设；最多保留 2×软上限（防无限膨胀，界面另有软上限提示）。
 */
export function normalizeNewsConfig(raw: unknown): NewsConfig {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(src.topics) ? src.topics : [];
  const taken = new Set<string>();
  const topics: NewsTopic[] = [];
  const hardMax = NEWS_TOPIC_SOFT_MAX * 2;
  for (const t of list) {
    if (topics.length >= hardMax) break;
    const n = normalizeTopic(t, taken);
    if (n) topics.push(n);
  }
  if (topics.length === 0) {
    // 默认预设也走同一套 id 生成，避免与用户手改后的 id 冲突
    const taken2 = new Set<string>();
    for (const t of DEFAULT_NEWS_TOPICS) {
      const n = normalizeTopic(t, taken2);
      if (n) topics.push(n);
    }
  }
  const updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : '';
  return { topics, updatedAt };
}
