/**
 * lib/platform/process.ts — 进程查询/终止的平台语义
 *
 * 解决的问题（全部是「在 mac 上永远正确、到 Windows 上静默失效」）：
 *   1. `main.ts` 端口占用探测硬编码 `/usr/sbin/lsof -tiTCP:PORT` → Windows 无 lsof，
 *      spawnSync 直接 ENOENT，`probe.stdout` 为空 ⇒ **一个残留进程都清不掉**，
 *      表现为「端口被占 → 服务起不来 → 闪退」，日志里却只看到一句 spawn error。
 *   2. `killStaleNextServers()` 用 `ps axo pid=,command=` + 正则 `/^\s*(\d+)\s+next-server/`
 *      识别孤儿：macOS 上 Next standalone 会把 process.title 改成 `next-server (v15.x)`，
 *      **Windows 没有进程标题这个概念**（命令行始终是 `BobWork.exe … server.js`）⇒ 判据整体不成立。
 *   3. `process.kill(pid, 'SIGKILL')` 在 Windows 上被 Node 映射为 TerminateProcess，
 *      「信号」语义不存在 ⇒ 想杀进程树必须显式 `taskkill /T`。
 *   4. `plugin-panels-server.ts` 的 `ps -o ppid=` 取父 pid + `ppid === 1` 判孤儿：
 *      Windows **没有 reparent 到 1 的机制**，孤儿进程的 ParentProcessId 保留为「已死的旧父 pid」
 *      ⇒ 判据要改成「父进程是否还活着」。
 *
 * 设计约束（与 binaries.ts 一致）：
 *   - 纯解析器与 I/O 分离，解析器可在 mac 上用 Windows 的样例输出做单测；
 *   - **同步版只给 Electron 主进程用**（主进程可以做阻塞探测）；Next 服务端事件循环里
 *     必须用 `*Async` 版本，否则一次 spawnSync 会卡住整个 HTTP 服务；
 *   - 查不到就返回空数组/ null 并**留下可读日志**，绝不假装成功（见 §7 静默失效）。
 */

