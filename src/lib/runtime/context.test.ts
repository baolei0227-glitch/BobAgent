/**
 * ContextRuntime 注入器回归测试（2026-10-02）
 *
 * 锁定「排期纪律幂等去重」这一条：`BUTLER_BASE_SYSTEM_PROMPT` 内已插值
 * `BUTLER_SCHEDULE_DISCIPLINE`，新装用户的 system 里本来就有最新口径——此时再经动态通道
 * 注入一遍就是逐字重复（约 950 字符/轮）+ 给模型制造"新旧两版挑一个"的伪冲突；
 * 而已装用户的 agent.json 是安装时物化的旧文本，必须照常注入覆盖。
 */
import { describe, it, expect, vi } from 'vitest';
import { ContextRuntime } from './context';
import { BUTLER_BASE_SYSTEM_PROMPT, BUTLER_SCHEDULE_DISCIPLINE, BUTLER_MEMORY_ROUTING } from '@/lib/agents/profiles';
import type { ToolScene } from '@/app/api/chat/tools';

// 可见源注入的降级路径测试：把三个数据源都打到「取不到」→ 整段静默返回 ''
// （任一源可用时省略对应行都不该影响其它源，此处只锁最极端的一档）。
vi.mock('@/lib/bridge/wechat-bridge', () => ({
  wechatBridge: { getStatus: () => { throw new Error('wechat bridge down'); } },
}));
vi.mock('@/lib/bridge/feishu-bridge', () => ({
  feishuBridge: { getStatus: () => { throw new Error('feishu bridge down'); } },
}));
vi.mock('@/lib/bridge/mail-poll', () => ({
  getMailStatus: () => { throw new Error('mail poll down'); },
}));
vi.mock('@/app/api/chat/tools', () => ({
  getLocalAuthorizedRoots: async () => [],
}));

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

describe('ContextRuntime.buildMemoryRoutingInjection 幂等去重', () => {
  const rt = new ContextRuntime();

  it('system 是当前版本（含本段）→ 不注入，零重复', () => {
    // BUTLER_BASE_SYSTEM_PROMPT 内插值了同一常量，等价于"新装 / agent.json 已刷新"的用户
    expect(BUTLER_BASE_SYSTEM_PROMPT).toContain(BUTLER_MEMORY_ROUTING);
    expect(rt.buildMemoryRoutingInjection(BUTLER_BASE_SYSTEM_PROMPT)).toBe('');
  });

  it('system 是旧版（不含本段）→ 照常注入并声明「以本段为准」', () => {
    const stale = '【信息分层纪律】旧版口径……';
    expect(stale).not.toContain(BUTLER_MEMORY_ROUTING);
    const out = rt.buildMemoryRoutingInjection(stale);
    expect(out).toContain('以本段为准');
    expect(out).toContain(BUTLER_MEMORY_ROUTING);
  });

  it('不传 basePrompt → 恒注入', () => {
    const out = rt.buildMemoryRoutingInjection();
    expect(out).toContain(BUTLER_MEMORY_ROUTING);
  });
});

describe('ContextRuntime.buildVisibleSourcesInjection 注册表派生', () => {
  const rt = new ContextRuntime();

  it('所有源均取不到（微信/飞书桥抛错、授权目录为空）且场景集为空 → 返回空串，不阻断对话', async () => {
    await expect(rt.buildVisibleSourcesInjection(new Set<ToolScene>())).resolves.toBe('');
  });

  it('命中 ledger 场景 → 出现材料索引 / 项目账本行（模型由此知道索引存在）', async () => {
    const out = await rt.buildVisibleSourcesInjection(new Set<ToolScene>(['ledger']));
    expect(out).toContain('项目材料索引');
    expect(out).toContain('search_materials');
    expect(out).toContain('项目账本');
    expect(out).toContain('read_ledger');
    // 未命中 butler / notebook / meeting 场景 → 对应行不出现
    expect(out).not.toContain('恒可见');
    expect(out).not.toContain('个人笔记库');
    expect(out).not.toContain('会议归档');
  });

  it('命中 butler 场景 → 出现恒可见事务域行', async () => {
    const out = await rt.buildVisibleSourcesInjection(new Set<ToolScene>(['butler']));
    expect(out).toContain('恒可见');
  });
});

/**
 * 「新建会话」意图注入回归（2026-10-06）。
 *
 * 事故原文（本机 butler-notify 线程 16:31 实录，逐字取自用户消息）：
 *   「新建会话，涉及一份合作模式，甲方是十三幺公司，乙方是个人，…」
 * 管家把这句读成「本次对话的背景说明」→ 0 次调用 create_session，自己把协议写完了。
 * 本用例把「开头=派单」和「句中提到=普通对话」这两侧钉住：前者必须注入意图指令，
 * 后者必须零注入（否则每轮都在给模型加噪音，且可能劫持正常对话）。
 */
describe('ContextRuntime.buildButlerNewSessionInjection 宿主判定', () => {
  const rt = new ContextRuntime();

  it('实录原文（以「新建会话，」开头）→ 注入「本轮意图：新建会话」并点明不要自己做', () => {
    const real =
      '新建会话，涉及一份合作模式，甲方是十三幺公司，乙方是个人，目前在十三幺负责古风团播（直播模式、造型、音乐等）。'
      + '甲方的想法是成立独立的子公司，专门运营古风团播，乙方的收益与经营状况相挂钩…';
    const out = rt.buildButlerNewSessionInjection(real);
    expect(out).toContain('本轮意图：新建会话');
    expect(out).toContain('create_session');
    expect(out).toContain('不要自己在管家线程里把这项工作做完');
    // 必须交代 ui_not_open 的如实回报口径，避免"假装建好了"
    expect(out).toContain('ui_not_open');
  });

  it('各种派单式说法都命中（含帮我/请前缀、口语变体）', () => {
    for (const text of [
      '新建会话，写一份法律意见',
      '新建一个会话：把这份合同审一下',
      '新开一个会话，整理这批材料',
      '开个会话，让 coding 改下这个脚本',
      '帮我新建会话：起草律师函',
      '请开个新会话',
    ]) {
      expect(rt.buildButlerNewSessionInjection(text), text).toContain('本轮意图：新建会话');
    }
  });

  it('句中提到"会话"不算派单 → 零注入（不劫持普通对话）', () => {
    for (const text of [
      '刚才那个会话里说的协议，帮我改一下第二条',
      '把这个会话的结论记到待办里',
      '今天的会话总结发我',
      '',
      '   ',
    ]) {
      expect(rt.buildButlerNewSessionInjection(text), text).toBe('');
    }
  });

  it('用户只说了「新建会话」没给任务 → 仍注入，但提示不传 task（建空会话）', () => {
    const out = rt.buildButlerNewSessionInjection('新建会话');
    expect(out).toContain('本轮意图：新建会话');
    expect(out).toContain('不传 task');
  });

  it('已建会话的追问不算派单（防误注入）', () => {
    for (const text of [
      '新建会话那边怎么样了',
      '新建会话的任务做完了吗',
      '开个会话里那版协议呢',
    ]) {
      expect(rt.buildButlerNewSessionInjection(text), text).toBe('');
    }
    // 反例对照：无分隔符但确实是派单
    expect(rt.buildButlerNewSessionInjection('开个会话把这件事办了')).toContain('本轮意图：新建会话');
  });
});
