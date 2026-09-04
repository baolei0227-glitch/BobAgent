import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ParseMode, ParseResult, VisionConfig, VisionResult } from './types';
import { describeImage } from './vision-adapter';
import { getCache, setCache } from './cache';
import { isVisionNegativelyCached, markVisionNegative } from './vision-cache';
import { logDispatchEvent, loadDispatchStats, applyDispatchPenalty, inferDocType } from '../dispatch-log';
export function getMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.avif': 'image/avif',
  };
  return map[ext] ?? 'image/png';
}

export async function fileToBase64(filePath: string): Promise<{ data: string; mimeType: string }> {
  const buffer = await fs.readFile(filePath);
  const mimeType = getMimeTypeFromPath(filePath);
  return {
    data: buffer.toString('base64'),
    mimeType,
  };
}

export async function computeFileHash(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 视觉模型候选（lib 层局部定义，避免依赖 app/api/chat 层） */
export interface VisionCandidateLike {
  model: string;
  apiKey: string;
  baseUrl?: string;
}

/**
 * 多候选视觉识别（切片级 failover）：按历史成功率降权排序，逐个尝试，第一个返回非空文本即成功。
 * 单候选失败（抛错 / 空描述）自动尝试下一个；全部失败抛出最后一个错误。
 * 每次尝试记录调度日志（chain 可配置，供 ledger 切片链路排障与降权统计）。
 *
 * 说明：ledger 切片是裁剪后的局部图（非用户原图），此处不做 egress 数据出口审计
 * （tools.ts 的 parseImageWithFallback 负责整图链路的 egress 记录，职责不重叠）。
 */
export async function parseImageWithFallback(
  filePath: string,
  projectPath: string,
  candidates: VisionCandidateLike[],
  mode: ParseMode,
  opts?: {
    /** 调度日志链路标识，默认 'vision-fallback'；ledger 切片请传 'ledger' */
    chain?: 'vision-fallback' | 'glm-ocr' | 'online-ocr' | 'vlm-upgrade' | 'ledger';
    /** 每片最多尝试的候选数（默认全部）。限制候选数可防止单片预算被多次 failover 撑爆。 */
    maxCandidates?: number;
    /** 单候选超时（毫秒）。默认 60s：稠密表格/长文档生成慢，30s 频繁假超时 → 重试 → 429。 */
    timeout?: number;
  },
): Promise<ParseResult> {
  if (candidates.length === 0) {
    throw new Error('[vision-failover] 没有可用的视觉模型候选');
  }
  const chain = opts?.chain ?? 'vision-fallback';
  const limit = Math.max(1, Math.min(opts?.maxCandidates ?? candidates.length, candidates.length));
  const timeout = opts?.timeout ?? 60_000;
  const ordered = applyDispatchPenalty(
    candidates.slice(0, limit),
    (c) => c.model,
    loadDispatchStats(),
  );
  const docType = inferDocType(filePath);
  let lastErr: unknown = null;
  for (let i = 0; i < ordered.length; i++) {
    const cfg = ordered[i];
    const t0 = Date.now();
    try {
      const result = await parseImage(filePath, projectPath, {
        model: cfg.model,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        mode,
        timeout,
      });
      if (result.extracted_text && result.extracted_text.trim().length > 0) {
        logDispatchEvent({ chain, model: cfg.model, docType, ok: true, ms: Date.now() - t0 });
        return result;
      }
      logDispatchEvent({ chain, model: cfg.model, docType, ok: false, ms: Date.now() - t0, error: 'empty result' });
      lastErr = new Error(`[vision-failover] 模型 ${cfg.model} 返回空描述`);
    } catch (e) {
      logDispatchEvent({
        chain,
        model: cfg.model,
        docType,
        ok: false,
        ms: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      });
      lastErr = e;
      console.warn(`[vision-failover] 模型 ${cfg.model} 失败，尝试下一个候选:`, e instanceof Error ? e.message : String(e));
    }
    // 重试退避：失败（超时/429/空结果）后等待再试下一个候选，避免密集重试触发模型 API 429 限流。
    // 最后一个候选失败后无需等待（无后继）；成功路径已 return，能走到这里的一定是失败。
    if (i < ordered.length - 1) {
      await new Promise((r) => setTimeout(r, 2_500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('[vision-failover] 所有视觉模型均失败');
}

export async function parseImage(
  filePath: string,
  projectPath: string,
  config: VisionConfig
): Promise<ParseResult> {
  const fileName = path.basename(filePath);
  const mimeType = getMimeTypeFromPath(filePath);

  const { data: base64Data } = await fileToBase64(filePath);
  const fileHash = await computeFileHash(filePath);

  const cached = await getCache(fileHash, projectPath);
  if (cached) {
    return {
      ...cached.result,
      file_name: fileName,
      mime_type: mimeType,
      parsed_at: cached.result.parsed_at,
    };
  }

  // P3 负缓存：确定性失败短时记忆，命中直接抛错跳过（避免视觉回退链风暴重试）
  if (isVisionNegativelyCached(fileHash)) {
    throw new Error(`[vision] 图片近期识别失败（确定性错误），已跳过重试：${fileName}`);
  }

  const visionStart = Date.now();
  let visionResult: VisionResult;
  try {
    visionResult = await describeImage(
      { type: 'base64', data: base64Data, mimeType },
      config
    );
  } catch (e) {
    // 确定性失败（400 格式/解析错误）→ 负缓存；超时/429/5xx 等瞬时失败不缓存（可重试成功）
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b400\b|invalid.*image|image.*(format|decode)|图片.*(格式|解析)|解析.*失败/i.test(msg)) {
      markVisionNegative(fileHash);
    }
    throw e;
  }
  const visionDuration = Date.now() - visionStart;

  const result: ParseResult = {
    file_name: fileName,
    file_type: 'image',
    mime_type: mimeType,
    extracted_text: visionResult.description,
    parse_method: 'vision',
    parsed_at: new Date().toISOString(),
    stats: {
      duration_ms: visionDuration,
      input_tokens: visionResult.input_tokens,
      output_tokens: visionResult.output_tokens,
    },
    file_hash: fileHash,
  };

  await setCache(fileHash, result, projectPath);

  return result;
}

export async function parseImages(
  filePaths: string[],
  projectPath: string,
  config: VisionConfig
): Promise<ParseResult[]> {
  const results: ParseResult[] = [];
  for (const filePath of filePaths) {
    results.push(await parseImage(filePath, projectPath, config));
  }
  return results;
}