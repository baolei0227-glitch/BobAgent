/**
 * 小程序桥写盘护栏（bridge-guards）回归。
 *
 * 背景（2026-10-02）：小程序桥的 `writeWanted` 能把任意文件写进全局 `butler/` 目录，
 * 文件名只做 `[a-zA-Z0-9._-]` 清洗 —— 于是 `preferences.md`（用户记忆真源，所有联系人共享）
 * 也在射程内，而且写的是 `fs.writeFile` **全量覆盖**：一次笼统确认就能清空全部记忆。
 * 本组锁住：butler 自己的真源/状态文件被拒；普通交付文件名照常放行；大小写与空白不绕过。
 */
import { describe, expect, it } from 'vitest';
import { isProtectedButlerFile, PROTECTED_BUTLER_FILES } from './bridge-guards';

describe('isProtectedButlerFile —— 小程序不该覆盖 Butler 自己的文件', () => {
  it('受保护清单里的文件一律拒绝（含大小写 / 空白变体）', () => {
    for (const name of PROTECTED_BUTLER_FILES) {
      expect(isProtectedButlerFile(name), name).toBe(true);
      expect(isProtectedButlerFile(name.toUpperCase()), name).toBe(true);
      expect(isProtectedButlerFile(`  ${name}  `), name).toBe(true);
    }
  });

  it('记忆真源必须在清单里（这条是本次护栏的目的）', () => {
    expect(PROTECTED_BUTLER_FILES).toContain('preferences.md');
    expect(isProtectedButlerFile('preferences.md')).toBe(true);
  });

  it('普通交付文件名照常放行（不误伤小程序的正常产出）', () => {
    for (const name of ['report.html', 'index.html', 'data.json', 'logo.png', 'notes.md', 'profile.md.bak']) {
      expect(isProtectedButlerFile(name), name).toBe(false);
    }
  });

  it('空值安全', () => {
    expect(isProtectedButlerFile('')).toBe(false);
    expect(isProtectedButlerFile('   ')).toBe(false);
  });
});
