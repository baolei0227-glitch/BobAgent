import { NextResponse } from 'next/server';
import { getMailStatus, pollMailOnce } from '@/lib/bridge/mail-poll';

/**
 * /api/mail —— 邮箱感知（IMAP 只读）的状态查询与手动触发。
 *
 * 与 /api/feishu 同层：绑定 / 解绑不在这里（凭证走 AppSettings.mail，由设置面板直接读写配置），
 * 本路由只暴露两件**运行时**的事：
 *   - GET  → 调度器状态（是否已配置 / 运行中 / 最近一轮未读数 / 最近错误）；
 *   - POST → 立刻跑一轮（设置面板「保存并测试」用：能当场暴露主机名/密码填错，不必等 2 分钟）。
 *
 * POST 在**尚未建立水位线**时只会做基线、不播报（见 mail-poll 首轮逻辑），故手动测试不会
 * 把存量未读一次性推给用户。
 */
export async function GET() {
  return NextResponse.json({ success: true, ...getMailStatus() });
}

export async function POST() {
  try {
    const count = await pollMailOnce();
    return NextResponse.json({ success: true, count, ...getMailStatus() });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
