import { NextRequest, NextResponse } from 'next/server';
import {
  getLocalSttStatus,
  removeLocalSttModel,
  startLocalSttJob,
  uninstallLocalSttBinary,
} from '@/lib/stt/sherpa';

/**
 * /api/stt/local — 本地离线 STT（sherpa-onnx）引擎与模型管理
 *
 * GET  ：返回引擎/模型安装状态 + 当前下载任务（UI 轮询进度用；进度来自磁盘 .part 字节数）
 * POST ：触发后台下载，或删除已下载内容
 *        body { action: 'binary' }                                   下载 CLI 引擎（shared 包，含 dylib）
 *        body { action: 'model', modelId: '...' }                    下载指定模型
 *        body { action: 'delete', target: 'binary' }                 卸载引擎（bin + lib）
 *        body { action: 'delete', target: 'model', modelId: '...' }  删除指定模型
 *
 * 下载在后台进行（大文件耗时较长），POST 立即返回，由 GET 轮询进度；
 * 删除是同步操作，直接返回删除后的最新状态，供 UI 立即刷新。
 */

export const maxDuration = 120;

export async function GET() {
  try {
    return NextResponse.json({ success: true, ...(await getLocalSttStatus()) });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === 'delete') {
      if (body?.target === 'binary') {
        await uninstallLocalSttBinary();
      } else {
        const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
        if (!modelId) throw new Error('删除模型需要提供 modelId');
        await removeLocalSttModel(modelId);
      }
      return NextResponse.json({ success: true, ...(await getLocalSttStatus()) });
    }
    const action = body?.action === 'model' ? 'model' : 'binary';
    const modelId = typeof body?.modelId === 'string' ? body.modelId : undefined;
    const job = startLocalSttJob(action, modelId);
    return NextResponse.json({ success: true, job });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}