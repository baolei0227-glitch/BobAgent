/**
 * lib/platform/binaries.ts — 外部可执行文件的解析与能力探测
 *
 * 解决的具体故障（全部是「不报错、只是功能消失」）：
 *   - `net/download.ts` 硬编码 `/usr/bin/curl`、`/usr/bin/tar` → Windows 上引擎/模型下载全挂；
 *   - 8 处硬编码 `/usr/bin/python3` → Windows 无系统 python3，Office/文档修订/图片裁剪全废；
 *   - `main.ts` 的 `FFMPEG_PATH` 无 `.exe` → 音视频解析拿不到 ffmpeg。
 *
 * 设计原则（对应评估文档 §10.3 的「能力探针」判据）：
 *   1. **缺能力必须显式抛错**（`requireCapability`），不得返回 null 让调用方悄悄降级；
 *   2. 解析结果**缓存**（同一个二进制在一次进程生命周期内只探测一次）；
 *   3. 所有候选列表是**纯函数**产出，便于单测用假 env / 假 exists 覆盖 Windows 分支。
 *
 * 本目录只允许相对导入（tsup 会把这里编进 electron/dist）。
 */

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { IS_WIN, PATH_DELIMITER, PLATFORM, exeName, splitPathListFor, windowsBinDirs, type PlatformId } from './runtime';

/** 探测用的存在性判定（单测可注入） */
export type ExistsFn = (p: string) => boolean;

const defaultExists: ExistsFn = (p) => {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
};

/** 返回第一个存在的候选路径 */
export function pickFirstExisting(candidates: readonly string[], exists: ExistsFn = defaultExists): string | null {
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return null;
}

/**
 * PATH 中的目录列表（按**目标平台**的分隔符拆分，空值安全）。
 *
 * 必须传 platform：在 mac 上分析 Windows 的 PATH 时，用宿主分隔符 `:` 会把
 * `C:\...\WindowsApps;C:\Python312` 切成三截，候选列表整体失真。
 */
function pathDirs(env: NodeJS.ProcessEnv, platform: PlatformId = PLATFORM): string[] {
  return splitPathListFor(env.PATH || env.Path || '', platform);
}

/**
 * 按**目标平台**选择 join：Windows 用 `path.win32`，POSIX 用 `path.posix`。
 * 不能用 `path.join`——它跟随宿主平台，会让 Windows 分支在 mac 上拼出 `/`，
 * 既掩盖真实缺陷，也让该分支无法被单测覆盖。
 */
function joinFor(platform: PlatformId): (...parts: string[]) => string {
  return platform === 'win32' ? path.win32.join : path.posix.join;
}

/**
 * 系统二进制候选路径（纯函数，便于单测）。
 *
 * POSIX：先查系统固定目录，再查 PATH（Finder/launchd 启动的 GUI 进程 PATH 往往不完整）。
 * Windows：`System32` 优先（`curl.exe`/`tar.exe` 自 Win10 1803 起随系统），其次 PATH。
 */
export function systemBinaryCandidates(
  name: string,
  platform: PlatformId = PLATFORM,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const join = joinFor(platform);
  if (platform === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    const dirs = [join(root, 'System32'), root, ...pathDirs(env, platform)];
    return dirs.map((d) => join(d, exeName(name, 'win32')));
  }
  const fixed = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...fixed, ...pathDirs(env)].map((d) => join(d, name));
}

