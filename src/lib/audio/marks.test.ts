import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  MARK_HINT_RE,
  parseClips,
  parseMarks,
  readMarksFile,
  serializeClips,
  serializeMarks,
  upsertClipRef,
  upsertMarkHint,
  writeMarksFile,
  type AudioClipRef,
} from '@/lib/audio/marks';

/**
 * 打点是**旁挂元信息**：解析必须对脏数据完全免疫（一行注释不该让回放报错），
 * 写回必须只动这一行、其余内容一字不改。这两条是回放能反复编辑打点而不损坏转写的前提。
 */
describe('parseMarks', () => {
  it('读出注释行里的打点，并按 t 升序', () => {
    const md = ['<!-- bob-audio: local:butler/meetings/录音 - X.webm -->', '<!-- bob-marks: [{"t":30},{"t":12.5,"label":"预算"}] -->', '# 会议记录'].join('\n');
    expect(parseMarks(md)).toEqual([
      { t: 12.5, label: '预算' },
      { t: 30 },
    ]);
  });

  it('没有指针 → 空数组', () => {
    expect(parseMarks('# 会议记录\n\n## 全文转写\n[00:00]\n正文')).toEqual([]);
  });

  it('指针内容不是合法 JSON → 空数组（不抛错）', () => {
    expect(parseMarks('<!-- bob-marks: {oops} -->')).toEqual([]);
  });

  it('不是数组 → 空数组', () => {
    expect(parseMarks('<!-- bob-marks: {"t":1} -->')).toEqual([]);
  });

  it('丢弃非法项：t 非数字 / 负数 / 项不是对象；空 label 不写字段', () => {
    const md = '<!-- bob-marks: [{"t":"x"},{"t":-1},5,{"t":3,"label":"  "},{"t":4,"label":" 提案 "}] -->';
    expect(parseMarks(md)).toEqual([{ t: 3 }, { t: 4, label: '提案' }]);
  });
});

describe('serializeMarks', () => {
  it('t 保留一位小数；label 为空时不写该字段', () => {
    expect(serializeMarks([{ t: 12.34 }, { t: 5, label: '  要点 ' }])).toBe('[{"t":12.3},{"t":5,"label":"要点"}]');
  });

  it('auto 仅在 true 时写出，且排在 label 之后', () => {
    expect(serializeMarks([{ t: 7, auto: true }, { t: 8, label: '手打' }, { t: 9, label: '自动', auto: true }])).toBe(
      '[{"t":7,"auto":true},{"t":8,"label":"手打"},{"t":9,"label":"自动","auto":true}]',
    );
  });
});

/**
 * 🔴 `auto` 是**可选字段**，两条持久化路径（md 注释行 / sidecar JSON）各有一份读写。
 * 只要有一条漏读/漏写，就是"写进去、读出来没了"的静默丢字段 —— tsc / eslint 都抓不到。
 * 故两个方向都断言，且**两条路径各测一次**。
 */
describe('AudioMark.auto 往返（md 注释行 + sidecar 两条路径）', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bw-marks-auto-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const mixed = [{ t: 1, auto: true as const }, { t: 2, label: '手打点' }, { t: 3, label: '自动点', auto: true as const }];

  it('md 路径：upsertMarkHint → parseMarks 保住 auto', () => {
    const md = upsertMarkHint('# 记录', mixed);
    expect(md).toContain('"auto":true');
    expect(parseMarks(md)).toEqual(mixed);
  });

  it('sidecar 路径：writeMarksFile → readMarksFile 保住 auto', async () => {
    const abs = join(dir, 'auto-roundtrip.marks.json');
    await writeMarksFile(abs, mixed);
    expect(await readMarksFile(abs)).toEqual(mixed);
  });

  it('手打点恒不写 auto 字段（旧数据语义 = 手打点，无需迁移）', () => {
    expect(serializeMarks([{ t: 1 }, { t: 2, label: 'x' }])).not.toContain('auto');
  });
});

