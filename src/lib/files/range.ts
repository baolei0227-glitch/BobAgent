/**
 * HTTP Range 解析与响应头构建（**纯函数**：不碰 fs / 不碰 HTTP）。
 *
 * 为什么单独一个文件：`/api/local-files` 与 `/api/projects` 两个 `file_proxy` 都要分段响应，
 * 抽成共用纯函数才能保证两端口径一致（尤其是 416 的 `Content-Range: bytes / * 写法`）。
 * 纯函数 ⇒ 可单测；两个路由只做「读 header → 调这里 → 组响应」。
 *
 * 只支持**单区间**：多区间（`bytes=0-1,5-6`）按 `null` 处理（浏览器媒体播放用不到多区间，
 * 强行支持会让正文组装复杂化且无收益）。
 */

/** 闭区间字节范围（含首尾） */
export interface ByteRange {
  /** 起点（含） */
  start: number;
  /** 终点（含） */
  end: number;
}

/**
 * 解析 `Range` 请求头（RFC 9110 §14.2 口径）。
 * - 返回 `null`            → **忽略** Range（无 Range / 非 `bytes` 单位 / 语法畸形 / 不支持的**多区间**）
 *                            ⇒ 调用方按**整份 200** 处理（并补 `Accept-Ranges`）
 * - 返回 `'unsatisfiable'` → 语法合法但**不可满足**（`start >= size`，或空文件取区间）
 *                            ⇒ 调用方按 **416** 处理
 * - 返回 `ByteRange`       → 按 **206** 处理（闭区间，已按文件大小钳位）
 *
 * 为什么畸形退 200 而非 416：RFC 规定畸形 range-set 应被**忽略**；416 只用于「合法但越界」。
 * 二者混淆会在遇到中间代理发的怪 Range 值时误报 416。
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const unit = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!unit) return null; // 非 bytes 单位，或 `bytes=` 空区间（畸形）⇒ 忽略
  const spec = unit[1].trim();
  if (spec.includes(',')) return null; // 多区间：语法合法但不支持 ⇒ 忽略（退整份）

  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return null; // 畸形
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null; // `bytes=-` 畸形

  // 空文件：任何区间都不可满足
  if (size <= 0) return 'unsatisfiable';

  // 后缀形式 bytes=-N：最后 N 字节
  if (rawStart === '') {
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null; // `-0` 等畸形 ⇒ 忽略
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start)) return null; // 畸形
  if (start >= size) return 'unsatisfiable'; // 合法但越界
  // 开区间 bytes=N-：到文件末尾
  if (rawEnd === '') return { start, end: size - 1 };

  const end = Number(rawEnd);
  if (!Number.isFinite(end)) return null; // 畸形
  if (end < start) return null; // 倒置 ⇒ 畸形 ⇒ 忽略
  return { start, end: Math.min(end, size - 1) };
}

/** 206 响应头（`Content-Type` 由调用方按扩展名另行补上） */
export function rangeHeaders(range: ByteRange, size: number): Record<string, string> {
  return {
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    'Content-Length': String(range.end - range.start + 1),
    'Accept-Ranges': 'bytes',
  };
}

/** 416 响应头（不满足的 Range） */
export function unsatisfiableHeaders(size: number): Record<string, string> {
  return {
    'Content-Range': `bytes */${size}`,
    'Accept-Ranges': 'bytes',
  };
}