/**
 * python 解释器候选（纯函数）。
 *
 * Windows 上刻意把**随包内置目录**排在 PATH 之前：目标机可能完全没装 Python，
 * 而 BobWork 依赖 `python-docx` / `Pillow` 等第三方包，只能用自带运行时
 * （见评估文档 §10.2-E：嵌入 Python + wheels 是阶段 E 的交付物）。
 *
 * ⚠️ 两个 Windows 专属陷阱（都会让「找到了 python」变成假象）：
 *
 * 1. **Microsoft Store 的 `python.exe` 是 0 字节 App Execution Alias**
 *    （`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`）。它是 reparse point，
 *    `existsSync` 返回 **true**，但一执行就打开应用商店、什么都不跑。
 *    若不禁用，`resolvePython()` 会理直气壮地返回这个假 python，
 *    之后 Office 模板填充/dcox 修订全部以「模块找不到」的形式失败 —— 与真因完全无关。
 *    ⇒ 候选列表**必须剔除** WindowsApps 目录。
 *
 * 2. **只装 launcher 的机器没有 `python.exe`，只有 `py.exe`**。
 *    `py script.py` 默认选最新 Python 3，等价于 `py -3 script.py`，可直接当解释器用。
 *    排在 `python.exe` 之后（有真解释器时优先用真的）。
 */
export function pythonCandidates(
  platform: PlatformId = PLATFORM,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const join = joinFor(platform);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || '';
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    // 随包资源目录：安装版是 <resources>/python，由 scripts/assemble-win-python.mjs 组装。
    // 主进程与 Next 服务子进程都要能解析它 —— 后者没有 process.resourcesPath，
    // 故 main.ts 会显式注入 BOBWORK_RESOURCES，这里是同一套语义的第二入口。
    const resources =
      env.BOBWORK_RESOURCES ||
      (process as unknown as { resourcesPath?: string }).resourcesPath ||
      '';
    const bundled = [
      // 主进程显式注入（打包版一定有）：直接命中随包解释器，省掉一次目录猜测
      env.BOBWORK_PYTHON || '',
      resources ? join(resources, 'python', 'python.exe') : '',
      local ? join(local, 'BobWork', 'python', 'python.exe') : '',
      join(programFiles, 'BobWork', 'python', 'python.exe'),
    ].filter(Boolean);
    // 剔除 WindowsApps：那里的 python.exe/python3.exe 是商店别名，不是解释器
    const dirs = pathDirs(env, platform).filter((d) => !/[\\/]WindowsApps[\\/]?$/i.test(d));
    const fromPath = dirs.map((d) => join(d, 'python.exe'));
    const launchers = dirs.map((d) => join(d, 'py.exe'));
    return [...bundled, ...fromPath, ...launchers];
  }
  const fixed = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
  const fromPath = pathDirs(env, platform).map((d) => join(d, 'python3'));
  return [...fixed, ...fromPath];
}

const cache = new Map<string, string | null>();

/** 解析系统二进制；找不到返回 null（调用方应改用 requireCapability 以获得可读错误） */
export function resolveSystemBinary(name: string, platform: PlatformId = PLATFORM, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = `${platform}:${name}`;
  if (cache.has(key)) return cache.get(key) as string | null;
  const found = pickFirstExisting(systemBinaryCandidates(name, platform, env));
  cache.set(key, found);
  return found;
}

/** 解析 python3；darwin 上解析结果与历史硬编码 `/usr/bin/python3` 一致 */
export function resolvePython(platform: PlatformId = PLATFORM, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = `${platform}:python`;
  if (cache.has(key)) return cache.get(key) as string | null;
  const found = pickFirstExisting(pythonCandidates(platform, env));
  cache.set(key, found);
  return found;
}

/** 清缓存（供测试与「用户刚装完运行时」场景） */
export function resetBinaryCache(): void {
  cache.clear();
}

/**
 * 取 Python 解释器绝对路径；缺失时抛可读错误。
 *
 * 用途：替换散落 8 处的硬编码。darwin 上解析结果仍是 `/usr/bin/python3`（与历史一致），
 * Windows 上优先随包内置运行时（见 pythonCandidates）。
 *
 * 错误信息里**列出实际尝试过的路径**：只说「找不到 Python」等于让用户去猜，
 * 而这张候选表恰恰是本项目最容易被改错的地方（WindowsApps 假解释器、py.exe、随包目录）。
 * 把「找过哪儿」写进报错，下一次排查就不用再读源码。
 */
