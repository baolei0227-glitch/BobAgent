import { describe, expect, it } from 'vitest';
import { DEFAULT_MIME, fileMime } from '@/lib/files/mime';

/**
 * 这张表的价值全在「音频不能被下发成 octet-stream」——因为 `<audio src=代理URL>` 直连播放时
 * 它就是真实输入（旧路径先抓 Blob 再纠正 MIME，把这个问题遮住了）。
 * 同时必须确认**未收录类型仍回退 octet-stream**，不能顺手改掉其他文件的下载/预览语义。
 */
describe('fileMime', () => {
  it('音频全部有正确的 MIME（不能落到默认值）', () => {
    const expected: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.opus': 'audio/ogg',
      '.flac': 'audio/flac',
      '.aiff': 'audio/aiff',
      '.aif': 'audio/aiff',
    };
    for (const [ext, mime] of Object.entries(expected)) {
      expect(fileMime(ext)).toBe(mime);
      expect(fileMime(ext)).not.toBe(DEFAULT_MIME);
    }
  });

  it('大小写不敏感，带点与否都能取到', () => {
    expect(fileMime('.MP3')).toBe('audio/mpeg');
    expect(fileMime('mp3')).toBe('audio/mpeg');
    expect(fileMime('.M4A')).toBe('audio/mp4');
  });

  it('原有条目口径不变（回归保护）', () => {
    expect(fileMime('.html')).toBe('text/html; charset=utf-8');
    expect(fileMime('.pdf')).toBe('application/pdf');
    expect(fileMime('.png')).toBe('image/png');
    expect(fileMime('.svg')).toBe('image/svg+xml');
  });

  it('.webm 按容器口径归 video（与仓库其余 4 处一致）', () => {
    expect(fileMime('.webm')).toBe('video/webm');
    expect(fileMime('.mp4')).toBe('video/mp4');
  });

  it('未收录 / 空输入 → 默认二进制流（不改动其他类型的既有行为）', () => {
    expect(fileMime('.docx')).toBe(DEFAULT_MIME);
    expect(fileMime('.txt')).toBe(DEFAULT_MIME);
    expect(fileMime('.amr')).toBe(DEFAULT_MIME);
    expect(fileMime('')).toBe(DEFAULT_MIME);
  });
});
