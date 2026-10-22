/**
 * lib/platform/runtime.ts — 平台标识与 PATH/可执行文件语义（跨宿主共享）
 *
 * 为什么单独成层：
 *   本仓库的平台差异长期散落在 21 个文件（`process.platform` 15 处 + 大量 POSIX 字符串假设）。
 *   散落的成本不是「写起来麻烦」，而是**静默失效**：`PATH.split(':')` 在 Windows 上会把
 *   `C:\Windows` 切成 `C` + `\Windows`，不报错、只是子进程再也找不到命令。
 *
 * 硬约束（勿改）：
 *   1. 本目录**只允许相对导入**，禁止 `@/` 别名 —— `electron/main.ts` 由 tsup 编译成 CJS，
 *      路径别名在那里无法解析（同 `src/lib/screen-ocr/capture.ts` 的既有约定）。
 *   2. 本模块不做任何 I/O，也不在模块加载期抛错；需要探测文件系统的能力放在 binaries.ts。
 */

import * as path from 'node:path';

/** 归一化后的平台标识（把 process.platform 的其余取值（freebsd 等）并入 linux 语义） */
export type PlatformId = 'darwin' | 'win32' | 'linux';

export const PLATFORM: PlatformId =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

export const IS_WIN = PLATFORM === 'win32';
export const IS_DARWIN = PLATFORM === 'darwin';

/**
 * 处理器架构，原样透传 `process.arch`（`arm64` / `x64` / …）。
 *
 * 刻意**不做归一化**：sherpa-onnx 之类官方产物是按 `osx-arm64` / `osx-x64` 命名的，
 * 归一化反而要再映射回去；而拼错的后果是下载 404、静默装不上引擎。
 */
export const ARCH = process.arch;

/**
 * PATH 列表分隔符：Windows 为 `;`，POSIX 为 `:`。
 * 用 `path.delimiter` 而不是写字面量，是这套语义唯一的真源。
 */
export const PATH_DELIMITER = path.delimiter;

/** 路径比较键：Windows 大小写不敏感，POSIX 敏感 */
export function pathKey(p: string): string {
  return IS_WIN ? p.toLowerCase() : p;
}

/**
 * 给定平台的文件系统路径是否**默认大小写不敏感**（纯函数，便于单测）。
 *
 * 与 `pathKey` 刻意不同：那个只用于 PATH 去重（Linux 上路径确实敏感，不能小写化），
 * 而这里描述的是「用户磁盘上的路径是否等价」——
 *   - macOS APFS/HFS+ 默认不敏感；
 *   - Windows NTFS 默认不敏感（很多人误以为只有 mac 如此，于是写成 `platform === 'darwin'`）；
 *   - Linux ext4 敏感。
 * 判据写错的后果是**静默**的：Windows 上 `C:\Foo` 与 `c:\foo` 被当成两个目录，
 * 「把目录粘进它自己」的前缀检查失效 → fs.cp 递归复制自身直到磁盘满。
 */
export function caseInsensitiveFs(platform: PlatformId = PLATFORM): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** 当前平台的文件系统路径是否默认大小写不敏感 */
export const CASE_INSENSITIVE_FS = caseInsensitiveFs();

/** 按文件系统语义归一化路径（大小写不敏感平台统一小写） */
export function fsPathKey(p: string, platform: PlatformId = PLATFORM): string {
  return caseInsensitiveFs(platform) ? p.toLowerCase() : p;
}

/** 拆 PATH 字符串（空段丢弃；Windows 不按 `:` 切，避免切碎盘符） */
export function splitPathList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(PATH_DELIMITER)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 按**目标平台**的分隔符拆 PATH。
 *
 * 为什么不能复用 `splitPathList`：那个用的是宿主分隔符（`path.delimiter`）。
 * 一旦在 mac 上分析 Windows 的 PATH（跨平台探测 / 单测），
 * `C:\Users\X\WindowsApps;C:\Python312` 会被 `:` 切成
 * `['C', '\Users\X\WindowsApps;C', '\Python312']` —— 候选列表全错，
 * 而这类错误在真机上不会出现，只在验证路径上出现，属于**最难发现的一种**。
 */
