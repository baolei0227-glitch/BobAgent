import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConversationTurn } from '@/lib/node-markdown';
import {
  compactionFallbackSummary,
  extractHardFacts,
  extractGoalFromExistingMemory,
  oldestPairsToFold,
  renderCompressedMemory,
  shouldCompact,
  type CompressInput,
} from './compact';
import {
  compactionTurnFromDerivedPayload,
  deriveCompactionTurnsFromLogs,
  readLogDerivedCompactionTurn,
} from './compact-source';

/** 夹具：含日期/金额/条款号硬事实（R-27 规则可抽取）的两轮对话 */
function fixtureTurns(): ConversationTurn[] {
  return [
    {
      question: '请分析 2026-07-31 签订的合同，标的额 8000元。',
      answer: '依据第三条，乙方应于 2026/8/15 前支付。',
      questionTime: '',
      answerTime: '',
    },
    {
      question: '若违约按 1.5万元 索赔是否合理？',
      answer: '需看第七条与违约金比例 20%。',
      questionTime: '',
      answerTime: '',
    },
  ];
}

describe('compact: P4c-1 compactionFallbackSummary 双轨收敛等价', () => {
  it('共享 fallback 与 route R-14-C / nodes append 两处原实现输出一致', () => {
    const turns = fixtureTurns();
    const existingMemory = '### 任务目标\n- 合同违约分析\n\n### 已确认事实\n- 旧事实\n';
    // 真实调用点中 goal 恒为 extractGoalFromExistingMemory(existing)（route 2342 与 nodes append 同源）
    const goal = extractGoalFromExistingMemory(existingMemory);
    const hardFacts = extractHardFacts(turns.map((t) => t.question + t.answer).join(''));
    const input: CompressInput = { goal, existingMemory, uncompressedTurns: turns, hardFacts };
    expect(hardFacts.length).toBeGreaterThan(0);

    // 原实现 A（chat/route.ts R-14-C 无模型/冷却期分支）：
    //   rendered = renderCompressedMemory({ goal, settled: hardFacts, disputes: [], excluded: [], preferences: [] })
    const originalChatImpl = renderCompressedMemory({
      goal,
      settled: hardFacts,
      disputes: [],
      excluded: [],
      preferences: [],
    });
    // 原实现 B（nodes/route.ts append 无模型分支 fallbackMem）：
    //   { goal: extractGoalFromExistingMemory(existing), settled: finalHardFacts, disputes: [], excluded: [], preferences: [] }
    const originalNodesImpl = renderCompressedMemory({
      goal: extractGoalFromExistingMemory(existingMemory),
      settled: hardFacts,
      disputes: [],
      excluded: [],
      preferences: [],
    });

    const shared = compactionFallbackSummary(input);
    expect(shared).toBe(originalChatImpl);
    expect(shared).toBe(originalNodesImpl);
    expect(originalChatImpl).toBe(originalNodesImpl);

    // 内容自检：任务目标保留、全部硬事实原文直写进 settled
    expect(shared).toContain(goal);
    for (const f of hardFacts) {
      expect(shared).toContain(f);
    }
  });

  it('硬事实为空时也稳定输出（与原实现的空 settled 渲染等价）', () => {
    const input: CompressInput = {
      goal: '无硬事实任务',
      existingMemory: '',
      uncompressedTurns: [],
      hardFacts: [],
    };
    const original = renderCompressedMemory({
      goal: '无硬事实任务',
      settled: [],
      disputes: [],
      excluded: [],
      preferences: [],
    });
    expect(compactionFallbackSummary(input)).toBe(original);
  });
});

