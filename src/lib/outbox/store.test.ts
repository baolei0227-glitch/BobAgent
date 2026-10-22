/**
 * Outbox 暂存区（lib/outbox/store）回归 —— 管家派发会话的产物「不落当前项目」核心链路。
 *
 * 覆盖：
 *   - createBatch / readBatch / listBatches：批次目录结构 + 契约读写 + 文件清单刷新
 *   - assignBatch：逐文件「复制→校验→删源」，全部搬走后整批目录删除；
 *     目标同名且大小不同 → **不覆盖**，批次保留并置 assigned
 *   - keepBatch / discardBatch
 *   - 清理口径（sweepIntermediateFiles → pruneOutbox）：过期 30 天删、kept 永不删、assigned 立即删
 *
 * 隔离：BOBWORK_HOME 指向临时目录（resolveAppRoot 运行时读 env），项目库整体 mock（不触达真实磁盘）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const H = vi.hoisted(() => ({ appRoot: '', projectDir: '' }));

/** 项目库 mock：Outbox 链路不依赖真实项目库（assign 目标由 deps 注入） */
vi.mock('@/lib/project/project-manager', () => ({
  listProjects: async () => ({ projects: [], active_projects: [], archived_projects: [], trashed_projects: [], currentId: null }),
  getCurrentProject: async () => {
    throw new Error('NO_PROJECT');
  },
  getProjectById: async () => {
    throw new Error('NO_PROJECT');
  },
}));

import { createBatch, readBatch, writeBatch, listBatches, keepBatch, discardBatch, assignBatch, batchPaths, chatBatchId, ensureChatBatch } from './store';
import { sweepIntermediateFiles } from '@/lib/cleanup/intermediate-cleanup';

/** 测试用目标项目解析（避免触达真实项目库） */
const deps = {
  resolveTarget: async (ref: string) => {
    if (ref === '项目A') return { ok: true as const, id: 'projA', name: '项目 A', path: H.projectDir };
    return { ok: false as const, message: `未找到项目「${ref}」` };
  },
};

beforeAll(() => {
  H.appRoot = mkdtempSync(join(tmpdir(), 'bobwork-outbox-'));
  process.env.BOBWORK_HOME = H.appRoot;
});

afterEach(() => {
  rmSync(join(H.appRoot, 'outbox'), { recursive: true, force: true });
  rmSync(H.projectDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(H.appRoot, { recursive: true, force: true });
  delete process.env.BOBWORK_HOME;
});

/** 写一个交付文件进批次的 homework/ 目录 */
function putDeliverable(batchId: string, name: string, content: string): void {
  const dir = batchPaths(batchId).homework;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, 'utf-8');
}

describe('createBatch / readBatch / listBatches', () => {
  it('建批：创建 homework/ 与 .ai-workspace/，契约状态 pending', async () => {
    const { batch, paths } = await createBatch({ originProjectId: 'projX', originLabel: '竞品调研' });
    expect(batch.status).toBe('pending');
    expect(batch.batch_id).toMatch(/^otb_/);
    expect(existsSync(paths.homework)).toBe(true);
    expect(existsSync(paths.workspace)).toBe(true); // .ai-workspace 随批建好

    const read = await readBatch(batch.batch_id);
    expect(read?.origin_label).toBe('竞品调研');
    expect(read?.origin_project_id).toBe('projX');
  });

  it('listBatches 刷新文件清单（隐藏目录不计入交付物）', async () => {
    const { batch } = await createBatch({ originLabel: '报告' });
    putDeliverable(batch.batch_id, 'report.md', '# hello');
    mkdirSync(join(batchPaths(batch.batch_id).homework, '.hidden'), { recursive: true });
    writeFileSync(join(batchPaths(batch.batch_id).homework, '.hidden', 'x.txt'), 'x');

    const list = await listBatches();
    const found = list.find((b) => b.batch_id === batch.batch_id);
    expect(found?.files.map((f) => f.rel)).toEqual(['report.md']);
    expect(found?.files[0]?.kind).toBeTruthy();
  });

  it('readBatch 对不存在的批次返回 null（不抛错）', async () => {
    expect(await readBatch('otb_19700101_deadbeef')).toBeNull();
  });
});

describe('ensureChatBatch（管家直聊按 threadId 复用批次）', () => {
  it('同一 threadId 恒得同一批次，且 id 满足工具侧校验字符集', async () => {
    const tid = 'b-1792373383075-qfb41i';
    const id = chatBatchId(tid);
    expect(id).toBe(chatBatchId(tid));
    expect(id).toMatch(/^otb_[A-Za-z0-9_-]{1,64}$/);

    const b1 = await ensureChatBatch(tid, { originProjectId: 'projX', originLabel: 'Butler' });
    const b2 = await ensureChatBatch(tid, { originProjectId: 'projX', originLabel: 'Butler' });
    expect(b1.batch_id).toBe(b2.batch_id);
    expect(existsSync(batchPaths(b1.batch_id).homework)).toBe(true);
    expect((await readBatch(b1.batch_id))?.session_id).toBe(tid);
  });

  it('特殊字符 threadId 净化后仍合法（不产生路径分隔符）', () => {
    const id = chatBatchId('butler/notify 会话#1');
    expect(id).toMatch(/^otb_[A-Za-z0-9_-]{1,64}$/);
    expect(id).not.toContain('/');
  });
});

