import { NextRequest, NextResponse } from 'next/server';
import { readSettingsFromFile, writeSettingsToFile, settingsFileExists } from '@/lib/settings-server';
import { getDefaultProjectDir } from '@/lib/project/project-manager';

/**
 * 首次运行向导（First Run Setup）
 *
 * GET  /api/setup            → 判断是否首次运行，返回默认保存地址
 * POST /api/setup complete   → 标记向导完成（写 setupCompleted 到 .settings.json）
 *
 * 首次运行判定：.settings.json 不存在（含 setupCompleted 标记）。
 * 注意不能以 .projects.json 为判据——页面加载时 /api/projects 的
 * ensureAppRoot 会自动创建它，会把"全新安装"误判为"已配置"。
 * 老用户升级（已有 .settings.json）→ 不再弹向导，静默跳过。
 */
export async function GET() {
  try {
    const hasSettings = await settingsFileExists();
    const firstRun = !hasSettings;
    const defaultDir = await getDefaultProjectDir();
    return NextResponse.json({ success: true, firstRun, defaultDir });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** POST /api/setup { action: 'complete' } → 标记首次向导完成 */
export async function POST(req: NextRequest) {
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'invalid JSON body' }, { status: 400 });
  }
  if (body.action !== 'complete') {
    return NextResponse.json({ success: false, error: 'action must be "complete"' }, { status: 400 });
  }
  try {
    const settings = await readSettingsFromFile();
    // 首次运行（无文件）时返回 defaultSettings，version=1，可直接写回；
    // 读取异常（version=0）时写入会被 settings-server 拒绝，这里显式兜底
    if (typeof settings.version !== 'number' || settings.version === 0) {
      return NextResponse.json(
        { success: false, error: 'settings file is corrupted; please delete it and retry' },
        { status: 500 },
      );
    }
    settings.setupCompleted = true;
    await writeSettingsToFile(settings);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
