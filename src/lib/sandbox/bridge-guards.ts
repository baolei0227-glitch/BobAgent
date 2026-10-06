/**
 * lib/sandbox/bridge-guards.ts —— 小程序桥（postMessage）的**服务端写盘护栏**（纯函数，无依赖）
 *
 * 背景（2026-10-02 核「记忆是否只有 Butler 能碰」时发现）：
 * `lib/sandbox/bridge.ts` 把 `writeWanted` 暴露给沙盒 iframe，语义是「把文件写进全局 `butler/` 目录」。
 * 落点只做了 `[a-zA-Z0-9._-]` 的文件名清洗（够挡目录穿越），但**没有区分文件归属** —— 于是
 * `preferences.md`（用户记忆真源）、`roles.json`（角色注册表）、`notify-state.json`（推送计数）、
 * `profile.md` 全在射程内，而且写的是 `fs.writeFile` **全量覆盖**：
 * 一次笼统的「小程序请求执行 writeWanted，是否允许？」就能清空用户的全部记忆。
 *
 * 故对 `butler/` **根目录下的平铺真源 / 状态文件**加硬护栏：拒绝写入，并说明原因。
 * 子目录（`.rules/`、`.skills/`、`.state/`）本就被文件名清洗挡住（清洗后不含 `/`），不在此列。
 */
export const PROTECTED_BUTLER_FILES: readonly string[] = [
  'preferences.md', // 用户长期记忆真源（所有联系人共享，明文 Markdown）
  'profile.md', // 用户档案（历史遗留文件，仍在 butler 根）
  'roles.json', // 角色注册表（threadId → 角色目录映射）
  'notify-state.json', // 推送计数（免打扰窗口 / 单日上限的状态）
];

/**
 * 该文件名是否是 Butler 自己的受保护文件。
 * 大小写不敏感、去首尾空白（Windows 上 `Preferences.MD` 与 `preferences.md` 是同一个文件）。
 */
export function isProtectedButlerFile(filename: string): boolean {
  const name = String(filename ?? '').trim().toLowerCase();
  if (!name) return false;
  return PROTECTED_BUTLER_FILES.some((p) => p.toLowerCase() === name);
}
