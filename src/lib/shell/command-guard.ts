/**
 * lib/shell/command-guard.ts — run_command / execute_script 的命令安全判定
 *
 * 为什么单独成模块：这套判定是**安全边界**，必须能被单测直接打靶。
 * 原先它内联在 `api/chat/tools/index.ts`（5500 行、依赖整棵服务端树），
 * 一改就没人敢动，也就没人发现它**整套规则只对 POSIX 成立**。
 *
 * 到 Windows 上原样运行会发生什么（这是本文件存在的全部理由）：
 *   - `rm -rf /` 拦得住，但 `del /f /s /q C:\*`、`rd /s /q C:\Users\bob`、
 *     `Remove-Item -Recurse -Force C:\` 全在放行侧 —— 同样的破坏力，零拦截；
 *   - `format C:`、`diskpart`、`bcdedit`、`shutdown /s`、`wevtutil cl` 同样放行；
 *   - 个人目录守卫只认 `~` 与 `/Users/`，`C:\Users\bob\Desktop` 完全不匹配 ⇒
 *     「禁止 shell 绕过 read_file 权限门控」这条规则在 Windows 上等于不存在。
 *
 * 设计取舍（刻意的）：
 *   1. **POSIX 规则一字不改地保留**，`checkDangerousCommand` 在任何平台都先跑它们
 *      —— 保证 mac 行为零变更，同时挡住 Windows 上 git-bash 里敲的 `rm -rf /`；
 *   2. Windows 侧不用一条巨型正则，而是「破坏性动词 + 灾难目标」两段式判定：
 *      动词和目标的组合才是灾难（`del foo.txt` 合法，`del /s /q C:\` 是灾难），
 *      写成一条正则既读不懂也必然误杀；
 *   3. 所有函数都能传 `platform` / `home` / `authorizedRoots`，因此 Windows 分支
 *      可以在 mac 上被真实样例驱动测试（与 `lib/platform` 同一套取向）。
 */

import { homedir } from 'node:os';
import { PLATFORM, type PlatformId } from '../platform/runtime';

// ==================== POSIX 规则（冻结，勿改语义） ====================

/**
 * 危险命令模式：匹配即拦截（防止不可恢复的破坏性操作）。
 *
 * ⚠️ 这组规则自 2026 年起在 mac 上就是线上判据，**改任何一条都要同步 mac 验收**。
 * Windows 侧的补充请加到 `WINDOWS_DANGEROUS_PATTERNS`，不要在这里塞 `win32` 分支。
 */
export const POSIX_DANGEROUS_PATTERNS: RegExp[] = [
  // 删根 / 删家目录 / 全盘递归删除
  // ⚠️ 2026-10-19 修正：尾部原本是 `\b`，而 `\b` 要求「词字符与非词字符之间」——
  // `~` 与 `/` 都是非词字符，紧跟字符串结尾时**不构成边界** ⇒ `rm -rf ~`、`rm -rf ~/`
  // 这两条最常见的命令**从来没被这条规则拦住过**（`rm -rf /` 是被下面第 3 条兜住的）。
  // 改成显式的「空白/命令分隔符/结尾」前瞻。
  /\brm\s+(-[rfRvfi]{2,}|--recursive|--force)\s+(\/|~\/?|\/\*|~\*|\/\.\*|~\/\.\*)(?=[\s;|&]|$)/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r[a-zA-Z]*|--[a-z-]*recursive[a-z-]*\s+--[a-z-]*force[a-z-]*)\s+(\/|~|\/home|\/Users|\/System|\/Library|\/private\/etc)\b/,
  /\brm\s+-[a-zA-Z]*[rfR][a-zA-Z]*\s+\/\s*$/,
  // 覆写磁盘 / 原始设备
  /\bdd\s+(if=|of=)\/dev\/(sd|hd|nvme|disk|rdisk|mem|kmem|random|urandom)\b/,
  // 格式化 / 擦除磁盘
  /\b(mkfs|newfs|fdisk|diskutil\s+erase|wipefs|blkdiscard|shred)\b/,
  // 关闭系统 / 杀所有进程
  /\b(shutdown|halt|poweroff|reboot|killall\s+(-[a-zA-Z]+\s+)?(init|launchd|systemd|Finder|Dock))\b/,
  // 直接 curl|bash 下载即执行（常见供应链攻击向量）
  /\b(curl|wget)\s+[^;&|`$()]*\|\s*(bash|sh|zsh|sudo|su)\b/,
  /\b(curl|wget)\s+[^;&|`$()]*>\s*\/tmp\/[A-Za-z0-9_.-]+\.(sh|py|rb|js)\s*;\s*(bash|sh|zsh|python|python3|node)\s+\/tmp\//,
  // 注入 sudo 提权（本地无 sudo 密码提示流程，直接失败即可）
  /\bsudo\s+(-S\s+)?(su|rm|chmod|chown|mount|umount|visudo|apt|yum|dnf|brew)\b/,
  // 篡改/删除审计与日志（2026-10-10：审计要能追责，就不该被同一条命令抹掉）
  /\b(rm|mv|truncate|shred)\b[^;&|]*(\/\.logs\b|\.logs\/|audit-\d{4}-\d{2}-\d{2}\.jsonl)/,
  />\s*[^;&|]*\.logs\//,
];

