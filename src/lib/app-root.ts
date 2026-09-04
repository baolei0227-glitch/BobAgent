/**
 * BobWork 根目录解析
 *
 * 规则：
 *   1) 若环境变量 `BOBWORK_HOME` 设置为绝对路径（且非空），使用它
 *   2) 否则使用默认的 `~/BobWork`
 */
import { homedir } from 'os';
import { join, sep, resolve } from 'path';
import { lstatSync } from 'fs';

export function resolveAppRoot(): string {
  const env = (process.env.BOBWORK_HOME || '').trim();
  if (env && env.startsWith('/')) return env;
  return join(homedir(), 'BobWork');
}

/** 判断是否通过 BOBWORK_HOME 覆盖了数据目录（仅用于 UI corner badge） */
export function isDevIsolation(): boolean {
  const env = (process.env.BOBWORK_HOME || '').trim();
  return env.length > 0;
}

// ==================== 目录/文件名常量（统一管理，隐藏为 . 前缀） ====================

/** 每个项目的数据库文件名（隐藏，避免用户误操作） */
export const PROJECT_DB_FILENAME = '.project.db';

/** 全局工作流模板数据库文件名（隐藏） */
export const TEMPLATES_DB_FILENAME = '.templates.db';

/** 全局 WANTED 收件箱数据库文件名（隐藏，跨项目统一收件箱） */
export const INBOX_DB_FILENAME = '.inbox.db';

/** 全局日历数据库文件名（隐藏）——日历与项目完全独立，事件/账户存于 app root 级全局库，
 *  不随项目删除、切换、重建而丢失（2026-08-18 起从各项目 .project.db 迁移而来） */
export const CALENDAR_DB_FILENAME = '.calendar.db';

/** 全局模型用量数据库文件名（隐藏）——用量账本与项目解耦（跨项目聚合 + OCR/notes 等扩展来源），
 *  2026-09-04 起从各项目 .project.db 的 usage_log 迁移而来 */
export const USAGE_DB_FILENAME = '.usage.db';

/** 无激活项目时的临时工作区目录名（隐藏，仅用于 captures/ 和临时脚本产物） */
export const SANDBOX_DIRNAME = '.sandbox';

/** Bob Sandbox 小程序专用目录名（小程序作为 BobWork 原生功能组件，独立目录，与临时沙盒产物隔离） */
export const BOB_SANDBOX_DIRNAME = 'bob-sandbox';

/** 全局工具审计日志目录名（隐藏） */
export const LOGS_DIRNAME = '.logs';

// ==================== iCloud 隔离（.nosync） ====================

/** iCloud 项目 db 的 .nosync 子目录名（.nosync 后缀让 iCloud Drive 跳过同步，避免 SQLite 多端写坏） */
export const PROJECT_DB_NOSYNC_DIRNAME = '.project.db.nosync';

/** 判断路径是否位于 iCloud Drive（macOS）内。
 *  覆盖两类情况：
 *   1) 路径直接位于 ~/Library/Mobile Documents/com~apple~CloudDocs/ 内；
 *   2) 路径位于 ~/Desktop 或 ~/Documents（当 iCloud“桌面与文稿”同步启用时，
 *      CloudDocs 下会出现指向这两个本地目录的符号链接，位于其下的文件同样会被 iCloud 同步）。
 */
export function isICloudPath(p: string): boolean {
  const docsRoot = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const normalized = resolve(p);
  if (normalized === docsRoot || normalized.startsWith(docsRoot + sep)) {
    return true;
  }

  // iCloud“桌面与文稿”：CloudDocs 下的 Desktop / Documents 是指向本地目录的符号链接。
  // 符号链接存在即代表桌面/文稿正被 iCloud 同步，其下文件也应纳入 .nosync 隔离。
  try {
    const syncPoints: Array<{ link: string; target: string }> = [
      { link: join(docsRoot, 'Desktop'), target: join(homedir(), 'Desktop') },
      { link: join(docsRoot, 'Documents'), target: join(homedir(), 'Documents') },
    ];
    for (const { link, target } of syncPoints) {
      const st = lstatSync(link, { throwIfNoEntry: false });
      if (!st || !st.isSymbolicLink()) continue;
      if (normalized === target || normalized.startsWith(target + sep)) {
        return true;
      }
    }
  } catch { /* 检测失败按非 iCloud 处理，不阻断调用 */ }

  return false;
}

/** 项目 db 完整路径：iCloud 项目放 .nosync 子目录，普通项目放项目根目录 */
export function resolveProjectDbPath(projectPath: string): string {
  return isICloudPath(projectPath)
    ? join(projectPath, PROJECT_DB_NOSYNC_DIRNAME, PROJECT_DB_FILENAME)
    : join(projectPath, PROJECT_DB_FILENAME);
}
