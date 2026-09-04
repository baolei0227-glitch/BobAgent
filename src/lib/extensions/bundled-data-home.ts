/**
 * lib/extensions/bundled-data-home.ts — 随包插件数据根统一（server-only）
 *
 * BobWork 启动随包分发（{BUNDLED}）的独立 MCP 插件时，向子进程注入环境变量
 * 覆盖其数据目录到 ~/BobWork/extensions/<plugin>/，实现"所有插件数据统一收进
 * BobWork 文件夹"。未登记或非 BobWork 托管的运行（独立 npx/daemon）不注入，
 * 由各插件自己的默认数据根决定，保持对外兼容。
 *
 * 注入点在 mcpManager 建立 stdio 连接时合并进 env（不落盘 .settings.json，
 * 避免把动态绝对路径污染进持久化配置）。
 */

import * as path from 'path';
import { resolveAppRoot } from '@/lib/app-root';

export interface BundledDataHome {
  /** 注入的环境变量名（子进程 config 读取） */
  envKey: string;
  /** 统一数据根目录：<APP_ROOT>/extensions/<plugin-id> */
  dir: string;
}

/** 登记表：plugin id → { 注入 env 键, extensions 下子目录 } */
const PLUGIN_DATA_ENV: Record<string, { envKey: string; sub: string }> = {
  'bob-notes-mcp': { envKey: 'BOB_NOTES_MCP_HOME', sub: 'bob-notes-mcp' },
};

/** 返回插件应注入的数据根（仅登记过的随包插件返回；其余 undefined 不注入） */
export function bundledDataHome(pluginId: string): BundledDataHome | undefined {
  const spec = PLUGIN_DATA_ENV[pluginId];
  if (!spec) return undefined;
  return { envKey: spec.envKey, dir: path.join(resolveAppRoot(), 'extensions', spec.sub) };
}