export function splitPathListFor(raw: string | undefined | null, platform: PlatformId): string[] {
  if (!raw) return [];
  const sep = platform === 'win32' ? ';' : ':';
  return raw
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 保序去重（Windows 下按小写比较） */
export function dedupePaths(dirs: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d) continue;
    const k = pathKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

/** 拼 PATH 字符串 */
export function joinPathList(dirs: Iterable<string>): string {
  return dedupePaths(dirs).join(PATH_DELIMITER);
}

/**
 * 动态库搜索环境变量：把 shared 包的 lib 目录挂到子进程可见的位置。
 *
 * macOS 用 `DYLD_LIBRARY_PATH`，而 Windows **没有这个变量** —— 它按 PATH 搜 DLL。
 * 只写 `DYLD_*` 不会报错，只会让 Windows 子进程以 0xC0000135（DLL 未找到）退出，
 * 表现为「本地引擎明明装好了，一转写就崩」。
 */
export function sharedLibEnv(
  libDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (IS_WIN) return { PATH: joinPathList([libDir, ...splitPathList(env.PATH)]) };
  return { DYLD_LIBRARY_PATH: [libDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':') };
}

/** 补可执行后缀：Windows 加 `.exe`，其它平台原样 */
export function exeName(base: string, platform: PlatformId = PLATFORM): string {
  if (platform !== 'win32') return base;
  return /\.(exe|cmd|bat)$/i.test(base) ? base : `${base}.exe`;
}

/**
 * POSIX 工具链目录（Homebrew 优先）—— `lib/mcp/child-env.ts` 的历史顺序。
 *
 * ⚠️ 与 POSIX_SYSTEM_DIRS 的顺序**刻意不同**：这里 Homebrew 在前，因为子进程跑的是
 * 用户工具链（node/python/git 以 brew 安装为准）；而主进程建 PATH 时系统目录在前。
 * 合并这两个顺序会改变 mac 上「同名二进制谁先命中」，属于行为变更，禁止合并。
 */
export const POSIX_TOOLCHAIN_DIRS: readonly string[] = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/**
 * POSIX 系统目录（系统优先）—— `electron/main.ts` 的历史顺序。
 * 见 POSIX_TOOLCHAIN_DIRS 的说明：两份顺序不要合并。
 */
export const POSIX_SYSTEM_DIRS: readonly string[] = [
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
];

/**
 * Windows 常见可执行目录（按优先级）。
 *
 * 与 POSIX 不同，Windows 的 PATH 由系统与用户注册表合并后注入进程，通常已完整；
 * 这里只补「GUI 进程常见缺失」的几个：node 安装目录与 npm 全局 bin。
 * `%SystemRoot%\System32` 必须在内，否则 `curl.exe` / `tar.exe` / `where.exe` 找不到。
 */
export function windowsBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  // 用 path.win32 而不是 path.join：本函数描述的是 Windows 语义，
  // 在 mac 上跑单测时也必须拼出 `C:\...`，否则 Windows 分支永远测不出来。
  const join = path.win32.join;
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const appData = env.APPDATA || '';
  const out = [
    join(root, 'System32'),
    root,
    join(root, 'System32', 'Wbem'),
    join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    join(programFiles, 'nodejs'),
  ];
  if (appData) out.push(join(appData, 'npm'));
  return out;
}

/** 当前平台的基础 PATH 目录（仅目录，不含用户 shell 追加项） */
export function baseBinDirs(platform: PlatformId = PLATFORM): string[] {
  if (platform === 'win32') return windowsBinDirs();
  // POSIX：两个调用方顺序不同，默认给工具链顺序（子进程占多数场景）
  return [...POSIX_TOOLCHAIN_DIRS];
}
