/**
 * resolveRole 目录消歧回归。
 *
 * 两个同名角色（这里都没有人设、回退到「未命名角色」）必须解析到**两个不同目录**，
 * 否则附件/文档/记录会串到一起（历史 bug：只在同一 threadId 改名时做占用检查）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的 ROLES_FILE 在 import 时由环境变量确定，
 * 所以必须先设 env 再动态 import。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let resolveRole: typeof import('./storage').resolveRole;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-role-'));
  process.env.BOBWORK_HOME = home;
  ({ resolveRole } = await import('./storage'));
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('resolveRole 同名角色目录消歧', () => {
  it('无 threadId → 未分类', async () => {
    await expect(resolveRole(null)).resolves.toEqual({ name: '未分类', dir: '未分类' });
  });

  it('同名角色落到不同目录，且重复解析结果稳定', async () => {
    const a = await resolveRole('thread-a');
    const b = await resolveRole('thread-b');

    // 首个占用原名，保持既有单联系人行为不变
    expect(a.dir).toBe('未命名角色');
    // 第二个必须被消歧，不能与第一个共用一个目录
    expect(b.dir).not.toBe(a.dir);
    expect(b.dir.startsWith('未命名角色-')).toBe(true);

    // 幂等：再次解析同一个 threadId 仍是同一目录（否则文件会失联）
    await expect(resolveRole('thread-b')).resolves.toEqual(b);
  });
});