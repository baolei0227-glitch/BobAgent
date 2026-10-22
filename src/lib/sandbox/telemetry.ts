/**
 * Coding 小程序关键遥测（P2-10）：一轮 coding 会话结束时追加一行 JSONL。
 *
 * 只记录**可度量的工程指标**（耗时/首代码/首预览/工具错误/自动修复/console 错误数），
 * 不记录用户愿望、代码内容、模型输出或任何个人信息。
 * 落盘：{appRoot}/bob-sandbox/telemetry.jsonl（单行上限 2KB，追加写入）。
 */
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

import { resolveAppRoot, BOB_SANDBOX_DIRNAME } from '@/lib/app-root';

export interface CodingTurnTelemetry {
  appId?: string;
  modelId?: string;
  /** 本轮从发送到收尾的总耗时（ms） */
  durationMs: number;
  /** 首个写代码工具调用的相对耗时（ms） */
  firstCodeMs?: number;
  /** 首个预览/截图工具调用的相对耗时（ms） */
  firstPreviewMs?: number;
  toolCalls?: number;
  toolErrors?: number;
  /** 本轮是否由有界自动修复触发 */
  autoRepair?: boolean;
  /** 收尾时仍存在的 console error 数 */
  consoleErrors?: number;
}

const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function finiteNonNegative(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

/** 追加一条 coding 遥测；失败静默（遥测不能影响主流程）。 */
export async function appendCodingTelemetry(entry: CodingTurnTelemetry): Promise<void> {
  try {
    const dir = join(resolveAppRoot(), BOB_SANDBOX_DIRNAME);
    await mkdir(dir, { recursive: true });
    const appId = typeof entry.appId === 'string' && APP_ID_RE.test(entry.appId) ? entry.appId : undefined;
    const modelId = typeof entry.modelId === 'string' ? entry.modelId.slice(0, 120) : undefined;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      appId,
      modelId,
      durationMs: finiteNonNegative(entry.durationMs) ?? 0,
      firstCodeMs: finiteNonNegative(entry.firstCodeMs),
      firstPreviewMs: finiteNonNegative(entry.firstPreviewMs),
      toolCalls: finiteNonNegative(entry.toolCalls),
      toolErrors: finiteNonNegative(entry.toolErrors),
      autoRepair: entry.autoRepair === true,
      consoleErrors: finiteNonNegative(entry.consoleErrors),
    }).slice(0, 2048);
    await appendFile(join(dir, 'telemetry.jsonl'), `${line}\n`, 'utf-8');
  } catch {
    // 遥测失败不影响会话
  }
}
