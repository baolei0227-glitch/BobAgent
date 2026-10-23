/**
 * lib/update/artifact.ts —— 更新包文件名语义（跨平台，纯函数）
 *
 * 为什么单独成模块：
 *   更新下载/安装链路原先把 macOS 的产物名写死在 6 处
 *   （`BobWork-<version>-macos-arm64.zip`），Windows 接入后这些位置全都不会报错，
 *   只会表现为「下载到一半找不到文件」「.partial 永远清不掉」「装完还是旧版」——
 *   属于最难从日志里看出来的那类故障。命名规则收敛到这里后，
 *   判据可以被单测穷举，主进程只负责 IO。
 *
 * 硬约束：
 *   1. 只做字符串解析，不碰文件系统、不读 app 状态（可被 vitest 直接覆盖）；
 *   2. 只使用相对导入（本文件会被 tsup 打进 electron/main.js 的 CJS 产物）。
 */
import { PLATFORM, type PlatformId } from '../platform';

/** 更新包扩展名：macOS 是 zip（ditto 解包），Windows 是 NSIS exe */
export type UpdatePackageExt = 'zip' | 'exe';

/** 可识别的产物名：BobWork-<version>-<platform>-<arch>.<ext> */
const ARTIFACT_NAME_RE =
  /^BobWork-(\d+(?:\.\d+)*)-(macos-(?:arm64|x64)|win-(?:x64|arm64))\.(zip|exe)$/;

/** 当前平台的安装包文件名（用于没有 files[0].url 时的兜底） */
export function updateArtifactName(version: string, platform: PlatformId = PLATFORM): string {
  const v = String(version ?? '').trim();
  if (!/^\d+(?:\.\d+)*$/.test(v)) {
    throw new Error(`invalid update version: ${JSON.stringify(version)}`);
  }
  return platform === 'win32' ? `BobWork-${v}-win-x64.exe` : `BobWork-${v}-macos-arm64.zip`;
}

/**
 * 从 latest.yml / latest-mac.yml 的 `files[0].url` 里取文件名。
 *
 * 三种现实输入：
 *   - `BobWork-0.7.746-win-x64.exe`（相对名）
 *   - `https://gitcode.com/.../download/latest/BobWork-...exe?noCache=1`（GitCode 会带 query）
 *   - CDN 绝对地址（302 之后）
 *
 * 安全性：只接受单段文件名。`../`、带分隔符或空的输入一律返回 ''，
 * 避免清单被篡改时把下载目标写到缓存目录之外。
 */
export function fileNameFromUpdateUrl(raw: string | undefined | null): string {
  if (!raw) return '';
  let pathname = String(raw).trim();
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    // 不是绝对 URL：按相对文件名处理
  }
  const base = pathname.split(/[?#]/)[0].split('/').pop() ?? '';
  let decoded = base;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    // 非法百分号编码：保留原样，交给下面的白名单判定
  }
  if (!decoded || decoded === '.' || decoded === '..') return '';
  // 反斜杠同样视为路径分隔符（Windows 上 `..\` 也能越界）
  if (/[\\/]/.test(decoded)) return '';
  return decoded;
}

/** 解析产物名；不是本应用的更新包则返回 null（清理逻辑据此不误删用户文件） */
export function parseUpdateArtifact(
  fileName: string | undefined | null,
): { version: string; platform: string; ext: UpdatePackageExt } | null {
  if (!fileName) return null;
  const m = ARTIFACT_NAME_RE.exec(String(fileName).trim());
  if (!m) return null;
  return { version: m[1], platform: m[2], ext: m[3] as UpdatePackageExt };
}

/** 是否为可安装的更新包（zip/exe 且命名合规） */
export function isUpdatePackageFile(fileName: string | undefined | null): boolean {
  return parseUpdateArtifact(fileName) !== null;
}

/** `.partial` 后缀是否为断点续传残留（只认 `<package>.partial`） */
export function isPartialUpdateFile(fileName: string | undefined | null): boolean {
  if (!fileName || !String(fileName).endsWith('.partial')) return false;
  return isUpdatePackageFile(String(fileName).slice(0, -'.partial'.length));
}

/** 逐段比较版本号（返回 >0 表示 a 更新）。只支持纯数字段，与项目现有版本线一致。 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 从目录列表里挑出指定扩展名、版本号最高的更新包文件名。
 *
 * 不能按文件名字母序取第一个：`0.7.9` 排在 `0.7.10` 后面，
 * 那会把用户「升级」回旧版本（macOS 安装分支踩过同一个坑）。
 */
export function pickLatestArtifact(names: Iterable<string>, ext: UpdatePackageExt): string {
  let best = '';
  let bestVersion = '';
  for (const name of names) {
    const artifact = parseUpdateArtifact(name);
    if (!artifact || artifact.ext !== ext) continue;
    if (!best || compareVersions(artifact.version, bestVersion) > 0) {
      best = name;
      bestVersion = artifact.version;
    }
  }
  return best;
}
