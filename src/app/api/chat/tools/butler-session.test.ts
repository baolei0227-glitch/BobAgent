import { describe, expect, it } from 'vitest';
import { butlerToolDefs } from '@/app/api/chat/tools/butler';

/**
 * 管家「应用结构」两枚新工具的守卫分支回归（2026-10-05）。
 *
 * switch_project / create_session 的落地路径要靠文件系统与前端 SSE，这里只锁**先于副作用**
 * 的两条硬约束——它们是「不猜、不乱动」的边界，坏了不会被别的用例发现：
 *   ① switch_project 没拿到项目引用时不得猜一个项目，直接要求澄清；
 *   ② create_session 在界面未打开（无任何 SSE 订阅者）时必须拒绝，且不得留下半状态。
 */
function tool(name: string) {
  const def = butlerToolDefs.find((d) => d.name === name);
  if (!def) throw new Error(`未找到工具：${name}`);
  return def;
}

async function run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await tool(name).execute(args);
  const text = typeof out === 'string' ? out : out.text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe('管家应用结构工具：先于副作用的两条硬约束', () => {
  it('switch_project：缺项目引用 → project is required（绝不猜项目）', async () => {
    for (const args of [{}, { project: '' }, { project: '   ' }]) {
      const parsed = await run('switch_project', args);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe('project is required');
      expect(String(parsed.hint)).toContain('确认项目名');
    }
  });

  it('create_session：界面未打开 → ui_not_open（不静默失败、不切项目、不建会话）', async () => {
    // 测试环境里没有浏览器 SSE 订阅者，等价于「BobWork 窗口没开」。
    const parsed = await run('create_session', { project: 'current', task: '把这件事跑一遍' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('ui_not_open');
    expect(String(parsed.message)).toContain('打开 BobWork');
  });

  it('两枚工具都挂在 butler 画像的工具表里（否则管家根本调不到）', () => {
    for (const name of ['switch_project', 'create_session']) {
      const def = tool(name);
      expect(def.parameters.type).toBe('object');
    }
  });
});
