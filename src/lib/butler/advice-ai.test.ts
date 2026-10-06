/**
 * Today 建议的 AI 判断层（advice-ai）回归。
 *
 * 覆盖四条硬边界：
 *   - 缓存键由「卡片 id + 各卡 items 的 key」决定：同集合同键、集合变则变、items 顺序无关；
 *   - prompt 必须带上 Memory / Rules（否则只会产出正确的废话）；
 *   - 解析容错（围栏 / 夹带说明 / 三种 JSON 形状），且**只认输入卡片 id**（防模型新增卡片）；
 *   - 无模型时回落 null（调用方保留规则文案），绝不半截覆盖。
 *
 * 隔离：storage 的 STATE_DIR 在 import 时由 BOBWORK_HOME 决定，故先设 env 再动态 import
 * （对齐 advice.test.ts / rule-signals.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AdviceCard } from './advice';
import type { UserPreference } from '@/lib/core/preferences-shared';
import type { RuleRecord } from './rules-shared';

let home = '';
let mod: typeof import('./advice-ai');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-advice-ai-'));
  process.env.BOBWORK_HOME = home;
  mod = await import('./advice-ai');
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** 造一张卡（items 只需 key/title 参与 hash 与 prompt） */
function card(id: string, kind: AdviceCard['kind'], keys: string[], count = keys.length): AdviceCard {
  return {
    id,
    kind,
    count,
    title: `title-${id}`,
    reason: `rule-reason-${id}`,
    items: keys.map((k) => ({ key: k, title: `item-${k}`, time: '', startMs: 0 })),
  };
}

describe('adviceHash —— 缓存键稳定性', () => {
  it('同集合 → 同 hash；items 顺序无关', () => {
    const a = [card('overdue', 'overdue', ['e1', 'e2'])];
    const b = [card('overdue', 'overdue', ['e2', 'e1'])];
    expect(mod.adviceHash(a)).toBe(mod.adviceHash(b));
  });

  it('集合变化（勾掉一条）→ hash 变', () => {
    const before = [card('overdue', 'overdue', ['e1', 'e2'])];
    const after = [card('overdue', 'overdue', ['e1'])];
    expect(mod.adviceHash(before)).not.toBe(mod.adviceHash(after));
  });
});

describe('buildAdvicePrompt —— 必须带 Memory / Rules', () => {
  it('注入记忆内容与规则名，并列出每张卡的 id 与关联条目', () => {
    const memories: UserPreference[] = [
      { index: 1, content: '上午先做需要整块时间的事', type: '偏好习惯', createdAt: '', source: 'chat' },
    ];
    const rules: RuleRecord[] = [
      { id: 'r-1', name: '周一先清逾期', intentRaw: '周一早上先处理逾期任务' } as unknown as RuleRecord,
    ];
    const prompt = mod.buildAdvicePrompt([card('overdue', 'overdue', ['e1'])], memories, rules);
    expect(prompt).toContain('上午先做需要整块时间的事');
    expect(prompt).toContain('周一先清逾期');
    expect(prompt).toContain('id=overdue');
    expect(prompt).toContain('item-e1');
  });
});

describe('parseAdviceReasons —— 容错且只认输入卡片', () => {
  const allowed = new Set(['overdue', 'stalled']);

  it('标准 JSON 数组', () => {
    const out = mod.parseAdviceReasons(
      '{"reasons":[{"id":"overdue","reason":"你昨天已顺延过一次，今天必须先清"}]}',
      allowed,
    );
    expect(out).toEqual({ overdue: '你昨天已顺延过一次，今天必须先清' });
  });

  it('代码块围栏 + 夹带说明文字', () => {
    const raw = '好的，结果如下：\n```json\n{"reasons":[{"id":"stalled","reason":"这个项目你设过每周推进"}]}\n```';
    expect(mod.parseAdviceReasons(raw, allowed)).toEqual({ stalled: '这个项目你设过每周推进' });
  });

  it('丢弃不在输入里的 id（防模型新增卡片）', () => {
    const out = mod.parseAdviceReasons(
      '{"reasons":[{"id":"invented","reason":"x"},{"id":"overdue","reason":"y"}]}',
      allowed,
    );
    expect(out).toEqual({ overdue: 'y' });
  });

  it('接受直接映射 {id: reason}', () => {
    expect(mod.parseAdviceReasons('{"overdue":"今天先清逾期"}', allowed)).toEqual({ overdue: '今天先清逾期' });
  });

  it('无法解析 → null；全部 id 非法 → null', () => {
    expect(mod.parseAdviceReasons('not json at all', allowed)).toBeNull();
    expect(mod.parseAdviceReasons('{"reasons":[{"id":"nope","reason":"x"}]}', allowed)).toBeNull();
  });
});

describe('缓存与覆盖', () => {
  it('写缓存后可按同集合读回', async () => {
    const cards = [card('overdue', 'overdue', ['e1'])];
    await mod.writeAdviceCache(cards, { overdue: 'AI 写的判断' });
    expect(await mod.readAdviceReasons(cards)).toEqual({ overdue: 'AI 写的判断' });
  });

  it('集合变了（勾掉一条）→ 缓存打不中', async () => {
    const cards = [card('overdue', 'overdue', ['e1'])];
    await mod.writeAdviceCache(cards, { overdue: 'AI 写的判断' });
    const changed = [card('overdue', 'overdue', ['e1', 'e2'])];
    expect(await mod.readAdviceReasons(changed)).toBeNull();
  });

  it('applyAdviceReasons 只按 id 覆盖 reason，不动 items / 顺序', () => {
    const cards = [card('overdue', 'overdue', ['e1']), card('stalled', 'stalled', ['p1'])];
    const out = mod.applyAdviceReasons(cards, { overdue: '新判断' });
    expect(out[0].reason).toBe('新判断');
    expect(out[0].items).toEqual(cards[0].items);
    expect(out[1].reason).toBe(cards[1].reason);
  });

  it('adviceCovered：全部覆盖为 true；缺一为 false；仅 clear 卡视为 true', () => {
    const cards = [card('overdue', 'overdue', ['e1']), card('stalled', 'stalled', ['p1'])];
    expect(mod.adviceCovered(cards, { overdue: 'a', stalled: 'b' })).toBe(true);
    expect(mod.adviceCovered(cards, { overdue: 'a' })).toBe(false);
    expect(mod.adviceCovered([card('clear', 'clear', [])], null)).toBe(true);
  });
});

describe('generateAdviceReasons —— 无模型回落', () => {
  it('无可用模型 → null（调用方保留规则文案）', async () => {
    const reasons = await mod.generateAdviceReasons([card('overdue', 'overdue', ['e1'])]);
    expect(reasons).toBeNull();
  });

  it('全是 clear 卡 → 无需生成，直接 null（不写缓存）', async () => {
    const reasons = await mod.generateAdviceReasons([card('clear', 'clear', [])]);
    expect(reasons).toBeNull();
  });
});
