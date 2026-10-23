/**
 * 更新包命名/解析单测。
 *
 * 取向与 platform 测试一致：**每个平台都要有反例**。只断言「mac 名字对」的实现
 * 同样能通过，但 Windows 更新会在真机上静默失效（下载目标名对不上清单）。
 */
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  fileNameFromUpdateUrl,
  isPartialUpdateFile,
  isUpdatePackageFile,
  parseUpdateArtifact,
  pickLatestArtifact,
  updateArtifactName,
} from './artifact';

describe('updateArtifactName', () => {
  it('Windows 用 NSIS exe，macOS 用 zip', () => {
    expect(updateArtifactName('0.7.746', 'win32')).toBe('BobWork-0.7.746-win-x64.exe');
    expect(updateArtifactName('0.7.746', 'darwin')).toBe('BobWork-0.7.746-macos-arm64.zip');
  });

  it('两个平台的产物名都能被 parse 回同一版本（名字必须自洽）', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const name = updateArtifactName('1.2.3', platform);
      expect(parseUpdateArtifact(name)?.version).toBe('1.2.3');
    }
  });

  it('非法版本号直接抛错，而不是拼出无法识别的文件名', () => {
    expect(() => updateArtifactName('', 'win32')).toThrow();
    expect(() => updateArtifactName('0.7.x', 'win32')).toThrow();
    expect(() => updateArtifactName('../etc', 'win32')).toThrow();
  });
});

describe('fileNameFromUpdateUrl', () => {
  it('相对文件名原样保留', () => {
    expect(fileNameFromUpdateUrl('BobWork-0.7.746-win-x64.exe')).toBe(
      'BobWork-0.7.746-win-x64.exe',
    );
  });

  it('GitCode 绝对地址 + noCache query：只取最后一段并丢掉 query', () => {
    expect(
      fileNameFromUpdateUrl(
        'https://gitcode.com/baolei89/BobWork/releases/download/latest/BobWork-0.7.746-win-x64.exe?noCache=1',
      ),
    ).toBe('BobWork-0.7.746-win-x64.exe');
  });

  it('百分号编码会解码（中文版本名不应变成乱码文件）', () => {
    expect(fileNameFromUpdateUrl('https://cdn.example.com/a/BobWork-0.7.746-win-x64.exe')).toBe(
      'BobWork-0.7.746-win-x64.exe',
    );
    expect(fileNameFromUpdateUrl('BobWork-%30.7.746-win-x64.exe')).toBe(
      'BobWork-0.7.746-win-x64.exe',
    );
  });

  it('路径穿越被收敛为单段文件名，编码过的分隔符直接拒绝', () => {
    // 取 basename 是安全的：最终只会写进 updater 缓存目录内部的这个文件名
    expect(fileNameFromUpdateUrl('../../evil.exe')).toBe('evil.exe');
    // 解码后才出现的分隔符无法再靠“取 basename”修正，必须整条拒绝
    expect(fileNameFromUpdateUrl('https://cdn/a/..%2Fevil.exe')).toBe('');
    // 非 URL 的 Windows 风格路径：反斜杠原样保留，必须拒绝
    expect(fileNameFromUpdateUrl('..\\evil.exe')).toBe('');
    // 绝对 URL 里的反斜杠会被 URL 解析器当作分隔符并规范化，结果是安全的单段名
    expect(fileNameFromUpdateUrl('https://cdn/a/..\\evil.exe')).toBe('evil.exe');
    expect(fileNameFromUpdateUrl('')).toBe('');
    expect(fileNameFromUpdateUrl(undefined)).toBe('');
    expect(fileNameFromUpdateUrl('https://cdn/a/')).toBe('');
  });
});

describe('parseUpdateArtifact', () => {
  it('识别两个平台与扩展名', () => {
    expect(parseUpdateArtifact('BobWork-0.7.746-win-x64.exe')).toEqual({
      version: '0.7.746',
      platform: 'win-x64',
      ext: 'exe',
    });
    expect(parseUpdateArtifact('BobWork-0.7.746-macos-arm64.zip')).toEqual({
      version: '0.7.746',
      platform: 'macos-arm64',
      ext: 'zip',
    });
  });

  it('不是本应用产物的一律返回 null（清理逻辑不能误删）', () => {
    expect(parseUpdateArtifact('notes.txt')).toBeNull();
    expect(parseUpdateArtifact('BobWork-latest-win-x64.exe')).toBeNull();
    expect(parseUpdateArtifact('BobWork-0.7.746-win-x64.exe.partial')).toBeNull();
    expect(parseUpdateArtifact('')).toBeNull();
    expect(parseUpdateArtifact(undefined)).toBeNull();
  });

  it('partial 判定只认「合规包名 + .partial」', () => {
    expect(isPartialUpdateFile('BobWork-0.7.746-win-x64.exe.partial')).toBe(true);
    expect(isPartialUpdateFile('BobWork-0.7.746-macos-arm64.zip.partial')).toBe(true);
    expect(isPartialUpdateFile('BobWork-0.7.746-win-x64.exe')).toBe(false);
    expect(isPartialUpdateFile('random.partial')).toBe(false);
  });

  it('isUpdatePackageFile 与 parse 的结论一致', () => {
    expect(isUpdatePackageFile('BobWork-0.7.746-win-x64.exe')).toBe(true);
    expect(isUpdatePackageFile('BobWork-0.7.746-win-x64.exe.partial')).toBe(false);
  });
});

describe('版本比较与挑选', () => {
  it('按数字段比较，而不是字符串比较', () => {
    expect(compareVersions('0.7.10', '0.7.9')).toBeGreaterThan(0);
    expect(compareVersions('0.7.9', '0.7.9')).toBe(0);
    expect(compareVersions('0.7.9', '0.8.0')).toBeLessThan(0);
    // 段数不齐时按 0 补齐
    expect(compareVersions('0.8', '0.7.99')).toBeGreaterThan(0);
  });

  it('挑版本号最高的安装包（不能按字母序取第一个）', () => {
    const names = [
      'BobWork-0.7.9-win-x64.exe',
      'BobWork-0.7.10-win-x64.exe',
      'BobWork-0.7.2-win-x64.exe',
    ];
    expect(pickLatestArtifact(names, 'exe')).toBe('BobWork-0.7.10-win-x64.exe');
    // 字符串排序会把 0.7.9 排在 0.7.10 之后 —— 直接取「最后一个」正是要防的回归
    expect([...names].sort().at(-1)).toBe('BobWork-0.7.9-win-x64.exe');
  });

  it('忽略扩展名不符、命名不合规与未知文件', () => {
    const names = [
      'BobWork-0.7.10-macos-arm64.zip',
      'notes.txt',
      'BobWork-0.7.11-win-x64.exe.partial',
      'BobWork-0.7.12-win-x64.exe',
    ];
    expect(pickLatestArtifact(names, 'exe')).toBe('BobWork-0.7.12-win-x64.exe');
    expect(pickLatestArtifact(names, 'zip')).toBe('BobWork-0.7.10-macos-arm64.zip');
    expect(pickLatestArtifact(['notes.txt'], 'exe')).toBe('');
    expect(pickLatestArtifact([], 'exe')).toBe('');
  });
});
