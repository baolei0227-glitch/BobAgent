/**
 * 片段 fork 成独立主音频后的**来源记录**（落在新音频目录的 `.origin.json`）。
 *
 * 为什么需要它：fork 之后父级与新音频是**两条独立文档** —— 不记来源的话，重新打开新音频
 * 就只剩一个 `source.wav`，用户看不出它是从哪段录音的哪一段来的。
 * 记录只在 fork 时写一次；来源与区间都不随后续编辑变化（后续编辑只改新音频自己）。
 *
 * ⚠️ 本文件必须保持**纯数据**（不碰 fs）：客户端面包屑要用它的类型与类型守卫，
 * 一旦从这里值引入 `node:fs` 就会把服务端模块拖进浏览器包。
 */

export interface AudioOrigin {
  /** 原音频所在的 API 侧：project = 项目内文件；local = 本地绝对路径（库内/任意本地） */
  source: 'local' | 'project';
  /** 原音频路径（API 口径，绝对路径或项目相对路径） */
  sourcePath: string;
  /** 原音频展示名（fork 时屏幕上那个名字，直接用于面包屑） */
  sourceName: string;
  /** fork 的区间（相对原音频的秒） */
  start: number;
  /** fork 的区间终点（秒） */
  end: number;
  /** fork 时间（ISO） */
  createdAt: string;
}

/** `.origin.json` 的类型守卫：任何字段不合法都当“没有来源”，绝不因脏 sidecar 让编辑器报错 */
export function isAudioOrigin(value: unknown): value is AudioOrigin {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    (o.source === 'local' || o.source === 'project') &&
    typeof o.sourcePath === 'string' &&
    o.sourcePath.length > 0 &&
    typeof o.sourceName === 'string' &&
    o.sourceName.length > 0 &&
    typeof o.start === 'number' &&
    Number.isFinite(o.start) &&
    o.start >= 0 &&
    typeof o.end === 'number' &&
    Number.isFinite(o.end) &&
    o.end > o.start &&
    typeof o.createdAt === 'string'
  );
}
