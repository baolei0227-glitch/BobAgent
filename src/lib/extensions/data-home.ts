/**
 * lib/extensions/data-home.ts — 插件统一数据根（server-only，零额外依赖）
 *
 * BobWork 托管的独立插件（随包 spawn / launchd daemon）数据统一收进
 * <APP_ROOT>/extensions/<plugin-id>/（notes/ocr 已实际迁移）。
 * 宿主代码需要读取插件数据（如 OCR config.json 探测生效配置）时统一经此解析，
 * 禁止硬编码 ~/.bob-notes-mcp 等旧自治路径。
 */

import * as path from 'path';
import { resolveAppRoot } from '@/lib/app-root';

/** 扩展仓库根：<APP_ROOT>/extensions */
export function extensionsDataRoot(): string {
  return path.join(resolveAppRoot(), 'extensions');
}

/** 插件数据根：<APP_ROOT>/extensions/<plugin-id> */
export function pluginDataHome(pluginId: string): string {
  return path.join(extensionsDataRoot(), pluginId);
}