describe('upsertMarkHint', () => {
  it('无打点时删除注释行，并保持其余内容不动', () => {
    const md = ['<!-- bob-audio: local:a.webm -->', '<!-- bob-marks: [{"t":1}] -->', '# 记录'].join('\n');
    expect(upsertMarkHint(md, [])).toBe(['<!-- bob-audio: local:a.webm -->', '# 记录'].join('\n'));
  });

  it('已有注释行 → 原位替换', () => {
    const md = ['<!-- bob-audio: local:a.webm -->', '<!-- bob-marks: [{"t":1}] -->', '# 记录'].join('\n');
    expect(upsertMarkHint(md, [{ t: 9 }])).toBe(
      ['<!-- bob-audio: local:a.webm -->', '<!-- bob-marks: [{"t":9}] -->', '# 记录'].join('\n'),
    );
  });

  it('没有注释行 → 紧跟在 bob-audio 行之后插入', () => {
    const md = ['<!-- bob-audio: local:a.webm -->', '', '## 全文转写', '[00:00]', '正文'].join('\n');
    expect(upsertMarkHint(md, [{ t: 2, label: 'a' }])).toBe(
      ['<!-- bob-audio: local:a.webm -->', '<!-- bob-marks: [{"t":2,"label":"a"}] -->', '', '## 全文转写', '[00:00]', '正文'].join('\n'),
    );
  });

  it('没有 bob-audio 行（老产物）→ 插到文件最前', () => {
    const md = ['# 会议记录 - X', '正文'].join('\n');
    expect(upsertMarkHint(md, [{ t: 2 }])).toBe(['<!-- bob-marks: [{"t":2}] -->', '# 会议记录 - X', '正文'].join('\n'));
  });

  it('写回后可被 parseMarks 原样读回（往返）', () => {
    const md = '<!-- bob-audio: local:a.webm -->\n# 记录';
    const marks = [{ t: 1.2 }, { t: 63.456, label: '结论' }];
    expect(parseMarks(upsertMarkHint(md, marks))).toEqual([{ t: 1.2 }, { t: 63.5, label: '结论' }]);
  });
});

describe('MARK_HINT_RE', () => {
  it('只认独占一行的注释行', () => {
    expect(MARK_HINT_RE.test('<!-- bob-marks: [{"t":1}] -->')).toBe(true);
    expect(MARK_HINT_RE.test('见 <!-- bob-marks: [{"t":1}] --> 一行')).toBe(false);
    expect(MARK_HINT_RE.test('<!-- bob-audio: local:a.webm -->')).toBe(false);
  });
});

describe('parseClips / serializeClips', () => {
  it('往返：写出再读回一致（start 升序，t 保留一位小数）', () => {
    const clips: AudioClipRef[] = [
      { path: '/a/.audio-clips/x-1/片段 - b.mp3', name: '片段 - b.mp3', start: 30.04, end: 42.46 },
      { path: '/a/.audio-clips/x-1/片段 - a.webm', name: '片段 - a.webm', start: 5, end: 8 },
    ];
    expect(parseClips(serializeClips(clips))).toEqual([
      { path: '/a/.audio-clips/x-1/片段 - a.webm', name: '片段 - a.webm', start: 5, end: 8 },
      { path: '/a/.audio-clips/x-1/片段 - b.mp3', name: '片段 - b.mp3', start: 30, end: 42.5 },
    ]);
  });

  it('脏数据当空：非 JSON / 非数组 / 缺 path / start 非法', () => {
    expect(parseClips('{oops}')).toEqual([]);
    expect(parseClips('{"path":"/a.mp3"}')).toEqual([]);
    expect(parseClips('[{"name":"x","start":1,"end":2}]')).toEqual([]);
    expect(parseClips('[{"path":"/a.mp3","start":"x","end":2}]')).toEqual([]);
  });

  it('name 缺失时用 path 的文件名兜底', () => {
    expect(parseClips('[{"path":"/a/b.mp3","start":1,"end":2}]')).toEqual([
      { path: '/a/b.mp3', name: 'b.mp3', start: 1, end: 2 },
    ]);
  });
});

