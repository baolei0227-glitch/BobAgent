import { describe, expect, it } from 'vitest';
import { detectCommand, mergeSteeringInput } from '@/lib/core/commands';

/**
 * B5「中途改」的纯逻辑：把「补充要求」合并回原指令输入（`mergeSteeringInput`）。
 *
 * 背景：微信桥的收消息轮询是 fire-and-forget（`wechat-adapter.ts:381` 不 await），
 * 所以长任务（长对话 / `/note` 编译）没跑完时，用户再发一句会**立刻**进到 onMessage。
 * 改前是并发再起一个任务（两个长任务各回执一次）；现在改为「打断旧的 + 按新要求重跑」。
 *
 * 这里锁住两个容易写错、且错了会静默丢内容的点：
 *   1. **剥前缀再加回**——否则重跑输入变成 `/note /note 写一份采购合同…`，指令前缀重复；
 *   2. **合并成单行**——命中指令的第一行会被整条消费，多行会让「补充要求」落到
 *      指令作用域之外、被整段丢弃。
 */
describe('mergeSteeringInput —— 中途改的输入合并', () => {
  it('带指令的原输入：剥前缀 → 合并 → 前缀加回（不得出现重复前缀）', () => {
    const out = mergeSteeringInput('/note 写一份采购合同', '改成 3 页以内');
    expect(out).toBe('/note 写一份采购合同（补充要求：改成 3 页以内）');
    expect(out.match(/\/note/g)).toHaveLength(1);
    expect(detectCommand(out)?.id).toBe('notebook'); // 仍是可路由的指令（note 的 id 为 notebook）
  });

  it('合并结果必须是单行（多行会让补充要求被指令路由丢掉）', () => {
    const out = mergeSteeringInput('/note 先列要点\n再展开成合同', '语气正式一点');
    expect(out.includes('\n')).toBe(false);
    expect(out).toBe('/note 先列要点 再展开成合同（补充要求：语气正式一点）');
  });

  it('无指令的原输入（node 模式下的续问）→ 返回纯文本，不凭空造指令', () => {
    const out = mergeSteeringInput('帮我看看这份合同的风险点', '重点看违约条款');
    expect(out).toBe('帮我看看这份合同的风险点（补充要求：重点看违约条款）');
    expect(out.startsWith('/')).toBe(false);
    expect(detectCommand(out)).toBeNull();
  });

  it('其它指令同样保留前缀（如 /todo）', () => {
    const out = mergeSteeringInput('/todo 明天下午三点跟张三丰开会', '改到四点');
    expect(out).toBe('/todo 明天下午三点跟张三丰开会（补充要求：改到四点）');
    expect(detectCommand(out)?.id).toBe('todo');
  });

  it('空白归一化：换行/多空格折叠成单空格，避免把噪音带进模型输入', () => {
    expect(mergeSteeringInput('/note  A\n\n  B  ', '  C   D  ')).toBe('/note A B（补充要求：C D）');
  });

  it('无空格写法（/todo买牛奶）也认得出指令', () => {
    const out = mergeSteeringInput('/todo买牛奶', '再买鸡蛋');
    expect(out).toBe('/todo 买牛奶（补充要求：再买鸡蛋）');
    expect(detectCommand(out)?.id).toBe('todo');
  });
});
