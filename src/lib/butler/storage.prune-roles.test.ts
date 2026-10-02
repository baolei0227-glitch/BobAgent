/**
 * roles.json 孤儿条目回收（pruneOrphanRoles）回归。
 *
 * 背景：`roles.json` 只增不删，线程被删后条目仍在（实测运行实例 10 条角色 vs 3 个活线程，
 * 含已退役的 `butler-wechat`）。本用例锁四条不变量：
 *   ① 无线程文件的普通条目 → 清掉；
 *   ② 三个常驻 id（Bobby / Recorder / 小微）→ **豁免**（线程可能只是还没首次创建）；
 *   ③ 有线程文件的条目 → 保留；
 *   ④ **绝不删角色目录**（目录里是用户的附件/文档，清的只是指针）。
 *
 * 隔离：BOBWORK_HOME 指向临时目录；storage.ts 的路径常量在 import 时由环境变量确定，
 * 所以必须先设 env 再动态 import（同 storage.resolve-role.test.ts 的做法）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home = '';
let pruneOrphanRoles: typeof import('./storage').pruneOrphanRoles;
let readRoles: typeof import('./storage').readRoles;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'bobwork-prune-roles-'));
  process.env.BOBWORK_HOME = home;
  ({ pruneOrphanRoles, readRoles } = await import('./storage'));
});

afterAll(() => {
  delete process.env.BOBWORK_HOME;
  if (home) rmSync(home, { recursive: true, force: true });
});

function seed(threads: Record<string, { name: string; dir: string }>): void {
  const dir = join(home, 'butler');
  mkdirSync(join(dir, '.state', 'threads'), { recursive: true });
  writeFileSync(join(dir, 'roles.json'), JSON.stringify({ threads }, null, 2), 'utf-8');
}

function seedThreadFile(threadId: string): void {
  writeFileSync(join(home, 'butler', '.state', 'threads', `${threadId}.json`), '{}', 'utf-8');
}

describe('pruneOrphanRoles', () => {
  it('清掉无线程文件的条目、豁免常驻 id、保留有文件的条目、不动角色目录', async () => {
    seed({
      'butler-notify': { name: 'Bobby', dir: 'Bobby' },
      'butler-recorder': { name: 'Recorder', dir: 'Recorder' },
      'butler-search': { name: '小微', dir: '小微' },
      'chat-1-orphan': { name: '小张', dir: '小张' },
      'butler-wechat': { name: 'Xiao Wei', dir: 'Xiao Wei' },
      'b-1-live': { name: '行程助理', dir: '行程助理' },
    });
    seedThreadFile('b-1-live');
    // 角色目录存在（内容物）：回收条目**不得**删掉它
    mkdirSync(join(home, 'butler', '小张', '2026-10-01', 'attachments'), { recursive: true });

    const removed = await pruneOrphanRoles();

    expect(removed.sort()).toEqual(['butler-wechat', 'chat-1-orphan']);
    const roles = await readRoles();
    expect(Object.keys(roles.threads).sort()).toEqual(['b-1-live', 'butler-notify', 'butler-recorder', 'butler-search']);
    // ④ 目录仍在
    expect(existsSync(join(home, 'butler', '小张', '2026-10-01', 'attachments'))).toBe(true);
  });

  it('幂等：第二次调用无孤儿可清，且不重写文件内容语义', async () => {
    const before = readFileSync(join(home, 'butler', 'roles.json'), 'utf-8');
    const removed = await pruneOrphanRoles();
    expect(removed).toEqual([]);
    // 无变更即不写盘（内容逐字不变）
    expect(readFileSync(join(home, 'butler', 'roles.json'), 'utf-8')).toBe(before);
  });

  it('空注册表是安全输入', async () => {
    seed({});
    await expect(pruneOrphanRoles()).resolves.toEqual([]);
  });
});
