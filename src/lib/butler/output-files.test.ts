import { describe, expect, it } from 'vitest';
import { extractOutputFiles, isDeliverablePath, restoreOutputFileLines } from '@/lib/butler/output-files';

/**
 * 管家产物文件行解析（2026-10-05 从 ButlerDrawer 抽出并扩展）。
 *
 * 为什么要有绝对路径这一档：管家是跨项目助手 —— 「查一下 X 项目的资料，把那份合同发我」时，
 * `search_materials project=X` 给的是**绝对路径**，而卡片侧的 WechatFileCard / ButlerDocPanel
 * 早已支持绝对路径；此前只有这道正则不认，表现为「管家说发了，对话里什么都没有」。
 */
describe('OutputFile 行解析', () => {
  it('项目相对路径：解析出文件并把这行从正文里剥离', () => {
    const { files, clean } = extractOutputFiles('结论如下。\nOutputFile: homework/意见书.md\n');
    expect(files).toEqual([{ path: 'homework/意见书.md', name: '意见书.md' }]);
    expect(clean).not.toContain('OutputFile');
    expect(clean).toContain('结论如下。');
  });

  it('绝对路径：接受（跨项目文件交付的唯一形态）', () => {
    const p = '/Users/bob/BobWorkspace/余靖潘案_20260927/materials/被告/合同.pdf';
    const { files, clean } = extractOutputFiles(`已找到该材料。\nOutputFile: ${p}\n`);
    expect(files).toEqual([{ path: p, name: '合同.pdf' }]);
    expect(clean.trim()).toBe('已找到该材料。');
  });

  it('home 路径与 Windows 反斜杠归一化', () => {
    expect(extractOutputFiles('OutputFile: ~/Desktop/a.docx').files).toEqual([{ path: '~/Desktop/a.docx', name: 'a.docx' }]);
    expect(extractOutputFiles('OutputFile: homework\\b.md').files).toEqual([{ path: 'homework/b.md', name: 'b.md' }]);
  });

  it('同一路径只出一张卡；多行按出现顺序保留', () => {
    const { files } = extractOutputFiles(
      'OutputFile: materials/a.pdf\nOutputFile: materials/b.pdf\nOutputFile: materials/a.pdf\n',
    );
    expect(files.map((f) => f.path)).toEqual(['materials/a.pdf', 'materials/b.pdf']);
  });

  it('非交付形态（脚本临时区/裸文件名/URL）不做卡片', () => {
    for (const raw of ['foo.md', 'tmp/x.md', 'https://example.com/a.pdf', '../outside.md']) {
      expect(isDeliverablePath(raw), raw).toBe(false);
      expect(extractOutputFiles(`OutputFile: ${raw}`).files, raw).toEqual([]);
    }
    // 反例对照：这些才是可交付形态
    for (const raw of ['homework/a.md', 'materials/a.pdf', 'attachments/a.docx', '.sandbox/apps/x/index.html', '~/a.md', '/abs/a.pdf']) {
      expect(isDeliverablePath(raw), raw).toBe(true);
    }
  });

  it('没有产物行时正文原样返回', () => {
    const body = '只有结论，没有文件。';
    expect(extractOutputFiles(body)).toEqual({ files: [], clean: body });
    expect(extractOutputFiles('')).toEqual({ files: [], clean: '' });
  });
});

/**
 * 卡片读不出来时的兜底（2026-10-05）：产物行已被剥离，若不还原，用户连路径都看不到。
 * 触发场景见 profiles.ts 的交付纪律：相对路径卡片在管家切过项目后会解析到别的项目。
 */
describe('读失败的产物行还原', () => {
  it('把打不开的路径还原回正文末尾，路径仍可见可复制', () => {
    expect(restoreOutputFileLines('结论见文件。', ['homework/意见书.md'])).toBe(
      '结论见文件。\n\nOutputFile: homework/意见书.md',
    );
  });

  it('没有失败项时正文原样返回（不引入多余空行）', () => {
    expect(restoreOutputFileLines('结论。', [])).toBe('结论。');
    expect(restoreOutputFileLines('结论。\n', [])).toBe('结论。\n');
  });

  it('正文为空（纯文件消息）时只给还原行，不留前导空行', () => {
    expect(restoreOutputFileLines('', ['/abs/a.pdf'])).toBe('OutputFile: /abs/a.pdf');
  });

  it('多个失败项按给定顺序逐行还原', () => {
    expect(restoreOutputFileLines('X', ['homework/a.md', 'materials/b.pdf'])).toBe(
      'X\n\nOutputFile: homework/a.md\nOutputFile: materials/b.pdf',
    );
  });
});
