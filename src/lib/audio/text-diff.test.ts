import { describe, expect, it } from 'vitest';
import { diffText } from '@/lib/audio/text-diff';

/**
 * 这组用例守的是**修订预览的可读性**：AI 改了几个字，用户就要在对照里看到几个字，
 * 不能把整句删了再整句插回来（那样等于没有修订，只是把原文盖掉）。
 */
describe('diffText（AI 修订对照）', () => {
  it('完全一致 → 单个 same（调用方据此不渲染修订条）', () => {
    expect(diffText('今天天气好', '今天天气好')).toEqual([{ type: 'same', text: '今天天气好' }]);
    expect(diffText('', '')).toEqual([]);
  });

  it('中文插一个字：只多出一段 ins，不整句重写', () => {
    expect(diffText('今天天气好', '今天天气很好')).toEqual([
      { type: 'same', text: '今天天气' },
      { type: 'ins', text: '很' },
      { type: 'same', text: '好' },
    ]);
  });

  it('中文删一个字：只多出一段 del', () => {
    expect(diffText('今天天气很好', '今天天气好')).toEqual([
      { type: 'same', text: '今天天气' },
      { type: 'del', text: '很' },
      { type: 'same', text: '好' },
    ]);
  });

  it('英文同样按字符比：只换一个词时只标出这个词', () => {
    const out = diffText('the weather is fine', 'the weather is bad');
    expect(out).toEqual([
      { type: 'same', text: 'the weather is ' },
      { type: 'del', text: 'fine' },
      { type: 'ins', text: 'bad' },
    ]);
  });

  it('标点/空白的变化也可见（去掉一个逗号）', () => {
    const out = diffText('先这样，再说', '先这样再说');
    expect(out).toEqual([
      { type: 'same', text: '先这样' },
      { type: 'del', text: '，' },
      { type: 'same', text: '再说' },
    ]);
  });

  it('相邻同类 op 合并（不产出碎片）', () => {
    const out = diffText('abcde', 'axcde');
    expect(out.filter((o) => o.type === 'del').map((o) => o.text)).toEqual(['b']);
    expect(out.filter((o) => o.type === 'ins').map((o) => o.text)).toEqual(['x']);
    // 还原性：same + ins 拼起来 = 新文本；same + del 拼起来 = 原文
    const rebuilt = out.filter((o) => o.type !== 'del').map((o) => o.text).join('');
    expect(rebuilt).toBe('axcde');
    const original = out.filter((o) => o.type !== 'ins').map((o) => o.text).join('');
    expect(original).toBe('abcde');
  });

  it('整段新增 / 整段删除', () => {
    expect(diffText('', '全新的句子')).toEqual([{ type: 'ins', text: '全新的句子' }]);
    expect(diffText('旧的句子', '')).toEqual([{ type: 'del', text: '旧的句子' }]);
  });

  it('超长文本退回"公共前后缀 + 中间整块"（不卡 UI，仍能还原两边）', () => {
    const before = '开头' + '甲'.repeat(40) + '结尾';
    const after = '开头' + '乙'.repeat(40) + '结尾';
    const out = diffText(before, after, 10);
    expect(out[0]).toEqual({ type: 'same', text: '开头' });
    expect(out[out.length - 1]).toEqual({ type: 'same', text: '结尾' });
    expect(out.filter((o) => o.type === 'del').map((o) => o.text).join('')).toBe('甲'.repeat(40));
    expect(out.filter((o) => o.type === 'ins').map((o) => o.text).join('')).toBe('乙'.repeat(40));
  });
});
