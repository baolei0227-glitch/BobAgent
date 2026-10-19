/**
 * 平台适配层单测。
 *
 * 判据取向：**每个平台分支都要有反例**（Windows 候选里不得出现 `/usr/bin`，
 * POSIX 候选里不得出现 `.exe`）。只断言「正向包含」不足以证明分支真的分开了 ——
 * 一个永远返回 POSIX 列表的实现也能让正向断言通过。
 */
import { describe, expect, it } from 'vitest';
// 本项目的 ProcessEnv 把 NODE_ENV 标为必填，测试里构造部分 env 必须经 unknown 中转；
// 这不影响被测代码（它只读 PATH/SystemRoot 等可选键）。
import {
  PATH_DELIMITER,
  PLATFORM,
  caseInsensitiveFs,
  dedupePaths,
  exeName,
  fsPathKey,
  joinPathList,
  pathKey,
  pickFirstExisting,
  pythonCandidates,
  splitPathList,
  systemBinaryCandidates,
  windowsBinDirs,
} from './index';

describe('PATH 语义', () => {
  it('当前平台的 PATH 分隔符与 node:path 一致', () => {
    expect(PATH_DELIMITER).toBe(PLATFORM === 'win32' ? ';' : ':');
  });

  it('拆分时丢弃空段（连续分隔符不产生空目录）', () => {
    const raw = ['/a', '', '/b', '  '].join(PATH_DELIMITER);
    expect(splitPathList(raw)).toEqual(['/a', '/b']);
  });

  it('空值安全', () => {
    expect(splitPathList(undefined)).toEqual([]);
    expect(splitPathList('')).toEqual([]);
  });

  it('拼回保持历史口径（darwin 上必须逐字等于旧实现的 join(":")）', () => {
    if (PLATFORM === 'darwin') {
      expect(joinPathList(['/usr/bin', '/bin'])).toBe('/usr/bin:/bin');
    }
  });

  it('去重保序，且 Windows 下大小写不敏感', () => {
    expect(dedupePaths(['/a', '/b', '/a'])).toEqual(['/a', '/b']);
    if (PLATFORM === 'win32') {
      expect(dedupePaths(['C:\\Windows', 'c:\\windows'])).toEqual(['C:\\Windows']);
    }
  });
});

describe('文件系统路径大小写语义', () => {
  it('macOS 与 Windows 都不敏感，Linux 敏感', () => {
    // 判据写错是静默的：Windows 上把 `C:\Foo` 与 `c:\foo` 当成两个目录，
    // 「目录不能粘进自身」的前缀检查会失效 → fs.cp 递归复制自身。
    expect(caseInsensitiveFs('darwin')).toBe(true);
    expect(caseInsensitiveFs('win32')).toBe(true);
    expect(caseInsensitiveFs('linux')).toBe(false);
  });

  it('fsPathKey 与 pathKey 的差别就在 Linux（PATH 去重不能小写化）', () => {
    expect(fsPathKey('/A/B', 'win32')).toBe('/a/b');
    expect(fsPathKey('/A/B', 'linux')).toBe('/A/B');
    // ⚠️ pathKey 用的是**宿主**平台（IS_WIN），不是入参 —— 它只服务于「当前这台机器的
    // PATH 去重」。所以这里不能写死 '/A/B'：那等于假设测试永远跑在 POSIX 上，
    // 一旦在 windows-latest 上跑就必红（2026-10 真机 CI 抓到的就是这一条）。
    expect(pathKey('/A/B')).toBe(PLATFORM === 'win32' ? '/a/b' : '/A/B');
  });
});

describe('exeName', () => {  it('非 Windows 原样返回', () => {
    expect(exeName('ffmpeg', 'darwin')).toBe('ffmpeg');
    expect(exeName('ffmpeg', 'linux')).toBe('ffmpeg');
  });

  it('Windows 补 .exe，且不重复补', () => {
    expect(exeName('ffmpeg', 'win32')).toBe('ffmpeg.exe');
    expect(exeName('ffmpeg.exe', 'win32')).toBe('ffmpeg.exe');
  });
});

