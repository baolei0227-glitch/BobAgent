/**
 * Daily News —— 落盘读写（server-only）
 *
 * 目录：`<APP_ROOT>/butler/.state/news/`
 *   config.json                  # 主题配置（topics[]）
 *   briefing-YYYY-MM-DD.json     # 当日简报（结构化；文件名含日期 → 跨天自然失效）
 *
 * 「每日一次」的判据就是**当日简报文件是否存在**（与 daily-tasks 的 digest-YYYY-MM-DD.md 同口径）：
 * 存在即视为今天已生成，非强制调用直接读缓存、不重算；改主题当天也不重写，
 * 由界面上的 Refresh now 触发强制重算（见 generate.ts 的 force）。
 *
 * 全部经 atomicWriteFile 落盘 + 进程内串行锁（与 butler 其余 store 同构）。
 */
import { promises as fs } from 'fs';
import { join } from 'path';
import { STATE_DIR, dateStamp } from '@/lib/butler/storage';
import { atomicWriteFile, createLock } from '@/lib/butler/fs-atomic';
import {
  normalizeNewsConfig,
  type NewsBriefing,
  type NewsConfig,
  type NewsTopic,
} from './types';

/** 新闻内部状态目录：butler/.state/news */
const NEWS_DIR = join(STATE_DIR, 'news');
const CONFIG_FILE = join(NEWS_DIR, 'config.json');

/** 当日简报文件路径（dateKey 缺省 = 今天，本地时区） */
export function briefingPath(dateKey?: string): string {
  return join(NEWS_DIR, `briefing-${dateKey ?? dateStamp(new Date())}.json`);
}

const withConfigLock = createLock();

/**
 * 读主题配置；无文件 / 损坏 → 默认预设（归一化保证永远返回可用配置）。
 */
export async function readNewsConfig(): Promise<NewsConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    return normalizeNewsConfig(JSON.parse(raw) as unknown);
  } catch {
    return normalizeNewsConfig(null);
  }
}

/**
 * 保存主题配置（归一化后落盘；updatedAt 由本函数统一写入）。
 * 读-改-写被串行化，避免并发保存互相覆盖。
 */
export async function writeNewsConfig(topics: unknown): Promise<NewsConfig> {
  return withConfigLock(async () => {
    const normalized = normalizeNewsConfig({ topics, updatedAt: new Date().toISOString() });
    await fs.mkdir(NEWS_DIR, { recursive: true });
    await atomicWriteFile(CONFIG_FILE, JSON.stringify(normalized, null, 2));
    return normalized;
  });
}

/** 便捷：追加一个主题并保存（label 必需，query 缺省用 label） */
export async function addNewsTopic(input: { label: string; query?: string; limit?: number; lang?: 'zh' | 'en' }): Promise<NewsConfig> {
  const cfg = await readNewsConfig();
  const topics: NewsTopic[] = [
    ...cfg.topics,
    {
      id: '', // 交给归一化生成稳定 slug
      label: input.label,
      query: input.query || input.label,
      limit: input.limit ?? 4,
      lang: input.lang ?? (/[\u4e00-\u9fa5]/.test(input.query || input.label) ? 'zh' : 'en'),
    } as NewsTopic,
  ];
  return writeNewsConfig(topics);
}

/** 便捷：按 label / id / query 匹配移除一个主题（命中多个时全部移除） */
export async function removeNewsTopic(key: string): Promise<{ config: NewsConfig; removed: number }> {
  const cfg = await readNewsConfig();
  const k = key.trim().toLowerCase();
  const kept = cfg.topics.filter((t) => {
    const hit = t.id.toLowerCase() === k || t.label.toLowerCase() === k || t.query.toLowerCase() === k
      || t.label.toLowerCase().includes(k);
    return !hit;
  });
  const removed = cfg.topics.length - kept.length;
  const config = removed > 0 ? await writeNewsConfig(kept) : cfg;
  return { config, removed };
}

/** 读某日简报；无文件 / 损坏 / 结构非法 → null */
export async function readNewsBriefing(dateKey?: string): Promise<NewsBriefing | null> {
  try {
    const raw = await fs.readFile(briefingPath(dateKey), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const b = parsed as Partial<NewsBriefing>;
    if (!Array.isArray(b.items)) return null;
    return {
      date: typeof b.date === 'string' ? b.date : (dateKey ?? dateStamp(new Date())),
      generatedAt: typeof b.generatedAt === 'string' ? b.generatedAt : '',
      overview: typeof b.overview === 'string' ? b.overview : '',
      items: b.items,
      summarized: b.summarized === true,
      degradedTopics: Array.isArray(b.degradedTopics) ? (b.degradedTopics as string[]) : [],
    };
  } catch {
    return null;
  }
}

/** 写当日简报（原子写） */
export async function writeNewsBriefing(briefing: NewsBriefing): Promise<void> {
  await fs.mkdir(NEWS_DIR, { recursive: true });
  await atomicWriteFile(briefingPath(briefing.date), JSON.stringify(briefing, null, 2));
}
