/**
 * 敏感字段加密工具（AES-256-GCM）
 *
 * 设计原则：
 *   - 密钥派生：基于机器硬件特征（macOS hw.uuid / hostname + username）+ 内置 pepper，
 *     同一份 settings.json 拷到另一台机器无法解密。
 *   - 密文格式：`enc::v1::<base64(iv):base64(tag):base64(ciphertext)>`
 *   - 透明迁移：读取时遇到明文自动回写加密（兼容老版本 settings.json）
 *   - 仅在 Node.js 环境可用（使用 crypto / sysctl），浏览器端永不加载。
 */

import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'crypto';
import { hostname, userInfo } from 'os';
import { machineIds, localHostName } from './platform';

const PREFIX = 'enc::v1::';
const KEYLEN = 32; // AES-256
const IVLEN = 12; // GCM 推荐
const TAGLEN = 16;

/** 内置 pepper（仅用于提升暴力破解成本，不是安全边界） */
const PEPPER = 'BobWork.Secrets.Pepper::v1::2026-07';

/**
 * 硬件指纹候选（首选，跨重启/跨网络稳定）。
 *
 * 取值来源已收进 `lib/platform/identity`（逐平台不同：macOS IOPlatformUUID、
 * Windows 注册表 MachineGuid、Linux /etc/machine-id）—— 这里只负责把取到的值
 * 拼成指纹串。**刻意分家**：那个串是数据契约（已落盘的密文全绑在它上，标签格式
 * 或候选顺序一变老密文就解不开），而「怎么取」是纯粹的平台差异。
 *
 * 主候选（首个）用于加密，其余仅用于解密回退。
 */
function hardwareFingerprints(): string[] {
  return machineIds().map((m) => `${m.kind}:${m.value}`);
}

/**
 * 历史指纹候选（只用于解密回退，不用于加密）：
 * 旧版本一律用主机名派生，主机名一变旧密文即解不开。保留这些候选，
 * 老密文仍能被解开并按主指纹透明迁移（见 settings-server 的迁移分支）。
 */
function legacyFingerprints(): string[] {
  const user = userInfo().username;
  const out: string[] = [];
  const host = hostname().trim();
  if (host) out.push(`host:${host}:user:${user}`);
  // macOS 未设 HostName 时 gethostname() 返回 "<LocalHostName>.local"；非 macOS 返回空串
  const local = localHostName();
  if (local) {
    out.push(`host:${local}.local:user:${user}`);
    out.push(`host:${local}:user:${user}`);
  }
  return out;
}

let cachedKeys: Buffer[] | null = null;

/** 全部候选派生密钥：首个为主密钥（用于加密），其余仅用于解密回退 */
function getKeys(): Buffer[] {
  if (cachedKeys) return cachedKeys;
  const unique = Array.from(new Set([...hardwareFingerprints(), ...legacyFingerprints()]));
  // 兜底：任何特征都取不到时仍要有一条确定性候选，避免无密钥可用
  if (unique.length === 0) unique.push(`host:${hostname()}:user:${userInfo().username}`);
  cachedKeys = unique.map((fp) =>
    scryptSync(`${PEPPER}::${fp}`, 'BobWork.Secrets.Salt', KEYLEN, { N: 16384, r: 8, p: 1 }),
  );
  return cachedKeys;
}

export function encryptSecret(plain: string | undefined | null): string | undefined {
  if (plain === undefined || plain === null || plain === '') return plain === '' ? '' : undefined;
  if (plain.startsWith(PREFIX)) return plain; // 已加密
  const key = getKeys()[0];
  const iv = randomBytes(IVLEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined =
    iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
  return PREFIX + combined;
}

/** 用指定密钥解一条密文；格式非法或密钥不匹配时返回 undefined（不抛异常） */
function decryptWithKey(blob: string, key: Buffer): string | undefined {
  const parts = blob.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return undefined;
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ct = Buffer.from(parts[2], 'base64');
  if (iv.length !== IVLEN || tag.length !== TAGLEN) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf-8');
  } catch {
    return undefined;
  }
}

/**
 * 解密一条密文：依次尝试主指纹与历史指纹。
 *
 * 全部失败返回 undefined —— 调用方必须按「凭据不可用」处理，
 * 绝不能把 `enc::v1::…` 密文本体当 Key 发出去（服务端会回
 * "Your api key: ****Vcg= is invalid"，即密文尾部被当成密钥回显）。
 */
export function decryptSecret(blob: string | undefined | null): string | undefined {
  if (blob === undefined || blob === null || blob === '') return blob === '' ? '' : undefined;
  if (!blob.startsWith(PREFIX)) return blob; // 明文，直接返回（兼容老数据）
  for (const key of getKeys()) {
    const plain = decryptWithKey(blob, key);
    if (plain !== undefined) return plain;
  }
  return undefined;
}

/** 是否为「主指纹解不开、历史指纹能解开」的密文 → 需要用主指纹重新加密迁移一次 */
export function isLegacyCiphertext(blob: string): boolean {
  if (!blob.startsWith(PREFIX)) return false;
  const keys = getKeys();
  if (decryptWithKey(blob, keys[0]) !== undefined) return false;
  return keys.slice(1).some((key) => decryptWithKey(blob, key) !== undefined);
}

