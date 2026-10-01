import { NextRequest, NextResponse } from 'next/server';
import { feishuBridge } from '@/lib/bridge/feishu-bridge';

/**
 * /api/feishu — 飞书机器人（长连接）绑定管理
 *
 * GET  /api/feishu?action=status            查询连接/运行状态
 * POST /api/feishu?action=connect           连接（body: {appId, appSecret}）
 * POST /api/feishu?action=unbind            解绑（关长连接 + 清凭证）
 */
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') || 'status';
  try {
    if (action === 'status') {
      // 冷恢复：有凭证但连接未跑（如重启后 / Next.js lazy init 后）→ 自动拉起，
      // 保证前端查询到的 running=true 对应真实可收消息的连接，而非僵尸绑定状态
      await feishuBridge.ensureRunning();
      return NextResponse.json({ success: true, ...feishuBridge.getStatus() });
    }
    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : '查询失败' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') || 'connect';
  try {
    if (action === 'connect') {
      const body = (await req.json().catch(() => ({}))) as { appId?: string; appSecret?: string };
      const appId = (body.appId ?? '').trim();
      const appSecret = (body.appSecret ?? '').trim();
      if (!appId || !appSecret) {
        return NextResponse.json({ success: false, error: 'App ID 与 App Secret 均为必填' }, { status: 400 });
      }
      try {
        await feishuBridge.connect(appId, appSecret);
      } catch (e) {
        // 凭证校验失败（App ID 格式 / 密钥错误）在此抛出，原文已是飞书返回的 code/msg
        return NextResponse.json({ success: false, error: e instanceof Error ? e.message : '凭证校验失败' }, { status: 400 });
      }
      return NextResponse.json({ success: true, ...feishuBridge.getStatus() });
    }
    if (action === 'unbind') {
      await feishuBridge.unbind();
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: '未知 action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : '操作失败' }, { status: 500 });
  }
}