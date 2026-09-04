import { NextRequest, NextResponse } from 'next/server';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RegionRef } from '@/lib/types';

/** 全景目标识别接口（Detect All）
 *  body: { image: string; width?: number; height?: number }
 *  image 为 dataUrl（data:image/png;base64,...）。
 *  无需用户指令：VLM 直接列出图中全部显著可编辑目标（人物/物体/文字块/背景区域），
 *  按显著性降序最多返回 15 个，并应用「规则一」最小区域外扩。
 */

/** 从 dataUrl 提取 base64 与 mimeType */
function extractImageData(image: string): { data: string; mimeType: string } {
  const m = image.match(/^data:(image\/[^;]+);base64,(.+)$/i);
  if (m) return { data: m[2], mimeType: m[1] };
  return { data: image, mimeType: 'image/png' };
}

/** 从 VLM 返回的文本中提取 JSON（容忍 markdown 代码块包裹） */
function parseRegionsJson(text: string): { regions: Array<{ object?: string; attributes?: string; bbox?: number[]; confidence?: number }> } | null {
  const trimmed = text.trim();
  // 去掉可能的 ```json ... ``` 包裹
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // 找到第一个 { 到最后一个 } 之间的内容
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (parsed && Array.isArray(parsed.regions)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** 规则一：最小区域外扩。bbox 面积 < 原图面积 × 1% 时按 30% 外扩（受图片边界裁剪） */
function applyMinRegionPad(
  bbox: [number, number, number, number],
  imgW: number,
  imgH: number,
): [number, number, number, number] {
  const [x1, y1, x2, y2] = bbox;
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return [0, 0, Math.max(1, Math.min(imgW, w)), Math.max(1, Math.min(imgH, h))];
  const areaRatio = (w * h) / Math.max(1, imgW * imgH);
  if (areaRatio >= 0.01) return bbox; // ≥1% 无需外扩
  const padX = w * 0.3;
  const padY = h * 0.3;
  return [
    Math.max(0, Math.round(x1 - padX)),
    Math.max(0, Math.round(y1 - padY)),
    Math.min(imgW, Math.round(x2 + padX)),
    Math.min(imgH, Math.round(y2 + padY)),
  ];
}

/** 归一化 bbox（0~1000）→ 原图像素 bbox（0~imgW/imgH），再做最小区域外扩 */
function normalizeToPixels(
  b: [number, number, number, number],
  imgW: number,
  imgH: number,
): [number, number, number, number] {
  // VLM 返回 0~1000 归一化坐标（与图片被缩放/拉伸后的实际像素尺寸无关），
  // 换算回原图自然像素坐标后外扩，保证圆点标注与图片内容精确对齐。
  const x1 = (Math.max(0, Math.min(1000, b[0])) / 1000) * imgW;
  const y1 = (Math.max(0, Math.min(1000, b[1])) / 1000) * imgH;
  const x2 = (Math.max(0, Math.min(1000, b[2])) / 1000) * imgW;
  const y2 = (Math.max(0, Math.min(1000, b[3])) / 1000) * imgH;
  return applyMinRegionPad(
    [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)],
    imgW,
    imgH,
  );
}

/** 全景识别数量上限 */
const MAX_REGIONS = 15;

/** 解析出的 VLM regions → 原图像素 RegionRef[]（归一化换算 + 最小外扩 + label 清洗） */
function buildRegions(
  parsed: { regions: Array<{ object?: string; attributes?: string; bbox?: number[]; confidence?: number }> },
  imgW: number,
  imgH: number,
): RegionRef[] {
  const regions: RegionRef[] = [];
  for (const raw of parsed.regions.slice(0, MAX_REGIONS)) {
    const b = raw.bbox;
    if (!Array.isArray(b) || b.length < 4 || typeof b[0] !== 'number' || typeof b[1] !== 'number' || typeof b[2] !== 'number' || typeof b[3] !== 'number') continue;
    // 归一化坐标（0~1000）→ 原图像素坐标，内部已做最小区域外扩
    const padded = normalizeToPixels(
      [b[0], b[1], b[2], b[3]],
      imgW,
      imgH,
    );
    const label = (raw.object || '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5-]/g, '-').replace(/-+/g, '-').slice(0, 24) || `region-${regions.length + 1}`;
    regions.push({
      id: `region-${label}-${Date.now().toString(36)}-${regions.length}`,
      label,
      object: (raw.object || label).trim(),
      attributes: (raw.attributes || '').trim() || undefined,
      bbox: padded,
      confidence: typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0,
    });
  }
  return regions;
}

/**
 * MCP 优先：Detect All 统一走 bob-ocr-mcp（ocr.image_understand detectAll 模式，复用插件 vision 配置）。
 * dataUrl → 临时图片文件 → MCP 调用 → 清理；MCP 未配置/不可用/插件未配视觉 → null（调用方回退内置视觉模型）。
 */
async function detectAllViaMcp(image: string): Promise<{ model: string; understanding: string } | null> {
  const { data: b64, mimeType } = extractImageData(image);
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
  const tmpPath = join(tmpdir(), `bobwork-detectall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  try {
    await writeFile(tmpPath, Buffer.from(b64, 'base64'));
    const { ocrImageUnderstandViaMcp } = await import('@/lib/mcp/ocr-client');
    const r = await ocrImageUnderstandViaMcp(tmpPath, { mode: 'detectAll' });
    return r ? { model: r.model, understanding: r.understanding } : null;
  } catch {
    return null;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { image, width, height } = body as {
      image?: string;
      width?: number;
      height?: number;
    };
    if (!image) {
      return NextResponse.json({ success: false, error: 'image is required' }, { status: 400 });
    }

    // 原图尺寸：优先用前端上报，否则默认 1024（用于外扩比例计算）
    const imgW = width && width > 0 ? width : 1024;
    const imgH = height && height > 0 ? height : 1024;

    // ---- Detect All 统一走 bob-ocr-mcp（ocr.image_understand detectAll 模式，复用插件 vision 配置）----
    const t0m = Date.now();
    const viaMcp = await detectAllViaMcp(image);
    if (viaMcp) {
      const parsedMcp = parseRegionsJson(viaMcp.understanding);
      if (!parsedMcp || parsedMcp.regions.length === 0) {
        // 合法 JSON 但无区域 = 图片无显著可编辑目标，返回成功 + 空 regions（前端按整图编辑处理）
        return NextResponse.json({ success: true, regions: [], model: viaMcp.model, ms: Date.now() - t0m });
      }
      return NextResponse.json({
        success: true,
        regions: buildRegions(parsedMcp, imgW, imgH),
        model: viaMcp.model,
        ms: Date.now() - t0m,
      });
    }
    return NextResponse.json(
      {
        success: false,
        error: '识别服务 bob-ocr-mcp 不可用或未配置视觉模型。请确认 OCR 插件常驻服务在线（bob-ocr-mcp --install-daemon）且已配置视觉模型（插件 /settings 的 Vision 区块）。',
      },
      { status: 502 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[imagegen/detect-all] error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