export function isEncrypted(blob: unknown): boolean {
  return typeof blob === 'string' && blob.startsWith(PREFIX);
}

// ============================================================
// settings 整棵树的加密/解密（按字段路径）
// ============================================================

/** 需要加密的字段路径（通配 * 表示数组元素） */
const SENSITIVE_PATHS: Array<Array<string | '*'>> = [
  ['providers', '*', 'apiKey'],
  ['search', 'apiKey'],
  ['vision', 'apiKey'],
  ['vision', 'auxiliaryApiKey'],
  ['taskModel', 'apiKey'],
  // 邮箱感知（IMAP）密码 / 应用专用密码（2026-10-10 感知面 ①）
  ['mail', 'password'],
  // customTools.headers 是 Record<string,string>，也含 Token
  ['customTools', '*', 'headers'],
  // MCP env 是 Record<string,string>，含 BRAVE_API_KEY / GITHUB_TOKEN / NOTION_KEY 等
  ['mcpServers', '*', 'env'],
];

/** 叶子变换：输入输出均为 unknown，由调用方在叶子处按实际类型收窄 */
type LeafFn = (leaf: unknown) => unknown;

/** 按路径遍历（'*' 通配数组元素）：命中路径末尾时对叶子执行 fn，其余结构原样深拷贝保留 */
function walk(
  obj: unknown,
  path: Array<string | '*'>,
  depth: number,
  fn: LeafFn,
): unknown {
  if (depth === path.length) return fn(obj);
  const key = path[depth];
  if (key === '*') {
    if (!Array.isArray(obj)) return obj;
    return obj.map((item) => walk(item, path, depth + 1, fn));
  }
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  const record = obj as Record<string, unknown>;
  if (!(key in record)) return obj;
  return {
    ...record,
    [key]: walk(record[key], path, depth + 1, fn),
  };
}

function applyToSensitive<T>(obj: T, fn: LeafFn): T {
  let out: unknown = obj;
  for (const path of SENSITIVE_PATHS) {
    out = walk(out, path, 0, fn);
  }
  // 遍历按路径原位替换叶子、保持整体结构形状，故可安全还原为输入类型 T
  return out as T;
}

export function encryptSettings<T>(settings: T): T {
  return applyToSensitive(settings, (leaf) => {
    if (leaf === undefined || leaf === null) return leaf;
    if (typeof leaf === 'string') return encryptSecret(leaf) ?? leaf;
    if (typeof leaf === 'object' && leaf !== null) {
      // Record<string, string>（headers / env）→ 逐值加密
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(leaf)) {
        out[k] = typeof v === 'string' ? encryptSecret(v) ?? v : v;
      }
      return out;
    }
    return leaf;
  });
}

/** 解密失败只提示一次，避免每次读设置都刷屏 */
let warnedDecryptFailure = false;

/** 解密叶子：密文解不开时返回空串（视作「未配置」并留痕），
 *  绝不把密文本体当凭据向上传递 */
function decryptLeaf(leaf: string): string {
  const plain = decryptSecret(leaf);
  if (plain === undefined) {
    if (!warnedDecryptFailure) {
      warnedDecryptFailure = true;
      console.warn(
        '[secrets] 密文解密失败：与当前机器指纹不匹配（换机器或文件损坏），相关凭据视为未配置，需重新录入',
      );
    }
    return '';
  }
  return plain;
}

export function decryptSettings<T>(settings: T): T {
  return applyToSensitive(settings, (leaf) => {
    if (leaf === undefined || leaf === null) return leaf;
    if (typeof leaf === 'string') return decryptLeaf(leaf);
    if (typeof leaf === 'object' && leaf !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(leaf)) {
        out[k] = typeof v === 'string' ? decryptLeaf(v) : v;
      }
      return out;
    }
    return leaf;
  });
}

/** 是否存在未加密的明文敏感字段（用于决定是否需要回写加密） */
export function hasPlainSecrets<T>(settings: T): boolean {
  let found = false;
  applyToSensitive(settings, (leaf) => {
    if (typeof leaf === 'string' && leaf !== '' && !isEncrypted(leaf)) {
      found = true;
    }
    if (leaf !== null && typeof leaf === 'object') {
      for (const v of Object.values(leaf)) {
        if (typeof v === 'string' && v !== '' && !isEncrypted(v)) found = true;
      }
    }
    return leaf;
  });
  return found;
}

/** 是否存在「历史指纹加密」的敏感字段（能解开但需按主指纹重写迁移） */
export function hasLegacySecrets<T>(settings: T): boolean {
  let found = false;
  applyToSensitive(settings, (leaf) => {
    if (typeof leaf === 'string' && isLegacyCiphertext(leaf)) {
      found = true;
    }
    if (leaf !== null && typeof leaf === 'object') {
      for (const v of Object.values(leaf)) {
        if (typeof v === 'string' && isLegacyCiphertext(v)) found = true;
      }
    }
    return leaf;
  });
  return found;
}
