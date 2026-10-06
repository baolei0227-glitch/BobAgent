import { describe, expect, it } from 'vitest';
import { materialPathToken, materialSourceTag, renderInventory } from '@/app/api/chat/tools/materials';

/**
 * 跨项目材料检索的回执格式回归（2026-10-05）。
 *
 * 锁两件事：
 *   ① **当前项目模式逐字节不变**（相对路径 + 原分组清单）——全仓 agent 的日常检索、成果块来源串
 *      都建立在这个形态上，一不小心改动就是隐形回归；
 *   ② 跨项目模式的约定：路径必须是**绝对**（read_attachment 会把相对路径解析到当前项目根，
 *      给相对路径必然读错文件），来源串必须带项目名限定（不是本项目的材料，不能混进本项目出处）。
 */
const ITEMS = [
  { relPath: '被告/合同.pdf', name: '合同.pdf', pageCount: 12, quality: 'text' },
  { relPath: '被告/回执.pdf', name: '回执.pdf', pageCount: 3, quality: 'vision' },
  { relPath: '清单.xlsx', name: '清单.xlsx', pageCount: 1, quality: 'text' },
];

describe('材料回执格式：当前项目 vs 跨项目', () => {
  it('当前项目：路径保持项目相对（read_attachment 按当前项目根寻址）', () => {
    expect(materialPathToken('/w/当前案_20260927', 'materials/被告/合同.pdf', 'current')).toBe('materials/被告/合同.pdf');
  });

  it('跨项目：路径一律绝对（相对路径会被解析到当前项目，读错文件）', () => {
    expect(materialPathToken('/w/余靖潘案_20260927', 'materials/被告/合同.pdf', 'foreign'))
      .toBe('/w/余靖潘案_20260927/materials/被告/合同.pdf');
    // 项目路径带尾斜杠时不出现双斜杠
    expect(materialPathToken('/w/余靖潘案_20260927/', 'materials/a.pdf', 'foreign'))
      .toBe('/w/余靖潘案_20260927/materials/a.pdf');
  });

  it('来源串：当前项目 = [来源: 材料:materials/…#pN]（页码可省）', () => {
    expect(materialSourceTag('materials/被告/合同.pdf', 3)).toBe('[来源: 材料:materials/被告/合同.pdf#p3]');
    expect(materialSourceTag('materials/被告/合同.pdf', undefined)).toBe('[来源: 材料:materials/被告/合同.pdf]');
  });

  it('来源串：跨项目带项目名限定（防被当成本项目材料的出处）', () => {
    expect(materialSourceTag('materials/被告/合同.pdf', 3, '余靖潘案')).toBe('[来源: 材料:余靖潘案:materials/被告/合同.pdf#p3]');
  });

  it('当前项目清单：分组形态与改造前逐字节一致（不传 target 即旧口径）', () => {
    const legacy = renderInventory(ITEMS, 3);
    expect(legacy).toBe(
      '项目材料清单（已建索引 3 份；未建索引/不支持索引的文件用 list_directory "materials/" 查看）：\n'
      + '【materials/被告】\n- 合同.pdf（12 页 · 文字层）\n- 回执.pdf（3 页 · 视觉识别）\n'
      + '【materials】\n- 清单.xlsx（1 页 · 文字层）',
    );
    // 显式传当前项目模式的 target，输出必须与旧口径一致
    expect(renderInventory(ITEMS, 3, { mode: 'current', name: '当前案', path: '/w/当前案' })).toBe(legacy);
  });

  it('跨项目清单：点名项目 + 逐条给绝对路径（不再分组）', () => {
    const out = renderInventory(ITEMS, 5, { mode: 'foreign', name: '余靖潘案', path: '/w/余靖潘案_20260927' });
    expect(out).toContain('项目「余靖潘案」材料清单（已建索引 5 份');
    expect(out).toContain('- /w/余靖潘案_20260927/materials/被告/合同.pdf（12 页 · 文字层）');
    expect(out).toContain('- /w/余靖潘案_20260927/materials/清单.xlsx（1 页 · 文字层）');
    expect(out).toContain('（仅列出前 3 条，共 5 份）');
  });
});
