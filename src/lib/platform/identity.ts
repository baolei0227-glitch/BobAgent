/**
 * lib/platform/identity.ts — 机器唯一标识（密钥派生指纹的取值来源）
 *
 * 为什么单独一个模块：
 *   它不属于「二进制/可执行文件解析」（binaries.ts），也不是纯语义常量（runtime.ts
 *   明令不做 I/O）；但它的每一支都**逐平台不同**，正是平台层该收的东西。
 *
 * 契约边界（改这里之前先读 secrets.ts 的说明）：
 *   本模块只负责「**怎么取**」，返回的是**带类型标签的原始值**；
 *   「取到的值拼成什么指纹串」由调用方（secrets.ts）决定 ——
 *   那个串是**数据契约**：已落盘的密文全部绑在它上面，标签格式一变，老密文就解不开。
 *   所以不要把标签格式挪进这一层。
 *
 * 选值标准：跨重启、跨网络稳定。
 *   - macOS：IOPlatformUUID（ioreg 读取）。注意 Apple Silicon 上 `sysctl -n hw.uuid`
 *     已返回 `unknown oid`，若此时退回主机名派生，主机名一变（DHCP 把 HostName 改成 IP、
 *     或用户改名）密钥就全部解不开。
 *   - Windows：注册表 MachineGuid（等价于 IOPlatformUUID，重装系统才会变）。
 *   - Linux：/etc/machine-id
 * 取不到一律返回空数组/空串，由调用方退回主机名候选（旧密文解密用）。
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { IS_DARWIN, PLATFORM } from './runtime';

/** 机器标识的种类。同时也是 secrets 侧指纹串的标签前缀（见模块头部的契约说明）。 */
export type MachineIdKind = 'hw.uuid' | 'machine-guid' | 'machine-id';

export interface MachineId {
  kind: MachineIdKind;
  value: string;
}

/** 同步执行外部命令取机器特征；失败返回空串（该候选直接跳过，不影响其它候选） */
function tryExec(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

/**
 * 硬件指纹候选（首选，跨重启/跨网络稳定），按优先级排列。
 *
 * ⚠️ 返回的**顺序**会被调用方当成候选顺序，且主候选（首个）用于加密 —— 改动顺序
 *    等于改密钥，会让老密文解不开。
 */
export function machineIds(): MachineId[] {
  const out: MachineId[] = [];
  if (IS_DARWIN) {
    const ioreg = tryExec('/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice');
    const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioreg)?.[1];
    if (uuid) out.push({ kind: 'hw.uuid', value: uuid });
    // Intel 机器仍可用（与 IOPlatformUUID 同值，去重后不重复派生）
    const sysctl = tryExec('/usr/sbin/sysctl -n hw.uuid');
    if (sysctl) out.push({ kind: 'hw.uuid', value: sysctl });
  } else if (PLATFORM === 'win32') {
    // 不加这一支时 Windows 会退到 hostname 派生 —— 主机名一改，settings.json 里的密文全部解不开。
    const raw = tryExec('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid');
    const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(raw);
    if (m) out.push({ kind: 'machine-guid', value: m[1] });
  } else if (PLATFORM === 'linux') {
    try {
      const id = readFileSync('/etc/machine-id', 'utf-8').trim();
      if (id) out.push({ kind: 'machine-id', value: id });
    } catch { /* 读不到就退到主机名候选 */ }
  }
  return out;
}

/**
 * macOS 本机 LocalHostName（未设 HostName 时 gethostname() 会返回 "<LocalHostName>.local"）。
 * 非 macOS 返回空串 —— secrets 侧的旧指纹候选只在 darwin 上有这一支。
 */
export function localHostName(): string {
  if (!IS_DARWIN) return '';
  return tryExec('/usr/sbin/scutil --get LocalHostName');
}
