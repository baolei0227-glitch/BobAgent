/**
 * 设置文件 I/O — 仅服务端/Electron 主进程使用
 *
 * 从 settings.ts 分离，避免浏览器打包时解析 fs/os/path 模块。
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { defaultSettings, type AppSettings } from './settings';
import { resolveAppRoot } from './app-root';
import { encryptSettings, decryptSettings, hasPlainSecrets } from './secrets';

function getSettingsFilePath(): string {
  return join(resolveAppRoot(), '.settings.json');
}

export async function readSettingsFromFile(): Promise<AppSettings> {
  try {
    const APP_ROOT = resolveAppRoot();
    const filePath = getSettingsFilePath();
    // 迁移旧文件名 → 新隐藏文件名（默认根目录下，非默认根目录下不再迁移）
    const legacyDefault = join(require('os').homedir(), 'BobAgent');
    if (APP_ROOT === legacyDefault) {
      const oldPath = join(APP_ROOT, 'settings.json');
      try {
        await fs.access(oldPath);
        try { await fs.access(filePath); } catch {
          await fs.rename(oldPath, filePath);
        }
      } catch { /* 旧文件不存在 */ }
    }
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged: AppSettings = { ...defaultSettings(), ...parsed, version: parsed.version ?? 1 };

    // 解密敏感字段；如果有明文，顺便回写成加密版（透明迁移）
    const decrypted = decryptSettings(merged);
    if (hasPlainSecrets(parsed)) {
      try {
        await writeSettingsToFile(decrypted);
      } catch { /* 回写失败不影响读取 */ }    }
    return decrypted;
  } catch {
    return defaultSettings();
  }
}

export async function writeSettingsToFile(settings: AppSettings): Promise<void> {
  const APP_ROOT = resolveAppRoot();
  await fs.mkdir(APP_ROOT, { recursive: true });
  const encrypted = encryptSettings(settings);
  await fs.writeFile(
    getSettingsFilePath(),
    JSON.stringify(encrypted, null, 2),
    'utf-8',
  );
}