export function pythonBin(usedBy = 'Python 脚本'): string {
  const p = resolvePython();
  if (!p) {
    const tried = pythonCandidates(PLATFORM, process.env).filter(Boolean);
    const shown = tried.slice(0, 8);
    const more = tried.length > shown.length ? `\n  …（共 ${tried.length} 个候选）` : '';
    throw new Error(
      `找不到 Python 解释器（${usedBy} 需要）。\n已尝试：\n` +
        shown.map((t) => `  · ${t}`).join('\n') +
        more +
        '\n' +
        (IS_WIN
          ? 'Windows 版应随包内置嵌入式 Python（含 python-docx / Pillow / lxml）：' +
            '<应用目录>\\resources\\python\\python.exe。若该目录不存在，说明安装不完整。'
          : '请安装 Xcode Command Line Tools（xcode-select --install）或 python3。'),
    );
  }
  return p;
}

/**
 * 在 shell 命令字符串里引用一个路径。
 *
 * 只在含空白时加双引号——Windows 上随包 Python 很可能落在
 * `C:\Program Files\BobWork\python\python.exe`，不加引号会被 shell 拆成两个词。
 * 用 execFile + argv 数组的调用点不需要它。
 */
export function shellArg(p: string): string {
  return /[\s]/.test(p) ? `"${p}"` : p;
}

/**
 * 给子进程注入的 PATH（工具链目录 + 当前 PATH）。
 *
 * 与旧实现的等价性：darwin 上等于
 *   ['/usr/bin','/bin','/usr/sbin','/sbin','/opt/homebrew/bin','/usr/local/bin', process.env.PATH].join(':')
 * —— 保留原有顺序与「末尾整体追加当前 PATH」的语义，不做去重（避免改变子进程看到的字符串）。
 */
export function toolPathEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dirs = IS_WIN
    ? windowsBinDirs(env)
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'];
  return [...dirs, env.PATH || ''].join(PATH_DELIMITER);
}

// ==================== 能力表 ====================

export type CapabilityId = 'curl' | 'tar' | 'zip' | 'python' | 'ffmpeg' | 'clang' | 'bash' | 'powershell';

export interface Capability {
  id: CapabilityId;
  available: boolean;
  /** 解析到的绝对路径（可解析项才有） */
  path?: string;
  /** 缺能力时给用户的处置建议 */
  hint: string;
}

const HINTS: Record<CapabilityId, string> = {
  curl: IS_WIN ? 'Windows 10 1803+ 自带 curl.exe；缺失请检查 System32 是否在 PATH 中。' : 'macOS 自带 /usr/bin/curl。',
  tar: IS_WIN ? 'Windows 10 1803+ 自带 tar.exe（bsdtar）；缺失请检查 System32。' : 'macOS 自带 /usr/bin/tar。',
  zip: '内置打包器（adm-zip）随应用分发，无需系统 zip 命令。',
  python: IS_WIN ? '随包内置嵌入式 Python（<resources>/python，含 python-docx / Pillow / lxml）。缺失说明安装不完整。' : '需安装 Xcode Command Line Tools 或 python3。',
  ffmpeg: '随包分发（@ffmpeg-installer）—— 缺失说明依赖没装全：pnpm install 后重试。',
  clang: IS_WIN ? 'Windows 无 clang；标点/声纹的 C 源需改为预编译 DLL 或纯 JS/WASM。' : '需 Xcode Command Line Tools。',
  bash: IS_WIN ? 'Windows 无 bash；Agent 执行层需映射到 PowerShell。' : 'POSIX 自带。',
  powershell: '仅 Windows 有意义。',
};

/**
 * 解析 PowerShell 绝对路径。
 *
 * 与其它二进制不同：`powershell.exe` 不在 `System32` 根下，而在
 * `System32\WindowsPowerShell\v1.0\` 内 —— 用 `systemBinaryCandidates` 找不到。
 * 仅 Windows 有意义；POSIX 返回 null。
 */
export function resolvePowershell(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!IS_WIN) return null;
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return pickFirstExisting([
    path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.win32.join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]);
}