describe('compact: T2 触发策略参数化（shouldCompact 轮数/token 可配，默认不激进）', () => {
  const mkTurns = (n: number): ConversationTurn[] =>
    Array.from({ length: n }, () => ({ question: 'q', answer: 'a', questionTime: '', answerTime: '' }));

  it('默认轮数 15 / token 阈值（1M→100k）与既有语义一致：小会话不触发（默认不激进）', () => {
    expect(shouldCompact(mkTurns(14), 0).shouldCompact).toBe(false);
    const d = shouldCompact(mkTurns(15), 0);
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('turns');
    // 默认 token 阈值：一两轮普通对话远达不到 → 未达长会话不折叠
    expect(shouldCompact(mkTurns(1), 0).shouldCompact).toBe(false);
  });

  it('轮数阈值可配（滚动投影调小 K 即更早触发；K 默认不收紧）', () => {
    const cfg = { triggerTokens: 1_000_000, triggerTurns: 8 };
    expect(shouldCompact(mkTurns(7), 0, cfg).shouldCompact).toBe(false);
    expect(shouldCompact(mkTurns(8), 0, cfg).shouldCompact).toBe(true);
    expect(shouldCompact(mkTurns(14), 0, cfg).shouldCompact).toBe(true);
  });

  it('token 阈值可配（与既有「字符×0.8 估 token」口径一致）', () => {
    const big = [{ question: 'x'.repeat(200), answer: 'y'.repeat(200), questionTime: '', answerTime: '' }];
    // 400 字符 → ≈320 tokens
    expect(shouldCompact(big, 0, { triggerTokens: 300, triggerTurns: 15 }).shouldCompact).toBe(true);
    expect(shouldCompact(big, 0, { triggerTokens: 500, triggerTurns: 15 }).shouldCompact).toBe(false);
    // 游标推进后只看未压缩段（R-25）
    expect(shouldCompact([...mkTurns(20), ...big], 20, { triggerTokens: 300, triggerTurns: 15 }).shouldCompact).toBe(true);
    expect(shouldCompact([...mkTurns(20), ...big], 21, { triggerTokens: 300, triggerTurns: 15 }).shouldCompact).toBe(false);
  });
});

describe('compact: T2 预算前瞻折叠量 oldestPairsToFold', () => {
  it('空/零水位 → 不折叠', () => {
    expect(oldestPairsToFold([], 100, 1)).toBe(0);
    expect(oldestPairsToFold([10, 10], 0, 1)).toBe(0);
  });

  it('从最老开始折叠，保留（最新）总字符 ≤ 低水位', () => {
    // 4 轮各 10 字符，低水位 25：保留最新 2 轮（20）即可，折叠最老 2 轮
    expect(oldestPairsToFold([10, 10, 10, 10], 25, 1)).toBe(2);
    // 低水位足够大 → 无需折叠
    expect(oldestPairsToFold([10, 10, 10, 10], 40, 1)).toBe(0);
  });

  it('至少保留 minKeepPairs 对（最新轮上下文不折叠进摘要）', () => {
    // 3 轮各 50，低水位 30：最新 1 对也无条件保留 → 折叠 2；minKeep=2 → 只折叠 1
    expect(oldestPairsToFold([50, 50, 50], 30, 1)).toBe(2);
    expect(oldestPairsToFold([50, 50, 50], 30, 2)).toBe(1);
  });

  it('最新轮已超低水位时不强行多折叠（保留下限生效）', () => {
    // 最老轮很小、最新轮巨大：只折叠最老的能折叠部分，保留巨大最新轮
    expect(oldestPairsToFold([5, 500], 100, 1)).toBe(1);
    // 单轮超低水位且只有它 → 不折叠（请求体里它仍是当前可见上下文）
    expect(oldestPairsToFold([500], 100, 1)).toBe(0);
  });
});

describe('compact: T2 折叠源切 .trajectory 日志派生 compactionTurnFromDerivedPayload', () => {
  const fallback: ConversationTurn = {
    question: '.md 问题',
    answer: '.md 回答',
    questionTime: 't1',
    answerTime: 't2',
  };

  it('日志派生 Q/A/reasoning/toolNames → 精简压缩输入文本（不含工具结果全文）', () => {
    const turn = compactionTurnFromDerivedPayload(
      {
        question: '日志问题',
        answer: '日志回答',
        reasoning: '思考内容 2026-07-31 到期',
        toolNames: ['read_file', 'write_file'],
      },
      fallback,
    );
    expect(turn.question).toBe('日志问题');
    expect(turn.answer).toContain('日志回答');
    expect(turn.answer).toContain('[推理过程] 思考内容 2026-07-31 到期');
    expect(turn.answer).toContain('[本轮工具] read_file、write_file');
    // 工具结果全文不得进入压缩输入（R4：防压缩模型输入爆炸）
    expect(turn.answer).not.toContain('tool result 全文');
  });

  it('reasoning 参与 R-27 硬事实抽取（日期可被规则命中）', () => {
    const turn = compactionTurnFromDerivedPayload(
      { answer: 'ok', reasoning: '标的额 8000元，2026/8/15 前支付' },
      fallback,
    );
    const facts = extractHardFacts(turn.question + turn.answer);
    expect(facts.some((f) => f.includes('8000'))).toBe(true);
    expect(facts.some((f) => f.includes('2026'))).toBe(true);
  });

  it('日志无可用文本 → 原样回退 .md 轮次（现网语义零漂移）', () => {
    const empty = compactionTurnFromDerivedPayload({}, fallback);
    expect(empty).toBe(fallback);
    expect(compactionTurnFromDerivedPayload({ question: '', answer: '', reasoning: '', toolNames: [] }, fallback)).toBe(fallback);
  });

  it('派生缺 answer/reasoning 时保留 .md 正文，避免内容丢失', () => {
    const turn = compactionTurnFromDerivedPayload({ question: '仅问题派生', toolNames: ['read_file'] }, fallback);
    expect(turn.question).toBe('仅问题派生');
    expect(turn.answer).toContain('.md 回答');
    expect(turn.answer).toContain('[本轮工具] read_file');
  });
});

