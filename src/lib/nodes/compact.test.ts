import { describe, expect, it } from 'vitest';
import type { ConversationTurn } from '@/lib/node-markdown';
import {
  compactionFallbackSummary,
  extractHardFacts,
  extractGoalFromExistingMemory,
  renderCompressedMemory,
  type CompressInput,
} from './compact';

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
