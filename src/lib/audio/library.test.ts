import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import {
  deleteShadowDir,
  listShadowDirs,
  saveToLibrary,
  sourceDir,
  readClips,
  writeClips,
  listLibrary,
  deleteEntry,
  renameClip,
  deleteClip,
  marksFileFor,
  libraryRoot,
  transcriptFileFor,
  readTranscriptFile,
  writeTranscriptFile,
} from '@/lib/audio/library';
import { promises as fsp } from 'node:fs';
import type { AudioClipRef } from '@/lib/audio/marks';
import { TRANSCRIPT_VERSION, type AudioTranscript } from '@/lib/audio/transcript';

/**
 * 库目录结构测试：全局库 + 复用指纹 + 源/打点/片段同居一处。
 *
 * 用 BOBWORK_HOME 指向临时目录隔离真实文件系统；每个 describe 聚焦一条核心不变式。
 */
let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'bw-lib-test-'));
  process.env.BOBWORK_HOME = tmpHome;
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('saveToLibrary', () => {
  it('创建目录 + source.<ext>，返回路径以 source.<ext> 结尾', async () => {
    const path = await saveToLibrary('录音.mp3', Buffer.from('save-test-1'));
    expect(path).toMatch(/source\.mp3$/);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(dirname(path))).toBe(true);
  });

  it('同内容同名 → 同目录（幂等，复用指纹）', async () => {
    const data = Buffer.from('same-content');
    const p1 = await saveToLibrary('a.mp3', data);
    const p2 = await saveToLibrary('a.mp3', data);
    expect(p1).toBe(p2);
  });

  it('同内容不同名 → 不同目录（前缀含源名，各自独立）', async () => {
    const data = Buffer.from('same-content-diff-name');
    const p1 = await saveToLibrary('a.mp3', data);
    const p2 = await saveToLibrary('b.mp3', data);
    expect(p1).not.toBe(p2);
  });

  it('不同内容 → 不同目录', async () => {
    const p1 = await saveToLibrary('a.mp3', Buffer.from('content-1'));
    const p2 = await saveToLibrary('a.mp3', Buffer.from('content-2'));
    expect(p1).not.toBe(p2);
  });

  it('非音频扩展名 → 抛错', async () => {
    await expect(saveToLibrary('a.txt', Buffer.from('x'))).rejects.toThrow();
  });
});