describe('upsertClipRef', () => {
  const mk = (path: string, start: number, end = start + 1): AudioClipRef => ({ path, name: path.split('/').pop()!, start, end });

  it('追加后按 start 升序', () => {
    const list = upsertClipRef([mk('/a/c.webm', 30)], mk('/a/a.webm', 5));
    expect(list.map((c) => c.path)).toEqual(['/a/a.webm', '/a/c.webm']);
  });

  it('同 path 视为重导 → 替换旧条目，不产生重复', () => {
    const list = upsertClipRef([mk('/a/c.webm', 30, 40)], mk('/a/c.webm', 10, 12));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ start: 10, end: 12 });
  });

  it('不修改入参（返回新数组）', () => {
    const before = [mk('/a/c.webm', 30)];
    upsertClipRef(before, mk('/a/a.webm', 5));
    expect(before).toHaveLength(1);
  });
});

/**
 * sidecar 落盘：`writeMarksFile` 必须**自己保证父目录存在**。
 *
 * 为什么这不是普通防御：库外音频（项目 materials / 任意本地路径）的打点放在**影子目录**
 * `<源名>-<指纹>/` 里，而该目录只有「导出过片段」或「算过波形缓存」才会被创建
 * （见 `library.ts:71` 的 `sourceDir(…, ensure=false)`）。所以给一个从未产生过副产物的
 * 库外音频打第一个点，父目录必然不存在 ⇒ `fs.writeFile` 直接 ENOENT ⇒ 路由 500。
 * 同类问题在 `writePeaksCache` 里已经踩过并修了（`peaks.ts:244-245` 的注释写着同样的理由），
 * `writeMarksFile` 是漏掉的那一处。
 *
 * 症状的不对称性值得记住：`marks.length === 0` 分支走的是包了 try/catch 的 `unlink`
 * ⇒ **删光打点不报错、加一个打点才 500**。
 */
describe('writeMarksFile / readMarksFile（sidecar 落盘）', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'bw-marks-test-'));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('父目录不存在时也能写成功（首次给库外音频打点）', async () => {
    const abs = join(tmp, 'shadow-dir-never-created', 'nested', 'source.marks.json');
    // ① 先断言前提：父目录确实不存在（否则本测试会退化成平凡为真）
    expect(existsSync(dirname(abs))).toBe(false);

    // ② 不预建目录，直接写
    await writeMarksFile(abs, [{ t: 12.5, label: '预算' }, { t: 30 }]);

    // ③ 文件落盘，且能原样读回（按 t 升序）
    expect(existsSync(abs)).toBe(true);
    expect(await readMarksFile(abs)).toEqual([{ t: 12.5, label: '预算' }, { t: 30 }]);
  });

  it('空数组 → 不抛错、不建文件，且**不创建目录**（不留空目录垃圾）', async () => {
    const dir = join(tmp, 'empty-case-dir');
    const abs = join(dir, 'source.marks.json');
    expect(existsSync(dir)).toBe(false);

    await expect(writeMarksFile(abs, [])).resolves.toBeUndefined();

    expect(existsSync(abs)).toBe(false);
    expect(existsSync(dir)).toBe(false); // 与删除语义一致：不该有副作用
  });

  it('目录已存在时正常覆盖写', async () => {
    const dir = join(tmp, 'existing-dir');
    const abs = join(dir, 'source.marks.json');
    await writeMarksFile(abs, [{ t: 1 }]); // 首次写入顺带建目录
    await writeMarksFile(abs, [{ t: 9, label: '改后' }]);

    expect(await readMarksFile(abs)).toEqual([{ t: 9, label: '改后' }]);
  });
});
