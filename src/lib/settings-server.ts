/**
 * 设置文件 I/O — 仅服务端/Electron 主进程使用
 *
 * 从 settings.ts 分离，避免浏览器打包时解析 fs/os/path 模块。
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { defaultSettings, type AppSettings } from './settings';
import { resolveAppRoot } from './app-root';

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
    return { ...defaultSettings(), ...parsed, version: parsed.version ?? 1 };
  } catch {
    return defaultSettings();
  }
}

export async function writeSettingsToFile(settings: AppSettings): Promise<void> {
  const APP_ROOT = resolveAppRoot();
  await fs.mkdir(APP_ROOT, { recursive: true });
  await fs.writeFile(
    getSettingsFilePath(),
    JSON.stringify(settings, null, 2),
    'utf-8',
  );
}
