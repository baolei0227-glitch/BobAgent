/**
 * /api/extensions/index — 扩展仓库总览
 *
 * GET — 迁移旧审计目录 → 生成并落盘 <APP_ROOT>/extensions/index.json → 返回总览。
 * 统一查看宿主侧扩展态：用户技能 / 已接入 MCP / 随包插件 / 独立插件登记。
 */

import { NextResponse } from 'next/server';
import * as fs from 'fs';
import {
  migrateLegacyAudit,
  cleanupLegacyPluginDirs,
  writeExtensionsIndex,
  extensionsIndexFile,
} from '@/lib/extensions/index-server';

export async function GET() {
  try {
    await migrateLegacyAudit();
    await cleanupLegacyPluginDirs();
    await writeExtensionsIndex();
    const raw = fs.readFileSync(extensionsIndexFile(), 'utf-8');
    return NextResponse.json(JSON.parse(raw));
  } catch (e: any) {
    console.error('GET /api/extensions/index error:', e);
    return NextResponse.json(
      { error: e?.message || 'Failed to build extensions index' },
      { status: 500 },
    );
  }
}