describe('系统二进制候选', () => {
  const winEnv = {
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    PATH: 'C:\\Tools;D:\\Bin',
  } as unknown as NodeJS.ProcessEnv;

  it('Windows：System32 优先，且全部带 .exe', () => {
    const c = systemBinaryCandidates('curl', 'win32', winEnv);
    expect(c[0]).toBe('C:\\Windows\\System32\\curl.exe');
    expect(c.every((p) => p.toLowerCase().endsWith('.exe'))).toBe(true);
  });

  it('反例：Windows 候选里不得出现任何 POSIX 系统目录', () => {
    const c = systemBinaryCandidates('curl', 'win32', winEnv);
    expect(c.some((p) => p.startsWith('/usr/'))).toBe(false);
    expect(c.some((p) => p.includes('\\opt\\homebrew'))).toBe(false);
  });

  it('POSIX：系统固定目录在 PATH 之前', () => {
    const c = systemBinaryCandidates('tar', 'darwin', { PATH: '/custom/bin' } as unknown as NodeJS.ProcessEnv);
    expect(c[0]).toBe('/usr/bin/tar');
    expect(c).toContain('/custom/bin/tar');
  });

  it('反例：POSIX 候选里不得出现 .exe', () => {
    const c = systemBinaryCandidates('tar', 'darwin', { PATH: '/custom/bin' } as unknown as NodeJS.ProcessEnv);
    expect(c.some((p) => p.endsWith('.exe'))).toBe(false);
  });
});

describe('python 候选', () => {
  it('darwin 首选 /usr/bin/python3（与历史硬编码一致）', () => {
    const c = pythonCandidates('darwin', { PATH: '/usr/local/bin' } as unknown as NodeJS.ProcessEnv);
    expect(c[0]).toBe('/usr/bin/python3');
  });

  it('Windows 首选随包内置运行时，而不是 PATH', () => {
    const c = pythonCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\X\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: 'C:\\Python312',
    } as unknown as NodeJS.ProcessEnv);
    expect(c[0]).toBe('C:\\Users\\X\\AppData\\Local\\BobWork\\python\\python.exe');
  });

  it('反例：Windows 候选里不得出现 /usr/bin/python3', () => {
    const c = pythonCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\X\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(c).not.toContain('/usr/bin/python3');
  });

  it('反例：不得采用 Microsoft Store 的 python.exe 别名（WindowsApps）', () => {
    // WindowsApps 下的 python.exe 是 0 字节 App Execution Alias：existsSync 为 true，
    // 但执行只会弹应用商店 —— 收进来就是一个「看起来找到了 python、实际什么都没跑」的假象。
    const c = pythonCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\X\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: 'C:\\Users\\X\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python312',
    } as unknown as NodeJS.ProcessEnv);
    expect(c.some((p) => /WindowsApps/i.test(p))).toBe(false);
    // 正常的 PATH 目录仍然要覆盖
    expect(c).toContain('C:\\Python312\\python.exe');
  });

  it('只装 launcher 的机器：py.exe 也要进候选（排在 python.exe 之后）', () => {
    const c = pythonCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\X\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      PATH: 'C:\\Windows\\py',
    } as unknown as NodeJS.ProcessEnv);
    expect(c).toContain('C:\\Windows\\py\\py.exe');
    expect(c.indexOf('C:\\Windows\\py\\py.exe')).toBeGreaterThan(c.indexOf('C:\\Windows\\py\\python.exe'));
  });

  it('反例：darwin 候选里不得出现 python.exe', () => {
    const c = pythonCandidates('darwin', { PATH: '' } as unknown as NodeJS.ProcessEnv);
    expect(c.some((p) => p.endsWith('python.exe'))).toBe(false);
  });
});

describe('pickFirstExisting', () => {
  it('返回第一个存在的候选', () => {
    const got = pickFirstExisting(['/nope', '/yes', '/also'], (p) => p === '/yes' || p === '/also');
    expect(got).toBe('/yes');
  });

  it('全都不存在时返回 null（由 requireCapability 负责给出可读错误）', () => {
    expect(pickFirstExisting(['/nope'], () => false)).toBeNull();
  });

  it('忽略空字符串候选（Windows 上 LOCALAPPDATA 缺失时会出现空项）', () => {
    expect(pickFirstExisting(['', '/yes'], (p) => p === '/yes')).toBe('/yes');
  });
});

describe('windowsBinDirs', () => {
  it('包含 System32 与 nodejs，缺 SystemRoot 时有兜底', () => {
    const dirs = windowsBinDirs({} as unknown as NodeJS.ProcessEnv);
    expect(dirs.some((d) => d.endsWith('System32'))).toBe(true);
    expect(dirs.some((d) => d.includes('nodejs'))).toBe(true);
  });

  it('APPDATA 缺失时不产出空路径段', () => {
    const dirs = windowsBinDirs({ SystemRoot: 'C:\\Windows' } as unknown as NodeJS.ProcessEnv);
    expect(dirs.every((d) => d.trim().length > 0)).toBe(true);
  });
});