// ==================== Windows 规则 ====================

/**
 * 与目标无关、**出现即危险**的 Windows 命令（不需要看参数）。
 *
 * 全部带 `i` 标志：Windows 命令行大小写不敏感，`FORMAT C:` 与 `format c:` 等价，
 * 漏掉 `i` 就等于给出一个「把大写字母改一下就能绕过」的守卫。
 */
export const WINDOWS_DANGEROUS_PATTERNS: RegExp[] = [
  // 格式化分区 / 磁盘分区工具 / 引导配置（改坏即无法开机）
  /\bformat(?:\.com)?\s+[a-z]:/i,
  /\bdiskpart(?:\.exe)?\b/i,
  /\bbcdedit(?:\.exe)?\b/i,
  // 关机 / 重启 / 注销
  /\bshutdown(?:\.exe)?\s+[^&|;]*\/[sr]\b/i,
  /\b(?:stop-computer|restart-computer)\b/i,
  // 清空事件日志（等价于 mac 侧「删审计日志」）
  /\bwevtutil(?:\.exe)?\s+cl\b/i,
  /\bclear-eventlog\b/i,
  // 下载即执行：管道给 iex / powershell / cmd，或显式 IEX(...)
  /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^|;]*\|\s*(?:iex|invoke-expression|powershell|pwsh|cmd)\b/i,
  /\b(?:iex|invoke-expression)\s*\(/i,
  /\bbitsadmin(?:\.exe)?\b[^&|;]*\/transfer\b/i,
  // 提权 / 建账号 / 改管理员组
  /\brunas(?:\.exe)?\b/i,
  /\bnet\s+user\s+\S+\s+[^&|;]*\/add\b/i,
  /\bnet\s+localgroup\s+administrators\s+\S+\s+\/add\b/i,
  // 注册表 / 服务（HKLM 写入是持久化后门的标准手法）
  /\breg(?:\.exe)?\s+(?:add|delete)\s+(?:HKLM|HKEY_LOCAL_MACHINE)\b/i,
  /\bsc(?:\.exe)?\s+delete\b/i,
  // 杀关键系统进程（explorer 之后桌面会消失；lsass 之后系统直接蓝屏）
  /\btaskkill(?:\.exe)?\b[^&|;]*\/im\s+(?:explorer|lsass|csrss|wininit|winlogon|smss|services|svchost)\.exe\b/i,
  /\btaskkill(?:\.exe)?\b[^&|;]*\/pid\s+(?:0|4)\b/i,
  /\bstop-process\b[^&|;]*-name\s+'?"?(?:lsass|csrss|wininit|winlogon|smss|services|svchost)'?"?/i,
  // 夺权改 ACL：把系统目录的权限改掉后，后续任何清理都会失败
  /\b(?:icacls|takeown)(?:\.exe)?\b[^&|;]*(?:[a-z]:[\\/](?:windows|users|program files)|%systemroot%|%windir%)/i,
  // 抹审计日志（与 mac 侧 `.logs` 判据对应）
  /\b(?:del|erase|remove-item|ri)\b[^&|;]*(?:\\\.logs\\|audit-\d{4}-\d{2}-\d{2}\.jsonl)/i,
];

/** 破坏性动词：出现这些词才继续看「目标是不是灾难级的」 */
const WINDOWS_DESTRUCTIVE_VERB =
  /\b(?:del|erase|rd|rmdir|remove-item|ri|move-item|mi|format|cipher|reg\s+delete|cleanmgr)\b/i;