describe('assignBatch（归口到项目）', () => {
  it('全部搬入目标项目 homework/，并删除整批暂存目录', async () => {
    H.projectDir = mkdtempSync(join(tmpdir(), 'bobwork-proj-a-'));
    const { batch } = await createBatch({ originLabel: '调研' });
    putDeliverable(batch.batch_id, 'report.md', 'body');
    putDeliverable(batch.batch_id, 'data.csv', 'a,b');

    const res = await assignBatch({ batchId: batch.batch_id, target: '项目A' }, deps);
    expect(res.ok).toBe(true);
    expect(res.target?.id).toBe('projA');
    expect(res.assigned?.length).toBe(2);
    expect(existsSync(join(H.projectDir, 'homework', 'report.md'))).toBe(true);
    expect(existsSync(join(H.projectDir, 'homework', 'data.csv'))).toBe(true);
    // 整批搬空 → 目录删除，不再占面板
    expect(existsSync(batchPaths(batch.batch_id).root)).toBe(false);
    expect(res.batchDeleted).toBe(true);
  });

  it('目标同名且大小不同 → 不覆盖，批次保留并置 assigned', async () => {
    H.projectDir = mkdtempSync(join(tmpdir(), 'bobwork-proj-b-'));
    mkdirSync(join(H.projectDir, 'homework'), { recursive: true });
    writeFileSync(join(H.projectDir, 'homework', 'report.md'), '原文（长度不同）', 'utf-8');

    const { batch } = await createBatch({ originLabel: '调研' });
    putDeliverable(batch.batch_id, 'report.md', '新内容');

    const res = await assignBatch({ batchId: batch.batch_id, target: '项目A' }, deps);
    expect(res.ok).toBe(true);
    expect(res.conflicts).toBe(1);
    expect(res.remaining).toEqual(['report.md']);
    // 目标原文未被覆盖
    expect(readFileSync(join(H.projectDir, 'homework', 'report.md'), 'utf-8')).toBe('原文（长度不同）');
    // 批次仍在，状态 assigned
    const kept = await readBatch(batch.batch_id);
    expect(kept?.status).toBe('assigned');
    expect(existsSync(batchPaths(batch.batch_id).root)).toBe(true);
  });

  it('目标项目解析失败 → 不搬运、原样返回错误', async () => {
    const { batch } = await createBatch({ originLabel: '调研' });
    putDeliverable(batch.batch_id, 'report.md', 'body');
    const res = await assignBatch({ batchId: batch.batch_id, target: '不存在项目' }, deps);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('不存在项目');
    expect(existsSync(batchPaths(batch.batch_id).root)).toBe(true);
  });
});

describe('keepBatch / discardBatch', () => {
  it('保留 → status kept；丢弃 → 整目录删除', async () => {
    const { batch } = await createBatch({ originLabel: 'x' });
    expect((await keepBatch(batch.batch_id))?.status).toBe('kept');
    expect(await discardBatch(batch.batch_id)).toBe(true);
    expect(existsSync(batchPaths(batch.batch_id).root)).toBe(false);
  });

  it('discardBatch 拒绝含路径分隔符/隐藏前缀的非法批次 id', async () => {
    expect(await discardBatch('../../etc')).toBe(false);
    expect(await discardBatch('.hidden')).toBe(false);
  });
});

describe('清理口径 pruneOutbox（经 sweepIntermediateFiles）', () => {
  /** 把批次契约的 created_at 改到 daysAgo 天前 */
  async function ageBatch(batchId: string, daysAgo: number): Promise<void> {
    const b = await readBatch(batchId);
    expect(b).toBeTruthy();
    await writeBatch({ ...b!, created_at: new Date(Date.now() - daysAgo * 86400000).toISOString() });
  }

  it('过期 30 天的 pending 批次被清掉', async () => {
    const { batch } = await createBatch({ originLabel: '旧' });
    putDeliverable(batch.batch_id, 'a.md', 'x');
    await ageBatch(batch.batch_id, 40);
    await sweepIntermediateFiles();
    expect(existsSync(batchPaths(batch.batch_id).root)).toBe(false);
  });

  it('kept 批次永不自动删（即使已过期）', async () => {
    const { batch } = await createBatch({ originLabel: '保留' });
    putDeliverable(batch.batch_id, 'a.md', 'x');
    await keepBatch(batch.batch_id);
    await ageBatch(batch.batch_id, 40);
    await sweepIntermediateFiles();
    expect(existsSync(batchPaths(batch.batch_id).root)).toBe(true);
  });

  it('新近 pending 批次不被清（30 天内）', async () => {
    const { batch } = await createBatch({ originLabel: '新' });
    putDeliverable(batch.batch_id, 'a.md', 'x');
    await sweepIntermediateFiles();
    expect(existsSync(batchPaths(batch.batch_id).root)).toBe(true);
  });

  it('created_at 不可解析 → 不按年龄淘汰（fail-safe，宁可留不可误删）', async () => {
    const { batch } = await createBatch({ originLabel: '坏时间' });
    putDeliverable(batch.batch_id, 'a.md', 'x');
    const b = await readBatch(batch.batch_id);
    await writeBatch({ ...b!, created_at: 'not-a-date' });
    await sweepIntermediateFiles();
    expect(existsSync(batchPaths(batch.batch_id).root)).toBe(true);
  });
});