/**
 * 随包 ffmpeg 的候选路径（`@ffmpeg-installer` 按平台各装一份）。
 *
 * 为什么不能只查 PATH：ffmpeg 是**随应用分发**的，用户机器上本来就不该有系统 ffmpeg。
 * 只查 PATH 会让能力表在干净机器上误报「缺 ffmpeg」——而它其实躺在 node_modules 里，
 * 主进程也确实是按 `resources/bin/ffmpeg` 取它的（`main.ts` 的 `FFMPEG_PATH`）。
 *
 * pnpm 布局下平台包在
 * `node_modules/.pnpm/@ffmpeg-installer+ffmpeg@<ver>/node_modules/@ffmpeg-installer/<plat>-<arch>/`，
 * 因此除直连路径外还要扫一层 `.pnpm`（用 readdir + 前缀过滤，不引 glob 依赖）。
 */
export function bundledFfmpegCandidates(appRoot: string = process.cwd()): string[] {
  const pkgDir = `${PLATFORM}-${process.arch}`;
  const bin = exeName('ffmpeg', PLATFORM);
  const join = PLATFORM === 'win32' ? path.win32.join : path.posix.join;
  const out: string[] = [join(appRoot, 'node_modules', '@ffmpeg-installer', pkgDir, bin)];
  try {
    const pnpmDir = join(appRoot, 'node_modules', '.pnpm');
    for (const name of readdirSync(pnpmDir)) {
      if (!name.startsWith('@ffmpeg-installer+ffmpeg@')) continue;
      out.push(join(pnpmDir, name, 'node_modules', '@ffmpeg-installer', pkgDir, bin));
    }
  } catch {
    /* 非 pnpm 布局 / 目录不存在：直连路径已覆盖 */
  }
  return out;
}

/** 解析 ffmpeg：先随包，再 PATH */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env, appRoot: string = process.cwd()): string | null {
  return pickFirstExisting(bundledFfmpegCandidates(appRoot)) ?? resolveSystemBinary('ffmpeg', PLATFORM, env);
}

/** 探测单项能力（不抛错） */
export function probeCapability(id: CapabilityId): Capability {
  switch (id) {
    case 'python': {
      const p = resolvePython();
      return { id, available: !!p, path: p ?? undefined, hint: HINTS[id] };
    }
    case 'ffmpeg': {
      const p = resolveFfmpeg();
      return { id, available: !!p, path: p ?? undefined, hint: HINTS[id] };
    }
    case 'powershell': {
      const p = resolvePowershell();
      return { id, available: !!p, path: p ?? undefined, hint: HINTS[id] };
    }
    case 'zip': {
      // 两平台都不依赖系统 zip：主进程用随包的 adm-zip（见 electron/main.ts saveImages）。
      // 这里没有可解析的绝对路径，故不返回 path；需要打包时直接用内置实现。
      return { id, available: true, hint: HINTS[id] };
    }
    case 'bash': {
      const p = pickFirstExisting(systemBinaryCandidates(id));
      return { id, available: !!p, path: p ?? undefined, hint: HINTS[id] };
    }
    default: {
      const p = resolveSystemBinary(id);
      return { id, available: !!p, path: p ?? undefined, hint: HINTS[id] };
    }
  }
}

/**
 * 取一个必需能力；缺失时**抛错**（而不是返回 null 让上层静默降级）。
 *
 * 为什么必须抛：`if (!(await lsof())) return null` 这类写法在 mac 上无害，
 * 到 Windows 上会变成「功能消失了但没人知道」。缺能力的正确表现是可读失败。
 */
export function requireCapability(id: CapabilityId, usedBy: string): string {
  const cap = probeCapability(id);
  if (!cap.available || !cap.path) {
    throw new Error(`缺少必需能力 "${id}"（${usedBy} 需要）。${cap.hint}`);
  }
  return cap.path;
}

/** 全部能力的探测快照（启动自检 / 诊断面板用） */
export function capabilitySnapshot(): Capability[] {
  const ids: CapabilityId[] = ['curl', 'tar', 'zip', 'python', 'ffmpeg', 'clang', 'bash', 'powershell'];
  return ids.map(probeCapability);
}