/** 命令分段（`&&`、`||`、`;`、单管道、换行各自独立判定，避免跨段误杀） */
function splitSegments(cmd: string): string[] {
  return cmd.split(/&&|\|\||[;|\n\r]/);
}

/**
 * 按 shell 规则切参数：**引号内的空格不切**。
 *
 * 为什么必须自己切：`del /s /q "C:\Program Files\BobWork"` 直接 `split(/\s+/)` 会得到
 * `"C:\Program` 与 `Files\BobWork"` 两个残缺 token，目标分类永远识别不出「系统目录」
 * —— 带空格的路径是 Windows 上最常见的形式（Program Files / Users\<名>）。
 */
export function splitCommandArgs(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 把目标 token 归一化成可比较的绝对形式。
 * 处理：引号、正斜杠（git-bash / PowerShell 都吃 `/`）、Windows 环境变量、`~`。
 */
export function normalizeWindowsTarget(token: string, home: string): string {
  let t = token.trim().replace(/^["']+|["']+$/g, '');
  // 环境变量展开（大小写不敏感）
  t = t.replace(/%([^%]+)%/g, (m, name: string) => {
    switch (name.toLowerCase()) {
      case 'systemdrive':
        return home.slice(0, 2) || 'C:';
      case 'systemroot':
      case 'windir':
        return `${home.slice(0, 2) || 'C:'}\\Windows`;
      case 'userprofile':
        return home;
      case 'homedrive':
        return home.slice(0, 2) || 'C:';
      case 'homepath':
        return home.slice(2) || '\\Users\\user';
      default:
        return m;
    }
  });
  t = t.replace(/\$env:([a-z_]+)/gi, (m, name: string) => {
    switch (name.toLowerCase()) {
      case 'systemdrive':
        return home.slice(0, 2) || 'C:';
      case 'systemroot':
      case 'windir':
        return `${home.slice(0, 2) || 'C:'}\\Windows`;
      case 'userprofile':
      case 'home':
        return home;
      default:
        return m;
    }
  });
  t = t.replace(/^~(?=$|[\\/])/, home);
  t = t.replace(/\//g, '\\');
  t = t.replace(/\\+$/, ''); // 去尾部反斜杠
  t = t.replace(/\\\*$/, ''); // 去尾部 \*
  t = t.replace(/\*$/, ''); // 去尾部 *
  return t.toLowerCase();
}

/**
 * 目标是否「灾难级」：盘根 / 系统目录 / 整个用户目录根。
 *
 * ⚠️ 判据必须锚到「目标**就是**根」，不能是「在根下面」——
 * `del /s /q C:\build` 是合法清理，`del /s /q C:\` 才是灾难。
 * 写成 startsWith 会把前者一起拦掉，逼着用户去关守卫（更糟）。
 */
export function classifyWindowsTarget(normalized: string, home: string): string | null {
  const h = home.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const drive = (h.slice(0, 2) || 'c:').toLowerCase();

  // 盘根：`c:` / `c:\` / `c:\*`（已归一化去尾斜杠）
  if (/^[a-z]:$/.test(normalized)) return '盘根';
  // 系统目录（含其下任意深度：删 System32 同样是灾难）
  const systemRoots = [`${drive}\\windows`, `${drive}\\program files`, `${drive}\\program files (x86)`, `${drive}\\programdata`];
  if (systemRoots.some((r) => normalized === r || normalized.startsWith(`${r}\\`))) return '系统目录';
  // 整个用户目录根：`c:\users\<name>` 本身（不含其下的具体文件）
  if (h && (normalized === h || /^[a-z]:\\users\\[^\\]+$/.test(normalized))) return '用户目录根';
  return null;
}

/**
 * Windows 侧「破坏性动词 + 灾难目标」判定。
 * 返回命中原因；无事返回 null。
 */
export function windowsCatastrophic(cmd: string, home: string): string | null {
  for (const seg of splitSegments(cmd)) {
    if (!WINDOWS_DESTRUCTIVE_VERB.test(seg)) continue;
    // 只取看起来像路径的参数（含盘符 / 环境变量 / ~ / 反斜杠）
    for (const raw of splitCommandArgs(seg)) {
      if (!/[\\/~]|%|\$env:|^[a-z]:/i.test(raw)) continue;
      const target = normalizeWindowsTarget(raw, home);
      const kind = classifyWindowsTarget(target, home);
      if (kind) return `${kind}（${raw.trim()}）`;
    }
  }
  return null;
}

// ==================== 统一入口 ====================

/** 按平台拼出完整规则表（POSIX 恒在，Windows 追加） */
export function dangerousPatternsFor(platform: PlatformId = PLATFORM): RegExp[] {
  return platform === 'win32'
    ? [...POSIX_DANGEROUS_PATTERNS, ...WINDOWS_DANGEROUS_PATTERNS]
    : POSIX_DANGEROUS_PATTERNS;
}

/**
 * 对命令字符串做危险检查。
 * @returns null = 放行；字符串 = 拦截原因（会原样展示给用户，故写人话不写正则）
 */
export function checkDangerousCommand(
  cmd: string,
  opts: { platform?: PlatformId; home?: string } = {},
): string | null {
  const platform = opts.platform ?? PLATFORM;
  const home = opts.home ?? homedir();
  for (const re of dangerousPatternsFor(platform)) {
    if (re.test(cmd)) return `匹配危险模式 ${re.toString()}`;
  }
  if (platform === 'win32') {
    const catastrophic = windowsCatastrophic(cmd, home);
    if (catastrophic) return `删除/格式化目标是${catastrophic}`;
  }
  return null;
}

// ==================== 个人目录守卫 ====================

/** POSIX 个人目录首段标记（与历史判据一致，勿删项） */
export const POSIX_PERSONAL_MARKERS = [
  'Downloads',
  'Desktop',
  'Documents',
  'Pictures',
  'Movies',
  'Music',
  'Library',
  '.ssh',
  '.aws',
  '.gnupg',
  'Keychains',
] as const;

/**
 * Windows 个人目录首段标记。
 *
 * 与 POSIX 的差异（刻意）：
 *   - `Library` 换成 `AppData`（Windows 的用户配置根），但 **`AppData\Local\Temp` 放行** ——
 *     Windows 的临时目录就在 AppData 下面，全封会连「写临时文件跑脚本」一起打死；
 *   - 多出用户库目录（Videos/Music/Favorites/Links/Contacts/Searches/Saved Games/3D Objects）
 *     与 OneDrive（大量真实文档在 OneDrive 同步目录里）。
 */
export const WINDOWS_PERSONAL_MARKERS = [
  'Downloads',
  'Desktop',
  'Documents',
  'Pictures',
  'Videos',
  'Music',
  'OneDrive',
  'Favorites',
  'Links',
  'Contacts',
  'Searches',
  'Saved Games',
  '3D Objects',
  'AppData',
  '.ssh',
  '.aws',
  '.gnupg',
] as const;

/** Windows 上「虽在个人目录内但属于临时区」的例外（小写、反斜杠） */
const WINDOWS_PERSONAL_EXCEPTIONS = ['\\appdata\\local\\temp'];

export interface PersonalDirOptions {
  platform?: PlatformId;
  home?: string;
  /** 用户已授权目录（绝对路径）；命中即放行 */
  authorizedRoots?: readonly string[];
}

/** 归一化用于比较（Windows 大小写不敏感 + 反斜杠） */
function cmpKey(p: string, platform: PlatformId): string {
  const s = platform === 'win32' ? p.replace(/\//g, '\\') : p;
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** child 是否等于 parent 或位于其下（分隔符按平台归一） */
function isUnder(child: string, parent: string, platform: PlatformId): boolean {
  const c = cmpKey(child, platform).replace(/\\+$/, '');
  const p = cmpKey(parent, platform).replace(/[\\/]+$/, '');
  if (!p) return false;
  if (c === p) return true;
  return platform === 'win32' ? c.startsWith(`${p}\\`) : c.startsWith(`${p}/`);
}

/**
 * 找出命令里引用的「未授权的个人敏感目录」。
 *
 * 用途：`read_file` 有权限门控，但 `run_command` 走的是 shell —— 不拦就等于
 * 那条门控可以被一句 `cat ~/Downloads/x.pdf` 绕过（mac 上还会触发 TCC 弹窗）。
 *
 * ⚠️ 历史实现（内联在 tools/index.ts）用 `cleaned.split('/')[1]` 取首段，
 * 对 `~/Desktop` 恰好正确，但对**绝对路径** `/Users/bob/Desktop` 取到的是 `Users`
 * ⇒ 绝对路径写法一直没被拦。这里改成从正则捕获组里直接取「家目录前缀之后的第一段」，
 * 两种写法都被覆盖（这是收严，不是放宽）。
 *
 * @returns 命中的绝对路径；未命中返回 null
 */
export function findPersonalDirReference(
  cmd: string,
  opts: PersonalDirOptions = {},
): string | null {
  const platform = opts.platform ?? PLATFORM;
  const home = (opts.home ?? homedir()).replace(/[\\/]+$/, '');
  const authorized = opts.authorizedRoots ?? [];

  // 候选 = <家目录前缀> + <其后的完整路径>。
  // ⚠️ 必须取「完整路径」而不是「前缀 + 首段」：AppData\Local\Temp 的例外判定
  // 需要看到 `Local\Temp` 这两段，只取首段时整条路径被截成 `...\AppData`，
  // 例外条件永远不成立 ⇒ 临时目录被一并封死。
  // POSIX：`~/X…` 或 `/Users/<name>/X…`
  // Windows：`%USERPROFILE%\X…`、`$env:USERPROFILE\X…`、`~\X…`、`C:\Users\<name>\X…`、`/c/Users/<name>/X…`
  const prefixRes =
    platform === 'win32'
      ? [
          /(?:%USERPROFILE%|\$env:USERPROFILE|\$HOME|~|[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+|\/[a-z]\/Users\/[^\/\s"']+)/gi,
        ]
      : [/(?:~|\/Users\/[^\/\s"']+)/g];
  const markers: readonly string[] =
    platform === 'win32' ? WINDOWS_PERSONAL_MARKERS : POSIX_PERSONAL_MARKERS;
  const sepClass = platform === 'win32' ? '[\\\\/]' : '/';
  const restRe = new RegExp(`^${sepClass}([^\\\\/\\s"']+(?:${sepClass}[^\\\\/\\s"']+)*)`);

  for (const pre of prefixRes) {
    pre.lastIndex = 0;
    for (const m of cmd.matchAll(pre)) {
      const prefix = m[0] ?? '';
      const after = cmd.slice((m.index ?? 0) + prefix.length);
      const rest = restRe.exec(after);
      if (!rest) continue;
      const segments = rest[1].split(/[\\/]/);
      const firstSeg = segments[0] ?? '';
      if (!firstSeg) continue;
      const hit = markers.some((mk) =>
        platform === 'win32' ? mk.toLowerCase() === firstSeg.toLowerCase() : mk === firstSeg,
      );
      if (!hit) continue;

      const resolved = resolveToken(`${prefix}/${rest[1]}`, home, platform);
      if (platform === 'win32') {
        const key = cmpKey(resolved, platform);
        // 例外判据要三种形态都覆盖：路径**就是** Temp、Temp 之下、以及以 Temp 结尾
        // （只写 `includes(ex + '\\')` 时，`dir ...\AppData\Local\Temp` 这条最常见的写法会漏放行）
        if (
          WINDOWS_PERSONAL_EXCEPTIONS.some(
            (ex) => key === ex || key.endsWith(ex) || key.includes(`${ex}\\`),
          )
        ) {
          continue;
        }
      }
      if (authorized.some((r) => isUnder(resolved, r, platform))) continue;
      return resolved;
    }
  }
  return null;
}

/** 把候选 token 还原成可比较的绝对路径（不做 fs 调用） */
function resolveToken(token: string, home: string, platform: PlatformId): string {
  let t = token;
  if (platform === 'win32') {
    t = t.replace(/^%USERPROFILE%|^\$env:USERPROFILE|^\$HOME/i, home);
    // 顺序要求：先把 git-bash 的 `/c/Users/x` 换成 `c:\Users\x`，再统一分隔符。
    // 反过来做会把 `/c/` 先变成 `\c\`，盘符规则就再也匹配不上了。
    t = t.replace(/^\/([a-z])\//i, (_m, d: string) => `${d.toUpperCase()}:\\`);
    t = t.replace(/\//g, '\\');
    if (t.startsWith('~')) t = home + t.slice(1);
    return t;
  }
  if (t.startsWith('~')) return home + t.slice(1);
  return t;
}