describe('sourceDir', () => {
  it('库内音频 → 源文件自己的目录', async () => {
    const path = await saveToLibrary('srcdir-test.mp3', Buffer.from('srcdir-1'));
    const dir = await sourceDir(path);
    expect(dir).toBe(dirname(path));
  });

  it('外部音频 → 影子目录（.audio-library 下，含路径指纹）', async () => {
    const external = join(tmpHome, 'materials', '外部.mp3');
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(external, 'x');
    const dir = await sourceDir(external);
    expect(dir).toContain('.audio-library');
    expect(basename(dir)).toContain('外部');
  });

  it('ensure=true → 创建影子目录', async () => {
    const external = join(tmpHome, 'materials', 'ensure-test.mp3');
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(external, 'x');
    const dir = await sourceDir(external, true);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('readClips / writeClips', () => {
  it('写后读 → 往返一致', async () => {
    const path = await saveToLibrary('clips-rt.mp3', Buffer.from('clips-rt'));
    const dir = dirname(path);
    const clips: AudioClipRef[] = [
      { path: join(dir, '片段 - a.mp3'), name: '片段 - a.mp3', start: 5, end: 8 },
      { path: join(dir, '片段 - b.mp3'), name: '片段 - b.mp3', start: 30, end: 42.5 },
    ];
    await writeClips(path, clips);
    expect(await readClips(path)).toEqual(clips);
  });

  it('无 .clips.json → 空数组', async () => {
    const path = await saveToLibrary('no-clips.mp3', Buffer.from('no-clips'));
    expect(await readClips(path)).toEqual([]);
  });

  it('空数组 → 删除 .clips.json', async () => {
    const path = await saveToLibrary('del-clips.mp3', Buffer.from('del-clips'));
    const dir = dirname(path);
    await writeClips(path, [{ path: '/x.mp3', name: 'x', start: 1, end: 2 }]);
    expect(existsSync(join(dir, '.clips.json'))).toBe(true);
    await writeClips(path, []);
    expect(existsSync(join(dir, '.clips.json'))).toBe(false);
  });

  it('外部源的片段记在影子目录里（库内源则记在自己目录里）', async () => {
    const external = join(tmpHome, 'ext-src', '外部源.mp3');
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(external, 'ext');
    const ref: AudioClipRef = { path: '/tmp/clip.mp3', name: 'clip.mp3', start: 10, end: 20 };
    await writeClips(external, [ref]);
    const dir = await sourceDir(external);
    expect(existsSync(join(dir, '.clips.json'))).toBe(true);
    expect(await readClips(external)).toEqual([ref]);
  });
});

describe('listLibrary', () => {
  it('空库 → 空数组', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'bw-lib-empty-'));
    const prev = process.env.BOBWORK_HOME;
    process.env.BOBWORK_HOME = empty;
    try {
      expect(await listLibrary()).toEqual([]);
    } finally {
      process.env.BOBWORK_HOME = prev;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('列出含 source.* 的目录，每条含 dir / path / name / size', async () => {
    const data = Buffer.from('list-entry-unique');
    const path = await saveToLibrary('列表测试.mp3', data);
    const entries = await listLibrary();
    const found = entries.find((e) => e.path === path);
    expect(found).toBeDefined();
    expect(found!.name).toMatch(/^source\./);
    expect(found!.dir).toBe(dirname(path));
    expect(found!.size).toBe(data.length);
    expect(found!.mtimeMs).toBeGreaterThan(0); // 加入库时间（源文件 mtime）
  });

  it('按加入库时间从新到旧排序（新的在最上面）', async () => {
    const older = await saveToLibrary('较旧.mp3', Buffer.from('older-entry'));
    const newer = await saveToLibrary('较新.mp3', Buffer.from('newer-entry'));
    // 显式拉开源文件 mtime：saveToLibrary 连续调用可能落在同一毫秒
    await fsp.utimes(older, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    await fsp.utimes(newer, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const entries = await listLibrary();
    const idxOlder = entries.findIndex((e) => e.path === older);
    const idxNewer = entries.findIndex((e) => e.path === newer);
    expect(idxNewer).toBeGreaterThanOrEqual(0);
    expect(idxOlder).toBeGreaterThan(idxNewer); // 新的排在旧的之前
  });

  it('影子目录（无 source.*）不出现在列表中', async () => {
    const external = join(tmpHome, 'shadow', '外部.mp3');
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(external, 'shadow');
    await writeClips(external, [{ path: '/x.mp3', name: 'x', start: 1, end: 2 }]);
    const dir = await sourceDir(external);
    const entries = await listLibrary();
    expect(entries.find((e) => e.dir === dir)).toBeUndefined();
  });
});

describe('deleteEntry', () => {
  it('删除整个源目录（源 + 打点 + 片段 + 清单一并清理）', async () => {
    const path = await saveToLibrary('删除测试.mp3', Buffer.from('del-entry'));
    const dir = dirname(path);
    await writeClips(path, [{ path: '/x.mp3', name: 'x', start: 1, end: 2 }]);
    writeFileSync(join(dir, 'source.marks.json'), '[]');
    expect(existsSync(dir)).toBe(true);
    await deleteEntry(path);
    expect(existsSync(dir)).toBe(false);
  });

  it('删除后 listLibrary 不再出现该条目', async () => {
    const path = await saveToLibrary('删除列表.mp3', Buffer.from('del-list'));
    await deleteEntry(path);
    const entries = await listLibrary();
    expect(entries.find((e) => e.path === path)).toBeUndefined();
  });

  it('删除外部源的影子目录', async () => {
    const external = join(tmpHome, 'del-shadow', '外部.mp3');
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(external, 'ds');
    await writeClips(external, [{ path: '/x.mp3', name: 'x', start: 1, end: 2 }]);
    const dir = await sourceDir(external);
    expect(existsSync(dir)).toBe(true);
    await deleteEntry(external);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('deleteClip', () => {
  /** 造一个源 + 一个真实存在的片段文件，返回 { src, clipAbs, dir } */
  async function makeClipSource(tag: string) {
    const src = await saveToLibrary(`${tag}.mp3`, Buffer.from(`src-${tag}`));
    const dir = dirname(src);
    const clipAbs = join(dir, `片段 - ${tag} - 00-01.webm`);
    writeFileSync(clipAbs, 'clip-bytes');
    await writeClips(src, [{ path: clipAbs, name: basename(clipAbs), start: 1, end: 2 }]);
    return { src, clipAbs, dir };
  }

  it('删文件 + 从清单移除，返回剩余清单', async () => {
    const { src, clipAbs } = await makeClipSource('delclip-ok');
    const next = await deleteClip(src, clipAbs);
    expect(existsSync(clipAbs)).toBe(false);
    expect(next).toEqual([]);
    expect(await readClips(src)).toEqual([]);
  });

  it('连同它的打点 sidecar 一起删', async () => {
    const { src, clipAbs, dir } = await makeClipSource('delclip-side');
    const side = join(dir, '片段 - delclip-side - 00-01.marks.json');
    writeFileSync(side, '[]');
    await deleteClip(src, clipAbs);
    expect(existsSync(side)).toBe(false);
  });

  it('只删指定片段，同源其它片段保留', async () => {
    const { src, clipAbs, dir } = await makeClipSource('delclip-keep');
    const other = join(dir, '片段 - 保留.webm');
    writeFileSync(other, 'keep');
    await writeClips(src, [
      { path: clipAbs, name: basename(clipAbs), start: 1, end: 2 },
      { path: other, name: basename(other), start: 5, end: 6 },
    ]);
    const next = await deleteClip(src, clipAbs);
    expect(existsSync(other)).toBe(true);
    expect(next.map((c) => c.path)).toEqual([other]);
  });

  it('片段不在源目录 / 不在清单里 → 抛错', async () => {
    const { src, dir } = await makeClipSource('delclip-missing');
    await expect(deleteClip(src, join(dir, '不存在.webm'))).rejects.toThrow();
    await expect(deleteClip(src, join(tmpHome, 'outside.webm'))).rejects.toThrow();
  });
});

describe('marksFileFor', () => {
  it('库内音频 → 与源同居一处（source.marks.json）', async () => {
    const src = await saveToLibrary('mf-lib.mp3', Buffer.from('mf-lib'));
    expect(await marksFileFor(src)).toBe(join(dirname(src), 'source.marks.json'));
  });

  it('库外音频（项目 materials）→ 影子目录，不落进 workspace', async () => {
    const ext = join(tmpHome, 'proj', 'materials', '录音 8.m4a');
    const p = await marksFileFor(ext);
    expect(p.startsWith(libraryRoot() + '/')).toBe(true);
    expect(dirname(p).startsWith(join(tmpHome, 'proj'))).toBe(false);
    expect(basename(p)).toBe('录音 8.marks.json');
  });
});

describe('renameClip', () => {
  /** 造一个源 + 一个真实存在的片段文件，返回 { src, clipAbs, dir } */
  async function makeClipSource(tag: string) {
    const src = await saveToLibrary(`${tag}.mp3`, Buffer.from(`src-${tag}`));
    const dir = dirname(src);
    const clipAbs = join(dir, `片段 - ${tag} - 00-01.webm`);
    writeFileSync(clipAbs, 'clip-bytes');
    const ref: AudioClipRef = { path: clipAbs, name: basename(clipAbs), start: 1, end: 2 };
    await writeClips(src, [ref]);
    return { src, clipAbs, dir };
  }

  it('改名：磁盘文件与清单同步，返回新路径', async () => {
    const { src, clipAbs, dir } = await makeClipSource('rename-ok');
    const { clips, path } = await renameClip(src, clipAbs, '新名字');
    expect(path).toBe(join(dir, '新名字.webm'));
    expect(existsSync(path)).toBe(true);
    expect(existsSync(clipAbs)).toBe(false);
    expect(clips[0].path).toBe(path);
    expect(clips[0].name).toBe('新名字.webm');
    expect(await readClips(src)).toEqual(clips);
  });

  it('连同打点 sidecar 一起改名', async () => {
    const { src, clipAbs, dir } = await makeClipSource('rename-side');
    const side = join(dir, '片段 - rename-side - 00-01.marks.json');
    writeFileSync(side, '[]');
    const { path } = await renameClip(src, clipAbs, '带打点');
    expect(existsSync(join(dir, '带打点.marks.json'))).toBe(true);
    expect(existsSync(side)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('新名自带扩展名 → 剥掉后沿用原扩展名', async () => {
    const { src, clipAbs, dir } = await makeClipSource('rename-ext');
    const { path } = await renameClip(src, clipAbs, '改成.mp3');
    expect(path).toBe(join(dir, '改成.webm'));
  });

  it('目标名已存在 → 抛错，不覆盖', async () => {
    const { src, clipAbs, dir } = await makeClipSource('rename-conflict');
    writeFileSync(join(dir, '占用.webm'), 'other');
    await expect(renameClip(src, clipAbs, '占用')).rejects.toThrow();
    expect(existsSync(join(dir, '占用.webm'))).toBe(true);
    expect(existsSync(clipAbs)).toBe(true);
  });

  it('片段不在源目录 / 不在清单里 → 抛错', async () => {
    const { src, dir } = await makeClipSource('rename-missing');
    await expect(renameClip(src, join(dir, '不存在.webm'), 'x')).rejects.toThrow();
    await expect(renameClip(src, join(tmpHome, 'outside.webm'), 'x')).rejects.toThrow();
  });
});

/**
 * 转写 sidecar：与打点/peaks 同款落点（库内就地、库外影子目录），外加一条**指纹失效判定**。
 *
 * 失效判定是这组的重点：音频被换掉（同名覆盖）后如果继续展示旧文稿，用户会拿旧转写去打点，
 * 点位与声音对不上，且界面上**看不出任何异常** —— 典型的静默错误。
 */
describe('转写 sidecar（transcriptFileFor / read / write）', () => {
  const mkTranscript = (over: Partial<AudioTranscript> = {}): AudioTranscript => ({
    version: TRANSCRIPT_VERSION,
    segments: [{ t: 0, end: 30, speaker: null, text: '第一段' }],
    plainText: '第一段',
    durationSec: 30,
    engine: 'Doubao',
    range: null,
    at: '2026-10-11T00:00:00.000Z',
    source: { size: 100, mtimeMs: 1000 },
    ...over,
  });

  it('库内音频：落在源文件同目录，文件名 <主名>.transcript.json', async () => {
    const src = await saveToLibrary('转写落点.mp3', Buffer.from('transcript-dest'));
    const p = await transcriptFileFor(src);
    expect(p).toBe(join(dirname(src), 'source.transcript.json'));
  });

  it('📌 库外音频：进影子目录（绝不写进源文件旁边 / 绝不进 workspace）', async () => {
    const external = join(tmpHome, 'outside-dir', '外部录音.mp3');
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(external, 'x');
    const p = await transcriptFileFor(external);
    expect(p.startsWith(libraryRoot() + '/')).toBe(true);
    expect(dirname(p)).not.toBe(dirname(external));
  });

  it('父目录不存在时也能写成功（首次给库外音频转写）', async () => {
    const transcriptAbs = join(libraryRoot(), 'never-created-shadow', 'nested', 'source.transcript.json');
    // ① 先断言前提：父目录确实不存在（否则本用例退化成平凡为真）
    expect(existsSync(dirname(transcriptAbs))).toBe(false);

    const t = mkTranscript();
    await writeTranscriptFile(transcriptAbs, t);

    expect(existsSync(transcriptAbs)).toBe(true);
    expect(await readTranscriptFile(transcriptAbs, t.source)).toEqual(t);
  });

  it('文件不存在 → null（不是抛错、不是空对象）', async () => {
    expect(await readTranscriptFile(join(tmpHome, 'nope.transcript.json'), null)).toBeNull();
  });

  it('🔴 指纹不符 → null（音频被替换后不展示过期文稿）', async () => {
    const p = join(tmpHome, 'stale.transcript.json');
    await writeTranscriptFile(p, mkTranscript({ source: { size: 100, mtimeMs: 1000 } }));

    expect(await readTranscriptFile(p, { size: 100, mtimeMs: 1000 })).not.toBeNull();
    expect(await readTranscriptFile(p, { size: 101, mtimeMs: 1000 })).toBeNull();
    expect(await readTranscriptFile(p, { size: 100, mtimeMs: 1001 })).toBeNull();
  });

  it('sidecar 记了指纹但音频已不在（current = null）→ null', async () => {
    const p = join(tmpHome, 'gone.transcript.json');
    await writeTranscriptFile(p, mkTranscript());
    expect(await readTranscriptFile(p, null)).toBeNull();
  });

  it('sidecar 没记指纹 → 放行（无法对账就不惩罚）', async () => {
    const p = join(tmpHome, 'no-fingerprint.transcript.json');
    await writeTranscriptFile(p, mkTranscript({ source: null }));
    expect(await readTranscriptFile(p, { size: 9, mtimeMs: 9 })).not.toBeNull();
  });

  it('非法 JSON → null', async () => {
    const p = join(tmpHome, 'broken.transcript.json');
    writeFileSync(p, '{ not json');
    expect(await readTranscriptFile(p, null)).toBeNull();
  });
});

/**
 * 影子目录（库外音频的产物）：列出 + 清理。
 *
 * 判据重点是**两条安全护栏**与"识别正式库条目"—— 这里错一次就会删掉用户导入的音频。
 */
describe('listShadowDirs / deleteShadowDir', () => {
  it('只列没有 source.* 的目录；正式库条目不算影子目录', async () => {
    const libEntry = join(libraryRoot(), '录音-aaaaaaaaaa');
    const shadow = join(libraryRoot(), '录音-111111111111');
    await fsp.mkdir(libEntry, { recursive: true });
    await fsp.mkdir(shadow, { recursive: true });
    await fsp.writeFile(join(libEntry, 'source.m4a'), 'x');
    await fsp.writeFile(join(shadow, '录音.marks.json'), '[{"t":1}]');

    const list = await listShadowDirs();
    const dirs = list.map((e) => e.dir);
    expect(dirs).toContain('录音-111111111111');
    expect(dirs).not.toContain('录音-aaaaaaaaaa');
    const one = list.find((e) => e.dir === '录音-111111111111');
    expect(one?.files.map((f) => f.name)).toEqual(['录音.marks.json']);
    expect(one?.sourcePath).toBeNull(); // 早期目录无记录
    expect(one?.sourceExists).toBeNull();
  });

  it('有 .source-ref.json 时给出"源是否还在"（源已不存在 ⇒ 判定为无主）', async () => {
    const shadow = join(libraryRoot(), '录音-222222222222');
    await fsp.mkdir(shadow, { recursive: true });
    await fsp.writeFile(join(shadow, '.source-ref.json'), JSON.stringify({ path: '/tmp/definitely-not-here-9f3a.m4a' }));
    const one = (await listShadowDirs()).find((e) => e.dir === '录音-222222222222');
    expect(one?.sourcePath).toBe('/tmp/definitely-not-here-9f3a.m4a');
    expect(one?.sourceExists).toBe(false);
  });

  it('🔴 护栏①：拒绝删除库根之外的目录', async () => {
    await expect(deleteShadowDir('/tmp')).rejects.toThrow(/outside the audio library/);
  });

  it('🔴 护栏②：拒绝删除**正式库条目**（有 source.* ⇒ 必须走库列表）', async () => {
    const libEntry = join(libraryRoot(), '录音-bbbbbbbbbb');
    await fsp.mkdir(libEntry, { recursive: true });
    await fsp.writeFile(join(libEntry, 'source.m4a'), 'x');
    await expect(deleteShadowDir(libEntry)).rejects.toThrow(/library entry/i);
    // 且目录仍在（拒绝不能是"删了再报错"）
    expect(existsSync(join(libEntry, 'source.m4a'))).toBe(true);
  });

  it('影子目录可正常删除（连同里面的产物）', async () => {
    const shadow = join(libraryRoot(), '录音-333333333333');
    await fsp.mkdir(shadow, { recursive: true });
    await fsp.writeFile(join(shadow, '录音.peaks.json'), '{}');
    await deleteShadowDir(shadow);
    expect(existsSync(shadow)).toBe(false);
    expect((await listShadowDirs()).some((e) => e.dir === '录音-333333333333')).toBe(false);
  });

  it('删除不存在的影子目录 ⇒ 明确报错（不静默成功）', async () => {
    await expect(deleteShadowDir(join(libraryRoot(), '录音-444444444444'))).rejects.toThrow(/not found/);
  });
});
