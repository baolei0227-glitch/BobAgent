import { describe, expect, it } from 'vitest';
import {
  WAIT_LINES,
  WAIT_STRIP_MIN_SILENCE_SEC,
  WAIT_TIER_BOUNDS,
  waitLineFor,
  waitTierIndex,
  waitVoiceOf,
  type WaitVoice,
} from '@/lib/butler/wait-lines';

/**
 * 管家等待口语回归（2026-10-06 抽出并扩写时立的）。
 *
 * 这套文案的价值全在三条规矩上（见 wait-lines.ts 头注）：句式不重样、**只写永远成立的话**、
 * 句尾不写省略号。文案会持续扩写——本用例就是那道闸：往表里加句子时，
 * 一旦写出"猜进度"的句子（在读材料 / 在写代码…）或句尾多一个省略号，这里立刻红。
 *
 * 另一条锁的是**分档口径**：按「距上次可见输出」的静默时长升级，而不是整轮总时长
 *（2026-10-06 实测事故：一轮 74 秒无新字，界面完全静止 → 安抚文案必须能被静默唤醒）。
 */
const VOICES: WaitVoice[] = ['warm', 'cool', 'brief'];

/**
 * 规矩②的机械闸门：具体动作 / 进度词。
 * 这些词一旦出现，就是在替模型宣称"我正在做什么"——猜错即露馅，故一律禁止。
 * （`look` / `watch` 不在此列：它们只说"我在看这件事"，不宣称看了什么，与既有文案同档。）
 */
const FORBIDDEN_ACTION_WORDS = [
  'read', 'write', 'search', 'file', 'files', 'code', 'doc', 'docs', 'pdf', 'paper', 'material',
  '材料', '文件', '检索', '搜索', '读取', '写入', '代码', '文档',
];

describe('等待口语：规矩闸门', () => {
  it('每种话风每档都有句子，且已扩写（每档 ≥ 4 句）', () => {
    for (const voice of VOICES) {
      const tiers = WAIT_LINES[voice];
      expect(tiers.length, voice).toBe(WAIT_TIER_BOUNDS.length + 1);
      tiers.forEach((pool, i) => {
        expect(pool.length, `${voice}[${i}]`).toBeGreaterThanOrEqual(4);
      });
    }
  });

  it('规矩② 只写永远成立的话：不含具体动作 / 进度词', () => {
    for (const voice of VOICES) {
      for (const pool of WAIT_LINES[voice]) {
        for (const line of pool) {
          const lower = line.toLowerCase();
          for (const w of FORBIDDEN_ACTION_WORDS) {
            expect(lower.includes(w.toLowerCase()), `${voice}: 「${line}」命中禁用词 ${w}`).toBe(false);
          }
        }
      }
    }
  });

  it('规矩③ 句尾不写省略号（行尾已挂三个跳动点）', () => {
    for (const voice of VOICES) {
      for (const pool of WAIT_LINES[voice]) {
        for (const line of pool) {
          expect(/[.．。…]$/.test(line.replace(/\.$/, '')), `${voice}: 「${line}」`).toBe(false);
          expect(line.endsWith('…') || line.endsWith('...'), `${voice}: 「${line}」`).toBe(false);
        }
      }
    }
  });

  it('规矩① 不重样：同一话风内不重复（跨话风可以有同句——一个用户只会用到一种话风）', () => {
    for (const voice of VOICES) {
      const lines = WAIT_LINES[voice].flat();
      const dup = lines.filter((l, i) => lines.indexOf(l) !== i);
      expect(dup, `${voice} 档内重复：${dup.join(' / ')}`).toEqual([]);
    }
  });

  it('文案量已扩写（三话风合计 ≥ 50 句；抽模块前是 24 句）', () => {
    const total = VOICES.reduce((n, v) => n + WAIT_LINES[v].flat().length, 0);
    expect(total).toBeGreaterThanOrEqual(50);
  });
});

describe('等待口语：分档与轮换口径', () => {
  it('档位按**静默秒数**切（0-5 / 5-25 / 25-60 / 60+）', () => {
    expect(waitTierIndex(0)).toBe(0);
    expect(waitTierIndex(4.9)).toBe(0);
    expect(waitTierIndex(5)).toBe(1);
    expect(waitTierIndex(24.9)).toBe(1);
    expect(waitTierIndex(25)).toBe(2);
    expect(waitTierIndex(59.9)).toBe(2);
    expect(waitTierIndex(60)).toBe(3);
    expect(waitTierIndex(600)).toBe(3);
    // 异常输入按第一档（不抛、不越界）
    expect(waitTierIndex(Number.NaN)).toBe(0);
    expect(waitTierIndex(-3)).toBe(0);
  });

  it('每 5 秒换一句，且换的是**同档**里的句子', () => {
    const pool = WAIT_LINES.brief[1];
    const l0 = waitLineFor({ voice: 'brief', silenceSec: 5 });
    const l1 = waitLineFor({ voice: 'brief', silenceSec: 10 });
    expect(pool).toContain(l0);
    expect(pool).toContain(l1);
    expect(l0).not.toBe(l1);
    // 档内走满一轮（第三档 5 句 × 5s = 25s）回到同一句——回绕只在同档内有意义
    expect(waitLineFor({ voice: 'warm', silenceSec: 60 })).toBe(waitLineFor({ voice: 'warm', silenceSec: 85 }));
    // 极端秒数不抛、仍取到句子
    expect(typeof waitLineFor({ voice: 'cool', silenceSec: 99999 })).toBe('string');
  });

  it('越久越安抚：静默 30s / 90s 落到更靠后的档', () => {
    expect(WAIT_LINES.warm[2]).toContain(waitLineFor({ voice: 'warm', silenceSec: 30 }));
    expect(WAIT_LINES.warm[3]).toContain(waitLineFor({ voice: 'warm', silenceSec: 90 }));
  });

  it('称呼只拼在温和档第一档，其余档与他人设不受影响', () => {
    expect(waitLineFor({ voice: 'warm', silenceSec: 0, addressUser: '老板' })).toMatch(/^老板, /);
    expect(waitLineFor({ voice: 'warm', silenceSec: 0 })).not.toMatch(/^, /);
    expect(waitLineFor({ voice: 'warm', silenceSec: 30, addressUser: '老板' })).not.toMatch(/^老板/);
    expect(waitLineFor({ voice: 'cool', silenceSec: 0, addressUser: '老板' })).not.toMatch(/^老板/);
  });

  it('状态条出场阈值在第一档之后（8s），避免正常顿挫时闪烁', () => {
    expect(WAIT_STRIP_MIN_SILENCE_SEC).toBeGreaterThan(WAIT_TIER_BOUNDS[0]);
    expect(waitTierIndex(WAIT_STRIP_MIN_SILENCE_SEC)).toBe(1);
  });
});

describe('等待话风：由人设推导', () => {
  it('默认温和；傲娇/毒舌/高冷 → 高冷；简洁/利落 → 简洁', () => {
    expect(waitVoiceOf(null)).toBe('warm');
    expect(waitVoiceOf({ personality: '元气满满、热情积极' })).toBe('warm');
    expect(waitVoiceOf({ template: 'tsundere' })).toBe('cool');
    expect(waitVoiceOf({ personality: '傲娇但心软' })).toBe('cool');
    expect(waitVoiceOf({ style: '冷静、克制' })).toBe('cool');
    expect(waitVoiceOf({ style: '简洁、条理清晰' })).toBe('brief');
    expect(waitVoiceOf({ personality: '干练利落' })).toBe('brief');
  });
});