describe('compact-source：负向回退（日志缺失/非法 → 原样回退 .md 轮次，不丢内容）', () => {
  // 真实临时目录 + .trajectory 落盘，覆盖 readLogDerivedCompactionTurn / deriveCompactionTurnsFromLogs 文件级链路
  const tmpRoot = mkdtempSync(join(tmpdir(), 'bob-compact-source-'));
  const nodeId = 'node-abc123';
  const logDir = join(tmpRoot, '.trajectory', nodeId);
  mkdirSync(logDir, { recursive: true });
  afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

  /** 一轮最小可派生日志（question=日志问题、answer=日志回答、reasoning 含日期硬事实） */
  function writeDerivableLog(taskId: string): void {
    const lines = [
      `{"seq":0,"type":"turn/start","ts":1,"payload":{"nodeId":"${nodeId}","userInput":"日志问题"}}`,
      `{"seq":1,"type":"user/message","ts":1,"payload":{"role":"user","content":"日志问题"}}`,
      `{"seq":2,"type":"step/start","ts":1,"payload":{"round":0}}`,
      `{"seq":3,"type":"assistant/message","ts":2,"payload":{"content":"日志回答","reasoning":"日志推理 2026-08-14 到期","toolCalls":[]}}`,
      `{"seq":4,"type":"turn/end","ts":3,"payload":{"rounds":1}}`,
    ];
    writeFileSync(join(logDir, `${taskId}.jsonl`), lines.join('\n'));
  }

  it('readLogDerivedCompactionTurn：日志文件不存在 → null（调用方回退 md）', () => {
    const turn: ConversationTurn = { question: '.md 问题', answer: '.md 回答', questionTime: '', answerTime: '', taskId: 'task-missing-0000' };
    expect(readLogDerivedCompactionTurn(tmpRoot, nodeId, turn)).toBeNull();
  });

  it('readLogDerivedCompactionTurn：日志为空 / 非法 taskId → null（不读、不回退错内容）', () => {
    const emptyLog = join(logDir, 'task-empty-0000.jsonl');
    writeFileSync(emptyLog, '');
    const turnA: ConversationTurn = { question: 'q', answer: 'a', questionTime: '', answerTime: '', taskId: 'task-empty-0000' };
    expect(readLogDerivedCompactionTurn(tmpRoot, nodeId, turnA)).toBeNull();
    // 路径段非法（穿越/超长）→ 直接 null，不触盘
    const turnB: ConversationTurn = { question: 'q', answer: 'a', questionTime: '', answerTime: '', taskId: '../evil/../../x' };
    expect(readLogDerivedCompactionTurn(tmpRoot, nodeId, turnB)).toBeNull();
    const turnC: ConversationTurn = { question: 'q', answer: 'a', questionTime: '', answerTime: '' }; // 无 taskId
    expect(readLogDerivedCompactionTurn(tmpRoot, nodeId, turnC)).toBeNull();
  });

  it('deriveCompactionTurnsFromLogs：逐轮独立——某轮日志缺失回退 md 原文（占位也保留），有日志轮走日志派生', () => {
    writeDerivableLog('task-ok-0001');
    const mdLost: ConversationTurn = { question: '[MD-TEXT-LOST md 已被清空]', answer: 'md 回答', questionTime: '', answerTime: '', taskId: 'task-missing-0001' };
    const mdOk: ConversationTurn = { question: '.md 问题二', answer: '.md 回答二', questionTime: '', answerTime: '', taskId: 'task-ok-0001' };
    const mdNoLog: ConversationTurn = { question: '.md 问题三', answer: '.md 回答三', questionTime: '', answerTime: '' }; // 无 taskId
    const out = deriveCompactionTurnsFromLogs([mdLost, mdOk, mdNoLog], tmpRoot, nodeId);

    // ① 日志缺失轮 → 回退 .md 原文（含占位文本也不丢，防折叠源漂移后内容黑洞）
    expect(out[0]).toBe(mdLost);
    expect(out[0].question).toContain('[MD-TEXT-LOST');
    // ② 有日志轮 → 日志派生（question/answer 来自日志，reasoning 以 [推理过程] 入答）
    expect(out[1]).not.toBe(mdOk);
    expect(out[1].question).toBe('日志问题');
    expect(out[1].answer).toContain('日志回答');
    expect(out[1].answer).toContain('[推理过程] 日志推理');
    // ③ 无 taskId 轮 → 保持 .md 原样（不触盘）
    expect(out[2]).toBe(mdNoLog);
  });
});

