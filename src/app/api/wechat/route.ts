import { NextRequest, NextResponse } from 'next/server';
import { wechatBridge } from '@/lib/bridge/wechat-bridge';

/**
 * /api/wechat — 微信 iLink 绑定管理
 *
 * GET  /api/wechat?action=status    查询绑定/运行状态
 * POST /api/wechat?action=bind      发起扫码绑定（返回二维码 dataURL）
 * POST /api/wechat?action=unbind    解绑（清凭证 + 停止轮询）
 */
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') || 'status';
  try {
    if (action === 'status') {
      // 冷恢复：有凭证但轮询未跑（如重启后 / Next.js lazy init 后）→ 自动拉起，
      // 保证前端查询到的 running=true 对应真实可收消息的连接，而非僵尸绑定状态
      await wechatBridge.ensureRunning();
      return NextResponse.json({ success: true, ...wechatBridge.getStatus() });
    }
    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : '查询失败' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') || 'bind';
  try {
    if (action === 'bind') {
      const state = await wechatBridge.startBinding();
      if (state.phase === 'error') {
        return NextResponse.json({ success: false, error: state.error || '获取二维码失败' }, { status: 500 });
      }
      return NextResponse.json({ success: true, state });
    }
    if (action === 'unbind') {
      await wechatBridge.unbind();
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : '操作失败' }, { status: 500 });
  }
}
