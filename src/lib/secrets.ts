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
import { execSync } from 'child_process';

const PREFIX = 'enc::v1::';
const KEYLEN = 32; // AES-256
const IVLEN = 12; // GCM 推荐
const TAGLEN = 16;

/** 内置 pepper（仅用于提升暴力破解成本，不是安全边界） */
const PEPPER = 'BobAgent.Secrets.Pepper::v1::2026-07';

/** 机器唯一特征，尽量稳定（用户改 hostname 不影响 hw.uuid） */
function getMachineFingerprint(): string {
  try {
    // macOS: 硬件 UUID，跨重启稳定
    if (process.platform === 'darwin') {
      const uuid = execSync('sysctl -n hw.uuid', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (uuid) return `hw.uuid:${uuid}`;
    }
    // Linux: machine-id
    if (process.platform === 'linux') {
      const id = require('fs').readFileSync('/etc/machine-id', 'utf-8').trim();
      if (id) return `machine-id:${id}`;
    }
  } catch {}
  // Fallback：hostname + username，至少能保证跨机器不同
  return `host:${hostname()}:user:${userInfo().username}`;
}

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const material = `${PEPPER}::${getMachineFingerprint()}`;
  cachedKey = scryptSync(material, 'BobAgent.Secrets.Salt', KEYLEN, { N: 16384, r: 8, p: 1 });
  return cachedKey;
}

export function encryptSecret(plain: string | undefined | null): string | undefined {
  if (plain === undefined || plain === null || plain === '') return plain === '' ? '' : undefined;
  if (plain.startsWith(PREFIX)) return plain; // 已加密
  const key = getKey();
  const iv = randomBytes(IVLEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined =
    iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
  return PREFIX + combined;
}

export function decryptSecret(blob: string | undefined | null): string | undefined {
  if (blob === undefined || blob === null || blob === '') return blob === '' ? '' : undefined;
  if (!blob.startsWith(PREFIX)) return blob; // 明文，直接返回（兼容老数据）
  const parts = blob.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return undefined;
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ct = Buffer.from(parts[2], 'base64');
    if (iv.length !== IVLEN || tag.length !== TAGLEN) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf-8');
  } catch {
    // 解密失败（换机器、文件损坏）→ 返回 undefined，由上层决定是否提示
    return undefined;
  }
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
  ['textEditModel', 'apiKey'],
  // customTools.headers 是 Record<string,string>，也含 Token
  ['customTools', '*', 'headers'],
  // MCP env 是 Record<string,string>，含 BRAVE_API_KEY / GITHUB_TOKEN / NOTION_KEY 等
  ['mcpServers', '*', 'env'],
];

function walk(
  obj: any,
  path: Array<string | '*'>,
  depth: number,
  fn: (leaf: any) => any,
): any {
  if (depth === path.length) return fn(obj);
  const key = path[depth];
  if (key === '*') {
    if (!Array.isArray(obj)) return obj;
    return obj.map((item) => walk(item, path, depth + 1, fn));
  }
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (!(key in obj)) return obj;
  return {
    ...obj,
    [key]: walk(obj[key], path, depth + 1, fn),
  };
}

function applyToSensitive<T>(obj: T, fn: (leaf: any) => any): T {
  let out: any = obj;
  for (const path of SENSITIVE_PATHS) {
    out = walk(out, path, 0, fn);
  }
  return out as T;
}

export function encryptSettings<T>(settings: T): T {
  return applyToSensitive(settings, (leaf) => {
    if (leaf === undefined || leaf === null) return leaf;
    if (typeof leaf === 'string') return encryptSecret(leaf) ?? leaf;
    if (typeof leaf === 'object' && leaf !== null) {
      // Record<string, string>（headers / env）→ 逐值加密
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(leaf)) {
        out[k] = typeof v === 'string' ? encryptSecret(v) ?? v : v;
      }
      return out;
    }
    return leaf;
  });
}

export function decryptSettings<T>(settings: T): T {
  return applyToSensitive(settings, (leaf) => {
    if (leaf === undefined || leaf === null) return leaf;
    if (typeof leaf === 'string') return decryptSecret(leaf) ?? leaf;
    if (typeof leaf === 'object' && leaf !== null) {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(leaf)) {
        out[k] = typeof v === 'string' ? decryptSecret(v) ?? v : v;
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