import { execFile, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { IS_WIN, PLATFORM, type PlatformId } from './runtime';

// ==================== 纯解析器（可在任意平台单测） ====================

/**
 * `lsof -tiTCP:<port> -sTCP:LISTEN` 的输出：一行一个 pid。
 * 例：`8876\n8877\n`
 */
export function parseLsofPids(stdout: string): number[] {
  const out: number[] = [];
  for (const raw of (stdout || '').split('\n')) {
    const s = raw.trim();
    if (!/^\d+$/.test(s)) continue;
    const pid = Number(s);
    if (pid > 0 && !out.includes(pid)) out.push(pid);
  }
  return out;
}

/**
 * `netstat -ano -p tcp` 的输出 → 监听指定端口的 pid。
 *
 * 样例（中文 Windows 的表头是中文，但**状态列恒为英文** LISTENING/ESTABLISHED）：
 * ```
 *   协议  本地地址          外部地址        状态           PID
 *   TCP    0.0.0.0:8321     0.0.0.0:0       LISTENING       8876
 *   TCP    [::]:8321        [::]:0          LISTENING       8876
 *   UDP    0.0.0.0:500       *:*                             1234
 * ```
 *
 * 为什么不用「本地地址以 :PORT 结尾」单独判定：一条**出站**连接如果恰好用了同名本地端口，
 * 就会命中并把正常进程杀掉。因此必须同时要求状态是 LISTENING。
 *
 * `otherStates` 收集「端口对得上但状态不是 LISTEN」的状态词，供上层在
 * 「一个都没杀到却起不来」时打日志——避免又一次静默失效。
 */
export function parseNetstatListenPids(
  stdout: string,
  port: number,
): { pids: number[]; otherStates: string[] } {
  const pids: number[] = [];
  const otherStates: string[] = [];
  const suffix = `:${port}`;
  for (const raw of (stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    if (t.length < 4) continue;
    const proto = t[0].toUpperCase();
    if (proto !== 'TCP' && proto !== 'TCPV6') continue; // UDP 无监听语义
    // 本地地址是第 2 列（index 1）；`0.0.0.0:8321` / `[::]:8321` / `127.0.0.1:8321` 均以 `:PORT` 结尾
    if (!t[1].endsWith(suffix)) continue;
    const pid = Number(t[t.length - 1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const state = t.length >= 5 ? t[3] : '';
    if (/^LISTEN/i.test(state)) {
      if (!pids.includes(pid)) pids.push(pid);
    } else if (state && !otherStates.includes(state)) {
      otherStates.push(state);
    }
  }
  return { pids, otherStates };
}

/**
 * `ps axo pid=,command=` 的输出 → 命令行以 `prefix` 开头的 pid。
 *
 * ⚠️ 只对 macOS 有意义（Next standalone 的 process.title 会变成 `next-server (vX.Y)`，
 * **命令行里不含路径**，所以不能用路径匹配）。Windows 侧改用 CIM 的 CommandLine 匹配。
 */
export function parsePsByCommandPrefix(stdout: string, prefix: string): number[] {
  const out: number[] = [];
  for (const line of (stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    if (!m[2].startsWith(prefix)) continue;
    const pid = Number(m[1]);
    if (pid > 0 && !out.includes(pid)) out.push(pid);
  }
  return out;
}

/**
 * `lsof -a -d cwd -p <pids>` 的输出 → cwd 落在 `needle` 路径下的 pid。
 *
 * 样例（`node 12345 user cwd DIR 1,15 4160 123456 /Applications/BobWork.app/.../next-standalone`）：
 * 第一列是进程名（可能含空格？不会——lsof 会截断到 9 字符且不含空格），第二列是 pid。
 */
export function parseLsofCwdPids(stdout: string, needle: string): number[] {
  const out: number[] = [];
  for (const line of (stdout || '').split('\n')) {
    if (!line.includes(needle)) continue;
    const m = line.match(/^\S+\s+(\d+)\s/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid > 0 && !out.includes(pid)) out.push(pid);
  }
  return out;
}

/** `Get-CimInstance Win32_Process | Select-Object … | ConvertTo-Json` 的元素 */
export interface CimProcess {
  ProcessId: number;
  ParentProcessId?: number;
  ExecutablePath?: string | null;
  CommandLine?: string | null;
}

/**
 * 解析 PowerShell 的 `ConvertTo-Json` 输出。
 * 注意：结果只有一个对象时 PowerShell 输出 `{...}` 而不是 `[{...}]`（经典陷阱），
 * 直接 `JSON.parse(...).map` 会抛 TypeError。
 */
export function parseCimProcessJson(stdout: string): CimProcess[] {
  const text = (stdout || '').trim();
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : [data];
  return arr.filter(
    (x): x is CimProcess => !!x && typeof (x as CimProcess).ProcessId === 'number',
  );
}

/** 从 CIM 结果里挑出 CommandLine 含 `needle` 的 pid（排除自身） */
export function filterCimByCommandLine(
  list: readonly CimProcess[],
  needle: string,
  selfPid = process.pid,
): number[] {
  const out: number[] = [];
  for (const p of list) {
    if (p.ProcessId === selfPid) continue;
    if (!p.CommandLine || !p.CommandLine.includes(needle)) continue;
    if (!out.includes(p.ProcessId)) out.push(p.ProcessId);
  }
  return out;
}

/** `ps -o ppid= -p PID` / PowerShell 单值输出 → pid；非法返回 null */
export function parseSinglePid(stdout: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(stdout || '');
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// ==================== 命令构造（纯函数） ====================

/** PowerShell `-EncodedCommand` 要求 UTF-16LE + base64：彻底绕开引号/反斜杠转义问题 */
export function encodePowershell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 列出「命令含 `needle`」的进程的 PowerShell 脚本。
 * 不按进程名过滤：electron-builder 会把可执行文件改名成产品名（BobWork.exe），
 * 硬编码 `electron.exe` 会在正式包里一个都匹配不到。
 */
export function cimCommandLineQueryScript(needle: string): string {
  const safe = needle.replace(/'/g, "''"); // PowerShell 单引号转义
  return (
    "$ErrorActionPreference='SilentlyContinue';" +
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${safe}*' } | ` +
    'Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  );
}

export function cimParentPidScript(pid: number): string {
  return (
    "$ErrorActionPreference='SilentlyContinue';" +
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').ParentProcessId`
  );
}

/** Windows 系统目录下的 exe 绝对路径（不依赖 PATH，GUI 进程 PATH 常不完整） */
export function systemExe(name: string, env: NodeJS.ProcessEnv = process.env, platform: PlatformId = PLATFORM): string {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

// ==================== 运行时（I/O） ====================

/**
 * 监听指定端口的 pid 列表。
 *
 * darwin/linux：`lsof -tiTCP:PORT -sTCP:LISTEN`
 * win32：`netstat -ano -p tcp` 解析 LISTENING 行
 *
 * 失败返回空数组（调用方据此降级到「HTTP 探测能否连上」，而不是断言端口空闲）。
 */
export function parseListeningPids(
  platform: PlatformId,
  port: number,
  run: (cmd: string, args: readonly string[]) => { ok: boolean; stdout: string },
): { pids: number[]; otherStates: string[] } {
  if (platform === 'win32') {
    const r = run(systemExe('netstat.exe'), ['-ano', '-p', 'tcp']);
    if (!r.ok) return { pids: [], otherStates: [] };
    return parseNetstatListenPids(r.stdout, port);
  }
  // lsof 全路径：Finder 启动的 GUI 进程 PATH 里没有 /usr/sbin
  const r = run('/usr/sbin/lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']);
  if (!r.ok) return { pids: [], otherStates: [] };
  return { pids: parseLsofPids(r.stdout), otherStates: [] };
}

function runSync(cmd: string, args: readonly string[], timeout = 4000): { ok: boolean; stdout: string; detail?: string } {
  try {
    const r = spawnSync(cmd, args as string[], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    if (r.error) return { ok: false, stdout: r.stdout ? String(r.stdout) : '', detail: r.error.message };
    return { ok: true, stdout: r.stdout ? String(r.stdout) : '' };
  } catch (e) {
    return { ok: false, stdout: '', detail: (e as Error).message };
  }
}

/** 同步版：仅限 Electron 主进程（阻塞式探测） */
export function listListeningPidsSync(port: number): { pids: number[]; otherStates: string[] } {
  return parseListeningPids(PLATFORM, port, (cmd, args) => runSync(cmd, args, 3000));
}

/** 异步版：给 Next 服务端事件循环用（禁止 spawnSync）。契约同 `parseListeningPids`：失败返回空，不 reject。 */
export function listListeningPidsAsync(port: number): Promise<{ pids: number[]; otherStates: string[] }> {
  const cmd = IS_WIN ? systemExe('netstat.exe') : '/usr/sbin/lsof';
  const args = IS_WIN ? ['-ano', '-p', 'tcp'] : [`-tiTCP:${port}`, '-sTCP:LISTEN'];
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve({ pids: [], otherStates: [] });
        const text = String(stdout || '');
        resolve(
          IS_WIN ? parseNetstatListenPids(text, port) : { pids: parseLsofPids(text), otherStates: [] },
        );
      });
    } catch {
      // spawn 阶段同步抛出（EPERM / 目标不存在）⇒ 按「查不到」降级，调用方会转 HTTP 探测
      resolve({ pids: [], otherStates: [] });
    }
  });
}

/** 进程是否存活（信号 0 探测；Windows 上 Node 用 OpenProcess 实现，同样可用） */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 终止一个进程（树）。
 *
 * - POSIX：`SIGTERM` → 调用方等一段时间 → `SIGKILL`；
 * - Windows：**没有信号语义**，`process.kill` 等同 TerminateProcess。
 *   要连带子进程必须 `taskkill /T`；不加 `/F` 只会给窗口发 WM_CLOSE，
 *   对无窗口的控制台子进程通常无效，因此失败后再补 `/F`。
 *
 * 返回是否「发起了终止」（不代表进程已退出，退出要轮询 isPidAlive）。
 */
export function terminatePid(pid: number, opts: { force?: boolean; tree?: boolean } = {}): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const force = !!opts.force;
  if (IS_WIN) {
    const args = ['/PID', String(pid)];
    if (opts.tree) args.push('/T');
    if (force) args.push('/F');
    const r = runSync(systemExe('taskkill.exe'), args, 5000);
    if (r.ok) return true;
    // 非 /F 且目标是无窗口控制台进程时 taskkill 会失败（"can only be terminated forcefully"）
    if (!force) return runSync(systemExe('taskkill.exe'), [...args, '/F'], 5000).ok;
    return false;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * 取父 pid（异步；失败 null）
 *
 * ⚠️ 必须**永不 reject**：调用方是陈旧进程回收路径，一次 reject 就会让整个回收流程中断，
 * 而回收失败的表现只是「下一轮启动端口被占」。`execFile` 在 spawn 阶段失败（如 EPERM、
 * 沙盒拦截、PATH 里没有 ps）时**可能同步抛**，这里统一兜成 null。
 */
export function processParentPidAsync(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      if (IS_WIN) {
        const script = encodePowershell(cimParentPidScript(pid));
        execFile(
          systemExe('WindowsPowerShell\\v1.0\\powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', script],
          { timeout: 6000 },
          (err, stdout) => resolve(err ? null : parseSinglePid(String(stdout || ''))),
        );
        return;
      }
      // `ps` 用全路径：与 /usr/sbin/lsof 同理（GUI 进程 PATH 不完整），也避免依赖 PATH 解析
      execFile('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
        resolve(err ? null : parseSinglePid(String(stdout || '')));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * 「这个 pid 是不是可以回收的残留进程」——两平台判据不同，不能共用一条规则：
 *
 * - POSIX：父是本进程（重复 spawn 的上一代）或父已被 launchd 收养（ppid === 1）；
 * - Windows：**没有 reparent**，孤儿进程的 ParentProcessId 仍指向那个已死的 pid。
 *   所以判据变成「父是本进程」或「父已不存在」。用 `ppid === 1` 在 Windows 上永远为假
 *   （Windows 的 pid 1 通常不存在），会得到一个静默失效的 `return false`。
 */
export async function isReapableStale(
  pid: number,
  opts: { selfPid?: number; selfPpid?: number } = {},
): Promise<boolean> {
  const selfPid = opts.selfPid ?? process.pid;
  const selfPpid = opts.selfPpid ?? process.ppid;
  if (pid === selfPid || pid === selfPpid) return false;
  const ppid = await processParentPidAsync(pid);
  if (ppid === null) {
    // 取不到父 pid：Windows 上多半是进程已退出（视为可回收，交由 isPidAlive 复核）
    return IS_WIN ? true : false;
  }
  if (ppid === selfPid) return true;
  if (IS_WIN) return !isPidAlive(ppid);
  return ppid === 1;
}

/**
 * 本应用残留的 next-standalone 进程。
 *
 * - darwin：`ps axo pid=,command=` 按进程标题 `next-server` 初筛 → `lsof -d cwd` 按
 *   工作目录二次确认（双保险不误杀别的应用的 next-server）；
 * - win32：`Get-CimInstance Win32_Process` 按 **CommandLine 含 `needle`** 匹配。
 *   Windows 上命令行是完整路径（`BobWork.exe --max-old-space-size=1024 …\next-standalone\server.js`），
 *   比 mac 的进程标题判据更精确，无需二次确认。
 *
 * `needle` 用相对稳定的路径片段（`next-standalone`）而不是绝对路径：安装位置可能变。
 */
export function listStaleServerPidsSync(needle: string): number[] {
  if (IS_WIN) {
    const script = encodePowershell(cimCommandLineQueryScript(needle));
    // PowerShell 冷启动 0.4–1.2s，给足超时（只在启动/退出各调一次）
    const r = runSync(systemExe('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], 15000);
    if (!r.ok) return [];
    return filterCimByCommandLine(parseCimProcessJson(r.stdout), needle);
  }
  const ps = runSync('ps', ['axo', 'pid=,command='], 3000);
  if (!ps.ok) return [];
  const candidates = parsePsByCommandPrefix(ps.stdout, 'next-server');
  if (candidates.length === 0) return [];
  const lsof = runSync('lsof', ['-a', '-d', 'cwd', '-p', candidates.join(',')], 4000);
  if (!lsof.ok) return [];
  return parseLsofCwdPids(lsof.stdout, needle).filter((p) => candidates.includes(p));
}
