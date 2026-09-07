import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CORE_EVENT, persistEventLog, type TrajectoryEvent } from './event-log';
import { readTrajectoryMessages } from './reader';

function mkProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bobwork-trajectory-reader-'));
  mkdirSync(join(dir, '.trajectory', 'node-1'), { recursive: true });
  return dir;
}

function ev(seq: number, type: string, payload: Record<string, unknown>): TrajectoryEvent {
  return { seq, type, ts: 1700000000000 + seq, payload };
}

describe('trajectory reader: readTrajectoryMessages', () => {
  it('读取任务日志并投影 messages / rendered', () => {
    const dir = mkProject();
    try {
      const events: TrajectoryEvent[] = [
        ev(0, CORE_EVENT.TURN_START, {}),
        ev(1, CORE_EVENT.USER_MESSAGE, { role: 'user', content: '问题' }),
        ev(2, CORE_EVENT.STEP_START, { round: 0 }),
        ev(3, CORE_EVENT.ASSISTANT_ATTEMPT, {
          round: 0,
          role: 'assistant',
          toolCalls: [{ id: 'c1', name: 'web_search' }],
        }),
        ev(4, CORE_EVENT.TOOL_RESULT, { round: 0, role: 'tool', tool_call_id: 'c1', content: '搜索结果…' }),
        ev(5, CORE_EVENT.ASSISTANT_MESSAGE, { round: 1, role: 'assistant', content: '答复', reasoning: '想' }),
        ev(6, CORE_EVENT.TURN_END, { rounds: 2 }),
        ev(7, 'done', { done: true }),
      ];
      persistEventLog(join(dir, '.trajectory', 'node-1', 'taskX.jsonl'), events);

      const r = readTrajectoryMessages(dir, 'node-1', 'taskX');
      expect(r).not.toBeNull();
      expect(r!.eventCount).toBe(8);
      expect(r!.coreCount).toBe(7);
      expect(r!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      // rendered：tool/result 并入 assistant 的 toolCalls
      expect(r!.rendered[1].role).toBe('assistant');
      expect(r!.rendered[1].toolCalls?.[0]?.result).toBe('搜索结果…');
      expect(r!.types).toContain(CORE_EVENT.ASSISTANT_MESSAGE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非法路径段（穿越）返回 null', () => {
    const dir = mkProject();
    try {
      // 真实文件存在，但 nodeId/taskId 含非法字符必须被拒绝（防读取任意路径）
      writeFileSync(join(dir, 'secret.txt'), 'x');
      expect(readTrajectoryMessages(dir, '../../', 'taskX')).toBeNull();
      expect(readTrajectoryMessages(dir, 'node-1', '../taskX')).toBeNull();
      expect(readTrajectoryMessages(dir, 'node-1', 'a b')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件不存在返回 null', () => {
    const dir = mkProject();
    try {
      expect(readTrajectoryMessages(dir, 'node-1', 'missing')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
