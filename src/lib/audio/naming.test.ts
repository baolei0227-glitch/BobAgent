import { describe, expect, it } from 'vitest';
import { audioTitle, clipBaseName, clipStamp, safeBaseName } from '@/lib/audio/naming';

/**
 * 命名是**纯字符串**逻辑，两侧（服务端导出 / 客户端预填）共用，所以单独测。
 * 关键不变式：文件名里不能出现冒号等文件系统非法字符；用户改名不能造成 `x.mp3.mp3`。
 */
describe('clipStamp', () => {
  it('秒 → mm-ss（文件名里不能有冒号）；负数按 0', () => {
    expect(clipStamp(5)).toBe('00-05');
    expect(clipStamp(62)).toBe('01-02');
    expect(clipStamp(0)).toBe('00-00');
    expect(clipStamp(-3)).toBe('00-00');
  });
});

describe('clipBaseName', () => {
  it('起止都进名（同一场多段不互相覆盖），且**不含扩展名**（留给容器决定）', () => {
    expect(clipBaseName('周会', 5, 62)).toBe('片段 - 周会 - 00-05-01-02');
    expect(clipBaseName('周会', 5, 62)).not.toContain(':');
    expect(clipBaseName('周会', 5, 62)).not.toContain('.');
  });
});

describe('safeBaseName', () => {
  it('剥掉自带扩展名，避免 `x.mp3.mp3`', () => {
    expect(safeBaseName('我的片段.mp3')).toBe('我的片段');
    expect(safeBaseName('a.WEBM')).toBe('a');
  });

  it('替换文件系统非法字符与换行', () => {
    expect(safeBaseName('a/b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i');
    expect(safeBaseName('a\nb')).toBe('a-b');
  });

  it('去掉开头的点（防止生成隐藏文件）；纯空白 → 空串（调用方回退默认名）', () => {
    expect(safeBaseName('...hidden')).toBe('hidden');
    expect(safeBaseName('   ')).toBe('');
    expect(safeBaseName('')).toBe('');
  });

  it('超长截断到 80', () => {
    expect(safeBaseName('x'.repeat(200)).length).toBe(80);
  });
});

describe('audioTitle', () => {
  it('去掉扩展名；没有名字时兜底 Audio', () => {
    expect(audioTitle('录音 - 周会.webm')).toBe('录音 - 周会');
    expect(audioTitle('')).toBe('Audio');
  });
});