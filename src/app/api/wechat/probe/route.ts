/**
 * POST /api/wechat/probe — 微信出站媒体协议探针（B4 门禁，dev 诊断用）
 *
 * 用途：验证 iLink 上行 voice_item / file_item 结构是否成立（sendVoice / sendFile 的
 * 字段是推定的，见 wechat-adapter.ts 注释）。调用后桥会向最近一次微信会话发送
 * 文本标记 → 1 秒语音 → 小文本文件 三条消息；用户在手机微信端核对实际收到什么。
 *
 * 用法前置：
 *   1. BobWork 运行中且微信已扫码绑定；
 *   2. 绑定后在微信里给 bot 发过任意一条消息（lastFrom 就位）；
 *   3. curl -X POST http://localhost:5000/api/wechat/probe
 *
 * 结果解读：
 *   - HTTP 层 results[].sent=false → iLink 直接拒绝该 item 结构（协议不成立）；
 *   - HTTP 层 sent=true 但微信端没收到对应消息 → iLink 接受了请求但静默丢弃（同样视为不成立）。
 */
import { NextResponse } from 'next/server';
import { wechatBridge } from '@/lib/bridge/wechat-bridge';

export async function POST() {
  try {
    // 桥未启动时先拉起（凭证在则恢复轮询）；探针本身不依赖轮询，只依赖 credentials + lastFrom
    await wechatBridge.ensureRunning();
    const result = await wechatBridge.probeOutboundMedia();
    return NextResponse.json({ success: result.ok, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[wechat/probe] 探针失败:', msg);
    return NextResponse.json({ success: false, ok: false, reason: msg, results: [] }, { status: 500 });
  }
}
