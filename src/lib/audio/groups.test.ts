import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  assignEntry,
  createGroup,
  deleteGroup,
  forgetEntry,
  readGroupState,
  renameGroup,
} from '@/lib/audio/groups';
import { libraryRoot, saveToLibrary } from '@/lib/audio/library';

/**
 * 库分组测试：状态落盘 + 增删改 + 归属 + 护栏。
 *
 * 用 BOBWORK_HOME 指向临时目录隔离真实文件系统（与 library.test.ts 同款）。
 */
let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'bw-groups-test-'));
  process.env.BOBWORK_HOME = tmpHome;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 把一份音频存进库，返回它的**目录**（归属键就是该目录的 basename） */
async function makeEntry(name: string, content: string): Promise<string> {
  const source = await saveToLibrary(name, Buffer.from(content));
  return dirname(source);
}

/** 直接写库根的 .groups.json（用于构造脏数据） */
async function writeRaw(value: unknown): Promise<void> {
  await fsp.mkdir(libraryRoot(), { recursive: true });
  await fsp.writeFile(join(libraryRoot(), '.groups.json'), JSON.stringify(value), 'utf-8');
}

describe('readGroupState', () => {
  it('文件不存在 → 空状态（不抛错）', async () => {
    const state = await readGroupState();
    expect(state.groups).toEqual([]);
    expect(state.assign).toEqual({});
  });

  it('脏数据被规范化：非法组、重复 id、指向不存在组的归属一律丢弃', async () => {
    await writeRaw({
      version: 1,
      groups: [
        { id: 'not-an-id', name: 'bad-id' },
        { id: 'g_aaaaaaaaaaaa', name: '保留组' },
        { id: 'g_aaaaaaaaaaaa', name: 'dup' },
        { id: 'g_bbbbbbbbbbbb', name: '   ' },
      ],
      assign: { good: 'g_aaaaaaaaaaaa', bad: 'g_cccccccccccc', empty: '' },
    });
    const state = await readGroupState();
    expect(state.groups).toEqual([{ id: 'g_aaaaaaaaaaaa', name: '保留组' }]);
    expect(state.assign).toEqual({ good: 'g_aaaaaaaaaaaa' });
  });
});

describe('createGroup / renameGroup / deleteGroup', () => {
  it('新建 → 组名落盘、id 形态正确、可被读回', async () => {
    const state = await createGroup('  工作  ');
    const added = state.groups.filter((g) => g.name === '工作'); // 前面的用例可能留了组，只断言新增项
    expect(added).toHaveLength(1);
    expect(added[0].id).toMatch(/^g_[a-f0-9]{12}$/);
    const reread = await readGroupState();
    expect(reread.groups).toEqual(state.groups);
  });

  it('空名字 → 抛错', async () => {
    await expect(createGroup('   ')).rejects.toThrow('group name is required');
  });

  it('重命名 → 只改名不改 id；未知组 / 空名字抛错', async () => {
    const created = await createGroup('old');
    const id = created.groups[created.groups.length - 1].id;
    const renamed = await renameGroup(id, 'new name');
    expect(renamed.groups.find((g) => g.id === id)?.name).toBe('new name');
    expect(renamed.groups.find((g) => g.id === id)?.id).toBe(id);
    await expect(renameGroup('g_ffffffffffff', 'x')).rejects.toThrow('group not found');
    await expect(renameGroup(id, '   ')).rejects.toThrow('group name is required');
  });

  it('删除组 → 组消失，指向它的归属一并回到未分组', async () => {
    const created = await createGroup('to-delete');
    const id = created.groups[created.groups.length - 1].id;
    const dir = await makeEntry('删除组测试.mp3', 'group-delete-content');
    await assignEntry(dir, id);
    expect((await readGroupState()).assign[basename(dir)]).toBe(id);

    const after = await deleteGroup(id);
    expect(after.groups.some((g) => g.id === id)).toBe(false);
    expect(after.assign[basename(dir)]).toBeUndefined();
  });
});

describe('assignEntry', () => {
  it('移入 / 移出分组：写盘并可读回；原地重放不报错', async () => {
    const created = await createGroup('assign-target');
    const id = created.groups[created.groups.length - 1].id;
    const dir = await makeEntry('归属测试.mp3', 'assign-content');
    const key = basename(dir);

    await assignEntry(dir, id);
    expect((await readGroupState()).assign[key]).toBe(id);

    await assignEntry(dir, ''); // 移出分组
    expect((await readGroupState()).assign[key]).toBeUndefined();
  });

  it('目标不是正式库条目 → 抛错（护栏）', async () => {
    const created = await createGroup('guard');
    const id = created.groups[created.groups.length - 1].id;
    await expect(assignEntry(join(tmpHome, 'outside'), id)).rejects.toThrow('not a library entry');
    // 库内目录但没有 source.*（影子目录）同样不算正式条目
    const shadow = join(libraryRoot(), '影子-111111111111');
    await fsp.mkdir(shadow, { recursive: true });
    await fsp.writeFile(join(shadow, '录音.marks.json'), '[]');
    await expect(assignEntry(shadow, id)).rejects.toThrow('not a library entry');
  });

  it('目标组不存在 → 抛错', async () => {
    const dir = await makeEntry('缺组.mp3', 'missing-group-content');
    await expect(assignEntry(dir, 'g_ffffffffffff')).rejects.toThrow('group not found');
  });
});

describe('forgetEntry', () => {
  it('抹掉某条目的归属；没记录时不写盘（不报错）', async () => {
    const created = await createGroup('forget');
    const id = created.groups[created.groups.length - 1].id;
    const dir = await makeEntry('遗忘.mp3', 'forget-content');
    await assignEntry(dir, id);
    expect((await readGroupState()).assign[basename(dir)]).toBe(id);

    await forgetEntry(dir);
    expect((await readGroupState()).assign[basename(dir)]).toBeUndefined();
    await expect(forgetEntry(dir)).resolves.toBeUndefined();
  });
});
