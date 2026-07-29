/**
 * BobAgent 根目录解析 —— 开发版与安装版隔离
 *
 * 规则：
 *   1) 若环境变量 `BOBAGENT_HOME` 设置为绝对路径（且非空），使用它
 *   2) 否则使用默认的 `~/BobAgent`
 *
 * 这样开发环境可以：
 *   export BOBAGENT_HOME="$HOME/BobAgent-Dev"
 * 让开发版和发布版完全隔离。
 */
import { homedir } from 'os';
import { join } from 'path';

export function resolveAppRoot(): string {
  const env = (process.env.BOBAGENT_HOME || '').trim();
  if (env && env.startsWith('/')) return env;
  return join(homedir(), 'BobAgent');
}

/** 方便判断是否运行在"隔离的开发模式"下（仅用于 UI corner badge） */
export function isDevIsolation(): boolean {
  const env = (process.env.BOBAGENT_HOME || '').trim();
  return env.length > 0;
}
