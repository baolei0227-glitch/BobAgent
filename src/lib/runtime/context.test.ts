/**
 * ContextRuntime 注入器回归测试（2026-10-02）
 *
 * 锁定「排期纪律幂等去重」这一条：`BUTLER_BASE_SYSTEM_PROMPT` 内已插值
 * `BUTLER_SCHEDULE_DISCIPLINE`，新装用户的 system 里本来就有最新口径——此时再经动态通道
 * 注入一遍就是逐字重复（约 950 字符/轮）+ 给模型制造"新旧两版挑一个"的伪冲突；
 * 而已装用户的 agent.json 是安装时物化的旧文本，必须照常注入覆盖。
 */
import { describe, it, expect } from 'vitest';
import { ContextRuntime } from './context';
import { BUTLER_BASE_SYSTEM_PROMPT, BUTLER_SCHEDULE_DISCIPLINE } from '@/lib/agents/profiles';

describe('ContextRuntime.buildScheduleDisciplineInjection 幂等去重', () => {
  const rt = new ContextRuntime();

  it('system 是当前版本（含本段）→ 不注入，零重复', () => {
    // BUTLER_BASE_SYSTEM_PROMPT 内插值了同一常量，等价于"新装 / agent.json 已刷新"的用户
    expect(BUTLER_BASE_SYSTEM_PROMPT).toContain(BUTLER_SCHEDULE_DISCIPLINE);
    expect(rt.buildScheduleDisciplineInjection(BUTLER_BASE_SYSTEM_PROMPT)).toBe('');
  });

  it('system 是旧版（不含本段）→ 照常注入并声明「以本段为准」', () => {
    const stale = '【排期纪律 · 先查占位，再给方案】任何「安排 / 改期 / 挪时间」的动作……';
    expect(stale).not.toContain(BUTLER_SCHEDULE_DISCIPLINE);
    const out = rt.buildScheduleDisciplineInjection(stale);
    expect(out).toContain('以本段为准');
    expect(out).toContain(BUTLER_SCHEDULE_DISCIPLINE);
  });

  it('不传 basePrompt → 与改动前行为一致（恒注入）', () => {
    const out = rt.buildScheduleDisciplineInjection();
    expect(out).toContain(BUTLER_SCHEDULE_DISCIPLINE);
  });
});
