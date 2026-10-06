/**
 * 昨日待办对账小节（formatReconcileSection）回归。
 *
 * 为什么要单独测：这段是「昨日复盘给出判断」的确定性落点 —— 模型路径与兜底路径共用一份，
 * 不靠模型转述，所以它的输出必须稳定、可预期。
 *
 * 隔离：daily-digest → project-manager → storage，STATE_DIR 在 import 时由 BOBWORK_HOME 决定，
 * 故先设 env 再动态 import。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let formatReconcileSection: typeof import('./daily-digest').formatReconcileSection;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-daily-digest-'));
  process.env.BOBWORK_HOME = home;
  ({ formatReconcileSection } = await import('./daily-digest'));
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('formatReconcileSection', () => {
  it('无待办 → 空串（调用方据此跳过节）', () => {
    expect(formatReconcileSection({ total: 0, done: 0, leftover: 0, leftoverTitles: [] })).toBe('');
  });

  it('有待办且无遗留指名 → 只给完成 / 遗留计数', () => {
    const out = formatReconcileSection({ total: 5, done: 5, leftover: 0, leftoverTitles: [] });
    expect(out).toContain('#### ⏱ 昨日待办对账');
    expect(out).toContain('✅ 完成 5 / ⏳ 遗留 0');
    expect(out).not.toContain('：');
  });

  it('有遗留 → 点名遗留项标题', () => {
    const out = formatReconcileSection({
      total: 5,
      done: 2,
      leftover: 3,
      leftoverTitles: ['写周报', '回邮件'],
    });
    expect(out).toContain('✅ 完成 2 / ⏳ 遗留 3：写周报、回邮件');
  });
});