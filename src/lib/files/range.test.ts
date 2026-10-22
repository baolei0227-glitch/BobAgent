import { describe, expect, it } from 'vitest';
import { parseRange, rangeHeaders, unsatisfiableHeaders } from '@/lib/files/range';

/**
 * Range 解析是纯函数，也是 206/416 分支的**唯一判据**——分段响应错在这里会静默给出错误字节数。
 * 口径（RFC 9110 §14.2）：畸形 Range **忽略**（→ null ⇒ 200）；合法但越界 → 'unsatisfiable'（⇒ 416）。
 * 覆盖：无 Range / 非 bytes 单位 / 开区间 / 后缀区间 / 越界 / 倒置 / 多区间 / 空文件 / 钳位。
 * 注意：判据要**互为独立见证**——每条既断言返回形态，也断言具体数值。
 */
describe('parseRange', () => {
  it('无 Range → null（走整份 200）', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  it('非 bytes 单位 / 畸形语法 → null（忽略，退整份 200）', () => {
    expect(parseRange('items=0-10', 1000)).toBeNull();
    expect(parseRange('bytes=', 1000)).toBeNull();
    expect(parseRange('bytes=abc', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('bytes=100-50', 1000)).toBeNull(); // 倒置
    expect(parseRange('bytes=-0', 1000)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull(); // 多区间不支持
  });

  it('闭区间 bytes=0-99 → {0,99}；大小写不敏感', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('BYTES=200-299', 1000)).toEqual({ start: 200, end: 299 });
  });

  it('开区间 bytes=0- → 到文件末尾', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('后缀区间 bytes=-100 → 最后 100 字节；bytes=-5000 → 全文件', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('终点超界 → 钳到 size-1', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('合法但越界（start >= size）→ unsatisfiable（416）', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=1000-1099', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=2000-3000', 1000)).toBe('unsatisfiable');
  });

  it('空文件（size=0）：区间请求 → unsatisfiable；无 Range 仍 null', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable');
    expect(parseRange(null, 0)).toBeNull();
  });
});

describe('rangeHeaders', () => {
  it('206：Content-Range / Content-Length / Accept-Ranges 三者口径一致', () => {
    const h = rangeHeaders({ start: 0, end: 99 }, 1000);
    expect(h['Content-Range']).toBe('bytes 0-99/1000');
    expect(h['Content-Length']).toBe('100'); // 闭区间 ⇒ end-start+1
    expect(h['Accept-Ranges']).toBe('bytes');
  });

  it('单字节区间 content-length = 1', () => {
    expect(rangeHeaders({ start: 5, end: 5 }, 10)['Content-Length']).toBe('1');
  });
});

describe('unsatisfiableHeaders', () => {
  it('416：Content-Range 用 */size（无 start-end）', () => {
    expect(unsatisfiableHeaders(1000)['Content-Range']).toBe('bytes */1000');
  });
});