describe('compact: R-26/append 侧触发一致性（与 chat R-14-C 共享 shouldCompact 的 append 参数形态）', () => {
  const mkTurns = (n: number): ConversationTurn[] =>
    Array.from({ length: n }, () => ({ question: 'q', answer: 'a', questionTime: '', answerTime: '' }));
  const COOLDOWN_MS = 10 * 60 * 1000;

  it('append 传 contextWindow 数字 → 按窗口动态 triggerTokens（1M→100k token≈125k 字符）', () => {
    // 单轮 150k 字符 → tokens 超 100k 触发；append 侧调用形态：shouldCompact(convs, until, contextWindow, compactedAt)
    const big = [{ question: 'x'.repeat(150_000), answer: '', questionTime: '', answerTime: '' }];
    const d = shouldCompact(big, 0, 1_000_000, null);
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('tokens');
    expect(d.range).toEqual({ start: 0, end: 1 });
  });

  it('冷却压制只作用于 token 触发：10 分钟内超 token 不触发，轮数兜底照走（R-26 语义）', () => {
    const inCooldown = Date.now() - 60_000; // 1 分钟前压过
    // token 触发被压制
    const big = [{ question: 'x'.repeat(150_000), answer: '', questionTime: '', answerTime: '' }];
    expect(shouldCompact(big, 0, 1_000_000, inCooldown).shouldCompact).toBe(false);
    // 轮数兜底不受冷却（append 长文档逐轮 append 的主防线）
    expect(shouldCompact(mkTurns(15), 0, 1_000_000, inCooldown).shouldCompact).toBe(true);
    expect(shouldCompact(mkTurns(15), 0, 1_000_000, inCooldown).reason).toBe('turns');
  });

  it('冷却期过后 token 触发恢复；ISO 字符串 compactedAt 同语义', () => {
    const cooled = Date.now() - COOLDOWN_MS - 60_000; // 冷却期已过
    const big = [{ question: 'x'.repeat(150_000), answer: '', questionTime: '', answerTime: '' }];
    expect(shouldCompact(big, 0, 1_000_000, cooled).shouldCompact).toBe(true);
    expect(shouldCompact(big, 0, 1_000_000, new Date(cooled).toISOString()).shouldCompact).toBe(true);
    expect(shouldCompact(big, 0, 1_000_000, null).shouldCompact).toBe(true);
  });

  it('游标推进后只看未压缩段（append 每轮推进 memory_compacted_until → 已被覆盖轮不再计）', () => {
    // 150k 字符轮在游标之前（已被上次折叠覆盖）→ 未压缩段为空 → 不触发
    const big = [{ question: 'x'.repeat(150_000), answer: '', questionTime: '', answerTime: '' }];
    expect(shouldCompact([...big], 1, 1_000_000, null).shouldCompact).toBe(false);
    // 游标后 15 轮仍触发（range 从游标起）
    const d = shouldCompact(mkTurns(15), 0, 1_000_000, Date.now());
    expect(d.shouldCompact).toBe(true);
    expect(d.range).toEqual({ start: 0, end: 15 });
  });
});
