/**
 * lib/mcp/child-env.ts — MCP 子进程运行环境（server-only）
 *
 * 两个共用件（原先只存在于 mcp/manager.ts，2026-10-12 抽出供 OCR 常驻桥复用）：
 *   1. buildChildPath()   —— 合并 Homebrew / nvm / volta / npm global 与当前 PATH。
 *      GUI 应用（launchd 启动）继承的 PATH 极不完整，子进程里的 node / python3 / swift
 *      都可能找不到；统一走这里，行为与 electron/main.ts 的 buildChildPath 一致。
 *   2. nodeRuntimeSpawn() —— **不要** spawn 系统 PATH 里的 'node'：用户机器上可能根本没装 node，
 *      或装的是 x64 / 版本不符的 node（历史事故：随包原生模块 ABI 不匹配 → SIGSEGV）。
 *      打包版宿主自己就跑在「Electron as node」上（electron/main.ts 以
 *      spawn(process.execPath, [server], { env: { ELECTRON_RUN_AS_NODE: '1' } }) 启动 server），
 *      因此子进程一律用 process.execPath + ELECTRON_RUN_AS_NODE=1：
 *        - 打包版：Electron 内置 Node 运行时（与随包原生模块架构/ABI 必然一致）
 *        - dev 版：就是当前 node（ELECTRON_RUN_AS_NODE 对 node 无副作用）
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IS_WIN, POSIX_TOOLCHAIN_DIRS, windowsBinDirs, splitPathList, joinPathList } from '../platform';

/** 构建子进程 PATH（与 electron/main.ts 的 buildChildPath 同口径，但顺序不同——见 platform/runtime.ts 注释） */
export function buildChildPath(): string {
  const home = homedir();
  // 目录表按平台取：Windows 上绝不能塞 POSIX 目录（不存在且会把 PATH 撑长）
  const paths: string[] = IS_WIN ? windowsBinDirs() : [...POSIX_TOOLCHAIN_DIRS];
  // nvm
  try {
    const nvmDir = join(home, '.nvm/versions/node');
    if (existsSync(nvmDir)) {
      for (const ver of readdirSync(nvmDir)) {
        paths.push(join(nvmDir, ver, 'bin'));
      }
    }
  } catch {}
  // volta（Windows 装在 %LOCALAPPDATA%\Volta\bin）
  paths.push(IS_WIN ? join(process.env.LOCALAPPDATA || join(home, 'AppData/Local'), 'Volta/bin') : join(home, '.volta/bin'));
  // npm global
  paths.push(join(home, '.npm-global/bin'));
  // 当前 process.env.PATH（Windows 上必须按 ';' 切，否则盘符会被切碎）
  paths.push(...splitPathList(process.env.PATH));
  return joinPathList(paths);
}

/** 以「Node 模式」运行 JS 入口时使用的可执行文件与环境变量 */
export function nodeRuntime(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** command 是否为「本机 JS 入口」（需要 Node 运行时来执行的那些） */
const LOCAL_NODE_COMMANDS = new Set(['node', 'node.exe']);

/**
 * 解析 stdio 插件子进程的运行时 —— 本仓库所有「随包/本机 MCP 插件启动」的统一出口。
 *
 * 为什么需要（2026-10-19 工单《插件启动层统一》P0）：
 *   预置本地插件（bob-notes / bob-mind / bob-video-shot / bob-team / bob-preview / coze…）
 *   的 command 写的是 `node`，直接交给 transport spawn 会落到**用户系统 PATH 的 node**上：
 *     - 用户没装 node（或 PATH 里找不到）→ ENOENT，插件在真机上「拉不起来」；
 *     - 装的是 x64 / 版本不符的 node → 随包原生模块 ABI 不匹配 → SIGSEGV（历史事故）。
 *   因此凡是「本机 JS 插件」（command 为 node）一律改走 Electron 内置 Node 运行时，
 *   与 electron/main.ts 启动 server、ocr-bridge 拉起常驻桥同一条口径（见本文件头注释）。
 *
 * 其余命令（npx 类市场插件、python3、用户自定义绝对路径等）**原样保留** ——
 * 它们本就依赖外部环境（npm / python），宿主不代为兜底，避免制造「假装能动」的假象。
 */
export function resolveStdioRuntime(
  command: string | undefined,
): { command: string; env: Record<string, string> } {
  const cmd = (command ?? '').trim();
  if (LOCAL_NODE_COMMANDS.has(cmd.toLowerCase())) {
    const rt = nodeRuntime();
    return { command: rt.command, env: rt.env };
  }
  return { command: cmd || 'npx', env: {} };
}

/**
 * 用 Node 运行时拉起一个 JS 入口（本仓库所有「宿主托管子进程」的统一出口）。
 * 调用方只需给 args 与额外 env；PATH / ELECTRON_RUN_AS_NODE 已按上面口径注入。
 */
export function spawnNodeProcess(
  args: string[],
  opts: Omit<SpawnOptions, 'env'> & { env?: Record<string, string | undefined> } = {},
): ChildProcess {
  const { env, ...rest } = opts;
  const rt = nodeRuntime();
  return spawn(rt.command, args, {
    ...rest,
    env: {
      ...process.env,
      PATH: buildChildPath(),
      ...rt.env,
      ...(env || {}),
    } as NodeJS.ProcessEnv,
  });
}
